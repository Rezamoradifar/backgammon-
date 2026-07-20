# Deployment

## Current testnet deployment (BSC Testnet, chainId 97)

Deployed from a disposable, testnet-only deployer key (holds only free
faucet tBNB, never reused for anything of value):

| Contract | Address |
|---|---|
| `PlayerRegistry` | `0x7cC99d855C17ce442Db707038dfA8b6EDf2329a6` |
| `MockRandomnessProvider` | `0x129CEf49AE0F8990dd0e9FEF0C2b1604ACafB182` |
| `GameManager` | `0x827a143C5cf778a9E72f362d26bDDa6BD61C6B7F` |

`admin` and `arbiter` on `GameManager`, and `admin` on `PlayerRegistry`, are
all the deployer address above - a testnet-only convenience, not how a real
deployment should be arranged (see SECURITY.md's roles section).

RPC used: `https://bsc-testnet-rpc.publicnode.com`.

BscScan source verification for these three contracts hasn't been done yet
- pending.

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
TESTNET_DEPLOYER_KEY=0x... NODE_USE_ENV_PROXY=1 node scripts/deploy-testnet.mjs
```

(`NODE_USE_ENV_PROXY=1` is only needed if you're running this behind an
HTTP(S)_PROXY that Node's built-in `fetch` doesn't pick up automatically -
harmless otherwise.) Writes `scripts/deployed-addresses.testnet.json`
(gitignored) with the three addresses and grants `GameManager` the
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
