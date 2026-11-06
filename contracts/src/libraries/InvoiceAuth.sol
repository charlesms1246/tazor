// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice One approver's authorization to pay one invoice from a company account.
/// @param invoiceHash Hash of the invoice document.
/// @param account The paying company account.
/// @param payee Recipient of the payment.
/// @param amount Token amount (USDT base units).
/// @param expiry Unix timestamp after which the authorization is invalid.
/// @param nonce Per-invoice nonce; the index into the account's paid bitmap.
struct InvoiceAuth {
    bytes32 invoiceHash;
    address account;
    address payee;
    uint256 amount;
    uint64 expiry;
    uint256 nonce;
}

/// @notice EIP-712 hashing for InvoiceAuth, shared by Whitechain and Ethereum verifiers.
/// Contracts inheriting OZ EIP712 use `_hashTypedDataV4(InvoiceAuthLib.hash(auth))`.
library InvoiceAuthLib {
    bytes32 internal constant TYPEHASH = keccak256(
        "InvoiceAuth(bytes32 invoiceHash,address account,address payee,uint256 amount,uint64 expiry,uint256 nonce)"
    );

    function hash(InvoiceAuth memory auth) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(TYPEHASH, auth.invoiceHash, auth.account, auth.payee, auth.amount, auth.expiry, auth.nonce)
        );
    }

    function digest(bytes32 domainSeparator, InvoiceAuth memory auth) internal pure returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(domainSeparator, hash(auth));
    }
}
