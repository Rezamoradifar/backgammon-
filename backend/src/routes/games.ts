import { Router } from "express";

import { prisma } from "../lib/prisma.js";

export const gamesRouter = Router();

/**
 * onChainGameId is only unique per contract (a redeployed GameManager
 * restarts its own numbering from 1), so every lookup/list here must be
 * scoped to the currently-configured contract - otherwise a stale game
 * left in an open/in-progress state on a superseded GameManager could leak
 * into the lobby, or a gameId collision could resolve to the wrong match.
 */
const CURRENT_GAME_MANAGER_ADDRESS = (process.env.GAME_MANAGER_ADDRESS ?? "").toLowerCase();

/**
 * Open tables - matches waiting for a second player to join, most recent
 * first. This is what powers the lobby's table list (browse and pick a
 * specific match to join, instead of blind auto-matchmaking) - anyone can
 * see these without authenticating, since nothing here is private.
 */
gamesRouter.get("/open", async (_req, res) => {
  const games = await prisma.game.findMany({
    where: { state: "WAITING_FOR_PLAYER", contractAddress: CURRENT_GAME_MANAGER_ADDRESS },
    orderBy: { createdAt: "desc" },
    include: { players: { include: { wallet: true } } },
    take: 100,
  });

  res.json(
    games.map((g) => ({
      gameId: g.onChainGameId.toString(),
      stake: g.stake.toString(),
      stakeToken: g.stakeToken,
      creator: g.players.find((p) => p.color === "WHITE")?.wallet.address ?? null,
      createdAt: g.createdAt,
    })),
  );
});

/**
 * Active/in-progress tables (seated but not yet started, or actually being
 * played) - shown as "live" for visibility, not joinable (already full).
 */
gamesRouter.get("/active", async (_req, res) => {
  const games = await prisma.game.findMany({
    where: { state: { in: ["CREATED", "ACTIVE", "AWAITING_RESULT"] }, contractAddress: CURRENT_GAME_MANAGER_ADDRESS },
    orderBy: { createdAt: "desc" },
    include: { players: { include: { wallet: true } } },
    take: 100,
  });

  res.json(
    games.map((g) => ({
      gameId: g.onChainGameId.toString(),
      state: g.state,
      stake: g.stake.toString(),
      stakeToken: g.stakeToken,
      players: g.players.map((p) => ({ address: p.wallet.address, color: p.color })),
      startedAt: g.startedAt,
    })),
  );
});

/** Game history for a wallet - completed matches, most recent first. */
gamesRouter.get("/history/:address", async (req, res) => {
  // Lowercased - Wallet rows are keyed by lowercase address everywhere (see
  // gameManagerIndexer.ts and auth.ts), since Postgres string equality is
  // case-sensitive and callers may pass a checksummed address.
  const wallet = await prisma.wallet.findUnique({ where: { address: req.params.address.toLowerCase() } });
  if (!wallet) {
    res.json([]);
    return;
  }

  const games = await prisma.game.findMany({
    where: { players: { some: { walletId: wallet.id } }, state: { in: ["COMPLETED", "CANCELLED"] } },
    orderBy: { completedAt: "desc" },
    include: { players: { include: { wallet: true } }, result: { include: { winner: true } } },
    take: 50,
  });

  res.json(
    games.map((g) => ({
      gameId: g.onChainGameId.toString(),
      state: g.state,
      stake: g.stake.toString(),
      stakeToken: g.stakeToken,
      players: g.players.map((p) => ({ address: p.wallet.address, color: p.color })),
      // The winner's address - previously returned winnerId (a Wallet uuid),
      // which the frontend compared against player addresses and could
      // never match, so every game silently displayed as a loss.
      winner: g.result?.winner.address ?? null,
      completedAt: g.completedAt,
    })),
  );
});

/**
 * Resolves an on-chain gameId to this backend's internal Game row - the
 * frontend knows the on-chain id (it's what createGame()'s transaction
 * ultimately produces) but the WebSocket gameplay room is keyed by the
 * internal id, so the client needs this lookup before it can `joinRoom`.
 * 404s (not an empty 200) until the indexer has actually seen GameCreated -
 * the frontend polls this while waiting.
 */
gamesRouter.get("/lookup/:onChainGameId", async (req, res) => {
  let onChainGameId: bigint;
  try {
    onChainGameId = BigInt(req.params.onChainGameId);
  } catch {
    res.status(400).json({ error: "Invalid onChainGameId" });
    return;
  }

  const game = await prisma.game.findUnique({
    where: { contractAddress_onChainGameId: { contractAddress: CURRENT_GAME_MANAGER_ADDRESS, onChainGameId } },
    include: { players: { include: { wallet: true } } },
  });
  if (!game) {
    res.status(404).json({ error: "Game not indexed yet" });
    return;
  }

  res.json({
    id: game.id,
    state: game.state,
    players: game.players.map((p) => ({ address: p.wallet.address, color: p.color })),
  });
});

/** Full move-by-move transcript for a single game - the detail the chain deliberately doesn't store. */
gamesRouter.get("/:onChainGameId/moves", async (req, res) => {
  const onChainGameId = BigInt(req.params.onChainGameId);
  const game = await prisma.game.findUnique({
    where: { contractAddress_onChainGameId: { contractAddress: CURRENT_GAME_MANAGER_ADDRESS, onChainGameId } },
  });
  if (!game) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  const [moves, diceRolls] = await Promise.all([
    prisma.move.findMany({ where: { gameId: game.id }, orderBy: [{ turnNumber: "asc" }, { sequenceInTurn: "asc" }] }),
    prisma.diceRoll.findMany({ where: { gameId: game.id }, orderBy: { turnNumber: "asc" } }),
  ]);

  res.json({ moves, diceRolls });
});
