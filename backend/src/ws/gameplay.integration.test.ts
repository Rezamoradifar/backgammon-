import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket } from "ws";

import { prisma } from "../lib/prisma.js";
import { issueSessionToken } from "../auth/jwt.js";
import { createWsServer } from "./server.js";
import { gameRoomManager } from "./gameRoom.js";

function waitForMessage(socket: WebSocket, predicate: (msg: Record<string, unknown>) => boolean, timeoutMs = 3000) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
    const handler = (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        socket.off("message", handler);
        resolve(msg);
      }
    };
    socket.on("message", handler);
  });
}

test("two real WebSocket clients can roll and move through a full server-validated turn", async () => {
  // --- fixtures: two wallets, a game, two seated game-players ---
  const whiteUser = await prisma.user.create({ data: {} });
  const whiteWallet = await prisma.wallet.create({
    data: { address: "0x1111111111111111111111111111111111111111", chainId: 97, userId: whiteUser.id },
  });
  const blackUser = await prisma.user.create({ data: {} });
  const blackWallet = await prisma.wallet.create({
    data: { address: "0x2222222222222222222222222222222222222222", chainId: 97, userId: blackUser.id },
  });

  const game = await prisma.game.create({
    data: {
      onChainGameId: BigInt(Math.floor(Math.random() * 1_000_000_000)),
      contractAddress: "0x0000000000000000000000000000000000000000",
      chainId: 97,
      state: "ACTIVE",
    },
  });
  await prisma.gamePlayer.create({ data: { gameId: game.id, walletId: whiteWallet.id, color: "WHITE" } });
  await prisma.gamePlayer.create({ data: { gameId: game.id, walletId: blackWallet.id, color: "BLACK" } });

  gameRoomManager.createRoom({ gameId: game.id, whiteWalletId: whiteWallet.id, blackWalletId: blackWallet.id });

  // --- real HTTP + WS server on an ephemeral port ---
  const httpServer = createServer();
  createWsServer(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  if (typeof address !== "object" || address === null) throw new Error("no server address");
  const port = address.port;

  const whiteToken = issueSessionToken({ userId: whiteUser.id, walletId: whiteWallet.id, address: whiteWallet.address });
  const blackToken = issueSessionToken({ userId: blackUser.id, walletId: blackWallet.id, address: blackWallet.address });

  const whiteSocket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${whiteToken}`);
  const blackSocket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${blackToken}`);

  await Promise.all([
    new Promise((resolve) => whiteSocket.once("open", resolve)),
    new Promise((resolve) => blackSocket.once("open", resolve)),
  ]);

  try {
    whiteSocket.send(JSON.stringify({ type: "joinRoom", gameId: game.id }));
    blackSocket.send(JSON.stringify({ type: "joinRoom", gameId: game.id }));

    const whiteJoined = await waitForMessage(whiteSocket, (m) => m.type === "roomJoined");
    assert.equal(whiteJoined.color, "white");
    const blackJoined = await waitForMessage(blackSocket, (m) => m.type === "roomJoined");
    assert.equal(blackJoined.color, "black");

    // White rolls - server rolls dice itself and broadcasts to both.
    whiteSocket.send(JSON.stringify({ type: "roll", gameId: game.id }));
    const [whiteRolled, blackRolled] = await Promise.all([
      waitForMessage(whiteSocket, (m) => m.type === "rolled"),
      waitForMessage(blackSocket, (m) => m.type === "rolled"),
    ]);
    assert.deepEqual(whiteRolled.dice, blackRolled.dice);
    assert.equal(whiteRolled.turn, "white");

    // Black attempting to roll/move on white's turn must be rejected silently (no broadcast, no state change).
    blackSocket.send(JSON.stringify({ type: "roll", gameId: game.id }));

    const dice = whiteRolled.dice as number[];
    const die = dice[0];
    // White's checkers start on points 24, 13, 8, 6 - point 24 moving `die` pips is always a legal opening move.
    const move = { source: { type: "point", point: 24 }, die, to: 24 - die };

    whiteSocket.send(JSON.stringify({ type: "move", gameId: game.id, move }));
    const [whiteMoved, blackMoved] = await Promise.all([
      waitForMessage(whiteSocket, (m) => m.type === "moved"),
      waitForMessage(blackSocket, (m) => m.type === "moved"),
    ]);
    assert.deepEqual(whiteMoved.move, move);
    assert.deepEqual(blackMoved.move, move);

    const persistedRoll = await prisma.diceRoll.findFirst({ where: { gameId: game.id } });
    assert.ok(persistedRoll);
    assert.deepEqual(persistedRoll?.values, dice);

    const persistedMove = await prisma.move.findFirst({ where: { gameId: game.id } });
    assert.ok(persistedMove);
    assert.equal(persistedMove?.dieValue, die);

    // Confirm the earlier out-of-turn roll from black was rejected: it should have logged a
    // security event rather than mutating state or broadcasting a second "rolled" message.
    const securityEvents = await prisma.securityEvent.findMany({ where: { gameId: game.id, walletId: blackWallet.id } });
    assert.equal(securityEvents.length, 1);
    assert.equal(securityEvents[0].type, "UNAUTHORIZED_ACTION_ATTEMPT");
  } finally {
    whiteSocket.close();
    blackSocket.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await prisma.securityEvent.deleteMany({ where: { gameId: game.id } });
    await prisma.move.deleteMany({ where: { gameId: game.id } });
    await prisma.diceRoll.deleteMany({ where: { gameId: game.id } });
    await prisma.gamePlayer.deleteMany({ where: { gameId: game.id } });
    await prisma.game.delete({ where: { id: game.id } });
    await prisma.wallet.delete({ where: { id: whiteWallet.id } });
    await prisma.wallet.delete({ where: { id: blackWallet.id } });
    await prisma.user.delete({ where: { id: whiteUser.id } });
    await prisma.user.delete({ where: { id: blackUser.id } });
  }
});
