// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WBSoulMirror} from "../src/mocks/WBSoulMirror.sol";
import {ForkBlocks} from "./ForkBlocks.sol";

/// Compares the mirror with WhiteBIT's live registries on a pinned Whitechain mainnet fork.
contract WBSoulMirrorForkTest is Test {
    address constant SOUL_REGISTRY = 0x0000000000000000000000000000000000002000;
    address constant ATTRIBUTE_REGISTRY = 0x0000000000000000000000000000000000002002;
    address constant IS_VERIFIED = 0xd88fa142B67F561C5f2Cbf803bF5AE906a8f1e41;
    address constant SOUL1_PRIMARY = 0xFD696AAF18c6eF43dDc14a6eB834c8b8037AF7bC;

    WBSoulMirror mirror;

    function setUp() public {
        vm.createSelectFork("whitechain", ForkBlocks.WHITECHAIN_MAINNET);
        assertEq(block.chainid, 1875);
        mirror = new WBSoulMirror(address(this));
        mirror.registerSoul(SOUL1_PRIMARY);
        mirror.setAttribute(1, IS_VERIFIED, bytes20(uint160(1)));
    }

    function test_soulOfRealBoundAddress() public view {
        (bool ok, bytes memory real) = SOUL_REGISTRY.staticcall(abi.encodeCall(WBSoulMirror.soulOf, (SOUL1_PRIMARY)));
        assertTrue(ok);
        assertEq(real.length, 32);
        assertEq(abi.decode(real, (uint256)), 1);
        assertEq(real, _mirrorCall(abi.encodeCall(WBSoulMirror.soulOf, (SOUL1_PRIMARY))));
    }

    function test_viewReturnDataIdentical() public view {
        address stranger = address(0xdead);
        bytes[] memory calls = new bytes[](9);
        calls[0] = abi.encodeCall(WBSoulMirror.soulOf, (stranger));
        calls[1] = abi.encodeCall(WBSoulMirror.soulAddresses, (1));
        calls[2] = abi.encodeCall(WBSoulMirror.soulPrimaryAddress, (1));
        calls[3] = abi.encodeWithSignature("isSoul(uint256)", 1);
        calls[4] = abi.encodeWithSignature("isSoul(address)", SOUL1_PRIMARY);
        calls[5] = abi.encodeCall(WBSoulMirror.isAddressUsed, (SOUL1_PRIMARY));
        calls[6] = abi.encodeCall(WBSoulMirror.soulOfRevoked, (SOUL1_PRIMARY));
        calls[7] = abi.encodeCall(WBSoulMirror.soulAttributeValue, (1, IS_VERIFIED));
        calls[8] = abi.encodeWithSignature("maxAddressesPerSoul()");

        address[] memory targets = new address[](9);
        for (uint256 i; i < 7; i++) {
            targets[i] = SOUL_REGISTRY;
        }
        targets[7] = ATTRIBUTE_REGISTRY;
        (bool okCfg, bytes memory cfg) = SOUL_REGISTRY.staticcall(abi.encodeCall(WBSoulMirror.config, ()));
        assertTrue(okCfg);
        targets[8] = abi.decode(cfg, (address));

        for (uint256 i; i < calls.length; i++) {
            (bool ok, bytes memory real) = targets[i].staticcall(calls[i]);
            assertTrue(ok);
            assertEq(real, _mirrorCall(calls[i]), vm.toString(i));
        }
    }

    function _mirrorCall(bytes memory data) internal view returns (bytes memory ret) {
        bool ok;
        (ok, ret) = address(mirror).staticcall(data);
        assertTrue(ok);
    }
}
