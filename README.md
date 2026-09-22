# AI Radar

Continuous AI intelligence radar: scans trusted sources, aggregates, categorizes,
summarizes and alerts on the latest AI advancements. Single Next.js app, no
external database — the whole dataset is one JSON document.

```text
sources (RSS/Atom) -> scanner -> classifier/summarizer -> store -> dashboard + APIs
```

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000
```

No configuration is required for local development: data lives in
`data/db.json` and the in-process scheduler starts scanning automatically
(`ENABLE_SCHEDULER=true`, first pass ~4s after boot).

```bash
npm run scan                    # one sweep from the CLI
npm run scan -- --source=openai-news
npm run reindex                 # re-score the whole archive after tuning settings
npm run seed:export             # snapshot the store into data/seed/articles.seed.json
npm run typecheck && npm run lint && npm test && npm run build
```

## Storage

Persistence sits behind a small storage abstraction (`src/lib/storage`), so the
application never touches the filesystem or Vercel Blob directly:

```text
app code (src/lib/store.ts, src/lib/runtime.ts, routes, scripts)
        |
        v
  StorageBackend  (src/lib/storage/index.ts picks one)
   |                              |
   v                              v
local backend                 blob backend
data/db.json                   Vercel Blob -> news.json
(synchronous reads,            (async, ETag conditional writes,
 atomic tmp+rename writes)      application/json, no CDN caching)
```

| Environment | Backend | Document |
| --- | --- | --- |
| `npm run dev`, tests, self-hosted with no Blob token | local filesystem | `data/db.json` |
| Vercel deployment (`VERCEL` is set) | Vercel Blob | `news.json` |
| Production build with `BLOB_READ_WRITE_TOKEN` set | Vercel Blob | `news.json` |

`STORAGE_BACKEND` overrides the choice: `local`, `blob` or `auto` (default).
Selecting `auto` is what keeps development safe — `npm run dev` never reads or
writes the production Blob store unless you explicitly ask for it with
`STORAGE_BACKEND=blob`.

Nothing else changed: the news schema, crawling, deduplication, search, sorting,
API response formats and frontend behaviour are identical to the pre-Blob app.

### Local development

```text
crawler -> store -> data/db.json
```

* Reads are synchronous and the file is written atomically (temp file + rename),
  exactly as before.
* A missing `data/db.json` starts an empty (or seed-populated) store in memory;
  the file is created on the first change.
* An unreadable `data/db.json` is moved aside to
  `data/db.json.corrupt-<timestamp>` and the app continues from an empty store.
* `DATA_DIR` still points the store at another directory.

### Vercel (production)

1. Push the repository to a Vercel project.
2. **Storage → Create → Blob**, choose the access mode (private or public) and
   connect it to the project's Production/Preview environments. Vercel then sets
   `BLOB_READ_WRITE_TOKEN` for the deployment automatically.
3. Deploy. The first write creates `news.json` (content type
   `application/json`); later writes overwrite the same pathname.
4. Optionally set `BLOB_ACCESS` if the store is private
   (`BLOB_ACCESS=private`) and `BLOB_STORE_PATHNAME` for a different path or
   prefix (default `news.json`).

The deployment filesystem is never used for persistence: without a Blob store,
`/api/health` reports a `degraded` status with an actionable message instead of
silently losing writes.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `STORAGE_BACKEND` | `auto` | `auto`, `local` or `blob` — which persistence backend to use |
| `BLOB_READ_WRITE_TOKEN` | — | Vercel Blob read/write token (set automatically by Vercel) |
| `BLOB_STORE_PATHNAME` | `news.json` | Document path inside the Blob store |
| `BLOB_ACCESS` | `public` | Must match the Blob store access mode: `public` or `private` |
| `DATA_DIR` | `./data` | Directory holding `db.json` + the seed snapshot (local backend) |
| `MAX_ARTICLES`, `SEED_ON_EMPTY`, `SCAN_*`, `ENABLE_SCHEDULER`, `SUMMARIZER`, `OPENAI_*` | see `.env.example` | Scanner, store window and summarizer settings |

Secrets are never hard-coded and `.env*` files are git-ignored. Start from
`.env.example`.

## Concurrency and data safety

The store keeps one in-memory copy per server process and writes it with a
compare-and-swap loop:

1. check the stored version (local: file size + mtime, Blob: ETag),
2. if another writer moved the document on, re-read it and replay the pending
   changes on top,
3. write conditionally (`ifMatch` on Vercel Blob, version check on the file) and
   retry on a lost race (up to 3 attempts).

That prevents the classic read-modify-write loss where two writers each load the
document, each add their own change, and the slower one overwrites the other. It
covers a CLI scan running next to `npm run dev`, overlapping serverless
instances, and the manual "Scan now" button (which reuses the in-flight sweep).

Known limitations, documented rather than hidden:

* An in-process cache can be a few seconds stale in another instance; the store
  rebases on the next write, so no update is lost, but a read may briefly miss
  the newest articles.
* Mutating routes respond only after `await flush()`, so the change is on the
  backend before the response is sent. A request already in flight when a
  serverless instance is frozen can still lose its very last write.
* `ENABLE_SCHEDULER` runs a scan loop inside the server process. That is ideal
  for local development and long-lived Node servers, but on serverless every
  instance would run its own loop. For Vercel, disable it and drive the existing
  endpoint from a Cron Job instead:

  ```jsonc
  // vercel.json
  { "crons": [{ "path": "/api/scan", "schedule": "*/20 * * * *" }] }
  ```

  with `ENABLE_SCHEDULER=false` in the project's environment variables.

## Observability

`GET /api/health` returns the usual counters plus a `storage` block:

```json
{
  "status": "ok",
  "storage": {
    "backend": { "kind": "local", "label": "data/db.json", "reason": "local development" },
    "hydrated": true,
    "dirty": false,
    "pendingWrites": 0,
    "lastWriteAt": "2026-01-01T10:00:00.000Z",
    "lastError": null
  }
}
```

When the backend cannot be loaded the endpoint answers `503` with
`status: "degraded"` and the same block, which makes a misconfigured Blob token,
a network failure or an unreadable document obvious from one request. Storage
errors are also logged server-side (Vercel: Functions → Logs) with the backend
label and the failing operation; tokens are never logged.

## Project layout

```text
src/
  app/                 pages (all force-dynamic) + route handlers
  components/          client UI
  hooks/               live-update hook (SSE)
  instrumentation.ts   boots the store + in-process scan loop
  lib/
    storage/           storage abstraction: types.ts, local.ts, blob.ts, index.ts
    store.ts           in-memory document, mutations, conditional persistence
    runtime.ts         server-side read facade used by pages/routes
    scanner.ts         feed fetching + normalization pipeline
    scheduler.ts       in-process scan loop
    classify.ts        taxonomy, impact scoring, entity extraction
    summarize.ts       extractive (offline) or LLM summaries
    ...                query, stats, alerts, digest, format helpers
scripts/               CLI: scan, reindex, seed:export
tests/                 node:test suites for the storage layer
data/                  db.json (git-ignored) + optional seed snapshot
```

## Deploying to Vercel

```bash
npm run build   # local sanity check (build + type checking via next build)
vercel deploy   # or connect the Git repository
```

Checklist: Blob store connected (`BLOB_READ_WRITE_TOKEN` present),
`ENABLE_SCHEDULER=false` plus a Cron Job for `/api/scan` if you want continuous
scanning, and `GET /api/health` reporting `status: "ok"` with
`storage.backend.kind: "blob"`.

