// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./PerchDegen.sol";

/// @notice Read-only experiment probe: measure entry and exit separately so
/// paper trading does not charge a new contract deployment on every hop.
contract PerchDegenPaperProbe {
    struct Measurement { uint256 recovered; uint256 enterGas; uint256 exitGas; }
    constructor(address weth, address npm, address router, address token, uint24 fee, int24 lower, int24 upper) payable {
        address[] memory allowed = new address[](1);
        allowed[0] = token;
        PerchDegen vault = new PerchDegen{value: msg.value}(address(this), weth, npm, router, allowed);
        uint256 principal = msg.value - vault.STIPEND();
        Measurement memory m;
        uint256 beforeGas = gasleft();
        vault.rebalance(weth, token, fee, lower, upper, 0, 1);
        m.enterGas = beforeGas - gasleft();
        beforeGas = gasleft();
        vault.exitProtected(1, principal * 97 / 100, block.timestamp + 60);
        m.exitGas = beforeGas - gasleft();
        m.recovered = address(this).balance - vault.STIPEND();
        // Also refund the caller if someone mistakenly deploys this probe.
        (bool ok,) = msg.sender.call{value: address(this).balance}("");
        require(ok, "refund failed");
        bytes memory result = abi.encode(m);
        assembly { return(add(result, 32), mload(result)) }
    }
    receive() external payable {}
}
