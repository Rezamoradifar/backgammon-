import { test } from "node:test";
import assert from "node:assert/strict";

import { applyMove, createInitialState, endTurn, getLegalMoves, isLegalMove, startTurn } from "./engine.js";
import { rollDice } from "./dice.js";

test("initial state has the standard starting position and no winner", () => {
  const state = createInitialState();
  assert.equal(state.points[23].owner, "white");
  assert.equal(state.points[23].count, 2);
  assert.equal(state.points[0].owner, "black");
  assert.equal(state.points[0].count, 2);
  assert.equal(state.winner, null);
  assert.equal(state.turn, "white");
});

test("rollDice always returns two values 1-6, or four equal values on a double", () => {
  for (let i = 0; i < 200; i++) {
    const dice = rollDice();
    assert.ok(dice.length === 2 || dice.length === 4);
    for (const d of dice) {
      assert.ok(d >= 1 && d <= 6);
    }
    if (dice.length === 4) {
      assert.ok(dice.every((d) => d === dice[0]));
    }
  }
});

test("a legal move for white advances a checker and is validated by isLegalMove", () => {
  let state = createInitialState();
  state = startTurn(state, [6, 5]);

  const legal = getLegalMoves(state, "white");
  assert.ok(legal.length > 0);

  const move = legal[0];
  assert.equal(isLegalMove(state, move), true);

  state = applyMove(state, move);
  assert.equal(state.dice.length, 1);
});

test("hitting a lone opposing checker sends it to the bar", () => {
  let state = createInitialState();
  // Move a white checker from 24 -> 18 (die 6), landing on an empty point first is fine;
  // to actually test a hit, place a manual blot scenario.
  state.points[17] = { owner: "black", count: 1 }; // point 18: a lone black blot
  state = startTurn(state, [6]);

  const move = { source: { type: "point" as const, point: 24 }, die: 6, to: 18 };
  assert.equal(isLegalMove(state, move), true);

  state = applyMove(state, move);
  assert.equal(state.points[17].owner, "white");
  assert.equal(state.bar.black, 1);
});

test("endTurn flips the active player and clears remaining dice", () => {
  let state = createInitialState();
  state = startTurn(state, [3, 4]);
  state = endTurn(state);
  assert.equal(state.turn, "black");
  assert.equal(state.dice.length, 0);
  assert.equal(state.hasRolled, false);
});

test("a move using a die value not currently available is rejected by isLegalMove", () => {
  let state = createInitialState();
  state = startTurn(state, [2]);
  const bogusMove = { source: { type: "point" as const, point: 24 }, die: 5, to: 19 };
  assert.equal(isLegalMove(state, bogusMove), false);
});
