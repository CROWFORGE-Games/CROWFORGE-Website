"use strict";
const test = require("node:test");
const assert = require("node:assert");

// In-memory stand-in for the few Firestore calls the sync uses.
const docs = new Map();
const ref = (path) => ({
  id: path.split("/").at(-1),
  path,
  get: async () => ({ id: path.split("/").at(-1), exists: docs.has(path), data: () => docs.get(path) }),
  set: async (data, opts) => docs.set(path, opts && opts.merge ? { ...(docs.get(path) || {}), ...data } : data)
});
const col = (path) => ({ doc: (id) => ref(`${path}/${id}`) });
const store = require("../src/store");
store.db = {
  getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
  bulkWriter: () => {
    const ops = [];
    return { set: (r, data, opts) => ops.push(() => r.set(data, opts)), close: async () => { for (const op of ops) await op(); } };
  }
};
store.ticketsRef = (g) => col(`games/${g}/tickets`);
store.entriesRef = (g, b) => col(`games/${g}/leaderboards/${b}/entries`);
store.syncStateRef = (g, name) => ref(`games/${g}/sync/${name}`);
const { syncTickets } = require("../src/sync");

const row = (status, priority, title = "Bug") => ["26.11.2026 18:00", "Player", title, "Desc", status, "1.1", "3", "", "", priority];

test("sheet status/priority do not overwrite tickets the dashboard manages", async () => {
  await syncTickets("tl", [row("open", "low"), row("open", "low", "Other")]);
  const ids = [...docs.keys()].filter((k) => k.startsWith("games/tl/tickets/"));
  assert.strictEqual(ids.length, 2);
  const [managedId, otherId] = ids;
  await ref(managedId).set({ status: "closed", priority: "high", managedBy: "dashboard" }, { merge: true });

  // The sheet row changes (e.g. someone edits the status column) -> both rows are re-synced.
  await syncTickets("tl", [row("open", "mid"), row("closed", "mid", "Other")]);
  assert.strictEqual(docs.get(managedId).status, "closed");
  assert.strictEqual(docs.get(managedId).priority, "high");
  assert.strictEqual(docs.get(otherId).status, "closed");
  assert.strictEqual(docs.get(otherId).priority, "mid");
});
