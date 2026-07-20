// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Abstraction over a verifiable randomness source, so GameManager
/// never depends on one specific provider implementation. An admin can swap
/// the active provider (e.g. moving from the local mock to a production
/// VRF-backed adapter) without redeploying GameManager.
interface IRandomnessProvider {
    /// @notice Requests one random word for `gameId`. The provider calls back
    /// into `IRandomnessConsumer.fulfillRandomness` on the caller once the
    /// result is available - synchronously for a local mock, asynchronously
    /// for a real VRF-backed one.
    /// @return requestId A provider-assigned id, unique per request, used by
    /// the consumer to match the eventual fulfillment to this exact request.
    function requestRandomness(uint256 gameId) external returns (uint256 requestId);
}

/// @notice Implemented by contracts that consume randomness requested via
/// {IRandomnessProvider.requestRandomness}.
interface IRandomnessConsumer {
    /// @dev Must only accept this call from the trusted, currently-configured
    /// randomness provider - implementations must check `msg.sender`.
    function fulfillRandomness(uint256 requestId, uint256 gameId, uint256 randomWord) external;
}
