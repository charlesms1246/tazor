// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @notice SIMULATED WB Soul for networks without WhiteBIT's registry.
/// Exposes the full ABI of SoulRegistry (Whitechain mainnet 0x...2000) with the same logic,
/// plus the attribute read/write pair of SoulAttributeRegistry (0x...2002) and
/// SoulRegistryConfig.maxAddressesPerSoul (0x...2001), so one mirror stands in for all three.
/// The owner plays WhiteBIT: registerSoul, assignAddress, revokeAddress, changePrimaryAddress,
/// and setAttribute(soulId, IS_VERIFIED, bytes20(uint160(1))) to mark a soul verified.
contract WBSoulMirror is Ownable {
    using EnumerableSet for EnumerableSet.AddressSet;

    uint8 public constant maxAddressesPerSoul = 5;

    uint256 public lastSoulId;
    mapping(address => uint256) private soulsByAddress;
    mapping(uint256 => address) private primaryAddressesBySoul;
    mapping(uint256 => EnumerableSet.AddressSet) private addressListsBySoul;
    mapping(address => uint256) private revokedAddresses;
    mapping(uint256 => mapping(address => bytes20)) private attributeValues;

    event PrimaryAddressChanged(uint256 indexed soulId, address previousValue, address newValue);
    event AddressAssigned(address indexed addr, uint256 indexed soulId);
    event AddressRevoked(address indexed addr, uint256 indexed soulId);
    event AttributeValueChanged(
        uint256 indexed soulId, address indexed attribute, bytes20 previousValue, bytes20 newValue
    );

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Mainnet returns the separate SoulRegistryConfig; the mirror is its own config.
    function config() external view returns (address) {
        return address(this);
    }

    function registerSoul(address addr) external onlyOwner {
        require(addr != address(0), "SoulRegistry: zero address is not allowed");
        require(!isAddressUsed(addr), "SoulRegistry: address has been already used");

        uint256 soulId = lastSoulId + 1;
        soulsByAddress[addr] = soulId;
        addressListsBySoul[soulId].add(addr);
        primaryAddressesBySoul[soulId] = addr;
        lastSoulId = soulId;

        emit PrimaryAddressChanged(soulId, address(0), addr);
        emit AddressAssigned(addr, soulId);
    }

    function changePrimaryAddress(uint256 soulId, address addr) external onlyOwner {
        if (primaryAddressesBySoul[soulId] == addr) return;
        require(primaryAddressesBySoul[soulId] != address(0), "SoulRegistry: soul does not exist");
        require(soulsByAddress[addr] == soulId, "SoulRegistry: address is not assigned to specified soul");

        emit PrimaryAddressChanged(soulId, primaryAddressesBySoul[soulId], addr);
        primaryAddressesBySoul[soulId] = addr;
    }

    function assignAddress(uint256 soulId, address addr) external onlyOwner {
        require(primaryAddressesBySoul[soulId] != address(0), "SoulRegistry: soul does not exist");
        require(addr != address(0), "SoulRegistry: zero address is not allowed");
        require(
            !isAddressUsed(addr) || revokedAddresses[addr] == soulId, "SoulRegistry: address has been already used"
        );
        require(
            addressListsBySoul[soulId].length() < maxAddressesPerSoul,
            "SoulRegistry: addresses per soul limit exceeded"
        );

        addressListsBySoul[soulId].add(addr);
        soulsByAddress[addr] = soulId;
        delete revokedAddresses[addr];
        emit AddressAssigned(addr, soulId);
    }

    function revokeAddress(address addr) external onlyOwner {
        uint256 soulId = soulsByAddress[addr];
        require(soulId != 0, "SoulRegistry: address is not assigned to any soul");
        require(addr != primaryAddressesBySoul[soulId], "SoulRegistry: cannot revoke soul's primary address");

        addressListsBySoul[soulId].remove(addr);
        delete soulsByAddress[addr];
        revokedAddresses[addr] = soulId;
        emit AddressRevoked(addr, soulId);
    }

    /// @notice Owner-only here; on mainnet each attribute contract gates its own writes.
    function setAttribute(uint256 soulId, address attribute, bytes20 value) external onlyOwner {
        require(primaryAddressesBySoul[soulId] != address(0), "SoulRegistry: soul does not exist");
        bytes20 previous = attributeValues[soulId][attribute];
        require(previous != value, "SoulAttributeRegistry: soul attribute will not change");

        emit AttributeValueChanged(soulId, attribute, previous, value);
        attributeValues[soulId][attribute] = value;
    }

    function soulAttributeValue(uint256 soulId, address attribute) external view returns (bytes20) {
        return attributeValues[soulId][attribute];
    }

    function isSoul(uint256 id) external view returns (bool) {
        return primaryAddressesBySoul[id] != address(0);
    }

    function isSoul(address addr) external view returns (bool) {
        return soulsByAddress[addr] != 0;
    }

    function soulOf(address addr) external view returns (uint256) {
        return soulsByAddress[addr];
    }

    function soulOfRevoked(address addr) external view returns (uint256) {
        return revokedAddresses[addr];
    }

    function soulPrimaryAddress(uint256 soulId) external view returns (address) {
        return primaryAddressesBySoul[soulId];
    }

    function soulAddresses(uint256 soulId) external view returns (address[] memory) {
        return addressListsBySoul[soulId].values();
    }

    function isAddressUsed(address addr) public view returns (bool) {
        return soulsByAddress[addr] != 0 || revokedAddresses[addr] != 0;
    }
}
