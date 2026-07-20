// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameManager} from "../GameManager.sol";
import {PlayerRegistry} from "../PlayerRegistry.sol";
import {MockRandomnessProvider} from "../randomness/MockRandomnessProvider.sol";

/// @notice Reverts unconditionally on receiving BNB - stands in for either a
/// malicious fee wallet or an innocent one that simply can't accept plain
/// transfers (e.g. a contract wallet with no payable fallback).
contract RevertingReceiver {
    receive() external payable {
        revert("nope");
    }
}

/// @notice Attempts to re-enter GameManager.withdraw() from its own receive()
/// hook, to prove the checks-effects-interactions ordering (zero the balance
/// before the external call) plus `nonReentrant` actually stop a reentrant
/// double-withdrawal.
contract ReentrantWithdrawer {
    GameManager public immutable gameManager;
    uint256 public reentryAttempts;

    constructor(GameManager gameManager_) {
        gameManager = gameManager_;
    }

    receive() external payable {
        reentryAttempts += 1;
        // Deliberately swallow the revert this should produce - the outer
        // test asserts on this contract's own final balance instead.
        try gameManager.withdraw() {} catch {}
    }

    function withdraw() external {
        gameManager.withdraw();
    }
}

contract WageringTest is Test {
    GameManager internal gameManager;
    PlayerRegistry internal playerRegistry;
    MockRandomnessProvider internal randomnessProvider;

    address internal admin = makeAddr("admin");
    address internal arbiter = makeAddr("arbiter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal ownerFeeWallet = makeAddr("ownerFeeWallet");
    address internal platformFeeWallet = makeAddr("platformFeeWallet");
    address internal marketingFeeWallet = makeAddr("marketingFeeWallet");
    address internal refL1 = makeAddr("refL1");
    address internal refL2 = makeAddr("refL2");
    address internal refL3 = makeAddr("refL3");

    uint256 internal constant BPS = 10_000;

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

    function _createActiveGame(uint256 stake) internal returns (uint256 gameId) {
        vm.prank(alice);
        gameId = gameManager.createGame{value: stake}();
        vm.prank(bob);
        gameManager.joinGame{value: stake}(gameId);
        vm.prank(alice);
        gameManager.startGame(gameId);
        uint256 requestId = gameManager.getGame(gameId).randomnessRequestId;
        randomnessProvider.fulfill(requestId);
    }

    function _settle(uint256 gameId, address winner) internal {
        vm.prank(winner);
        gameManager.submitResult(gameId, winner, keccak256("transcript"));
        address other = winner == alice ? bob : alice;
        vm.prank(other);
        gameManager.confirmResult(gameId);
    }

    // -------------------------------------------------------------------
    // Stake matching
    // -------------------------------------------------------------------

    function test_CreateGame_RecordsStake() public {
        vm.prank(alice);
        uint256 gameId = gameManager.createGame{value: 1 ether}();
        assertEq(gameManager.getGame(gameId).stake, 1 ether);
    }

    function test_RevertWhen_JoinGameStakeMismatch() public {
        vm.prank(alice);
        uint256 gameId = gameManager.createGame{value: 1 ether}();

        vm.prank(bob);
        vm.expectRevert(GameManager.StakeMismatch.selector);
        gameManager.joinGame{value: 0.5 ether}(gameId);
    }

    function test_RevertWhen_JoinGameSendsBnbToAFreeGame() public {
        vm.prank(alice);
        uint256 gameId = gameManager.createGame();

        vm.prank(bob);
        vm.expectRevert(GameManager.StakeMismatch.selector);
        gameManager.joinGame{value: 1 ether}(gameId);
    }

    // -------------------------------------------------------------------
    // Fee split - no referrer registered for either player
    // -------------------------------------------------------------------

    function test_FeeSplit_NoReferrer_ExactAmounts() public {
        uint256 stake = 1 ether;
        uint256 gameId = _createActiveGame(stake);
        _settle(gameId, alice);

        // Direct cuts, doubled (once per player's stake).
        assertEq(gameManager.pendingWithdrawals(ownerFeeWallet), 2 * (stake * 500 / BPS));
        assertEq(
            gameManager.pendingWithdrawals(platformFeeWallet),
            2 * (stake * 500 / BPS + stake * 400 / BPS + stake * 200 / BPS + stake * 150 / BPS)
        );
        assertEq(gameManager.pendingWithdrawals(marketingFeeWallet), 2 * (stake * 250 / BPS));

        uint256 totalFeePerPlayer = stake * 2000 / BPS; // 20%
        uint256 expectedWinnerPayout = stake * 2 - 2 * totalFeePerPlayer;
        assertEq(gameManager.pendingWithdrawals(alice), expectedWinnerPayout);
        assertEq(expectedWinnerPayout, stake * 2 * 80 / 100); // 80% of the pot
    }

    // -------------------------------------------------------------------
    // Fee split - full 3-level referral chain for the loser (bob)
    // -------------------------------------------------------------------

    function test_FeeSplit_ThreeLevelReferralChain() public {
        vm.prank(refL2);
        playerRegistry.setReferrer(refL3);
        vm.prank(refL1);
        playerRegistry.setReferrer(refL2);
        vm.prank(bob);
        playerRegistry.setReferrer(refL1);

        uint256 stake = 1 ether;
        uint256 gameId = _createActiveGame(stake);
        _settle(gameId, alice); // alice wins, bob (the referred player) loses - referral pays out from bob's own stake regardless of outcome

        assertEq(gameManager.pendingWithdrawals(refL1), stake * 400 / BPS);
        assertEq(gameManager.pendingWithdrawals(refL2), stake * 200 / BPS);
        assertEq(gameManager.pendingWithdrawals(refL3), stake * 150 / BPS);

        // Platform only gets alice's (unreferred) fallback share of 7.5%, plus both players' direct 5% platform cut.
        uint256 platformFromAlice = stake * 500 / BPS + stake * (400 + 200 + 150) / BPS;
        uint256 platformFromBob = stake * 500 / BPS; // bob's referral levels all redirected to refL1/L2/L3, not platform
        assertEq(gameManager.pendingWithdrawals(platformFeeWallet), platformFromAlice + platformFromBob);
    }

    function test_FeeSplit_PartialReferralChain_MissingLevelsFallBackToPlatform() public {
        vm.prank(bob);
        playerRegistry.setReferrer(refL1); // only one level - refL1 has no referrer of their own

        uint256 stake = 1 ether;
        uint256 gameId = _createActiveGame(stake);
        _settle(gameId, alice);

        assertEq(gameManager.pendingWithdrawals(refL1), stake * 400 / BPS);
        // Levels 2 and 3 (unset) redirect to platform, on top of bob's direct 5% and alice's full 7.5% fallback.
        uint256 expectedPlatform = stake * 500 / BPS // alice's platform cut
            + stake * (400 + 200 + 150) / BPS // alice's referral fallback (no referrer at all)
            + stake * 500 / BPS // bob's platform cut
            + stake * (200 + 150) / BPS; // bob's L2+L3 fallback (L1 was paid to refL1)
        assertEq(gameManager.pendingWithdrawals(platformFeeWallet), expectedPlatform);
    }

    // -------------------------------------------------------------------
    // Free (zero-stake) games never touch payout logic
    // -------------------------------------------------------------------

    function test_FreeGame_NoFeesOrPayoutsCredited() public {
        uint256 gameId = _createActiveGame(0);
        _settle(gameId, alice);

        assertEq(gameManager.pendingWithdrawals(alice), 0);
        assertEq(gameManager.pendingWithdrawals(ownerFeeWallet), 0);
        assertEq(gameManager.pendingWithdrawals(platformFeeWallet), 0);
        assertEq(gameManager.pendingWithdrawals(marketingFeeWallet), 0);
    }

    // -------------------------------------------------------------------
    // Cancellation refunds
    // -------------------------------------------------------------------

    function test_CancelGame_BeforeJoin_RefundsCreatorOnly() public {
        vm.prank(alice);
        uint256 gameId = gameManager.createGame{value: 1 ether}();

        vm.prank(alice);
        gameManager.cancelGame(gameId);

        assertEq(gameManager.pendingWithdrawals(alice), 1 ether);
        assertEq(gameManager.pendingWithdrawals(bob), 0);
    }

    function test_CancelGame_AfterJoin_RefundsBothPlayersInFull() public {
        vm.prank(alice);
        uint256 gameId = gameManager.createGame{value: 1 ether}();
        vm.prank(bob);
        gameManager.joinGame{value: 1 ether}(gameId);

        vm.prank(alice);
        gameManager.cancelGame(gameId);

        assertEq(gameManager.pendingWithdrawals(alice), 1 ether);
        assertEq(gameManager.pendingWithdrawals(bob), 1 ether);
    }

    // -------------------------------------------------------------------
    // Withdrawals: actual BNB movement, DoS-safety, reentrancy
    // -------------------------------------------------------------------

    function test_Withdraw_TransfersCreditedBnbAndZeroesBalance() public {
        uint256 gameId = _createActiveGame(1 ether);
        _settle(gameId, alice);

        uint256 before = alice.balance;
        uint256 credited = gameManager.pendingWithdrawals(alice);

        vm.prank(alice);
        gameManager.withdraw();

        assertEq(alice.balance, before + credited);
        assertEq(gameManager.pendingWithdrawals(alice), 0);
    }

    function test_RevertWhen_WithdrawingWithNothingCredited() public {
        vm.prank(alice);
        vm.expectRevert(GameManager.NothingToWithdraw.selector);
        gameManager.withdraw();
    }

    /// @dev The whole point of the pull-payment pattern: a fee wallet that
    /// reverts on receiving BNB must not block the game from finalizing, nor
    /// block the *other* fee wallets or the winner from withdrawing their own
    /// share. Only the broken wallet's own withdraw() call should ever fail.
    function test_RevertingFeeWallet_DoesNotBlockGameOrOtherWithdrawals() public {
        RevertingReceiver brokenOwnerWallet = new RevertingReceiver();
        vm.prank(admin);
        gameManager.setOwnerFeeWallet(address(brokenOwnerWallet));

        uint256 gameId = _createActiveGame(1 ether);
        _settle(gameId, alice); // must succeed even though ownerFeeWallet can never accept a push-payment

        assertEq(uint8(gameManager.getGame(gameId).state), uint8(GameManager.State.COMPLETED));
        assertGt(gameManager.pendingWithdrawals(address(brokenOwnerWallet)), 0);

        // The winner's own withdrawal is unaffected by the broken wallet.
        uint256 before = alice.balance;
        vm.prank(alice);
        gameManager.withdraw();
        assertGt(alice.balance, before);

        // The broken wallet's own withdrawal attempt fails, but only for itself.
        vm.prank(address(brokenOwnerWallet));
        vm.expectRevert(GameManager.TransferFailed.selector);
        gameManager.withdraw();
    }

    function test_RevertWhen_ReentrantWithdrawAttemptsDoubleSpend() public {
        ReentrantWithdrawer attacker = new ReentrantWithdrawer(gameManager);

        vm.prank(alice);
        uint256 gameId = gameManager.createGame{value: 1 ether}();
        // Fund the attacker contract as the joining "player" so it ends up
        // with a real credited balance (the loser's stake share is irrelevant
        // here - simplest way to get it net-credited is to have it win).
        vm.deal(address(attacker), 1 ether);
        vm.prank(address(attacker));
        gameManager.joinGame{value: 1 ether}(gameId);
        vm.prank(alice);
        gameManager.startGame(gameId);
        randomnessProvider.fulfill(gameManager.getGame(gameId).randomnessRequestId);

        vm.prank(address(attacker));
        gameManager.submitResult(gameId, address(attacker), keccak256("t"));
        vm.prank(alice);
        gameManager.confirmResult(gameId);

        uint256 credited = gameManager.pendingWithdrawals(address(attacker));
        assertGt(credited, 0);

        attacker.withdraw();

        // Exactly one payout's worth landed - the reentrant call inside
        // receive() must not have succeeded in draining a second time.
        assertEq(address(attacker).balance, credited);
        assertEq(gameManager.pendingWithdrawals(address(attacker)), 0);
        assertGt(attacker.reentryAttempts(), 0); // confirms the reentrant call was actually attempted
    }

    // -------------------------------------------------------------------
    // Fuzz: fund conservation - total credited always equals total deposited
    // -------------------------------------------------------------------

    function testFuzz_TotalCreditedNeverExceedsTotalDeposited(uint96 rawStake, bool aliceWins) public {
        uint256 stake = bound(uint256(rawStake), 1, 500 ether);
        uint256 gameId = _createActiveGame(stake);
        _settle(gameId, aliceWins ? alice : bob);

        uint256 totalCredited = gameManager.pendingWithdrawals(alice) + gameManager.pendingWithdrawals(bob)
            + gameManager.pendingWithdrawals(ownerFeeWallet) + gameManager.pendingWithdrawals(platformFeeWallet)
            + gameManager.pendingWithdrawals(marketingFeeWallet);

        assertEq(totalCredited, stake * 2);
    }

    // -------------------------------------------------------------------
    // Weekly top-wagerer reward distribution
    // -------------------------------------------------------------------

    function _grantRewardDistributor(address distributor) internal {
        bytes32 role = gameManager.REWARD_DISTRIBUTOR_ROLE();
        vm.prank(admin);
        gameManager.grantRole(role, distributor);
    }

    function _fundPlatformFeeWallet(uint256 amount) internal returns (uint256 credited) {
        // A stake of `amount * BPS / PLATFORM_FEE_BPS` credits exactly
        // `amount` to platformFeeWallet from a single player's cut once that
        // game is settled - the other player's cut just adds extra headroom.
        uint256 stake = (amount * BPS) / 500; // 500 = PLATFORM_FEE_BPS, one side's cut
        vm.deal(alice, stake + 1 ether);
        vm.deal(bob, stake + 1 ether);
        uint256 gameId = _createActiveGame(stake);
        _settle(gameId, alice);
        credited = gameManager.pendingWithdrawals(platformFeeWallet);
    }

    function test_DistributeWeeklyRewards_CreditsWinnersAndDebitsPlatform() public {
        uint256 funded = _fundPlatformFeeWallet(300 ether);
        address distributor = makeAddr("distributor");
        _grantRewardDistributor(distributor);

        address[] memory winners = new address[](3);
        winners[0] = makeAddr("weekly1");
        winners[1] = makeAddr("weekly2");
        winners[2] = makeAddr("weekly3");
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 50 ether;
        amounts[1] = 30 ether;
        amounts[2] = 20 ether;

        vm.prank(distributor);
        gameManager.distributeWeeklyRewards(winners, amounts, 1);

        assertEq(gameManager.pendingWithdrawals(winners[0]), 50 ether);
        assertEq(gameManager.pendingWithdrawals(winners[1]), 30 ether);
        assertEq(gameManager.pendingWithdrawals(winners[2]), 20 ether);
        assertEq(gameManager.pendingWithdrawals(platformFeeWallet), funded - 100 ether);
    }

    function test_RevertWhen_DistributingWithoutRole() public {
        _fundPlatformFeeWallet(300 ether);
        address[] memory winners = new address[](1);
        winners[0] = makeAddr("weekly1");
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 10 ether;

        vm.prank(alice); // never granted REWARD_DISTRIBUTOR_ROLE
        vm.expectRevert();
        gameManager.distributeWeeklyRewards(winners, amounts, 1);
    }

    function test_RevertWhen_DistributingMoreThanPlatformBalance() public {
        uint256 funded = _fundPlatformFeeWallet(10 ether);
        address distributor = makeAddr("distributor");
        _grantRewardDistributor(distributor);

        address[] memory winners = new address[](1);
        winners[0] = makeAddr("weekly1");
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = funded + 1 ether;

        vm.prank(distributor);
        vm.expectRevert(GameManager.InsufficientPlatformBalance.selector);
        gameManager.distributeWeeklyRewards(winners, amounts, 1);
    }

    function test_RevertWhen_DistributingWithMismatchedArrayLengths() public {
        _fundPlatformFeeWallet(10 ether);
        address distributor = makeAddr("distributor");
        _grantRewardDistributor(distributor);

        address[] memory winners = new address[](2);
        winners[0] = makeAddr("weekly1");
        winners[1] = makeAddr("weekly2");
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1 ether;

        vm.prank(distributor);
        vm.expectRevert(GameManager.ArrayLengthMismatch.selector);
        gameManager.distributeWeeklyRewards(winners, amounts, 1);
    }

    function test_RevertWhen_DistributingWithEmptyWinnerList() public {
        address distributor = makeAddr("distributor");
        _grantRewardDistributor(distributor);

        address[] memory winners = new address[](0);
        uint256[] memory amounts = new uint256[](0);

        vm.prank(distributor);
        vm.expectRevert(GameManager.EmptyWinnerList.selector);
        gameManager.distributeWeeklyRewards(winners, amounts, 1);
    }

    function test_RevertWhen_DistributingToZeroAddress() public {
        uint256 funded = _fundPlatformFeeWallet(10 ether);
        address distributor = makeAddr("distributor");
        _grantRewardDistributor(distributor);

        address[] memory winners = new address[](1);
        winners[0] = address(0);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = funded;

        vm.prank(distributor);
        vm.expectRevert(GameManager.ZeroAddress.selector);
        gameManager.distributeWeeklyRewards(winners, amounts, 1);
    }

    function test_DistributeWeeklyRewards_DoesNotAffectOtherBalances() public {
        _fundPlatformFeeWallet(100 ether);
        uint256 ownerBefore = gameManager.pendingWithdrawals(ownerFeeWallet);
        uint256 marketingBefore = gameManager.pendingWithdrawals(marketingFeeWallet);
        address distributor = makeAddr("distributor");
        _grantRewardDistributor(distributor);

        address[] memory winners = new address[](1);
        winners[0] = makeAddr("weekly1");
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 10 ether;

        vm.prank(distributor);
        gameManager.distributeWeeklyRewards(winners, amounts, 1);

        assertEq(gameManager.pendingWithdrawals(ownerFeeWallet), ownerBefore);
        assertEq(gameManager.pendingWithdrawals(marketingFeeWallet), marketingBefore);
    }
}
