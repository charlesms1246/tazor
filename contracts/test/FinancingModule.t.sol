// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FinancingModule} from "../src/modules/FinancingModule.sol";
import {IPaymentModuleV2Views} from "../src/interfaces/IPaymentModuleV2Views.sol";
import {Approver7702} from "../src/account/Approver7702.sol";
import {MockERC20} from "./mocks/Mocks.sol";

/// Stands in for PaymentModuleV2's views plus the WB Soul registries.
contract MockViews is IPaymentModuleV2Views {
    address public usdt;
    address public soulRegistry = address(this);
    address public attributeRegistry = address(this);
    address public isVerifiedAttribute = address(0xd88f);
    mapping(address => uint256) public soul;
    mapping(uint256 => bool) public verified;
    mapping(address => mapping(address => uint256)) public roles;
    mapping(address => bool) public company;
    mapping(address => bool) public revoked;
    uint256 public threshold = 5e6;

    constructor(address usdt_) { usdt = usdt_; }
    function setSoul(address a, uint256 id, bool v) external { soul[a] = id; verified[id] = v; }
    function setRole(address account, address a, uint256 r) external { roles[account][a] = r; }
    function setCompany(address a) external { company[a] = true; }
    function setRevoked(address a, bool r) external { revoked[a] = r; }
    function soulOf(address a) external view returns (uint256) { return soul[a]; }
    function soulAttributeValue(uint256 id, address) external view returns (bytes20) { return verified[id] ? bytes20(uint160(1)) : bytes20(0); }
    function approverStatus(address account, address a) external view returns (uint256, bool) {
        uint256 id = soul[a];
        return (roles[account][a], id != 0 && verified[id] && !revoked[a]);
    }
    function isTazorAccount(address a) external view returns (bool) { return company[a]; }
    function twoApproverThresholdOf(address) external view returns (uint256) { return threshold; }
}

/// Minimal ERC-7579 executor target: performs a single call for the installed module.
contract MockAccount {
    address public module;
    function setModule(address m) external { module = m; }
    function executeFromExecutor(bytes32, bytes calldata data) external returns (bytes[] memory results) {
        require(msg.sender == module, "not module");
        address target = address(bytes20(data[0:20]));
        (bool ok, bytes memory ret) = target.call(data[52:]);
        require(ok, "call failed");
        results = new bytes[](1);
        results[0] = ret;
    }
}

