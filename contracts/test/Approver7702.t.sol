// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Approver7702} from "../src/account/Approver7702.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

contract Approver7702Test is Test {
    Approver7702 impl;
    uint256 aliceKey = 0xA11CE;
    address alice;

    function setUp() public {
        impl = new Approver7702();
        alice = vm.addr(aliceKey);
        vm.signAndAttachDelegation(address(impl), aliceKey);
    }

    function _sign(uint256 key, bytes32 h) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, h);
        return abi.encodePacked(r, s, v);
    }

    function test_delegatedWalletKeepsAddressAndHasCode() public view {
        assertGt(alice.code.length, 0);
        assertEq(alice.code, abi.encodePacked(hex"ef0100", address(impl)));
    }

    function test_erc1271AcceptsOwnKey() public view {
        bytes32 h = keccak256("tazor invoice digest");
        assertEq(IERC1271(alice).isValidSignature(h, _sign(aliceKey, h)), IERC1271.isValidSignature.selector);
        assertTrue(SignatureChecker.isValidSignatureNow(alice, h, _sign(aliceKey, h)));
    }

    function test_erc1271RejectsOtherKey() public view {
        bytes32 h = keccak256("tazor invoice digest");
        assertEq(IERC1271(alice).isValidSignature(h, _sign(0xB0B, h)), bytes4(0xffffffff));
        assertFalse(SignatureChecker.isValidSignatureNow(alice, h, _sign(0xB0B, h)));
    }

    function test_strangerCannotExecute() public {
        vm.expectRevert();
        vm.prank(address(0xBAD));
        Approver7702(payable(alice)).execute(bytes32(0), "");
    }
}
