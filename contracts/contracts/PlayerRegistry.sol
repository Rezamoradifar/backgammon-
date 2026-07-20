// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title PlayerRegistry
/// @notice Optional on-chain identity and aggregate stats for players. Holds
/// no funds and grants no privileged access based on stats or display name -
/// a public, append-only scoreboard that a GameManager updates whenever one
/// of its matches completes.
contract PlayerRegistry is AccessControl {
    /// @dev Granted to GameManager deployments so they - and only they - can
    /// record a result once a match actually reaches COMPLETED on-chain.
    bytes32 public constant GAME_MANAGER_ROLE = keccak256("GAME_MANAGER_ROLE");

    uint16 public constant MAX_DISPLAY_NAME_LENGTH = 32;

    struct Stats {
        uint32 wins;
        uint32 losses;
        uint32 gamesPlayed;
    }

    mapping(address player => string displayName) public displayNameOf;
    mapping(address player => Stats stats) public statsOf;

    /// @notice Who referred a given player, if anyone - set at most once per
    /// player (first call wins) so an existing referral relationship can't be
    /// reassigned later. Consulted by GameManager to route wagering referral
    /// commissions; unset for a player just means "no referrer," not an error.
    mapping(address player => address referrer) public referrerOf;

    error DisplayNameTooLong();
    error ReferrerAlreadySet();
    error SelfReferral();

    event PlayerRegistered(address indexed player, string displayName);
    event ResultRecorded(address indexed winner, address indexed loser);
    event ReferrerSet(address indexed player, address indexed referrer);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Sets or updates the caller's own display name.
    /// @dev Uniqueness is enforced off-chain (backend/DB), not here - the
    /// chain only needs to authenticate "this address chose this label," not
    /// arbitrate collisions between accounts.
    function registerDisplayName(string calldata displayName) external {
        if (bytes(displayName).length > MAX_DISPLAY_NAME_LENGTH) revert DisplayNameTooLong();
        displayNameOf[msg.sender] = displayName;
        emit PlayerRegistered(msg.sender, displayName);
    }

    /// @notice One-time registration of who referred the caller.
    /// @dev Callable by anyone for themselves, at most once (no reassigning a
    /// referrer later). `referrer` isn't required to be a known/registered
    /// player - it's just an address that will receive referral commissions
    /// from the caller's future wagers, if any. Referral chains (referrer's
    /// own referrer, and so on) are read by GameManager by walking this
    /// mapping up to its configured depth - not validated or bounded here, so
    /// a cycle (A refers B, B refers A) is possible but harmless: it only
    /// means fixed-percentage commissions circulate between the two, not an
    /// unbounded loop, since every reader walks a fixed number of levels.
    function setReferrer(address referrer) external {
        if (referrerOf[msg.sender] != address(0)) revert ReferrerAlreadySet();
        if (referrer == msg.sender) revert SelfReferral();
        referrerOf[msg.sender] = referrer;
        emit ReferrerSet(msg.sender, referrer);
    }

    /// @notice Records a completed match's outcome.
    /// @dev Restricted to addresses holding GAME_MANAGER_ROLE, so stats can
    /// only move in lockstep with an actual on-chain game reaching COMPLETED.
    function recordResult(address winner, address loser) external onlyRole(GAME_MANAGER_ROLE) {
        Stats storage winnerStats = statsOf[winner];
        Stats storage loserStats = statsOf[loser];
        winnerStats.wins += 1;
        winnerStats.gamesPlayed += 1;
        loserStats.losses += 1;
        loserStats.gamesPlayed += 1;
        emit ResultRecorded(winner, loser);
    }
}
