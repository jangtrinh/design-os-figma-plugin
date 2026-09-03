// Where the gap-fill baseline LIVES: `figma.clientStorage`, one value per file, never the
// document.
//
// The baseline used to be chunked sharedPluginData on `figma.root`. Three faults, all
// fatal, all removed by moving it here: (1) every write to `figma.root` echoes back as a
// `documentchange` the plugin itself caused, feeding its own idle timer; (2) document data
// is SHARED between collaborators, so one user's baseline silently replaced another's and
// the next diff ran against the wrong base; (3) the payload dirties the file and rides
// multiplayer sync. `clientStorage` is per-machine, async, emits no events, and has room
// for the whole baseline in ONE value — so the chunking/manifest machinery is gone too.
//
// The store is an INTERFACE, not a direct `figma.clientStorage` call, for one reason that
// matters: the quota REFUSAL is the interesting path, and a test double can encode it.
import { utf8ByteLength } from '../../../shared/utf8-byte-length';

/** `[id, name, type, x, y, parentId]` — the tuple form of one node, ~40% smaller than the
 *  object form across a 4 000-record page and the only shape ever persisted. */
export type BaselineRecord = [string, string, string, number, number, string | null];

export interface BaselinePage {
  id: string;
  name: string;
  truncated: boolean;
  /** Absent for a truncated page: its diff is suppressed anyway, so storing records for it
   *  buys nothing and costs the most bytes of any page in the file. */
  records?: BaselineRecord[];
}

/** WHICH file a baseline describes. Stamped into the value because the storage KEY cannot
 *  answer it: a file with no `fileKey` is keyed by a slug of its name, and two different
 *  files slug to one key ("VSF - PCP" and "VSF / PCP" both give `vsf-pcp`). */
export interface BaselineIdentity {
  /** `figma.fileKey` — null on any host without `enablePrivatePluginApi`. */
  fileKey: string | null;
  fileName: string | null;
}

export interface FileBaseline extends BaselineIdentity {
  writtenAt: string;
  /** `figma.currentUser?.name` — null when the host reports no user. Stamped so the day a
   *  SECOND person runs this plugin on the same file, `writtenBy !== currentUser` is the
   *  signal that gap-fill's `actor: 'owner'` attribution stopped being true. */
  writtenBy: string | null;
  pages: BaselinePage[];
}

export interface BaselineStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  keys(): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export const BASELINE_KEY_PREFIX = 'figma-edit-baseline-v2:';

/** Same fileKey-first chain the CLI's `fileIdentity` uses (duplicated, not imported: the
 *  plugin sandbox cannot reach `cli/src`). A Free-tier file has no fileKey, so its baseline
 *  is keyed by a slug of the name — renaming such a file orphans its baseline, which reads
 *  as an honest `baseline-missing` notice rather than a wrong diff. */
