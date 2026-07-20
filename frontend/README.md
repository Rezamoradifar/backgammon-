# Frontend

Next.js (App Router) client for the on-chain Backgammon platform: wallet
connect, matchmaking, on-chain game creation/joining, and the live gameplay
board. See the root `../ARCHITECTURE.md` for how this fits with the backend
and contracts.

## Stack

- Next.js 16 (Turbopack), React 19, TypeScript
- wagmi v2 + viem for wallet/contract interaction
- RainbowKit for the wallet-connect UI, restricted to an explicit
  MetaMask + WalletConnect wallet list (see `lib/wagmi.ts` for why)
- Plain WebSocket client (`lib/useGameSocket.ts`) for matchmaking and the
  live gameplay relay against the backend

## Getting started

```bash
cp .env.example .env.local   # fill in the backend URL and contract addresses
npm install
npm run dev
```

Open http://localhost:3000. Without `NEXT_PUBLIC_GAME_MANAGER_ADDRESS` /
`NEXT_PUBLIC_PLAYER_REGISTRY_ADDRESS` set, matchmaking still pairs players
but on-chain game creation/joining will fail - see the backend's deploy
script for producing local addresses to test against.

`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is optional for local development:
without it the wallet list falls back to MetaMask only, since WalletConnect
v2 requires a real Cloud project id
(https://cloud.walletconnect.com) to initialize.

## Verification

```bash
npx tsc --noEmit
npm run lint
npm run build
```

All three are clean. The build was additionally checked by running
`npm run dev` and loading the landing and lobby pages in a real browser
(dark theme renders, the wallet-connect modal opens, zero console errors).
