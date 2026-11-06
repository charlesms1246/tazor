// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The two WB Soul reads Tazor needs: SoulRegistry.soulOf and SoulAttributeRegistry.soulAttributeValue.
interface IWBSoulRegistry {
    function soulOf(address addr) external view returns (uint256);
}

interface IWBSoulAttributeRegistry {
    function soulAttributeValue(uint256 soulId, address attribute) external view returns (bytes20);
}
