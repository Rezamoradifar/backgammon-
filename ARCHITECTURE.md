# Architecture

## What this version is, and isn't

This is a **wallet-connected, skill-game Backgammon platform** on BNB Smart
Chain. Two wallets can create and play a match against each other; the chain
records who played whom and who won. A match's stake is optional and chosen
by its creator when calling `createGame` (`msg.value`, 0 = a free/friendly
match with no escrow or payout at all, same as this project's original
scope) - `joinGame` must send exactly that amount. When a match is staked,
`GameManager` escrows both players' funds and, on completion, pays the
winner minus an owner/platform/marketing fee and up to 3 levels of referral
commission (see the fee-split table in `DEPLOYMENT.md`); every payout is a
pull-payment (`pendingWithdrawals` + `withdraw()`), specifically so a single
reverting fee-recipient address can never freeze every match's settlement -
see `GameManager`'s contract-level NatSpec and `contracts/contracts/test/Wagering.t.sol`
for the full reasoning and the tests proving it.

A smart contract does not by itself make real-money wagering legal, remove
KYC/AML obligations, or exempt a platform from gambling licensing. Those
requirements are a function of jurisdiction and the actual economic activity
happening, not of whether a blockchain is involved - the multi-level referral
commission structure specifically tends to sit under its own additional
regulatory scrutiny in many places, distinct from a gambling license alone.
That compliance responsibility sits with whoever operates a deployment with
staking enabled, not with this codebase. See `SECURITY.md` and
`DEPLOYMENT.md`'s wagering section before enabling it for real funds.

## System overview

```
┌─────────────┐        ┌──────────────────┐        ┌────────────────────┐
│   Frontend   │◄──────►│      Backend      │◄──────►│   PostgreSQL (DB)   │
│  (Next.js)   │  REST/  │ (Node/TS, WS)    │  Prisma │                     │
│              │  WS     │                   │        │                     │
└──────┬───────┘        └─────────┬─────────┘        └────────────────────┘
       │  wagmi/viem               │  viem (indexer, read-only)
       ▼                           ▼
┌─────────────────────────────────────────────────┐
│              BNB Smart Chain (BSC)                │
│  ┌─────────────────┐   ┌───────────────────────┐  │
│  │  PlayerRegistry   │   │      GameManager       │  │
│  └─────────────────┘   │  (uses IRandomnessProvider) │
│                         └───────────┬───────────┘  │
│                                     ▼               │
│                    MockRandomnessProvider (dev only) │
│                    / production VRF adapter (future) │
└─────────────────────────────────────────────────┘
```

The frontend talks to the chain directly for on-chain actions (wallet
signs the transaction), and to the backend for everything that doesn't need
to be on-chain: matchmaking, move relay between the two players' clients,
game history, leaderboards, and player stats display. The backend never
holds a private key on a user's behalf and never has custody of anything -
its job is coordination and indexing, not custody.

## On-chain vs. off-chain split

This is the central design decision, and it's explicit rather than
incidental: **a full backgammon match involves dozens of dice rolls and
checker moves; none of the individual moves are written on-chain.** Doing so
would cost real gas for every single die roll and checker placement in a
game that has no stakes to justify that cost, for no fairness benefit (see
below).

What's on-chain (`GameManager`):

| Action | Why it's on-chain |
|---|---|
| Create / join a match | Establishes who the two participants are, publicly and immutably. |
| Start (randomness request) | Fairly and verifiably decides who moves first - the one place raw unpredictability actually matters. |
| Optional move-commitment checkpoint | A cheap, opt-in hash anchor a player can post if they want an audit trail for a future dispute - not required for normal play. |
| Submit / confirm / dispute result | The economically meaningful fact ("who won") is recorded and mutually agreed on-chain. |
| Cancel / forfeit | Lifecycle bookkeeping so a match can't get stuck forever. |

What's off-chain (client + backend, not in this contracts stage):

- Every individual dice roll after the game starts, and every checker move.
- The full backgammon rules engine (legal-move validation, bearing off,
  hitting blots, forced moves) - both clients run the same deterministic
  engine and agree on the outcome; nothing about backgammon's rules needs a
  trusted third party to arbitrate in real time.
- Matchmaking, chat/presence, and the live board state shown to each player.

If a player believes the counted result is wrong, they call `disputeResult`
instead of `confirmResult`. Full decentralized dispute resolution (e.g.
replaying the entire move log against the engine and verifying a hash chain)
is a real, larger undertaking and is left as a documented extension point;
this version resolves disputes via an `ARBITER_ROLE` human reviewer, which is
proportionate to a free, low-stakes game.

