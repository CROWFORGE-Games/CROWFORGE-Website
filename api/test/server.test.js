"use strict";
const test = require("node:test");
const assert = require("node:assert");

process.env.GAME_KEY = "test-key";
const store = require("../src/store");
const calls = [];
store.getLeaderboard = async (g, b, opts) => { calls.push(["get", g, b, opts]); return { entries: [], me: null }; };
store.submitScore = async (g, b, board, s) => { calls.push(["score", g, b, s]); return { best: s.score, improved: true, rank: 1 }; };
store.createTicket = async (g, t) => { calls.push(["ticket", g, t]); return { id: "api_x", duplicate: false }; };
const { server } = require("../src/server");

let base;
test.before(() => new Promise((r) => server.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => server.close());

const post = (path, body, key = "test-key") =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Game-Key": key }, body: JSON.stringify(body) });

test("leaderboard read is public and clamps limit", async () => {
  const res = await fetch(base + "/v1/games/tavern-legends/leaderboards/beer-tapped?limit=500&name=Bob");
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(calls.at(-1)[3], { limit: 100, name: "Bob" });
});

test("unknown board is 404", async () => {
  const res = await fetch(base + "/v1/games/tavern-legends/leaderboards/nope");
  assert.strictEqual(res.status, 404);
});

test("score requires game key", async () => {
  const res = await post("/v1/games/tavern-legends/leaderboards/beer-tapped/scores", { name: "a", score: 1 }, "wrong");
  assert.strictEqual(res.status, 401);
});

test("score validation and success", async () => {
  let res = await post("/v1/games/tavern-legends/leaderboards/beer-tapped/scores", { name: "a", score: -1 });
  assert.strictEqual(res.status, 422);
  res = await post("/v1/games/tavern-legends/leaderboards/beer-tapped/scores", { name: "a", score: 999999999 });
  assert.strictEqual(res.status, 422);
  res = await post("/v1/games/tavern-legends/leaderboards/beer-tapped/scores", { name: "Alice", score: 120, version: "1.1.0" });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { best: 120, improved: true, rank: 1 });
});

test("score rate limit per name", async () => {
  const p = "/v1/games/tavern-legends/leaderboards/beer-tapped/scores";
  await post(p, { name: "Rate", score: 1 });
  await post(p, { name: "Rate", score: 2 });
  const res = await post(p, { name: "rate", score: 3 });
  assert.strictEqual(res.status, 429);
});

test("ticket validation and success", async () => {
  let res = await post("/v1/games/tavern-legends/tickets", { description: "no title" });
  assert.strictEqual(res.status, 422);
  res = await post("/v1/games/tavern-legends/tickets", {
    reporter: "Bob", title: "Bug", description: "x", build: "1.1.0", totalDays: "12",
    taverns: [{ type: "small", name: "Inn", level: 3, workers: 2 }]
  });
  assert.strictEqual(res.status, 201);
  const t = calls.at(-1)[2];
  assert.strictEqual(t.totalDays, 12);
  assert.deepStrictEqual(t.taverns, [{ type: "small", name: "Inn", level: 3, workers: 2 }]);
});

test("invalid json is 400, sync without token is 401", async () => {
  let res = await fetch(base + "/v1/games/tavern-legends/tickets", { method: "POST", headers: { "X-Game-Key": "test-key" }, body: "{" });
  assert.strictEqual(res.status, 400);
  res = await fetch(base + "/internal/sync", { method: "POST" });
  assert.strictEqual(res.status, 401);
});
