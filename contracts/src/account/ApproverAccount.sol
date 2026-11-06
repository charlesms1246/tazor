// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Account} from "@openzeppelin/contracts/account/Account.sol";
import {ERC7821} from "@openzeppelin/contracts/account/extensions/draft-ERC7821.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {MultiSignerERC7913} from "@openzeppelin/contracts/utils/cryptography/signers/MultiSignerERC7913.sol";

/// @notice One per person; its address is the person's identity. Threshold 1 over ERC-7913 signers:
/// a passkey (WebAuthn verifier ++ x ++ y) and optionally a 20-byte ECDSA backup address.
/// Signature format for isValidSignature and userOps: abi.encode(bytes[] signers, bytes[] signatures).
contract ApproverAccount is Account, MultiSignerERC7913, ERC7821, IERC1271, Initializable {
    constructor() MultiSignerERC7913(_unusableSigners(), 1) {
        _disableInitializers();
    }

    function initialize(bytes[] calldata signers) external initializer {
        _addSigners(signers);
        _setThreshold(1);
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) public view returns (bytes4) {
        return _rawSignatureValidation(hash, signature) ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    function addSigners(bytes[] memory signers) external onlyEntryPointOrSelf {
        _addSigners(signers);
    }

    function removeSigners(bytes[] memory signers) external onlyEntryPointOrSelf {
        _removeSigners(signers);
    }

    function _erc7821AuthorizedExecutor(address caller, bytes32 mode, bytes calldata executionData)
        internal
        view
        override
        returns (bool)
    {
        return caller == address(entryPoint()) || super._erc7821AuthorizedExecutor(caller, mode, executionData);
    }

    /// @dev The implementation is never initialized; address(0) as an ECDSA signer can never validate.
    function _unusableSigners() private pure returns (bytes[] memory signers) {
        signers = new bytes[](1);
        signers[0] = abi.encodePacked(address(0));
    }
}
