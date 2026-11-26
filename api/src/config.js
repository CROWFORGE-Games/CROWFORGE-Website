"use strict";

// Per-game configuration. A new game = a new entry here (and its data lives under games/{gameId} in Firestore).
// keyEnv: environment variable holding that game's X-Game-Key (a Secret Manager secret in Cloud Run).
// One key per game, so a key extracted from one build cannot write into another game.
const games = {
  "tavern-legends": {
    keyEnv: "GAME_KEY",
    // Steam App ID for sign-in (ticket check). Set TL_STEAM_APP_ID in Cloud Run.
    steamAppId: process.env.TL_STEAM_APP_ID || "",
    // Sheet that the already shipped builds write to via Apps Script. Read-only for this service.
    sheetId: process.env.TL_SHEET_ID || "1qh8yL1pgwBEGJ10cJZvfYOJhZKdeCrc5f9pkJ31nYy4",
    ticketsRange: "tickets!A2:J",
    // Remote commands (dashboard -> game). Replaces row 2 of the "Commands" sheet for new builds.
    commands: { actions: ["SendMessage", "GiveGold", "Puke", "Reservation"] },
    leaderboards: {
      "beer-tapped": {
        sheetRange: "BeerTapped!A2:D",
        // Plausibility limits for scores sent by the new game version. Tune when real data is known.
        maxScore: 200000,
        maxIncreasePerSubmit: 20000
      }
    }
  },
  "werewolf-hunter": {
    keyEnv: "GAME_KEY_WEREWOLF_HUNTER",
    leaderboards: {}
  }
};

function gameKeyFor(gameId) {
  const game = games[gameId];
  return game && game.keyEnv ? String(process.env[game.keyEnv] || "").trim() : "";
}

module.exports = {
  games,
  port: Number(process.env.PORT || 8080),
  gameKeyFor,
  // E-mail addresses allowed to trigger /internal/sync with a Google ID token (Cloud Scheduler SA, admins).
  syncAllowedEmails: String(process.env.SYNC_ALLOWED_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
};
