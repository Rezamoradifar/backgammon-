// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A 6-decimal ERC-20 standing in for USDT on BSC Testnet (there is
/// no canonical testnet Tether deployment). Explicitly test-only, same as
/// MockRandomnessProvider - never deploy this to mainnet; a real deployment
/// should point GameManager's stake-token allowlist at the actual USDT
/// contract address for the target chain instead.
/// @dev `faucet` is open to anyone specifically so testers can mint
/// themselves stake funds without needing an admin - there is no economic
/// value here to protect.
contract MockUSDT is ERC20 {
    uint8 private constant DECIMALS = 6;

    constructor() ERC20("Mock USDT (testnet only)", "mUSDT") {}

    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }

    /// @notice Mints `amount` (in whole mUSDT, e.g. 100 = 100 mUSDT) to the caller.
    function faucet(uint256 amount) external {
        _mint(msg.sender, amount * 10 ** DECIMALS);
    }
}
