import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { prisma } from "../lib/prisma.js";
import { startGameManagerIndexer } from "./gameManagerIndexer.js";

// Requires a local Hardhat node (`npx hardhat node` in contracts/) with
// GameManager/PlayerRegistry/MockRandomnessProvider already deployed - see
// README.md's "Local end-to-end testing" section for the exact commands.
// Skips itself (rather than failing) if that node isn't reachable, so the
// regular `npm test` run doesn't require standing up a chain.

const RPC_URL = process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8545";
const GAME_MANAGER_ADDRESS = process.env.LOCAL_GAME_MANAGER_ADDRESS as `0x${string}` | undefined;
const RANDOMNESS_ADDRESS = process.env.LOCAL_RANDOMNESS_ADDRESS as `0x${string}` | undefined;

const __dirname = dirname(fileURLToPath(import.meta.url));
const gameManagerAbi = JSON.parse(readFileSync(join(__dirname, "abi/GameManager.json"), "utf8"));
const randomnessAbi = JSON.parse(readFileSync(join(__dirname, "abi/MockRandomnessProvider.json"), "utf8"));

const localChain: Chain = {
  id: 31337,
  name: "hardhat-local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

// Well-known local Hardhat test accounts (safe - public private keys, local dev chain only).
const PLAYER1_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PLAYER2_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

async function isRpcReachable(): Promise<boolean> {
  try {
    const client = createPublicClient({ chain: localChain, transport: http(RPC_URL) });
    await client.getChainId();
    return true;
  } catch {
    return false;
  }
}

test("indexer mirrors a real on-chain game lifecycle into Postgres and activates a live room", async (t) => {
  if (!GAME_MANAGER_ADDRESS || !(await isRpcReachable())) {
    t.skip("no local Hardhat node / GameManager address configured - see README for how to run this locally");
    return;
  }

  const player1 = privateKeyToAccount(PLAYER1_KEY);
  const player2 = privateKeyToAccount(PLAYER2_KEY);

  const publicClient = createPublicClient({ chain: localChain, transport: http(RPC_URL) });
  const player1Client = createWalletClient({ account: player1, chain: localChain, transport: http(RPC_URL) });
  const player2Client = createWalletClient({ account: player2, chain: localChain, transport: http(RPC_URL) });

  const unwatch = startGameManagerIndexer({ rpcUrl: RPC_URL, chain: localChain, gameManagerAddress: GAME_MANAGER_ADDRESS });

  try {
    const createHash = await player1Client.writeContract({
      address: GAME_MANAGER_ADDRESS,
      abi: gameManagerAbi,
      functionName: "createGame",
      chain: localChain,
    });
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });

    const game = await pollUntil(async () => {
      const games = await prisma.game.findMany({ where: { contractAddress: GAME_MANAGER_ADDRESS }, orderBy: { createdAt: "desc" } });
      return games[0] ?? null;
    });
    assert.ok(game, "indexer did not create a Game row for GameCreated");
    assert.equal(game!.state, "WAITING_FOR_PLAYER");

    const joinHash = await player2Client.writeContract({
      address: GAME_MANAGER_ADDRESS,
      abi: gameManagerAbi,
      functionName: "joinGame",
      args: [game!.onChainGameId],
      chain: localChain,
    });
    await publicClient.waitForTransactionReceipt({ hash: joinHash });

    await pollUntil(async () => {
      const updated = await prisma.game.findUnique({ where: { id: game!.id } });
      return updated?.state === "CREATED" ? updated : null;
    });

    const startHash = await player1Client.writeContract({
      address: GAME_MANAGER_ADDRESS,
      abi: gameManagerAbi,
      functionName: "startGame",
      args: [game!.onChainGameId],
      chain: localChain,
    });
    await publicClient.waitForTransactionReceipt({ hash: startHash });

    // MockRandomnessProvider defers fulfillment to an explicit step (mirroring
    // a real VRF's separate callback transaction) - read back the pending
    // requestId and fulfill it so GameManager actually emits GameStarted.
    if (!RANDOMNESS_ADDRESS) throw new Error("LOCAL_RANDOMNESS_ADDRESS is required for this test");
    const onChainGame = (await publicClient.readContract({
      address: GAME_MANAGER_ADDRESS,
      abi: gameManagerAbi,
      functionName: "getGame",
      args: [game!.onChainGameId],
    })) as { randomnessRequestId: bigint };
    const fulfillHash = await player1Client.writeContract({
      address: RANDOMNESS_ADDRESS,
      abi: randomnessAbi,
      functionName: "fulfill",
      args: [onChainGame.randomnessRequestId],
      chain: localChain,
    });
    await publicClient.waitForTransactionReceipt({ hash: fulfillHash });

    const activeGame = await pollUntil(async () => {
      const updated = await prisma.game.findUnique({ where: { id: game!.id }, include: { players: true } });
      return updated?.state === "ACTIVE" ? updated : null;
    });
    assert.ok(activeGame, "indexer did not activate the game after GameStarted");
    assert.equal(activeGame!.players.length, 2);
    assert.ok(activeGame!.firstToMoveColor === "WHITE" || activeGame!.firstToMoveColor === "BLACK");

    const createdEvents = await prisma.contractEvent.findMany({ where: { transactionHash: createReceipt.transactionHash } });
    assert.ok(createdEvents.length > 0, "GameCreated should have been recorded in ContractEvent");
  } finally {
    unwatch();
    const games = await prisma.game.findMany({ where: { contractAddress: GAME_MANAGER_ADDRESS } });
    for (const g of games) {
      await prisma.contractEvent.deleteMany({ where: { gameId: g.id } });
      await prisma.gamePlayer.deleteMany({ where: { gameId: g.id } });
      await prisma.game.delete({ where: { id: g.id } });
    }
  }
});

async function pollUntil<T>(check: () => Promise<T | null>, timeoutMs = 10_000, intervalMs = 200): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}
