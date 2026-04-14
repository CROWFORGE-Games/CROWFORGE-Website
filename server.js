const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const COOLDOWN_SECONDS = 45;
const MIN_ELAPSED_MS = 3500;
const rateLimitStore = new Map();
const steamNewsCache = new Map();
const leaderboardCache = new Map();
const twitchCategoryStatsCache = new Map();
let twitchTokenCache = null;
const STEAM_NEWS_CACHE_MS = 10 * 60 * 1000;
const LEADERBOARD_CACHE_MS = 5 * 60 * 1000;
const TWITCH_CATEGORY_STATS_CACHE_MS = 60 * 1000;

const MIME_TYPES = {
  ".html": "text/html; charset=UTF-8",
  ".css": "text/css; charset=UTF-8",
  ".js": "application/javascript; charset=UTF-8",
  ".json": "application/json; charset=UTF-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=UTF-8",
  ".webp": "image/webp"
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=UTF-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function cleanRateLimitStore(nowSeconds) {
  for (const [ip, lastRequest] of rateLimitStore.entries()) {
    if (nowSeconds - lastRequest > COOLDOWN_SECONDS * 4) {
      rateLimitStore.delete(ip);
    }
  }
}

function getCachedSteamNews(cacheKey) {
  const cached = steamNewsCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > STEAM_NEWS_CACHE_MS) {
    steamNewsCache.delete(cacheKey);
    return null;
  }
  return cached.payload;
}

function setCachedSteamNews(cacheKey, payload) {
  steamNewsCache.set(cacheKey, {
    createdAt: Date.now(),
    payload
  });
}

function getCachedLeaderboard(cacheKey) {
  const cached = leaderboardCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > LEADERBOARD_CACHE_MS) {
    leaderboardCache.delete(cacheKey);
    return null;
  }
  return cached.payload;
}

function setCachedLeaderboard(cacheKey, payload) {
  leaderboardCache.set(cacheKey, {
    createdAt: Date.now(),
    payload
  });
}

function getCachedTwitchCategoryStats(cacheKey) {
  const cached = twitchCategoryStatsCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > TWITCH_CATEGORY_STATS_CACHE_MS) {
    twitchCategoryStatsCache.delete(cacheKey);
    return null;
  }
  return cached.payload;
}

function setCachedTwitchCategoryStats(cacheKey, payload) {
  twitchCategoryStatsCache.set(cacheKey, {
    createdAt: Date.now(),
    payload
  });
}

