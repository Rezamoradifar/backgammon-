import { createPublicClient, http, type Address, type Chain } from "viem";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { prisma } from "../lib/prisma.js";
import { gameRoomManager } from "../ws/gameRoom.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gameManagerAbi = JSON.parse(readFileSync(join(__dirname, "abi/GameManager.json"), "utf8"));

interface IndexerConfig {
  rpcUrl: string;
  chain: Chain;
  gameManagerAddress: Address;
}

/**
 * Watches GameManager's events and mirrors them into Postgres. The chain
 * remains the source of truth (see ARCHITECTURE.md) - this never writes
 * back on-chain, it only reads and caches for fast queries (game history,
 * leaderboard) and to activate the live WebSocket game room the moment a
 * match actually goes ACTIVE on-chain.
 *
 * Idempotent by design: every event is first recorded in ContractEvent
 * keyed by (transactionHash, logIndex) - a unique-constraint violation on a
 * replayed event (e.g. after a reconnect) is treated as "already processed"
 * and skipped, not an error.
 */
export function startGameManagerIndexer(config: IndexerConfig) {
  const publicClient = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });

  const unwatch = publicClient.watchContractEvent({
    address: config.gameManagerAddress,
    abi: gameManagerAbi,
    onLogs: (logs) => {
      for (const log of logs) {
        void handleLog(config, log as unknown as DecodedLog);
      }
    },
  });

  return unwatch;
}

interface DecodedLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
}

