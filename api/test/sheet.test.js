"use strict";
const test = require("node:test");
const assert = require("node:assert");
const s = require("../src/sheet");

test("parseSheetDate handles Vienna summer and winter time", () => {
  assert.strictEqual(s.parseSheetDate("18.07.2026 10:25").toISOString(), "2026-07-18T08:25:00.000Z");
  assert.strictEqual(s.parseSheetDate("14.11.2026").toISOString(), "2026-11-13T23:00:00.000Z");
  assert.strictEqual(s.parseSheetDate(""), null);
  assert.strictEqual(s.parseSheetDate("2026-11-14"), null);
});

test("namePlayerKey is case-insensitive and slash-safe", () => {
  assert.strictEqual(s.namePlayerKey(" Bazillos "), s.namePlayerKey("bazillos"));
  assert.ok(!s.namePlayerKey("a/b").includes("/"));
});

test("parseLeaderboardRows skips headers and invalid rows, keeps best score per name", () => {
  const rows = s.parseLeaderboardRows([
    ["Steamname", "Score", "Date", "Version"],
    ["mwolf286", "20550", "14.10.2026", "1.0.9"],
    ["MWOLF286", "100", "01.10.2026", "1.0.8"],
    ["salome", "0", "25.11.2026"],
    ["", "5"],
    ["bad", "abc"]
  ]);
  assert.deepStrictEqual(rows.map((r) => [r.name, r.score, r.version]), [
    ["mwolf286", 20550, "1.0.9"],
    ["salome", 0, null]
  ]);
});

test("parseTaverns splits the legacy string, names may contain commas", () => {
  assert.deepStrictEqual(s.parseTaverns(";small,The Spitting Dragon,7,Workers: 3;uncle,Mäxle, der Zweite,1,Workers: 0"), [
    { type: "small", name: "The Spitting Dragon", level: 7, workers: 3 },
    { type: "uncle", name: "Mäxle, der Zweite", level: 1, workers: 0 }
  ]);
  assert.deepStrictEqual(s.parseTaverns(""), []);
});

test("parseTicketRows dedupes identical rows and skips empty ones", () => {
  const row = ["11.08.2026 08:54", "TENOKE", "Stew", "Meat not accepted", "open", "1.0.9", "8", ";small,X,3,Workers: 0", "", "mid"];
  const tickets = s.parseTicketRows([row, [...row], [], ["19.07.2026 10:59"]]);
  assert.strictEqual(tickets.length, 1);
  assert.strictEqual(tickets[0].status, "open");
  assert.strictEqual(tickets[0].priority, "mid");
  assert.strictEqual(tickets[0].totalDays, 8);
  assert.ok(tickets[0].id.startsWith("sheet_"));
});

test("recordHash changes when a field changes", () => {
  const a = { id: 1, status: "open" };
  assert.notStrictEqual(s.recordHash(a), s.recordHash({ ...a, status: "closed" }));
});
