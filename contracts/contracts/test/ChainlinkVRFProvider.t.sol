// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";
import {ChainlinkVRFProvider} from "../randomness/ChainlinkVRFProvider.sol";
import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {IRandomnessConsumer} from "../interfaces/IRandomnessProvider.sol";

/// @dev Stands in for GameManager: records whatever the provider calls back
/// with, and - like the real GameManager.fulfillRandomness - only accepts
/// that callback from the address it trusts as its configured provider.
contract MockConsumer is IRandomnessConsumer {
    address public immutable trustedProvider;
    uint256 public lastRequestId;
    uint256 public lastGameId;
    uint256 public lastRandomWord;
    bool public fulfilled;

    error NotTrustedProvider();

    constructor(address trustedProvider_) {
        trustedProvider = trustedProvider_;
    }

    function fulfillRandomness(uint256 requestId, uint256 gameId, uint256 randomWord) external {
        if (msg.sender != trustedProvider) revert NotTrustedProvider();
        lastRequestId = requestId;
        lastGameId = gameId;
        lastRandomWord = randomWord;
        fulfilled = true;
    }
}

contract ChainlinkVRFProviderTest is Test {
    VRFCoordinatorV2_5Mock internal coordinator;
    ChainlinkVRFProvider internal provider;
    MockConsumer internal consumer;

    address internal admin = makeAddr("admin");
    uint256 internal subId;

    function setUp() public {
        coordinator = new VRFCoordinatorV2_5Mock(0.1 ether, 1e9, 1e18);
        subId = coordinator.createSubscription();
        coordinator.fundSubscription(subId, 100 ether);

        vm.prank(admin);
        provider = new ChainlinkVRFProvider(address(coordinator), subId, bytes32(uint256(1)), 3, 200_000, false);
        coordinator.addConsumer(subId, address(provider));

        consumer = new MockConsumer(address(provider));
    }

    function test_RevertWhen_DisallowedConsumerRequestsRandomness() public {
        vm.prank(address(consumer));
        vm.expectRevert(ChainlinkVRFProvider.ConsumerNotAllowed.selector);
        provider.requestRandomness(1);
    }

    function test_AllowedConsumer_RequestAndFulfillRoundTrip() public {
        vm.prank(admin);
        provider.setConsumerAllowed(address(consumer), true);

        vm.prank(address(consumer));
        uint256 requestId = provider.requestRandomness(42);

        coordinator.fulfillRandomWords(requestId, address(provider));

        assertTrue(consumer.fulfilled());
        assertEq(consumer.lastRequestId(), requestId);
        assertEq(consumer.lastGameId(), 42);
    }

    function test_RevertWhen_NonOwnerSetsConsumerAllowed() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert("Only callable by owner");
        provider.setConsumerAllowed(address(consumer), true);
    }

    function test_RevertWhen_NonOwnerUpdatesVrfConfig() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert("Only callable by owner");
        provider.setVrfConfig(bytes32(uint256(2)), 5, 300_000, true);
    }

    function test_RevertWhen_NonCoordinatorCallsRawFulfillDirectly() public {
        vm.prank(admin);
        provider.setConsumerAllowed(address(consumer), true);
        vm.prank(address(consumer));
        uint256 requestId = provider.requestRandomness(1);

        uint256[] memory words = new uint256[](1);
        words[0] = 7;
        vm.expectRevert(
            abi.encodeWithSelector(VRFConsumerBaseV2Plus.OnlyCoordinatorCanFulfill.selector, address(this), address(coordinator))
        );
        provider.rawFulfillRandomWords(requestId, words);
    }

    function test_RevertWhen_FulfillingAnUnknownRequestId() public {
        vm.prank(admin);
        provider.setConsumerAllowed(address(consumer), true);
        // Never actually requested - the coordinator itself would reject this
        // (InvalidRequest), so simulate its callback path directly instead.
        uint256[] memory words = new uint256[](1);
        words[0] = 9;
        vm.prank(address(coordinator));
        vm.expectRevert(ChainlinkVRFProvider.RequestNotFound.selector);
        provider.rawFulfillRandomWords(999, words);
    }

    function test_SetSubscriptionId_UpdatesSubscription() public {
        vm.prank(admin);
        provider.setSubscriptionId(777);
        assertEq(provider.subscriptionId(), 777);
    }
}
