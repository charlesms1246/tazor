// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IRoleCache, TazorRoles} from "../interfaces/IRoleCache.sol";

interface IRevocationConfig {
    function registryOf(address account) external view returns (address);
    function isSoulVerified(address approver) external view returns (bool);
    function roleCache() external view returns (IRoleCache);
}

/// @notice Instant, Whitechain-local revocation of an approver for one company account. No un-revoke:
/// re-adding a person means a new ApproverAccount. Deployed by PaymentModule, which supplies the config.
contract RevocationList is EIP712 {
    bytes32 public constant REVOKE_TYPEHASH = keccak256("Revoke(address account,address target,uint256 deadline)");

    IRevocationConfig public immutable config;

    mapping(address account => mapping(address approver => bool)) public isRevoked;

    event ApproverRevoked(address indexed account, address indexed target, address indexed admin);

    error RevocationExpired();
    error RevocationUnknownAccount(address account);
    error RevocationAlreadyRevoked(address target);
    error RevocationInvalidAdmin(address admin);
    error RevocationInvalidSignature();

    constructor() EIP712("Tazor", "1") {
        config = IRevocationConfig(msg.sender);
    }

    /// @param sig ERC-1271 signature by `admin` over Revoke(account, target, deadline).
    /// The admin needs ROLE_TAZOR_ADMIN, except when revoking itself (target == admin).
    function revoke(address account, address target, address admin, uint256 deadline, bytes calldata sig) external {
        require(block.timestamp <= deadline, RevocationExpired());
        address registry = config.registryOf(account);
        require(registry != address(0), RevocationUnknownAccount(account));
        require(!isRevoked[account][target], RevocationAlreadyRevoked(target));
        require(!isRevoked[account][admin] && config.isSoulVerified(admin), RevocationInvalidAdmin(admin));
        if (target != admin) {
            (uint256 roles,) = config.roleCache().rolesOf(registry, admin);
            require(roles & TazorRoles.ROLE_TAZOR_ADMIN != 0, RevocationInvalidAdmin(admin));
        }
        require(
            SignatureChecker.isValidSignatureNow(admin, revokeDigest(account, target, deadline), sig),
            RevocationInvalidSignature()
        );

        isRevoked[account][target] = true;
        emit ApproverRevoked(account, target, admin);
    }

    function revokeDigest(address account, address target, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REVOKE_TYPEHASH, account, target, deadline)));
    }
}
