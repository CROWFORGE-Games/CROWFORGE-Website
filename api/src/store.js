"use strict";

const { Firestore, FieldValue, Timestamp } = require("@google-cloud/firestore");
const { sha1, namePlayerKey } = require("./sheet");

const db = new Firestore({ ignoreUndefinedProperties: true });

const gameRef = (gameId) => db.collection("games").doc(gameId);
const entriesRef = (gameId, boardId) => gameRef(gameId).collection("leaderboards").doc(boardId).collection("entries");
const ticketsRef = (gameId) => gameRef(gameId).collection("tickets");
const syncStateRef = (gameId, name) => gameRef(gameId).collection("sync").doc(name);
const commandsRef = (gameId) => gameRef(gameId).collection("commands");

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// --- Leaderboard -------------------------------------------------------------------------------

const topCache = new Map();
const TOP_CACHE_MS = 30 * 1000;

async function rankOf(gameId, boardId, score) {
  const snap = await entriesRef(gameId, boardId).where("score", ">", score).count().get();
  return snap.data().count + 1;
}

async function getLeaderboard(gameId, boardId, { limit, name, steamId }) {
  const cacheKey = `${gameId}/${boardId}/${limit}`;
  let cached = topCache.get(cacheKey);
  if (!cached || Date.now() - cached.at > TOP_CACHE_MS) {
    // A player can have a Steam entry (new builds) and a name entry (old builds via sheet):
    // read a few more and keep only the best entry per name.
    const snap = await entriesRef(gameId, boardId).orderBy("score", "desc").limit(Math.min(300, limit * 3)).get();
    const seen = new Set();
    const entries = [];
    for (const doc of snap.docs) {
      const d = doc.data();
      const key = String(d.nameLower || d.name || doc.id).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        rank: entries.length + 1,
        name: d.name,
        score: d.score,
        version: d.version || null,
        verified: Boolean(d.steamId),
        updatedAt: d.updatedAt ? d.updatedAt.toDate().toISOString() : null
      });
      if (entries.length >= limit) break;
    }
    cached = { at: Date.now(), entries };
    topCache.set(cacheKey, cached);
  }

  let me = null;
  let best = null;
  if (steamId) {
    const doc = await entriesRef(gameId, boardId).doc(steamPlayerKey(steamId)).get();
    if (doc.exists) best = doc.data();
  }
  if (name) {
    const snap = await entriesRef(gameId, boardId).where("nameLower", "==", name.toLowerCase()).get();
    for (const doc of snap.docs) {
      const d = doc.data();
      if (!best || d.score > best.score) best = d;
    }
  }
  if (best) me = { rank: await rankOf(gameId, boardId, best.score), name: best.name, score: best.score };
  return { entries: cached.entries, me };
}

const steamPlayerKey = (steamId) => "steam:" + String(steamId);

/** steamId set = signed in with Steam (verified), otherwise keyed by name like the old builds. */
async function submitScore(gameId, boardId, board, { name, score, version, steamId }) {
  const ref = entriesRef(gameId, boardId).doc(steamId ? steamPlayerKey(steamId) : namePlayerKey(name));
  const result = await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const previous = doc.exists ? doc.data().score : null;
    if (previous !== null && score <= previous) {
      // updatedAt = last time the player sent a score (dashboard "played today").
      tx.update(ref, { updatedAt: FieldValue.serverTimestamp() });
      return { best: previous, improved: false };
    }
    if (previous !== null && board.maxIncreasePerSubmit && score - previous > board.maxIncreasePerSubmit) {
      throw new ApiError(422, "Score increase not plausible.");
    }
    tx.set(
      ref,
      {
        name,
        nameLower: name.toLowerCase(),
        score,
        version: version || null,
        steamId: steamId || null,
        verified: Boolean(steamId),
        source: "api",
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    return { best: score, improved: true };
  });
  if (result.improved) {
    for (const key of topCache.keys()) if (key.startsWith(`${gameId}/${boardId}/`)) topCache.delete(key);
  }
  return { ...result, rank: await rankOf(gameId, boardId, result.best) };
}

// --- Tickets -----------------------------------------------------------------------------------

async function createTicket(gameId, ticket) {
  // Same reporter + title + description = same document, so double submits are stored once.
  const id = "api_" + sha1([ticket.reporter, ticket.title, ticket.description].join("\u0001")).slice(0, 24);
  const ref = ticketsRef(gameId).doc(id);
  try {
    await ref.create({
      ...ticket,
      status: "open",
      priority: null,
      source: "api",
      createdAt: FieldValue.serverTimestamp()
    });
    return { id, duplicate: false };
  } catch (error) {
    if (error && error.code === 6) return { id, duplicate: true }; // ALREADY_EXISTS
    throw error;
  }
}

// --- Remote commands ---------------------------------------------------------------------------
// Written by the dashboard (games/{gameId}/commands), read by the game. A command stays active until
// expiresAt; the game remembers which ids it already ran, so every command runs once per session.

const commandsCache = new Map();
const COMMANDS_CACHE_MS = 3 * 1000;

async function activeCommands(gameId) {
  const cached = commandsCache.get(gameId);
  if (cached && Date.now() - cached.at < COMMANDS_CACHE_MS) return cached.commands;
  const snap = await commandsRef(gameId).where("expiresAt", ">", Timestamp.now()).get();
  const commands = snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((c) => !c.deleted)
    .map((c) => ({
      id: c.id,
      target: String(c.target || "").toLowerCase(),
      action: String(c.action || ""),
      param: String(c.param ?? ""),
      createdAt: c.createdAt && c.createdAt.toDate ? c.createdAt.toDate().toISOString() : null
    }))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  commandsCache.set(gameId, { at: Date.now(), commands });
  return commands;
}

async function getCommands(gameId, { player }) {
  const name = String(player || "").trim().toLowerCase();
  const commands = (await activeCommands(gameId))
    .filter((c) => c.action && name && c.target === name)
    .map(({ id, action, param, createdAt }) => ({ id, action, param, createdAt }));
  return { commands, serverTime: new Date().toISOString() };
}

module.exports = {
  db,
  Timestamp,
  FieldValue,
  ApiError,
  entriesRef,
  ticketsRef,
  syncStateRef,
  getLeaderboard,
  submitScore,
  createTicket,
  commandsRef,
  getCommands
};
