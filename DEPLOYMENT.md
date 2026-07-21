# Deployment

## Current testnet deployment (BSC Testnet, chainId 97)

Redeployed (GameManager only - PlayerRegistry/MockRandomnessProvider/MockUSDT
reused as-is, so existing player registry stats and referral registrations
carry over) to retune the fee split - owner 5%->7.5%, platform 5%->2.5%,
marketing and referral totals unchanged. Deployed from a disposable,
testnet-only deployer key (holds only free faucet tBNB, never reused for
anything of value):

| Contract | Address |
|---|---|
| `PlayerRegistry` | `0x73d9B06F77521AA0Ff5e04C3593BC2Ba821A1868` |
| `MockRandomnessProvider` | `0xFc69A338137C82B1F2c6C7e312085ff85A275790` |
| `MockUSDT` | `0xC097fe10Fcd9Bf1728390Cf742e2A835900929B9` |
| `GameManager` | `0x2D2c6450fFAe4F76D90215aE5A3D3e8Fb5E1cE18` |

`admin` and `arbiter` on `GameManager`, and `admin` on `PlayerRegistry`, are
all the deployer address above - a testnet-only convenience, not how a real
deployment should be arranged (see SECURITY.md's roles section).

Fee wallets on this `GameManager`:

| Wallet | Address | Cut |
|---|---|---|
| `ownerFeeWallet` | `0x63c5B98AEfd69658B652d5F35FFda3C6c06847E3` | 7.50% of each player's stake |
| `platformFeeWallet` | deployer address (placeholder - admin-changeable via `setPlatformFeeWallet`) | 2.50% + any referral level with no registered referrer - now also the weekly reward pool's holding account, see below |
| `marketingFeeWallet` | `0x0467aE53eaC5A1C46cCC48f1D1C00B3D91F6f74a` | 2.50% of each player's stake |

`REWARD_DISTRIBUTOR_ROLE` is held by the same deployer address (testnet
convenience, same reasoning as `admin`/`arbiter` above) - the backend's
`WEEKLY_REWARD_DISTRIBUTOR_KEY` uses this same key on this deployment.

RPC used: `https://bsc-testnet-rpc.publicnode.com`.

BscScan source verification for these contracts hasn't been done yet -
pending.

### Staking with USDT instead of BNB

`GameManager` now accepts a match's stake in native BNB (`createGame`,
unchanged) **or** an admin-allowlisted ERC-20 token (`createGameERC20`,
new). On this testnet deployment, `MockUSDT` above (a 6-decimal test
token - BSC Testnet has no canonical Tether deployment, so this stands in
for it, same reasoning as `MockRandomnessProvider`; never deploy it to
mainnet) is the only allowlisted stake token, added via
`setStakeTokenAllowed`. Anyone can mint themselves test funds via its
public `faucet(uint256 wholeTokens)` function - no admin needed.

Key design point: **BNB and ERC-20 balances never mix.**
`pendingWithdrawals` is keyed by `(account, token)` - address(0) means
native BNB - so a player who's won both a BNB match and a USDT match
withdraws each separately via `withdraw(token)`. The fee split (20% total,
same bps table as before) and referral chain work identically regardless
of which asset a match is staked in; each is just computed in that
token's own smallest unit.

A real deployment swaps `MockUSDT` for the actual USDT contract address on
the target chain via `setStakeTokenAllowed` - no contract redeploy needed
for that swap, only redeploy was needed to add ERC-20 support itself.

## Live deployment (Railway)

| Service | URL |
|---|---|
| Backend (API + WebSocket) | `https://backgammon-production-d36d.up.railway.app` |
| Frontend | `https://frontend-production-acc82.up.railway.app` |

Backend, Postgres, and frontend are separate Railway services in the same
project/environment; the backend talks to Postgres over Railway's private
network (`postgres.railway.internal`).

### Verified end-to-end against this live deployment

`backend/scripts/smoke-test.mjs` runs the full flow with two real wallets
against the URLs above and BSC Testnet - SIWE auth, on-chain
createGame/joinGame/startGame, the indexer picking the game up into a real
Postgres, the backend's auto-fulfill relayer resolving randomness
unattended, `forfeitGame` settling the wager, and a real `withdraw()`
moving real (testnet) BNB - and confirms the fee split lands on the exact
expected wei amounts. Last run: all steps passed.

