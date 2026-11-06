// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {InvoiceAuth} from "../libraries/InvoiceAuth.sol";
import {IPaymentModule} from "./IPaymentModule.sol";

interface IEnsRegistry {
    function getSubregistry(string calldata label) external view returns (address);
    function roles(uint256 resource, address account) external view returns (uint256);
}

interface IOptimismPortal {
    function depositTransaction(address to, uint256 value, uint64 gasLimit, bool isCreation, bytes calldata data)
        external
        payable;
}

/// @notice Ethereum-side fallback: checks ENSv2 APPROVER roles and forwards an approved payment
/// to the Whitechain PaymentModule through the OptimismPortal. Permissionless, ownerless, immutable.
contract EnsGate {
    uint256 public constant ROLE_APPROVER = 1 << 64;

    IOptimismPortal public immutable portal;
    IEnsRegistry public immutable taz0rRegistry;
    address public immutable paymentModule;
    uint64 public immutable l2GasLimit;

    event Forwarded(string label, address indexed account, uint256 indexed nonce);

    error UnknownCompany(string label);
    error BadApproverList();
    error NotApprover(address approver);
    error DuplicateApprover(address approver);
    error AccountMismatch();
    error Expired();

    constructor(address portal_, address taz0rRegistry_, address paymentModule_, uint64 l2GasLimit_) {
        portal = IOptimismPortal(portal_);
        taz0rRegistry = IEnsRegistry(taz0rRegistry_);
        paymentModule = paymentModule_;
        l2GasLimit = l2GasLimit_;
    }

    function forward(
        string calldata label,
        address account,
        InvoiceAuth calldata auth,
        address[] calldata approvers,
        bytes[] calldata signatures
    ) external {
        if (auth.account != account) revert AccountMismatch();
        if (auth.expiry < block.timestamp) revert Expired();
        if (approvers.length == 0 || approvers.length != signatures.length) revert BadApproverList();

        address registry = taz0rRegistry.getSubregistry(label);
        if (registry == address(0)) revert UnknownCompany(label);

        for (uint256 i; i < approvers.length; ++i) {
            address a = approvers[i];
            for (uint256 j; j < i; ++j) {
                if (approvers[j] == a) revert DuplicateApprover(a);
            }
            if (IEnsRegistry(registry).roles(0, a) & ROLE_APPROVER == 0) revert NotApprover(a);
        }

        portal.depositTransaction(
            paymentModule,
            0,
            l2GasLimit,
            false,
            abi.encodeCall(IPaymentModule.payFromL1, (registry, account, auth, approvers, signatures))
        );
        emit Forwarded(label, account, auth.nonce);
    }
}
