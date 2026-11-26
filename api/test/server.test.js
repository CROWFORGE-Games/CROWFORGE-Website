"use strict";
const test = require("node:test");
const assert = require("node:assert");

process.env.GAME_KEY = "test-key";
process.env.GAME_KEY_WEREWOLF_HUNTER = "wh-key";
process.env.STEAM_WEB_API_KEY = "steam-test-key";
process.env.TL_STEAM_APP_ID = "123";
const steam = require("../src/steam");
steam.authenticateTicket = async ({ appId, ticket }) => {
  if (ticket !== "ab".repeat(20)) throw new steam.SteamError(401, "Steam ticket rejected.");
  return { steamId: "76561190000000001", name: "SteamMathi", appId };
};
const store = require("../src/store");
const calls = [];
store.getLeaderboard = async (g, b, opts) => { calls.push(["get", g, b, opts]); return { entries: [], me: null }; };
store.submitScore = async (g, b, board, s) => { calls.push(["score", g, b, s]); return { best: s.score, improved: true, rank: 1 }; };
store.createTicket = async (g, t) => { calls.push(["ticket", g, t]); return { id: "api_x", duplicate: false }; };
store.getCommands = async (g, o) => { calls.push(["commands", g, o]); return { commands: [{ id: "c1", action: "GiveGold", param: "50", createdAt: null }], serverTime: "t" }; };
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

test("each game has its own key", async () => {
  let res = await post("/v1/games/werewolf-hunter/tickets", { title: "Bug" }, "test-key");
  assert.strictEqual(res.status, 401, "Tavern Legends key must not write Werewolf Hunter tickets");
  res = await post("/v1/games/tavern-legends/tickets", { title: "Bug" }, "wh-key");
  assert.strictEqual(res.status, 401, "Werewolf Hunter key must not write Tavern Legends tickets");
  res = await post("/v1/games/unknown-game/tickets", { title: "Bug" });
  assert.strictEqual(res.status, 404);
});

test("werewolf hunter ticket keeps map, session and recent events", async () => {
  const res = await post("/v1/games/werewolf-hunter/tickets", {
    reporter: "Wolf", title: "Stuck", description: "in wall", build: "0.9.1", map: "Village",
    sessionId: "s-1", recentEvents: [...Array(60).keys()].map((i) => "event " + i)
  }, "wh-key");
  assert.strictEqual(res.status, 201);
  const [, gameId, t] = calls.at(-1);
  assert.strictEqual(gameId, "werewolf-hunter");
  assert.strictEqual(t.map, "Village");
  assert.strictEqual(t.recentEvents.length, 50);
  assert.strictEqual(t.recentEvents[0], "event 10");
});

test("commands need the game key and a game with commands", async () => {
  let res = await fetch(base + "/v1/games/tavern-legends/commands?player=Bob");
  assert.strictEqual(res.status, 401);
  res = await fetch(base + "/v1/games/werewolf-hunter/commands", { headers: { "X-Game-Key": "wh-key" } });
  assert.strictEqual(res.status, 404);
  res = await fetch(base + "/v1/games/tavern-legends/commands?player=Bob", { headers: { "X-Game-Key": "test-key" } });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(calls.at(-1), ["commands", "tavern-legends", { player: "Bob" }]);
  assert.strictEqual((await res.json()).commands[0].action, "GiveGold");
});

test("steam auth issues a token that signs score submits", async () => {
  let res = await post("/v1/games/tavern-legends/auth/steam", { ticket: "ab".repeat(20) }, "wrong");
  assert.strictEqual(res.status, 401);
  res = await post("/v1/games/tavern-legends/auth/steam", { ticket: "cd".repeat(20) });
  assert.strictEqual(res.status, 401);
  res = await post("/v1/games/tavern-legends/auth/steam", { ticket: "ab".repeat(20) });
  assert.strictEqual(res.status, 200);
  const auth = await res.json();
  assert.strictEqual(auth.steamId, "76561190000000001");
  assert.strictEqual(auth.name, "SteamMathi");
  assert.ok(auth.token.startsWith("v1."));

  const scorePath = "/v1/games/tavern-legends/leaderboards/beer-tapped/scores";
  const send = (token) => fetch(base + scorePath, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Game-Key": "test-key", Authorization: "Bearer " + token },
    body: JSON.stringify({ name: "Fake", score: 7 })
  });
  res = await send(auth.token);
  assert.strictEqual(res.status, 200);
  const call = calls.at(-1);
  assert.strictEqual(call[0], "score");
  assert.strictEqual(call[3].steamId, "76561190000000001");
  assert.strictEqual(call[3].name, "SteamMathi");
  res = await send("v1.bad.token");
  assert.strictEqual(res.status, 401);
});

test("leaderboard passes a numeric steamId through", async () => {
  await fetch(base + "/v1/games/tavern-legends/leaderboards/beer-tapped?steamId=76561190000000001");
  assert.deepStrictEqual(calls.at(-1)[3], { limit: 10, name: "", steamId: "76561190000000001" });
});
