// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {ApproverAccountFactory} from "../../src/account/ApproverAccountFactory.sol";
import {RoleCache} from "../../src/ens/RoleCache.sol";
import {MockGatewayVerifier} from "../RoleCache.t.sol";
import {GasMeter} from "./GasMeter.sol";

/// No fork. Passkey numbers depend on the EVM version: run once with the default (prague: no P-256
/// precompile, OZ falls back to Solidity) and once with --evm-version osaka (P256VERIFY at 0x100).
contract GasReportLocalTest is GasMeter {
    ApproverAccountFactory factory;
    bytes passkey;
    address backup;
    uint256 backupKey;
    string fixture;

    function setUp() public {
        factory = new ApproverAccountFactory();
        fixture = vm.readFile("test/fixtures/webauthn.json");
        passkey = abi.encodePacked(
            factory.webAuthnVerifier(), vm.parseJsonBytes32(fixture, ".x"), vm.parseJsonBytes32(fixture, ".y")
        );
        (backup, backupKey) = makeAddrAndKey("backup");
    }

    function _hasP256Precompile() internal view returns (bool) {
        // valid fixture signature verified directly at 0x100
        bytes32 h = vm.parseJsonBytes32(fixture, ".assertions[0].messageHash");
        (bool ok, bytes memory ret) = address(0x100).staticcall(
            abi.encode(
                h,
                vm.parseJsonBytes32(fixture, ".assertions[0].r"),
                vm.parseJsonBytes32(fixture, ".assertions[0].s"),
                vm.parseJsonBytes32(fixture, ".x"),
                vm.parseJsonBytes32(fixture, ".y")
            )
        );
        return ok && ret.length == 32 && uint256(bytes32(ret)) == 1;
    }

    function _account(bool withBackup) internal returns (address) {
        bytes[] memory signers = new bytes[](withBackup ? 2 : 1);
        signers[0] = passkey;
        if (withBackup) signers[1] = abi.encodePacked(backup);
        return factory.createAccount(signers);
    }

    function _wrap(bytes memory signer, bytes memory sig) internal pure returns (bytes memory) {
        bytes[] memory signers = new bytes[](1);
        bytes[] memory sigs = new bytes[](1);
        signers[0] = signer;
        sigs[0] = sig;
        return abi.encode(signers, sigs);
    }

    function test_gas_approverAccount_passkey() public {
        bytes[] memory signers = new bytes[](1);
        signers[0] = passkey;
        _measure("ApproverAccount deploy, passkey", address(factory), abi.encodeCall(factory.createAccount, (signers)));
    }

    function test_gas_approverAccount_passkeyBackup() public {
        bytes[] memory signers = new bytes[](2);
        signers[0] = passkey;
        signers[1] = abi.encodePacked(backup);
        _measure(
            "ApproverAccount deploy, passkey + backup", address(factory), abi.encodeCall(factory.createAccount, (signers))
        );
    }

    function test_gas_isValidSignature_passkey() public {
        address account = _account(true);
        string memory p = ".assertions[0]";
        WebAuthn.WebAuthnAuth memory a = WebAuthn.WebAuthnAuth({
            r: vm.parseJsonBytes32(fixture, string.concat(p, ".r")),
            s: vm.parseJsonBytes32(fixture, string.concat(p, ".s")),
            challengeIndex: vm.parseJsonUint(fixture, string.concat(p, ".challengeIndex")),
            typeIndex: vm.parseJsonUint(fixture, string.concat(p, ".typeIndex")),
            authenticatorData: vm.parseJsonBytes(fixture, string.concat(p, ".authenticatorData")),
            clientDataJSON: vm.parseJsonString(fixture, string.concat(p, ".clientDataJSON"))
        });
        bytes memory sig = _wrap(
            passkey, abi.encode(a.r, a.s, a.challengeIndex, a.typeIndex, a.authenticatorData, a.clientDataJSON)
        );
        bytes32 challenge = vm.parseJsonBytes32(fixture, string.concat(p, ".challenge"));
        assertEq(IERC1271(account).isValidSignature(challenge, sig), IERC1271.isValidSignature.selector);
        _measure(
            string.concat("ERC-1271 passkey check [", _hasP256Precompile() ? "osaka, P-256 precompile" : "prague, Solidity P-256", "]"),
            account,
            abi.encodeCall(IERC1271.isValidSignature, (challenge, sig))
        );
    }

    function test_gas_isValidSignature_backup() public {
        address account = _account(true);
        bytes32 h = keccak256("invoice");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(backupKey, h);
        _measure(
            "ERC-1271 backup (ECDSA) check",
            account,
            abi.encodeCall(IERC1271.isValidSignature, (h, _wrap(abi.encodePacked(backup), abi.encodePacked(r, s, v))))
        );
    }

    function test_gas_syncRoles_mockVerifier() public {
        MockGatewayVerifier verifier = new MockGatewayVerifier();
        RoleCache cache = new RoleCache(verifier);
        string memory json = vm.readFile("test/fixtures/roles-proof.json");
        address registry = vm.parseJsonAddress(json, ".registry");
        address account = 0xce4389ACb79463062c362fACB8CB04513fA3D8D8;
        verifier.set(keccak256(cache.request(registry, account).ops), vm.parseJsonBytes32(json, ".value"), 0);
        _measure(
            "RoleCache.syncRoles, real proof, MOCK verifier",
            address(cache),
            abi.encodeCall(RoleCache.syncRoles, (registry, account, vm.parseJsonBytes(json, ".witness")))
        );
    }
}
