"use strict";

const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");
const { OAuth2Client } = require("google-auth-library");
const config = require("./config");
const store = require("./store");
const steam = require("./steam");
const periods = require("./periods");

const MAX_BODY_BYTES = 32 * 1024;
const GCLOUD_CLI_AUDIENCE = "32555940559.apps.googleusercontent.com"; // `gcloud auth print-identity-token`
const oidc = new OAuth2Client();

// --- helpers -----------------------------------------------------------------------------------

function send(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=UTF-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return forwarded ? String(forwarded).split(",")[0].trim() : req.socket.remoteAddress || "unknown";
}

// Simple fixed-window rate limiter, per instance. Good enough with a small max-instances setting.
const buckets = new Map();
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.start > windowMs) {
    buckets.set(key, { start: now, count: 1 });
    return false;
  }
  bucket.count++;
  return bucket.count > limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (now - bucket.start > 15 * 60 * 1000) buckets.delete(key);
}, 60 * 1000).unref();

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new store.ApiError(413, "Payload too large.");
    chunks.push(chunk);
  }
  try {
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new store.ApiError(400, "Invalid JSON.");
  }
}

function requireGameKey(req, gameId) {
  if (!config.games[gameId]) throw new store.ApiError(404, "Unknown game.");
  const key = config.gameKeyFor(gameId);
  if (!key) throw new store.ApiError(503, "Writes are disabled for this game (no game key configured).");
  const given = Buffer.from(String(req.headers["x-game-key"] || ""));
  const expected = Buffer.from(key);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new store.ApiError(401, "Invalid game key.");
  }
}

async function requireSyncCaller(req) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw new store.ApiError(401, "Missing token.");
  const audience = [`https://${req.headers.host}`, `https://${req.headers.host}/internal/sync`, GCLOUD_CLI_AUDIENCE];
  let payload;
  try {
    payload = (await oidc.verifyIdToken({ idToken: token, audience })).getPayload();
  } catch {
    throw new store.ApiError(401, "Invalid token.");
  }
  const email = String(payload.email || "").toLowerCase();
  if (!payload.email_verified || !config.syncAllowedEmails.includes(email)) {
    throw new store.ApiError(403, "Not allowed.");
  }
}

function text(value, max, field, { required = false } = {}) {
  const s = String(value ?? "").trim();
  if (required && !s) throw new store.ApiError(422, `${field} is required.`);
  if (s.length > max) throw new store.ApiError(422, `${field} is too long (max ${max}).`);
  return s;
}

function lookupBoard(gameId, boardId) {
  const game = config.games[gameId];
  const board = game && game.leaderboards && game.leaderboards[boardId];
  if (!board) throw new store.ApiError(404, "Unknown game or leaderboard.");
  return board;
}

// --- handlers ----------------------------------------------------------------------------------

/** Steam identity from "Authorization: Bearer <token>", or null. A present but invalid token is an error. */
function steamIdentity(req, gameId) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return null;
  const identity = steam.verifyToken(header.slice(7), gameId);
  if (!identity) throw new store.ApiError(401, "Invalid or expired Steam token. Sign in again.");
  return identity;
}

async function postSteamAuth(req, res, gameId) {
  requireGameKey(req, gameId);
  if (rateLimited(`auth:${gameId}:${clientIp(req)}`, 10, 60 * 1000)) {
    throw new store.ApiError(429, "Too many sign-in attempts.");
  }
  const body = await readJson(req);
  try {
    const { steamId, name } = await steam.authenticateTicket({ appId: config.games[gameId].steamAppId, ticket: body.ticket });
    const displayName = name || text(body.name, 64, "name");
    send(res, 200, { ...steam.issueToken({ gameId, steamId, name: displayName }), steamId, name: displayName });
  } catch (error) {
    if (error instanceof steam.SteamError) throw new store.ApiError(error.status, error.message);
    throw error;
  }
}

async function getLeaderboard(req, res, url, gameId, boardId) {
  lookupBoard(gameId, boardId);
  const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get("limit") || "10", 10) || 10));
  const name = text(url.searchParams.get("name"), 64, "name");
  const steamId = text(url.searchParams.get("steamId"), 20, "steamId");
  const payload = await store.getLeaderboard(gameId, boardId, /^\d+$/.test(steamId) ? { limit, name, steamId } : { limit, name });
  send(res, 200, payload, { "Access-Control-Allow-Origin": "*" });
}

