// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {WBSoulMirror} from "../src/mocks/WBSoulMirror.sol";
import {MirrorOperator} from "../src/mocks/MirrorOperator.sol";

contract MirrorOperatorTest is Test {
    address constant IS_VERIFIED = 0xd88fa142B67F561C5f2Cbf803bF5AE906a8f1e41;
    bytes20 constant VERIFIED = bytes20(uint160(1));

    WBSoulMirror mirror;
    MirrorOperator op;
    address deployer = makeAddr("deployer");
    address operator = makeAddr("operator");
    address stranger = makeAddr("stranger");
    address priya = makeAddr("priya");
    address priyaSecond = makeAddr("priyaSecond");
    address guest = makeAddr("guest");
    uint256 priyaSoul;

    function setUp() public {
        vm.warp(1_800_000_000);
        mirror = new WBSoulMirror(deployer);
        // an existing, verified soul with a second address, as on the testnet mirror today
        vm.startPrank(deployer);
        mirror.registerSoul(priya);
        priyaSoul = mirror.soulOf(priya);
        mirror.assignAddress(priyaSoul, priyaSecond);
        mirror.setAttribute(priyaSoul, IS_VERIFIED, VERIFIED);
        op = new MirrorOperator(mirror, deployer, 3);
        op.setOperator(operator, true);
        mirror.transferOwnership(address(op));
        vm.stopPrank();
    }

    function test_operatorRegistersANewVerifiedSoul() public {
        vm.expectEmit(true, true, true, true, address(op));
        emit MirrorOperator.SoulVerified(priyaSoul + 1, guest, operator);
        vm.prank(operator);
        uint256 id = op.registerVerified(guest);
        assertEq(id, priyaSoul + 1);
        assertEq(mirror.soulOf(guest), id);
        assertEq(mirror.soulPrimaryAddress(id), guest);
        assertEq(mirror.soulAttributeValue(id, IS_VERIFIED), VERIFIED);
        assertEq(op.remainingToday(), 2);
    }

    function test_onlyWhitelistedOperators() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MirrorOperator.NotOperator.selector, stranger));
        op.registerVerified(guest);
        vm.prank(deployer); // the owner is not an operator either unless whitelisted
        vm.expectRevert(abi.encodeWithSelector(MirrorOperator.NotOperator.selector, deployer));
        op.registerVerified(guest);
        vm.prank(deployer);
        op.setOperator(operator, false);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(MirrorOperator.NotOperator.selector, operator));
        op.registerVerified(guest);
    }

    function test_operatorCannotTouchExistingSouls() public {
        // an address already on a soul (primary or secondary) cannot be re-registered
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(MirrorOperator.SoulExists.selector, priya, priyaSoul));
        op.registerVerified(priya);
        vm.expectRevert(abi.encodeWithSelector(MirrorOperator.SoulExists.selector, priyaSecond, priyaSoul));
        op.registerSoul(priyaSecond);
        // nor mark an existing soul verified
        vm.expectRevert(abi.encodeWithSelector(MirrorOperator.NotRegisteredHere.selector, priyaSoul));
        op.setVerified(priyaSoul);
        vm.stopPrank();

        // a revoked address stays used, so it cannot come back as a fresh verified soul
        vm.prank(deployer);
        op.execute(abi.encodeCall(WBSoulMirror.revokeAddress, (priyaSecond)));
        vm.prank(operator);
        vm.expectRevert("SoulRegistry: address has been already used");
        op.registerVerified(priyaSecond);

        // the operator has no path to the mirror's other functions: not directly (not the owner) …
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        mirror.revokeAddress(priya);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        mirror.setAttribute(priyaSoul, IS_VERIFIED, bytes20(0));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        mirror.assignAddress(priyaSoul, guest);
        // … nor through the operator contract's owner functions
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        op.execute(abi.encodeCall(WBSoulMirror.setAttribute, (priyaSoul, IS_VERIFIED, bytes20(0))));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        op.transferMirrorOwnership(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        op.setDailyCap(1000);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        op.setOperator(stranger, true);
        vm.stopPrank();

        // Priya's soul is unchanged
        assertEq(mirror.soulAttributeValue(priyaSoul, IS_VERIFIED), VERIFIED);
        assertEq(mirror.soulOf(priya), priyaSoul);
    }

    function test_registerSoulThenSetVerified_asTheRelayerCallsIt() public {
        vm.startPrank(operator);
        uint256 id = op.registerSoul(guest);
        assertEq(mirror.soulOf(guest), id);
        assertEq(mirror.soulAttributeValue(id, IS_VERIFIED), bytes20(0));
        assertTrue(op.registeredHere(id));
        // a retry is a no-op returning the same soul and does not use the cap again
        assertEq(op.registerSoul(guest), id);
        assertEq(op.remainingToday(), 2);
        op.setVerified(id);
        assertEq(mirror.soulAttributeValue(id, IS_VERIFIED), VERIFIED);
        op.setVerified(id); // already verified: no-op
        // a soul id not registered here (or that does not exist) is refused
        vm.expectRevert(abi.encodeWithSelector(MirrorOperator.NotRegisteredHere.selector, id + 1));
        op.setVerified(id + 1);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MirrorOperator.NotOperator.selector, stranger));
        op.setVerified(id);
    }

    function test_dailyCapHoldsAndResetsAtUtcMidnight() public {
        vm.startPrank(operator);
        for (uint256 i; i < 3; i++) op.registerVerified(address(uint160(0xA000 + i)));
        uint256 day = block.timestamp / 1 days;
        vm.expectRevert(abi.encodeWithSelector(MirrorOperator.DailyCapReached.selector, day, 3));
        op.registerVerified(address(0xA003));
        assertEq(op.remainingToday(), 0);
        vm.warp((day + 1) * 1 days);
        op.registerVerified(address(0xA003));
        vm.stopPrank();
        assertEq(op.remainingToday(), 2);

        vm.prank(deployer);
        op.setDailyCap(0);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(MirrorOperator.DailyCapReached.selector, day + 1, 0));
        op.registerVerified(address(0xA004));
    }

    function test_ownerForwardsAnyCallAndCanTakeTheMirrorBack() public {
        vm.startPrank(deployer);
        op.execute(abi.encodeCall(WBSoulMirror.setAttribute, (priyaSoul, IS_VERIFIED, bytes20(0))));
        assertEq(mirror.soulAttributeValue(priyaSoul, IS_VERIFIED), bytes20(0));
        // a failing forwarded call reverts with the mirror's reason
        vm.expectRevert(
            abi.encodeWithSelector(
                MirrorOperator.ExecuteFailed.selector,
                abi.encodeWithSignature("Error(string)", "SoulAttributeRegistry: soul attribute will not change")
            )
        );
        op.execute(abi.encodeCall(WBSoulMirror.setAttribute, (priyaSoul, IS_VERIFIED, bytes20(0))));

        op.transferMirrorOwnership(deployer);
        assertEq(mirror.owner(), deployer);
        mirror.registerSoul(guest); // the deployer is WhiteBIT again
        vm.stopPrank();

        // and the operator key lost its only power with it
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(op)));
        op.registerVerified(address(0xB0B));
    }
}
