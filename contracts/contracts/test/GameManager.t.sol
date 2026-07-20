// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameManager} from "../GameManager.sol";
import {PlayerRegistry} from "../PlayerRegistry.sol";
import {MockRandomnessProvider} from "../randomness/MockRandomnessProvider.sol";

contract GameManagerTest is Test {
    GameManager internal gameManager;
    PlayerRegistry internal playerRegistry;
    MockRandomnessProvider internal randomnessProvider;

    address internal admin = makeAddr("admin");
    address internal arbiter = makeAddr("arbiter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");
    address internal ownerFeeWallet = makeAddr("ownerFeeWallet");
    address internal platformFeeWallet = makeAddr("platformFeeWallet");
    address internal marketingFeeWallet = makeAddr("marketingFeeWallet");

    function setUp() public {
        playerRegistry = new PlayerRegistry(admin);
        randomnessProvider = new MockRandomnessProvider();

        vm.prank(admin);
        gameManager = new GameManager(
            admin, arbiter, playerRegistry, randomnessProvider, ownerFeeWallet, platformFeeWallet, marketingFeeWallet
        );

        bytes32 gameManagerRole = playerRegistry.GAME_MANAGER_ROLE();
        vm.prank(admin);
        playerRegistry.grantRole(gameManagerRole, address(gameManager));

        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
    }

    function _createJoinedGame() internal returns (uint256 gameId) {
        gameId = _createJoinedGameWithStake(0);
    }

    function _createActiveGame() internal returns (uint256 gameId) {
        gameId = _createActiveGameWithStake(0);
    }

    function _createJoinedGameWithStake(uint256 stake) internal returns (uint256 gameId) {
        vm.prank(alice);
        gameId = gameManager.createGame{value: stake}();

        vm.prank(bob);
        gameManager.joinGame{value: stake}(gameId);
    }

    function _createActiveGameWithStake(uint256 stake) internal returns (uint256 gameId) {
        gameId = _createJoinedGameWithStake(stake);
        vm.prank(alice);
        gameManager.startGame(gameId);

        uint256 requestId = gameManager.getGame(gameId).randomnessRequestId;
        randomnessProvider.fulfill(requestId);
    }

    // -------------------------------------------------------------------
    // Lifecycle: create / join
    // -------------------------------------------------------------------

    function test_CreateGame_SeatsCreatorAsPlayer1() public {
        vm.prank(alice);
        uint256 gameId = gameManager.createGame();

        GameManager.Game memory game = gameManager.getGame(gameId);
        assertEq(game.player1, alice);
        assertEq(uint8(game.state), uint8(GameManager.State.WAITING_FOR_PLAYER));
    }

    function test_JoinGame_SeatsOpponentAndActivatesCreatedState() public {
        uint256 gameId = _createJoinedGame();

        GameManager.Game memory game = gameManager.getGame(gameId);
        assertEq(game.player2, bob);
        assertEq(uint8(game.state), uint8(GameManager.State.CREATED));
    }

    function test_RevertWhen_JoiningOwnGame() public {
        vm.prank(alice);
        uint256 gameId = gameManager.createGame();

        vm.prank(alice);
        vm.expectRevert(GameManager.CannotJoinOwnGame.selector);
        gameManager.joinGame(gameId);
    }

    function test_RevertWhen_DoubleJoining() public {
        uint256 gameId = _createJoinedGame();

        vm.prank(mallory);
        vm.expectRevert(
            abi.encodeWithSelector(
                GameManager.InvalidStateForAction.selector, GameManager.State.CREATED, GameManager.State.WAITING_FOR_PLAYER
            )
        );
        gameManager.joinGame(gameId);
    }

    function test_RevertWhen_JoiningNonexistentGame() public {
        vm.prank(bob);
        vm.expectRevert(GameManager.GameNotFound.selector);
        gameManager.joinGame(999);
    }

    // -------------------------------------------------------------------
    // Lifecycle: start / randomness
    // -------------------------------------------------------------------

    function test_StartGame_ActivatesAndPicksAFirstMover() public {
        uint256 gameId = _createJoinedGame();

        vm.prank(alice);
        gameManager.startGame(gameId);

        GameManager.Game memory pending = gameManager.getGame(gameId);
        assertEq(uint8(pending.state), uint8(GameManager.State.CREATED));

        randomnessProvider.fulfill(pending.randomnessRequestId);

        GameManager.Game memory game = gameManager.getGame(gameId);
        assertEq(uint8(game.state), uint8(GameManager.State.ACTIVE));
        assertTrue(game.firstToMove == alice || game.firstToMove == bob);
    }

    function test_RevertWhen_NonPlayerStartsGame() public {
        uint256 gameId = _createJoinedGame();

        vm.prank(mallory);
        vm.expectRevert(GameManager.NotAPlayer.selector);
        gameManager.startGame(gameId);
    }

    function test_RevertWhen_FulfillingRandomnessFromUntrustedCaller() public {
        uint256 gameId = _createJoinedGame();
        vm.prank(alice);
        gameManager.startGame(gameId);

        vm.prank(mallory);
        vm.expectRevert(GameManager.NotRandomnessProvider.selector);
        gameManager.fulfillRandomness(1, gameId, 42);
    }

    function test_RevertWhen_ReplayingAFulfilledRandomnessRequest() public {
        uint256 gameId = _createJoinedGame();
        vm.prank(alice);
        gameManager.startGame(gameId);

        uint256 requestId = gameManager.getGame(gameId).randomnessRequestId;
        randomnessProvider.fulfill(requestId); // legitimate, first fulfillment

        vm.prank(address(randomnessProvider));
        vm.expectRevert(GameManager.UnknownRandomnessRequest.selector);
        gameManager.fulfillRandomness(requestId, gameId, 42); // replay of the same requestId
    }

    // -------------------------------------------------------------------
    // Lifecycle: result submission / confirmation / dispute
    // -------------------------------------------------------------------

    function test_SubmitResult_MovesToAwaitingResult() public {
        uint256 gameId = _createActiveGame();

        vm.prank(alice);
        gameManager.submitResult(gameId, alice, keccak256("transcript"));

        GameManager.Game memory game = gameManager.getGame(gameId);
        assertEq(uint8(game.state), uint8(GameManager.State.AWAITING_RESULT));
        assertEq(game.claimedWinner, alice);
    }

    function test_RevertWhen_SubmittingResultWithNonPlayerWinner() public {
        uint256 gameId = _createActiveGame();

        vm.prank(alice);
        vm.expectRevert(GameManager.InvalidWinner.selector);
        gameManager.submitResult(gameId, mallory, keccak256("transcript"));
    }

    function test_ConfirmResult_CompletesGameAndRecordsStats() public {
        uint256 gameId = _createActiveGame();

        vm.prank(alice);
        gameManager.submitResult(gameId, alice, keccak256("transcript"));

        vm.prank(bob);
        gameManager.confirmResult(gameId);

        GameManager.Game memory game = gameManager.getGame(gameId);
        assertEq(uint8(game.state), uint8(GameManager.State.COMPLETED));

        (uint32 aliceWins, uint32 aliceLosses, uint32 aliceGames) = playerRegistry.statsOf(alice);
        assertEq(aliceWins, 1);
        assertEq(aliceLosses, 0);
        assertEq(aliceGames, 1);

        (uint32 bobWins, uint32 bobLosses, uint32 bobGames) = playerRegistry.statsOf(bob);
        assertEq(bobWins, 0);
        assertEq(bobLosses, 1);
        assertEq(bobGames, 1);
    }

    function test_RevertWhen_SubmitterConfirmsTheirOwnResult() public {
        uint256 gameId = _createActiveGame();

        vm.prank(alice);
        gameManager.submitResult(gameId, alice, keccak256("transcript"));

        vm.prank(alice);
        vm.expectRevert(GameManager.ResultAlreadySubmittedByCaller.selector);
        gameManager.confirmResult(gameId);
    }

    function test_RevertWhen_ConfirmingBeforeResultSubmitted() public {
        uint256 gameId = _createActiveGame();

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(
                GameManager.InvalidStateForAction.selector, GameManager.State.ACTIVE, GameManager.State.AWAITING_RESULT
            )
        );
        gameManager.confirmResult(gameId);
    }

    function test_DisputeResult_MovesToDisputedAndArbiterResolves() public {
        uint256 gameId = _createActiveGame();

        vm.prank(alice);
        gameManager.submitResult(gameId, alice, keccak256("transcript"));

        vm.prank(bob);
        gameManager.disputeResult(gameId);

        GameManager.Game memory game = gameManager.getGame(gameId);
        assertEq(uint8(game.state), uint8(GameManager.State.DISPUTED));

        vm.prank(arbiter);
        gameManager.resolveDispute(gameId, bob);

        game = gameManager.getGame(gameId);
        assertEq(uint8(game.state), uint8(GameManager.State.COMPLETED));
        assertEq(game.claimedWinner, bob);
    }

    function test_RevertWhen_NonArbiterResolvesDispute() public {
        uint256 gameId = _createActiveGame();
        vm.prank(alice);
        gameManager.submitResult(gameId, alice, keccak256("transcript"));
        vm.prank(bob);
        gameManager.disputeResult(gameId);

        vm.prank(mallory);
        vm.expectRevert();
        gameManager.resolveDispute(gameId, bob);
    }

    function test_FinalizeByTimeout_AfterWindowElapses() public {
        uint256 gameId = _createActiveGame();

        vm.prank(alice);
        gameManager.submitResult(gameId, alice, keccak256("transcript"));

        vm.warp(block.timestamp + gameManager.RESULT_CONFIRMATION_WINDOW() + 1);

        vm.prank(alice);
        gameManager.finalizeByTimeout(gameId);

        GameManager.Game memory game = gameManager.getGame(gameId);
        assertEq(uint8(game.state), uint8(GameManager.State.COMPLETED));
    }

    function test_FinalizeByTimeout_SucceedsAtExactlyTheWindowBoundary() public {
        uint256 gameId = _createActiveGame();

        vm.prank(alice);
        gameManager.submitResult(gameId, alice, keccak256("transcript"));

        vm.warp(block.timestamp + gameManager.RESULT_CONFIRMATION_WINDOW());

        vm.prank(alice);
        gameManager.finalizeByTimeout(gameId);

        GameManager.Game memory game = gameManager.getGame(gameId);
        assertEq(uint8(game.state), uint8(GameManager.State.COMPLETED));
    }

    function test_RevertWhen_FinalizingByTimeoutTooEarly() public {
        uint256 gameId = _createActiveGame();

        vm.prank(alice);
        gameManager.submitResult(gameId, alice, keccak256("transcript"));

        vm.prank(alice);
        vm.expectRevert(GameManager.ConfirmationWindowNotElapsed.selector);
        gameManager.finalizeByTimeout(gameId);
    }

    // -------------------------------------------------------------------
    // Lifecycle: cancel / forfeit
    // -------------------------------------------------------------------

    function test_CancelGame_BeforeOpponentJoins() public {
        vm.prank(alice);
        uint256 gameId = gameManager.createGame();

        vm.prank(alice);
        gameManager.cancelGame(gameId);

        GameManager.Game memory game = gameManager.getGame(gameId);
        assertEq(uint8(game.state), uint8(GameManager.State.CANCELLED));
    }

    function test_RevertWhen_CancelingAnActiveGame() public {
        uint256 gameId = _createActiveGame();

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                GameManager.InvalidStateForAction.selector, GameManager.State.ACTIVE, GameManager.State.WAITING_FOR_PLAYER
            )
        );
        gameManager.cancelGame(gameId);
    }

    function test_ForfeitGame_HandsWinToOpponent() public {
        uint256 gameId = _createActiveGame();

        vm.prank(alice);
        gameManager.forfeitGame(gameId);

        GameManager.Game memory game = gameManager.getGame(gameId);
        assertEq(uint8(game.state), uint8(GameManager.State.COMPLETED));
        assertEq(game.claimedWinner, bob);
    }

    // -------------------------------------------------------------------
    // Access control / pausability
    // -------------------------------------------------------------------

    function test_RevertWhen_NonPauserPauses() public {
        vm.prank(mallory);
        vm.expectRevert();
        gameManager.pause();
    }

    function test_RevertWhen_CreatingGameWhilePaused() public {
        vm.prank(admin);
        gameManager.pause();

        vm.prank(alice);
        vm.expectRevert();
        gameManager.createGame();
    }

    function test_RevertWhen_NonAdminSetsRandomnessProvider() public {
        MockRandomnessProvider newProvider = new MockRandomnessProvider();

        vm.prank(mallory);
        vm.expectRevert();
        gameManager.setRandomnessProvider(newProvider);
    }

    // -------------------------------------------------------------------
    // Fuzz tests
    // -------------------------------------------------------------------

    function testFuzz_OnlySeatedPlayersCanSubmitMoves(address caller, bytes32 commitment) public {
        uint256 gameId = _createActiveGame();
        vm.assume(caller != alice && caller != bob);

        vm.prank(caller);
        vm.expectRevert(GameManager.NotAPlayer.selector);
        gameManager.submitMove(gameId, commitment);
    }

    function testFuzz_FinalizeByTimeoutOnlyAfterWindow(uint256 elapsed) public {
        // Strictly less than the window - at exactly the window, the wait
        // requirement is satisfied and finalization should succeed instead.
        elapsed = bound(elapsed, 0, gameManager.RESULT_CONFIRMATION_WINDOW() - 1);

        uint256 gameId = _createActiveGame();
        vm.prank(alice);
        gameManager.submitResult(gameId, alice, keccak256("transcript"));

        vm.warp(block.timestamp + elapsed);

        vm.prank(alice);
        vm.expectRevert(GameManager.ConfirmationWindowNotElapsed.selector);
        gameManager.finalizeByTimeout(gameId);
    }

    function testFuzz_WinnerMustBeASeatedPlayer(address randomWinner) public {
        uint256 gameId = _createActiveGame();
        vm.assume(randomWinner != alice && randomWinner != bob);

        vm.prank(alice);
        vm.expectRevert(GameManager.InvalidWinner.selector);
        gameManager.submitResult(gameId, randomWinner, keccak256("transcript"));
    }

    function testFuzz_JoinGameAlwaysRejectsASecondJoiner(address secondJoiner) public {
        uint256 gameId = _createJoinedGame();
        vm.assume(secondJoiner != address(0));

        vm.prank(secondJoiner);
        vm.expectRevert(
            abi.encodeWithSelector(
                GameManager.InvalidStateForAction.selector, GameManager.State.CREATED, GameManager.State.WAITING_FOR_PLAYER
            )
        );
        gameManager.joinGame(gameId);
    }
}