## Randomness model

`IRandomnessProvider` / `IRandomnessConsumer` (`contracts/interfaces/IRandomnessProvider.sol`)
abstracts "get one verifiably-fair random word" behind an interface, so
`GameManager` never hard-codes a specific oracle. It's used for exactly one
thing in this version: **fairly picking who moves first** when a match
starts. It is deliberately *not* used for in-game dice - those are off-chain
(see above), which sidesteps the far more expensive problem of getting a
VRF round for every single roll of a free game.

- `MockRandomnessProvider` (`contracts/randomness/MockRandomnessProvider.sol`)
  is the only implementation in this version. It is explicitly **not
  secure** - it derives its word from `blockhash`/`prevrandao`, which a block
  producer (or, on a local dev chain, anyone) can bias or predict. It exists
  purely so `GameManager` has something to compile and test against.
- Fulfillment is a **separate, explicit call** (`fulfill(requestId)`), not
  something that happens inside the request call itself. This mirrors how a
  real VRF coordinator actually behaves (the callback always arrives in a
  later transaction, never the same one) and is required for `GameManager`'s
  own request-id bookkeeping to be race-free - an earlier version of this
  mock called back synchronously and it corrupted that bookkeeping, caught by
  the Foundry-style test suite (`test_RevertWhen_ReplayingAFulfilledRandomnessRequest`
  and its siblings).
- **Production replacement**: point `randomnessProvider` (via
  `setRandomnessProvider`, admin-only) at a real VRF-backed adapter - e.g. a
  Chainlink VRF v2.5 subscription consumer implementing the same
  `IRandomnessProvider` interface, calling back into
  `GameManager.fulfillRandomness` from the VRF Coordinator. That adapter does
  not exist in this version; building and auditing it is future work, kept
  cleanly separate by the interface boundary.
- Replay protection: `GameManager` records `requestId -> gameId` when it
  requests randomness, and deletes that entry the moment it's consumed. A
  second fulfillment attempt with the same `requestId` reverts with
  `UnknownRandomnessRequest`. Only the configured provider address may call
  `fulfillRandomness` at all (`NotRandomnessProvider` otherwise).

## Game lifecycle (state machine)

```
CREATED ──(opponent joins)──► WAITING_FOR_PLAYER is actually the FIRST state;
```

To avoid confusion, here is the real transition graph as implemented
(`GameManager.State`):

```
        createGame()
            │
            ▼
   WAITING_FOR_PLAYER ──cancelGame()──► CANCELLED
            │
        joinGame()
            │
            ▼
         CREATED ──cancelGame()──► CANCELLED
            │
        startGame() + randomness fulfilled
            │
            ▼
          ACTIVE ──forfeitGame()──► COMPLETED
            │
        submitResult()
            │
            ▼
     AWAITING_RESULT ──confirmResult()──────► COMPLETED
            │         ──finalizeByTimeout()─► COMPLETED  (submitter only, after 1 day)
        disputeResult()
            │
            ▼
        DISPUTED ──resolveDispute() [ARBITER_ROLE]──► COMPLETED
```

Two additions beyond the originally-specified function set, both necessary
for the state machine to actually be workable rather than able to get stuck:

- **`forfeitGame`**: without it, a player who disappears mid-match freezes
  the game in `ACTIVE` forever. Either seated player can forfeit, instantly
  handing the win to their opponent.
- **`finalizeByTimeout`**: without it, a player who submits an honest result
  and then faces a silent, non-responding opponent (who neither confirms nor
  disputes) is stuck in `AWAITING_RESULT` forever. After
  `RESULT_CONFIRMATION_WINDOW` (1 day), the submitter can finalize
  unilaterally.

A deliberate, documented tradeoff: `cancelGame` still allows the creator to
cancel a match even after an opponent has joined (state `CREATED`, before
`startGame`). Since no funds are at stake in this version, that's a minor
inconvenience to the joining player, not a griefing or escrow risk. A future
stake-based version should restrict this (or compensate the joiner) since the
inconvenience becomes an economic harm once money is involved.

## Trust assumptions

