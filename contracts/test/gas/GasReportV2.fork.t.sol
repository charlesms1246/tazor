// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InvoiceAuth} from "../../src/libraries/InvoiceAuth.sol";
import {PaymentModuleV2} from "../../src/modules/PaymentModuleV2.sol";
import {WBSoulMirror} from "../../src/mocks/WBSoulMirror.sol";
import {ForkBlocks} from "../ForkBlocks.sol";
import {TazorFixtureV2} from "../TazorFixtureV2.sol";
import {GasMeter} from "./GasMeter.sol";

/// v2 rows for the gas report: Whitechain Sepolia fork, real USDT + WBSoulMirror, real L1Block.
contract GasReportV2WhitechainTest is TazorFixtureV2, GasMeter {
    address addedPayee = makeAddr("added-payee");

    function _deployTokenAndSoul() internal override {
        vm.createSelectFork("whitechain_testnet", ForkBlocks.WHITECHAIN_SEPOLIA);
        usdt = IERC20(0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7);
        mirror = WBSoulMirror(0x9822650A99bD33F29E383345F570dAE1e4E00928);
        whitebit = 0xce4389ACb79463062c362fACB8CB04513fA3D8D8;
    }

    function _fund(address to, uint256 amount) internal override {
        vm.prank(whitebit);
        require(usdt.transfer(to, amount));
    }

    function setUp() public override {
        super.setUp();
        _allowPayee(buyer, addedPayee);
        _fund(addedPayee, 1); // existing balance, like the v1 "payee balance > 0" rows
    }

    function _payOneCall(address to, uint256 amount, uint256 n) internal returns (bytes memory) {
        InvoiceAuth memory auth = _auth(buyer, to, amount);
        bytes32 d = pm.invoiceDigest(auth);
        (address[] memory ap, bytes[] memory sg) = n == 1 ? _approvals(bob, d) : _approvals(alice, bob, d);
        return abi.encodeCall(PaymentModuleV2.payOne, (buyer, auth, ap, sg));
    }

    function test_gas_v2_payOne_1approver_addedPayee() public {
        _measure("v2 payOne, 1 approver, added payee (balance > 0)", address(pm), _payOneCall(addedPayee, 1e6, 1));
    }

    function test_gas_v2_payOne_2approvers_addedPayee_fresh() public {
        _measure(
            "v2 payOne, 2 approvers, added payee, fresh-proof rule",
            address(pm),
            _payOneCall(addedPayee, 6e6, 2)
        );
    }

    function test_gas_v2_payOne_1approver_addedTazorAccountPayee() public {
        _measure("v2 payOne, 1 approver, added Tazor-account payee (balance > 0)", address(pm), _payOneCall(supplierAccount, 1e6, 1));
    }

    function test_gas_v2_payOne_1approver_steadyWindow() public {
        (bool ok,) = address(pm).call(_payOneCall(addedPayee, 1e6, 1)); // earlier payment this window
        require(ok);
        _measure("v2 payOne, 1 approver, added payee, window already used", address(pm), _payOneCall(addedPayee, 1e6, 1));
    }

    function test_gas_v2_payRun10() public {
        InvoiceAuth[] memory auths = new InvoiceAuth[](10);
        for (uint256 i; i < 10; i++) {
            auths[i] = _auth(buyer, addedPayee, 1e6);
        }
        (address[] memory ap, bytes[] memory sg) = _approvals(alice, bob, pm.runDigest(auths));
        _measure(
            "v2 payRun(10), 2 approvers, one added payee [/10 per invoice]",
            address(pm),
            abi.encodeCall(PaymentModuleV2.payRun, (buyer, auths, ap, sg))
        );
    }

    function test_gas_v2_payAsAgent() public {
        InvoiceAuth memory auth = _auth(buyer, addedPayee, 1e6);
        _measure(
            "v2 payAsAgent",
            address(pm),
            abi.encodeCall(PaymentModuleV2.payAsAgent, (buyer, auth, ann.account, _sign(ann, pm.invoiceDigest(auth))))
        );
    }

    function test_gas_v2_addPayee() public {
        uint256 d = _deadline();
        address p = makeAddr("new-payee");
        bytes memory sig = _sign(alice, pm.typedDigest(keccak256(abi.encode(pm.ADD_PAYEE_TYPEHASH(), buyer, p, d))));
        _measure("v2 addPayee", address(pm), abi.encodeCall(PaymentModuleV2.addPayee, (buyer, p, alice.account, d, sig)));
    }
}
