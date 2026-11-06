// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Account as OZAccount} from "@openzeppelin/contracts/account/Account.sol";
import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {ERC7579Utils, Execution} from "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {ApproverAccount} from "../src/account/ApproverAccount.sol";
import {ApproverAccountFactory} from "../src/account/ApproverAccountFactory.sol";
import {ModeLib} from "./mocks/Mocks.sol";

contract ApproverAccountTest is Test {
    bytes4 constant MAGIC = 0x1626ba7e;
    bytes4 constant INVALID = 0xffffffff;

    ApproverAccountFactory factory;
    ApproverAccount account;
    string fixture;
    bytes passkey;
    address backup;
    uint256 backupKey;

    function setUp() public {
        fixture = vm.readFile("test/fixtures/webauthn.json");
        factory = new ApproverAccountFactory();
        passkey = abi.encodePacked(
            factory.webAuthnVerifier(), vm.parseJsonBytes32(fixture, ".x"), vm.parseJsonBytes32(fixture, ".y")
        );
        (backup, backupKey) = makeAddrAndKey("backup");

        bytes[] memory signers = new bytes[](2);
        signers[0] = passkey;
        signers[1] = abi.encodePacked(backup);
        uint256 g = gasleft();
        account = ApproverAccount(payable(factory.createAccount(signers)));
        console2.log("gas ApproverAccountFactory.createAccount (passkey + backup)", g - gasleft());
    }

    // ---- fixture helpers

    function _assertion(uint256 i) internal view returns (bytes32 challenge, WebAuthn.WebAuthnAuth memory auth) {
        string memory p = string.concat(".assertions[", vm.toString(i), "]");
        challenge = vm.parseJsonBytes32(fixture, string.concat(p, ".challenge"));
        auth = WebAuthn.WebAuthnAuth({
            r: vm.parseJsonBytes32(fixture, string.concat(p, ".r")),
            s: vm.parseJsonBytes32(fixture, string.concat(p, ".s")),
            challengeIndex: vm.parseJsonUint(fixture, string.concat(p, ".challengeIndex")),
            typeIndex: vm.parseJsonUint(fixture, string.concat(p, ".typeIndex")),
            authenticatorData: vm.parseJsonBytes(fixture, string.concat(p, ".authenticatorData")),
            clientDataJSON: vm.parseJsonString(fixture, string.concat(p, ".clientDataJSON"))
        });
    }

    function _rawS(uint256 i) internal view returns (bytes32) {
        return vm.parseJsonBytes32(fixture, string.concat(".assertions[", vm.toString(i), "].rawS"));
    }

    function _wrap(bytes memory signer, bytes memory sig) internal pure returns (bytes memory) {
        bytes[] memory signers = new bytes[](1);
        bytes[] memory sigs = new bytes[](1);
        signers[0] = signer;
        sigs[0] = sig;
        return abi.encode(signers, sigs);
    }

    function _passkeySig(WebAuthn.WebAuthnAuth memory auth) internal view returns (bytes memory) {
        return _wrap(passkey, _encodeAuth(auth));
    }

    /// The ERC-7913 WebAuthn verifier reads the struct fields as a flat tuple (no leading offset word),
    /// so abi.encode(auth) does not verify.
    function _encodeAuth(WebAuthn.WebAuthnAuth memory a) internal pure returns (bytes memory) {
        return abi.encode(a.r, a.s, a.challengeIndex, a.typeIndex, a.authenticatorData, a.clientDataJSON);
    }

    function test_structEncodingIsRejected() public view {
        (bytes32 challenge, WebAuthn.WebAuthnAuth memory auth) = _assertion(0);
        assertEq(account.isValidSignature(challenge, _wrap(passkey, abi.encode(auth))), INVALID);
    }

    function _backupSig(bytes32 hash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(backupKey, hash);
        return _wrap(abi.encodePacked(backup), abi.encodePacked(r, s, v));
    }

    // ---- P1-2 real passkey

    function test_passkeyAssertionsReturnMagic() public view {
        for (uint256 i; i < 3; i++) {
            (bytes32 challenge, WebAuthn.WebAuthnAuth memory auth) = _assertion(i);
            assertEq(account.isValidSignature(challenge, _passkeySig(auth)), MAGIC, vm.toString(i));
            assertTrue(SignatureChecker.isValidSignatureNow(address(account), challenge, _passkeySig(auth)));
        }
    }

    function test_passkeyGas() public view {
        (bytes32 challenge, WebAuthn.WebAuthnAuth memory auth) = _assertion(0);
        bytes memory sig = _passkeySig(auth);
        uint256 g = gasleft();
        account.isValidSignature(challenge, sig);
        console2.log("gas ERC-1271 passkey check", g - gasleft());
    }

    function test_rejectsTamperedChallenge() public view {
        (bytes32 challenge, WebAuthn.WebAuthnAuth memory auth) = _assertion(0);
        assertEq(account.isValidSignature(challenge ^ bytes32(uint256(1)), _passkeySig(auth)), INVALID);
        (bytes32 other,) = _assertion(1);
        assertEq(account.isValidSignature(other, _passkeySig(auth)), INVALID);
    }

    function test_rejectsTamperedAuthenticatorData() public view {
        (bytes32 challenge, WebAuthn.WebAuthnAuth memory auth) = _assertion(0);
        auth.authenticatorData[0] ^= 0x01; // rpIdHash
        assertEq(account.isValidSignature(challenge, _passkeySig(auth)), INVALID);
        (, auth) = _assertion(0);
        auth.authenticatorData[36] ^= 0x01; // signature counter
        assertEq(account.isValidSignature(challenge, _passkeySig(auth)), INVALID);
    }

    function test_rejectsHighS() public view {
        for (uint256 i; i < 2; i++) {
            (bytes32 challenge, WebAuthn.WebAuthnAuth memory auth) = _assertion(i);
            assertTrue(_rawS(i) != auth.s, "fixture rawS is the high-s form");
            assertEq(uint256(auth.s) + uint256(_rawS(i)), 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551);
            auth.s = _rawS(i);
            assertEq(account.isValidSignature(challenge, _passkeySig(auth)), INVALID, vm.toString(i));
        }
    }

    function test_rejectsUnknownPasskey() public view {
        (bytes32 challenge, WebAuthn.WebAuthnAuth memory auth) = _assertion(0);
        bytes memory otherKey = abi.encodePacked(factory.webAuthnVerifier(), bytes32(uint256(1)), bytes32(uint256(2)));
        assertEq(account.isValidSignature(challenge, _wrap(otherKey, _encodeAuth(auth))), INVALID);
    }

    // ---- P1-2b backup signer

    function test_backupReturnsMagic() public view {
        bytes32 hash = keccak256("invoice");
        assertEq(account.isValidSignature(hash, _backupSig(hash)), MAGIC);
    }

    function test_backupGas() public view {
        bytes32 hash = keccak256("invoice");
        bytes memory sig = _backupSig(hash);
        uint256 g = gasleft();
        account.isValidSignature(hash, sig);
        console2.log("gas ERC-1271 backup (ECDSA) check", g - gasleft());
    }

    function test_strangerEcdsaRejected() public {
        (, uint256 k) = makeAddrAndKey("stranger");
        bytes32 hash = keccak256("invoice");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, hash);
        assertEq(account.isValidSignature(hash, _wrap(abi.encodePacked(vm.addr(k)), abi.encodePacked(r, s, v))), INVALID);
        // a valid backup signature claimed under another signer id is also rejected
        assertEq(account.isValidSignature(hash, _wrap(abi.encodePacked(vm.addr(k)), abi.encodePacked(_rawBackup(hash)))), INVALID);
    }

    function _rawBackup(bytes32 hash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(backupKey, hash);
        return abi.encodePacked(r, s, v);
    }

    /// Removal through the account's own userOp path: the passkey authorizes, the EntryPoint executes.
    function test_removedBackupRejected() public {
        (bytes32 challenge, WebAuthn.WebAuthnAuth memory auth) = _assertion(2);
        PackedUserOperation memory op;
        op.sender = address(account);
        op.signature = _passkeySig(auth);

        address ep = address(account.entryPoint());
        vm.prank(ep);
        assertEq(account.validateUserOp(op, challenge, 0), 0, "passkey authorizes the userOp");

        bytes[] memory remove = new bytes[](1);
        remove[0] = abi.encodePacked(backup);
        Execution[] memory calls = new Execution[](1);
        calls[0] = Execution(address(account), 0, abi.encodeCall(ApproverAccount.removeSigners, (remove)));
        vm.prank(ep);
        account.execute(ModeLib.mode(ERC7579Utils.CALLTYPE_BATCH), abi.encode(calls));

        assertFalse(account.isSigner(abi.encodePacked(backup)));
        bytes32 hash = keccak256("invoice");
        assertEq(account.isValidSignature(hash, _backupSig(hash)), INVALID);
        assertEq(account.isValidSignature(challenge, _passkeySig(auth)), MAGIC, "passkey still valid");
    }

    function test_badUserOpSignatureFails() public {
        PackedUserOperation memory op;
        op.sender = address(account);
        bytes32 hash = keccak256("op");
        (, uint256 k) = makeAddrAndKey("stranger");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k, hash);
        op.signature = _wrap(abi.encodePacked(vm.addr(k)), abi.encodePacked(r, s, v));
        vm.prank(address(account.entryPoint()));
        assertEq(account.validateUserOp(op, hash, 0), 1);
    }

    function test_signerManagementSelfOnly() public {
        bytes[] memory s = new bytes[](1);
        s[0] = abi.encodePacked(address(this));
        vm.expectRevert(abi.encodeWithSelector(OZAccount.AccountUnauthorized.selector, address(this)));
        account.addSigners(s);
        s[0] = abi.encodePacked(backup);
        vm.expectRevert(abi.encodeWithSelector(OZAccount.AccountUnauthorized.selector, address(this)));
        account.removeSigners(s);
        vm.expectRevert(abi.encodeWithSelector(OZAccount.AccountUnauthorized.selector, address(this)));
        account.execute(ModeLib.mode(ERC7579Utils.CALLTYPE_BATCH), abi.encode(new Execution[](0)));
    }

    function test_cannotRemoveLastSigner() public {
        bytes[] memory all = new bytes[](2);
        all[0] = passkey;
        all[1] = abi.encodePacked(backup);
        vm.prank(address(account));
        vm.expectRevert();
        account.removeSigners(all);
    }

    function test_factoryDeterministicAndIdempotent() public {
        bytes[] memory signers = new bytes[](2);
        signers[0] = passkey;
        signers[1] = abi.encodePacked(backup);
        assertEq(factory.predictAddress(signers), address(account));
        assertEq(factory.createAccount(signers), address(account));
        assertEq(account.threshold(), 1);
        assertEq(account.getSignerCount(), 2);
        vm.expectRevert();
        account.initialize(signers);
    }

    function test_implementationLocked() public {
        ApproverAccount impl = ApproverAccount(payable(factory.implementation()));
        vm.expectRevert();
        impl.initialize(new bytes[](0));
        bytes32 hash = keccak256("x");
        assertEq(impl.isValidSignature(hash, _wrap(abi.encodePacked(address(0)), new bytes(65))), INVALID);
    }
}
