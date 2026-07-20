# On-Chain Backgammon (free, non-custodial)

A free-to-play, wallet-connected 1v1 Backgammon platform on BNB Smart Chain.
No wagering, no wallet-held stakes, no payouts - matches are created, joined,
started, and recorded on-chain; the game itself is played off-chain by two
clients running the same deterministic rules engine. See `ARCHITECTURE.md`
for the full design (on-chain/off-chain split, randomness model, trust
assumptions) and `SECURITY.md` for the security measures and known
limitations.

## Status

| Layer | Status |
|---|---|
| Smart contracts (`GameManager`, `PlayerRegistry`, randomness abstraction) | **Done.** Compiled and tested - 34 tests passing, including fuzz tests. |
| Backend (Node/TS, Prisma/Postgres, WebSocket matchmaking + move relay, contract indexer) | **Done.** Auth, matchmaking, real-time gameplay relay, and the contract event indexer all verified end-to-end - see `backend/README.md`. |
| Frontend (Next.js, wagmi/viem/RainbowKit) | **Done.** Landing, lobby (matchmaking -> on-chain game -> live room), gameplay board, leaderboard, history, referral, profile, and settings pages - `tsc`, `eslint`, and `next build` all clean, verified in a real browser. See `frontend/README.md`. |
| Docker / deployment configuration | **Done.** Backend ships a `Dockerfile`; frontend deploys as a stock Next.js app. See `DEPLOYMENT.md`. |
| BNB Chain Testnet deployment | **Done.** `PlayerRegistry`, `MockRandomnessProvider`, and `GameManager` are live on BSC Testnet - addresses in `DEPLOYMENT.md`. Hosting the backend/frontend so the deployment is actually reachable is in progress. |

## Repository layout

```
onchain-backgammon/
├── ARCHITECTURE.md
├── SECURITY.md
├── GAME_RULES.md
├── contracts/     Solidity + Hardhat 3 (Foundry-compatible, see ARCHITECTURE.md)
├── backend/       Node/TS API + WebSocket + Prisma
└── frontend/      Next.js client
```

## Contracts: setup

```bash
cd contracts
npm install
npx hardhat compile
npx hardhat test
```

If you have Foundry installed, the same contracts and tests also run with:

```bash
cd contracts
forge test
```

## Backend: setup

```bash
cd backend
npm install
cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET
npx prisma migrate dev
npm test
```

See `backend/README.md` for what's implemented, why the backend (not either
client) rolls the dice, and how to run the full suite against a real local
blockchain (not mocked) for the contract-indexer test.

## Deploying

See `DEPLOYMENT.md` for the current BSC Testnet deployment's addresses, how
to redeploy the contracts yourself, and how to host the backend/frontend
(Docker + Railway walkthrough this project's first deployment used).

## License

MIT (contracts). Backend/frontend licensing to be decided once those layers
exist.
