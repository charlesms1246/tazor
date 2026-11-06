// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {TazorAccount} from "./TazorAccount.sol";

/// @notice Deploys TazorAccount clones, always with the same PolicyHook.
contract TazorAccountFactory {
    address public immutable implementation;
    address public immutable policyHook;

    event TazorAccountCreated(address indexed account, bytes[] admins, uint64 threshold, address[] executors);

    struct Config {
        bytes[] admins;
        uint64 threshold;
        address[] executors;
        bytes[] executorData;
    }

    constructor(address policyHook_) {
        implementation = address(new TazorAccount());
        policyHook = policyHook_;
    }

    /// @notice Idempotent. The CREATE2 salt binds every init parameter, so a predicted address
    /// cannot be taken with a different configuration.
    function createAccount(Config calldata config, bytes32 salt) external returns (address account) {
        bytes32 fullSalt = _salt(config, salt);
        account = Clones.predictDeterministicAddress(implementation, fullSalt);
        if (account.code.length == 0) {
            Clones.cloneDeterministic(implementation, fullSalt);
            TazorAccount(payable(account)).initialize(
                config.admins, config.threshold, config.executors, config.executorData, policyHook
            );
            emit TazorAccountCreated(account, config.admins, config.threshold, config.executors);
        }
    }

    function predictAddress(Config calldata config, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(config, salt));
    }

    function _salt(Config calldata config, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(config, salt));
    }
}