async function postScore(req, res, gameId, boardId) {
  requireGameKey(req, gameId);
  const board = lookupBoard(gameId, boardId);
  const identity = steamIdentity(req, gameId);
  if (!identity && config.games[gameId].scoreRequiresSteam) {
    throw new store.ApiError(401, "Steam sign-in required to submit scores.");
  }
  const body = await readJson(req);
  // Signed in: the Steam name wins over what the client sends.
  const name = (identity && identity.name) || text(body.name, 64, "name", { required: true });
  const score = Number(body.score);
  if (!Number.isInteger(score) || score < 0 || score > board.maxScore) {
    throw new store.ApiError(422, "score must be an integer between 0 and " + board.maxScore + ".");
  }
  const version = text(body.version, 32, "version");
  const who = identity ? `steam:${identity.steamId}` : name.toLowerCase();
  if (rateLimited(`score:${gameId}:${boardId}:${who}`, 2, 60 * 1000)) {
    throw new store.ApiError(429, "Too many score submissions.");
  }
  const result = await store.submitScore(gameId, boardId, board, { name, score, version, steamId: identity ? identity.steamId : undefined });
  send(res, 200, result);
}

async function postTicket(req, res, gameId) {
  requireGameKey(req, gameId);
  if (rateLimited(`ticket:${gameId}:${clientIp(req)}`, 5, 10 * 60 * 1000)) {
    throw new store.ApiError(429, "Too many bug reports. Please wait a few minutes.");
  }
  const body = await readJson(req);
  const taverns = Array.isArray(body.taverns) ? body.taverns.slice(0, 20) : [];
  const totalDays = Number.parseInt(body.totalDays, 10);
  const recentEvents = Array.isArray(body.recentEvents) ? body.recentEvents.slice(-50) : [];
  const ticket = {
    reporter: text(body.reporter, 64, "reporter"),
    title: text(body.title, 200, "title", { required: true }),
    description: text(body.description, 5000, "description"),
    build: text(body.build, 32, "build"),
    totalDays: Number.isFinite(totalDays) ? totalDays : null,
    taverns: taverns.map((t) => ({
      type: text(t && t.type, 32, "taverns.type"),
      name: text(t && t.name, 64, "taverns.name"),
      level: Number.isFinite(Number(t && t.level)) ? Number(t.level) : null,
      workers: Number.isFinite(Number(t && t.workers)) ? Number(t.workers) : null
    })),
    // Generic context for games without taverns (e.g. Werewolf Hunter). Untrusted player data.
    map: text(body.map, 64, "map"),
    sessionId: text(body.sessionId, 64, "sessionId"),
    recentEvents: recentEvents.map((line) => String(line ?? "").trim().slice(0, 300)).filter(Boolean)
  };
  const result = await store.createTicket(gameId, ticket);
  send(res, result.duplicate ? 200 : 201, result);
}

async function getCommands(req, res, url, gameId) {
  requireGameKey(req, gameId);
  if (!config.games[gameId].commands) throw new store.ApiError(404, "No remote commands for this game.");
  const player = text(url.searchParams.get("player"), 64, "player");
  send(res, 200, await store.getCommands(gameId, { player }));
}

async function postSync(req, res) {
  await requireSyncCaller(req);
  const { syncAll } = require("./sync");
  const report = await syncAll();
  console.log(JSON.stringify({ message: "sync done", report }));
  send(res, 200, report);
}

/** Configured counter, or the game's default for open counters (created on first add). */
function lookupCounter(gameId, counterId) {
  const game = config.games[gameId];
  const counter = game && game.counters && game.counters[counterId];
  if (counter) return { ...counter, configured: true };
  if (game && game.openCounters && /^[a-z0-9][a-z0-9-]{0,39}$/.test(counterId)) {
    return { maxPerMinute: game.openCounters.maxPerMinute, configured: false };
  }
  throw new store.ApiError(404, "Unknown game or counter.");
}

