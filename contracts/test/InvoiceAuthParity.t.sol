// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {InvoiceAuth, InvoiceAuthLib} from "../src/libraries/InvoiceAuth.sol";

/// Fixed vector produced by the web client's invoice and InvoiceAuth code.
/// If either side changes its encoding, this test fails.
contract InvoiceAuthParityTest is Test {
    function test_matchesWebClientVector() public pure {
        bytes memory canonical =
            bytes(
                '{"id":"INV-2026-0001","supplierName":"Acme Steel Pvt Ltd","supplierAccount":"0x0000000000000000000000000000000000000002","payee":"0x0000000000000000000000000000000000000003","buyerAccount":"0x0000000000000000000000000000000000000001","token":"0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7","amount":"1250500000","dueDate":1798761600,"lines":[{"description":"Steel rods 12mm","quantity":"100","unitPrice":"12000000"},{"description":"Delivery","quantity":"1","unitPrice":"50500000"}],"memo":"PO 4471"}'
            );
        bytes32 invoiceHash = keccak256(canonical);
        assertEq(invoiceHash, 0xc85cca45cd5c38307310a6605ded415efbb52cb66abe16037c923ad1ae4d059d);

        InvoiceAuth memory auth = InvoiceAuth({
            invoiceHash: invoiceHash,
            account: address(1),
            payee: address(3),
            amount: 1_250_500_000,
            expiry: 2_000_000_000,
            nonce: 7
        });
        assertEq(InvoiceAuthLib.hash(auth), 0x10dae004e7d0fc07e98a43018f8a20a037476cbafe27cc31e3e17b3f205a2735);

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Tazor"),
                keccak256("1"),
                uint256(1874),
                address(0xdEaD)
            )
        );
        assertEq(domainSeparator, 0x12b512d8db92646623a346b829be339c360bfcf18297ce5d54b869cb39d80468);
        assertEq(
            InvoiceAuthLib.digest(domainSeparator, auth), 0xb7399b5d83c93cf90a0e136bc1f0b4817ff78004f1bcba9ea9c07f645e7b707b
        );
    }
}
