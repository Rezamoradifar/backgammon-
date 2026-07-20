// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRandomnessProvider, IRandomnessConsumer} from "../interfaces/IRandomnessProvider.sol";

/// @notice Local-only randomness source for development and tests.
/// @dev NOT SECURE - derives its "random" word from blockhash/prevrandao,
/// which a block producer (or, on a local dev chain, anyone) can bias or
/// predict. This must never be wired into a production deployment; point
/// GameManager at a real VRF-backed provider instead (see ARCHITECTURE.md's
/// randomness section for the production wiring this is a placeholder for).
///
/// Fulfillment is a separate, explicit step ({fulfill}) rather than
/// happening inside {requestRandomness} itself - mirroring how a real VRF
/// coordinator always calls back in a later transaction. Consumers (like
/// GameManager) record their own request bookkeeping using the requestId
/// returned by {requestRandomness} *before* any fulfillment can occur; a
/// mock that fulfilled synchronously would call back before that
/// bookkeeping had a chance to run.
contract MockRandomnessProvider is IRandomnessProvider {
    struct PendingRequest {
        address consumer;
        uint256 gameId;
    }

    uint256 private nextRequestId = 1;
    mapping(uint256 requestId => PendingRequest pending) private pendingRequests;

    error RequestNotFound();

    function requestRandomness(uint256 gameId) external returns (uint256 requestId) {
        requestId = nextRequestId++;
        pendingRequests[requestId] = PendingRequest({consumer: msg.sender, gameId: gameId});
    }

    /// @notice Test/dev helper that triggers the deferred fulfillment
    /// callback for a previously-issued request, simulating a real VRF
    /// coordinator's later callback transaction. Callable by anyone - there
    /// is no production security model here, only local iteration speed.
    function fulfill(uint256 requestId) external {
        PendingRequest memory pending = pendingRequests[requestId];
        if (pending.consumer == address(0)) revert RequestNotFound();
        delete pendingRequests[requestId];

        uint256 randomWord = uint256(
            keccak256(abi.encode(blockhash(block.number - 1), block.prevrandao, requestId, pending.gameId))
        );
        IRandomnessConsumer(pending.consumer).fulfillRandomness(requestId, pending.gameId, randomWord);
    }
}
