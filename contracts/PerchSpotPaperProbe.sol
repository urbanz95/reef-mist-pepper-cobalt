// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

struct SpotPoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
interface ISpotToken {
    function balanceOf(address) external view returns (uint256);
    function approve(address,uint256) external returns (bool);
    function transfer(address,uint256) external returns (bool);
}
interface ISpotWeth is ISpotToken { function deposit() external payable; function withdraw(uint256) external; }
interface ISpotV2 {
    function swapExactETHForTokens(uint256,address[] calldata,address,uint256) external payable returns (uint256[] memory);
    function swapExactTokensForETH(uint256,uint256,address[] calldata,address,uint256) external returns (uint256[] memory);
}
interface ISpotV3 {
    struct Params { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    function exactInputSingle(Params calldata) external payable returns (uint256);
}
interface ISpotCurve {
    function buy(uint256,uint256,address) external payable returns(uint256);
    function sell(uint256,uint256,address) external returns(uint256);
}
interface ISpotV4 {
    struct SwapParams { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
    function unlock(bytes calldata) external returns (bytes memory);
    function swap(SpotPoolKey memory,SwapParams memory,bytes calldata) external returns (int256);
    function sync(address) external;
    function settle() external payable returns (uint256);
    function take(address,address,uint256) external;
}

/// @notice Disposable eth_call-only wallet. Not a production trading vault.
contract SpotPaperWallet {
    address immutable owner;
    address immutable weth;
    address immutable token;
    address immutable executor;
    uint8 immutable version;
    SpotPoolKey key;
    constructor(address w,address t,address e,uint8 v,SpotPoolKey memory k) payable {
        owner=msg.sender; weth=w; token=t; executor=e; version=v; key=k;
    }
    function measure() external returns (uint256 recovered,uint256 bought,uint256 enterGas,uint256 exitGas) {
        require(msg.sender==owner,"owner");
        uint256 start=gasleft();
        uint256 principal=address(this).balance;
        if(version==5){
            bool nativeQuote=key.currency0==address(0);
            if(!nativeQuote){ISpotWeth(weth).deposit{value:principal}();require(ISpotToken(weth).approve(executor,principal),"approve");}
            ISpotCurve(executor).buy{value:nativeQuote?principal:0}(principal,1,address(this));
            require(address(this).balance==0 && ISpotToken(weth).balanceOf(address(this))==0,"partial curve fill");
        } else if (version==2) {
            address[] memory path=new address[](2); path[0]=weth; path[1]=token;
            ISpotV2(executor).swapExactETHForTokens{value:principal}(1,path,address(this),block.timestamp);
        } else {
            if (version==3 || (key.currency0!=address(0) && key.currency1!=address(0))) {
                ISpotWeth(weth).deposit{value:principal}();
            }
            if (version==3) {
                require(ISpotToken(weth).approve(executor,principal),"approve");
                ISpotV3(executor).exactInputSingle(ISpotV3.Params(weth,token,key.fee,address(this),principal,1,0));
            } else {
                require(version==4,"version");
                ISpotV4(executor).unlock(abi.encode(true,principal));
            }
        }
        bought=ISpotToken(token).balanceOf(address(this)); require(bought>0,"no tokens");
        enterGas=start-gasleft();
        (recovered,exitGas)=sell(bought);
    }
    /// @notice Sell only: the caller must supply the held balance through eth_call state overrides.
    /// No buy occurs before this sale, so a fresh buy cannot refill a drained pool.
    function sellHeld(uint256 quantity) external returns(uint256 recovered,uint256 exitGas) {
        require(msg.sender==owner,"owner");
        require(quantity>0 && ISpotToken(token).balanceOf(address(this))==quantity,"held balance");
        return sell(quantity);
    }
    function sell(uint256 bought) private returns(uint256 recovered,uint256 exitGas) {
        uint256 start=gasleft();
        if(version==5){
            require(ISpotToken(token).approve(executor,bought),"approve");
            ISpotCurve(executor).sell(bought,1,address(this));
        } else if (version==2) {
            require(ISpotToken(token).approve(executor,bought),"approve");
            address[] memory path=new address[](2); path[0]=token; path[1]=weth;
            ISpotV2(executor).swapExactTokensForETH(bought,1,path,address(this),block.timestamp);
        } else if (version==3) {
            require(ISpotToken(token).approve(executor,bought),"approve");
            ISpotV3(executor).exactInputSingle(ISpotV3.Params(token,weth,key.fee,address(this),bought,1,0));
        } else {
            ISpotV4(executor).unlock(abi.encode(false,bought));
        }
        uint256 wrapped=ISpotToken(weth).balanceOf(address(this));
        if(wrapped>0) ISpotWeth(weth).withdraw(wrapped);
        recovered=address(this).balance;
        exitGas=start-gasleft();
        (bool ok,)=owner.call{value:recovered}(""); require(ok,"refund");
    }
    function unlockCallback(bytes calldata data) external returns(bytes memory) {
        require(msg.sender==executor && version==4,"callback");
        (bool buy,uint256 amount)=abi.decode(data,(bool,uint256));
        bool token0=key.currency0==token;
        bool zeroForOne=buy ? !token0 : token0;
        int256 delta=ISpotV4(executor).swap(key,ISpotV4.SwapParams(zeroForOne,-int256(amount),
            zeroForOne ? uint160(4295128740) : uint160(1461446703485210103287273052203988822378723970341)),"");
        settle(key.currency0,int128(delta>>128)); settle(key.currency1,int128(delta));
        return "";
    }
    function settle(address currency,int128 delta) private {
        if(delta>0) ISpotV4(executor).take(currency,address(this),uint128(delta));
        else if(delta<0) {
            uint256 amount=uint256(-int256(delta));
            if(currency==address(0)) ISpotV4(executor).settle{value:amount}();
            else {
                ISpotV4(executor).sync(currency);
                require(ISpotToken(currency).transfer(executor,amount),"transfer");
                ISpotV4(executor).settle();
            }
        }
    }
    receive() external payable {}
}

contract PerchSpotPaperProbe {
    constructor(address weth,address token,address executor,uint8 version,SpotPoolKey memory key) payable {
        SpotPaperWallet wallet=new SpotPaperWallet{value:msg.value}(weth,token,executor,version,key);
        (uint256 recovered,uint256 bought,uint256 enterGas,uint256 exitGas)=wallet.measure();
        (bool ok,)=msg.sender.call{value:address(this).balance}(""); require(ok,"refund");
        bytes memory result=abi.encode(recovered,bought,enterGas,exitGas);
        assembly { return(add(result,32),mload(result)) }
    }
    receive() external payable {}
}

/// @notice Constructor result only. This contract is never deployed or funded on-chain.
contract PerchSpotExitProbe {
    constructor(address weth,address token,address executor,uint8 version,SpotPoolKey memory key,uint256 quantity) {
        SpotPaperWallet wallet=new SpotPaperWallet(weth,token,executor,version,key);
        (uint256 recovered,uint256 gasUsed)=wallet.sellHeld(quantity);
        bytes memory result=abi.encode(recovered,gasUsed);
        assembly { return(add(result,32),mload(result)) }
    }
    receive() external payable {}
}