async function handleLog(config: IndexerConfig, log: DecodedLog): Promise<void> {
  try {
    await prisma.contractEvent.create({
      data: {
        contractAddress: config.gameManagerAddress,
        chainId: config.chain.id,
        eventName: log.eventName,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        args: JSON.parse(JSON.stringify(log.args, (_key, value) => (typeof value === "bigint" ? value.toString() : value))),
      },
    });
  } catch (err) {
    // Unique constraint on (transactionHash, logIndex) - already processed this exact log, e.g. after a reconnect replay.
    if (isUniqueConstraintError(err)) return;
    throw err;
  }

  switch (log.eventName) {
    case "GameCreated":
      await onGameCreated(config, log);
      break;
    case "GameJoined":
      await onGameJoined(log);
      break;
    case "GameStarted":
      await onGameStarted(log);
      break;
    case "ResultConfirmed":
    case "ResultFinalizedByTimeout":
      await onGameCompleted(log);
      break;
    case "DisputeResolved":
      await onGameCompleted(log);
      break;
    case "GameForfeited":
      await onGameForfeited(log);
      break;
    case "GameCancelled":
      await onGameCancelled(log);
      break;
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002";
}

async function findOrThrow(onChainGameId: bigint) {
  const game = await prisma.game.findUnique({ where: { onChainGameId } });
  if (!game) throw new Error(`Game not found for onChainGameId=${onChainGameId}`);
  return game;
}

async function onGameCreated(config: IndexerConfig, log: DecodedLog): Promise<void> {
  const gameId = log.args.gameId as bigint;
  const creator = (log.args.creator as string).toLowerCase();

  const game = await prisma.game.create({
    data: {
      onChainGameId: gameId,
      contractAddress: config.gameManagerAddress,
      chainId: config.chain.id,
      state: "WAITING_FOR_PLAYER",
    },
  });

  const wallet = await findOrCreateWallet(creator, config.chain.id);
  // Convention: player1 (the creator) is always seated WHITE, player2 (the joiner) BLACK.
  await prisma.gamePlayer.create({ data: { gameId: game.id, walletId: wallet.id, color: "WHITE" } });
}

async function onGameJoined(log: DecodedLog): Promise<void> {
  const gameId = log.args.gameId as bigint;
  const opponent = (log.args.opponent as string).toLowerCase();

  const game = await findOrThrow(gameId);
  const wallet = await findOrCreateWallet(opponent, game.chainId);
  await prisma.gamePlayer.create({ data: { gameId: game.id, walletId: wallet.id, color: "BLACK" } });
  await prisma.game.update({ where: { id: game.id }, data: { state: "CREATED" } });
}

async function onGameStarted(log: DecodedLog): Promise<void> {
  const gameId = log.args.gameId as bigint;
  const firstToMove = (log.args.firstToMove as string).toLowerCase();

  const game = await findOrThrow(gameId);
  const players = await prisma.gamePlayer.findMany({ where: { gameId: game.id }, include: { wallet: true } });
  const firstMoverColor = players.find((p) => p.wallet.address.toLowerCase() === firstToMove)?.color ?? "WHITE";

  await prisma.game.update({
    where: { id: game.id },
    data: { state: "ACTIVE", startedAt: new Date(), firstToMoveColor: firstMoverColor },
  });

  const white = players.find((p) => p.color === "WHITE");
  const black = players.find((p) => p.color === "BLACK");
  if (white && black) {
    gameRoomManager.createRoom({ gameId: game.id, whiteWalletId: white.walletId, blackWalletId: black.walletId });
  }
}

async function onGameCompleted(log: DecodedLog): Promise<void> {
  const gameId = log.args.gameId as bigint;
  const game = await findOrThrow(gameId);

  // The chain's Game struct (getGame) has claimedWinner - but this indexer only
  // sees the event args, which don't all carry the winner directly for every
  // completion path. Reading the winner is done via the players' recorded
  // GamePlayer color + the room's final in-memory state, matching how the
  // WebSocket layer already knows who won when `gameOver` fires.
  const state = gameRoomManager.getRoomState(game.id);
  if (!state?.winner) return; // no off-chain record of the winner yet - nothing to reconcile

  const players = await prisma.gamePlayer.findMany({ where: { gameId: game.id } });
  const winner = players.find((p) => p.color.toLowerCase() === state.winner);
  const loser = players.find((p) => p.color.toLowerCase() !== state.winner);
  if (!winner || !loser) return;

  await finalizeGame(game.id, winner.walletId, loser.walletId, log.eventName === "DisputeResolved" ? "ARBITER" : log.eventName === "ResultFinalizedByTimeout" ? "TIMEOUT" : "CONFIRMED", log.transactionHash);
}

async function onGameForfeited(log: DecodedLog): Promise<void> {
  const gameId = log.args.gameId as bigint;
  const winnerAddress = (log.args.winner as string).toLowerCase();
  const game = await findOrThrow(gameId);

  const players = await prisma.gamePlayer.findMany({ where: { gameId: game.id }, include: { wallet: true } });
  const winner = players.find((p) => p.wallet.address.toLowerCase() === winnerAddress);
  const loser = players.find((p) => p.wallet.address.toLowerCase() !== winnerAddress);
  if (!winner || !loser) return;

  await finalizeGame(game.id, winner.walletId, loser.walletId, "CONFIRMED", log.transactionHash);
}

async function finalizeGame(
  gameId: string,
  winnerWalletId: string,
  loserWalletId: string,
  source: "CONFIRMED" | "TIMEOUT" | "ARBITER",
  txHash: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.game.update({ where: { id: gameId }, data: { state: "COMPLETED", completedAt: new Date() } });
    await tx.gameResult.create({ data: { gameId, winnerId: winnerWalletId, loserId: loserWalletId, source, txHash } });

    const winnerEntry = await tx.leaderboardEntry.upsert({
      where: { walletId: winnerWalletId },
      update: {},
      create: { walletId: winnerWalletId },
    });
    const nextStreak = winnerEntry.currentStreak + 1;
    await tx.leaderboardEntry.update({
      where: { walletId: winnerWalletId },
      data: {
        wins: { increment: 1 },
        gamesPlayed: { increment: 1 },
        currentStreak: nextStreak,
        bestStreak: Math.max(winnerEntry.bestStreak, nextStreak),
      },
    });

    await tx.leaderboardEntry.upsert({
      where: { walletId: loserWalletId },
      update: {},
      create: { walletId: loserWalletId },
    });
    await tx.leaderboardEntry.update({
      where: { walletId: loserWalletId },
      data: { losses: { increment: 1 }, gamesPlayed: { increment: 1 }, currentStreak: 0 },
    });
  });
}

async function onGameCancelled(log: DecodedLog): Promise<void> {
  const gameId = log.args.gameId as bigint;
  const game = await findOrThrow(gameId);
  await prisma.game.update({ where: { id: game.id }, data: { state: "CANCELLED" } });
}

async function findOrCreateWallet(address: string, chainId: number) {
  return prisma.wallet.upsert({
    where: { address },
    update: {},
    create: { address, chainId, user: { create: {} } },
  });
}
