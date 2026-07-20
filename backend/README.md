# Backend

Node.js/TypeScript API + WebSocket server for the On-Chain Backgammon
platform. See the repo root's `ARCHITECTURE.md` for the
full on-chain/off-chain design; this README covers backend-specific setup,
testing, and a few implementation notes worth knowing before you read the
code.

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET at minimum
npx prisma migrate dev
npm run dev
```

Requires a running PostgreSQL instance matching `DATABASE_URL`.

## What's implemented

- **Wallet-signature auth** (`src/auth/`): a minimal SIWE-style (EIP-4361-flavored)
  nonce + sign + verify flow using viem's `verifyMessage`. The backend never
  sees or needs a private key at any point. Sessions are plain JWTs.
- **Matchmaking** (`src/ws/matchmaker.ts`): an in-memory queue that pairs two
  waiting wallets and tells both "go create/join the on-chain game with this
  opponent." It does not create a `Game` row itself - that only happens once
  the contract event indexer sees the real on-chain transactions.
- **Real-time gameplay relay** (`src/ws/gameRoom.ts`): once a game goes
  `ACTIVE` on-chain, both players' sockets join a room keyed by the game's
  internal id. The backend rolls dice itself (`src/engine/dice.ts`, a CSPRNG)
  and validates every submitted move against the same deterministic rules
  engine the free client-side game uses (`src/engine/engine.ts`, ported from
  `dravon`'s `lib/backgammon/engine.ts`) before applying it - a client
  claiming an illegal move is rejected and logged as a `SecurityEvent`, not
  silently trusted.
- **Contract event indexer** (`src/indexer/gameManagerIndexer.ts`): watches
  `GameManager`'s events via viem and mirrors them into Postgres - creating
  `Game`/`GamePlayer` rows, activating the live WebSocket room the moment a
  match goes `ACTIVE`, and recording `GameResult` + updating
  `LeaderboardEntry` when a match completes. Idempotent by construction: every
  event is first written to the append-only `ContractEvent` table keyed by
  `(transactionHash, logIndex)`, so a replayed event (e.g. after a reconnect)
  is a no-op, not a duplicate.
- **REST endpoints** (`src/routes/`): `/auth/nonce`, `/auth/verify`,
  `/games/history/:address`, `/games/:onChainGameId/moves`, `/leaderboard`,
  `/referral/claim`, `/referral/mine`.

## Why the backend rolls the dice

Both clients run the identical rules engine, so per-move *validation* doesn't
need a trusted third party - but *dice* are different: if either client
generated its own roll, a dishonest client could bias it. The backend rolls
dice server-side with Node's CSPRNG (`crypto.randomInt`) and broadcasts the
result to both players - a neutral-referee pattern, not "trust the client."

## Testing

```bash
npm test
```

Runs the full suite via Node's built-in test runner (serialized -
`--test-concurrency=1` - a couple of the integration tests open real sockets
and a real DB connection, and running them concurrently was genuinely flaky
in this environment, not indicative of a product bug). Covers:

- `src/auth/siwe.test.ts` - real signature verification with a genuinely
  generated keypair (not a mock): correct signer verifies, wrong signer
  doesn't, tampered message doesn't.
- `src/engine/engine.test.ts` - the ported rules engine's core behavior.
- `src/ws/gameplay.integration.test.ts` - two real WebSocket clients (real
  JWTs, real Postgres rows) roll and move through a full server-validated
  turn, including confirming an out-of-turn action from the wrong player is
  rejected and logged as a `SecurityEvent`.
- `src/indexer/gameManagerIndexer.integration.test.ts` - see below; skips
  itself if no local chain is configured.

### Local end-to-end testing (real chain, not mocked)

The indexer integration test talks to an actual local blockchain rather than
mocking viem - this is how it was verified while building this stage:

```bash
# Terminal 1: a local Hardhat JSON-RPC node
cd ../contracts && npx hardhat node

# Terminal 2: deploy PlayerRegistry + MockRandomnessProvider + GameManager to it
cd backend && node scripts/deploy-local.mjs
# prints three addresses and writes scripts/deployed-addresses.local.json

# Terminal 2 (same one): run the suite pointed at that chain
LOCAL_RPC_URL=http://127.0.0.1:8545 \
LOCAL_GAME_MANAGER_ADDRESS=<GameManager address printed above> \
LOCAL_RANDOMNESS_ADDRESS=<MockRandomnessProvider address printed above> \
npm test
```

Without those three env vars, `npm test` still runs everything else and
skips only the on-chain indexer test (reported as `SKIP`, not a failure).

## Environment variables

See `.env.example`. `RPC_URL` / `GAME_MANAGER_ADDRESS` are optional for
`npm run dev` - if unset, the server starts without the contract indexer
running (logged clearly, not a silent no-op) and everything else (auth, WS
matchmaking against already-seeded rooms, REST reads) still works.
