import { randomInt } from "node:crypto";

/**
 * The backend rolls dice server-side using a CSPRNG and broadcasts the
 * result to both clients - the neutral-referee pattern. Neither client's own
 * RNG is ever trusted for determining game-affecting randomness, since a
 * dishonest client could otherwise bias its own rolls.
 */
export function rollDice(): number[] {
  const a = randomInt(1, 7);
  const b = randomInt(1, 7);
  return a === b ? [a, a, a, a] : [a, b];
}
