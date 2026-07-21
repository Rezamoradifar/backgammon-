// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
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
/// @dev A game's stake is set by its creator via `createGame`'s `msg.value`
/// (native BNB) or {createGameERC20}'s `amount` (an allowlisted ERC-20,
/// e.g. a USDT deployment - see {allowedStakeTokens}); `stake == 0` is a
/// free/friendly match and never touches any of the payout logic below -
/// see ARCHITECTURE.md and DEPLOYMENT.md for the wagering design and the
/// licensing/compliance responsibility that sits with whoever operates a
/// deployment with `stake > 0` enabled.
/// @dev All payouts (winner, owner/platform/marketing fees, referral
/// commissions) are credited to `pendingWithdrawals` (keyed by account
/// *and* stake token - a BNB match's payouts and a USDT match's payouts
/// never share a balance) and pulled via {withdraw}, rather than pushed
/// synchronously during {_finalize} or {cancelGame} - a single
/// fee-recipient address that reverts (or, for an ERC-20, a transfer that
/// fails) must never be able to freeze every match's payout, since the
/// same three fee wallets are shared across all games.
contract GameManager is AccessControl, Pausable, ReentrancyGuard, IRandomnessConsumer {
    using SafeERC20 for IERC20;
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @dev Granted to the backend's automated weekly-reward job, and only
    /// lets it move already-credited platformFeeWallet balance to specific
    /// winners via {distributeWeeklyRewards} - it cannot credit itself or
    /// anyone from thin air, and cannot touch any other account's balance.
    bytes32 public constant REWARD_DISTRIBUTOR_ROLE = keccak256("REWARD_DISTRIBUTOR_ROLE");

    /// @dev Fee basis points out of BPS_DENOMINATOR, deducted from *each*
    /// player's own stake independently (not the pooled pot) so each side's
    /// own referral chain is paid from their own contribution. Total: 2000 bps
    /// = 20% of each player's stake; the remaining 80% + 80% (=160% of one
    /// stake, i.e. both stakes minus the 20% total fee) goes to the winner.
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant OWNER_FEE_BPS = 750; // 7.50% -> ownerFeeWallet
    uint256 public constant PLATFORM_FEE_BPS = 250; // 2.50% -> platformFeeWallet (funds the weekly top-3 prize pool)
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
        uint256 stake; // per-player wager in the smallest unit of stakeToken; 0 = free match
        address stakeToken; // address(0) = native BNB, otherwise an allowlisted ERC-20
    }

    PlayerRegistry public immutable playerRegistry;
    IRandomnessProvider public randomnessProvider;

    address public ownerFeeWallet;
    address public platformFeeWallet;
    address public marketingFeeWallet;

    /// @notice ERC-20 tokens players may stake with via {createGameERC20},
    /// besides native BNB (which is always allowed). Admin-controlled rather
    /// than hardcoded so a testnet mock token can be swapped for a real
    /// mainnet USDT deployment without redeploying this contract.
    mapping(address token => bool allowed) public allowedStakeTokens;

    uint256 private nextGameId = 1;
    mapping(uint256 gameId => Game game) public games;
    mapping(uint256 requestId => uint256 gameId) private gameIdByRequestId;

    /// @notice Amount of `token` (address(0) = native BNB) credited to
    /// `account` from a settled wager (winnings, fee, or referral
    /// commission) or a cancellation refund, pulled via {withdraw}. Kept
    /// per-token so a BNB match's payouts and a USDT match's payouts never
    /// share, or can be confused with, one another's balance.
    mapping(address account => mapping(address token => uint256 amount)) public pendingWithdrawals;

    error NotAPlayer();
    error NotRandomnessProvider();
    error GameNotFound();
    error InvalidStateForAction(State current, State required);
    error CannotJoinOwnGame();
    error UnknownRandomnessRequest();
    error RandomnessAlreadyRequested();
    error ConfirmationWindowNotElapsed();
    error ResultAlreadySubmittedByCaller();
    error ZeroAddress();
    error InvalidWinner();
    error StakeMismatch();
    error NothingToWithdraw();
    error TransferFailed();
    error ArrayLengthMismatch();
    error InsufficientPlatformBalance();
    error EmptyWinnerList();
    error TokenNotAllowed();
    error NativeValueNotAccepted();

    event GameCreated(uint256 indexed gameId, address indexed creator, address stakeToken, uint256 stake);
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
    event Withdrawal(address indexed account, address indexed token, uint256 amount);
    event WeeklyRewardDistributed(uint256 indexed weekId, address indexed token, address indexed winner, uint256 amount);
    event StakeTokenAllowedUpdated(address indexed token, bool allowed);

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

    /// @notice Creates a new native-BNB-staked match and seats the caller as
    /// player1.
    /// @dev `msg.value` becomes the per-player stake for this match; sending
    /// 0 creates a free/friendly match that never touches escrow or fee
    /// logic. The joiner must send exactly this amount (see {joinGame}). For
    /// an ERC-20-staked match, see {createGameERC20} instead.
    function createGame() external payable whenNotPaused returns (uint256 gameId) {
        gameId = nextGameId++;
        Game storage game = games[gameId];
        game.player1 = msg.sender;
        game.state = State.WAITING_FOR_PLAYER;
        game.stake = msg.value;
        emit GameCreated(gameId, msg.sender, address(0), msg.value);
    }

    /// @notice Creates a new match staked with an allowlisted ERC-20 token
    /// (e.g. USDT) and seats the caller as player1.
    /// @dev Pulls `amount` of `token` from the caller via `transferFrom` -
    /// the caller must have already `approve`d this contract for at least
    /// `amount`. `amount == 0` creates a free/friendly match, same as native
    /// {createGame}. Reverts if `token` isn't in {allowedStakeTokens}.
    function createGameERC20(address token, uint256 amount) external whenNotPaused returns (uint256 gameId) {
        if (!allowedStakeTokens[token]) revert TokenNotAllowed();

        gameId = nextGameId++;
        Game storage game = games[gameId];
        game.player1 = msg.sender;
        game.state = State.WAITING_FOR_PLAYER;
        game.stake = amount;
        game.stakeToken = token;

        if (amount > 0) IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit GameCreated(gameId, msg.sender, token, amount);
    }

    /// @notice Seats the caller as player2 on an open match.
    /// @dev The state check alone fully prevents double-joining: a second
    /// join attempt always finds `state != WAITING_FOR_PLAYER` (the first
    /// join already advanced it to CREATED), so no separate "is player2
    /// already set" check is reachable or needed. Must match the creator's
    /// stake exactly (0 for a free match) so both sides risk equally - in
    /// whichever asset (native BNB or ERC-20) the creator chose, read from
    /// the game itself rather than passed in again here.
    function joinGame(uint256 gameId) external payable whenNotPaused gameExists(gameId) {
        Game storage game = games[gameId];
        if (game.state != State.WAITING_FOR_PLAYER) revert InvalidStateForAction(game.state, State.WAITING_FOR_PLAYER);
        if (msg.sender == game.player1) revert CannotJoinOwnGame();

        address stakeToken = game.stakeToken;
        uint256 stake = game.stake;
        if (stakeToken == address(0)) {
            if (msg.value != stake) revert StakeMismatch();
        } else if (msg.value != 0) {
            revert NativeValueNotAccepted();
        }

        // Effects before the ERC-20 interaction below (checks-effects-
        // interactions) - matches {createGameERC20}'s own ordering, so a
        // non-standard stake token with transfer hooks can't re-enter
        // {joinGame} while this game still looks WAITING_FOR_PLAYER.
        game.player2 = msg.sender;
        game.state = State.CREATED;

        if (stakeToken != address(0) && stake > 0) {
            IERC20(stakeToken).safeTransferFrom(msg.sender, address(this), stake);
        }
        emit GameJoined(gameId, msg.sender);
    }

    /// @notice Kicks off the match: requests verifiable randomness to fairly
    /// pick who moves first. Either seated player may call this once both
    /// have joined.
    /// @dev Reverts if a request is already outstanding for this game
    /// (`randomnessRequestId != 0`) rather than issuing a second one - with a
    /// real, asynchronous VRF provider (unlike the instantly-fulfilled local
    /// mock) nothing else stopped both players from racing this and paying
    /// for two live requests, only one of which {fulfillRandomness} could
    /// ever accept.
    function startGame(uint256 gameId) external whenNotPaused gameExists(gameId) onlyPlayer(gameId) nonReentrant {
        Game storage game = games[gameId];
        if (game.state != State.CREATED) revert InvalidStateForAction(game.state, State.CREATED);
        if (game.randomnessRequestId != 0) revert RandomnessAlreadyRequested();

        uint256 requestId = randomnessProvider.requestRandomness(gameId);
        game.randomnessRequestId = requestId;
        gameIdByRequestId[requestId] = gameId;
        emit RandomnessRequested(gameId, requestId);
    }

    /// @dev Called back by the configured randomness provider only.
    /// @dev Requires the game to still be CREATED before touching anything -
    /// a real VRF provider's callback can arrive an arbitrary, attacker-
    /// influenceable number of blocks after {startGame} requested it (unlike
    /// the local mock's same-transaction fulfillment), leaving a real window
    /// for the game to have since been {cancelGame}'d (and its stake already
    /// refunded) before this callback lands. Without this check, a stale
    /// fulfillment would still flip a cancelled game to ACTIVE and let it
    /// later {_finalize} and pay out `game.stake` a second time - the first
    /// time via the cancellation refund, the second via that resurrected
    /// finalize - double-crediting `pendingWithdrawals` beyond what the
    /// contract actually holds. Deletes the request-id mapping only after
    /// that check passes, so the same requestId can never be replayed to
    /// re-fulfill (or fulfill a different game) either.
    function fulfillRandomness(uint256 requestId, uint256 gameId, uint256 randomWord) external override {
        if (msg.sender != address(randomnessProvider)) revert NotRandomnessProvider();
        if (gameIdByRequestId[requestId] != gameId) revert UnknownRandomnessRequest();

        Game storage game = games[gameId];
        if (game.state != State.CREATED) revert InvalidStateForAction(game.state, State.CREATED);
        delete gameIdByRequestId[requestId];

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
        // Belt-and-suspenders alongside {fulfillRandomness}'s own state
        // check: a game can reach here with an outstanding randomness
        // request (startGame doesn't change `state` while awaiting
        // fulfillment) - drop the mapping now so a since-superseded VRF
        // callback finds nothing to match instead of relying solely on the
        // state guard on the other side.
        if (game.randomnessRequestId != 0) {
            delete gameIdByRequestId[game.randomnessRequestId];
        }
        if (game.stake > 0) {
            _credit(game.player1, game.stakeToken, game.stake);
            if (state == State.CREATED) _credit(game.player2, game.stakeToken, game.stake);
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

    /// @notice Allows or disallows an ERC-20 token as a {createGameERC20}
    /// stake option (e.g. a USDT deployment). Native BNB is always allowed
    /// and isn't part of this allowlist.
    function setStakeTokenAllowed(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        allowedStakeTokens[token] = allowed;
        emit StakeTokenAllowedUpdated(token, allowed);
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

    /// @notice Pulls the caller's full credited balance of `token`
    /// (address(0) = native BNB) - winnings, fees, referral commissions, or
    /// a cancellation refund. A player who played both BNB and USDT matches
    /// calls this once per token; balances never mix.
    /// @dev Zeroes the balance before sending (checks-effects-interactions),
    /// plus `nonReentrant` as defense in depth.
    function withdraw(address token) external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender][token];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[msg.sender][token] = 0;

        if (token == address(0)) {
            (bool ok,) = msg.sender.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(msg.sender, amount);
        }
        emit Withdrawal(msg.sender, token, amount);
    }

    // ---------------------------------------------------------------------
    // Weekly top-wagerer rewards
    // ---------------------------------------------------------------------

    /// @notice Moves part of platformFeeWallet's own accumulated balance of
    /// `token` to this week's top-wagering-volume winners, as credited
    /// `pendingWithdrawals` balances they then pull via {withdraw}.
    /// @dev Restricted to `REWARD_DISTRIBUTOR_ROLE` (the backend's automated
    /// weekly job). Ranking, tier split, and "who qualifies" are all computed
    /// off-chain from indexed `GameCreated`/`GameJoined` stake data - this
    /// function only ever moves already-credited platformFeeWallet balance to
    /// the addresses/amounts it's given, and can never credit more than
    /// platformFeeWallet actually holds of that token, or touch any other
    /// account's balance. Since BNB and USDT fee pools never mix, the weekly
    /// job calls this once per token that had wagering volume that week.
    /// `weekId` is an opaque caller-chosen identifier (e.g. an ISO week
    /// number) recorded in the event for off-chain bookkeeping/idempotency;
    /// this contract does not itself track which weeks were already paid.
    function distributeWeeklyRewards(
        address token,
        address[] calldata winners,
        uint256[] calldata amounts,
        uint256 weekId
    ) external onlyRole(REWARD_DISTRIBUTOR_ROLE) {
        if (winners.length == 0) revert EmptyWinnerList();
        if (winners.length != amounts.length) revert ArrayLengthMismatch();

        uint256 total;
        for (uint256 i; i < amounts.length; i++) {
            total += amounts[i];
        }
        if (pendingWithdrawals[platformFeeWallet][token] < total) revert InsufficientPlatformBalance();

        pendingWithdrawals[platformFeeWallet][token] -= total;
        for (uint256 i; i < winners.length; i++) {
            if (winners[i] == address(0)) revert ZeroAddress();
            _credit(winners[i], token, amounts[i]);
            emit WeeklyRewardDistributed(weekId, token, winners[i], amounts[i]);
        }
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
            address token = game.stakeToken;
            uint256 winnerPayout = stake * 2;
            winnerPayout -= _payFeesForStake(game.player1, token, stake);
            winnerPayout -= _payFeesForStake(game.player2, token, stake);
            _credit(winner, token, winnerPayout);
        }
    }

    /// @dev Deducts and credits the owner/platform/marketing/referral cuts of
    /// one player's own stake, returning the total deducted so the caller can
    /// subtract it from the pot. Each player's own fee is computed from their
    /// own stake and their own referral chain, independent of the other
    /// player's - see the contract-level NatSpec for why.
    function _payFeesForStake(address player, address token, uint256 stake) private returns (uint256 totalFee) {
        uint256 ownerCut = (stake * OWNER_FEE_BPS) / BPS_DENOMINATOR;
        uint256 platformCut = (stake * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
        uint256 marketingCut = (stake * MARKETING_FEE_BPS) / BPS_DENOMINATOR;
        _credit(ownerFeeWallet, token, ownerCut);
        _credit(platformFeeWallet, token, platformCut);
        _credit(marketingFeeWallet, token, marketingCut);

        address l1 = playerRegistry.referrerOf(player);
        uint256 l1Cut = (stake * REFERRAL_L1_BPS) / BPS_DENOMINATOR;
        _creditReferralOrFallback(l1, token, l1Cut);

        address l2 = l1 != address(0) ? playerRegistry.referrerOf(l1) : address(0);
        uint256 l2Cut = (stake * REFERRAL_L2_BPS) / BPS_DENOMINATOR;
        _creditReferralOrFallback(l2, token, l2Cut);

        address l3 = l2 != address(0) ? playerRegistry.referrerOf(l2) : address(0);
        uint256 l3Cut = (stake * REFERRAL_L3_BPS) / BPS_DENOMINATOR;
        _creditReferralOrFallback(l3, token, l3Cut);

        totalFee = ownerCut + platformCut + marketingCut + l1Cut + l2Cut + l3Cut;
    }

    /// @dev A referral level with no registered referrer redirects its cut to
    /// platformFeeWallet instead of leaving it uncredited to anyone.
    function _creditReferralOrFallback(address referrer, address token, uint256 amount) private {
        _credit(referrer == address(0) ? platformFeeWallet : referrer, token, amount);
    }

    function _credit(address account, address token, uint256 amount) private {
        if (amount == 0) return;
        pendingWithdrawals[account][token] += amount;
    }
}
