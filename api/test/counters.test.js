"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { counterAllowance } = require("../src/store");

test("counter allowance grows with time since the last add", () => {
  const now = Date.parse("2026-11-27T10:00:00Z");
  assert.strictEqual(counterAllowance(60, 0, now), 3600); // first add: one hour
  assert.strictEqual(counterAllowance(60, now - 5 * 60000, now), 300);
  assert.strictEqual(counterAllowance(60, now - 1000, now), 60); // at least one minute
  assert.strictEqual(counterAllowance(60, now - 7 * 86400000, now), 86400); // capped at one day
});