Not covered by that script: the WebSocket-based matchmaking/live-room relay
(pairing two queued players, rolling dice, relaying moves). That needs a
real browser or an unrestricted WS client to exercise - this repo's own
dev sandbox couldn't (WebSocket upgrades to arbitrary hosts aren't
supported through its network policy). Verify that piece by actually
playing a match through the frontend in a browser with two wallets.

### Two deployment gotchas already fixed here, worth knowing if you redeploy

- **Postgres volume mounted directly at `/var/lib/postgresql/data` breaks
  `initdb`** (the mount point already has a `lost+found` dir, and Postgres
  refuses to initialize into a non-empty directory). Fix: mount the volume
  one level up (`/var/lib/postgresql`) and set `PGDATA` to a subdirectory
  under it.
- **`tsc` doesn't copy the indexer's ABI JSON files into `dist/`** since
  nothing statically imports them (they're loaded via `readFileSync` at
  runtime) - the container built and started fine, then crashed on ENOENT
  the moment the indexer initialized. Fixed by an explicit `cp` step in
  `backend/Dockerfile` after `npm run build`.
- **A public RPC's free-tier `eth_getLogs` range cap can permanently wedge
  a naive indexer.** `gameManagerIndexer.ts` no longer uses viem's
  `watchContractEvent` directly - see its own comment for why (a plain
  "watch from last block to latest" catch-up range can exceed a provider's
  cap after any restart/gap, and every poll after that keeps retrying the
  same oversized, rejected range forever). It now chunks every poll to 40
  blocks and resumes from the highest block already recorded in Postgres.

### Wagering, fees, and referral commissions (real money - read this first)

`GameManager.createGame()` now takes `msg.value` as the per-player stake
(0 = a free/friendly match, unchanged from before). `joinGame` must send
exactly that amount. On a completed match, **20% of each player's own
stake** is deducted (independently per player, from their own stake and
their own referral chain) and the rest goes to the winner:

| Cut | Bps | Recipient |
|---|---|---|
| Owner fee | 750 (7.50%) | `ownerFeeWallet` |
| Platform fee | 250 (2.50%) | `platformFeeWallet` |
| Marketing fee | 250 (2.50%) | `marketingFeeWallet` |
| Referral level 1 | 400 (4.00%) | the player's registered referrer |
| Referral level 2 | 200 (2.00%) | that referrer's own referrer |
| Referral level 3 | 150 (1.50%) | that referrer's referrer's referrer |

A player registers who referred them once, ever, via
`PlayerRegistry.setReferrer(address)` - there's no restriction on who the
referrer address is, and a referral level with nobody registered falls back
to `platformFeeWallet` rather than being lost. All payouts (winner,
fees, referral commissions, and cancellation refunds) are **pull-payments**:
credited to `pendingWithdrawals[account]` and claimed via `withdraw()`,
specifically so a single fee-recipient address that reverts on receiving
BNB can never freeze every match's payout (see `GameManager`'s contract-level
NatSpec and `contracts/contracts/test/Wagering.t.sol` for the full
threat-model reasoning and the tests proving it, including a dedicated
reentrancy test on `withdraw()`).

**Before enabling this on mainnet with real funds**: this is real-money
wagering with referral commissions, which in most jurisdictions requires a
gambling license (and the multi-level referral structure specifically often
sits under separate regulatory scrutiny beyond that, distinct from a
gambling license alone - the person deploying this is responsible for that
compliance, not this codebase). A professional third-party security audit
of this escrow/payout logic is strongly recommended before any real user
funds are ever at risk here - none has been done yet, this has only been
tested with Foundry-style unit/fuzz tests in this repo.

### Weekly top-wagerer rewards

Once a week, the backend's own job (`backend/src/jobs/weeklyRewards.ts`)
redirects part of `platformFeeWallet`'s own accumulated 2.5% cut to that
week's top 3 wagerers by total stake volume, instead of it just sitting
there indefinitely:

1. It ranks players by total stake across matches that actually **settled**
   (`COMPLETED`) in the previous Monday-to-Monday UTC week - a cancelled
   match refunds in full and pays no fee, so it doesn't count as wagering
   volume.
