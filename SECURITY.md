# Security

## Scope of this document

Covers `contracts/contracts/GameManager.sol`, `PlayerRegistry.sol`, and the
randomness abstraction. The backend and frontend have their own security
considerations (wallet-signature auth, never handling private keys) noted
in their own READMEs once built; this file is about the on-chain surface,
which is what actually needs a security review before any mainnet deploy.

## Applied measures

- **Checks-Effects-Interactions**: every state-mutating function updates
  `Game` storage before making any external call (e.g. `_finalize` sets
  `game.state = State.COMPLETED` before calling
  `playerRegistry.recordResult`). `startGame` requests randomness only after
  fully validating state; the actual state mutation happens later, in
  `fulfillRandomness`, once the trusted provider calls back.
- **`ReentrancyGuard`**: applied to every function that performs an external
  call with a state change on either side (`startGame`, `confirmResult`,
  `finalizeByTimeout`, `forfeitGame`). `submitMove`, `submitResult`, and
  `disputeResult` have no external calls, so no guard is needed there.
- **`AccessControl`** (OpenZeppelin v5): `ARBITER_ROLE` for dispute
  resolution, `PAUSER_ROLE` for the emergency pause switch, `DEFAULT_ADMIN_ROLE`
  for provider swaps, fee-wallet updates (`setOwnerFeeWallet`,
  `setPlatformFeeWallet`, `setMarketingFeeWallet`), and role management,
  `REWARD_DISTRIBUTOR_ROLE` for the backend's automated weekly top-wagerer
  reward job (see below). `DEFAULT_ADMIN_ROLE` can redirect where fees are
  paid, but cannot touch `pendingWithdrawals` balances already credited to
  players, referrers, or the fee wallets themselves - see "No hidden owner
  withdrawal" below. `PlayerRegistry.GAME_MANAGER_ROLE` is the only way
  stats can be written, restricting it to actual `GameManager` deployments.
- **`Pausable`**: `createGame`, `joinGame`, `startGame`, `submitMove`,
  `submitResult`, `forfeitGame` all respect `whenNotPaused`. Result
  confirmation/dispute/timeout-finalization and cancellation are deliberately
  **not** pause-gated, so a paused contract can still be wound down safely
  (players already mid-dispute or mid-timeout aren't stuck waiting on an
  admin to unpause).
- **Custom errors** throughout (no `require(string)`), for cheaper reverts
  and precise, typed failure reasons callers/tests can assert on.
- **No upgradeability**: no proxy pattern. A bug requires a new deployment
  and a migration, not a silent logic swap. This was a low-stakes tradeoff
  when the contract held no funds; now that a deployment can escrow real
  BNB, it cuts the other way too - there is no way to patch a discovered
  bug in place, only redeploy and migrate players/funds to a new contract.
  Weigh this seriously before enabling staking with meaningful amounts.
- **No hidden owner withdrawal**: every BNB movement out of `GameManager`
  goes through `pendingWithdrawals[account]`, credited only by the specific
  gameplay events described in DEPLOYMENT.md's wagering section (a
  settled wager's winner/fee/referral split, or a cancellation refund) -
  there is no function, admin-gated or otherwise, that sweeps the
  contract's balance or credits an arbitrary address out of thin air.
  `DEFAULT_ADMIN_ROLE` can redirect *where future fees* go
  (`setOwnerFeeWallet` etc.) but cannot touch a balance already credited to
  someone. `withdraw()` itself only ever pays `msg.sender` their own
  credited balance.
- **Randomness replay protection**: see ARCHITECTURE.md's randomness
  section. A `requestId` is deleted from the tracking map the instant it's
  consumed; only the configured provider address may call back at all.
- **Zero-address checks** on constructor parameters and provider updates.

## Roles

