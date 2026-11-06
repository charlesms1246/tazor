// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {InvoiceAuth, InvoiceAuthLib} from "../src/libraries/InvoiceAuth.sol";

contract InvoiceAuthHarness is EIP712 {
    constructor() EIP712("Tazor", "1") {}

    function digest(InvoiceAuth calldata auth) external view returns (bytes32) {
        return _hashTypedDataV4(InvoiceAuthLib.hash(auth));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}

contract InvoiceAuthTest is Test {
    string constant TYPE_STRING =
        "InvoiceAuth(bytes32 invoiceHash,address account,address payee,uint256 amount,uint64 expiry,uint256 nonce)";

    InvoiceAuthHarness harness;
    InvoiceAuth auth;

    function setUp() public {
        vm.chainId(1874);
        harness = new InvoiceAuthHarness();
        auth = InvoiceAuth({
            invoiceHash: keccak256("invoice #42"),
            account: address(0xA11CE),
            payee: address(0xB0B),
            amount: 1_250_000_000,
            expiry: 1_800_000_000,
            nonce: 42
        });
    }

    function test_typehashStringIsExact() public pure {
        assertEq(InvoiceAuthLib.TYPEHASH, keccak256(bytes(TYPE_STRING)));
        assertEq(
            InvoiceAuthLib.TYPEHASH, 0x3468a997c2cd2eb8b30a11916926ce2f723a7a30dafa311b2c16f4674a5075b7, "pinned typehash"
        );
    }

    function test_typehashMatchesForgeEip712Encoder() public pure {
        assertEq(InvoiceAuthLib.TYPEHASH, vm.eip712HashType(TYPE_STRING));
    }

    function test_structHashMatchesManualEncoding() public view {
        bytes32 manual = keccak256(
            abi.encode(
                keccak256(bytes(TYPE_STRING)),
                auth.invoiceHash,
                auth.account,
                auth.payee,
                auth.amount,
                auth.expiry,
                auth.nonce
            )
        );
        assertEq(InvoiceAuthLib.hash(auth), manual);
    }

    function test_digestMatchesManualAndHarness() public view {
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Tazor"),
                keccak256("1"),
                uint256(1874),
                address(harness)
            )
        );
        bytes32 manual = keccak256(abi.encodePacked("\x19\x01", domainSep, InvoiceAuthLib.hash(auth)));
        assertEq(harness.domainSeparator(), domainSep);
        assertEq(InvoiceAuthLib.digest(domainSep, auth), manual);
        assertEq(harness.digest(auth), manual);
    }

    function test_digestMatchesSignTypedDataJson() public view {
        assertEq(harness.digest(auth), vm.eip712HashTypedData(_typedDataJson(1874, address(harness))));
    }

    function test_signatureRecoversSigner() public {
        (address signer, uint256 pk) = makeAddrAndKey("approver");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, harness.digest(auth));
        assertEq(ECDSA.recover(harness.digest(auth), v, r, s), signer);
    }

    function test_chainIdChangesDigest() public {
        bytes32 onWhitechain = harness.digest(auth);
        vm.chainId(11155111);
        bytes32 onSepolia = harness.digest(auth);
        assertTrue(onWhitechain != onSepolia);
        assertEq(onSepolia, vm.eip712HashTypedData(_typedDataJson(11155111, address(harness))));
    }

    function test_fieldChangesDigest() public {
        bytes32 base = harness.digest(auth);
        auth.amount += 1;
        assertTrue(harness.digest(auth) != base);
    }

    function _typedDataJson(uint256 chainId, address verifyingContract) internal view returns (string memory) {
        string memory types = string.concat(
            '"types":{"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},',
            '{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],',
            '"InvoiceAuth":[{"name":"invoiceHash","type":"bytes32"},{"name":"account","type":"address"},',
            '{"name":"payee","type":"address"},{"name":"amount","type":"uint256"},',
            '{"name":"expiry","type":"uint64"},{"name":"nonce","type":"uint256"}]}'
        );
        string memory domain = string.concat(
            '"domain":{"name":"Tazor","version":"1","chainId":',
            vm.toString(chainId),
            ',"verifyingContract":"',
            vm.toString(verifyingContract),
            '"}'
        );
        string memory message = string.concat(
            '"message":{"invoiceHash":"',
            vm.toString(auth.invoiceHash),
            '","account":"',
            vm.toString(auth.account),
            '","payee":"',
            vm.toString(auth.payee),
            '","amount":"',
            vm.toString(auth.amount),
            '","expiry":"',
            vm.toString(uint256(auth.expiry)),
            '","nonce":"',
            vm.toString(auth.nonce),
            '"}'
        );
        return string.concat("{", types, ',"primaryType":"InvoiceAuth",', domain, ",", message, "}");
    }
}
