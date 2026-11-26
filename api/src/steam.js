"use strict";

// Steam sign-in for game clients.
// Client: SteamUser()->GetAuthTicketForWebApi("crowforge-api") -> hex ticket -> POST /v1/games/{id}/auth/steam.
// Server: checks the ticket with Steam (publisher Web API key), then hands out a short-lived token
// (HMAC-signed, no extra secret: the signing key is derived from the Steam key).

const crypto = require("crypto");

const IDENTITY = "crowforge-api";
const TOKEN_TTL_SECONDS = 60 * 60;
const STEAM_API = "https://partner.steam-api.com";

class SteamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function steamKey() {
  return String(process.env.STEAM_WEB_API_KEY || "").trim();
}

function signingKey() {
  const key = steamKey();
  if (!key) throw new SteamError(503, "Steam sign-in is not configured.");
  return crypto.createHmac("sha256", key).update("crowforge-token-v1").digest();
}

const b64 = (buf) => Buffer.from(buf).toString("base64url");

function issueToken({ gameId, steamId, name }, now = Date.now()) {
  const payload = b64(JSON.stringify({ g: gameId, s: steamId, n: name, e: Math.floor(now / 1000) + TOKEN_TTL_SECONDS }));
  const sig = b64(crypto.createHmac("sha256", signingKey()).update(payload).digest());
  return { token: `v1.${payload}.${sig}`, expiresIn: TOKEN_TTL_SECONDS };
}

/** Returns {steamId, name} for a valid token of this game, otherwise null. */
function verifyToken(token, gameId, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !steamKey()) return null;
  const expected = crypto.createHmac("sha256", signingKey()).update(parts[1]).digest();
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (data.g !== gameId || !data.s || !(data.e * 1000 > now)) return null;
  return { steamId: String(data.s), name: String(data.n || "") };
}

async function steamGet(path, params, fetchImpl) {
  const url = new URL(STEAM_API + path);
  for (const [k, v] of Object.entries({ key: steamKey(), ...params })) url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw new SteamError(502, "Steam is not reachable.");
  }
  if (!res.ok) throw new SteamError(502, `Steam answered ${res.status}.`);
  return res.json();
}

/** Checks a Web API ticket with Steam. Returns {steamId, name}. */
async function authenticateTicket({ appId, ticket }, fetchImpl = fetch) {
  if (!steamKey()) throw new SteamError(503, "Steam sign-in is not configured.");
  if (!appId) throw new SteamError(404, "No Steam app configured for this game.");
  const hex = String(ticket || "").trim();
  if (!/^[0-9a-fA-F]{16,4096}$/.test(hex)) throw new SteamError(422, "ticket must be a hex string.");

  const auth = await steamGet("/ISteamUserAuth/AuthenticateUserTicket/v1/", { appid: appId, ticket: hex, identity: IDENTITY }, fetchImpl);
  const params = auth && auth.response && auth.response.params;
  if (!params || params.result !== "OK" || !/^\d{5,20}$/.test(String(params.steamid || ""))) {
    throw new SteamError(401, "Steam ticket rejected.");
  }
  if (params.publisherbanned) throw new SteamError(403, "Account is banned for this game.");
  const steamId = String(params.steamid);

  let name = "";
  try {
    const summary = await steamGet("/ISteamUser/GetPlayerSummaries/v2/", { steamids: steamId }, fetchImpl);
    const player = summary && summary.response && summary.response.players && summary.response.players[0];
    name = String((player && player.personaname) || "").trim().slice(0, 64);
  } catch {
    // Name is optional; the game can still send its own.
  }
  return { steamId, name };
}

module.exports = { SteamError, issueToken, verifyToken, authenticateTicket, IDENTITY };
