"use strict";

// Per-game configuration. A new game = a new entry here (and its data lives under games/{gameId} in Firestore).
const games = {
  "tavern-legends": {
    // Sheet that the already shipped builds write to via Apps Script. Read-only for this service.
    sheetId: process.env.TL_SHEET_ID || "1qh8yL1pgwBEGJ10cJZvfYOJhZKdeCrc5f9pkJ31nYy4",
    ticketsRange: "tickets!A2:J",
    leaderboards: {
      "beer-tapped": {
        sheetRange: "BeerTapped!A2:D",
        // Plausibility limits for scores sent by the new game version. Tune when real data is known.
        maxScore: 200000,
        maxIncreasePerSubmit: 20000
      }
    }
  }
};

module.exports = {
  games,
  port: Number(process.env.PORT || 8080),
  gameKey: String(process.env.GAME_KEY || "").trim(),
  // E-mail addresses allowed to trigger /internal/sync with a Google ID token (Cloud Scheduler SA, admins).
  syncAllowedEmails: String(process.env.SYNC_ALLOWED_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
};
