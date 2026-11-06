// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InvoiceAuth} from "../src/libraries/InvoiceAuth.sol";
import {PaymentModule} from "../src/modules/PaymentModule.sol";
import {WBSoulMirror} from "../src/mocks/WBSoulMirror.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {PaymentModuleBase} from "./PaymentModule.base.sol";

contract PaymentModuleTest is PaymentModuleBase {
    function _deployTokenAndSoul() internal override {
        whitebit = makeAddr("whitebit");
        usdt = IERC20(address(new MockERC20()));
        mirror = new WBSoulMirror(whitebit);
    }

    function _fund(address to, uint256 amount) internal override {
        MockERC20(address(usdt)).mint(to, amount);
    }

    /// PaymentModule's invoice digest equals the web client's vector for the same domain.
    function test_invoiceDigestMatchesWebClientVector() public {
        vm.chainId(1874);
        deployCodeTo(
            "PaymentModule.sol:PaymentModule",
            abi.encode(address(usdt), address(mirror), address(mirror), IS_VERIFIED, address(roleCache), ensGateAlias),
            address(0xdEaD)
        );
        InvoiceAuth memory auth = InvoiceAuth({
            invoiceHash: 0xc85cca45cd5c38307310a6605ded415efbb52cb66abe16037c923ad1ae4d059d,
            account: address(1),
            payee: address(3),
            amount: 1_250_500_000,
            expiry: 2_000_000_000,
            nonce: 7
        });
        assertEq(
            PaymentModule(address(0xdEaD)).invoiceDigest(auth),
            0xb7399b5d83c93cf90a0e136bc1f0b4817ff78004f1bcba9ea9c07f645e7b707b
        );
    }
}
