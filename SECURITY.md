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
  for provider swaps and role management. `PlayerRegistry.GAME_MANAGER_ROLE`
  is the only way stats can be written, restricting it to actual
  `GameManager` deployments.
- **`Pausable`**: `createGame`, `joinGame`, `startGame`, `submitMove`,
  `submitResult`, `forfeitGame` all respect `whenNotPaused`. Result
  confirmation/dispute/timeout-finalization and cancellation are deliberately
  **not** pause-gated, so a paused contract can still be wound down safely
  (players already mid-dispute or mid-timeout aren't stuck waiting on an
  admin to unpause).
- **Custom errors** throughout (no `require(string)`), for cheaper reverts
  and precise, typed failure reasons callers/tests can assert on.
- **No upgradeability**: no proxy pattern. A bug requires a new deployment,
  not a silent logic swap - appropriate for a contract with no funds at risk
  and a correspondingly low cost of redeployment.
- **No hidden owner withdrawal**: there is no `payable` function anywhere in
  `GameManager` or `PlayerRegistry`, and no function that moves any token or
  native-currency balance out of the contract, because the contract never
  receives any. This is structural, not policy - there is nothing to
  withdraw.
- **Randomness replay protection**: see ARCHITECTURE.md's randomness
  section. A `requestId` is deleted from the tracking map the instant it's
  consumed; only the configured provider address may call back at all.
- **Zero-address checks** on constructor parameters and provider updates.

## Known limitations (by design, for this version)

- **`MockRandomnessProvider` is not secure** and must never be deployed to
  mainnet or testnet as the active provider - it's for local development and
  tests only. This is stated in its own NatSpec, not just here.
- **Dispute resolution is manually arbitrated** (`ARBITER_ROLE`), not
  cryptographically verified against the full off-chain move log. Acceptable
  for a free game; would need real design work (full move-log replay and
  verification, or a decentralized oracle) before any stake-bearing version.
- **A malicious client could submit a false `resultHash`/claimed winner.**
  The counter-party's recourse is `disputeResult`, escalating to the arbiter.
  There is no cryptographic proof step yet that a submitted result actually
  matches a valid, legal game transcript - the `movesCommitment` checkpoint
  exists as a building block for that, but nothing in this version verifies
  it against anything.
- **`cancelGame` after an opponent has joined** is a known, documented
  tradeoff (see ARCHITECTURE.md) - acceptable because no funds are at stake
  in this version.

## Testing

34 tests in `contracts/contracts/test/*.t.sol`, run via
`npx hardhat test` (Hardhat 3's built-in Solidity test runner; also
Foundry-`forge test`-compatible, see ARCHITECTURE.md):

- Unit tests for every state transition and every access-control gate.
- Fuzz tests (256 runs each) for: non-players can never submit moves,
  a submitted winner must be one of the two seated players, a second
  joiner is always rejected regardless of address, and the timeout window
  is enforced for every elapsed-time value below the boundary.
- Two real bugs were found and fixed by this suite before being merged (not
  hypothetical - this is what actually happened building this version):
  1. `MockRandomnessProvider` originally fulfilled synchronously inside
     `requestRandomness`, racing `GameManager`'s own request-tracking
     bookkeeping. Fixed by making fulfillment a separate, explicit call.
  2. A `GameAlreadyFull` check in `joinGame` was unreachable dead code - the
     preceding state check already fully prevents double-joining. Removed
     rather than left in as false reassurance.

## Reporting a vulnerability

This is a personal/small-team project, not a bug-bounty program yet. If you
find an issue before this reaches mainnet, open an issue in this repository
describing it - there is nothing custodial at risk in this version, so
there's no urgency around fund safety, but state-machine or access-control
bugs are still worth flagging before any real-money module is ever built on
top of this.
