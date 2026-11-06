// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Account} from "@openzeppelin/contracts/account/Account.sol";
import {ERC7579Utils, CallType} from "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";
import {
    Execution,
    IERC7579Hook,
    IERC7579Execution,
    IERC7579ModuleConfig,
    MODULE_TYPE_VALIDATOR,
    MODULE_TYPE_EXECUTOR,
    MODULE_TYPE_HOOK
} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";

/// @notice The single ERC-7579 hook of every TazorAccount. Stateless; one deployment serves all accounts.
/// - executeFromExecutor: sender must be an installed executor; single/batch calls only, never to the account.
/// - Admin path (sender is the account or its EntryPoint): execute may only call the account itself
///   with zero value (configuration), installModule only validators, uninstallModule only validators or
///   executors. So no admin path can move tokens or add a new way to move them.
/// - Anything else (fallback calls, delegatecall, other call types) reverts. The hook cannot be uninstalled.
contract PolicyHook is IERC7579Hook {
    error PolicyHookUnauthorizedSender(address sender);
    error PolicyHookForbiddenCallType(CallType callType);
    error PolicyHookForbiddenTarget(address target);
    error PolicyHookForbiddenModule(uint256 moduleTypeId);
    error PolicyHookForbiddenSelector(bytes4 selector);
    error PolicyHookPermanent();

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_HOOK;
    }

    function onInstall(bytes calldata) external {}

    function onUninstall(bytes calldata) external pure {
        revert PolicyHookPermanent();
    }

    function postCheck(bytes calldata) external {}

    function preCheck(address msgSender, uint256 value, bytes calldata msgData)
        external
        view
        returns (bytes memory)
    {
        address account = msg.sender;
        bytes4 selector = msgData.length >= 4 ? bytes4(msgData[:4]) : bytes4(0);

        if (selector == IERC7579Execution.executeFromExecutor.selector) {
            require(
                IERC7579ModuleConfig(account).isModuleInstalled(MODULE_TYPE_EXECUTOR, msgSender, ""),
                PolicyHookUnauthorizedSender(msgSender)
            );
            _checkCalls(account, msgData, false);
            return "";
        }

        require(
            msgSender == account || msgSender == address(Account(payable(account)).entryPoint()),
            PolicyHookUnauthorizedSender(msgSender)
        );

        if (selector == IERC7579Execution.execute.selector) {
            require(value == 0, PolicyHookForbiddenTarget(account));
            _checkCalls(account, msgData, true);
        } else if (selector == IERC7579ModuleConfig.installModule.selector) {
            uint256 moduleTypeId = uint256(bytes32(msgData[4:36]));
            require(moduleTypeId == MODULE_TYPE_VALIDATOR, PolicyHookForbiddenModule(moduleTypeId));
        } else if (selector == IERC7579ModuleConfig.uninstallModule.selector) {
            uint256 moduleTypeId = uint256(bytes32(msgData[4:36]));
            require(
                moduleTypeId == MODULE_TYPE_VALIDATOR || moduleTypeId == MODULE_TYPE_EXECUTOR,
                PolicyHookForbiddenModule(moduleTypeId)
            );
        } else {
            revert PolicyHookForbiddenSelector(selector);
        }
        return "";
    }

    /// @dev Decodes execute(bytes32,bytes) / executeFromExecutor(bytes32,bytes) with the same ERC7579Utils
    /// decoders the account uses. selfOnly: every call must target the account with zero value;
    /// otherwise no call may target the account.
    function _checkCalls(address account, bytes calldata msgData, bool selfOnly) private pure {
        CallType callType = CallType.wrap(bytes1(msgData[4:5]));
        uint256 offset = 4 + uint256(bytes32(msgData[36:68]));
        uint256 length = uint256(bytes32(msgData[offset:offset + 32]));
        bytes calldata executionCalldata = msgData[offset + 32:offset + 32 + length];

        if (callType == ERC7579Utils.CALLTYPE_SINGLE) {
            (address target, uint256 callValue,) = ERC7579Utils.decodeSingle(executionCalldata);
            _checkCall(account, target, callValue, selfOnly);
        } else if (callType == ERC7579Utils.CALLTYPE_BATCH) {
            Execution[] calldata calls = ERC7579Utils.decodeBatch(executionCalldata);
            for (uint256 i; i < calls.length; ++i) {
                _checkCall(account, calls[i].target, calls[i].value, selfOnly);
            }
        } else {
            revert PolicyHookForbiddenCallType(callType);
        }
    }

    function _checkCall(address account, address target, uint256 callValue, bool selfOnly) private pure {
        if (selfOnly) {
            require(target == account && callValue == 0, PolicyHookForbiddenTarget(target));
        } else {
            require(target != account, PolicyHookForbiddenTarget(target));
        }
    }
}
