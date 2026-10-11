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
    function positions(uint256 tokenId) external view returns (
        uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128
    );
}

/// @notice Owner deposits ETH. Keeper (operator) may only hop the Uniswap v3
///         WETH position. Only the owner can exit to their wallet.
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

    event Armed(address indexed owner, address indexed operator, uint256 ethIn);
    event Hopped(address token0, address token1, uint24 fee, uint256 tokenId);
    event Exited(uint256 ethOut);

    error NotOwner();
    error NotOperator();
    error BadValue();
    error NeedWeth();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator && msg.sender != owner) revert NotOperator();
        _;
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

    receive() external payable {
        if (msg.value > 0) weth.deposit{value: msg.value}();
    }

    function deposit() external payable onlyOwner {
        if (msg.value == 0) revert BadValue();
        weth.deposit{value: msg.value}();
    }

    function setOperator(address next) external onlyOwner {
        operator = next;
    }

    function rebalance(
        address t0,
        address t1,
        uint24 fee_,
        int24 tickLower,
        int24 tickUpper,
        uint256 minOutExit,
        uint256 minOutEnter
    ) external onlyOperator {
        _unwind(minOutExit);
        _enter(t0, t1, fee_, tickLower, tickUpper, minOutEnter);
    }

    function exit() external onlyOwner {
        _unwind(0);
        uint256 w = weth.balanceOf(address(this));
        if (w > 0) weth.withdraw(w);
        uint256 bal = address(this).balance;
        _pushEth(owner);
        _sweep(token0);
        _sweep(token1);
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
        if (uint160(t0) > uint160(t1)) (t0, t1) = (t1, t0);
        address w = address(weth);
        if (t0 != w && t1 != w) revert NeedWeth();
        address other = t0 == w ? t1 : t0;
        uint256 half = weth.balanceOf(address(this)) / 2;
        _swap(w, other, fee_, half, minOutEnter);
        uint256 a0 = IERC20(t0).balanceOf(address(this));
        uint256 a1 = IERC20(t1).balanceOf(address(this));
        _approve(t0, address(npm), a0);
        _approve(t1, address(npm), a1);
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
        tokenId = id;
        token0 = t0;
        token1 = t1;
        fee = fee_;
        emit Hopped(t0, t1, fee_, id);
    }

    function _unwind(uint256 minOutExit) internal {
        _exitNft();
        address w = address(weth);
        if (token0 != address(0) && token0 != w) _toWeth(token0, fee, minOutExit);
        if (token1 != address(0) && token1 != w) _toWeth(token1, fee, minOutExit);
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

    function _toWeth(address token, uint24 fee_, uint256 minOut) internal {
        if (token == address(0) || token == address(weth)) return;
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) return;
        uint24 useFee = fee_ == 0 ? 3000 : fee_;
        _swap(token, address(weth), useFee, bal, minOut);
    }

    function _swap(address tokenIn, address tokenOut, uint24 fee_, uint256 amountIn, uint256 minOut) internal {
        if (amountIn == 0 || tokenIn == tokenOut) return;
        _approve(tokenIn, address(router), amountIn);
        router.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee_,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function _approve(address token, address spender, uint256 amount) internal {
        IERC20(token).approve(spender, 0);
        IERC20(token).approve(spender, amount);
    }

    function _sweep(address token) internal {
        if (token == address(0) || token == address(weth)) return;
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).transfer(owner, bal);
    }

    function _pushEth(address to) internal {
        uint256 bal = address(this).balance;
        if (bal == 0) return;
        (bool ok, ) = to.call{value: bal}("");
        if (!ok) revert BadValue();
    }
}
