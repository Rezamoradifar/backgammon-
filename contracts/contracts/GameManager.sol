// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRandomnessProvider, IRandomnessConsumer} from "./interfaces/IRandomnessProvider.sol";
import {PlayerRegistry} from "./PlayerRegistry.sol";

/// @title GameManager
/// @notice Coordinates the lifecycle of 1v1 Backgammon matches, optionally
/// wagered. Full per-checker, per-turn play happens off-chain between the two
/// clients (see ARCHITECTURE.md's on-chain/off-chain split) - this contract
/// anchors only a match's identity, participants, lifecycle state, an
/// optional move-commitment checkpoint, the final agreed result, and (for a
/// wagered match) the escrowed stake and its payout, so outcomes stay
/// auditable without paying gas for every dice roll and checker move.
/// @dev A game's stake is set by its creator via `createGame`'s `msg.value`;
/// `stake == 0` is a free/friendly match and never touches any of the
/// payout logic below - see ARCHITECTURE.md and DEPLOYMENT.md for the
/// wagering design and the licensing/compliance responsibility that sits
/// with whoever operates a deployment with `stake > 0` enabled.
/// @dev All payouts (winner, owner/platform/marketing fees, referral
/// commissions) are credited to `pendingWithdrawals` and pulled via
/// {withdraw}, rather than pushed synchronously during {_finalize} or
/// {cancelGame} - a single fee-recipient address that reverts on receiving
/// BNB (deliberately or not) must never be able to freeze every match's
/// payout, since the same three fee wallets are shared across all games.
contract GameManager is AccessControl, Pausable, ReentrancyGuard, IRandomnessConsumer {
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @dev Fee basis points out of BPS_DENOMINATOR, deducted from *each*
    /// player's own stake independently (not the pooled pot) so each side's
    /// own referral chain is paid from their own contribution. Total: 2000 bps
    /// = 20% of each player's stake; the remaining 80% + 80% (=160% of one
    /// stake, i.e. both stakes minus the 20% total fee) goes to the winner.
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant OWNER_FEE_BPS = 500; // 5.00% -> ownerFeeWallet
    uint256 public constant PLATFORM_FEE_BPS = 500; // 5.00% -> platformFeeWallet
    uint256 public constant MARKETING_FEE_BPS = 250; // 2.50% -> marketingFeeWallet
    uint256 public constant REFERRAL_L1_BPS = 400; // 4.00% -> referrer
    uint256 public constant REFERRAL_L2_BPS = 200; // 2.00% -> referrer's referrer
    uint256 public constant REFERRAL_L3_BPS = 150; // 1.50% -> referrer's referrer's referrer
    // Any referral level with no registered referrer redirects that level's
    // cut to platformFeeWallet instead of leaving it unclaimable.

    /// @dev How long the non-submitting player has to confirm or dispute a
    /// submitted result before the submitter may finalize unilaterally -
    /// stops an unresponsive or griefing opponent from freezing a match in
    /// AWAITING_RESULT forever.
    uint256 public constant RESULT_CONFIRMATION_WINDOW = 1 days;

    enum State {
        NONE, // gameId was never created - default/zero value, never a real game's state
        CREATED,
        WAITING_FOR_PLAYER,
        ACTIVE,
        AWAITING_RESULT,
        COMPLETED,
        CANCELLED,
        DISPUTED
    }

    struct Game {
        address player1;
        address player2;
        address firstToMove;
        State state;
        address resultSubmitter;
        address claimedWinner;
        bytes32 resultHash;
        uint64 resultSubmittedAt;
        bytes32 movesCommitment;
        uint256 randomnessRequestId;
        uint256 stake; // per-player wager in wei, set by createGame's msg.value; 0 = free match
    }

    PlayerRegistry public immutable playerRegistry;
    IRandomnessProvider public randomnessProvider;

    address public ownerFeeWallet;
    address public platformFeeWallet;
    address public marketingFeeWallet;

    uint256 private nextGameId = 1;
    mapping(uint256 gameId => Game game) public games;
    mapping(uint256 requestId => uint256 gameId) private gameIdByRequestId;

    /// @notice BNB credited to `account` from a settled wager (winnings, fee,
    /// or referral commission) or a cancellation refund, pulled via {withdraw}.
    mapping(address account => uint256 amount) public pendingWithdrawals;

    error NotAPlayer();
    error NotRandomnessProvider();
    error GameNotFound();
    error InvalidStateForAction(State current, State required);
    error CannotJoinOwnGame();
    error UnknownRandomnessRequest();
    error ConfirmationWindowNotElapsed();
    error ResultAlreadySubmittedByCaller();
    error ZeroAddress();
    error InvalidWinner();
    error StakeMismatch();
    error NothingToWithdraw();
    error TransferFailed();

    event GameCreated(uint256 indexed gameId, address indexed creator, uint256 stake);
    event GameJoined(uint256 indexed gameId, address indexed opponent);
    event RandomnessRequested(uint256 indexed gameId, uint256 indexed requestId);
    event GameStarted(uint256 indexed gameId, address indexed firstToMove);
    event MovesCheckpointed(uint256 indexed gameId, address indexed player, bytes32 movesCommitment);
    event ResultSubmitted(
        uint256 indexed gameId, address indexed submitter, address indexed claimedWinner, bytes32 resultHash
    );
    event ResultConfirmed(uint256 indexed gameId, address indexed confirmer);
    event ResultFinalizedByTimeout(uint256 indexed gameId);
    event GameDisputed(uint256 indexed gameId, address indexed disputer);
    event DisputeResolved(uint256 indexed gameId, address indexed winner, address indexed arbiter);
    event GameCancelled(uint256 indexed gameId, address indexed canceller);
    event GameForfeited(uint256 indexed gameId, address indexed forfeitingPlayer, address indexed winner);
    event RandomnessProviderUpdated(address indexed previousProvider, address indexed newProvider);
    event OwnerFeeWalletUpdated(address indexed previous, address indexed next);
    event PlatformFeeWalletUpdated(address indexed previous, address indexed next);
    event MarketingFeeWalletUpdated(address indexed previous, address indexed next);
    event Withdrawal(address indexed account, uint256 amount);

    modifier onlyPlayer(uint256 gameId) {
        Game storage game = games[gameId];
        if (msg.sender != game.player1 && msg.sender != game.player2) revert NotAPlayer();
        _;
    }

    modifier gameExists(uint256 gameId) {
        if (games[gameId].state == State.NONE) revert GameNotFound();
        _;
    }

    constructor(
        address admin,
        address arbiter,
        PlayerRegistry playerRegistry_,
        IRandomnessProvider randomnessProvider_,
        address ownerFeeWallet_,
        address platformFeeWallet_,
        address marketingFeeWallet_
    ) {
        if (
            admin == address(0) || address(playerRegistry_) == address(0) || address(randomnessProvider_) == address(0)
                || ownerFeeWallet_ == address(0) || platformFeeWallet_ == address(0) || marketingFeeWallet_ == address(0)
        ) {
            revert ZeroAddress();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        if (arbiter != address(0)) _grantRole(ARBITER_ROLE, arbiter);
        playerRegistry = playerRegistry_;
        randomnessProvider = randomnessProvider_;
        ownerFeeWallet = ownerFeeWallet_;
        platformFeeWallet = platformFeeWallet_;
        marketingFeeWallet = marketingFeeWallet_;
    }

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    /// @notice Creates a new match and seats the caller as player1.
    /// @dev `msg.value` becomes the per-player stake for this match; sending
    /// 0 creates a free/friendly match that never touches escrow or fee
    /// logic. The joiner must send exactly this amount (see {joinGame}).
    function createGame() external payable whenNotPaused returns (uint256 gameId) {
        gameId = nextGameId++;
        Game storage game = games[gameId];
        game.player1 = msg.sender;
        game.state = State.WAITING_FOR_PLAYER;
        game.stake = msg.value;
        emit GameCreated(gameId, msg.sender, msg.value);
    }

    /// @notice Seats the caller as player2 on an open match.
    /// @dev The state check alone fully prevents double-joining: a second
    /// join attempt always finds `state != WAITING_FOR_PLAYER` (the first
    /// join already advanced it to CREATED), so no separate "is player2
    /// already set" check is reachable or needed. Must send exactly the
    /// creator's stake (0 for a free match) so both sides risk equally.
    function joinGame(uint256 gameId) external payable whenNotPaused gameExists(gameId) {
        Game storage game = games[gameId];
        if (game.state != State.WAITING_FOR_PLAYER) revert InvalidStateForAction(game.state, State.WAITING_FOR_PLAYER);
        if (msg.sender == game.player1) revert CannotJoinOwnGame();
        if (msg.value != game.stake) revert StakeMismatch();

        game.player2 = msg.sender;
        game.state = State.CREATED;
        emit GameJoined(gameId, msg.sender);
    }

    /// @notice Kicks off the match: requests verifiable randomness to fairly
    /// pick who moves first. Either seated player may call this once both
    /// have joined.
    function startGame(uint256 gameId) external whenNotPaused gameExists(gameId) onlyPlayer(gameId) nonReentrant {
        Game storage game = games[gameId];
        if (game.state != State.CREATED) revert InvalidStateForAction(game.state, State.CREATED);

        uint256 requestId = randomnessProvider.requestRandomness(gameId);
        game.randomnessRequestId = requestId;
        gameIdByRequestId[requestId] = gameId;
        emit RandomnessRequested(gameId, requestId);
    }

    /// @dev Called back by the configured randomness provider only. Deletes
    /// the request-id mapping before use so the same requestId can never be
    /// replayed to re-fulfill (or fulfill a different game).
    function fulfillRandomness(uint256 requestId, uint256 gameId, uint256 randomWord) external override {
        if (msg.sender != address(randomnessProvider)) revert NotRandomnessProvider();
        if (gameIdByRequestId[requestId] != gameId) revert UnknownRandomnessRequest();
        delete gameIdByRequestId[requestId];

        Game storage game = games[gameId];
        game.firstToMove = (randomWord % 2 == 0) ? game.player1 : game.player2;
        game.state = State.ACTIVE;
        emit GameStarted(gameId, game.firstToMove);
    }

    /// @notice Optional, lightweight checkpoint of a hash summarizing the
    /// match's moves so far - NOT a full move log. A player may call this as
    /// often, or as rarely, as they like (including never); it exists purely
    /// as an anti-cheat audit aid for a future dispute review, not a
    /// requirement for normal play.
    function submitMove(uint256 gameId, bytes32 movesCommitment)
        external
        whenNotPaused
        gameExists(gameId)
        onlyPlayer(gameId)
    {
        Game storage game = games[gameId];
        if (game.state != State.ACTIVE) revert InvalidStateForAction(game.state, State.ACTIVE);
        game.movesCommitment = movesCommitment;
        emit MovesCheckpointed(gameId, msg.sender, movesCommitment);
    }

    /// @notice Either player reports the match's outcome once off-chain play
    /// concludes.
    function submitResult(uint256 gameId, address winner, bytes32 resultHash)
        external
        whenNotPaused
        gameExists(gameId)
        onlyPlayer(gameId)
    {
        Game storage game = games[gameId];
        if (game.state != State.ACTIVE) revert InvalidStateForAction(game.state, State.ACTIVE);
        if (winner != game.player1 && winner != game.player2) revert InvalidWinner();

        game.resultSubmitter = msg.sender;
        game.claimedWinner = winner;
        game.resultHash = resultHash;
        game.resultSubmittedAt = uint64(block.timestamp);
        game.state = State.AWAITING_RESULT;
        emit ResultSubmitted(gameId, msg.sender, winner, resultHash);
    }

    /// @notice The player who did NOT submit the result confirms they agree
    /// with it, finalizing the match.
    function confirmResult(uint256 gameId) external whenNotPaused gameExists(gameId) onlyPlayer(gameId) nonReentrant {
        Game storage game = games[gameId];
        if (game.state != State.AWAITING_RESULT) revert InvalidStateForAction(game.state, State.AWAITING_RESULT);
        if (msg.sender == game.resultSubmitter) revert ResultAlreadySubmittedByCaller();

        _finalize(game);
        emit ResultConfirmed(gameId, msg.sender);
    }

    /// @notice If the other player never confirms or disputes, the submitter
    /// can finalize unilaterally once the confirmation window elapses.
    function finalizeByTimeout(uint256 gameId)
        external
        whenNotPaused
        gameExists(gameId)
        onlyPlayer(gameId)
        nonReentrant
    {
        Game storage game = games[gameId];
        if (game.state != State.AWAITING_RESULT) revert InvalidStateForAction(game.state, State.AWAITING_RESULT);
        if (msg.sender != game.resultSubmitter) revert NotAPlayer();
        if (block.timestamp < game.resultSubmittedAt + RESULT_CONFIRMATION_WINDOW) {
            revert ConfirmationWindowNotElapsed();
        }

        _finalize(game);
        emit ResultFinalizedByTimeout(gameId);
    }

    /// @notice The non-submitting player disputes the claimed result instead
    /// of confirming it, escalating to arbiter review.
    function disputeResult(uint256 gameId) external whenNotPaused gameExists(gameId) onlyPlayer(gameId) {
        Game storage game = games[gameId];
        if (game.state != State.AWAITING_RESULT) revert InvalidStateForAction(game.state, State.AWAITING_RESULT);
        if (msg.sender == game.resultSubmitter) revert ResultAlreadySubmittedByCaller();

        game.state = State.DISPUTED;
        emit GameDisputed(gameId, msg.sender);
    }

    /// @notice Arbiter-only manual resolution for a disputed match.
    /// @dev A fully decentralized resolution (e.g. replaying the full move
    /// log against the deterministic engine on-chain or in a verifiable
    /// off-chain judge) is a documented future extension; this version keeps
    /// a human arbiter in the loop, appropriate for a free, low-stakes,
    /// play-for-fun game.
    function resolveDispute(uint256 gameId, address winner) external onlyRole(ARBITER_ROLE) gameExists(gameId) {
        Game storage game = games[gameId];
        if (game.state != State.DISPUTED) revert InvalidStateForAction(game.state, State.DISPUTED);
        if (winner != game.player1 && winner != game.player2) revert InvalidWinner();

        game.claimedWinner = winner;
        _finalize(game);
        emit DisputeResolved(gameId, winner, msg.sender);
    }

    /// @notice Cancels a match before it starts.
    /// @dev Allowed by the creator or an admin, and only before ACTIVE. The
    /// creator may still cancel after an opponent has joined but before play
    /// starts; for a wagered match both players' escrowed stakes are
    /// refunded in full (no fee is taken on a cancellation, only on a
    /// completed match), so this is a griefing inconvenience at worst, never
    /// a fund-loss risk for the joiner.
    function cancelGame(uint256 gameId) external nonReentrant gameExists(gameId) {
        Game storage game = games[gameId];
        bool isCreator = msg.sender == game.player1;
        bool isAdmin = hasRole(DEFAULT_ADMIN_ROLE, msg.sender);
        if (!isCreator && !isAdmin) revert NotAPlayer();
        State state = game.state;
        if (state != State.WAITING_FOR_PLAYER && state != State.CREATED) {
            revert InvalidStateForAction(state, State.WAITING_FOR_PLAYER);
        }

        game.state = State.CANCELLED;
        if (game.stake > 0) {
            _credit(game.player1, game.stake);
            if (state == State.CREATED) _credit(game.player2, game.stake);
        }
        emit GameCancelled(gameId, msg.sender);
    }

    /// @notice Either player can forfeit an active match, immediately handing
    /// the win to their opponent.
    /// @dev Not part of the originally-specified function set, but necessary
    /// for a workable state machine: without it, a player who disappears
    /// mid-match freezes the game in ACTIVE forever.
    function forfeitGame(uint256 gameId) external whenNotPaused gameExists(gameId) onlyPlayer(gameId) nonReentrant {
        Game storage game = games[gameId];
        if (game.state != State.ACTIVE) revert InvalidStateForAction(game.state, State.ACTIVE);

        address winner = msg.sender == game.player1 ? game.player2 : game.player1;
        game.claimedWinner = winner;
        _finalize(game);
        emit GameForfeited(gameId, msg.sender, winner);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice Swaps the randomness provider (e.g. mock -> production VRF
    /// adapter) without redeploying this contract.
    function setRandomnessProvider(IRandomnessProvider newProvider) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(newProvider) == address(0)) revert ZeroAddress();
        emit RandomnessProviderUpdated(address(randomnessProvider), address(newProvider));
        randomnessProvider = newProvider;
    }

    function setOwnerFeeWallet(address newWallet) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newWallet == address(0)) revert ZeroAddress();
        emit OwnerFeeWalletUpdated(ownerFeeWallet, newWallet);
        ownerFeeWallet = newWallet;
    }

    function setPlatformFeeWallet(address newWallet) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newWallet == address(0)) revert ZeroAddress();
        emit PlatformFeeWalletUpdated(platformFeeWallet, newWallet);
        platformFeeWallet = newWallet;
    }

    function setMarketingFeeWallet(address newWallet) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newWallet == address(0)) revert ZeroAddress();
        emit MarketingFeeWalletUpdated(marketingFeeWallet, newWallet);
        marketingFeeWallet = newWallet;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Withdrawals
    // ---------------------------------------------------------------------

    /// @notice Pulls the caller's full credited balance (winnings, fees,
    /// referral commissions, or a cancellation refund).
    /// @dev Zeroes the balance before sending (checks-effects-interactions),
    /// plus `nonReentrant` as defense in depth.
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[msg.sender] = 0;

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawal(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getGame(uint256 gameId) external view returns (Game memory) {
        return games[gameId];
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _finalize(Game storage game) private {
        address winner = game.claimedWinner;
        address loser = winner == game.player1 ? game.player2 : game.player1;
        game.state = State.COMPLETED;
        playerRegistry.recordResult(winner, loser);

        uint256 stake = game.stake;
        if (stake > 0) {
            uint256 winnerPayout = stake * 2;
            winnerPayout -= _payFeesForStake(game.player1, stake);
            winnerPayout -= _payFeesForStake(game.player2, stake);
            _credit(winner, winnerPayout);
        }
    }

    /// @dev Deducts and credits the owner/platform/marketing/referral cuts of
    /// one player's own stake, returning the total deducted so the caller can
    /// subtract it from the pot. Each player's own fee is computed from their
    /// own stake and their own referral chain, independent of the other
    /// player's - see the contract-level NatSpec for why.
    function _payFeesForStake(address player, uint256 stake) private returns (uint256 totalFee) {
        uint256 ownerCut = (stake * OWNER_FEE_BPS) / BPS_DENOMINATOR;
        uint256 platformCut = (stake * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
        uint256 marketingCut = (stake * MARKETING_FEE_BPS) / BPS_DENOMINATOR;
        _credit(ownerFeeWallet, ownerCut);
        _credit(platformFeeWallet, platformCut);
        _credit(marketingFeeWallet, marketingCut);

        address l1 = playerRegistry.referrerOf(player);
        uint256 l1Cut = (stake * REFERRAL_L1_BPS) / BPS_DENOMINATOR;
        _creditReferralOrFallback(l1, l1Cut);

        address l2 = l1 != address(0) ? playerRegistry.referrerOf(l1) : address(0);
        uint256 l2Cut = (stake * REFERRAL_L2_BPS) / BPS_DENOMINATOR;
        _creditReferralOrFallback(l2, l2Cut);

        address l3 = l2 != address(0) ? playerRegistry.referrerOf(l2) : address(0);
        uint256 l3Cut = (stake * REFERRAL_L3_BPS) / BPS_DENOMINATOR;
        _creditReferralOrFallback(l3, l3Cut);

        totalFee = ownerCut + platformCut + marketingCut + l1Cut + l2Cut + l3Cut;
    }

    /// @dev A referral level with no registered referrer redirects its cut to
    /// platformFeeWallet instead of leaving it uncredited to anyone.
    function _creditReferralOrFallback(address referrer, uint256 amount) private {
        _credit(referrer == address(0) ? platformFeeWallet : referrer, amount);
    }

    function _credit(address account, uint256 amount) private {
        if (amount == 0) return;
        pendingWithdrawals[account] += amount;
    }
}
