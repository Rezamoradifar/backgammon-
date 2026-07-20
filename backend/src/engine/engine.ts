// Ported from the free client-side game (dravon's lib/backgammon/engine.ts).
// Both clients and this backend run the identical rules engine, so the
// backend can validate a submitted move without trusting either player's
// own implementation.

import type { GameState, Move, Player, PointState } from "./types.js";

export const HOME_RANGE: Record<Player, [number, number]> = {
  white: [1, 6],
  black: [19, 24],
};

export function opponent(player: Player): Player {
  return player === "white" ? "black" : "white";
}

function idx(point: number): number {
  return point - 1;
}

function distanceToBearOff(player: Player, point: number): number {
  return player === "white" ? point : 25 - point;
}

function targetPoint(player: Player, point: number, die: number): number {
  return player === "white" ? point - die : point + die;
}

function barEntryPoint(player: Player, die: number): number {
  return player === "white" ? 25 - die : die;
}

export function createInitialState(): GameState {
  const points: PointState[] = Array.from({ length: 24 }, () => ({ owner: null, count: 0 }));

  const place = (point: number, owner: Player, count: number) => {
    points[idx(point)] = { owner, count };
  };

  place(24, "white", 2);
  place(13, "white", 5);
  place(8, "white", 3);
  place(6, "white", 5);

  place(1, "black", 2);
  place(12, "black", 5);
  place(17, "black", 3);
  place(19, "black", 5);

  return {
    points,
    bar: { white: 0, black: 0 },
    borneOff: { white: 0, black: 0 },
    turn: "white",
    dice: [],
    hasRolled: false,
    winner: null,
    lastRoll: [],
  };
}

function isOpenFor(state: GameState, player: Player, point: number): boolean {
  if (point < 1 || point > 24) return false;
  const p = state.points[idx(point)];
  return p.owner === null || p.owner === player || p.count <= 1;
}

function isAllCheckersHome(state: GameState, player: Player): boolean {
  if (state.bar[player] > 0) return false;
  const [start, end] = HOME_RANGE[player];
  for (let point = 1; point <= 24; point++) {
    if (point >= start && point <= end) continue;
    const p = state.points[idx(point)];
    if (p.owner === player && p.count > 0) return false;
  }
  return true;
}

/** All legal moves for `player` using one of the currently-available dice values. */
export function getLegalMoves(state: GameState, player: Player): Move[] {
  if (state.winner) return [];
  const dieValues = Array.from(new Set(state.dice));
  const moves: Move[] = [];

  if (state.bar[player] > 0) {
    for (const die of dieValues) {
      const to = barEntryPoint(player, die);
      if (isOpenFor(state, player, to)) {
        moves.push({ source: { type: "bar" }, die, to });
      }
    }
    return moves;
  }

  const allHome = isAllCheckersHome(state, player);

  for (let point = 1; point <= 24; point++) {
    const p = state.points[idx(point)];
    if (p.owner !== player || p.count === 0) continue;

    for (const die of dieValues) {
      const to = targetPoint(player, point, die);
      const isOff = player === "white" ? to < 1 : to > 24;

      if (isOff) {
        if (!allHome) continue;
        const distance = distanceToBearOff(player, point);
        if (die === distance) {
          moves.push({ source: { type: "point", point }, die, to: null });
        } else if (die > distance) {
          const [start, end] = HOME_RANGE[player];
          const hasFartherChecker = (() => {
            for (let q = start; q <= end; q++) {
              const farther = player === "white" ? q > point : q < point;
              if (!farther) continue;
              const qp = state.points[idx(q)];
              if (qp.owner === player && qp.count > 0) return true;
            }
            return false;
          })();
          if (!hasFartherChecker) {
            moves.push({ source: { type: "point", point }, die, to: null });
          }
        }
        continue;
      }

      if (isOpenFor(state, player, to)) {
        moves.push({ source: { type: "point", point }, die, to });
      }
    }
  }

  return moves;
}

export function hasAnyLegalMove(state: GameState, player: Player): boolean {
  return getLegalMoves(state, player).length > 0;
}

function cloneState(state: GameState): GameState {
  return {
    points: state.points.map((p) => ({ ...p })),
    bar: { ...state.bar },
    borneOff: { ...state.borneOff },
    turn: state.turn,
    dice: [...state.dice],
    hasRolled: state.hasRolled,
    winner: state.winner,
    lastRoll: [...state.lastRoll],
  };
}

/** Applies a single die's move. Consumes exactly one matching die value from state.dice. */
export function applyMove(state: GameState, move: Move): GameState {
  const next = cloneState(state);
  const player = next.turn;

  const dieIndex = next.dice.indexOf(move.die);
  if (dieIndex === -1) return state;
  next.dice.splice(dieIndex, 1);

  if (move.source.type === "bar") {
    next.bar[player] -= 1;
  } else {
    const from = next.points[idx(move.source.point)];
    from.count -= 1;
    if (from.count === 0) from.owner = null;
  }

  if (move.to === null) {
    next.borneOff[player] += 1;
  } else {
    const dest = next.points[idx(move.to)];
    if (dest.owner !== null && dest.owner !== player) {
      next.bar[dest.owner] += 1;
      dest.owner = player;
      dest.count = 1;
    } else {
      dest.owner = player;
      dest.count += 1;
    }
  }

  if (next.borneOff[player] === 15) {
    next.winner = player;
  }

  return next;
}

export function startTurn(state: GameState, dice: number[]): GameState {
  const next = cloneState(state);
  next.dice = dice;
  next.lastRoll = [...dice];
  next.hasRolled = true;
  return next;
}

export function endTurn(state: GameState): GameState {
  const next = cloneState(state);
  next.turn = opponent(next.turn);
  next.dice = [];
  next.hasRolled = false;
  return next;
}

/** Is `move` one of the currently legal moves for the state's active player? Used to validate a client-submitted move before applying it server-side. */
export function isLegalMove(state: GameState, move: Move): boolean {
  const legal = getLegalMoves(state, state.turn);
  return legal.some(
    (m) =>
      m.die === move.die &&
      m.to === move.to &&
      m.source.type === move.source.type &&
      (m.source.type === "point" && move.source.type === "point" ? m.source.point === move.source.point : true),
  );
}
