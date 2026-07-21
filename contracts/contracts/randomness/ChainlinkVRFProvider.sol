// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {IRandomnessProvider, IRandomnessConsumer} from "../interfaces/IRandomnessProvider.sol";

/// @title ChainlinkVRFProvider
/// @notice Production `IRandomnessProvider` backed by Chainlink VRF v2.5
/// (subscription model) - the real, unbiasable/unpredictable randomness
/// source GameManager must be pointed at before a mainnet deployment goes
/// live; see `MockRandomnessProvider`'s NatSpec for why that one never can.
/// @dev Deployment/operational steps (see DEPLOYMENT.md for the full
/// walkthrough):
/// 1. Create a VRF subscription at vrf.chain.link for the target chain,
///    fund it (LINK or native BNB, matching `nativePayment` below), and
///    note its `subscriptionId`.
/// 2. Deploy this contract with that subscription id, the chain's VRF
///    Coordinator address, and a keyHash (gas lane) - both from Chainlink's
///    published per-chain VRF docs.
/// 3. Add this contract as a consumer on that subscription (from the
///    subscription's own owner/UI) - Chainlink bills requests to the
///    subscription, not to this contract's own balance.
/// 4. Call {setConsumerAllowed} to allowlist the deployed GameManager
///    address - only allowlisted callers may spend the subscription's
///    funds via {requestRandomness}; without this gate, any address could
///    drain it by spamming requests billed to it.
/// 5. Point GameManager at this contract via its own `setRandomnessProvider`
///    (admin-only there).
contract ChainlinkVRFProvider is VRFConsumerBaseV2Plus, IRandomnessProvider {
    struct PendingRequest {
        address consumer;
        uint256 gameId;
    }

    uint32 private constant NUM_WORDS = 1;

    uint256 public subscriptionId;
    bytes32 public keyHash;
    uint16 public requestConfirmations;
    uint32 public callbackGasLimit;
    /// @notice Whether subscription costs are paid in the chain's native
    /// token (true) or LINK (false) - must match how the subscription
    /// itself is actually funded, or every request reverts at the
    /// Coordinator once its balance of the *other* currency runs out.
    bool public nativePayment;

    /// @notice Contracts allowed to spend this subscription's funds via
    /// {requestRandomness}.
    mapping(address consumer => bool allowed) public allowedConsumers;

    mapping(uint256 requestId => PendingRequest pending) private pendingRequests;

    error ConsumerNotAllowed();
    error RequestNotFound();

    event ConsumerAllowedUpdated(address indexed consumer, bool allowed);
    event VrfConfigUpdated(bytes32 keyHash, uint16 requestConfirmations, uint32 callbackGasLimit, bool nativePayment);
    event SubscriptionIdUpdated(uint256 subscriptionId);

    constructor(
        address vrfCoordinator,
        uint256 subscriptionId_,
        bytes32 keyHash_,
        uint16 requestConfirmations_,
        uint32 callbackGasLimit_,
        bool nativePayment_
    ) VRFConsumerBaseV2Plus(vrfCoordinator) {
        subscriptionId = subscriptionId_;
        keyHash = keyHash_;
        requestConfirmations = requestConfirmations_;
        callbackGasLimit = callbackGasLimit_;
        nativePayment = nativePayment_;
    }

    /// @notice Allows or disallows a contract (e.g. GameManager) to request
    /// randomness billed to this provider's VRF subscription.
    function setConsumerAllowed(address consumer, bool allowed) external onlyOwner {
        allowedConsumers[consumer] = allowed;
        emit ConsumerAllowedUpdated(consumer, allowed);
    }

    /// @notice Updates the VRF request parameters (gas lane, confirmations,
    /// callback gas, payment currency) without redeploying.
    function setVrfConfig(bytes32 keyHash_, uint16 requestConfirmations_, uint32 callbackGasLimit_, bool nativePayment_)
        external
        onlyOwner
    {
        keyHash = keyHash_;
        requestConfirmations = requestConfirmations_;
        callbackGasLimit = callbackGasLimit_;
        nativePayment = nativePayment_;
        emit VrfConfigUpdated(keyHash_, requestConfirmations_, callbackGasLimit_, nativePayment_);
    }

    /// @notice Points this provider at a different (or migrated) subscription.
    function setSubscriptionId(uint256 subscriptionId_) external onlyOwner {
        subscriptionId = subscriptionId_;
        emit SubscriptionIdUpdated(subscriptionId_);
    }

    /// @inheritdoc IRandomnessProvider
    function requestRandomness(uint256 gameId) external returns (uint256 requestId) {
        if (!allowedConsumers[msg.sender]) revert ConsumerNotAllowed();

        requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: NUM_WORDS,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: nativePayment}))
            })
        );
        pendingRequests[requestId] = PendingRequest({consumer: msg.sender, gameId: gameId});
    }

    /// @dev Only reachable via `VRFConsumerBaseV2Plus.rawFulfillRandomWords`,
    /// which itself reverts unless `msg.sender` is the real VRF Coordinator -
    /// this function never has to (and cannot) check that itself.
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        PendingRequest memory pending = pendingRequests[requestId];
        if (pending.consumer == address(0)) revert RequestNotFound();
        delete pendingRequests[requestId];

        IRandomnessConsumer(pending.consumer).fulfillRandomness(requestId, pending.gameId, randomWords[0]);
    }
}
