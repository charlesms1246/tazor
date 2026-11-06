// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {InvoiceAuth} from "../libraries/InvoiceAuth.sol";

interface IPaymentModule {
    function payFromL1(
        address registry,
        address account,
        InvoiceAuth calldata auth,
        address[] calldata approvers,
        bytes[] calldata signatures
    ) external;
}
