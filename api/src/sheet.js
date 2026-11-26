"use strict";

// Pure parsing helpers for the legacy Google Sheet. No I/O here so they can be unit tested.
const crypto = require("crypto");

const TIME_ZONE = "Europe/Vienna";

function sha1(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

function cell(row, index) {
  return String((row && row[index]) ?? "").trim();
}

function zoneOffsetMs(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - date.getTime();
}

// "18.07.2026 10:25" or "14.10.2026" (local time Vienna) -> Date, or null.
function parseSheetDate(raw) {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(String(raw || "").trim());
  if (!match) return null;
  const [, d, m, y, hh = "0", mm = "0"] = match;
  const guess = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm)));
  if (Number.isNaN(guess.getTime())) return null;
  return new Date(guess.getTime() - zoneOffsetMs(guess));
}

// Firestore doc id for a player without verified Steam ID. Encoded so it never contains "/".
function namePlayerKey(name) {
  return "name:" + encodeURIComponent(String(name).trim().toLowerCase());
}

// BeerTapped rows: [Steamname, Score, Date, Version]. Returns one entry per player (highest score wins).
function parseLeaderboardRows(values) {
  const byKey = new Map();
  for (const row of values || []) {
    const name = cell(row, 0);
    const score = Number.parseInt(cell(row, 1), 10);
    if (!name || !Number.isFinite(score) || score < 0) continue;
    const lower = name.toLowerCase();
    if (lower === "steamname" || lower === "steam name") continue;
    const entry = {
      key: namePlayerKey(name),
      name,
      score,
      version: cell(row, 3) || null,
      dateRaw: cell(row, 2) || null
    };
    const existing = byKey.get(entry.key);
    if (!existing || entry.score > existing.score) byKey.set(entry.key, entry);
  }
  return [...byKey.values()];
}

// ";small,The Spitting Dragon,7,Workers: 3;uncle,Black Eagle,3,Workers: 1" -> structured list.
function parseTaverns(raw) {
  const result = [];
  for (const part of String(raw || "").split(";")) {
    const fields = part.split(",").map((s) => s.trim());
    if (fields.length < 4 || !fields[0]) continue;
    const workersMatch = /(\d+)/.exec(fields[fields.length - 1]);
    const level = Number.parseInt(fields[fields.length - 2], 10);
    result.push({
      type: fields[0],
      name: fields.slice(1, -2).join(", "),
      level: Number.isFinite(level) ? level : null,
      workers: workersMatch ? Number(workersMatch[1]) : null
    });
  }
  return result;
}

// tickets rows: [createdat, reporter, title, description, status, build, totaldays, taverns, (empty), priority].
// Identical rows (double submits) map to the same id and are stored once.
function parseTicketRows(values) {
  const byId = new Map();
  for (const row of values || []) {
    const createdAtRaw = cell(row, 0);
    const reporter = cell(row, 1);
    const title = cell(row, 2);
    const description = cell(row, 3);
    if (!title && !description) continue;
    const id = "sheet_" + sha1([createdAtRaw, reporter, title, description].join("\u0001")).slice(0, 24);
    const totalDays = Number.parseInt(cell(row, 6), 10);
    byId.set(id, {
      id,
      createdAtRaw: createdAtRaw || null,
      reporter: reporter || null,
      title,
      description,
      status: cell(row, 4).toLowerCase() || "open",
      build: cell(row, 5) || null,
      totalDays: Number.isFinite(totalDays) ? totalDays : null,
      tavernsRaw: cell(row, 7) || null,
      taverns: parseTaverns(cell(row, 7)),
      priority: cell(row, 9).toLowerCase() || null
    });
  }
  return [...byId.values()];
}

function recordHash(record) {
  return sha1(JSON.stringify(record)).slice(0, 16);
}

module.exports = {
  sha1,
  parseSheetDate,
  namePlayerKey,
  parseLeaderboardRows,
  parseTaverns,
  parseTicketRows,
  recordHash
};
