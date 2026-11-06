// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";

/// One measured top-level call per test. Run with `forge test --isolate -vvvv` so the call is its own
/// transaction; the trace's top frame then shows the full tx gas (intrinsic included). The GAS| log line
/// carries the calldata byte counts so script/gas-report.sh can derive execution-only gas.
abstract contract GasMeter is Test {
    function _measure(string memory label, address target, bytes memory data) internal {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        uint256 zeros;
        for (uint256 i; i < data.length; ++i) {
            if (data[i] == 0) zeros++;
        }
        console2.log(string.concat("GAS|", label, "|", vm.toString(zeros), "|", vm.toString(data.length - zeros)));
    }
}
