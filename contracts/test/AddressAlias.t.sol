// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AddressAlias} from "../src/libraries/AddressAlias.sol";

contract AddressAliasTest is Test {
    function test_knownVector() public pure {
        assertEq(AddressAlias.applyL1ToL2Alias(address(0)), 0x1111000000000000000000000000000000001111);
        assertEq(
            AddressAlias.applyL1ToL2Alias(0x0000000000000000000000000000000000000001),
            0x1111000000000000000000000000000000001112
        );
    }

    function test_overflowWraps() public pure {
        assertEq(
            AddressAlias.applyL1ToL2Alias(0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF),
            0x1111000000000000000000000000000000001110
        );
        assertEq(
            AddressAlias.applyL1ToL2Alias(0xeeeF000000000000000000000000000000000000),
            0x0000000000000000000000000000000000001111
        );
    }

    function testFuzz_matchesModularAdd(address a) public pure {
        uint256 expected = (uint256(uint160(a)) + uint256(0x001111000000000000000000000000000000001111)) % (1 << 160);
        assertEq(uint160(AddressAlias.applyL1ToL2Alias(a)), expected);
    }
}