async function postCounterAdd(req, res, gameId, counterId) {
  requireGameKey(req, gameId);
  const counter = lookupCounter(gameId, counterId);
  const identity = steamIdentity(req, gameId);
  if (!identity) throw new store.ApiError(401, "Steam sign-in required.");
  const body = await readJson(req);
  const amount = Number(body.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > 1000000) {
    throw new store.ApiError(422, "amount must be an integer between 1 and 1000000.");
  }
  const slotId = text(body.slotId, 64, "slotId");
  if (slotId && !/^[A-Za-z0-9_-]+$/.test(slotId)) throw new store.ApiError(422, "slotId may only contain letters, digits, _ and -.");
  const version = text(body.version, 32, "version");
  if (rateLimited(`counter:${gameId}:${counterId}:${identity.steamId}`, 30, 60 * 1000)) {
    throw new store.ApiError(429, "Too many counter updates.");
  }
  const name = identity.name || "Player";
  if (!counter.configured) {
    await store.registerCounter(gameId, counterId, config.games[gameId].openCounters.maxCounters);
  }
  const result = await store.addToCounter(gameId, counterId, counter, { steamId: identity.steamId, name, amount, slotId, version });
  send(res, 200, result);
}

async function getCounterLeaderboard(req, res, url, gameId, counterId) {
  lookupCounter(gameId, counterId);
  const period = url.searchParams.get("period") || "all";
  if (!periods.PERIODS.includes(period)) throw new store.ApiError(422, "period must be all, day, week or month.");
  const offset = url.searchParams.get("offset") === "-1" && period !== "all" ? -1 : 0;
  const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get("limit") || "10", 10) || 10));
  const steamId = text(url.searchParams.get("steamId"), 20, "steamId");
  const payload = await store.getCounterLeaderboard(gameId, counterId, { period, offset, limit, steamId: /^\d+$/.test(steamId) ? steamId : "" });
  send(res, 200, payload, { "Access-Control-Allow-Origin": "*" });
}

// --- routing -----------------------------------------------------------------------------------

const LEADERBOARD = /^\/v1\/games\/([a-z0-9-]+)\/leaderboards\/([a-z0-9-]+)$/;
const SCORES = /^\/v1\/games\/([a-z0-9-]+)\/leaderboards\/([a-z0-9-]+)\/scores$/;
const TICKETS = /^\/v1\/games\/([a-z0-9-]+)\/tickets$/;
const COMMANDS = /^\/v1\/games\/([a-z0-9-]+)\/commands$/;
const COUNTER_ADD = /^\/v1\/games\/([a-z0-9-]+)\/counters\/([a-z0-9-]+)\/add$/;
const COUNTER_BOARD = /^\/v1\/games\/([a-z0-9-]+)\/counters\/([a-z0-9-]+)\/leaderboard$/;
const STEAM_AUTH = /^\/v1\/games\/([a-z0-9-]+)\/auth\/steam$/;

async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  let m;

  if (req.method === "OPTIONS" && (LEADERBOARD.test(path) || COUNTER_BOARD.test(path))) {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET" });
    return res.end();
  }
  if (path === "/healthz") return send(res, 200, { ok: true });
  if (req.method === "GET" && (m = LEADERBOARD.exec(path))) return getLeaderboard(req, res, url, m[1], m[2]);
  if (req.method === "POST" && (m = SCORES.exec(path))) return postScore(req, res, m[1], m[2]);
  if (req.method === "POST" && (m = TICKETS.exec(path))) return postTicket(req, res, m[1]);
  if (req.method === "GET" && (m = COMMANDS.exec(path))) return getCommands(req, res, url, m[1]);
  if (req.method === "POST" && (m = COUNTER_ADD.exec(path))) return postCounterAdd(req, res, m[1], m[2]);
  if (req.method === "GET" && (m = COUNTER_BOARD.exec(path))) return getCounterLeaderboard(req, res, url, m[1], m[2]);
  if (req.method === "POST" && (m = STEAM_AUTH.exec(path))) return postSteamAuth(req, res, m[1]);
  if (req.method === "POST" && path === "/internal/sync") return postSync(req, res);
  return send(res, 404, { error: "Not found." });
}

const server = http.createServer((req, res) => {
  if (!["GET", "POST", "OPTIONS"].includes(req.method)) return send(res, 405, { error: "Method not allowed." });
  if (req.method === "GET" && rateLimited(`ip:${clientIp(req)}`, 120, 60 * 1000)) {
    return send(res, 429, { error: "Too many requests." });
  }
  route(req, res).catch((error) => {
    if (error instanceof store.ApiError) return send(res, error.status, { error: error.message });
    console.error(error);
    send(res, 500, { error: "Internal error." });
  });
});

if (require.main === module) {
  server.listen(config.port, "0.0.0.0", () => console.log(`crowforge-api listening on ${config.port}`));
}

module.exports = { server };
