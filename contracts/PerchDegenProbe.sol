// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./PerchDegen.sol";

/// @notice eth_call ONLY. Executes the actual vault buy/mint/remove/sell sequence
/// against current chain state. This does not certify future token behaviour.
contract PerchDegenProbe {
    constructor(address weth, address npm, address router, address token, uint24 fee, int24 lower, int24 upper) payable {
        address[] memory allowed = new address[](1);
        allowed[0] = token;
        PerchDegen vault = new PerchDegen{value: msg.value}(address(this), weth, npm, router, allowed);
        uint256 principal = msg.value - vault.STIPEND();
        vault.rebalance(weth, token, fee, lower, upper, 0, 1);
        vault.exitProtected(1, principal * 97 / 100, block.timestamp + 60);
        uint256 recovered = address(this).balance - vault.STIPEND();
        bytes memory result = abi.encode(recovered);
        assembly { return(add(result, 32), mload(result)) }
    }
    receive() external payable {}
}
