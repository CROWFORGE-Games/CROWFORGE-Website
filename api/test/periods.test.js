"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { periodInfo, currentKeys } = require("../src/periods");

const at = (s) => Date.parse(s);

test("week runs Monday 00:00 to Monday 00:00 Vienna time", () => {
  // Thursday 27.11.2026 00:20 in Vienna
  const w = periodInfo("week", 0, at("2026-11-26T23:20:00Z"));
  assert.deepStrictEqual(w, { period: "week", key: "w2026-48", startsAt: "2026-11-22T23:00:00.000Z", endsAt: "2026-11-29T23:00:00.000Z" });
  // Sunday 23:59:59 Vienna is still week 48, Monday 00:00 is week 49
  assert.strictEqual(periodInfo("week", 0, at("2026-11-29T22:59:59Z")).key, "w2026-48");
  assert.strictEqual(periodInfo("week", 0, at("2026-11-29T23:00:00Z")).key, "w2026-49");
  assert.strictEqual(periodInfo("week", -1, at("2026-11-26T23:20:00Z")).key, "w2026-47");
});

test("day and month follow Vienna dates and DST", () => {
  assert.strictEqual(periodInfo("day", 0, at("2026-11-26T23:20:00Z")).key, "d2026-11-27");
  const dstDay = periodInfo("day", 0, at("2026-03-29T00:30:00Z")); // clocks jump forward that night
  assert.strictEqual(dstDay.startsAt, "2026-03-28T23:00:00.000Z");
  assert.strictEqual(dstDay.endsAt, "2026-03-29T22:00:00.000Z");
  assert.strictEqual(periodInfo("month", 0, at("2026-12-31T23:30:00Z")).key, "m2027-01");
  assert.strictEqual(periodInfo("month", -1, at("2026-01-15T12:00:00Z")).key, "m2025-12");
});

test("ISO week across the year boundary", () => {
  assert.strictEqual(periodInfo("week", 0, at("2027-01-03T12:00:00Z")).key, "w2026-53");
  assert.strictEqual(periodInfo("week", 0, at("2027-01-04T12:00:00Z")).key, "w2027-01");
});

test("an add counts towards all four periods", () => {
  assert.deepStrictEqual(currentKeys(at("2026-11-26T23:20:00Z")), ["all", "d2026-11-27", "w2026-48", "m2026-11"]);
});
