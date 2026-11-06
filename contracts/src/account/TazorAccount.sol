// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccountERC7579} from "@openzeppelin/contracts/account/extensions/draft-AccountERC7579.sol";
import {AccountERC7579Hooked} from "@openzeppelin/contracts/account/extensions/draft-AccountERC7579Hooked.sol";
import {
    MODULE_TYPE_VALIDATOR,
    MODULE_TYPE_EXECUTOR,
    MODULE_TYPE_HOOK
} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {MultiSignerERC7913} from "@openzeppelin/contracts/utils/cryptography/signers/MultiSignerERC7913.sol";

/// @notice One per company. Admin signers are ApproverAccount addresses (20-byte ERC-7913 signers resolved
/// through ERC-1271) with a threshold; they only authorize userOps, whose executions PolicyHook restricts
/// to configuration of this account. Funds move only through installed executors.
contract TazorAccount is AccountERC7579Hooked, MultiSignerERC7913, Initializable {
    error TazorAccountMissingHook();
    error TazorAccountExecutorDataMismatch();

    constructor() MultiSignerERC7913(_unusableSigners(), 1) {
        _disableInitializers();
    }

    /// @dev Executors are installed before the hook, so the hook does not gate initialization.
    /// executorData[i] is passed to executors[i].onInstall.
    function initialize(
        bytes[] calldata admins,
        uint64 threshold_,
        address[] calldata executors,
        bytes[] calldata executorData,
        address hook_
    ) external initializer {
        require(hook_ != address(0), TazorAccountMissingHook());
        require(executors.length == executorData.length, TazorAccountExecutorDataMismatch());
        _addSigners(admins);
        _setThreshold(threshold_);
        for (uint256 i; i < executors.length; ++i) {
            _installModule(MODULE_TYPE_EXECUTOR, executors[i], executorData[i]);
        }
        _installModule(MODULE_TYPE_HOOK, hook_, "");
    }

    function addSigners(bytes[] memory signers) external onlyEntryPointOrSelf {
        _addSigners(signers);
    }

    function removeSigners(bytes[] memory signers) external onlyEntryPointOrSelf {
        _removeSigners(signers);
    }

    function setThreshold(uint64 newThreshold) external onlyEntryPointOrSelf {
        _setThreshold(newThreshold);
    }

    function supportsModule(uint256 moduleTypeId) public pure override returns (bool) {
        return moduleTypeId == MODULE_TYPE_VALIDATOR || moduleTypeId == MODULE_TYPE_EXECUTOR
            || moduleTypeId == MODULE_TYPE_HOOK;
    }

    /// @notice Always invalid: an ERC-1271 yes would let token permit / EIP-3009 authorizations move funds
    /// without passing through an executor.
    function isValidSignature(bytes32, bytes calldata) public pure override returns (bytes4) {
        return bytes4(0xffffffff);
    }

    function _rawSignatureValidation(bytes32 hash, bytes calldata signature)
        internal
        view
        override(AccountERC7579, MultiSignerERC7913)
        returns (bool)
    {
        return MultiSignerERC7913._rawSignatureValidation(hash, signature);
    }

    function _unusableSigners() private pure returns (bytes[] memory signers) {
        signers = new bytes[](1);
        signers[0] = abi.encodePacked(address(0));
    }
}
