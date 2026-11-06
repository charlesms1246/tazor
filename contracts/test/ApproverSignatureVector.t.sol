// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ApproverAccount} from "../src/account/ApproverAccount.sol";
import {ApproverAccountFactory} from "../src/account/ApproverAccountFactory.sol";

/// Verifies approvals produced by the web app's TypeScript encoder against a real ApproverAccount.
/// The TS vector wraps the passkey signature with a placeholder verifier address; the inner signature
/// bytes do not depend on the verifier, so they are used verbatim with the factory's real verifier.
contract ApproverSignatureVectorTest is Test {
    bytes4 constant MAGIC = 0x1626ba7e;
    bytes4 constant INVALID = 0xffffffff;

    string vec;
    ApproverAccountFactory factory;
    ApproverAccount account;
    bytes32 x;
    bytes32 y;

    function setUp() public {
        vec = vm.readFile("test/fixtures/approver-sig.json");
        x = vm.parseJsonBytes32(vec, ".x");
        y = vm.parseJsonBytes32(vec, ".y");
        factory = new ApproverAccountFactory();
        bytes[] memory signers = new bytes[](2);
        signers[0] = abi.encodePacked(factory.webAuthnVerifier(), x, y);
        signers[1] = abi.encodePacked(vm.parseJsonAddress(vec, ".backup.eoa"));
        account = ApproverAccount(payable(factory.createAccount(signers)));
    }

    function _wrap(bytes memory signer, bytes memory sig) internal pure returns (bytes memory) {
        bytes[] memory signers = new bytes[](1);
        bytes[] memory sigs = new bytes[](1);
        signers[0] = signer;
        sigs[0] = sig;
        return abi.encode(signers, sigs);
    }

    function _passkey(uint256 i) internal view returns (bytes32 digest, bytes memory sig, bytes memory approval) {
        string memory p = string.concat(".passkey[", vm.toString(i), "]");
        digest = vm.parseJsonBytes32(vec, string.concat(p, ".digest"));
        sig = vm.parseJsonBytes(vec, string.concat(p, ".signature"));
        approval = vm.parseJsonBytes(vec, string.concat(p, ".approval"));
    }

    function test_tsOuterEncodingMatchesSolidity() public view {
        address placeholder = vm.parseJsonAddress(vec, ".verifierPlaceholder");
        bytes memory signer = abi.encodePacked(placeholder, x, y);
        assertEq(signer, vm.parseJsonBytes(vec, ".signer"));
        for (uint256 i; i < 3; ++i) {
            (, bytes memory sig, bytes memory approval) = _passkey(i);
            assertEq(_wrap(signer, sig), approval, vm.toString(i));
        }
        bytes memory backupSig = vm.parseJsonBytes(vec, ".backup.signature");
        assertEq(backupSig.length, 65);
        assertEq(
            _wrap(abi.encodePacked(vm.parseJsonAddress(vec, ".backup.eoa")), backupSig),
            vm.parseJsonBytes(vec, ".backup.approval")
        );
    }

    function test_passkeyApprovalsValid() public view {
        bytes memory signer = abi.encodePacked(factory.webAuthnVerifier(), x, y);
        for (uint256 i; i < 3; ++i) {
            (bytes32 digest, bytes memory sig,) = _passkey(i);
            assertEq(account.isValidSignature(digest, _wrap(signer, sig)), MAGIC, vm.toString(i));
        }
    }

    function test_backupApprovalValidVerbatim() public view {
        bytes32 digest = vm.parseJsonBytes32(vec, ".backup.digest");
        assertEq(account.isValidSignature(digest, vm.parseJsonBytes(vec, ".backup.approval")), MAGIC);
    }

    function test_placeholderVerifierRejected() public view {
        (bytes32 digest,, bytes memory approval) = _passkey(0);
        assertEq(account.isValidSignature(digest, approval), INVALID);
    }

    function test_oneByteChangeFails() public view {
        bytes memory signer = abi.encodePacked(factory.webAuthnVerifier(), x, y);
        for (uint256 i; i < 3; ++i) {
            (bytes32 digest, bytes memory sig,) = _passkey(i);
            uint256[3] memory at = [uint256(5), 0x20 + 5, sig.length - 40];
            for (uint256 k; k < at.length; ++k) {
                bytes memory t = bytes.concat(sig);
                t[at[k]] ^= 0x01;
                assertEq(account.isValidSignature(digest, _wrap(signer, t)), INVALID, string.concat(vm.toString(i), "/", vm.toString(k)));
            }
            assertEq(account.isValidSignature(digest ^ bytes32(uint256(1)), _wrap(signer, sig)), INVALID);
        }
        bytes32 bd = vm.parseJsonBytes32(vec, ".backup.digest");
        bytes memory backup = vm.parseJsonBytes(vec, ".backup.approval");
        bytes memory bt = bytes.concat(backup);
        bt[backup.length - 64] ^= 0x01;
        assertEq(account.isValidSignature(bd, bt), INVALID);
    }
}
