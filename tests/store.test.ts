/**
 * Storage layer tests.
 *
 * These cover the migration contract: local development still reads and writes
 * `data/db.json`, existing articles survive a write, deduplication still folds
 * cross-source duplicates, an unreadable document is never overwritten, and a
 * document written by somebody else is merged rather than clobbered.
 *
 * Run with: npm test  (node --import tsx --test tests)
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { createBlobBackend } from "../src/lib/storage/blob";
import { createLocalBackend } from "../src/lib/storage/local";
import {
  StorageConflictError,
  resolveStorageBackend,
  resolveStorageTarget,
  resetStorageBackend,
} from "../src/lib/storage";
import {
  ensureStoreLoaded,
  flush,
  getDb,
  getStoreStatus,
  insertArticles,
  mutate,
  resetStoreCache,
} from "../src/lib/store";
import type { Article } from "../src/lib/types";

const TRACKED_ENV = [
  "DATA_DIR",
  "STORAGE_BACKEND",
  "BLOB_READ_WRITE_TOKEN",
  "BLOB_ACCESS",
  "BLOB_STORE_PATHNAME",
  "BLOB_STORE_ID",
  "VERCEL",
  "VERCEL_OIDC_TOKEN",
  "NODE_ENV",
  "SEED_ON_EMPTY",
] as const;

const savedEnv = new Map<string, string | undefined>();
let dataDir = "";

beforeEach(() => {
  if (savedEnv.size === 0) {
    for (const key of TRACKED_ENV) savedEnv.set(key, process.env[key]);
  }
  for (const key of TRACKED_ENV) delete process.env[key];

  dataDir = mkdtempSync(path.join(tmpdir(), "ai-radar-store-"));
  process.env.DATA_DIR = dataDir;

  resetStorageBackend();
  resetStoreCache();
});

afterEach(() => {
  resetStoreCache();
  resetStorageBackend();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});


/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function makeArticle(
  input: Omit<Pick<Article, "id" | "title" | "sourceId" | "publishedAt">, never> &
    Partial<Omit<Article, "id" | "title" | "sourceId" | "publishedAt">>,
): Article {
  const now = new Date().toISOString();
  const rest: Partial<Article> = { ...input };
  delete rest.id;
  delete rest.title;
  delete rest.sourceId;
  delete rest.publishedAt;
  return {
    id: input.id,
    title: input.title,
    url: `https://example.com/${input.id}`,
    canonicalUrl: `https://example.com/${input.id}`,
    sourceId: input.sourceId,
    sourceName: input.sourceId,
    sourceKind: "media",
    author: null,
    publishedAt: input.publishedAt,
    fetchedAt: now,
    updatedAt: now,
    excerpt: `${input.title} body`,
    summary: `${input.title} summary`,
    summaryMethod: "excerpt",
    keyPoints: [],
    category: "models",
    secondaryCategories: [],
    categoryConfidence: 0.5,
    tags: ["benchmark"],
    entities: { companies: [], models: [], people: [], technologies: [] },
    impact: 50,
    relevance: 50,
    signals: [],
    sentiment: "neutral",
    isBreaking: false,
    alsoCoveredBy: [],
    read: false,
    bookmarked: false,
    duplicateOf: null,
    wordCount: 120,
    readingMinutes: 1,
    ...rest,
  };
}

function writeDocument(articles: Article[]): void {
  const now = new Date().toISOString();
  writeFileSync(
    path.join(dataDir, "db.json"),
    JSON.stringify({
      version: 1,
      createdAt: now,
      updatedAt: now,
      articles,
      sources: [],
      alerts: [],
      alertEvents: [],
      runs: [],
      settings: { scanIntervalMinutes: 20, maxArticles: 4000 },
      meta: { lastScanAt: null, lastScanTrigger: null, scansCompleted: 0, totalArticlesAdded: articles.length },
    }),
    "utf8",
  );
}

function readDocument(): { articles: Article[]; settings: { scanIntervalMinutes: number } } {
  return JSON.parse(readFileSync(path.join(dataDir, "db.json"), "utf8"));
}

const OLD_ARTICLE = makeArticle({
  id: "old-1",
  title: "Open weights model released by a large lab",
  sourceId: "lab-news",
  publishedAt: new Date(Date.now() - 3_600_000).toISOString(),
});

const SECOND_ARTICLE = makeArticle({
  id: "old-2",
  title: "Datacenter build-out accelerates across three regions",
  sourceId: "infra-daily",
  publishedAt: new Date(Date.now() - 7_200_000).toISOString(),
});

/* -------------------------------------------------------------------------- */
/*  Backend resolution                                                         */
/* -------------------------------------------------------------------------- */

