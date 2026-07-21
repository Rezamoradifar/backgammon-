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
  turnTimer: ReturnType<typeof setTimeout> | null;
  turnDeadline: number | null;
  /** The very first turn's clock only starts once both players have
   * actually connected - otherwise it could burn down while a player's
   * frontend is still polling its way from ACTIVE to opening the WS room. */
  firstTurnClockStarted: boolean;
}

/** How long a player has to roll (or, once rolled, to play out their dice)
 * before the server acts on their behalf - keeps a stalled or disconnected
 * player from freezing the match indefinitely, and keeps matches (and so
 * the pool of concurrently-playable tables) moving. Gameplay is entirely
 * off-chain (see ARCHITECTURE.md), so this needs no contract change - the
 * server already has full authority over turn state. */
const TURN_TIMEOUT_MS = 60_000;

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
    const room: Room = {
      gameId: params.gameId,
      state: createInitialState(),
      turnNumber: 0,
      seats: {
        white: { walletId: params.whiteWalletId, color: "white", socket: null },
        black: { walletId: params.blackWalletId, color: "black", socket: null },
      },
      turnTimer: null,
      turnDeadline: null,
      firstTurnClockStarted: false,
    };
    this.rooms.set(params.gameId, room);
  }

  private armTurnTimer(room: Room): void {
    this.clearTurnTimer(room);
    room.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
    room.turnTimer = setTimeout(() => {
      void this.handleTurnTimeout(room.gameId);
    }, TURN_TIMEOUT_MS);
  }

  private clearTurnTimer(room: Room): void {
    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.turnTimer = null;
    room.turnDeadline = null;
  }

  /** Fires once a player's turn clock runs out - rolls for them if they
   * hadn't yet, otherwise plays their first available legal move (repeated
   * calls, one per remaining die, drive the rest of a stalled turn to
   * completion at the same 60s pace as an actively-attentive player). */
  private async handleTurnTimeout(gameId: string): Promise<void> {
    const room = this.rooms.get(gameId);
    if (!room || room.state.winner) return;
    const seat = room.seats[room.state.turn];

    if (!room.state.hasRolled) {
      await this.handleRoll(gameId, seat.walletId);
      return;
    }

    const legalMoves = getLegalMoves(room.state, room.state.turn);
    if (legalMoves.length > 0) {
      await this.handleMove(gameId, seat.walletId, legalMoves[0]);
    }
  }

  attachSocket(gameId: string, walletId: string, socket: WebSocket): Player | null {
    const room = this.rooms.get(gameId);
    if (!room) return null;
    const seat = Object.values(room.seats).find((s) => s.walletId === walletId);
    if (!seat) return null;
    seat.socket = socket;

    const bothConnected = Object.values(room.seats).every((s) => s.socket?.readyState === s.socket?.OPEN);
    if (bothConnected && !room.firstTurnClockStarted && !room.state.winner) {
      room.firstTurnClockStarted = true;
      this.armTurnTimer(room);
      this.broadcast(room, { type: "turnDeadline", turnDeadline: room.turnDeadline });
    }

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

    if (hasAnyLegalMove(room.state, room.state.turn)) {
      this.armTurnTimer(room); // clock for playing out this roll
    }
    this.broadcast(room, { type: "rolled", turn: room.state.turn, dice, turnNumber: room.turnNumber, turnDeadline: room.turnDeadline });

    if (!hasAnyLegalMove(room.state, room.state.turn)) {
      this.broadcast(room, { type: "noLegalMoves", turn: room.state.turn });
      room.state = endTurn(room.state);
      this.armTurnTimer(room); // clock for the next player's roll
      this.broadcast(room, { type: "turnEnded", turn: room.state.turn, turnDeadline: room.turnDeadline });
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

    if (room.state.winner) {
      this.clearTurnTimer(room);
      this.broadcast(room, { type: "moved", move, wasHit: isHit, state: this.publicState(room.state) });
      this.broadcast(room, { type: "gameOver", winner: room.state.winner });
      return;
    }

    if (room.state.dice.length === 0) {
      room.state = endTurn(room.state);
      this.armTurnTimer(room); // next player's roll
      this.broadcast(room, { type: "moved", move, wasHit: isHit, state: this.publicState(room.state) });
      this.broadcast(room, { type: "turnEnded", turn: room.state.turn, turnDeadline: room.turnDeadline });
    } else if (!hasAnyLegalMove(room.state, room.state.turn)) {
      this.broadcast(room, { type: "moved", move, wasHit: isHit, state: this.publicState(room.state) });
      this.broadcast(room, { type: "noLegalMoves", turn: room.state.turn });
      room.state = endTurn(room.state);
      this.armTurnTimer(room); // next player's roll
      this.broadcast(room, { type: "turnEnded", turn: room.state.turn, turnDeadline: room.turnDeadline });
    } else {
      this.armTurnTimer(room); // reset the clock - still this player's turn, dice remain
      this.broadcast(room, { type: "moved", move, wasHit: isHit, state: this.publicState(room.state), turnDeadline: room.turnDeadline });
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

  getTurnDeadline(gameId: string): number | null {
    return this.rooms.get(gameId)?.turnDeadline ?? null;
  }

  /** Stops a room's turn clock without otherwise touching it - state stays
   * readable (the indexer reads it well after a match's real gameOver, to
   * reconcile the on-chain settlement event whenever it arrives), this
   * only clears the pending timer handle. Exists for tests that create a
   * short-lived room and need to not leave a 60s timer running past the
   * test itself; production rooms simply let the timer clear itself via
   * clearTurnTimer's normal call sites. */
  stopTurnClock(gameId: string): void {
    const room = this.rooms.get(gameId);
    if (room) this.clearTurnTimer(room);
  }
}

export const gameRoomManager = new GameRoomManager();
