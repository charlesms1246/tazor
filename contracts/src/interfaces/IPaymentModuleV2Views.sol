// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Read-only surface of PaymentModuleV2 used by other Tazor modules.
interface IPaymentModuleV2Views {
    function approverStatus(address account, address approver) external view returns (uint256 roles, bool valid);
    function isTazorAccount(address a) external view returns (bool);
    function twoApproverThresholdOf(address account) external view returns (uint256);
    function usdt() external view returns (address);
    function soulRegistry() external view returns (address);
    function attributeRegistry() external view returns (address);
    function isVerifiedAttribute() external view returns (address);
}
