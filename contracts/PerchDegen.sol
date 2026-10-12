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

interface INpm {
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
///         off at any time with setOperator(). The owner paths (exit, exitNoSwap,
///         rescueToken, rescueNft) never depend on a swap succeeding.
contract PerchDegen {
    uint256 public constant STIPEND = 0.001 ether;

    address public immutable owner;
    address public operator;
    IWETH public immutable weth;
    INpm public immutable npm;
    ISwapRouter public immutable router;

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

    constructor(address operator_, address weth_, address npm_, address router_) payable {
        if (operator_ == address(0) || msg.value <= STIPEND) revert BadValue();
        owner = msg.sender;
        operator = operator_;
        weth = IWETH(weth_);
        npm = INpm(npm_);
        router = ISwapRouter(router_);
        (bool ok, ) = operator_.call{value: STIPEND}("");
        if (!ok) revert BadValue();
        uint256 rest = msg.value - STIPEND;
        weth.deposit{value: rest}();
        emit Armed(msg.sender, operator_, rest);
    }

    /// @dev ETH coming back from WETH.withdraw() must NOT be re-wrapped, otherwise
    ///      exit() can never hand native ETH to the owner. Plain ETH sent by anyone
    ///      else is wrapped so it stays productive. Stays under 2300 gas for WETH
    ///      implementations that use transfer().
    receive() external payable {
        if (msg.sender == address(weth)) return;
        if (msg.value > 0) weth.deposit{value: msg.value}();
    }

    function deposit() external payable onlyOwner {
        if (msg.value == 0) revert BadValue();
        weth.deposit{value: msg.value}();
    }

    /// @notice Set to a fresh keeper, or to any dead address to revoke the keeper.
    function setOperator(address next) external onlyOwner {
        operator = next;
        emit OperatorChanged(next);
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
        _exitNft();
        _toWethStrict(token0, minOutExit);
        _toWethStrict(token1, minOutExit);
        _enter(t0, t1, fee_, tickLower, tickUpper, minOutEnter);
    }

    /// @notice Close the position, swap back to ETH (best effort) and send
    ///         everything to the owner. A token whose swap fails (honeypot, no
    ///         liquidity) is sent to the owner as-is instead of blocking the exit.
    ///         Swaps use no slippage floor: use exitNoSwap() if you fear sandwiching.
    function exit() external onlyOwner nonReentrant {
        _exit(true);
    }

    /// @notice Same as exit() but never swaps: owner gets ETH plus the raw pair token.
    function exitNoSwap() external onlyOwner nonReentrant {
        _exit(false);
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
        npm.transferFrom(address(this), owner, id);
    }

    // ---------------------------------------------------------------- internals

    function _exit(bool swap) internal {
        _exitNft();
        if (swap) {
            _toWethBestEffort(token0);
            _toWethBestEffort(token1);
        }
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

    /// @dev Owner path: never reverts because of the token.
    function _toWethBestEffort(address token) internal {
        if (token == address(0) || token == address(weth)) return;
        try IERC20(token).balanceOf(address(this)) returns (uint256 bal) {
            if (bal > 0) _swap(token, address(weth), fee == 0 ? 3000 : fee, bal, 0);
        } catch {}
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
