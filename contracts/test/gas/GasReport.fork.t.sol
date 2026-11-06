// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InvoiceAuth} from "../../src/libraries/InvoiceAuth.sol";
import {ApproverAccountFactory} from "../../src/account/ApproverAccountFactory.sol";
import {TazorAccountFactory} from "../../src/account/TazorAccountFactory.sol";
import {PaymentModule} from "../../src/modules/PaymentModule.sol";
import {RevocationList} from "../../src/modules/RevocationList.sol";
import {MandateModule} from "../../src/modules/MandateModule.sol";
import {WBSoulMirror} from "../../src/mocks/WBSoulMirror.sol";
import {TazorFixture} from "../TazorFixture.sol";
import {GasMeter} from "./GasMeter.sol";
import {ForkBlocks} from "../ForkBlocks.sol";

/// Whitechain Sepolia fork, real track USDT and the deployed WBSoulMirror.
contract GasReportWhitechainTest is TazorFixture, GasMeter {
    address constant MIRROR = 0x9822650A99bD33F29E383345F570dAE1e4E00928;
    address constant USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;
    address constant MIRROR_OWNER = 0xce4389ACb79463062c362fACB8CB04513fA3D8D8;

    MandateModule mm;
    address mandateCo;

    function _deployTokenAndSoul() internal override {
        vm.createSelectFork("whitechain_testnet", ForkBlocks.WHITECHAIN_SEPOLIA);
        usdt = IERC20(USDT);
        mirror = WBSoulMirror(MIRROR);
        whitebit = MIRROR_OWNER;
    }

    function _fund(address to, uint256 amount) internal override {
        vm.prank(MIRROR_OWNER);
        require(usdt.transfer(to, amount));
    }

    function setUp() public override {
        super.setUp();
        mm = new MandateModule(pm);
        mandateCo = _company("gas-mandate-co", address(mm));
        _fund(mandateCo, 5e6);
    }

    // ---- account deploys

    function _companyCall(uint256 nAdmins, bool withMandate, string memory salt) internal view returns (bytes memory) {
        bytes[] memory admins = new bytes[](nAdmins);
        admins[0] = abi.encodePacked(alice.account);
        if (nAdmins == 2) admins[1] = abi.encodePacked(bob.account);
        uint256 n = withMandate ? 2 : 1;
        address[] memory executors = new address[](n);
        bytes[] memory data = new bytes[](n);
        executors[0] = address(pm);
        data[0] = abi.encode(REGISTRY, THRESHOLD);
        if (withMandate) executors[1] = address(mm);
        return abi.encodeCall(
            TazorAccountFactory.createAccount,
            (TazorAccountFactory.Config(admins, uint64(nAdmins), executors, data), keccak256(bytes(salt)))
        );
    }

    function test_gas_tazorAccount_1admin() public {
        _measure("TazorAccount deploy, 1 admin, PaymentModule", address(accountFactory), _companyCall(1, false, "g1"));
    }

    function test_gas_tazorAccount_2admins() public {
        _measure("TazorAccount deploy, 2 admins, PaymentModule", address(accountFactory), _companyCall(2, false, "g2"));
    }

    function test_gas_tazorAccount_1admin_mandate() public {
        _measure("TazorAccount deploy, 1 admin, Payment+Mandate", address(accountFactory), _companyCall(1, true, "g3"));
    }

    function test_gas_tazorAccount_2admins_mandate() public {
        _measure("TazorAccount deploy, 2 admins, Payment+Mandate", address(accountFactory), _companyCall(2, true, "g4"));
    }

    function test_gas_approverAccount_backupOnly() public {
        bytes[] memory signers = new bytes[](1);
        signers[0] = abi.encodePacked(makeAddr("gas-backup"));
        _measure(
            "ApproverAccount deploy, ECDSA backup only",
            address(approverFactory),
            abi.encodeCall(ApproverAccountFactory.createAccount, (signers))
        );
    }

    // ---- payments

    function _payOneCall(uint256 nApprovers, uint256 amount) internal returns (bytes memory) {
        InvoiceAuth memory auth = _auth(buyer, payee, amount);
        bytes32 digest = pm.invoiceDigest(auth);
        (address[] memory ap, bytes[] memory sg) = nApprovers == 1 ? _approvals(bob, digest) : _approvals(alice, bob, digest);
        return abi.encodeCall(PaymentModule.payOne, (buyer, auth, ap, sg));
    }

    function test_gas_payOne_1approver_freshPayee() public {
        _measure("payOne, 1 approver, payee balance 0", address(pm), _payOneCall(1, 1e6));
    }

    function test_gas_payOne_1approver_existingPayee() public {
        _fund(payee, 1);
        _measure("payOne, 1 approver, payee balance > 0", address(pm), _payOneCall(1, 1e6));
    }

    function test_gas_payOne_2approvers_freshPayee() public {
        _measure("payOne, 2 approvers, payee balance 0", address(pm), _payOneCall(2, 6e6));
    }

    function test_gas_payOne_2approvers_existingPayee() public {
        _fund(payee, 1);
        _measure("payOne, 2 approvers, payee balance > 0", address(pm), _payOneCall(2, 6e6));
    }

    function test_gas_payRun10() public {
        InvoiceAuth[] memory auths = new InvoiceAuth[](10);
        for (uint256 i; i < 10; i++) {
            auths[i] = _auth(buyer, vm.addr(0xBEEF00 + i), 1e6);
        }
        (address[] memory ap, bytes[] memory sg) = _approvals(alice, bob, pm.runDigest(auths));
        _measure(
            "payRun(10), 2 approvers, fresh payees [/10 per invoice]",
            address(pm),
            abi.encodeCall(PaymentModule.payRun, (buyer, auths, ap, sg))
        );
    }

    function test_gas_payFromL1() public {
        InvoiceAuth memory auth = _auth(buyer, payee, 1e6);
        (address[] memory ap, bytes[] memory sg) = _approvals(bob, pm.invoiceDigest(auth));
        bytes memory data = abi.encodeCall(PaymentModule.payFromL1, (REGISTRY, buyer, auth, ap, sg));
        vm.prank(ensGateAlias);
        _measure("payFromL1 (L2 leg), 1 approver, payee balance 0", address(pm), data);
    }

    function test_gas_revoke() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(alice, revocations.revokeDigest(buyer, bob.account, deadline));
        _measure(
            "RevocationList.revoke (admin revokes approver)",
            address(revocations),
            abi.encodeCall(RevocationList.revoke, (buyer, bob.account, alice.account, deadline, sig))
        );
    }

    // ---- mandates

    function _mandate(uint256 cap, uint256 nonce) internal view returns (MandateModule.Mandate memory) {
        return MandateModule.Mandate(mandateCo, payee, cap, 1 days, uint64(block.timestamp + 30 days), nonce);
    }

    function _createCall(MandateModule.Mandate memory m, uint256 nApprovers) internal view returns (bytes memory) {
        bytes32 d = mm.mandateDigest(m);
        (address[] memory ap, bytes[] memory sg) = nApprovers == 1 ? _approvals(bob, d) : _approvals(alice, bob, d);
        return abi.encodeCall(MandateModule.createMandate, (m, ap, sg));
    }

    function _createMandate() internal returns (bytes32 id) {
        MandateModule.Mandate memory m = _mandate(2e6, 1);
        (bool ok, bytes memory ret) = address(mm).call(_createCall(m, 1));
        require(ok);
        id = abi.decode(ret, (bytes32));
    }

    function test_gas_createMandate_1approver() public {
        _measure("createMandate, 1 approver", address(mm), _createCall(_mandate(1e6, 1), 1));
    }

    function test_gas_createMandate_2approvers() public {
        _measure("createMandate, 2 approvers", address(mm), _createCall(_mandate(THRESHOLD + 1, 1), 2));
    }

    function test_gas_pull_first() public {
        bytes32 id = _createMandate();
        _measure("MandateModule.pull, first (payee balance 0)", address(mm), abi.encodeCall(MandateModule.pull, (id, 1e6)));
    }

    function test_gas_pull_steady() public {
        bytes32 id = _createMandate();
        mm.pull(id, 1e6);
        _measure("MandateModule.pull, steady (same period)", address(mm), abi.encodeCall(MandateModule.pull, (id, 5e5)));
    }

    function test_gas_cancel_byApprover() public {
        bytes32 id = _createMandate();
        bytes memory sig = _sign(carol, mm.cancelDigest(id));
        _measure(
            "MandateModule.cancel, by approver",
            address(mm),
            abi.encodeCall(MandateModule.cancel, (id, carol.account, sig))
        );
    }
}