function extractSteamImageFromContents(contents) {
  const match = String(contents || "").match(/\{STEAM_CLAN_IMAGE\}\/([^\s"'<>]+)/i);
  return match ? `https://clan.fastly.steamstatic.com/images/${match[1]}` : "";
}

function extractMetaImage(html) {
  const source = String(html || "");
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match && match[1]) return match[1];
  }
  return "";
}

async function resolveSteamNewsImage(item) {
  const fromContents = extractSteamImageFromContents(item.contents);
  if (fromContents) return fromContents;
  if (!item.url) return "";
  try {
    const response = await fetch(item.url, {
      headers: {
        "User-Agent": "CROWFORGE Website/1.0"
      }
    });
    if (!response.ok) return "";
    const html = await response.text();
    return extractMetaImage(html);
  } catch {
    return "";
  }
}

async function fetchSteamNews(appId, count) {
  const cacheKey = `${appId}:${count}`;
  const cached = getCachedSteamNews(cacheKey);
  if (cached) return cached;

  const apiUrl = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${encodeURIComponent(appId)}&count=${encodeURIComponent(count)}&maxlength=500&format=json`;
  const response = await fetch(apiUrl, {
    headers: {
      "User-Agent": "CROWFORGE Website/1.0"
    }
  });

  if (!response.ok) {
    throw new Error("Failed to fetch Steam news.");
  }

  const data = await response.json();
  const items = (data.appnews && Array.isArray(data.appnews.newsitems)) ? data.appnews.newsitems : [];
  const enrichedItems = await Promise.all(items.map(async (item, index) => {
    const image = index < 4 ? await resolveSteamNewsImage(item) : extractSteamImageFromContents(item.contents);
    return {
      ...item,
      image
    };
  }));

  const payload = {
    appnews: {
      ...(data.appnews || {}),
      newsitems: enrichedItems
    }
  };
  setCachedSteamNews(cacheKey, payload);
  return payload;
}

function parseLeaderboardCsv(text) {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter(Boolean);

  const players = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const name = String(cols[0] || "").trim().replace(/^"|"$/g, "");
    const beers = Number.parseInt(String(cols[1] || "0").trim().replace(/^"|"$/g, ""), 10);
    const normalizedName = name.toLowerCase();
    if (!name || normalizedName === "steamname" || normalizedName === "steam name") continue;
    if (!Number.isFinite(beers) || beers <= 0) continue;
    players.push({ name, beers });
  }

  players.sort((a, b) => b.beers - a.beers);
  return players;
}

async function fetchLeaderboard(sheetId) {
  const cacheKey = String(sheetId || "default");
  const cached = getCachedLeaderboard(cacheKey);
  if (cached) return cached;

  const csvUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=csv&gid=0`;
  const response = await fetch(csvUrl, {
    headers: {
      "User-Agent": "CROWFORGE Website/1.0"
    }
  });

  if (!response.ok) {
    throw new Error("Failed to fetch leaderboard.");
  }

  const text = await response.text();
  const payload = {
    players: parseLeaderboardCsv(text)
  };
  setCachedLeaderboard(cacheKey, payload);
  return payload;
}

async function fetchTwitchAppAccessToken(forceRefresh = false) {
  const clientId = String(process.env.TWITCH_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.TWITCH_CLIENT_SECRET || "").trim();

  if (!clientId || !clientSecret) {
    throw new Error("TWITCH_CLIENT_ID oder TWITCH_CLIENT_SECRET ist serverseitig nicht gesetzt.");
  }

  if (
    !forceRefresh &&
    twitchTokenCache &&
    twitchTokenCache.accessToken &&
    twitchTokenCache.expiresAt > Date.now() + 60 * 1000
  ) {
    return twitchTokenCache;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials"
  });

  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });

  if (!response.ok) {
    throw new Error("Twitch App Access Token konnte nicht geladen werden.");
  }

  const data = await response.json();
  const expiresInMs = Math.max(0, Number(data.expires_in || 0) * 1000);
  twitchTokenCache = {
    accessToken: String(data.access_token || ""),
    clientId,
    expiresAt: Date.now() + expiresInMs
  };

  if (!twitchTokenCache.accessToken) {
    throw new Error("Twitch Access Token fehlt in der Antwort.");
  }

  return twitchTokenCache;
}

