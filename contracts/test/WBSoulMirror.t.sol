// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {WBSoulMirror} from "../src/mocks/WBSoulMirror.sol";

contract WBSoulMirrorTest is Test {
    address constant IS_VERIFIED = 0xd88fa142B67F561C5f2Cbf803bF5AE906a8f1e41;
    bytes20 constant VERIFIED = bytes20(uint160(1));

    WBSoulMirror mirror;
    address whitebit = makeAddr("whitebit");
    address alice = makeAddr("alice");

    function setUp() public {
        mirror = new WBSoulMirror(whitebit);
    }

    function test_selectorsMatchMainnetAbi() public view {
        string memory sigs = vm.readFile("test/fixtures/wbsoul.signatures.json");
        string memory artifact = vm.readFile("out/WBSoulMirror.sol/WBSoulMirror.json");
        string[] memory mirrorSigs = vm.parseJsonKeys(artifact, ".methodIdentifiers");

        string[] memory mainnet = vm.parseJsonStringArray(sigs, ".soulRegistryFunctions");
        string[] memory attr = vm.parseJsonStringArray(sigs, ".attributeRegistryFunctions");
        string[] memory cfg = vm.parseJsonStringArray(sigs, ".configFunctions");

        for (uint256 i; i < mainnet.length; i++) {
            string memory path = string.concat(".methodIdentifiers['", mainnet[i], "']");
            assertTrue(vm.keyExistsJson(artifact, path), string.concat("mirror lacks ", mainnet[i]));
            assertEq(
                vm.parseBytes(string.concat("0x", vm.parseJsonString(artifact, path))),
                abi.encodePacked(bytes4(keccak256(bytes(mainnet[i])))),
                mainnet[i]
            );
        }
        assertEq(mirrorSigs.length, mainnet.length + attr.length + cfg.length, "mirror has unlisted functions");
        for (uint256 i; i < attr.length; i++) {
            assertTrue(vm.keyExistsJson(artifact, string.concat(".methodIdentifiers['", attr[i], "']")), attr[i]);
        }
        for (uint256 i; i < cfg.length; i++) {
            assertTrue(vm.keyExistsJson(artifact, string.concat(".methodIdentifiers['", cfg[i], "']")), cfg[i]);
        }
    }

    function test_eventTopicsMatchMainnetAbi() public pure {
        assertEq(WBSoulMirror.AddressAssigned.selector, keccak256("AddressAssigned(address,uint256)"));
        assertEq(WBSoulMirror.AddressRevoked.selector, keccak256("AddressRevoked(address,uint256)"));
        assertEq(
            WBSoulMirror.PrimaryAddressChanged.selector, keccak256("PrimaryAddressChanged(uint256,address,address)")
        );
        assertEq(
            WBSoulMirror.AttributeValueChanged.selector,
            keccak256("AttributeValueChanged(uint256,address,bytes20,bytes20)")
        );
    }

    function test_registerAssignVerifyRevoke() public {
        vm.startPrank(whitebit);
        mirror.registerSoul(alice);
        uint256 soul = mirror.soulOf(alice);
        assertEq(soul, 1);
        assertEq(mirror.soulPrimaryAddress(soul), alice);

        address phone = makeAddr("phone");
        mirror.assignAddress(soul, phone);
        assertEq(mirror.soulOf(phone), soul);
        assertEq(mirror.soulAddresses(soul).length, 2);

        mirror.setAttribute(soul, IS_VERIFIED, VERIFIED);
        assertEq(mirror.soulAttributeValue(soul, IS_VERIFIED), VERIFIED);

        mirror.revokeAddress(phone);
        assertEq(mirror.soulOf(phone), 0);
        assertEq(mirror.soulOfRevoked(phone), soul);
        assertTrue(mirror.isAddressUsed(phone));

        mirror.setAttribute(soul, IS_VERIFIED, bytes20(0));
        assertEq(mirror.soulAttributeValue(soul, IS_VERIFIED), bytes20(0));
        vm.stopPrank();
    }

    function test_maxFiveAddressesPerSoul() public {
        vm.startPrank(whitebit);
        mirror.registerSoul(alice);
        for (uint256 i = 1; i < 5; i++) {
            mirror.assignAddress(1, vm.addr(100 + i));
        }
        vm.expectRevert("SoulRegistry: addresses per soul limit exceeded");
        mirror.assignAddress(1, address(0x2000));
    }

    function test_cannotRevokePrimary() public {
        vm.startPrank(whitebit);
        mirror.registerSoul(alice);
        vm.expectRevert("SoulRegistry: cannot revoke soul's primary address");
        mirror.revokeAddress(alice);
    }

    function test_writesAreOwnerOnly() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);
        vm.startPrank(alice);
        vm.expectRevert(err);
        mirror.registerSoul(alice);
        vm.expectRevert(err);
        mirror.assignAddress(1, alice);
        vm.expectRevert(err);
        mirror.revokeAddress(alice);
        vm.expectRevert(err);
        mirror.changePrimaryAddress(1, alice);
        vm.expectRevert(err);
        mirror.setAttribute(1, IS_VERIFIED, VERIFIED);
    }
}
