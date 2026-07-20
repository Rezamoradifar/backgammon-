import { createServer } from "node:http";
import express from "express";

import { authRouter } from "./routes/auth.js";
import { gamesRouter } from "./routes/games.js";
import { leaderboardRouter } from "./routes/leaderboard.js";
import { referralRouter } from "./routes/referral.js";
import { createWsServer } from "./ws/server.js";
import { startGameManagerIndexer } from "./indexer/gameManagerIndexer.js";
import { startWeeklyRewardsScheduler } from "./jobs/weeklyRewards.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/auth", authRouter);
app.use("/games", gamesRouter);
app.use("/leaderboard", leaderboardRouter);
app.use("/referral", referralRouter);

const httpServer = createServer(app);
createWsServer(httpServer);

const { RPC_URL, GAME_MANAGER_ADDRESS, CHAIN_ID, MOCK_RANDOMNESS_PROVIDER_ADDRESS, MOCK_RANDOMNESS_RELAYER_KEY } = process.env;
if (RPC_URL && GAME_MANAGER_ADDRESS) {
  startGameManagerIndexer({
    rpcUrl: RPC_URL,
    gameManagerAddress: GAME_MANAGER_ADDRESS as `0x${string}`,
    mockRandomnessProviderAddress: MOCK_RANDOMNESS_PROVIDER_ADDRESS as `0x${string}` | undefined,
    mockRandomnessRelayerKey: MOCK_RANDOMNESS_RELAYER_KEY as `0x${string}` | undefined,
    chain: {
      id: Number(CHAIN_ID ?? 97),
      name: "configured-chain",
      nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
      rpcUrls: { default: { http: [RPC_URL] } },
    },
  });
  console.log(`Contract event indexer watching ${GAME_MANAGER_ADDRESS} on chain ${CHAIN_ID}`);
  if (MOCK_RANDOMNESS_PROVIDER_ADDRESS && MOCK_RANDOMNESS_RELAYER_KEY) {
    console.log(`Auto-fulfilling MockRandomnessProvider requests at ${MOCK_RANDOMNESS_PROVIDER_ADDRESS} (testnet-only stopgap)`);
  }
} else {
  console.log("RPC_URL / GAME_MANAGER_ADDRESS not set - contract event indexer is not running");
}

const { WEEKLY_REWARD_DISTRIBUTOR_KEY } = process.env;
if (RPC_URL && GAME_MANAGER_ADDRESS && WEEKLY_REWARD_DISTRIBUTOR_KEY) {
  startWeeklyRewardsScheduler({
    rpcUrl: RPC_URL,
    gameManagerAddress: GAME_MANAGER_ADDRESS as `0x${string}`,
    distributorPrivateKey: WEEKLY_REWARD_DISTRIBUTOR_KEY as `0x${string}`,
    chain: {
      id: Number(CHAIN_ID ?? 97),
      name: "configured-chain",
      nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
      rpcUrls: { default: { http: [RPC_URL] } },
    },
  });
  console.log("Weekly top-wagerer reward job is running (hourly due-check)");
} else {
  console.log("WEEKLY_REWARD_DISTRIBUTOR_KEY not set - weekly reward job is not running");
}

const port = Number(process.env.PORT ?? 4000);
httpServer.listen(port, () => {
  console.log(`Backend listening on :${port} (HTTP + /ws)`);
});
