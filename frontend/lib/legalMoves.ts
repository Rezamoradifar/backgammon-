// A client-side copy of just the legal-move calculation (not the full rules
// engine - the frontend never mutates state itself, see
// lib/backgammonTypes.ts's header comment). This exists purely so the board
// can highlight legal destinations instantly, without waiting on a
// round-trip; the server (backend/src/engine/engine.ts) is what actually
// validates and applies every move - if the two ever disagreed, the server
// wins, and an illegal client-side guess is simply rejected (see
// backend/src/ws/gameRoom.ts's SecurityEvent logging for that path).

import type { GameState, Move, Player } from "./backgammonTypes";

const HOME_RANGE: Record<Player, [number, number]> = {
  white: [1, 6],
  black: [19, 24],
};

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