| Party | Trusted for | Not trusted for |
|---|---|---|
| Randomness provider | Providing the random word used for GameManager's own bookkeeping to stay correct | Anything else - a compromised/predictable provider only affects who moves first, never funds (there are none) or match outcomes directly |
| `ARBITER_ROLE` holder | Manually resolving disputed match outcomes | Anything else - cannot touch funds (none exist), cannot alter a non-disputed game, cannot bypass `onlyPlayer`/state checks |
| `DEFAULT_ADMIN_ROLE` holder | Pausing the contract, swapping the randomness provider, cancelling stuck pre-start games | Cannot declare a winner, cannot touch an ACTIVE or COMPLETED game's outcome, cannot withdraw anything (there is nothing to withdraw - no payable functions, no token balance the contract ever holds) |
| Backend | Matchmaking, relaying moves between clients, indexing on-chain events into the DB for history/leaderboards | Never holds a private key on a user's behalf; never signs a transaction for a user; a compromised backend can disrupt matchmaking/UX but cannot forge an on-chain result, since `submitResult`/`confirmResult` must be signed by the actual seated players' wallets |
| Each player's client | Running the shared deterministic rules engine honestly during their own turn | The opponent's client does not trust the other's engine output blindly - both independently validate legality; the on-chain `submitResult`/`confirmResult`/`disputeResult` flow is the actual arbitration mechanism when clients disagree |

No contract in this version is upgradeable (no proxy pattern) and no
contract holds player funds, so there is no hidden owner withdrawal path to
audit for - the "no hidden owner withdrawal" requirement is satisfied
structurally, not by a promise.

## Future regulated modules (not implemented, not activated)

Escrow, fees, and referral commissions are implemented (see above) - what's
still explicitly **out of scope**, kept behind the interface boundaries
described above rather than half-wired-in:

- **KYC/AML**: would live in the backend/off-chain layer (identity is not a
  smart-contract concern), gating access to staked matches specifically -
  not the free-match path, which needs none of this.
- **Geographic restrictions**: same - an off-chain, backend-enforced concern
  for staked matches, irrelevant to a free match.
- **A production randomness provider**: `MockRandomnessProvider` is
  dev/testnet-only (see its NatSpec and SECURITY.md) - a real deployment
  with staking enabled needs a real VRF-backed `IRandomnessProvider`
  swapped in via `setRandomnessProvider` before it's trustworthy.

None of this is stubbed out with placeholder functions in `GameManager` or
`PlayerRegistry` - deliberately, so there's no half-finished wagering code
sitting dormant in the audited surface of the free version. Building any of
it is contingent on the actual legal/licensing review described in the
project brief, not on engineering readiness.

## Repository layout

```
onchain-backgammon/
├── ARCHITECTURE.md        (this file)
├── SECURITY.md
├── contracts/             Solidity + Hardhat 3 (also Foundry-compatible - see below)
│   ├── contracts/
│   │   ├── GameManager.sol
│   │   ├── PlayerRegistry.sol
│   │   ├── interfaces/IRandomnessProvider.sol
│   │   ├── randomness/MockRandomnessProvider.sol
│   │   └── test/*.t.sol  (forge-std style unit + fuzz tests)
│   ├── hardhat.config.ts
│   └── foundry.toml
├── backend/               Node/TS API + WebSocket + Prisma - see backend/README.md
│   ├── prisma/schema.prisma
│   └── src/
│       ├── auth/          wallet-signature (SIWE-style) nonce + verify + JWT sessions
│       ├── engine/         ported rules engine + server-side dice CSPRNG
│       ├── ws/             matchmaking queue + live gameplay relay (move validation, anti-cheat)
│       ├── indexer/        GameManager event watcher -> Postgres
│       └── routes/         auth, game history, leaderboard, referral REST endpoints
└── frontend/              Next.js client (not started)
```

## Why Hardhat 3 instead of only Foundry for this stage

The brief specifies Foundry for development. The contracts and their
forge-std-style tests (including fuzz tests) are written to be fully
Foundry-compatible - `foundry.toml` is included and `forge test` should run
them as-is with a real Foundry install. In the sandbox this was built in,
Foundry's own installer (`foundryup`) needs `api.github.com`, which that
environment's egress policy blocks; Hardhat 3 ships a built-in Solidity test
runner that executes the *same* forge-std `.t.sol` files (including
`vm.prank`, `vm.expectRevert`, `vm.warp`, and fuzz `testFuzz_*` functions)
without needing Foundry's own binary, so it was used to actually compile and
run the suite for real in that constrained environment. Both toolchains read
the same contracts and the same tests; nothing here is Hardhat-only syntax.
