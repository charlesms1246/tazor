// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRoleCache} from "../interfaces/IRoleCache.sol";

struct GatewayRequest {
    bytes ops;
}

struct GatewayProof {
    bytes rlpEncodedL1Block;
    bytes rlpEncodedL2Block;
    bytes accountProof;
    bytes storageProof;
    bytes[] proofs;
    bytes order;
}

interface IGatewayVerifier {
    function getLatestContext() external view returns (bytes memory);
    function getStorageValues(bytes memory context, GatewayRequest memory req, bytes memory proof)
        external
        view
        returns (bytes[] memory values, uint8 exitCode);
}

/// @notice Caches ENSv2 root roles (`_roles[0][account]` of a company registry on Ethereum) on
/// Whitechain. Anyone can sync with a storage proof checked by a ReverseOPVerifier against L1Block.
/// A sync must prove a newer Ethereum block than the cached one, so old proofs cannot restore
/// revoked roles.
contract RoleCache is IRoleCache {
    /// Base slot of EnhancedAccessControl `_roles` in the ENSv2 UserRegistry layout.
    uint256 public constant ROLES_BASE_SLOT = 2;

    IGatewayVerifier public immutable verifier;

    struct Entry {
        uint256 roles;
        uint64 l1Block;
    }

    mapping(address registry => mapping(address account => Entry)) private _entries;

    event RolesSynced(address indexed registry, address indexed account, uint256 roles, uint64 l1Block);

    error RoleCacheProofFailed(uint8 exitCode);
    error RoleCacheStale(uint64 proven, uint64 cached);

    constructor(IGatewayVerifier verifier_) {
        verifier = verifier_;
    }

    function rolesOf(address registry, address account) external view returns (uint256 roles, uint64 l1Block) {
        Entry storage e = _entries[registry][account];
        return (e.roles, e.l1Block);
    }

    function rolesSlot(address account) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(account, keccak256(abi.encode(uint256(0), ROLES_BASE_SLOT)))));
    }

    function syncRoles(address registry, address account, bytes calldata proof) external {
        (bytes[] memory values, uint8 exitCode) =
            verifier.getStorageValues(verifier.getLatestContext(), request(registry, account), proof);
        require(exitCode == 0, RoleCacheProofFailed(exitCode));
        uint64 provenBlock = provenL1Block(proof);
        Entry storage e = _entries[registry][account];
        require(provenBlock > e.l1Block, RoleCacheStale(provenBlock, e.l1Block));
        uint256 roles = uint256(bytes32(values[0]));
        e.roles = roles;
        e.l1Block = provenBlock;
        emit RolesSynced(registry, account, roles, provenBlock);
    }

    /// @notice The gateway program: target = registry, slot = rolesSlot(account), read, output 0.
    function request(address registry, address account) public pure returns (GatewayRequest memory) {
        return GatewayRequest(
            abi.encodePacked(
                uint8(1), _push(uint160(registry)), uint8(0x32), _push(rolesSlot(account)), uint8(0x46), uint8(0x3c),
                uint8(0), uint8(0x33)
            )
        );
    }

    /// @notice Block number (header field 8) of the Ethereum header inside a ReverseOPVerifier proof.
    function provenL1Block(bytes calldata proof) public pure returns (uint64) {
        bytes memory l1Header = abi.decode(proof, (GatewayProof)).rlpEncodedL1Block;
        uint256 p = _listPayloadStart(l1Header);
        for (uint256 i; i < 8; ++i) {
            p = _skipItem(l1Header, p);
        }
        (uint256 start, uint256 len) = _stringAt(l1Header, p);
        require(len <= 8);
        uint64 n;
        for (uint256 i; i < len; ++i) {
            n = (n << 8) | uint8(l1Header[start + i]);
        }
        return n;
    }

    function _push(uint256 v) private pure returns (bytes memory) {
        if (v == 0) return hex"00";
        uint256 n = 32;
        while (n > 1 && (v >> ((n - 1) * 8)) == 0) --n;
        bytes memory out = new bytes(n + 1);
        out[0] = bytes1(uint8(n));
        for (uint256 i; i < n; ++i) {
            out[1 + i] = bytes1(uint8(v >> ((n - 1 - i) * 8)));
        }
        return out;
    }

    function _listPayloadStart(bytes memory b) private pure returns (uint256) {
        uint8 h = uint8(b[0]);
        require(h >= 0xc0);
        return h <= 0xf7 ? 1 : 1 + (h - 0xf7);
    }

    function _stringAt(bytes memory b, uint256 p) private pure returns (uint256 start, uint256 len) {
        uint8 h = uint8(b[p]);
        if (h < 0x80) return (p, 1);
        if (h <= 0xb7) return (p + 1, h - 0x80);
        require(h <= 0xbf);
        uint256 ll = h - 0xb7;
        for (uint256 i; i < ll; ++i) {
            len = (len << 8) | uint8(b[p + 1 + i]);
        }
        return (p + 1 + ll, len);
    }

    function _skipItem(bytes memory b, uint256 p) private pure returns (uint256) {
        uint8 h = uint8(b[p]);
        if (h < 0xc0) {
            (uint256 start, uint256 len) = _stringAt(b, p);
            return start + len;
        }
        if (h <= 0xf7) return p + 1 + (h - 0xc0);
        uint256 ll = h - 0xf7;
        uint256 len;
        for (uint256 i; i < ll; ++i) {
            len = (len << 8) | uint8(b[p + 1 + i]);
        }
        return p + 1 + ll + len;
    }
}
