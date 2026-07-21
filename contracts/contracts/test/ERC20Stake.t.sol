// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GameManager} from "../GameManager.sol";
import {PlayerRegistry} from "../PlayerRegistry.sol";
import {MockRandomnessProvider} from "../randomness/MockRandomnessProvider.sol";
import {MockUSDT} from "../tokens/MockUSDT.sol";

/// @notice Covers the ERC-20 (e.g. USDT) stake path specifically - the BNB
/// path's fee-split/referral/reentrancy/DoS-safety properties are already
/// proven in Wagering.t.sol and apply identically here since both paths
/// share the same `_finalize`/`_payFeesForStake`/`_credit` internals; this
/// file focuses on what's actually different about ERC-20 stakes: the
/// approve/transferFrom escrow flow, the token allowlist gate, and that
/// BNB and ERC-20 balances never mix in `pendingWithdrawals`.
contract ERC20StakeTest is Test {
    GameManager internal gameManager;
    PlayerRegistry internal playerRegistry;
    MockRandomnessProvider internal randomnessProvider;
    MockUSDT internal usdt;

    address internal admin = makeAddr("admin");
    address internal arbiter = makeAddr("arbiter");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal ownerFeeWallet = makeAddr("ownerFeeWallet");
    address internal platformFeeWallet = makeAddr("platformFeeWallet");
    address internal marketingFeeWallet = makeAddr("marketingFeeWallet");

    uint256 internal constant BPS = 10_000;

    function setUp() public {
        playerRegistry = new PlayerRegistry(admin);
        randomnessProvider = new MockRandomnessProvider();
        usdt = new MockUSDT();

        vm.prank(admin);
        gameManager = new GameManager(
            admin, arbiter, playerRegistry, randomnessProvider, ownerFeeWallet, platformFeeWallet, marketingFeeWallet
        );

        bytes32 gameManagerRole = playerRegistry.GAME_MANAGER_ROLE();
        vm.prank(admin);
        playerRegistry.grantRole(gameManagerRole, address(gameManager));

        vm.prank(admin);
        gameManager.setStakeTokenAllowed(address(usdt), true);

        usdt.faucet(10_000); // to this test contract, irrelevant
        vm.prank(alice);
        usdt.faucet(10_000);
        vm.prank(bob);
        usdt.faucet(10_000);

        vm.prank(alice);
        usdt.approve(address(gameManager), type(uint256).max);
        vm.prank(bob);
        usdt.approve(address(gameManager), type(uint256).max);
    }

    function _usdt(uint256 whole) internal view returns (uint256) {
        return whole * 10 ** usdt.decimals();
    }

    function _createActiveErc20Game(uint256 stake) internal returns (uint256 gameId) {
        vm.prank(alice);
        gameId = gameManager.createGameERC20(address(usdt), stake);
        vm.prank(bob);
        gameManager.joinGame(gameId);
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
    // Allowlist gate
    // -------------------------------------------------------------------

    function test_RevertWhen_CreatingGameWithDisallowedToken() public {
        MockUSDT other = new MockUSDT();
        // Computed before expectRevert - _usdt() makes an external decimals()
        // call, which would otherwise be the "next call" expectRevert
        // intercepts instead of the actual createGameERC20 call below.
        uint256 amount = _usdt(10);
        vm.prank(alice);
        vm.expectRevert(GameManager.TokenNotAllowed.selector);
        gameManager.createGameERC20(address(other), amount);
    }

    function test_AdminCanRevokeTokenAllowance() public {
        vm.prank(admin);
        gameManager.setStakeTokenAllowed(address(usdt), false);

        uint256 amount = _usdt(10);
        vm.prank(alice);
        vm.expectRevert(GameManager.TokenNotAllowed.selector);
        gameManager.createGameERC20(address(usdt), amount);
    }

    // -------------------------------------------------------------------
    // Escrow: approve/transferFrom flow
    // -------------------------------------------------------------------

    function test_CreateGameERC20_PullsStakeFromCreator() public {
        uint256 stake = _usdt(50);
        uint256 balanceBefore = usdt.balanceOf(alice);

        vm.prank(alice);
        uint256 gameId = gameManager.createGameERC20(address(usdt), stake);

        assertEq(usdt.balanceOf(alice), balanceBefore - stake);
        assertEq(usdt.balanceOf(address(gameManager)), stake);
        assertEq(gameManager.getGame(gameId).stakeToken, address(usdt));
        assertEq(gameManager.getGame(gameId).stake, stake);
    }

    function test_JoinGame_PullsMatchingStakeInSameToken() public {
        uint256 stake = _usdt(50);
        vm.prank(alice);
        uint256 gameId = gameManager.createGameERC20(address(usdt), stake);

        uint256 bobBalanceBefore = usdt.balanceOf(bob);
        vm.prank(bob);
        gameManager.joinGame(gameId);

        assertEq(usdt.balanceOf(bob), bobBalanceBefore - stake);
        assertEq(usdt.balanceOf(address(gameManager)), stake * 2);
    }

    function test_RevertWhen_JoiningErc20GameWithNativeValue() public {
        uint256 stake = _usdt(50);
        vm.prank(alice);
        uint256 gameId = gameManager.createGameERC20(address(usdt), stake);

        vm.deal(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(GameManager.NativeValueNotAccepted.selector);
        gameManager.joinGame{value: 1 ether}(gameId);
    }

    function test_RevertWhen_JoiningWithoutApproval() public {
        uint256 stake = _usdt(50);
        vm.prank(alice);
        uint256 gameId = gameManager.createGameERC20(address(usdt), stake);

        address carol = makeAddr("carol");
        vm.prank(admin);
        usdt.transfer(carol, 0); // no-op, carol has 0 balance and no approval
        vm.prank(carol);
        vm.expectRevert(); // ERC20InsufficientAllowance
        gameManager.joinGame(gameId);
    }

    // -------------------------------------------------------------------
    // Fee split - identical bps math to the BNB path, in USDT's smallest unit
    // -------------------------------------------------------------------

    function test_FeeSplit_ExactAmountsInUsdt() public {
        uint256 stake = _usdt(100);
        uint256 gameId = _createActiveErc20Game(stake);
        _settle(gameId, alice);

        assertEq(gameManager.pendingWithdrawals(ownerFeeWallet, address(usdt)), 2 * (stake * 500 / BPS));
        assertEq(gameManager.pendingWithdrawals(marketingFeeWallet, address(usdt)), 2 * (stake * 250 / BPS));

        uint256 totalFeePerPlayer = stake * 2000 / BPS;
        uint256 expectedWinnerPayout = stake * 2 - 2 * totalFeePerPlayer;
        assertEq(gameManager.pendingWithdrawals(alice, address(usdt)), expectedWinnerPayout);
    }

    // -------------------------------------------------------------------
    // Withdrawal: pulls the right token, never touches the other
    // -------------------------------------------------------------------

    function test_Withdraw_TransfersUsdtAndZeroesOnlyThatTokensBalance() public {
        uint256 stake = _usdt(100);
        uint256 gameId = _createActiveErc20Game(stake);
        _settle(gameId, alice);

        uint256 credited = gameManager.pendingWithdrawals(alice, address(usdt));
        assertGt(credited, 0);
        uint256 aliceBalanceBefore = usdt.balanceOf(alice);

        vm.prank(alice);
        gameManager.withdraw(address(usdt));

        assertEq(usdt.balanceOf(alice), aliceBalanceBefore + credited);
        assertEq(gameManager.pendingWithdrawals(alice, address(usdt)), 0);
        // Alice's native-BNB balance is untouched by a USDT withdrawal.
        assertEq(gameManager.pendingWithdrawals(alice, address(0)), 0);
    }

    function test_BnbAndUsdtBalancesForSameAccountNeverMix() public {
        // Alice plays and wins one BNB match and one USDT match; each
        // token's credited balance must reflect only that match.
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);

        vm.prank(alice);
        uint256 bnbGameId = gameManager.createGame{value: 1 ether}();
        vm.prank(bob);
        gameManager.joinGame{value: 1 ether}(bnbGameId);
        vm.prank(alice);
        gameManager.startGame(bnbGameId);
        randomnessProvider.fulfill(gameManager.getGame(bnbGameId).randomnessRequestId);
        _settle(bnbGameId, alice);

        uint256 usdtGameId = _createActiveErc20Game(_usdt(100));
        _settle(usdtGameId, alice);

        uint256 bnbCredited = gameManager.pendingWithdrawals(alice, address(0));
        uint256 usdtCredited = gameManager.pendingWithdrawals(alice, address(usdt));
        // Winner takes both stakes minus the 20%-per-side fee: 2*S*0.8.
        assertEq(bnbCredited, 2 ether * 80 / 100);
        assertEq(usdtCredited, _usdt(100) * 2 * 80 / 100);

        vm.prank(alice);
        gameManager.withdraw(address(0));
        assertEq(gameManager.pendingWithdrawals(alice, address(0)), 0);
        assertEq(gameManager.pendingWithdrawals(alice, address(usdt)), usdtCredited); // untouched
    }

    // -------------------------------------------------------------------
    // Cancellation refunds in the same token
    // -------------------------------------------------------------------

    function test_CancelGame_RefundsUsdtToCreator() public {
        uint256 stake = _usdt(50);
        uint256 balanceBefore = usdt.balanceOf(alice);

        vm.prank(alice);
        uint256 gameId = gameManager.createGameERC20(address(usdt), stake);
        assertEq(usdt.balanceOf(alice), balanceBefore - stake);

        vm.prank(alice);
        gameManager.cancelGame(gameId);

        assertEq(gameManager.pendingWithdrawals(alice, address(usdt)), stake);
        vm.prank(alice);
        gameManager.withdraw(address(usdt));
        assertEq(usdt.balanceOf(alice), balanceBefore);
    }

    // -------------------------------------------------------------------
    // Fund conservation, fuzzed over stake amount
    // -------------------------------------------------------------------

    function testFuzz_TotalUsdtCreditedNeverExceedsTotalDeposited(uint96 rawStake, bool aliceWins) public {
        uint256 stake = bound(uint256(rawStake), 1, 5_000_000 * 10 ** usdt.decimals());
        vm.prank(admin);
        usdt.faucet(0); // no-op keep pattern consistent
        // Ensure both players can cover an arbitrarily large fuzzed stake.
        vm.prank(alice);
        usdt.approve(address(gameManager), type(uint256).max);
        vm.prank(bob);
        usdt.approve(address(gameManager), type(uint256).max);
        deal(address(usdt), alice, stake);
        deal(address(usdt), bob, stake);

        uint256 gameId = _createActiveErc20Game(stake);
        _settle(gameId, aliceWins ? alice : bob);

        uint256 totalCredited = gameManager.pendingWithdrawals(alice, address(usdt))
            + gameManager.pendingWithdrawals(bob, address(usdt))
            + gameManager.pendingWithdrawals(ownerFeeWallet, address(usdt))
            + gameManager.pendingWithdrawals(platformFeeWallet, address(usdt))
            + gameManager.pendingWithdrawals(marketingFeeWallet, address(usdt));

        assertEq(totalCredited, stake * 2);
    }
}