contract FinancingModuleTest is Test {
    uint256 constant APPROVER = 1 << 64;
    MockERC20 usdt;
    MockViews views;
    MockAccount buyer;
    FinancingModule fin;
    Approver7702 impl;
    uint256 priyaKey = 0xA11CE;
    uint256 cfoKey = 0xCF0;
    uint256 supplierKey = 0x5E11;
    uint256 financierKey = 0xF1;
    address priya;
    address cfo;
    address supplier;
    address financier;

    function setUp() public {
        usdt = new MockERC20();
        views = new MockViews(address(usdt));
        buyer = new MockAccount();
        fin = new FinancingModule(views);
        buyer.setModule(address(fin));
        impl = new Approver7702();
        priya = _wallet(priyaKey, 1);
        cfo = _wallet(cfoKey, 2);
        supplier = _wallet(supplierKey, 3);
        financier = _wallet(financierKey, 4);
        views.setRole(address(buyer), priya, APPROVER);
        views.setRole(address(buyer), cfo, APPROVER);
        usdt.mint(address(buyer), 100e6);
        usdt.mint(financier, 100e6);
    }

    function _wallet(uint256 key, uint256 soulId) internal returns (address a) {
        a = vm.addr(key);
        vm.signAndAttachDelegation(address(impl), key);
        views.setSoul(a, soulId, true);
    }

    function _f(uint256 amount, uint256 nonce) internal view returns (FinancingModule.FinancedInvoice memory) {
        return FinancingModule.FinancedInvoice(keccak256("INV-0099"), address(buyer), supplier, amount, uint64(block.timestamp + 30 days), nonce);
    }

    function _sig(uint256 key, bytes32 h) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, h);
        return abi.encodePacked(r, s, v);
    }

    function _commit(FinancingModule.FinancedInvoice memory f, uint256[] memory keys, address[] memory who) internal returns (uint256) {
        bytes32 d = fin.financedDigest(f);
        bytes[] memory sigs = new bytes[](keys.length);
        for (uint256 i; i < keys.length; ++i) sigs[i] = _sig(keys[i], d);
        return fin.commit(f, who, sigs);
    }

    function _one(uint256 k, address a) internal pure returns (uint256[] memory keys, address[] memory who) {
        keys = new uint256[](1); keys[0] = k;
        who = new address[](1); who[0] = a;
    }

    function _two() internal view returns (uint256[] memory keys, address[] memory who) {
        keys = new uint256[](2); keys[0] = priyaKey; keys[1] = cfoKey;
        who = new address[](2); who[0] = priya; who[1] = cfo;
    }

    function test_fullLifecycle_commitSellSettle() public {
        (uint256[] memory k, address[] memory w) = _two();
        uint256 id = _commit(_f(10e6, 1), k, w);
        assertEq(fin.ownerOf(id), supplier);
        vm.prank(supplier);
        fin.list(id, 9.7e6);
        vm.prank(financier);
        usdt.approve(address(fin), 9.7e6);
        vm.prank(financier);
        fin.buy(id);
        assertEq(fin.ownerOf(id), financier);
        assertEq(usdt.balanceOf(supplier), 9.7e6, "supplier paid early at a discount");
        vm.expectRevert();
        fin.settle(id);
        vm.warp(block.timestamp + 30 days);
        fin.settle(id);
        assertEq(usdt.balanceOf(financier), 100e6 - 9.7e6 + 10e6, "financier paid face value at maturity");
        assertEq(usdt.balanceOf(address(buyer)), 90e6);
        vm.expectRevert();
        fin.ownerOf(id);
    }

    function test_oneApproverBelowThreshold() public {
        (uint256[] memory k, address[] memory w) = _one(priyaKey, priya);
        uint256 id = _commit(_f(2e6, 2), k, w);
        assertEq(fin.ownerOf(id), supplier);
    }

    function test_twoApproversAboveThreshold() public {
        (uint256[] memory k, address[] memory w) = _one(priyaKey, priya);
        FinancingModule.FinancedInvoice memory f = _f(10e6, 3);
        bytes32 d = fin.financedDigest(f);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sig(priyaKey, d);
        vm.expectRevert(abi.encodeWithSelector(FinancingModule.FinancingNotEnoughApprovers.selector, 2, 1));
        fin.commit(f, w, sigs);
        k;
    }

    function test_revokedApproverRejected() public {
        views.setRevoked(priya, true);
        (uint256[] memory k, address[] memory w) = _one(priyaKey, priya);
        FinancingModule.FinancedInvoice memory f = _f(2e6, 4);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sig(k[0], fin.financedDigest(f));
        vm.expectRevert(abi.encodeWithSelector(FinancingModule.FinancingInvalidApprover.selector, priya));
        fin.commit(f, w, sigs);
    }

    function test_sameSoulCountsOnce() public {
        address priya2 = _wallet(0xA11CE2, 1);
        views.setRole(address(buyer), priya2, APPROVER);
        FinancingModule.FinancedInvoice memory f = _f(10e6, 5);
        bytes32 d = fin.financedDigest(f);
        address[] memory w = new address[](2); w[0] = priya; w[1] = priya2;
        bytes[] memory sigs = new bytes[](2); sigs[0] = _sig(priyaKey, d); sigs[1] = _sig(0xA11CE2, d);
        vm.expectRevert(abi.encodeWithSelector(FinancingModule.FinancingDuplicateSoul.selector, 1));
        fin.commit(f, w, sigs);
    }

    function test_badSignatureRejected() public {
        FinancingModule.FinancedInvoice memory f = _f(2e6, 6);
        address[] memory w = new address[](1); w[0] = priya;
        bytes[] memory sigs = new bytes[](1); sigs[0] = _sig(cfoKey, fin.financedDigest(f));
        vm.expectRevert(abi.encodeWithSelector(FinancingModule.FinancingInvalidSignature.selector, priya));
        fin.commit(f, w, sigs);
    }

    function test_claimsOnlyMoveToVerifiedHolders() public {
        (uint256[] memory k, address[] memory w) = _one(priyaKey, priya);
        uint256 id = _commit(_f(2e6, 7), k, w);
        address stranger = makeAddr("stranger");
        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(FinancingModule.FinancingHolderNotAllowed.selector, stranger));
        fin.transferFrom(supplier, stranger, id);
        address company = makeAddr("company");
        views.setCompany(company);
        vm.prank(supplier);
        fin.transferFrom(supplier, company, id);
        assertEq(fin.ownerOf(id), company);
    }

    function test_unverifiedHolderCannotBeMintedTo() public {
        (uint256[] memory k, address[] memory w) = _one(priyaKey, priya);
        FinancingModule.FinancedInvoice memory f = _f(2e6, 8);
        f.holder = makeAddr("nobody");
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sig(k[0], fin.financedDigest(f));
        vm.expectRevert(abi.encodeWithSelector(FinancingModule.FinancingHolderNotAllowed.selector, f.holder));
        fin.commit(f, w, sigs);
    }

    function test_onlyHolderCanList() public {
        (uint256[] memory k, address[] memory w) = _one(priyaKey, priya);
        uint256 id = _commit(_f(2e6, 9), k, w);
        vm.prank(financier);
        vm.expectRevert(abi.encodeWithSelector(FinancingModule.FinancingNotHolder.selector, financier));
        fin.list(id, 1);
    }

    function test_sameTermsCannotBeCommittedTwice() public {
        (uint256[] memory k, address[] memory w) = _one(priyaKey, priya);
        _commit(_f(2e6, 10), k, w);
        vm.expectRevert();
        this.commitAgain(k, w);
    }

    function commitAgain(uint256[] memory k, address[] memory w) external {
        _commit(_f(2e6, 10), k, w);
    }
}
