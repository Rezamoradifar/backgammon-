/**
 * Player level - a simple, purely cosmetic progression readout derived
 * from completed games, with no gameplay effect and no on-chain state.
 * sqrt-shaped so early levels come quickly and later ones take
 * progressively more games, without needing a hand-tuned XP table.
 */
export function computeLevel(gamesPlayed: number): number {
  return Math.floor(Math.sqrt(Math.max(0, gamesPlayed))) + 1;
}
