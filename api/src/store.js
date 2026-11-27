"use strict";

const { Firestore, FieldValue, Timestamp } = require("@google-cloud/firestore");
const { sha1, namePlayerKey } = require("./sheet");
const periods = require("./periods");

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

// --- Hidden players ----------------------------------------------------------------------------
// games/{g}/hiddenPlayers/{playerKey} (written by the dashboard): the player keeps playing and sees
// their own rank, but is left out of every top list and does not push others down.
// playerKey = entry document id ("steam:<id>" or "name:<name>").

const hiddenCache = new Map();
const HIDDEN_CACHE_MS = 30 * 1000;

async function hiddenPlayers(gameId) {
  const cached = hiddenCache.get(gameId);
  if (cached && Date.now() - cached.at < HIDDEN_CACHE_MS) return cached.keys;
  let keys = new Set();
  try {
    const snap = await gameRef(gameId).collection("hiddenPlayers").get();
    keys = new Set(snap.docs.map((doc) => doc.id));
  } catch (error) {
    console.error("hiddenPlayers read failed", error);
    if (cached) return cached.keys;
  }
  hiddenCache.set(gameId, { at: Date.now(), keys });
  return keys;
}

/** Hidden entries of one collection with a value above `value` (they must not count for ranks). */
async function hiddenAbove(collection, hidden, field, value, ownKey) {
  const keys = [...hidden].filter((key) => key !== ownKey);
  if (!keys.length) return 0;
  const docs = await db.getAll(...keys.map((key) => collection.doc(key)));
  return docs.filter((doc) => doc.exists && (Number(doc.data()[field]) || 0) > value).length;
}

// --- Leaderboard -------------------------------------------------------------------------------

const topCache = new Map();
const TOP_CACHE_MS = 30 * 1000;

async function rankOf(gameId, boardId, score, ownKey) {
  const ref = entriesRef(gameId, boardId);
  const [snap, hidden] = await Promise.all([ref.where("score", ">", score).count().get(), hiddenPlayers(gameId)]);
  return snap.data().count - (await hiddenAbove(ref, hidden, "score", score, ownKey)) + 1;
}

