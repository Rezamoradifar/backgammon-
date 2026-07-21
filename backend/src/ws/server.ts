import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";

import { verifySessionToken } from "../auth/jwt.js";
import { matchmaker } from "./matchmaker.js";
import { gameRoomManager } from "./gameRoom.js";

const clientMessageSchema = z.union([
  z.object({ type: z.literal("queue"), stake: z.string().optional() }),
  z.object({ type: z.literal("cancelQueue") }),
  z.object({ type: z.literal("gameCreated"), onChainGameId: z.string() }),
  z.object({ type: z.literal("joinRoom"), gameId: z.string() }),
  z.object({
    type: z.literal("roll"),
    gameId: z.string(),
  }),
  z.object({
    type: z.literal("move"),
    gameId: z.string(),
    move: z.object({
      source: z.union([z.object({ type: z.literal("bar") }), z.object({ type: z.literal("point"), point: z.number() })]),
      die: z.number(),
      to: z.number().nullable(),
    }),
  }),
]);

function extractToken(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? "", "http://localhost");
  return url.searchParams.get("token");
}

export function createWsServer(server: import("node:http").Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
    const token = extractToken(req);
    if (!token) {
      socket.close(4001, "Missing auth token");
      return;
    }

    let claims;
    try {
      claims = verifySessionToken(token);
    } catch {
      socket.close(4001, "Invalid or expired auth token");
      return;
    }

    const { walletId, address } = claims;

    socket.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const result = clientMessageSchema.safeParse(parsed);
      if (!result.success) return;
      const message = result.data;

      switch (message.type) {
        case "queue":
          matchmaker.enqueue({ walletId, address, socket, stake: message.stake ?? "0" });
          break;
        case "cancelQueue":
          matchmaker.dequeue(walletId);
          break;
        case "gameCreated": {
          const opponent = matchmaker.getPairedOpponent(walletId);
          if (opponent && opponent.socket.readyState === opponent.socket.OPEN) {
            opponent.socket.send(JSON.stringify({ type: "gameCreated", onChainGameId: message.onChainGameId }));
          }
          matchmaker.clearPair(walletId);
          break;
        }
        case "joinRoom": {
          const color = gameRoomManager.attachSocket(message.gameId, walletId, socket);
          const state = gameRoomManager.getRoomState(message.gameId);
          const turnDeadline = gameRoomManager.getTurnDeadline(message.gameId);
          socket.send(JSON.stringify({ type: "roomJoined", gameId: message.gameId, color, state: state ?? null, turnDeadline }));
          break;
        }
        case "roll":
          void gameRoomManager.handleRoll(message.gameId, walletId);
          break;
        case "move":
          void gameRoomManager.handleMove(message.gameId, walletId, message.move);
          break;
      }
    });

    socket.on("close", () => {
      matchmaker.dequeue(walletId);
    });
  });

  return wss;
}
