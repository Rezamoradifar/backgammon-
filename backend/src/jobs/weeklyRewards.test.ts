import { test } from "node:test";
import assert from "node:assert/strict";

import { tieredSplit } from "./weeklyRewards.js";
import { previousCompletedWeek } from "../lib/isoWeek.js";

test("tieredSplit gives 1st place the largest share and allocates the full pool", () => {
  const pool = 1000n;
  const amounts = tieredSplit(pool, 3);
  assert.equal(amounts.length, 3);
  assert.ok(amounts[0] > amounts[1]);
  assert.ok(amounts[1] > amounts[2]);
  assert.equal(amounts.reduce((sum, a) => sum + a, 0n), pool);
});

test("tieredSplit handles fewer than 3 winners by re-normalizing shares", () => {
  const pool = 300n;
  const amounts = tieredSplit(pool, 1);
  assert.deepEqual(amounts, [300n]);

  const twoWinners = tieredSplit(pool, 2);
  assert.equal(twoWinners.length, 2);
  assert.equal(twoWinners.reduce((sum, a) => sum + a, 0n), pool);
  assert.ok(twoWinners[0] > twoWinners[1]);
});

test("tieredSplit never loses wei to integer division", () => {
  for (const pool of [1n, 7n, 999_999_999_999_999_999n]) {
    const amounts = tieredSplit(pool, 3);
    assert.equal(amounts.reduce((sum, a) => sum + a, 0n), pool);
  }
});

test("previousCompletedWeek always returns a 7-day range ending at the current week's Monday", () => {
  const { start, end, weekId } = previousCompletedWeek(new Date("2026-07-20T15:00:00Z"));
  assert.equal(end.getTime() - start.getTime(), 7 * 24 * 60 * 60 * 1000);
  assert.equal(end.toISOString(), "2026-07-20T00:00:00.000Z");
  assert.equal(weekId, "2026-W29");
});
