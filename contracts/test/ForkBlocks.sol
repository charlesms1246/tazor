// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// One place for every fork pin and the Sepolia archive RPC.
library ForkBlocks {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// Whitechain Sepolia (1874). Kept here because 0xce43…D8D8 holds the ~36.6 USDT the fork suites
    /// impersonate for funding; it holds less at later blocks.
    uint256 internal constant WHITECHAIN_SEPOLIA = 12_343_263;

    /// Whitechain mainnet (1875): soul 1 bound to 0xFD69…F7bC and IsVerified, operator 0xb358…0ED9.
    uint256 internal constant WHITECHAIN_MAINNET = 51_920_000;

    /// Ethereum Sepolia (11155111): after the taz0r.eth / acme registries, CreateX and the portal exist.
    uint256 internal constant ETH_SEPOLIA = 12_074_500;

    /// publicnode prunes old Sepolia state, so Sepolia forks use an archive endpoint.
    /// Override with SEPOLIA_FORK_RPC.
    function sepoliaRpc() internal view returns (string memory) {
        return vm.envOr("SEPOLIA_FORK_RPC", string("https://sepolia.gateway.tenderly.co"));
    }
}