async function getLeaderboard(gameId, boardId, { limit, name, steamId }) {
  const cacheKey = `${gameId}/${boardId}/${limit}`;
  let cached = topCache.get(cacheKey);
  if (!cached || Date.now() - cached.at > TOP_CACHE_MS) {
    // A player can have a Steam entry (new builds) and a name entry (old builds via sheet):
    // read a few more and keep only the best entry per name.
    const hidden = await hiddenPlayers(gameId);
    const snap = await entriesRef(gameId, boardId).orderBy("score", "desc").limit(Math.min(300 + hidden.size, limit * 3 + hidden.size)).get();
    const seen = new Set();
    const entries = [];
    for (const doc of snap.docs) {
      if (hidden.has(doc.id)) continue;
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
  let bestKey = null;
  if (steamId) {
    const doc = await entriesRef(gameId, boardId).doc(steamPlayerKey(steamId)).get();
    if (doc.exists) {
      best = doc.data();
      bestKey = doc.id;
    }
  }
  if (name) {
    const [byId, snap] = await Promise.all([
      entriesRef(gameId, boardId).doc(namePlayerKey(name)).get(),
      entriesRef(gameId, boardId).where("nameLower", "==", name.toLowerCase()).get()
    ]);
    for (const doc of [byId, ...snap.docs].filter((d) => d.exists)) {
      const d = doc.data();
      if (!best || d.score > best.score) {
        best = d;
        bestKey = doc.id;
      }
    }
  }
  if (best) me = { rank: await rankOf(gameId, boardId, best.score, bestKey), name: best.name, score: best.score };
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
  return { ...result, rank: await rankOf(gameId, boardId, result.best, ref.id) };
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

// --- Counters (e.g. beers tapped), summed per period ---------------------------------------------
// games/{g}/counters/{c}/periods/{periodKey}/entries/steam:{id}  {name, steamId, value, slots{}, updatedAt}
// games/{g}/counters/{c}/players/steam:{id}                      {lastAt}  (for the plausibility limit)
// games/{g}/counterFlags/{auto}                                  adds above the limit (shown in the dashboard)

const counterRef = (gameId, counterId) => gameRef(gameId).collection("counters").doc(counterId);
const counterEntriesRef = (gameId, counterId, key) => counterRef(gameId, counterId).collection("periods").doc(key).collection("entries");
const counterFlagsRef = (gameId) => gameRef(gameId).collection("counterFlags");

const MAX_ALLOWANCE_MINUTES = 24 * 60;
const FIRST_ADD_MINUTES = 60;

/** How much may be added after `minutes` since the last add (first add: one hour's worth). */
function counterAllowance(maxPerMinute, lastAtMs, nowMs) {
  const minutes = lastAtMs ? Math.min(MAX_ALLOWANCE_MINUTES, Math.max(1, (nowMs - lastAtMs) / 60000)) : FIRST_ADD_MINUTES;
  return Math.floor(maxPerMinute * minutes);
}

async function addToCounter(gameId, counterId, counter, { steamId, name, amount, slotId, version }, nowMs = Date.now()) {
  const player = steamPlayerKey(steamId);
  const keys = periods.currentKeys(nowMs);
  const playerRef = counterRef(gameId, counterId).collection("players").doc(player);
  const entryRefs = keys.map((key) => counterEntriesRef(gameId, counterId, key).doc(player));

  const result = await db.runTransaction(async (tx) => {
    const [state, ...entries] = await Promise.all([tx.get(playerRef), ...entryRefs.map((ref) => tx.get(ref))]);
    const lastAt = state.exists && state.data().lastAt ? state.data().lastAt.toMillis() : 0;
    const accepted = Math.min(amount, counterAllowance(counter.maxPerMinute, lastAt, nowMs));
    const now = Timestamp.fromMillis(nowMs);
    tx.set(playerRef, { lastAt: now, name, steamId }, { merge: true });
    const totals = {};
    entryRefs.forEach((ref, i) => {
      const previous = entries[i].exists ? Number(entries[i].data().value) || 0 : 0;
      totals[periods.PERIODS[i]] = previous + accepted;
      if (accepted <= 0) return;
      const data = { name, nameLower: name.toLowerCase(), steamId, value: FieldValue.increment(accepted), version: version || null, updatedAt: now };
      if (slotId) data.slots = { [slotId]: FieldValue.increment(accepted) };
      tx.set(ref, data, { merge: true });
    });
    return { accepted, totals };
  });

  const flagged = result.accepted < amount;
  if (flagged) {
    await counterFlagsRef(gameId).add({
      counterId, steamId, name, requested: amount, accepted: result.accepted, slotId: slotId || null,
      version: version || null, createdAt: FieldValue.serverTimestamp()
    });
  }
  return {
    accepted: result.accepted,
    flagged,
    total: result.totals.all,
    periods: { day: result.totals.day, week: result.totals.week, month: result.totals.month }
  };
}

// Open counters: games/{g}/counters/{c} {createdAt} marks a counter as existing (listed in the dashboard).
const knownCounters = new Set();

async function registerCounter(gameId, counterId) {
  const cacheKey = `${gameId}/${counterId}`;
  if (knownCounters.has(cacheKey)) return;
  const ref = counterRef(gameId, counterId);
  const doc = await ref.get();
  if (!doc.exists) {
    await ref.set({ createdAt: FieldValue.serverTimestamp(), source: "game" }, { merge: true });
  }
  knownCounters.add(cacheKey);
}

/** Sets the player's value (any integer >= 0, may go down). Plain value, no periods. */
async function setCounterValue(gameId, counterId, { steamId, name, value, slotId, version }, nowMs = Date.now()) {
  const ref = counterEntriesRef(gameId, counterId, "all").doc(steamPlayerKey(steamId));
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const previous = doc.exists ? Number(doc.data().value) || 0 : 0;
    const data = { name, nameLower: name.toLowerCase(), steamId, value, version: version || null, updatedAt: Timestamp.fromMillis(nowMs) };
    if (slotId) data.slots = { [slotId]: value };
    tx.set(ref, data, { merge: true });
    return { value, previous };
  });
}

/** The player's own value and rank (value 0, rank null when nothing was stored yet). */
async function getCounterValue(gameId, counterId, steamId) {
  const ref = counterEntriesRef(gameId, counterId, "all");
  const doc = await ref.doc(steamPlayerKey(steamId)).get();
  if (!doc.exists) return { counterId, value: 0, rank: null, exists: false };
  const value = Number(doc.data().value) || 0;
  return { counterId, value, rank: await counterRank(gameId, ref, value, doc.id), exists: true };
}

async function counterRank(gameId, ref, value, ownKey) {
  const [above, hidden] = await Promise.all([ref.where("value", ">", value).count().get(), hiddenPlayers(gameId)]);
  return above.data().count - (await hiddenAbove(ref, hidden, "value", value, ownKey)) + 1;
}

const counterTopCache = new Map();
const COUNTER_CACHE_MS = 15 * 1000;

async function getCounterLeaderboard(gameId, counterId, { period, offset, limit, steamId }) {
  const info = periods.periodInfo(period, offset);
  const ref = counterEntriesRef(gameId, counterId, info.key);
  const cacheKey = `${gameId}/${counterId}/${info.key}/${limit}`;
  let cached = counterTopCache.get(cacheKey);
  if (!cached || Date.now() - cached.at > COUNTER_CACHE_MS) {
    const hidden = await hiddenPlayers(gameId);
    const snap = await ref.orderBy("value", "desc").limit(limit + hidden.size).get();
    const entries = snap.docs
      .filter((doc) => !hidden.has(doc.id))
      .slice(0, limit)
      .map((doc, i) => ({ rank: i + 1, name: doc.data().name, value: Number(doc.data().value) || 0 }));
    cached = { at: Date.now(), entries };
    counterTopCache.set(cacheKey, cached);
  }
  let me = null;
  if (steamId) {
    const doc = await ref.doc(steamPlayerKey(steamId)).get();
    if (doc.exists) {
      const value = Number(doc.data().value) || 0;
      me = { rank: await counterRank(gameId, ref, value, doc.id), name: doc.data().name, value };
    }
  }
  return { counterId, ...info, entries: cached.entries, me };
}

module.exports = {
  addToCounter,
  registerCounter,
  setCounterValue,
  getCounterValue,
  getCounterLeaderboard,
  counterAllowance,
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
