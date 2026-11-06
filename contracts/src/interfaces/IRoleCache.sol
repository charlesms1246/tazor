// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Whitechain-side cache of a company's ENS registry roles.
interface IRoleCache {
    function rolesOf(address registry, address account) external view returns (uint256 roles, uint64 l1Block);
}

library TazorRoles {
    uint256 internal constant ROLE_APPROVER = 1 << 64;
    uint256 internal constant ROLE_TAZOR_ADMIN = 1 << 68;
    uint256 internal constant ROLE_AGENT = 1 << 72;
}
