import { Router } from "express";

import { prisma } from "../lib/prisma.js";

export const gamesRouter = Router();

/** Game history for a wallet - completed matches, most recent first. */
gamesRouter.get("/history/:address", async (req, res) => {
  const wallet = await prisma.wallet.findUnique({ where: { address: req.params.address } });
  if (!wallet) {
    res.json([]);
    return;
  }

  const games = await prisma.game.findMany({
    where: { players: { some: { walletId: wallet.id } }, state: { in: ["COMPLETED", "CANCELLED"] } },
    orderBy: { completedAt: "desc" },
    include: { players: { include: { wallet: true } }, result: true },
    take: 50,
  });

  res.json(
    games.map((g) => ({
      gameId: g.onChainGameId.toString(),
      state: g.state,
      players: g.players.map((p) => ({ address: p.wallet.address, color: p.color })),
      winner: g.result?.winnerId ?? null,
      completedAt: g.completedAt,
    })),
  );
});

/** Full move-by-move transcript for a single game - the detail the chain deliberately doesn't store. */
gamesRouter.get("/:onChainGameId/moves", async (req, res) => {
  const onChainGameId = BigInt(req.params.onChainGameId);
  const game = await prisma.game.findUnique({ where: { onChainGameId } });
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
