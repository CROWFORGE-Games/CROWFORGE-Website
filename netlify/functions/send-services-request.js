const COOLDOWN_SECONDS = 45;
const MIN_ELAPSED_MS = 3500;
const rateLimitStore = new Map();

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(payload),
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getClientIp(event) {
  const headers = event.headers || {};
  const forwarded = headers["x-forwarded-for"] || headers["X-Forwarded-For"];
  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }
  return (
    headers["client-ip"] ||
    headers["x-nf-client-connection-ip"] ||
    "unknown"
  );
}

exports.handler = async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { message: "Method not allowed." });
    }

    let payload = {};
    try {
      payload = event.body ? JSON.parse(event.body) : {};
    } catch {
      return json(400, { message: "Invalid request payload." });
    }

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
      return json(422, { message: "Bitte fülle Name, E-Mail, Paket und Projektziel aus." });
    }

    if (website !== "") {
      return json(400, { message: "Anfrage konnte nicht verarbeitet werden." });
    }

    const startedAtMs = /^\d+$/.test(formStartedAt) ? Number(formStartedAt) : 0;
    if (!startedAtMs) {
      return json(400, { message: "Bitte lade die Seite neu und versuche es erneut." });
    }

    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs < MIN_ELAPSED_MS) {
      return json(429, { message: "Die Anfrage wurde zu schnell gesendet. Bitte versuche es in ein paar Sekunden erneut." });
    }

    const ip = getClientIp(event);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const lastRequest = rateLimitStore.get(ip) || 0;
    if (nowSeconds - lastRequest < COOLDOWN_SECONDS) {
      return json(429, { message: "Bitte warte kurz, bevor du eine weitere Anfrage sendest." });
    }
    rateLimitStore.set(ip, nowSeconds);

    const resendApiKey = process.env.RESEND_API_KEY;
    const resendFrom =
      process.env.RESEND_FROM || "CROWFORGE Web Services <contact@crowforge-games.com>";
    const resendTo = process.env.RESEND_TO || "contact@crowforge-games.com";

    if (!resendApiKey) {
      return json(500, { message: "RESEND_API_KEY ist serverseitig nicht gesetzt." });
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
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: resendFrom,
        to: [resendTo],
        reply_to: email,
        subject: `Neue Web Services Anfrage - ${pkg}`,
        html,
        text: mailBody || goal,
      }),
    });

    const resendText = await resendResponse.text();
    let resendJson = {};
    try {
      resendJson = resendText ? JSON.parse(resendText) : {};
    } catch {
      resendJson = {};
    }

    if (!resendResponse.ok) {
      return json(500, {
        message:
          resendJson.message ||
          resendJson.error ||
          "Versand über Resend fehlgeschlagen.",
      });
    }

    return json(200, {
      message: "Anfrage erfolgreich gesendet.",
      id: resendJson.id || null,
    });
  } catch (error) {
    return json(500, {
      message: `Serverfehler beim Versand: ${error instanceof Error ? error.message : "Unbekannter Fehler"}`,
    });
  }
};