describe("storage backend resolution", () => {
  test("auto keeps development on the local file", () => {
    const target = resolveStorageTarget();
    assert.equal(target.kind, "local");
    assert.match(target.reason, /local/i);
    assert.equal(resolveStorageBackend().kind, "local");
  });

  test("auto selects Vercel Blob when deployed to Vercel", () => {
    process.env.VERCEL = "1";
    const target = resolveStorageTarget();
    assert.equal(target.kind, "blob");
    assert.match(target.reason, /Vercel/);
  });

  test("auto selects Vercel Blob for a production build with a Blob token", () => {
    (process.env as { NODE_ENV?: string }).NODE_ENV = "production";
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test";
    assert.equal(resolveStorageTarget().kind, "blob");
  });

  test("an explicit STORAGE_BACKEND wins over detection", () => {
    process.env.VERCEL = "1";
    process.env.STORAGE_BACKEND = "local";
    assert.equal(resolveStorageTarget().kind, "local");

    delete process.env.VERCEL;
    process.env.STORAGE_BACKEND = "blob";
    assert.equal(resolveStorageTarget().kind, "blob");
  });

  test("blob without credentials fails with an actionable message", () => {
    process.env.STORAGE_BACKEND = "blob";
    assert.throws(() => resolveStorageBackend(), /BLOB_READ_WRITE_TOKEN/);
  });

  test("blob diagnostics never expose the token", () => {
    const backend = createBlobBackend({ pathname: "news.json", access: "private", token: "super-secret" });
    assert.equal(backend.kind, "blob");
    assert.equal(backend.label, "vercel-blob:news.json");
    assert.deepEqual(backend.describe(), {
      kind: "blob",
      label: "vercel-blob:news.json",
      pathname: "news.json",
      access: "private",
      explicitToken: true,
    });
    assert.ok(!JSON.stringify(backend.describe()).includes("super-secret"));
  });
});

/* -------------------------------------------------------------------------- */
/*  Local backend (conditional writes)                                         */
/* -------------------------------------------------------------------------- */

describe("local backend conditional writes", () => {
  test("first write is allowed only on an empty document", async () => {
    const backend = createLocalBackend({ dir: dataDir, fileName: "db.json" });
    assert.equal(await backend.stat(), null);

    const first = await backend.write('{"a":1}', { expectedEtag: null });
    assert.ok(first.meta.etag);

    await assert.rejects(
      () => backend.write('{"b":"longer-payload"}', { expectedEtag: null }),
      StorageConflictError,
    );
  });

  test("a write with a stale etag is rejected, the current etag is accepted", async () => {
    const backend = createLocalBackend({ dir: dataDir, fileName: "db.json" });
    const first = await backend.write('{"a":1}', { expectedEtag: null });
    await backend.write('{"b":"longer-payload"}', { expectedEtag: first.meta.etag });

    await assert.rejects(
      () => backend.write('{"c":3}', { expectedEtag: first.meta.etag }),
      StorageConflictError,
    );

    const current = await backend.stat();
    const third = await backend.write('{"c":3}', { expectedEtag: current?.etag ?? null });
    assert.notEqual(third.meta.etag, current?.etag);
    assert.equal((await backend.read())?.json, '{"c":3}');
  });

  test("stat reports size, etag and mtime", async () => {
    const backend = createLocalBackend({ dir: dataDir, fileName: "db.json" });
    await backend.write('{"a":1}', { expectedEtag: null });
    const status = await backend.stat();
    assert.ok(status);
    assert.equal(status.size, '{"a":1}'.length);
    assert.ok(status.etag.length > 0);
    assert.ok(status.updatedAt === null || typeof status.updatedAt === "string");
  });
});

/* -------------------------------------------------------------------------- */
/*  Store: hydration and persistence                                           */
/* -------------------------------------------------------------------------- */

