# Backgammon Rules (as implemented)

Standard backgammon rules, as validated by the shared deterministic engine
both clients run. This document describes the rules the engine enforces -
not the on-chain lifecycle (see ARCHITECTURE.md for that).

## Setup

- 24 points, numbered 1-24. Each player has 15 checkers.
- White's home board is points 1-6; White bears off past point 1 and moves
  toward decreasing point numbers.
- Black's home board is points 19-24; Black bears off past point 24 and
  moves toward increasing point numbers.
- Starting position (standard): each player has checkers on their 24-point,
  13-point, 8-point, and 6-point (mirrored for the opponent).

## Turn structure

1. Roll two six-sided dice.
2. Move checkers using the pip values shown. A double (both dice showing the
   same value) grants four moves of that value instead of two.
3. Each die value is used for exactly one checker movement of that many
   pips, in either order, as legal moves allow.
4. If no legal move exists for the roll (or part of it), that portion of the
   turn is forfeited.

## Legal moves

- A checker may move to an open point: empty, occupied by 1 or fewer of the
  opponent's checkers ("a blot"), or already occupied by the player's own
  checkers.
- Landing on a single opposing checker ("hitting a blot") sends it to the
  bar.
- A point occupied by 2+ of the opponent's checkers is closed - no landing
  there.

## The bar

- A checker sent to the bar must re-enter the board before its owner may
  make any other move.
- Re-entry uses the opponent's home board: the die value determines which
  point to enter on. If that entry point is closed, that die can't be used
  for re-entry (and if the player has a checker on the bar, no other move
  can be made until it re-enters).

## Bearing off

- Once all 15 of a player's checkers are within their own home board, they
  may begin bearing off (removing checkers from the board).
- A checker on point matching the exact die value bears off directly.
- If a die value is higher than any occupied point in the home board, it may
  bear off the checker on the highest remaining occupied point instead.

## Winning

- The first player to bear off all 15 checkers wins the match.
- (Standard backgammon scoring - gammons, backgammons, and the doubling cube
  - is not implemented in this version; wins are single-point, matching the
  free skill-game scope. See ARCHITECTURE.md for why stakes/scoring
  multipliers aren't part of this version.)

## What's on-chain vs. what isn't

None of the above turn-by-turn play happens on-chain - see ARCHITECTURE.md's
"On-chain vs. off-chain split" for the full reasoning. The chain only ever
sees: the match was created, both players joined, it started, and (once play
concludes off-chain) the agreed final result.
