// Ported from the free client-side game (dravon's lib/backgammon/types.ts) -
// the backend runs the exact same deterministic rules so it can validate
// moves as a neutral referee rather than trusting either client.

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
