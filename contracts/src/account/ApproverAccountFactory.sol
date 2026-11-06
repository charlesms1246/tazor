// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ERC7913WebAuthnVerifier} from "@openzeppelin/contracts/utils/cryptography/verifiers/ERC7913WebAuthnVerifier.sol";
import {ApproverAccount} from "./ApproverAccount.sol";

/// @notice Deploys ApproverAccount clones at an address determined by the initial signers.
contract ApproverAccountFactory {
    address public immutable implementation;
    /// @notice ERC-7913 verifier for passkey signers: signer = abi.encodePacked(webAuthnVerifier, x, y).
    address public immutable webAuthnVerifier;

    event ApproverAccountCreated(address indexed account, bytes[] signers);

    constructor() {
        implementation = address(new ApproverAccount());
        webAuthnVerifier = address(new ERC7913WebAuthnVerifier());
    }

    /// @notice Idempotent: returns the existing account if already deployed.
    function createAccount(bytes[] calldata signers) external returns (address account) {
        bytes32 salt = keccak256(abi.encode(signers));
        account = Clones.predictDeterministicAddress(implementation, salt);
        if (account.code.length == 0) {
            Clones.cloneDeterministic(implementation, salt);
            ApproverAccount(payable(account)).initialize(signers);
            emit ApproverAccountCreated(account, signers);
        }
    }

    function predictAddress(bytes[] calldata signers) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, keccak256(abi.encode(signers)));
    }
}
