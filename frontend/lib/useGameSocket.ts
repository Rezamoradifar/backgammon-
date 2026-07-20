"use client";

import * as React from "react";

import { WS_BASE_URL } from "./api";
import type { GameState, Move } from "./backgammonTypes";

export type ServerMessage =
  | { type: "matched"; opponentAddress: string; opponentWalletId: string; amICreator: boolean; stake: string }
  | { type: "gameCreated"; onChainGameId: string }
  | { type: "roomJoined"; gameId: string; color: "white" | "black" | null; state: GameState | null }
  | { type: "rolled"; turn: "white" | "black"; dice: number[]; turnNumber: number }
  | { type: "moved"; move: Move; wasHit: boolean; state: GameState }
  | { type: "noLegalMoves"; turn: "white" | "black" }
  | { type: "turnEnded"; turn: "white" | "black" }
  | { type: "gameOver"; winner: "white" | "black" };

type ClientMessage =
  | { type: "queue"; stake: string }
  | { type: "cancelQueue" }
  | { type: "gameCreated"; onChainGameId: string }
  | { type: "joinRoom"; gameId: string }
  | { type: "roll"; gameId: string }
  | { type: "move"; gameId: string; move: unknown };

type Listener = (message: ServerMessage) => void;

/**
 * A single persistent WebSocket connection for the authenticated session,
 * shared for both matchmaking and live gameplay (they're the same socket -
 * see backend/src/ws/server.ts's message router).
 *
 * Consumers subscribe with `onMessage` and update their own state directly
 * from within that callback, since it fires from the socket's own message
 * event rather than from a React render/effect cycle.
 */
export function useGameSocket(token: string | null) {
  const socketRef = React.useRef<WebSocket | null>(null);
  const listenersRef = React.useRef<Set<Listener>>(new Set());
  const [isOpen, setIsOpen] = React.useState(false);

  React.useEffect(() => {
    if (!token) return;

    const socket = new WebSocket(`${WS_BASE_URL}/ws?token=${encodeURIComponent(token)}`);
    socketRef.current = socket;

    socket.onopen = () => setIsOpen(true);
    socket.onclose = () => setIsOpen(false);
    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      for (const listener of listenersRef.current) listener(message);
    };

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [token]);

  const onMessage = React.useCallback((listener: Listener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const send = React.useCallback((message: ClientMessage) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(message));
    }
  }, []);

  return { isOpen, onMessage, send };
}