| Role | Held by (this testnet deployment) | Can do | Cannot do |
|---|---|---|---|
| `DEFAULT_ADMIN_ROLE` (`GameManager`, `PlayerRegistry`) | the deployer address (see DEPLOYMENT.md) | Swap the randomness provider; change fee-wallet addresses; grant/revoke roles | Touch any already-credited `pendingWithdrawals` balance; move a player's escrowed stake before a match settles |
| `ARBITER_ROLE` (`GameManager`) | same deployer address | Resolve a `disputeResult` by naming a winner | Anything outside an actively `DISPUTED` match - see the manual-arbitration limitation below |
| `PAUSER_ROLE` (`GameManager`) | same deployer address | Pause/unpause `createGame`/`joinGame`/`startGame`/`submitMove`/`submitResult`/`forfeitGame` | Pause result confirmation, dispute, timeout-finalization, or cancellation - deliberately left active even while paused, see "Applied measures" |
| `REWARD_DISTRIBUTOR_ROLE` (`GameManager`) | a dedicated backend-held key, distinct from the deployer/admin key, whose only job is running the weekly reward cron | Move part of `platformFeeWallet`'s own already-credited balance to that week's top-3-wagerer winners via `distributeWeeklyRewards` | Credit itself or anyone from thin air - blocked by an on-chain balance check against `platformFeeWallet`'s real `pendingWithdrawals` balance; touch any other account's balance (a player's winnings, `ownerFeeWallet`, `marketingFeeWallet`) |
| `GAME_MANAGER_ROLE` (`PlayerRegistry`) | the `GameManager` contract itself | Record a completed match's stats | Nothing else - it's the only permission this role grants |

On this testnet deployment, one address wears the admin/arbiter/pauser hats
- a testnet-only convenience (see DEPLOYMENT.md), not how a real deployment
should be arranged. A real deployment should split these across separately
held keys, and treat the arbiter key especially carefully once staking is
enabled - it can decide who wins a disputed, real-money match.

## Known limitations (by design, for this version)

- **`MockRandomnessProvider` is not secure** and must never be deployed to
  mainnet or testnet as the active provider - it's for local development and
  tests only. This is stated in its own NatSpec, not just here.
- **Dispute resolution is manually arbitrated** (`ARBITER_ROLE`), not
  cryptographically verified against the full off-chain move log. This was
  an acceptable tradeoff when nothing was at stake; now that a match can be
  staked, a disputed result puts real escrowed funds in the hands of a
  single arbiter's judgment call, with no on-chain verification against the
  actual game transcript. Real design work (full move-log replay and
  verification, or a decentralized oracle) is needed before this is a
  trustworthy dispute path for meaningfully large stakes - treat the
  arbiter as a genuine trusted third party, not a rubber stamp, and keep
  stakes small until that work is done.
- **A malicious client could submit a false `resultHash`/claimed winner.**
  The counter-party's recourse is `disputeResult`, escalating to the arbiter
  above. There is no cryptographic proof step yet that a submitted result
  actually matches a valid, legal game transcript - the `movesCommitment`
  checkpoint exists as a building block for that, but nothing in this
  version verifies it against anything.
- **`cancelGame` after an opponent has joined** refunds both players' full
  escrowed stakes (no fee is taken on a cancellation) - a griefing
  inconvenience at worst, not a fund-loss risk, for a staked match.

## Testing

58 tests in `contracts/contracts/test/*.t.sol`, run via
`npx hardhat test` (Hardhat 3's built-in Solidity test runner; also
Foundry-`forge test`-compatible, see ARCHITECTURE.md):

- Unit tests for every state transition and every access-control gate.
- Fuzz tests (256 runs each) for: non-players can never submit moves,
  a submitted winner must be one of the two seated players, a second
  joiner is always rejected regardless of address, the timeout window
  is enforced for every elapsed-time value below the boundary, and (for the
  wagering path) total credited BNB across every recipient always exactly
  equals total deposited, for any stake amount and win/loss outcome.
- `contracts/contracts/test/Wagering.t.sol` specifically covers the
  escrow/payout path: exact fee-split amounts, multi-level and partial
  referral chains, cancellation refunds, and - the two properties that
  actually matter most for a contract holding real funds - a test proving a
  single reverting fee-recipient address can never block the game or
  anyone else's withdrawal, and a dedicated reentrancy test on `withdraw()`.
  It also covers `distributeWeeklyRewards`: exact winner-credit amounts and
  the matching debit from `platformFeeWallet`, that it never touches
  `ownerFeeWallet`/`marketingFeeWallet`, and reverts for every misuse case
  (no `REWARD_DISTRIBUTOR_ROLE`, mismatched array lengths, an empty winner
  list, a zero-address winner, or a requested total exceeding what
  `platformFeeWallet` actually holds).
- Real bugs were found and fixed by this suite before being merged (not
  hypothetical - this is what actually happened building this version):
  1. `MockRandomnessProvider` originally fulfilled synchronously inside
     `requestRandomness`, racing `GameManager`'s own request-tracking
     bookkeeping. Fixed by making fulfillment a separate, explicit call.
  2. A `GameAlreadyFull` check in `joinGame` was unreachable dead code - the
     preceding state check already fully prevents double-joining. Removed
     rather than left in as false reassurance.
  3. (Found in production, not by this test suite) The deployed indexer's
     naive event-watching could permanently wedge after any downtime, once
     the catch-up range exceeded a public RPC's free-tier `eth_getLogs`
     cap - see `DEPLOYMENT.md`'s "deployment gotchas" for the fix.

## Reporting a vulnerability

This is a personal/small-team project, not a bug-bounty program yet. If you
find an issue, open an issue in this repository describing it. Real BNB is
at risk in any deployment with staking enabled and real funds in it (see
the wagering section of `DEPLOYMENT.md`) - treat escrow/payout/access-control
bugs as urgent, and treat a professional third-party audit as a
prerequisite before meaningful stakes are ever exposed to this code on
mainnet, not an optional nice-to-have.