2. It takes the top 3, and splits a pool - the *smaller* of that week's
   estimated 2.5% fee accumulation and whatever `platformFeeWallet` actually
   holds on-chain right now - tiered 50% / 30% / 20% (1st/2nd/3rd).
3. It calls `GameManager.distributeWeeklyRewards(winners, amounts, weekId)`,
   which **only** moves already-credited `platformFeeWallet` balance to the
   named winners' own `pendingWithdrawals` - it cannot invent funds, and
   can't touch anyone else's balance (`ownerFeeWallet`, `marketingFeeWallet`,
   any player's own credited winnings). Restricted to `REWARD_DISTRIBUTOR_ROLE`,
   granted to a backend-held key (`WEEKLY_REWARD_DISTRIBUTOR_KEY`) whose
   *only* on-chain capability is this one function.
4. Winners are recorded in Postgres (`WeeklyRewardDistribution`, unique on
   `[weekId, walletId]`) before the job is considered done for that week -
   the job checks this table first on every run (it re-checks roughly
   hourly, not on a precise once-a-week timer, so a restart or missed tick
   just means "it runs within an hour of when it should have"), which is
   what actually guarantees a week is never paid out twice, not the hourly
   cadence itself.

The 50/30/20 tiered split was this codebase's own design choice (the owner
asked for "tiered, first place gets the most" without specifying exact
percentages) - change `TIER_SHARES` in `weeklyRewards.ts` if a different
split is wanted. `platformFeeWallet` still accumulates its normal 2.5% (plus
any referral-fallback redirects) every settled match exactly as before;
this job is what turns part of that ongoing balance into a recurring
players' prize pool instead of a static fee sink.

**Live**: the deployed `GameManager` above includes this function,
`REWARD_DISTRIBUTOR_ROLE` is granted to the backend's job wallet, and
`WEEKLY_REWARD_DISTRIBUTOR_KEY` is set on the live backend - the job is
running (hourly due-check) against this deployment.

### Cosmetics shop (dice/board skins)

Purely visual dice/board skins, paid for with a real on-chain transaction
(native BNB, or the same USDT stake token above) - no gameplay effect, and
no new contract. The catalog lives in code
(`backend/src/shop/catalog.ts`), not a DB table, since there's no admin UI
to add items yet.

Purchase flow (`backend/src/routes/shop.ts`):
1. The frontend sends BNB directly, or calls the USDT token's own
   `transfer`, to `SHOP_TREASURY_ADDRESS` (defaults to `OWNER_FEE_WALLET` -
   no reason to stand up a second treasury).
2. It POSTs the resulting `txHash` to `/shop/purchase`. The backend never
   trusts this at face value - it independently re-reads that exact
   transaction from the chain (sender, recipient, and paid amount) before
   granting the item, the same "read the chain ourselves" posture the
   contract event indexer uses for game events.
3. A DB-level unique constraint on `txHash` means a given payment can only
   ever be redeemed into one item grant, even under concurrent requests.

Env vars: `SHOP_TREASURY_ADDRESS` (or reuse `OWNER_FEE_WALLET`),
`USDT_TOKEN_ADDRESS` (the same MockUSDT address above). A player's
in-game level (shown next to their name) is a simple, purely cosmetic
`floor(sqrt(gamesPlayed)) + 1` derived from existing leaderboard stats -
no new state, no relation to the shop.

### The MockRandomnessProvider caveat (read this before wiring a backend up)

`MockRandomnessProvider` is explicitly insecure and dev/testnet-only (see its
NatSpec and SECURITY.md). It defers fulfillment to a separate `fulfill(requestId)`
call instead of resolving synchronously, mirroring a real VRF coordinator's
async callback - but *nothing calls that automatically*. A production
randomness provider would call back on its own; this mock needs something
to call `fulfill` for it, or every game hangs forever right after `startGame()`.

