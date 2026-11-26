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

async function getLeaderboard(gameId, boardId, { limit, name }) {
  const cacheKey = `${gameId}/${boardId}/${limit}`;
  let cached = topCache.get(cacheKey);
  if (!cached || Date.now() - cached.at > TOP_CACHE_MS) {
    const snap = await entriesRef(gameId, boardId).orderBy("score", "desc").limit(limit).get();
    const entries = snap.docs.map((doc, i) => {
      const d = doc.data();
      return {
        rank: i + 1,
        name: d.name,
        score: d.score,
        version: d.version || null,
        updatedAt: d.updatedAt ? d.updatedAt.toDate().toISOString() : null
      };
    });
    cached = { at: Date.now(), entries };
    topCache.set(cacheKey, cached);
  }

  let me = null;
  if (name) {
    const doc = await entriesRef(gameId, boardId).doc(namePlayerKey(name)).get();
    if (doc.exists) {
      const d = doc.data();
      me = { rank: await rankOf(gameId, boardId, d.score), name: d.name, score: d.score };
    }
  }
  return { entries: cached.entries, me };
}

async function submitScore(gameId, boardId, board, { name, score, version }) {
  const ref = entriesRef(gameId, boardId).doc(namePlayerKey(name));
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
        verified: false,
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
