# Deployment

## Current testnet deployment (BSC Testnet, chainId 97)

Deployed from a disposable, testnet-only deployer key (holds only free
faucet tBNB, never reused for anything of value):

| Contract | Address |
|---|---|
| `PlayerRegistry` | `0x04B155d2Aa2A3F8E4Cc87185dDA33c98a7ffd99e` |
| `MockRandomnessProvider` | `0x5E2330F247665938216A9d868F55c230a63322B7` |
| `GameManager` | `0x659F13336113FdC0AE864C965634D8eF39f4EB84` |

`admin` and `arbiter` on `GameManager`, and `admin` on `PlayerRegistry`, are
all the deployer address above - a testnet-only convenience, not how a real
deployment should be arranged (see SECURITY.md's roles section).

Fee wallets on this `GameManager`:

| Wallet | Address | Cut |
|---|---|---|
| `ownerFeeWallet` | `0x63c5B98AEfd69658B652d5F35FFda3C6c06847E3` | 5.00% of each player's stake |
| `platformFeeWallet` | deployer address (placeholder - admin-changeable via `setPlatformFeeWallet`) | 5.00% + any referral level with no registered referrer |
| `marketingFeeWallet` | `0x0467aE53eaC5A1C46cCC48f1D1C00B3D91F6f74a` | 2.50% of each player's stake |

RPC used: `https://bsc-testnet-rpc.publicnode.com`.

BscScan source verification for these three contracts hasn't been done yet
- pending.

### Wagering, fees, and referral commissions (real money - read this first)

`GameManager.createGame()` now takes `msg.value` as the per-player stake
(0 = a free/friendly match, unchanged from before). `joinGame` must send
exactly that amount. On a completed match, **20% of each player's own
stake** is deducted (independently per player, from their own stake and
their own referral chain) and the rest goes to the winner:

| Cut | Bps | Recipient |
|---|---|---|
| Owner fee | 500 (5.00%) | `ownerFeeWallet` |
| Platform fee | 500 (5.00%) | `platformFeeWallet` |
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
TESTNET_DEPLOYER_KEY=0x... NODE_USE_ENV_PROXY=1 node scripts/deploy-testnet.mjs
```

(`NODE_USE_ENV_PROXY=1` is only needed if you're running this behind an
HTTP(S)_PROXY that Node's built-in `fetch` doesn't pick up automatically -
harmless otherwise. The three `*_FEE_WALLET` vars all default to the
deployer address if omitted - `platformFeeWallet` is meant to be changed
later via `setPlatformFeeWallet` regardless.) Writes
`scripts/deployed-addresses.testnet.json` (gitignored) with the three
contract addresses and fee wallets, and grants `GameManager` the
`GAME_MANAGER_ROLE` on `PlayerRegistry` automatically.

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
     above), `JWT_SECRET` (any long random string), `JWT_EXPIRES_IN=7d`.
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