export function baselineKeyFor(fileKey: string | null | undefined, fileName: string | null | undefined): string {
  if (typeof fileKey === 'string' && fileKey.trim() !== '') return `${BASELINE_KEY_PREFIX}${fileKey}`;
  const slug = (fileName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${BASELINE_KEY_PREFIX}${slug.length > 0 ? slug : 'unknown'}`;
}

export function createClientStorageBaselineStore(): BaselineStore {
  return {
    get: (key) => figma.clientStorage.getAsync(key),
    set: (key, value) => figma.clientStorage.setAsync(key, value),
    keys: () => figma.clientStorage.keysAsync(),
    delete: (key) => figma.clientStorage.deleteAsync(key),
  };
}

/** Test double. `quotaBytes` caps the TOTAL bytes held — the whole store, not one value,
 *  because that is what `figma.clientStorage` actually limits and it is what makes evicting
 *  another file's baseline a real remedy rather than a ritual. `set` REJECTS when the write
 *  would push the total past the cap: the external API's refusal is the branch worth
 *  testing, and a permissive double would be a green light that means nothing. */
export function createMemoryBaselineStore(
  // `getError` makes every READ reject. A store can refuse a read as well as a write, and
  // that refusal is NOT "nothing stored" — a caller that conflates them overwrites a
  // still-valid baseline it merely failed to load.
  opts: { quotaBytes?: number; getError?: string } = {},
): BaselineStore & { readonly map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  const quota = opts.quotaBytes ?? Infinity;
  const sizeOf = (value: unknown): number => utf8ByteLength(JSON.stringify(value));
  return {
    map,
    get: async (key) => {
      if (opts.getError !== undefined) throw new Error(opts.getError);
      return map.get(key);
    },
    set: async (key, value) => {
      let total = sizeOf(value);
      for (const [k, v] of map) if (k !== key) total += sizeOf(v);
      if (total > quota) throw new Error(`in-memory quota exceeded: ${total} > ${quota} bytes`);
      map.set(key, value);
    },
    keys: async () => [...map.keys()],
    delete: async (key) => { map.delete(key); },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseBaseline(raw: unknown): FileBaseline | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<FileBaseline>;
  if (typeof candidate.writtenAt !== 'string' || !Array.isArray(candidate.pages)) return null;
  return {
    writtenAt: candidate.writtenAt,
    writtenBy: candidate.writtenBy ?? null,
    // A value written before identity was stamped carries neither, which reads as "belongs
    // to no known file" and degrades to missing — an absent fact instead of an unverifiable one.
    fileKey: typeof candidate.fileKey === 'string' ? candidate.fileKey : null,
    fileName: typeof candidate.fileName === 'string' ? candidate.fileName : null,
    pages: candidate.pages,
  };
}

function describeIdentity(id: BaselineIdentity): string {
  return id.fileKey !== null ? `fileKey ${id.fileKey}` : `name "${id.fileName ?? ''}"`;
}

/** Does the value at this key describe the file asking for it? A present-but-FOREIGN
 *  baseline is the worst input a diff can take — every node of this file reads as created
 *  and every node of the other as deleted — so identity is checked, not assumed from the
 *  key. Keyed files compare keys (a rename keeps its baseline); keyless files, which share
 *  a slug-derived key, compare names.
 *  Residual and unfixable from inside the value: two keyless files with the IDENTICAL name
 *  are indistinguishable — nothing observable tells them apart. */
function belongsToFile(baseline: FileBaseline, identity: BaselineIdentity): boolean {
  if (baseline.fileKey !== null || identity.fileKey !== null) return baseline.fileKey === identity.fileKey;
  return baseline.fileName === identity.fileName;
}

export interface BaselineReadResult {
  baseline: FileBaseline | null;
  error?: string;
  /** The STORE refused the read — distinct from `baseline: null` meaning "nothing stored".
   *  A caller may write a fresh baseline over nothing, but must not write over a value it
   *  merely failed to load: that turns "reported late" into "never reported". */
  readFailed?: boolean;
}

/** Reads this file's baseline. A missing, unrecognisable, or FOREIGN value degrades to
 *  `null`, which the caller reports as `baseline-missing` — never as an empty baseline,
 *  which would fabricate a "everything was just created" diff. */
export async function readFileBaseline(store: BaselineStore, key: string, identity: BaselineIdentity): Promise<BaselineReadResult> {
  let raw: unknown;
  try {
    raw = await store.get(key);
  } catch (err) {
    return { baseline: null, readFailed: true, error: `baseline read failed: ${messageOf(err)}` };
  }
  const baseline = parseBaseline(raw);
  if (baseline && !belongsToFile(baseline, identity)) {
    return {
      baseline: null,
      error: `baseline at ${key} belongs to another file (stored ${describeIdentity(baseline)}, current ${describeIdentity(identity)}) — treated as missing`,
    };
  }
  return { baseline };
}

export interface BaselineWriteResult {
  ok: boolean;
  bytes: number;
  /** The OTHER file's baseline key dropped to make room. Present only when one was — an
   *  eviction is a real deletion of someone's data and never happens off the record. */
  evicted?: string;
  error?: string;
}

/** The oldest OTHER file's baseline by `writtenAt`. A key whose value is unreadable, or
 *  whose `writtenAt` does not parse as a date, deliberately ranks OLDEST: it can no longer
 *  be ordered against anything, so it is the cheapest of the set to lose. Ties keep the
 *  first key in enumeration order. */
async function oldestOtherBaselineKey(store: BaselineStore, selfKey: string): Promise<string | null> {
  const keys = (await store.keys()).filter((k) => k !== selfKey && k.startsWith(BASELINE_KEY_PREFIX));
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (const key of keys) {
    let at = -1;
    try {
      const parsed = parseBaseline(await store.get(key));
      at = parsed ? Date.parse(parsed.writtenAt) : -1;
    } catch { at = -1; }
    const rank = Number.isFinite(at) ? at : -1;
    if (rank < oldestAt) { oldestAt = rank; oldestKey = key; }
  }
  return oldestKey;
}

/**
 * One `set`, and — on refusal — ONE eviction + ONE retry. Bounded on purpose: an unbounded
 * evict-and-retry loop would quietly delete every other file's baseline to force this one
 * through. When the retry also fails, nothing was written and the caller records the
 * failure in STATUS; a baseline that failed to write means the NEXT session diffs against
 * an older one, which duplicates edits but never loses them.
 */
export async function writeFileBaseline(store: BaselineStore, key: string, baseline: FileBaseline): Promise<BaselineWriteResult> {
  const bytes = utf8ByteLength(JSON.stringify(baseline));
  try {
    await store.set(key, baseline);
    return { ok: true, bytes };
  } catch (first) {
    let evicted: string | null = null;
    try {
      evicted = await oldestOtherBaselineKey(store, key);
      if (evicted) await store.delete(evicted);
    } catch (evictErr) {
      return { ok: false, bytes: 0, error: `baseline write failed: ${messageOf(first)}; eviction failed: ${messageOf(evictErr)}` };
    }
    if (!evicted) return { ok: false, bytes: 0, error: `baseline write failed: ${messageOf(first)}; no other baseline to evict` };
    try {
      await store.set(key, baseline);
      return { ok: true, bytes, evicted };
    } catch (second) {
      return { ok: false, bytes: 0, evicted, error: `baseline write failed after evicting ${evicted}: ${messageOf(second)}` };
    }
  }
}
