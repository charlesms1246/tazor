// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Account} from "@openzeppelin/contracts/account/Account.sol";
import {ERC7821} from "@openzeppelin/contracts/account/extensions/draft-ERC7821.sol";
import {SignerEIP7702} from "@openzeppelin/contracts/utils/cryptography/signers/SignerEIP7702.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @notice EIP-7702 delegate for an existing wallet that WhiteBIT already bound to a WB Soul.
/// The wallet keeps its address (its identity in WB Soul and in company ENS roles) and its key,
/// and gains ERC-1271 approvals and ERC-7821 batched self-execution.
contract Approver7702 is Account, SignerEIP7702, ERC7821, IERC1271 {
    /// @notice Raw-hash ERC-1271 with the wallet's own key; Tazor digests already bind chain and verifier.
    function isValidSignature(bytes32 hash, bytes calldata signature) public view returns (bytes4) {
        return _rawSignatureValidation(hash, signature) ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    function _erc7821AuthorizedExecutor(address caller, bytes32 mode, bytes calldata executionData)
        internal
        view
        override
        returns (bool)
    {
        return caller == address(entryPoint()) || super._erc7821AuthorizedExecutor(caller, mode, executionData);
    }
}
