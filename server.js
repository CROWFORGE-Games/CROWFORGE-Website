const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const COOLDOWN_SECONDS = 45;
const MIN_ELAPSED_MS = 3500;
const rateLimitStore = new Map();

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
