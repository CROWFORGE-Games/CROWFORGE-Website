"use strict";
const test = require("node:test");
const assert = require("node:assert");

process.env.STEAM_WEB_API_KEY = "steam-test-key";
const steam = require("../src/steam");

const TICKET = "ab".repeat(20);
const fakeFetch = (auth, players = [{ personaname: "Mathi" }]) => {
  const urls = [];
  const impl = async (url) => {
    urls.push(String(url));
    const body = String(url).includes("AuthenticateUserTicket") ? auth : { response: { players } };
    return { ok: true, json: async () => body };
  };
  impl.urls = urls;
  return impl;
};

test("token roundtrip, wrong game, expiry, tampering", () => {
  const now = Date.now();
  const { token, expiresIn } = steam.issueToken({ gameId: "tavern-legends", steamId: "76561190000000001", name: "Mathi" }, now);
  assert.strictEqual(expiresIn, 3600);
  assert.deepStrictEqual(steam.verifyToken(token, "tavern-legends", now), { steamId: "76561190000000001", name: "Mathi" });
  assert.strictEqual(steam.verifyToken(token, "werewolf-hunter", now), null);
  assert.strictEqual(steam.verifyToken(token, "tavern-legends", now + 3601 * 1000), null);
  const [v, payload, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ g: "tavern-legends", s: "1", n: "x", e: 9e9 })).toString("base64url");
  assert.strictEqual(steam.verifyToken(`${v}.${forged}.${sig}`, "tavern-legends", now), null);
  assert.strictEqual(steam.verifyToken(`${v}.${payload}`, "tavern-legends", now), null);
  assert.strictEqual(steam.verifyToken("garbage", "tavern-legends", now), null);
});

test("authenticateTicket accepts a valid ticket and reads the persona name", async () => {
  const f = fakeFetch({ response: { params: { result: "OK", steamid: "76561190000000001", publisherbanned: false } } });
  const result = await steam.authenticateTicket({ appId: "123", ticket: TICKET }, f);
  assert.deepStrictEqual(result, { steamId: "76561190000000001", name: "Mathi" });
  assert.match(f.urls[0], /identity=crowforge-api/);
  assert.match(f.urls[0], /appid=123/);
});

test("authenticateTicket rejects bad input and bad answers", async () => {
  const ok = fakeFetch({ response: { params: { result: "OK", steamid: "76561190000000001" } } });
  await assert.rejects(steam.authenticateTicket({ appId: "123", ticket: "zz" }, ok), { status: 422 });
  await assert.rejects(steam.authenticateTicket({ appId: "", ticket: TICKET }, ok), { status: 404 });
  await assert.rejects(steam.authenticateTicket({ appId: "123", ticket: TICKET }, fakeFetch({ response: { error: { errorcode: 3 } } })), { status: 401 });
  const banned = fakeFetch({ response: { params: { result: "OK", steamid: "76561190000000001", publisherbanned: true } } });
  await assert.rejects(steam.authenticateTicket({ appId: "123", ticket: TICKET }, banned), { status: 403 });
  const down = async () => { throw new Error("offline"); };
  await assert.rejects(steam.authenticateTicket({ appId: "123", ticket: TICKET }, down), { status: 502 });
});

test("missing Steam key means sign-in is off", async () => {
  const saved = process.env.STEAM_WEB_API_KEY;
  delete process.env.STEAM_WEB_API_KEY;
  try {
    await assert.rejects(steam.authenticateTicket({ appId: "123", ticket: TICKET }, fakeFetch({})), { status: 503 });
    assert.strictEqual(steam.verifyToken("v1.a.b", "tavern-legends"), null);
  } finally {
    process.env.STEAM_WEB_API_KEY = saved;
  }
});
