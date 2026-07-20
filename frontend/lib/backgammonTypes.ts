// Mirrors backend/src/engine/types.ts - the frontend only ever displays
// state broadcast by the server (see ARCHITECTURE.md's on-chain/off-chain
// split), it never runs its own copy of the rules engine.

export type Player = "white" | "black";

export interface PointState {
  owner: Player | null;
  count: number;
}

export interface GameState {
  points: PointState[];
  bar: Record<Player, number>;
  borneOff: Record<Player, number>;
  turn: Player;
  dice: number[];
  hasRolled: boolean;
  winner: Player | null;
  lastRoll: number[];
}

export type MoveSource = { type: "bar" } | { type: "point"; point: number };

export interface Move {
  source: MoveSource;
  die: number;
  to: number | null;
}
