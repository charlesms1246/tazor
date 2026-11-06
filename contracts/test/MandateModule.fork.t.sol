// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WBSoulMirror} from "../src/mocks/WBSoulMirror.sol";
import {MandateModuleBase} from "./MandateModule.base.sol";
import {ForkBlocks} from "./ForkBlocks.sol";

/// Same scenario against the deployed Whitechain Sepolia WBSoulMirror and the real track USDT.
contract MandateModuleForkTest is MandateModuleBase {
    address constant MIRROR = 0x9822650A99bD33F29E383345F570dAE1e4E00928;
    address constant USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;
    address constant MIRROR_OWNER = 0xce4389ACb79463062c362fACB8CB04513fA3D8D8;

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
}