For this testnet deployment, the backend does that itself: `gameManagerIndexer.ts`
watches `GameManager`'s `RandomnessRequested` event and immediately calls
`fulfill(requestId)` using a disposable testnet key held only by the
backend (the "relayer" - see `MOCK_RANDOMNESS_RELAYER_KEY` below; this
deployment reuses the same throwaway key that deployed the contracts,
since both are testnet-only, valueless keys with nothing to separate). This
is a testnet-only stopgap, not a security model - anyone can call `fulfill`
themselves too, since the mock has no access control. Swapping in a real
VRF-backed provider before any real deployment removes the need for this
relayer entirely.

## Deploying the contracts yourself

```bash
cd backend
OWNER_FEE_WALLET=0x... PLATFORM_FEE_WALLET=0x... MARKETING_FEE_WALLET=0x... \
REWARD_DISTRIBUTOR_ADDRESS=0x... \
TESTNET_DEPLOYER_KEY=0x... NODE_USE_ENV_PROXY=1 node scripts/deploy-testnet.mjs
```

(`NODE_USE_ENV_PROXY=1` is only needed if you're running this behind an
HTTP(S)_PROXY that Node's built-in `fetch` doesn't pick up automatically -
harmless otherwise. The three `*_FEE_WALLET` vars all default to the
deployer address if omitted - `platformFeeWallet` is meant to be changed
later via `setPlatformFeeWallet` regardless. `REWARD_DISTRIBUTOR_ADDRESS`
defaults to the deployer too, but should be the address matching whatever
key goes into the backend's own `WEEKLY_REWARD_DISTRIBUTOR_KEY`.) Writes
`scripts/deployed-addresses.testnet.json` (gitignored) with the three
contract addresses, fee wallets, and reward-distributor address, and grants
`GameManager` the `GAME_MANAGER_ROLE` on `PlayerRegistry` and
`REWARD_DISTRIBUTOR_ROLE` to `REWARD_DISTRIBUTOR_ADDRESS` automatically.

Never point this script, or `MockRandomnessProvider`, at BSC mainnet.

## Hosting (backend + frontend)

Both the backend and Postgres need to run somewhere persistently reachable
on the internet - this repo's own CI/dev sandbox is not that. The backend
ships a `Dockerfile` (multi-stage build, runs `prisma migrate deploy` then
the compiled server) so it deploys cleanly on any container host; the
frontend is a stock Next.js app any Next-aware host (or the same Dockerfile
approach) can build directly.

### Railway (what this project's first deployment used)

1. New Railway project, connect the GitHub repo.
2. Add a Postgres database (Railway's own plugin) to the project.
3. Add a service for the backend:
   - Root directory: `backend`
   - Builds from `backend/Dockerfile` automatically.
   - Env vars: `DATABASE_URL` (reference the Postgres plugin's variable),
     `CHAIN_ID=97`, `RPC_URL=https://bsc-testnet-rpc.publicnode.com`,
     `GAME_MANAGER_ADDRESS`, `PLAYER_REGISTRY_ADDRESS` (the two addresses
     above), `MOCK_RANDOMNESS_PROVIDER_ADDRESS` (the address above),
     `MOCK_RANDOMNESS_RELAYER_KEY` (a funded testnet key - see the caveat
     above), `WEEKLY_REWARD_DISTRIBUTOR_KEY` (the key matching whichever
     address was granted `REWARD_DISTRIBUTOR_ROLE` at deploy time - only
     needs enough BNB for gas, never holds player funds), `JWT_SECRET`
     (any long random string), `JWT_EXPIRES_IN=7d`.
   - Generate a public domain (Settings -> Networking).
4. Add a service for the frontend:
   - Root directory: `frontend`
   - Nixpacks auto-detects Next.js - no Dockerfile needed.
   - Env vars: `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL` (the backend
     service's public domain, `https://`/`wss://`), `NEXT_PUBLIC_GAME_MANAGER_ADDRESS`,
     `NEXT_PUBLIC_PLAYER_REGISTRY_ADDRESS` (same two addresses),
     `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (optional - without it the
     wallet list falls back to MetaMask only, see `frontend/lib/wagmi.ts`).
   - Generate a public domain.

## Mainnet

Not done, and not something to do casually: `MockRandomnessProvider` must
first be replaced with a real VRF-backed provider (see ARCHITECTURE.md),
and the deployer/admin/arbiter roles need to be real, separately-held
addresses rather than one throwaway testnet key wearing three hats. See
SECURITY.md before any mainnet deployment.
