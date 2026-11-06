// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice OP Stack L1 -> L2 sender aliasing for contract-originated deposits.
library AddressAlias {
    uint160 internal constant OFFSET = uint160(0x1111000000000000000000000000000000001111);

    function applyL1ToL2Alias(address l1Address) internal pure returns (address l2Address) {
        unchecked {
            l2Address = address(uint160(l1Address) + OFFSET);
        }
    }
}