async function twitchHelixGet(endpoint, params, forceRefresh = false) {
  const { accessToken, clientId } = await fetchTwitchAppAccessToken(forceRefresh);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    query.append(key, String(value));
  }

  const response = await fetch(`https://api.twitch.tv/helix/${endpoint}?${query.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Client-Id": clientId
    }
  });

  if (response.status === 401 && !forceRefresh) {
    twitchTokenCache = null;
    return twitchHelixGet(endpoint, params, true);
  }

  if (!response.ok) {
    throw new Error(`Twitch Helix Request fehlgeschlagen (${response.status}).`);
  }

  return response.json();
}

async function fetchTwitchCategoryStats(categoryName) {
  const normalizedCategory = String(categoryName || "").trim();
  if (!normalizedCategory) {
    return {
      category: "",
      viewers: 0,
      live_channels: 0
    };
  }

  const cacheKey = normalizedCategory.toLowerCase();
  const cached = getCachedTwitchCategoryStats(cacheKey);
  if (cached) return cached;

  const gamesPayload = await twitchHelixGet("games", { name: normalizedCategory });
  const game = Array.isArray(gamesPayload.data)
    ? gamesPayload.data.find((entry) => String(entry.name || "").toLowerCase() === normalizedCategory.toLowerCase()) || gamesPayload.data[0]
    : null;

  if (!game || !game.id) {
    const payload = {
      category: normalizedCategory,
      viewers: 0,
      live_channels: 0
    };
    setCachedTwitchCategoryStats(cacheKey, payload);
    return payload;
  }

  let viewers = 0;
  let liveChannels = 0;
  let cursor = "";

  do {
    const streamsPayload = await twitchHelixGet("streams", {
      game_id: game.id,
      first: 100,
      after: cursor || undefined
    });

    const streams = Array.isArray(streamsPayload.data) ? streamsPayload.data : [];
    for (const stream of streams) {
      viewers += Number(stream.viewer_count || 0);
      liveChannels += 1;
    }

    cursor = streamsPayload.pagination && streamsPayload.pagination.cursor
      ? String(streamsPayload.pagination.cursor)
      : "";
  } while (cursor);

  const payload = {
    category: String(game.name || normalizedCategory),
    viewers,
    live_channels: liveChannels
  };

  setCachedTwitchCategoryStats(cacheKey, payload);
  return payload;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid request payload.");
  }
}

async function handleServicesRequest(req, res) {
  try {
    const payload = await readJsonBody(req);
    const name = String(payload.name || "").trim();
    const company = String(payload.company || "").trim();
    const email = String(payload.email || "").trim();
    const goal = String(payload.goal || "").trim();
    const pkg = String(payload.package || "").trim();
    const packagePrice = String(payload.packagePrice || "").trim();
    const maintenance = String(payload.maintenance || "").trim();
    const budget = String(payload.budget || "").trim();
    const timeline = String(payload.timeline || "").trim();
    const mailBody = String(payload.mailBody || "").trim();
    const website = String(payload.website || "").trim();
    const formStartedAt = String(payload.formStartedAt || "").trim();
    const addons = Array.isArray(payload.addons) ? payload.addons : [];

    if (!name || !goal || !pkg || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendJson(res, 422, { message: "Bitte fülle Name, E-Mail, Paket und Projektziel aus." });
    }

    if (website !== "") {
      return sendJson(res, 400, { message: "Anfrage konnte nicht verarbeitet werden." });
    }

    const startedAtMs = /^\d+$/.test(formStartedAt) ? Number(formStartedAt) : 0;
    if (!startedAtMs) {
      return sendJson(res, 400, { message: "Bitte lade die Seite neu und versuche es erneut." });
    }

    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs < MIN_ELAPSED_MS) {
      return sendJson(res, 429, { message: "Die Anfrage wurde zu schnell gesendet. Bitte versuche es in ein paar Sekunden erneut." });
    }

    const ip = getClientIp(req);
    const nowSeconds = Math.floor(Date.now() / 1000);
    cleanRateLimitStore(nowSeconds);
    const lastRequest = rateLimitStore.get(ip) || 0;
    if (nowSeconds - lastRequest < COOLDOWN_SECONDS) {
      return sendJson(res, 429, { message: "Bitte warte kurz, bevor du eine weitere Anfrage sendest." });
    }
    rateLimitStore.set(ip, nowSeconds);

    const resendApiKey = process.env.RESEND_API_KEY;
    const resendFrom = process.env.RESEND_FROM || "CROWFORGE Web Services <contact@crowforge-games.com>";
    const resendTo = process.env.RESEND_TO || "contact@crowforge-games.com";

    if (!resendApiKey) {
      return sendJson(res, 500, { message: "RESEND_API_KEY ist serverseitig nicht gesetzt." });
    }

    const addonItems = addons.length
      ? addons.map((addon) => `<li>${escapeHtml(addon)}</li>`).join("")
      : "<li>Keine Add-ons ausgewählt</li>";

    const html = `
      <div style="font-family:Inter,Segoe UI,Arial,sans-serif;color:#111827;line-height:1.65">
        <h2 style="margin:0 0 16px;font-size:24px">Neue Anfrage über CROWFORGE Web Services</h2>
        <p style="margin:0 0 20px">Es wurde eine neue Projektanfrage über die Services-Seite gesendet.</p>
        <table style="width:100%;border-collapse:collapse;margin:0 0 20px">
          <tr><td style="padding:8px 0;font-weight:700;width:180px">Paket</td><td style="padding:8px 0">${escapeHtml(pkg)}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700">Preisrahmen Paket</td><td style="padding:8px 0">${escapeHtml(packagePrice)}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700">Wartung</td><td style="padding:8px 0">${escapeHtml(maintenance)}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700">Budget</td><td style="padding:8px 0">${escapeHtml(budget)}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700">Zeitrahmen</td><td style="padding:8px 0">${escapeHtml(timeline)}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700">Name</td><td style="padding:8px 0">${escapeHtml(name)}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700">Unternehmen</td><td style="padding:8px 0">${company ? escapeHtml(company) : "-"}</td></tr>
          <tr><td style="padding:8px 0;font-weight:700">E-Mail</td><td style="padding:8px 0">${escapeHtml(email)}</td></tr>
        </table>
        <h3 style="margin:0 0 10px;font-size:18px">Add-ons</h3>
        <ul style="margin:0 0 20px 18px;padding:0">${addonItems}</ul>
        <h3 style="margin:24px 0 10px;font-size:18px">Projektziel / Infos</h3>
        <div style="padding:14px 16px;border:1px solid #e5e7eb;background:#f8fafc;white-space:pre-wrap">${escapeHtml(goal)}</div>
        <h3 style="margin:24px 0 10px;font-size:18px">Textversion</h3>
        <div style="padding:14px 16px;border:1px solid #e5e7eb;background:#ffffff;white-space:pre-wrap">${escapeHtml(mailBody || goal)}</div>
      </div>
    `;

    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: resendFrom,
        to: [resendTo],
        reply_to: email,
        subject: `Neue Web Services Anfrage - ${pkg}`,
        html,
        text: mailBody || goal
      })
    });

    const resendText = await resendResponse.text();
    let resendJson = {};
    try {
      resendJson = resendText ? JSON.parse(resendText) : {};
    } catch {
      resendJson = {};
    }

    if (!resendResponse.ok) {
      return sendJson(res, 500, {
        message: resendJson.message || resendJson.error || "Versand über Resend fehlgeschlagen."
      });
    }

    return sendJson(res, 200, {
      message: "Anfrage erfolgreich gesendet.",
      id: resendJson.id || null
    });
  } catch (error) {
    return sendJson(res, 500, {
      message: `Serverfehler beim Versand: ${error instanceof Error ? error.message : "Unbekannter Fehler"}`
    });
  }
}

function serveFile(req, res, pathname) {
  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = decodeURIComponent(filePath);
  const absolutePath = path.normalize(path.join(ROOT, filePath));

  if (!absolutePath.startsWith(ROOT)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=UTF-8" });
    res.end("Forbidden");
    return;
  }

  fs.stat(absolutePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=UTF-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(absolutePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600"
    });
    fs.createReadStream(absolutePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;

  if (req.method === "GET" && pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=UTF-8" });
    res.end("ok");
    return;
  }

  if (pathname === "/api/send-services-request") {
    if (req.method !== "POST") {
      return sendJson(res, 405, { message: "Method not allowed." });
    }
    return handleServicesRequest(req, res);
  }

  if (pathname === "/api/steam-news") {
    if (req.method !== "GET") {
      return sendJson(res, 405, { message: "Method not allowed." });
    }
    try {
      const appId = String(requestUrl.searchParams.get("appid") || "3160880").trim();
      const count = Math.max(1, Math.min(12, Number(requestUrl.searchParams.get("count") || 8) || 8));
      const payload = await fetchSteamNews(appId, count);
      return sendJson(res, 200, payload);
    } catch (error) {
      return sendJson(res, 502, {
        message: error instanceof Error ? error.message : "Steam news unavailable."
      });
    }
  }

  if (pathname === "/api/leaderboard") {
    if (req.method !== "GET") {
      return sendJson(res, 405, { message: "Method not allowed." });
    }
    try {
      const sheetId = String(requestUrl.searchParams.get("sheetId") || "1qh8yL1pgwBEGJ10cJZvfYOJhZKdeCrc5f9pkJ31nYy4").trim();
      const payload = await fetchLeaderboard(sheetId);
      return sendJson(res, 200, payload);
    } catch (error) {
      return sendJson(res, 502, {
        message: error instanceof Error ? error.message : "Leaderboard unavailable."
      });
    }
  }

  if (pathname === "/api/twitch-category-stats") {
    if (req.method !== "GET") {
      return sendJson(res, 405, { message: "Method not allowed." });
    }
    try {
      const categoryName = String(requestUrl.searchParams.get("name") || "").trim();
      if (!categoryName) {
        return sendJson(res, 200, {
          category: "",
          viewers: 0,
          live_channels: 0
        });
      }

      const payload = await fetchTwitchCategoryStats(categoryName);
      return sendJson(res, 200, payload);
    } catch (error) {
      return sendJson(res, 502, {
        message: error instanceof Error ? error.message : "Twitch category stats unavailable.",
        category: String(requestUrl.searchParams.get("name") || "").trim(),
        viewers: 0,
        live_channels: 0
      });
    }
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=UTF-8" });
    res.end("Method not allowed");
    return;
  }

  serveFile(req, res, pathname);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`CROWFORGE website listening on ${PORT}`);
});
