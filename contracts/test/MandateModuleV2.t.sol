// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WBSoulMirror} from "../src/mocks/WBSoulMirror.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {MandateModuleV2Base} from "./MandateModuleV2.base.sol";

contract MandateModuleV2Test is MandateModuleV2Base {
    function _deployTokenAndSoul() internal override {
        whitebit = makeAddr("whitebit");
        usdt = IERC20(address(new MockERC20()));
        mirror = new WBSoulMirror(whitebit);
    }

    function _fund(address to, uint256 amount) internal override {
        MockERC20(address(usdt)).mint(to, amount);
    }
}
