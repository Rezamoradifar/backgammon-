// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRandomnessProvider, IRandomnessConsumer} from "./interfaces/IRandomnessProvider.sol";
import {PlayerRegistry} from "./PlayerRegistry.sol";

/// @title GameManager
/// @notice Coordinates the lifecycle of free, non-custodial 1v1 Backgammon
/// matches. Full per-checker, per-turn play happens off-chain between the two
/// clients (see ARCHITECTURE.md's on-chain/off-chain split) - this contract
/// anchors only a match's identity, participants, lifecycle state, an
/// optional move-commitment checkpoint, and the final agreed result, so
/// outcomes stay auditable without paying gas for every dice roll and
/// checker move.
/// @dev Holds no player funds. No wagering, escrow, entry fees, or payouts
/// exist in this version - see ARCHITECTURE.md's "Future regulated modules"
/// section for what a separately-licensed module would add later, and why
/// none of that is wired in here.
contract GameManager is AccessControl, Pausable, ReentrancyGuard, IRandomnessConsumer {
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

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
    }

    PlayerRegistry public immutable playerRegistry;
    IRandomnessProvider public randomnessProvider;

    uint256 private nextGameId = 1;
    mapping(uint256 gameId => Game game) public games;
    mapping(uint256 requestId => uint256 gameId) private gameIdByRequestId;

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

    event GameCreated(uint256 indexed gameId, address indexed creator);
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

    modifier onlyPlayer(uint256 gameId) {
        Game storage game = games[gameId];
        if (msg.sender != game.player1 && msg.sender != game.player2) revert NotAPlayer();
        _;
    }

    modifier gameExists(uint256 gameId) {
        if (games[gameId].state == State.NONE) revert GameNotFound();
        _;
    }

    constructor(address admin, address arbiter, PlayerRegistry playerRegistry_, IRandomnessProvider randomnessProvider_) {
        if (admin == address(0) || address(playerRegistry_) == address(0) || address(randomnessProvider_) == address(0))
        {
            revert ZeroAddress();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        if (arbiter != address(0)) _grantRole(ARBITER_ROLE, arbiter);
        playerRegistry = playerRegistry_;
        randomnessProvider = randomnessProvider_;
    }

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    /// @notice Creates a new match and seats the caller as player1.
    function createGame() external whenNotPaused returns (uint256 gameId) {
        gameId = nextGameId++;
        Game storage game = games[gameId];
        game.player1 = msg.sender;
        game.state = State.WAITING_FOR_PLAYER;
        emit GameCreated(gameId, msg.sender);
    }

    /// @notice Seats the caller as player2 on an open match.
    /// @dev The state check alone fully prevents double-joining: a second
    /// join attempt always finds `state != WAITING_FOR_PLAYER` (the first
    /// join already advanced it to CREATED), so no separate "is player2
    /// already set" check is reachable or needed.
    function joinGame(uint256 gameId) external whenNotPaused gameExists(gameId) {
        Game storage game = games[gameId];
        if (game.state != State.WAITING_FOR_PLAYER) revert InvalidStateForAction(game.state, State.WAITING_FOR_PLAYER);
        if (msg.sender == game.player1) revert CannotJoinOwnGame();

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
    /// starts; since no funds are at stake in this version that's a minor
    /// inconvenience rather than a griefing/escrow risk - a future
    /// stake-based version should restrict this or add joiner compensation.
    function cancelGame(uint256 gameId) external gameExists(gameId) {
        Game storage game = games[gameId];
        bool isCreator = msg.sender == game.player1;
        bool isAdmin = hasRole(DEFAULT_ADMIN_ROLE, msg.sender);
        if (!isCreator && !isAdmin) revert NotAPlayer();
        if (game.state != State.WAITING_FOR_PLAYER && game.state != State.CREATED) {
            revert InvalidStateForAction(game.state, State.WAITING_FOR_PLAYER);
        }

        game.state = State.CANCELLED;
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

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
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
    }
}
