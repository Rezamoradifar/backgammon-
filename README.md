# On-Chain Backgammon

A wallet-connected 1v1 Backgammon platform on BNB Smart Chain. A match's
stake is optional and set by its creator (0 = a free/friendly game); when set,
both players escrow that stake on-chain and the winner is paid out on
completion, minus an owner/platform/marketing fee and up to 3 levels of
referral commission - see `DEPLOYMENT.md`'s wagering section for the exact
split and the compliance responsibility that comes with enabling it for
real money. Matches are created, joined, started, and recorded on-chain;
the game itself is played off-chain by two clients running the same
deterministic rules engine. See `ARCHITECTURE.md` for the full design
(on-chain/off-chain split, randomness model, trust assumptions) and
`SECURITY.md` for the security measures and known limitations.

## Status

| Layer | Status |
|---|---|
| Smart contracts (`GameManager`, `PlayerRegistry`, randomness abstraction, wagering/fee/referral logic) | **Done.** Compiled and tested - 51 tests passing, including fuzz tests and dedicated reentrancy/DoS-safety tests for the wagering payout path. |
| Backend (Node/TS, Prisma/Postgres, WebSocket matchmaking + move relay, contract indexer) | **Done.** Auth, matchmaking, real-time gameplay relay, and the contract event indexer all verified end-to-end - see `backend/README.md`. |
| Frontend (Next.js, wagmi/viem/RainbowKit) | **Done.** Landing, lobby (stake amount -> matchmaking -> on-chain game -> live room), gameplay board, leaderboard, history, referral (on-chain), settings (withdraw), and profile pages - `tsc`, `eslint`, and `next build` all clean, verified in a real browser. See `frontend/README.md`. |
| Docker / deployment configuration | **Done.** Backend ships a `Dockerfile`; frontend deploys as a stock Next.js app. See `DEPLOYMENT.md`. |
| BNB Chain Testnet deployment | **Done, and live.** Contracts, backend, and frontend are all deployed and reachable - see `DEPLOYMENT.md` for addresses and URLs. A real two-wallet smoke test against the live deployment passes end-to-end (auth, on-chain create/join/start, indexing, auto-randomness, wagering payout, withdrawal). |

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
