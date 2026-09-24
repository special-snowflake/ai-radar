/**
 * Three-way JSON merge used when a durable pending record is recovered.
 *
 * The primary write path replays the *pending mutations* (`MutationThunk`s) on
 * top of a fresh document, which is precise but only possible inside the
 * process that made them. Once a change set has been handed to the durable
 * fallback (see `store.ts`), all we have is the document before and after those
 * changes, so recovery has to merge documents instead.
 *
 * Rules, chosen to match the "local changes win, nothing gets clobbered"
 * behaviour of the replay path as closely as documents allow:
 *
 *   - only one side changed a value  -> that side wins;
 *   - both changed, plain objects    -> merge key by key (recursively);
 *   - both changed, arrays of objects with an `id` -> union by id, so items
 *     another writer added are kept and items it deleted stay deleted;
 *   - both changed anything else (scalars, primitive arrays) -> the recovered
 *     local change set wins, because that is the change the user made and it
 *     would otherwise be dropped.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

/** Sentinel for "this side has no such key/value at all". */
const MISSING = Symbol("missing");
type Maybe<T> = T | typeof MISSING;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idOf(value: unknown): string | null {
  return isObject(value) && typeof value.id === "string" ? value.id : null;
}

function indexById(items: JsonValue[]): Map<string, JsonValue> {
  const index = new Map<string, JsonValue>();
  for (const item of items) {
    const id = idOf(item);
    if (id !== null) index.set(id, item);
  }
  return index;
}

/** True when every entry carries a string `id`, making a union-by-id meaningful. */
function isIdKeyed(items: unknown): items is JsonValue[] {
  return Array.isArray(items) && items.length > 0 && items.every((item) => idOf(item) !== null);
}

/** Structural equality for JSON values (only used on the recovery path). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

function kindOf(value: Maybe<JsonValue>): "missing" | "array" | "object" | "scalar" {
  if (value === MISSING) return "missing";
  if (Array.isArray(value)) return "array";
  if (isObject(value)) return "object";
  return "scalar";
}

function pick(value: Maybe<JsonObject>, key: string): Maybe<JsonValue> {
  if (value === MISSING) return MISSING;
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : MISSING;
}

function mergeValue(base: Maybe<JsonValue>, local: Maybe<JsonValue>, remote: Maybe<JsonValue>): Maybe<JsonValue> {
  if (local === MISSING) return remote;
  if (remote === MISSING) return local;
  if (jsonEqual(local, base)) return remote;
  if (jsonEqual(remote, base)) return local;

  const localKind = kindOf(local);
  const remoteKind = kindOf(remote);
  if (localKind === "array" && remoteKind === "array") {
    return mergeArray(
      kindOf(base) === "array" ? (base as JsonValue[]) : MISSING,
      local as JsonValue[],
      remote as JsonValue[],
    );
  }
  if (localKind === "object" && remoteKind === "object") {
    return mergeObject(
      kindOf(base) === "object" ? (base as JsonObject) : MISSING,
      local as JsonObject,
      remote as JsonObject,
    );
  }
  return local;
}

function mergeObject(base: Maybe<JsonObject>, local: JsonObject, remote: JsonObject): JsonObject {
  const merged: JsonObject = {};
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const key of keys) {
    const value = mergeValue(pick(base, key), pick(local, key), pick(remote, key));
    if (value !== MISSING) merged[key] = value;
  }
  return merged;
}

function mergeArray(base: Maybe<JsonValue[]>, local: JsonValue[], remote: JsonValue[]): JsonValue[] {
  // Opaque arrays (tags, key points, interest weights): a union would be
  // meaningless, so the recovered change set wins.
  if (!isIdKeyed(local) || !isIdKeyed(remote)) return local;

  const baseById = indexById(base === MISSING ? [] : base);
  const remoteById = indexById(remote);
  const merged: JsonValue[] = [];
  const seen = new Set<string>();

  for (const item of local) {
    const id = idOf(item) as string;
    seen.add(id);
    const remoteItem = remoteById.get(id);
    if (remoteItem === undefined) {
      // Another writer removed it: respect the removal, exactly like replaying
      // a local mutation against a document it no longer contains.
      if (!baseById.has(id)) merged.push(item);
      continue;
    }
    const baseItem = baseById.get(id);
    merged.push(mergeValue(baseItem === undefined ? MISSING : baseItem, item, remoteItem) as JsonValue);
  }

  for (const item of remote) {
    const id = idOf(item) as string;
    if (seen.has(id) || baseById.has(id)) continue; // already merged, or removed locally
    merged.push(item);
  }

  return merged;
}

function parseJson(json: string): JsonValue | null {
  try {
    return (JSON.parse(json) as JsonValue) ?? null;
  } catch {
    return null;
  }
}

/**
 * Merge a recovered change set onto the document that is stored now.
 *
 * @param baseJson   document the local changes were applied to (`null` when it
 *                   did not exist yet, in which case a union merge is used)
 * @param localJson  that document *including* the local changes
 * @param remoteJson document currently stored (`null` when it was removed)
 * @returns the merged document as JSON, or `null` when a payload is unreadable —
 *          in that case the record is kept instead of guessed at.
 */
export function mergePendingDocument(
  baseJson: string | null,
  localJson: string,
  remoteJson: string | null,
): string | null {
  const local = parseJson(localJson);
  if (local === null || !isObject(local)) return null;
  if (remoteJson === null) return JSON.stringify(local);

  const remote = parseJson(remoteJson);
  if (remote === null || !isObject(remote)) return null;

  let base: Maybe<JsonValue> = MISSING;
  if (baseJson !== null) {
    const parsed = parseJson(baseJson);
    if (parsed === null || !isObject(parsed)) return null;
    base = parsed;
  }

  const merged = mergeValue(base, local, remote);
  if (merged === MISSING) return null;
  return JSON.stringify(merged);
}
