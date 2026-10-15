// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface IWETH is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

interface IFactory {
    function getPool(address, address, uint24) external view returns (address);
}

interface INpm {
    function factory() external view returns (address);
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }
    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }
    function mint(MintParams calldata params) external payable returns (uint256, uint128, uint256, uint256);
    function decreaseLiquidity(DecreaseLiquidityParams calldata params) external payable returns (uint256, uint256);
    function collect(CollectParams calldata params) external payable returns (uint256, uint256);
    function transferFrom(address from, address to, uint256 id) external;
    function positions(uint256 tokenId) external view returns (
        uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128
    );
}

/// @notice Owner deposits ETH. Keeper (operator) may only hop the Uniswap v3
///         WETH position. Only the owner can exit to their wallet.
/// @dev    Trust model: the operator is a trusted hot key. It cannot withdraw to
///         itself, but it picks the pool/tokens/ticks of each hop, so a stolen
///         operator key can still burn value through bad hops. Owner can cut it
///         off at any time with setOperator(). The raw owner exits and rescue paths never depend on a swap succeeding.
///         Token permissions and trade limits bound, but cannot eliminate, hot-key risk.
contract PerchDegen {
    uint256 public constant VERSION = 2;
    uint256 public lastRebalance;
    uint256 public dayStart;
    uint256 public dailyTrades;
    mapping(address => bool) public allowedToken;
    uint256 public constant STIPEND = 0.00005 ether;
    /// @notice Launch cap on the total ETH ever deposited into one vault (stipend
    ///         excluded). Bounds what a compromised keeper can ever put at risk.
    uint256 public constant MAX_DEPOSIT = 0.5 ether;

    address public immutable owner;
    address public operator;
    IWETH public immutable weth;
    INpm public immutable npm;
    ISwapRouter public immutable router;

    uint256 public deposited;
    uint256 public tokenId;
    address public token0;
    address public token1;
    uint24 public fee;

    bool private _locked;

    event Armed(address indexed owner, address indexed operator, uint256 ethIn);
    event Hopped(address token0, address token1, uint24 fee, uint256 tokenId);
    event Exited(uint256 ethOut);
    event OperatorChanged(address indexed operator);

    error NotOwner();
    error NotOperator();
    error BadValue();
    error CapExceeded();
    error NeedWeth();
    error SwapFailed();
    error Reentrancy();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator && msg.sender != owner) revert NotOperator();
        _;
    }

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    constructor(address operator_, address weth_, address npm_, address router_, address[] memory tokens_) payable {
        if (weth_.code.length == 0 || npm_.code.length == 0 || router_.code.length == 0 || tokens_.length > 16) revert BadValue();
        for (uint256 i; i < tokens_.length; i++) allowedToken[tokens_[i]] = true;
        if (operator_ == address(0) || msg.value <= STIPEND) revert BadValue();
        owner = msg.sender;
        operator = operator_;
        weth = IWETH(weth_);
        npm = INpm(npm_);
        router = ISwapRouter(router_);
        (bool ok, ) = operator_.call{value: STIPEND}("");
        if (!ok) revert BadValue();
        uint256 rest = msg.value - STIPEND;
        if (rest > MAX_DEPOSIT) revert CapExceeded();
        deposited = rest;
        weth.deposit{value: rest}();
        emit Armed(msg.sender, operator_, rest);
    }

    /// @dev ETH coming back from WETH.withdraw() must NOT be re-wrapped, otherwise
    ///      exit() can never hand native ETH to the owner. Plain ETH sent by anyone
    ///      else is wrapped so it stays productive. Stays under 2300 gas for WETH
    ///      implementations that use transfer().
    receive() external payable {
        if (msg.sender == address(weth)) return;
        if (msg.value > 0) {
            if (deposited + msg.value > MAX_DEPOSIT) revert CapExceeded();
            deposited += msg.value;
            weth.deposit{value: msg.value}();
        }
    }

    function deposit() external payable onlyOwner {
        if (msg.value == 0) revert BadValue();
        if (deposited + msg.value > MAX_DEPOSIT) revert CapExceeded();
        deposited += msg.value;
        weth.deposit{value: msg.value}();
    }

    /// @notice Set to a fresh keeper, or to any dead address to revoke the keeper.
    function setOperator(address next) external onlyOwner {
        operator = next;
        emit OperatorChanged(next);
    }

    /// @notice Reviewed tokens are chosen by the owner, never by the keeper.
    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        allowedToken[token] = allowed;
    }

    /// @param minOutExit  min WETH for swapping the old pair token back; must be
    ///                    > 0 whenever there is something to swap.
    /// @param minOutEnter min pair token for the half-WETH swap; must be > 0.
    function rebalance(
        address t0,
        address t1,
        uint24 fee_,
        int24 tickLower,
        int24 tickUpper,
        uint256 minOutExit,
        uint256 minOutEnter
    ) external onlyOperator nonReentrant {
        if (lastRebalance != 0 && block.timestamp < lastRebalance + 30 minutes) revert BadValue();
        if (block.timestamp >= dayStart + 1 days) { dayStart = block.timestamp; dailyTrades = 0; }
        if (dailyTrades >= 4) revert BadValue();
        lastRebalance = block.timestamp;
        dailyTrades++;
        _exitNft();
        _toWethStrict(token0, minOutExit);
        _toWethStrict(token1, minOutExit);
        _enter(t0, t1, fee_, tickLower, tickUpper, minOutEnter);
    }

    /// @notice Safe default: return ETH and raw tokens, with no market sale.
    function exit() external onlyOwner nonReentrant { _exit(); }
    function exitNoSwap() external onlyOwner nonReentrant { _exit(); }

    /// @notice Atomic quoted exit. If either floor fails, no assets move.
    function exitProtected(uint256 minOut, uint256 minTotalWeth, uint256 deadline) external onlyOwner nonReentrant {
        _liquidate(minOut, minTotalWeth, deadline);
        _exit();
    }

    /// @notice Risk exit keeps WETH in the owner's vault and revokes automation.
    function exitToWeth(uint256 minOut, uint256 minTotalWeth, uint256 deadline) external onlyOperator nonReentrant {
        _liquidate(minOut, minTotalWeth, deadline);
        operator = address(0);
        token0 = address(0); token1 = address(0); fee = 0;
        emit OperatorChanged(address(0));
    }

    function _liquidate(uint256 minOut, uint256 minTotalWeth, uint256 deadline) internal {
        if (deadline < block.timestamp || deadline > block.timestamp + 5 minutes || minTotalWeth == 0) revert BadValue();
        _exitNft();
        _toWethStrict(token0, minOut);
        _toWethStrict(token1, minOut);
        if (weth.balanceOf(address(this)) < minTotalWeth) revert BadValue();
    }

    /// @notice Escape hatch: pull any ERC20 held by the vault to the owner.
    function rescueToken(address token) external onlyOwner nonReentrant {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0 && !_call(token, abi.encodeCall(IERC20.transfer, (owner, bal)))) {
            revert BadValue();
        }
    }

    /// @notice Escape hatch if the position can no longer be unwound through the
    ///         NPM: move the position NFT itself to the owner.
    function rescueNft() external onlyOwner nonReentrant {
        uint256 id = tokenId;
        if (id == 0) revert BadValue();
        tokenId = 0;
        operator = address(0);
        npm.transferFrom(address(this), owner, id);
    }

    // ---------------------------------------------------------------- internals

    function _exit() internal {
        operator = address(0);
        emit OperatorChanged(address(0));
        _exitNft();
        uint256 wb = weth.balanceOf(address(this));
        if (wb > 0) {
            try weth.withdraw(wb) {} catch {}
        }
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok, ) = owner.call{value: bal}("");
            if (!ok) {
                // owner cannot receive ETH: hand over WETH instead of reverting
                weth.deposit{value: bal}();
                bal = 0;
            }
        }
        _sendAll(address(weth));
        _sendAll(token0);
        _sendAll(token1);
        token0 = address(0);
        token1 = address(0);
        fee = 0;
        emit Exited(bal);
    }

    function _enter(
        address t0,
        address t1,
        uint24 fee_,
        int24 tickLower,
        int24 tickUpper,
        uint256 minOutEnter
    ) internal {
        if (t0 == t1) revert NeedWeth();
        if (minOutEnter == 0) revert BadValue();
        if (fee_ != 100 && fee_ != 500 && fee_ != 3000 && fee_ != 10000) revert BadValue();
        if (uint160(t0) > uint160(t1)) (t0, t1) = (t1, t0);
        address w = address(weth);
        if (t0 != w && t1 != w) revert NeedWeth();
        address other = t0 == w ? t1 : t0;
        if (!allowedToken[other]) revert BadValue();
        { address pool = IFactory(npm.factory()).getPool(t0, t1, fee_);
        if (pool == address(0) || pool.code.length == 0) revert BadValue(); }
        uint256 half = weth.balanceOf(address(this)) / 2;
        if (half == 0) revert BadValue();
        if (!_swap(w, other, fee_, half, minOutEnter)) revert SwapFailed();
        uint256 a0 = IERC20(t0).balanceOf(address(this));
        uint256 a1 = IERC20(t1).balanceOf(address(this));
        if (!_approve(t0, address(npm), a0) || !_approve(t1, address(npm), a1)) revert BadValue();
        (uint256 id, , , ) = npm.mint(
            INpm.MintParams({
                token0: t0,
                token1: t1,
                fee: fee_,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: a0,
                amount1Desired: a1,
                amount0Min: (a0 * 99) / 100,
                amount1Min: (a1 * 99) / 100,
                recipient: address(this),
                deadline: block.timestamp + 20 minutes
            })
        );
        _approve(t0, address(npm), 0);
        _approve(t1, address(npm), 0);
        tokenId = id;
        token0 = t0;
        token1 = t1;
        fee = fee_;
        emit Hopped(t0, t1, fee_, id);
    }

    function _exitNft() internal {
        uint256 id = tokenId;
        if (id == 0) return;
        (, , , , , , , uint128 liq, , , , ) = npm.positions(id);
        if (liq > 0) {
            npm.decreaseLiquidity(
                INpm.DecreaseLiquidityParams({
                    tokenId: id,
                    liquidity: liq,
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: block.timestamp + 20 minutes
                })
            );
        }
        npm.collect(
            INpm.CollectParams({
                tokenId: id,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        tokenId = 0;
    }

    /// @dev Operator path: slippage floor is mandatory and a failed swap reverts.
    function _toWethStrict(address token, uint256 minOut) internal {
        if (token == address(0) || token == address(weth)) return;
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) return;
        if (minOut == 0) revert BadValue();
        if (!_swap(token, address(weth), fee == 0 ? 3000 : fee, bal, minOut)) revert SwapFailed();
    }

    /// @dev Returns false instead of reverting so owner paths can carry on.
    function _swap(
        address tokenIn,
        address tokenOut,
        uint24 fee_,
        uint256 amountIn,
        uint256 minOut
    ) internal returns (bool ok) {
        if (amountIn == 0 || tokenIn == tokenOut) return true;
        if (!_approve(tokenIn, address(router), amountIn)) return false;
        (ok, ) = address(router).call(
            abi.encodeCall(
                ISwapRouter.exactInputSingle,
                (
                    ISwapRouter.ExactInputSingleParams({
                        tokenIn: tokenIn,
                        tokenOut: tokenOut,
                        fee: fee_,
                        recipient: address(this),
                        amountIn: amountIn,
                        amountOutMinimum: minOut,
                        sqrtPriceLimitX96: 0
                    })
                )
            )
        );
        _approve(tokenIn, address(router), 0);
    }

    /// @dev Tolerates tokens that return nothing (USDT style) and reverts on false.
    function _call(address target, bytes memory data) internal returns (bool ok) {
        if (target.code.length == 0) return false;
        bytes memory ret;
        (ok, ret) = target.call(data);
        if (ok && ret.length != 0) ok = ret.length >= 32 && abi.decode(ret, (bool));
    }

    function _approve(address token, address spender, uint256 amount) internal returns (bool) {
        _call(token, abi.encodeCall(IERC20.approve, (spender, 0)));
        if (amount == 0) return true;
        return _call(token, abi.encodeCall(IERC20.approve, (spender, amount)));
    }

    function _sendAll(address token) internal {
        if (token == address(0)) return;
        try IERC20(token).balanceOf(address(this)) returns (uint256 bal) {
            if (bal > 0) _call(token, abi.encodeCall(IERC20.transfer, (owner, bal)));
        } catch {}
    }
}