describe("store hydration and persistence (local)", () => {
  test("a missing document starts empty and writes nothing until a change", async () => {
    await ensureStoreLoaded();
    assert.equal(getDb().articles.length, 0);
    const status = getStoreStatus();
    assert.equal(status.backend.kind, "local");
    assert.equal(status.hydrated, true);
    assert.equal(status.dirty, false);
    assert.equal(existsSync(path.join(dataDir, "db.json")), false);
  });

  test("existing data is read and survives a write", async () => {
    writeDocument([OLD_ARTICLE, SECOND_ARTICLE]);

    resetStorageBackend();
    resetStoreCache();
    await ensureStoreLoaded();
    assert.equal(getDb().articles.length, 2);
    assert.deepEqual(
      getDb().articles.map((article) => article.id).sort(),
      ["old-1", "old-2"],
    );

    const added = insertArticles([
      makeArticle({
        id: "new-1",
        title: "Agents get cheaper tool calls with new caching mode",
        sourceId: "ai-weekly",
        publishedAt: new Date().toISOString(),
      }),
    ]);
    assert.equal(added.added.length, 1);
    assert.equal(added.merged, 0);

    await flush();
    assert.equal(getStoreStatus().pendingWrites, 0);
    assert.equal(getStoreStatus().dirty, false);

    const persisted = readDocument();
    assert.equal(persisted.articles.length, 3);
    assert.ok(persisted.articles.some((article) => article.id === "old-1"));
    assert.ok(persisted.articles.some((article) => article.id === "new-1"));
  });

  test("cross-source duplicates are still merged, not added", async () => {
    writeDocument([OLD_ARTICLE]);

    resetStorageBackend();
    resetStoreCache();
    await ensureStoreLoaded();
    assert.equal(getDb().articles.length, 1);

    const result = insertArticles([
      makeArticle({
        id: "dup-1",
        title: "Open weights model released by a large lab",
        sourceId: "wire-report",
        publishedAt: new Date(Date.now() - 1_800_000).toISOString(),
      }),
    ]);
    assert.equal(result.added.length, 0);
    assert.ok(result.merged >= 1);
    assert.equal(getDb().articles.length, 1);
    assert.ok(getDb().articles[0].alsoCoveredBy.includes("wire-report"));
  });

  test("a document written by someone else is rebased, not clobbered", async () => {
    writeDocument([OLD_ARTICLE]);
    resetStorageBackend();
    resetStoreCache();
    await ensureStoreLoaded();
    assert.equal(getDb().articles.length, 1);

    // Our process makes a change but does not flush yet.
    mutate((document) => {
      document.settings.scanIntervalMinutes = 42;
    });
    assert.equal(getStoreStatus().dirty, true);
    assert.equal(getStoreStatus().pendingWrites, 1);

    // A second writer (another instance / CLI) persists its own copy meanwhile.
    const external = readDocument();
    external.articles.push(
      makeArticle({
        id: "external-1",
        title: "External writer added this story while we were busy",
        sourceId: "other-node",
        publishedAt: new Date().toISOString(),
      }),
    );
    external.settings.scanIntervalMinutes = 20;
    writeFileSync(path.join(dataDir, "db.json"), JSON.stringify(external), "utf8");

    // Our flush must merge on top of the external copy.
    await flush();

    const persisted = readDocument();
    assert.equal(persisted.settings.scanIntervalMinutes, 42);
    assert.equal(persisted.articles.length, 2);
    assert.ok(persisted.articles.some((article) => article.id === "external-1"));
    assert.equal(getStoreStatus().pendingWrites, 0);
    assert.equal(getStoreStatus().lastError, null);
  });

  test("an unreadable document is quarantined, never overwritten", async () => {
    writeFileSync(path.join(dataDir, "db.json"), "{definitely not json", "utf8");

    await ensureStoreLoaded();
    assert.equal(getDb().articles.length, 0);

    const files = readdirSync(dataDir);
    assert.ok(files.some((name) => name.startsWith("db.json.corrupt-")));
  });

  test("SEED_ON_EMPTY hydrates from the committed seed snapshot", async () => {
    mkdirSync(path.join(dataDir, "seed"), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      path.join(dataDir, "seed", "articles.seed.json"),
      JSON.stringify({
        exportedAt: now,
        articles: [OLD_ARTICLE],
        sources: [],
      }),
      "utf8",
    );

    await ensureStoreLoaded();
    assert.equal(getDb().articles.length, 1);
    assert.equal(getDb().articles[0].id, "old-1");
  });
});



