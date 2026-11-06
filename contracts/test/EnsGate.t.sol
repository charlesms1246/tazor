// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EnsGate} from "../src/l1/EnsGate.sol";
import {IPaymentModule} from "../src/l1/IPaymentModule.sol";
import {InvoiceAuth} from "../src/libraries/InvoiceAuth.sol";

contract MockPortal {
    address public to;
    uint256 public value;
    uint64 public gasLimit;
    bool public isCreation;
    bytes public data;
    uint256 public msgValue;
    uint256 public calls;

    function depositTransaction(address to_, uint256 value_, uint64 gasLimit_, bool isCreation_, bytes calldata data_)
        external
        payable
    {
        (to, value, gasLimit, isCreation, data, msgValue) = (to_, value_, gasLimit_, isCreation_, data_, msg.value);
        ++calls;
    }
}

contract MockRegistry {
    mapping(string => address) public sub;
    mapping(address => uint256) public rootRoles;

    function setSub(string calldata label, address r) external {
        sub[label] = r;
    }

    function setRoles(address a, uint256 r) external {
        rootRoles[a] = r;
    }

    function getSubregistry(string calldata label) external view returns (address) {
        return sub[label];
    }

    function roles(uint256 resource, address a) external view returns (uint256) {
        return resource == 0 ? rootRoles[a] : 0;
    }
}

contract EnsGateTest is Test {
    uint64 constant L2_GAS = 300_000;
    address constant MODULE = address(0x7000);
    address constant ACCOUNT = address(0xACC);
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    address constant MALLORY = address(0xBAD);

    MockPortal portal;
    MockRegistry parent;
    MockRegistry acme;
    EnsGate gate;

    function setUp() public {
        vm.warp(1_800_000_000);
        portal = new MockPortal();
        parent = new MockRegistry();
        acme = new MockRegistry();
        parent.setSub("acme", address(acme));
        acme.setRoles(ALICE, 1 << 64);
        acme.setRoles(BOB, (1 << 64) | (1 << 68));
        acme.setRoles(MALLORY, 1 << 68);
        gate = new EnsGate(address(portal), address(parent), MODULE, L2_GAS);
    }

    function _auth() internal view returns (InvoiceAuth memory) {
        return InvoiceAuth(keccak256("inv"), ACCOUNT, address(0xBEEF), 1_250_500000, uint64(block.timestamp + 1 days), 7);
    }

    function _list(address a, address b) internal pure returns (address[] memory l, bytes[] memory s) {
        uint256 n = b == address(0) ? 1 : 2;
        l = new address[](n);
        s = new bytes[](n);
        l[0] = a;
        s[0] = hex"aa01";
        if (n == 2) {
            l[1] = b;
            s[1] = hex"bb02";
        }
    }

    function test_forwardEncodesExactDeposit() public {
        InvoiceAuth memory auth = _auth();
        (address[] memory l, bytes[] memory s) = _list(ALICE, BOB);
        vm.expectEmit(address(gate));
        emit EnsGate.Forwarded("acme", ACCOUNT, 7);
        gate.forward("acme", ACCOUNT, auth, l, s);

        assertEq(portal.calls(), 1);
        assertEq(portal.to(), MODULE);
        assertEq(portal.value(), 0);
        assertEq(portal.msgValue(), 0);
        assertEq(portal.gasLimit(), L2_GAS);
        assertFalse(portal.isCreation());
        assertEq(portal.data(), abi.encodeCall(IPaymentModule.payFromL1, (address(acme), ACCOUNT, auth, l, s)));
    }

    function test_revertNotApprover() public {
        (address[] memory l, bytes[] memory s) = _list(ALICE, MALLORY);
        vm.expectRevert(abi.encodeWithSelector(EnsGate.NotApprover.selector, MALLORY));
        gate.forward("acme", ACCOUNT, _auth(), l, s);
    }

    function test_revertUnknownLabel() public {
        (address[] memory l, bytes[] memory s) = _list(ALICE, address(0));
        vm.expectRevert(abi.encodeWithSelector(EnsGate.UnknownCompany.selector, "nobody"));
        gate.forward("nobody", ACCOUNT, _auth(), l, s);
    }

    function test_revertDuplicateApprover() public {
        (address[] memory l, bytes[] memory s) = _list(ALICE, ALICE);
        vm.expectRevert(abi.encodeWithSelector(EnsGate.DuplicateApprover.selector, ALICE));
        gate.forward("acme", ACCOUNT, _auth(), l, s);
    }

    function test_revertExpired() public {
        InvoiceAuth memory auth = _auth();
        auth.expiry = uint64(block.timestamp - 1);
        (address[] memory l, bytes[] memory s) = _list(ALICE, address(0));
        vm.expectRevert(EnsGate.Expired.selector);
        gate.forward("acme", ACCOUNT, auth, l, s);
    }

    function test_revertAccountMismatch() public {
        (address[] memory l, bytes[] memory s) = _list(ALICE, address(0));
        vm.expectRevert(EnsGate.AccountMismatch.selector);
        gate.forward("acme", address(0xDEAD), _auth(), l, s);
    }

    function test_revertBadApproverList() public {
        address[] memory l = new address[](1);
        l[0] = ALICE;
        vm.expectRevert(EnsGate.BadApproverList.selector);
        gate.forward("acme", ACCOUNT, _auth(), l, new bytes[](0));
        vm.expectRevert(EnsGate.BadApproverList.selector);
        gate.forward("acme", ACCOUNT, _auth(), new address[](0), new bytes[](0));
    }
}
