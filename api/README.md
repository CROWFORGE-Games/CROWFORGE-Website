# crowforge-api

Game backend for CROWFORGE games on Cloud Run + Firestore. Separate Cloud Run service, so the website is not affected.

- Reads the legacy Google Sheet (`TavernLegendsRuntime`) once per hour and mirrors tickets and the
  Beer Tapped leaderboard into Firestore. The sheet is never written. Old game builds keep using Apps Script.
- New game versions write directly to this API.

## Endpoints

| Method | Path | Auth | Body / query | Response |
| --- | --- | --- | --- | --- |
| GET | `/v1/games/{gameId}/leaderboards/{boardId}` | none | `?limit=10&name=<player>` | `{entries:[{rank,name,score,version,updatedAt}], me:{rank,name,score}\|null}` |
| POST | `/v1/games/{gameId}/leaderboards/{boardId}/scores` | `X-Game-Key` | `{name, score, version}` | `{best, improved, rank}` |
| POST | `/v1/games/{gameId}/tickets` | `X-Game-Key` | `{reporter, title, description, build, totalDays, taverns:[{type,name,level,workers}]}` | `{id, duplicate}` |
| POST | `/internal/sync` | Google ID token (allow-listed e-mail) | – | sync report |
| GET | `/healthz` | none | – | `{ok:true}` |

Current ids: `gameId = tavern-legends`, `boardId = beer-tapped`.

**Limits:** score must be an integer `0..maxScore`, may rise by at most `maxIncreasePerSubmit` per submit,
max 2 submits per player per minute. Bug reports: 5 per IP per 10 minutes, identical reports stored once.

**Security caveat:** `X-Game-Key` ships inside the game build and can be extracted. Until Steam ticket auth is
added, anyone with the key can post scores and tickets. The limits above only reduce the damage.

## Firestore layout

```
games/{gameId}/leaderboards/{boardId}/entries/{playerKey}   name, score, version, verified, source, updatedAt
games/{gameId}/tickets/{ticketId}                            sheet_* (from sheet) or api_* (from game)
games/{gameId}/sync/{name}                                   row hashes of the last sheet sync
```

`playerKey = name:<lower-case name>` until Steam IDs are verified.

## Deploy (Cloud Shell)

One-time: newer projects build `--source` deploys with the Compute default service account, which needs build rights:

```
PROJECT_NUMBER=$(gcloud projects describe crowforge-platform --format='value(projectNumber)')
gcloud projects add-iam-policy-binding crowforge-platform \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role=roles/cloudbuild.builds.builder --condition=None
```

```
gcloud run deploy crowforge-api --source . --region europe-west3 \
  --service-account crowforge-api@crowforge-platform.iam.gserviceaccount.com \
  --allow-unauthenticated --max-instances 2 --memory 256Mi \
  --set-secrets GAME_KEY=crowforge-game-key:latest \
  --set-env-vars "^;^SYNC_ALLOWED_EMAILS=crowforge-api@crowforge-platform.iam.gserviceaccount.com,$(gcloud config get-value account)"
```

If the org policy *Domain restricted sharing* blocks `allUsers` ("Setting IAM policy failed"), make the
service public without touching the org policy:

```
gcloud run services update crowforge-api --region europe-west3 --no-invoker-iam-check
```

The sheet must be shared (Viewer) with `crowforge-api@crowforge-platform.iam.gserviceaccount.com`.

## Tests

```
npm install && npm test
```

## Sheet sync schedule

Cloud Shell user tokens have a different audience, so trigger the sync through Cloud Scheduler (uses the service account's OIDC token):

```
URL=$(gcloud run services describe crowforge-api --region europe-west3 --format='value(status.url)')
gcloud scheduler jobs create http crowforge-sheet-sync --location europe-west3 --schedule "0 * * * *" \
  --time-zone "Europe/Vienna" --uri "$URL/internal/sync" --http-method POST \
  --oidc-service-account-email crowforge-api@crowforge-platform.iam.gserviceaccount.com --oidc-token-audience "$URL"
gcloud scheduler jobs run crowforge-sheet-sync --location europe-west3   # run now
gcloud run services logs read crowforge-api --region europe-west3 --limit 5
```
