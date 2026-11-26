"use strict";

// One-way sync: legacy Google Sheet -> Firestore. Idempotent and cheap: a hash per row is kept in one
// state document, so only changed rows are read and written. The sheet is never modified.
const { GoogleAuth } = require("google-auth-library");
const { games } = require("./config");
const { parseLeaderboardRows, parseTicketRows, parseSheetDate, recordHash } = require("./sheet");
const { db, Timestamp, FieldValue, entriesRef, ticketsRef, syncStateRef } = require("./store");

const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });

async function readRanges(sheetId, ranges) {
  const client = await auth.getClient();
  const query = ranges.map((r) => "ranges=" + encodeURIComponent(r)).join("&");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values:batchGet?${query}`;
  const res = await client.request({ url });
  return (res.data.valueRanges || []).map((vr) => vr.values || []);
}

async function changedSince(stateName, gameId, records, idOf) {
  const stateDoc = await syncStateRef(gameId, stateName).get();
  const oldHashes = (stateDoc.exists && stateDoc.data().hashes) || {};
  const newHashes = {};
  const changed = [];
  for (const record of records) {
    const id = idOf(record);
    const hash = recordHash(record);
    newHashes[id] = hash;
    if (oldHashes[id] !== hash) changed.push(record);
  }
  return { changed, newHashes };
}

async function saveState(gameId, stateName, hashes, rows) {
  await syncStateRef(gameId, stateName).set({ hashes, rows, syncedAt: FieldValue.serverTimestamp() });
}

async function syncLeaderboard(gameId, boardId, values) {
  const records = parseLeaderboardRows(values);
  const stateName = `leaderboard_${boardId}`;
  const { changed, newHashes } = await changedSince(stateName, gameId, records, (r) => r.key);
  const col = entriesRef(gameId, boardId);
  let written = 0;
  let keptHigher = 0;
  const writer = db.bulkWriter();
  for (let i = 0; i < changed.length; i += 300) {
    const chunk = changed.slice(i, i + 300);
    const docs = await db.getAll(...chunk.map((r) => col.doc(r.key)));
    chunk.forEach((record, j) => {
      const existing = docs[j].exists ? docs[j].data() : null;
      // Never lower a score: the new game version may already have sent a higher one.
      if (existing && existing.score > record.score) {
        keptHigher++;
        return;
      }
      const date = parseSheetDate(record.dateRaw);
      writer.set(
        col.doc(record.key),
        {
          name: record.name,
          nameLower: record.name.toLowerCase(),
          score: record.score,
          version: record.version,
          verified: false,
          source: existing && existing.source === "api" ? "api" : "sheet",
          sheetDate: record.dateRaw,
          updatedAt: date ? Timestamp.fromDate(date) : FieldValue.serverTimestamp()
        },
        { merge: true }
      );
      written++;
    });
  }
  await writer.close();
  await saveState(gameId, stateName, newHashes, records.length);
  return { rows: records.length, changed: changed.length, written, keptHigher };
}

async function syncTickets(gameId, values) {
  const records = parseTicketRows(values);
  const { changed, newHashes } = await changedSince("tickets", gameId, records, (r) => r.id);
  const col = ticketsRef(gameId);
  const writer = db.bulkWriter();
  for (const record of changed) {
    const { id, ...data } = record;
    const date = parseSheetDate(record.createdAtRaw);
    writer.set(
      col.doc(id),
      {
        ...data,
        source: "sheet",
        createdAt: date ? Timestamp.fromDate(date) : null,
        syncedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  }
  await writer.close();
  await saveState(gameId, "tickets", newHashes, records.length);
  return { rows: records.length, changed: changed.length, written: changed.length };
}

async function syncAll() {
  const report = {};
  for (const [gameId, game] of Object.entries(games)) {
    if (!game.sheetId) continue;
    const boards = Object.entries(game.leaderboards || {});
    const ranges = [game.ticketsRange, ...boards.map(([, b]) => b.sheetRange)];
    const [ticketValues, ...boardValues] = await readRanges(game.sheetId, ranges);
    report[gameId] = { tickets: await syncTickets(gameId, ticketValues), leaderboards: {} };
    for (let i = 0; i < boards.length; i++) {
      report[gameId].leaderboards[boards[i][0]] = await syncLeaderboard(gameId, boards[i][0], boardValues[i]);
    }
  }
  return report;
}

module.exports = { syncAll };
