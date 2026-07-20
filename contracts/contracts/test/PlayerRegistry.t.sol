// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PlayerRegistry} from "../PlayerRegistry.sol";

contract PlayerRegistryTest is Test {
    PlayerRegistry internal registry;

    address internal admin = makeAddr("admin");
    address internal gameManager = makeAddr("gameManager");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        registry = new PlayerRegistry(admin);
        bytes32 gameManagerRole = registry.GAME_MANAGER_ROLE();
        vm.prank(admin);
        registry.grantRole(gameManagerRole, gameManager);
    }

    function test_RegisterDisplayName() public {
        vm.prank(alice);
        registry.registerDisplayName("Alice");
        assertEq(registry.displayNameOf(alice), "Alice");
    }

    function test_RevertWhen_DisplayNameTooLong() public {
        vm.prank(alice);
        vm.expectRevert(PlayerRegistry.DisplayNameTooLong.selector);
        registry.registerDisplayName("this display name is deliberately far too long to accept");
    }

    function test_RevertWhen_NonGameManagerRecordsResult() public {
        vm.prank(alice);
        vm.expectRevert();
        registry.recordResult(alice, bob);
    }

    function test_RecordResult_UpdatesBothPlayersStats() public {
        vm.prank(gameManager);
        registry.recordResult(alice, bob);

        (uint32 aliceWins, uint32 aliceLosses, uint32 aliceGames) = registry.statsOf(alice);
        assertEq(aliceWins, 1);
        assertEq(aliceLosses, 0);
        assertEq(aliceGames, 1);

        (uint32 bobWins, uint32 bobLosses, uint32 bobGames) = registry.statsOf(bob);
        assertEq(bobWins, 0);
        assertEq(bobLosses, 1);
        assertEq(bobGames, 1);
    }

    function testFuzz_RepeatedWinsAccumulateCorrectly(uint8 winCount) public {
        winCount = uint8(bound(winCount, 0, 50));
        for (uint256 i = 0; i < winCount; i++) {
            vm.prank(gameManager);
            registry.recordResult(alice, bob);
        }

        (uint32 aliceWins,, uint32 aliceGames) = registry.statsOf(alice);
        assertEq(aliceWins, winCount);
        assertEq(aliceGames, winCount);
    }
}
