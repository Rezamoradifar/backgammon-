import type { WebSocket } from "ws";

import { prisma } from "../lib/prisma.js";
import { applyMove, createInitialState, endTurn, getLegalMoves, hasAnyLegalMove, isLegalMove, startTurn } from "../engine/engine.js";
import { rollDice } from "../engine/dice.js";
import type { GameState, Move, Player } from "../engine/types.js";

interface Seat {
  walletId: string;
  color: Player;
  socket: WebSocket | null;
}

interface Room {
  gameId: string; // internal Game.id (uuid), not the on-chain gameId
  state: GameState;
  turnNumber: number;
  seats: Record<Player, Seat>;
}

/**
 * Live, server-authoritative game state for matches currently in progress.
 * The chain never sees per-move traffic (see ARCHITECTURE.md); this is
 * where actual turn-by-turn play - and its validation - happens. State is
 * in-memory only, keyed by the internal Game row id; Move/DiceRoll rows are
 * the durable record.
 */
class GameRoomManager {
  private rooms = new Map<string, Room>();

  createRoom(params: { gameId: string; whiteWalletId: string; blackWalletId: string }): void {
    this.rooms.set(params.gameId, {
      gameId: params.gameId,
      state: createInitialState(),
      turnNumber: 0,
      seats: {
        white: { walletId: params.whiteWalletId, color: "white", socket: null },
        black: { walletId: params.blackWalletId, color: "black", socket: null },
      },
    });
  }

  attachSocket(gameId: string, walletId: string, socket: WebSocket): Player | null {
    const room = this.rooms.get(gameId);
    if (!room) return null;
    const seat = Object.values(room.seats).find((s) => s.walletId === walletId);
    if (!seat) return null;
    seat.socket = socket;
    return seat.color;
  }

  private seatFor(room: Room, walletId: string): Seat | undefined {
    return Object.values(room.seats).find((s) => s.walletId === walletId);
  }

  private broadcast(room: Room, message: object): void {
    const payload = JSON.stringify(message);
    for (const seat of Object.values(room.seats)) {
      if (seat.socket?.readyState === seat.socket?.OPEN) {
        seat.socket?.send(payload);
      }
    }
  }

  private async recordSecurityEvent(params: {
    walletId: string;
    gameId: string;
    type: "INVALID_MOVE_ATTEMPT" | "UNAUTHORIZED_ACTION_ATTEMPT";
    details: object;
  }): Promise<void> {
    await prisma.securityEvent.create({
      data: {
        walletId: params.walletId,
        gameId: params.gameId,
        type: params.type,
        severity: "LOW",
        details: params.details,
      },
    });
  }

  async handleRoll(gameId: string, walletId: string): Promise<void> {
    const room = this.rooms.get(gameId);
    if (!room) return;
    const seat = this.seatFor(room, walletId);
    if (!seat) return;

    if (room.state.turn !== seat.color || room.state.hasRolled || room.state.winner) {
      await this.recordSecurityEvent({
        walletId,
        gameId,
        type: "UNAUTHORIZED_ACTION_ATTEMPT",
        details: { action: "roll", turn: room.state.turn, hasRolled: room.state.hasRolled },
      });
      return;
    }

    const dice = rollDice();
    room.state = startTurn(room.state, dice);
    room.turnNumber += 1;

    await prisma.diceRoll.create({
      data: {
        gameId: room.gameId,
        playerId: (await this.gamePlayerRow(room.gameId, walletId))!.id,
        walletId,
        turnNumber: room.turnNumber,
        values: dice,
      },
    });

    this.broadcast(room, { type: "rolled", turn: room.state.turn, dice, turnNumber: room.turnNumber });

    if (!hasAnyLegalMove(room.state, room.state.turn)) {
      this.broadcast(room, { type: "noLegalMoves", turn: room.state.turn });
      room.state = endTurn(room.state);
      this.broadcast(room, { type: "turnEnded", turn: room.state.turn });
    }
  }

  async handleMove(gameId: string, walletId: string, move: Move): Promise<void> {
    const room = this.rooms.get(gameId);
    if (!room) return;
    const seat = this.seatFor(room, walletId);
    if (!seat) return;

    if (room.state.turn !== seat.color || !room.state.hasRolled || room.state.winner) {
      await this.recordSecurityEvent({
        walletId,
        gameId,
        type: "UNAUTHORIZED_ACTION_ATTEMPT",
        details: { action: "move", turn: room.state.turn, hasRolled: room.state.hasRolled, move },
      });
      return;
    }

    if (!isLegalMove(room.state, move)) {
      await this.recordSecurityEvent({
        walletId,
        gameId,
        type: "INVALID_MOVE_ATTEMPT",
        details: { move, legalMoves: getLegalMoves(room.state, room.state.turn) },
      });
      return;
    }

    const isHit =
      move.to !== null &&
      (() => {
        const dest = room.state.points[move.to! - 1];
        return dest.owner !== null && dest.owner !== room.state.turn && dest.count === 1;
      })();

    const player = await this.gamePlayerRow(room.gameId, walletId);
    const sequenceInTurn = await prisma.move.count({ where: { gameId: room.gameId, turnNumber: room.turnNumber } });

    room.state = applyMove(room.state, move);

    await prisma.move.create({
      data: {
        gameId: room.gameId,
        playerId: player!.id,
        walletId,
        turnNumber: room.turnNumber,
        sequenceInTurn,
        dieValue: move.die,
        fromPoint: move.source.type === "point" ? move.source.point : null,
        toPoint: move.to,
        wasHit: isHit,
      },
    });

    this.broadcast(room, { type: "moved", move, wasHit: isHit, state: this.publicState(room.state) });

    if (room.state.winner) {
      this.broadcast(room, { type: "gameOver", winner: room.state.winner });
      return;
    }

    if (room.state.dice.length === 0) {
      room.state = endTurn(room.state);
      this.broadcast(room, { type: "turnEnded", turn: room.state.turn });
    } else if (!hasAnyLegalMove(room.state, room.state.turn)) {
      this.broadcast(room, { type: "noLegalMoves", turn: room.state.turn });
      room.state = endTurn(room.state);
      this.broadcast(room, { type: "turnEnded", turn: room.state.turn });
    }
  }

  private async gamePlayerRow(gameId: string, walletId: string) {
    return prisma.gamePlayer.findUnique({ where: { gameId_walletId: { gameId, walletId } } });
  }

  /** Strip nothing for now - both players see full board state, matching standard backgammon (no hidden information). */
  private publicState(state: GameState) {
    return state;
  }

  getRoomState(gameId: string): GameState | undefined {
    return this.rooms.get(gameId)?.state;
  }
}

export const gameRoomManager = new GameRoomManager();
