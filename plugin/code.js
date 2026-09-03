"use strict";
(() => {
  // shared/protocol.ts
  var DEFAULT_IDLE_MS = 3e5;
  var MIN_IDLE_MS = 1e3;
  var CHUNK_LIMIT = 512 * 1024;
  var DEFAULT_COWORK_TIMEOUT_SECONDS = 600;
  var COMMAND_TIMEOUTS = {
    HTML_TO_FIGMA: 6e4,
    IMPORT_PAYLOAD: 6e4,
    // A gradient bake fetches a renderer bundle, compiles shaders, and waits for the
    // first frame to settle before reading pixels. The fetch is the slow, variable part.
    SHADER_GRADIENT: 9e4,
    SHADER_GRADIENT_PROBE: 9e4,
    IMPORT_GRADIENT: 6e4,
    SCAN_DESIGN_SYSTEM: 3e4,
    AUDIT_DS: 12e4,
    // usage scan traverses EVERY page's instances — heavier than the DS scan
    EXEC_JS: 3e4,
    // CLI --timeout may raise, capped at 120s
    BATCH: 6e4,
    // Fallback only — cowork.ts always passes an explicit timeoutMs derived from the
    // caller's OWN --timeout (which can exceed this default), same "hop buffer past the
    // requested budget" shape as batch.ts's own scaled timeout.
    COWORK: DEFAULT_COWORK_TIMEOUT_SECONDS * 1e3 + 5e3
  };
  var BROKER_IDLE_SHUTDOWN_MS = 30 * 6e4;

  // shared/file-match.ts
  function fileMatches(actual, filter, exact) {
    const a = (actual ?? "").trim().toLowerCase();
    const f = filter.trim().toLowerCase();
    return exact ? a === f : a.includes(f);
  }

  // shared/utf8-byte-length.ts
  function utf8ByteLength(str2) {
    let bytes = 0;
    for (let i = 0; i < str2.length; i++) {
      const code = str2.charCodeAt(i);
      if (code < 128) bytes += 1;
      else if (code < 2048) bytes += 2;
      else if (code >= 55296 && code <= 56319) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    }
    return bytes;
  }

  // plugin/src/main/gapfill-baseline-store.ts
  var BASELINE_KEY_PREFIX = "figma-edit-baseline-v2:";
  function baselineKeyFor(fileKey, fileName) {
    if (typeof fileKey === "string" && fileKey.trim() !== "") return `${BASELINE_KEY_PREFIX}${fileKey}`;
    const slug = (fileName ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `${BASELINE_KEY_PREFIX}${slug.length > 0 ? slug : "unknown"}`;
  }
  function createClientStorageBaselineStore() {
    return {
      get: (key) => figma.clientStorage.getAsync(key),
      set: (key, value) => figma.clientStorage.setAsync(key, value),
      keys: () => figma.clientStorage.keysAsync(),
      delete: (key) => figma.clientStorage.deleteAsync(key)
    };
  }
  function messageOf(err) {
    return err instanceof Error ? err.message : String(err);
  }
  function parseBaseline(raw) {
    if (!raw || typeof raw !== "object") return null;
    const candidate = raw;
    if (typeof candidate.writtenAt !== "string" || !Array.isArray(candidate.pages)) return null;
    return {
      writtenAt: candidate.writtenAt,
      writtenBy: candidate.writtenBy ?? null,
      // A value written before identity was stamped carries neither, which reads as "belongs
      // to no known file" and degrades to missing — an absent fact instead of an unverifiable one.
      fileKey: typeof candidate.fileKey === "string" ? candidate.fileKey : null,
      fileName: typeof candidate.fileName === "string" ? candidate.fileName : null,
      pages: candidate.pages
    };
  }
  function describeIdentity(id) {
    return id.fileKey !== null ? `fileKey ${id.fileKey}` : `name "${id.fileName ?? ""}"`;
  }
  function belongsToFile(baseline, identity) {
    if (baseline.fileKey !== null || identity.fileKey !== null) return baseline.fileKey === identity.fileKey;
    return baseline.fileName === identity.fileName;
  }
  async function readFileBaseline(store, key, identity) {
    let raw;
    try {
      raw = await store.get(key);
    } catch (err) {
      return { baseline: null, readFailed: true, error: `baseline read failed: ${messageOf(err)}` };
    }
    const baseline = parseBaseline(raw);
    if (baseline && !belongsToFile(baseline, identity)) {
      return {
        baseline: null,
        error: `baseline at ${key} belongs to another file (stored ${describeIdentity(baseline)}, current ${describeIdentity(identity)}) \u2014 treated as missing`
      };
    }
    return { baseline };
  }
  async function oldestOtherBaselineKey(store, selfKey) {
    const keys = (await store.keys()).filter((k) => k !== selfKey && k.startsWith(BASELINE_KEY_PREFIX));
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const key of keys) {
      let at = -1;
      try {
        const parsed = parseBaseline(await store.get(key));
        at = parsed ? Date.parse(parsed.writtenAt) : -1;
      } catch {
        at = -1;
      }
      const rank = Number.isFinite(at) ? at : -1;
      if (rank < oldestAt) {
        oldestAt = rank;
        oldestKey = key;
      }
    }
    return oldestKey;
  }
  async function writeFileBaseline(store, key, baseline) {
    const bytes = utf8ByteLength(JSON.stringify(baseline));
    try {
      await store.set(key, baseline);
      return { ok: true, bytes };
    } catch (first) {
      let evicted = null;
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

  // plugin/src/main/gapfill-status.ts
  function createGapfillStats() {
    return {
      pagesDiffed: 0,
      pagesTruncated: 0,
      baselineWrittenAt: null,
      baselineBytes: 0,
      legacyCleared: 0,
      evicted: [],
      errorCount: 0,
      firstError: null,
      bootBaselineUnreadable: false
    };
  }
  function recordGapfillError(stats, message) {
    stats.errorCount += 1;
    if (stats.firstError === null) stats.firstError = message;
  }
  function recordGapfillEviction(stats, key) {
    if (!stats.evicted.includes(key)) stats.evicted.push(key);
  }
  function toGapfillStatus(stats) {
    return {
      pagesDiffed: stats.pagesDiffed,
      pagesTruncated: stats.pagesTruncated,
      baselineWrittenAt: stats.baselineWrittenAt,
      baselineBytes: stats.baselineBytes,
      ...stats.legacyCleared > 0 && { legacyCleared: stats.legacyCleared },
      ...stats.evicted.length > 0 && { baselineEvicted: [...stats.evicted] },
      ...stats.firstError !== null && { errors: [stats.firstError], errorCount: stats.errorCount }
    };
  }

  // plugin/src/main/edit-gapfill.ts
  var LEGACY_NS = "ease_design";
  var LEGACY_MANIFEST_KEY = "figma-edit-snapshot-v1";
  var LEGACY_CHUNK_PREFIX = "figma-edit-snap-";
  var SNAPSHOT_NODE_CAP_PER_PAGE = 4e3;
  function normalizeSnapshotCoord(n) {
    return Math.round(n * 2) / 2;
  }
  function toBaselineRecord(rec) {
    return [rec.id, rec.name, rec.type, rec.x, rec.y, rec.parent];
  }
  function fromBaselineRecord(rec) {
    return { id: rec[0], name: rec[1], type: rec[2], x: rec[3], y: rec[4], parent: rec[5] };
  }
  function snapshotProviderFrom(precomputed, fallback) {
    return (page) => precomputed.get(page.id) ?? fallback(page);
  }
  function yieldToHost() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  var MOVE_EPSILON = 0.5;
  function diffSnapshots(prev, next) {
    const prevById = new Map(prev.map((n) => [n.id, n]));
    const nextIds = new Set(next.map((n) => n.id));
    const created = [];
    const deleted = [];
    const renamed = [];
    const moved = [];
    for (const n of next) {
      const p = prevById.get(n.id);
      if (!p) {
        created.push(n);
        continue;
      }
      if (p.name !== n.name) renamed.push({ prev: p, next: n });
      if (Math.abs(p.x - n.x) > MOVE_EPSILON || Math.abs(p.y - n.y) > MOVE_EPSILON) moved.push({ prev: p, next: n });
    }
    for (const p of prev) {
      if (!nextIds.has(p.id)) deleted.push(p);
    }
    return { created, deleted, renamed, moved };
  }
  function mergeUpdatedRecords(renamed, moved) {
    const byId = /* @__PURE__ */ new Map();
    for (const { next } of renamed) {
      const entry = byId.get(next.id) ?? { rec: next, props: /* @__PURE__ */ new Set() };
      entry.props.add("name");
      byId.set(next.id, entry);
    }
    for (const { next } of moved) {
      const entry = byId.get(next.id) ?? { rec: next, props: /* @__PURE__ */ new Set() };
      entry.props.add("x");
      entry.props.add("y");
      byId.set(next.id, entry);
    }
    return [...byId.values()].map(({ rec, props }) => ({ rec, changedProps: [...props].sort() }));
  }
  function deletedPageIds(prevPageIds, currentPageIds) {
    return prevPageIds.filter((id) => !currentPageIds.has(id));
  }
  function pageWasTruncated(prevTruncated, nextTruncated) {
    return prevTruncated === true || nextTruncated;
  }
  function deletedPageLabel(page) {
    return page.records ? `${page.name} (${page.records.length} node(s))` : page.name;
  }
  function toGapfillEdit(op, rec, page, changedProps = []) {
    return {
      op,
      nodeId: rec.id,
      nodeName: rec.name,
      nodeType: rec.type,
      // Gap-fill is existence/name/position only (spec non-goal: no property-level diff for
      // the offline window) — the baseline itself never tracked a parent NAME (only a
      // parent id, for a future use), so this is null rather than invented.
      parentName: null,
      page,
      changedProps,
      origin: "LOCAL",
      // The agent cannot have acted while its bridge was down — every gap-fill frame is
      // unambiguously the owner's.
      actor: "owner"
    };
  }
  function gapfillEditsForPage(diff, pageName) {
    const edits = [];
    for (const rec of diff.created) edits.push(toGapfillEdit("created", rec, pageName));
    for (const rec of diff.deleted) edits.push(toGapfillEdit("deleted", rec, pageName));
    for (const { rec, changedProps } of mergeUpdatedRecords(diff.renamed, diff.moved)) {
      edits.push(toGapfillEdit("updated", rec, pageName, changedProps));
    }
    return edits;
  }
  function baselineMissingNotice(fileName, pageName) {
    return toGapfillEdit(
      "updated",
      { id: "gapfill:baseline-missing", name: fileName, type: "DOCUMENT", x: 0, y: 0, parent: null },
      pageName,
      ["baseline-missing"]
    );
  }
  function baselineUnreadableNotice(fileName, pageName) {
    return toGapfillEdit(
      "updated",
      { id: "gapfill:baseline-unreadable", name: fileName, type: "DOCUMENT", x: 0, y: 0, parent: null },
      pageName,
      ["baseline-unreadable"]
    );
  }
  function resolveBaselinePage(page, prevEntry, snapshot) {
    try {
      const { records, truncated } = snapshot();
      return truncated ? { id: page.id, name: page.name, truncated: true } : { id: page.id, name: page.name, truncated: false, records: records.map(toBaselineRecord) };
    } catch {
      return prevEntry ?? null;
    }
  }
  function createSingleFlightWriter(write) {
    let inFlight = false;
    let rearmed = false;
    function settle() {
      inFlight = false;
      if (rearmed) {
        rearmed = false;
        trigger();
      }
    }
    function trigger() {
      if (inFlight) {
        rearmed = true;
        return;
      }
      inFlight = true;
      let started;
      try {
        started = write();
      } catch {
        settle();
        return;
      }
      started.then(settle, settle);
    }
    return trigger;
  }
  function snapshotPage(page) {
    const all = page.findAll(() => true);
    const truncated = all.length > SNAPSHOT_NODE_CAP_PER_PAGE;
    const records = [];
    for (const node of all) {
      if (records.length >= SNAPSHOT_NODE_CAP_PER_PAGE) break;
      const hasXY = "x" in node && "y" in node;
      records.push({
        id: node.id,
        name: node.name,
        type: node.type,
        x: hasXY ? normalizeSnapshotCoord(node.x) : 0,
        y: hasXY ? normalizeSnapshotCoord(node.y) : 0,
        parent: node.parent ? node.parent.id : null
      });
    }
    return { records, truncated };
  }
  function messageOf2(err) {
    return err instanceof Error ? err.message : String(err);
  }
  function currentIdentity() {
    return { fileKey: figma.fileKey ?? null, fileName: figma.root.name };
  }
  function currentBaselineKey() {
    const { fileKey, fileName } = currentIdentity();
    return baselineKeyFor(fileKey, fileName);
  }
  async function readBaseline(store, stats) {
    const { baseline, error, readFailed } = await readFileBaseline(store, currentBaselineKey(), currentIdentity());
    if (error) recordGapfillError(stats, error);
    return { baseline, readFailed: readFailed === true };
  }
  async function writeBaseline(pages, snapshotFor, store, stats, now = Date.now) {
    const key = currentBaselineKey();
    if (stats.bootBaselineUnreadable) {
      recordGapfillError(stats, "baseline write withheld: this session could not read the stored baseline at boot");
      return;
    }
    const { baseline: prev, readFailed } = await readBaseline(store, stats);
    if (readFailed) {
      recordGapfillError(stats, "baseline write skipped: the previous baseline could not be read");
      return;
    }
    const prevById = new Map((prev?.pages ?? []).map((p) => [p.id, p]));
    const nextPages = [];
    for (const page of pages) {
      const resolved = resolveBaselinePage(page, prevById.get(page.id), () => snapshotFor(page));
      if (resolved) nextPages.push(resolved);
    }
    const identity = currentIdentity();
    const baseline = {
      writtenAt: new Date(now()).toISOString(),
      writtenBy: figma.currentUser ? figma.currentUser.name : null,
      fileKey: identity.fileKey,
      fileName: identity.fileName,
      pages: nextPages
    };
    const result = await writeFileBaseline(store, key, baseline);
    if (result.evicted) recordGapfillEviction(stats, result.evicted);
    if (result.error) recordGapfillError(stats, result.error);
    if (result.ok) {
      stats.baselineWrittenAt = baseline.writtenAt;
      stats.baselineBytes = result.bytes;
    }
  }
  function clearLegacyGapfillDocumentData(stats) {
    let cleared = 0;
    try {
      if (!figma.root.getSharedPluginData(LEGACY_NS, LEGACY_MANIFEST_KEY)) return 0;
      const keys = figma.root.getSharedPluginDataKeys(LEGACY_NS);
      for (const key of keys) {
        if (key !== LEGACY_MANIFEST_KEY && !key.startsWith(LEGACY_CHUNK_PREFIX)) continue;
        figma.root.setSharedPluginData(LEGACY_NS, key, "");
        cleared += 1;
      }
    } catch (err) {
      recordGapfillError(stats, `legacy gap-fill cleanup failed: ${messageOf2(err)}`);
    }
    stats.legacyCleared += cleared;
    return cleared;
  }
  async function runGapfillDiff(pages, store, stats) {
    const { baseline: prev, readFailed } = await readBaseline(store, stats);
    if (readFailed) {
      stats.bootBaselineUnreadable = true;
      return [baselineUnreadableNotice(figma.root.name, figma.currentPage.name)];
    }
    if (!prev) {
      const firstRun = /* @__PURE__ */ new Map();
      for (const page of pages) {
        await yieldToHost();
        try {
          firstRun.set(page.id, snapshotPage(page));
        } catch {
        }
      }
      await writeBaseline(pages, snapshotProviderFrom(firstRun, snapshotPage), store, stats);
      return [baselineMissingNotice(figma.root.name, figma.currentPage.name)];
    }
    const edits = [];
    const walked = /* @__PURE__ */ new Map();
    const currentPageIds = new Set(pages.map((p) => p.id));
    const prevById = new Map(prev.pages.map((p) => [p.id, p]));
    for (const deletedId of deletedPageIds(prev.pages.map((p) => p.id), currentPageIds)) {
      const prevPage = prevById.get(deletedId);
      edits.push(toGapfillEdit(
        "deleted",
        { id: `page-deleted:${prevPage.id}`, name: deletedPageLabel(prevPage), type: "PAGE", x: 0, y: 0, parent: null },
        prevPage.name,
        ["page-deleted"]
      ));
    }
    for (const page of pages) {
      await yieldToHost();
      const prevPage = prevById.get(page.id);
      let walk2;
      try {
        walk2 = snapshotPage(page);
      } catch (err) {
        recordGapfillError(stats, `page walk failed on "${page.name}": ${messageOf2(err)}`);
        continue;
      }
      const { records: nextRecords, truncated: nextTruncated } = walk2;
      walked.set(page.id, walk2);
      stats.pagesDiffed += 1;
      if (pageWasTruncated(prevPage?.truncated, nextTruncated)) {
        stats.pagesTruncated += 1;
        edits.push(toGapfillEdit("updated", { id: `truncated:${page.id}`, name: page.name, type: "PAGE", x: 0, y: 0, parent: null }, page.name, ["truncated"]));
        continue;
      }
      const diff = diffSnapshots((prevPage?.records ?? []).map(fromBaselineRecord), nextRecords);
      edits.push(...gapfillEditsForPage(diff, page.name));
    }
    await writeBaseline(pages, snapshotProviderFrom(walked, snapshotPage), store, stats);
    return edits;
  }

  // plugin/src/main/boot-capture.ts
  function messageOf3(err) {
    return err instanceof Error ? err.message : String(err);
  }
  async function runBootCapture(deps) {
    try {
      await deps.loadAllPages();
    } catch (err) {
      deps.notify(`live-sync capture disabled: ${messageOf3(err)}`);
      return;
    }
    try {
      await deps.gapfill();
    } catch (err) {
      deps.notify(`live-sync gap-fill skipped: ${messageOf3(err)}`);
    }
    try {
      deps.subscribe();
    } catch (err) {
      deps.notify(`live-sync capture disabled: ${messageOf3(err)}`);
    }
  }

  // plugin/src/main/edit-actor.ts
  var AGENT_ECHO_MS = 1e4;
  function isDeclaredNow(declared, nodeId, now) {
    const expiresAt = declared.get(nodeId);
    return expiresAt !== void 0 && (expiresAt === Infinity || now < expiresAt);
  }
  function classifyActor(nodeId, _op, now, s) {
    const busy = s.activeCount > 0 || s.lastDrainAt > 0 && now - s.lastDrainAt < AGENT_ECHO_MS;
    if (busy) {
      return isDeclaredNow(s.declared, nodeId, now) ? "agent" : "ambiguous";
    }
    const lastAgentAt2 = s.lastAgentAt.get(nodeId);
    if (lastAgentAt2 !== void 0 && now - lastAgentAt2 < AGENT_ECHO_MS) return "ambiguous";
    return "owner";
  }
  var DECLARED_IDS_CAP = 2e3;
  var LAST_AGENT_AT_CAP = 2e3;
  function enforceCap(map, cap) {
    if (map.size <= cap) return;
    let excess = map.size - cap;
    for (const id of map.keys()) {
      if (excess <= 0) break;
      map.delete(id);
      excess -= 1;
    }
  }
  function pruneDeclaredIds(declared, now, cap = DECLARED_IDS_CAP) {
    for (const [id, expiresAt] of declared) {
      if (expiresAt !== Infinity && now >= expiresAt) declared.delete(id);
    }
    enforceCap(declared, cap);
  }
  function pruneLastAgentAt(lastAgentAt2, now, echoMs = AGENT_ECHO_MS, cap = LAST_AGENT_AT_CAP) {
    for (const [id, at] of lastAgentAt2) {
      if (now - at >= echoMs) lastAgentAt2.delete(id);
    }
    enforceCap(lastAgentAt2, cap);
  }

  // plugin/src/main/change-node-identity.ts
  function resolveComponentIdentity(node) {
    if ("removed" in node && node.removed) {
      if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
        return { id: node.id, name: null, type: node.type };
      }
      return null;
    }
    let n = node;
    while (n) {
      if (n.type === "COMPONENT_SET") return { id: n.id, name: n.name, type: n.type };
      if (n.type === "COMPONENT") {
        if (n.parent && n.parent.type === "COMPONENT_SET") {
          return { id: n.parent.id, name: n.parent.name, type: n.parent.type };
        }
        return { id: n.id, name: n.name, type: n.type };
      }
      n = n.parent;
    }
    return null;
  }
  var EDIT_IDENTITY_CACHE_CAP = 2e3;
  function createEditIdentityCache(cap = EDIT_IDENTITY_CACHE_CAP) {
    const entries = /* @__PURE__ */ new Map();
    return {
      get: (id) => entries.get(id),
      remember: (id, value) => {
        entries.set(id, value);
        if (entries.size > cap) {
          const oldestKey = entries.keys().next().value;
          if (oldestKey !== void 0) entries.delete(oldestKey);
        }
      },
      size: () => entries.size
    };
  }
  var ENCLOSING_NAME_HOP_CAP = 20;
  function enclosingName(node) {
    let n = node.parent;
    let hops = 0;
    while (n && hops < ENCLOSING_NAME_HOP_CAP) {
      if (n.type === "FRAME" || n.type === "SECTION" || n.type === "COMPONENT" || n.type === "COMPONENT_SET") {
        return n.name;
      }
      n = n.parent;
      hops += 1;
    }
    return null;
  }

  // shared/figma-changes.ts
  function mapChangeType(type) {
    switch (type) {
      case "CREATE":
        return "created";
      case "DELETE":
        return "deleted";
      case "PROPERTY_CHANGE":
        return "updated";
      default:
        return null;
    }
  }
  function isPluginBookkeepingChange(changeType, properties) {
    if (changeType !== "PROPERTY_CHANGE" || properties.length === 0) return false;
    return properties.every((property) => property === "pluginData");
  }
  var OP_RANK = { deleted: 3, created: 2, updated: 1 };
  function coalesceChanges(raw) {
    const byId = /* @__PURE__ */ new Map();
    const propSets = /* @__PURE__ */ new Map();
    for (const c of raw) {
      const props = propSets.get(c.nodeId) ?? /* @__PURE__ */ new Set();
      for (const p of c.changedProps) props.add(p);
      propSets.set(c.nodeId, props);
      const prev = byId.get(c.nodeId);
      if (!prev) {
        byId.set(c.nodeId, { ...c, changedProps: [] });
        continue;
      }
      prev.op = OP_RANK[c.op] > OP_RANK[prev.op] ? c.op : prev.op;
      if (prev.nodeName === null && c.nodeName !== null) prev.nodeName = c.nodeName;
      if (!prev.nodeType && c.nodeType) prev.nodeType = c.nodeType;
      if (c.origin === "REMOTE") prev.origin = "REMOTE";
    }
    const out = [];
    for (const [id, c] of byId) {
      c.changedProps = [...propSets.get(id) ?? /* @__PURE__ */ new Set()].sort();
      out.push(c);
    }
    out.sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0);
    return out;
  }

  // shared/edit-feed.ts
  function coalesceEdits(raw) {
    const byId = /* @__PURE__ */ new Map();
    const propSets = /* @__PURE__ */ new Map();
    for (const e of raw) {
      const props = propSets.get(e.nodeId) ?? /* @__PURE__ */ new Set();
      for (const p of e.changedProps) props.add(p);
      propSets.set(e.nodeId, props);
      const prev = byId.get(e.nodeId);
      if (!prev) {
        byId.set(e.nodeId, { ...e, changedProps: [] });
        continue;
      }
      prev.op = e.op;
      if (prev.nodeName === null && e.nodeName !== null) prev.nodeName = e.nodeName;
      if (prev.parentName === null && e.parentName !== null) prev.parentName = e.parentName;
      if (!prev.nodeType && e.nodeType) prev.nodeType = e.nodeType;
      if (e.origin === "REMOTE") prev.origin = "REMOTE";
      prev.actor = e.actor;
    }
    const out = [];
    for (const [id, e] of byId) {
      e.changedProps = [...propSets.get(id) ?? /* @__PURE__ */ new Set()].sort();
      out.push(e);
    }
    out.sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0);
    return out;
  }

  // plugin/src/main/page-of-node.ts
  function pageOf(node) {
    let current = node;
    while (current) {
      if (current.type === "PAGE") return current;
      current = current.parent;
    }
    return null;
  }

  // plugin/src/main/document-change-capture.ts
  function createDocumentChangeCapture(deps) {
    const stats = {
      pluginDataChangesDropped: 0,
      pageFallbacks: 0,
      errorCount: 0,
      firstError: null
    };
    function resolvedPage(node, remembered) {
      const own = pageOf(node);
      if (own) return own.name;
      if (remembered !== void 0) return remembered;
      stats.pageFallbacks += 1;
      return figma.currentPage.name;
    }
    function resolvedRemovedPage(remembered) {
      if (remembered !== void 0) return remembered;
      stats.pageFallbacks += 1;
      return figma.currentPage.name;
    }
    function recordCaptureError(error) {
      stats.errorCount += 1;
      if (stats.firstError === null) {
        stats.firstError = error instanceof Error ? error.message : String(error);
      }
    }
    function onDocumentChange(event) {
      const now = deps.now();
      const connectorTouched = [];
      deps.onBatchStart(now);
      const correctionBatch = deps.corrections.begin();
      let correctionsUsable = true;
      const raw = [];
      const edits = [];
      for (const dc of event.documentChanges) {
        const op = mapChangeType(dc.type);
        if (op === null) continue;
        const node = dc.node;
        if (!node) continue;
        const changedProps = dc.type === "PROPERTY_CHANGE" ? [...dc.properties] : [];
        if (isPluginBookkeepingChange(dc.type, changedProps)) {
          stats.pluginDataChangesDropped += 1;
          continue;
        }
        if (correctionsUsable && (!("removed" in node) || !node.removed)) {
          try {
            deps.corrections.record(correctionBatch, node.id, { changeType: dc.type, properties: changedProps });
          } catch (error) {
            recordCaptureError(error);
            correctionsUsable = false;
          }
        }
        connectorTouched.push(node.id);
        const identity = resolveComponentIdentity(node);
        if (identity) {
          raw.push({
            op,
            nodeId: identity.id,
            nodeName: identity.name,
            nodeType: identity.type,
            changedProps,
            origin: dc.origin
          });
        }
        const removed = "removed" in node && node.removed;
        const known = deps.identity.get(node.id);
        const parentName = removed ? known?.parentName ?? null : enclosingName(node);
        const page = removed ? resolvedRemovedPage(known?.page) : resolvedPage(node, known?.page);
        edits.push({
          op,
          nodeId: node.id,
          nodeName: removed ? known?.name ?? null : node.name,
          nodeType: node.type,
          parentName,
          page,
          changedProps,
          origin: dc.origin,
          actor: classifyActor(node.id, op, now, deps.actorState())
        });
        if (!removed) deps.identity.remember(node.id, { name: node.name, type: node.type, parentName, page });
      }
      if (connectorTouched.length > 0) deps.noteChangedNodes(connectorTouched);
      const changes = coalesceChanges(raw);
      if (changes.length > 0) {
        deps.post({
          // fileName rides alongside fileKey — fileKey is null whenever the manifest lacks
          // enablePrivatePluginApi, so without a name the slug chain collapses every such
          // file to 'unknown' and keeps coalescing them.
          type: "DOC_CHANGE",
          data: { changes, page: figma.currentPage.name, fileKey: figma.fileKey ?? null, fileName: figma.root.name }
        });
        deps.noteComponentChanges(changes.length);
      }
      if (edits.length > 0) {
        deps.post({
          type: "EDIT_FEED",
          data: {
            edits: coalesceEdits(edits),
            fileKey: figma.fileKey ?? null,
            fileName: figma.root.name,
            source: "live"
          }
        });
        deps.noteEdits();
      }
      if (changes.length > 0 || edits.length > 0) deps.armIdle();
      if (correctionsUsable) {
        try {
          deps.corrections.flush(correctionBatch);
        } catch (error) {
          recordCaptureError(error);
        }
      }
    }
    return { onDocumentChange, stats };
  }

  // plugin/src/main/font-match.ts
  var GENERIC_FAMILIES = /* @__PURE__ */ new Set([
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "ui-rounded",
    "math",
    "emoji",
    "fangsong",
    "-apple-system",
    "blinkmacsystemfont"
  ]);
  function normalizeFamily(name) {
    return name.toLowerCase().replace(/["']/g, "").replace(/\s+/g, " ").trim();
  }
  function parseFontStack(raw) {
    if (!raw) return [];
    const out = [];
    for (const part of raw.split(",")) {
      const fam = part.replace(/["']/g, "").trim();
      if (!fam) continue;
      if (GENERIC_FAMILIES.has(normalizeFamily(fam))) continue;
      out.push(fam);
    }
    return out;
  }
  function matchFamily(requested, available) {
    const want = normalizeFamily(requested);
    if (!want) return null;
    for (const a of available) if (normalizeFamily(a) === want) return a;
    for (const a of available) {
      const na = normalizeFamily(a);
      if (na.startsWith(`${want} `) || want.startsWith(`${na} `)) return a;
    }
    return null;
  }
  function matchFamilyStack(stack, available) {
    for (const fam of stack) {
      const hit = matchFamily(fam, available);
      if (hit) return hit;
    }
    return null;
  }
  function pickStyle(variants, availableStyles) {
    const norm = (s) => s.toLowerCase().replace(/\s+/g, "");
    const byNorm = /* @__PURE__ */ new Map();
    for (const s of availableStyles) byNorm.set(norm(s), s);
    for (const v of variants) {
      const hit = byNorm.get(norm(v));
      if (hit) return hit;
    }
    return null;
  }

  // plugin/src/main/executor-fonts.ts
  function getFontStyleVariants(weight, isItalic = false) {
    const regularMap = {
      100: ["Thin", "Hairline"],
      200: ["ExtraLight", "Extra Light", "UltraLight", "Ultra Light"],
      300: ["Light"],
      400: ["Regular", "Normal", "Book"],
      500: ["Medium"],
      600: ["SemiBold", "Semi Bold", "Semibold", "DemiBold", "Demi Bold"],
      700: ["Bold"],
      800: ["ExtraBold", "Extra Bold", "UltraBold", "Ultra Bold"],
      900: ["Black", "Heavy"]
    };
    const baseStyles = regularMap[weight] || ["Regular"];
    if (isItalic) {
      const italicStyles = [];
      for (const style of baseStyles) {
        if (style === "Regular" || style === "Normal") {
          italicStyles.push("Italic");
        } else {
          italicStyles.push(`${style} Italic`);
          italicStyles.push(`${style}Italic`);
        }
      }
      italicStyles.push("Italic");
      return italicStyles;
    }
    return baseStyles;
  }
  async function tryLoadFont(family, styleVariants) {
    for (const style of styleVariants) {
      try {
        await figma.loadFontAsync({ family, style });
        return { family, style };
      } catch {
      }
    }
    return null;
  }
  var availableFontsCache = null;
  async function getAvailableFonts() {
    if (availableFontsCache) return availableFontsCache;
    const stylesByFamily = /* @__PURE__ */ new Map();
    try {
      const list3 = await figma.listAvailableFontsAsync();
      for (const f of list3) {
        const arr = stylesByFamily.get(f.fontName.family) ?? [];
        arr.push(f.fontName.style);
        stylesByFamily.set(f.fontName.family, arr);
      }
    } catch {
    }
    availableFontsCache = { families: [...stylesByFamily.keys()], stylesByFamily };
    return availableFontsCache;
  }
  async function loadBestFont(family, weight, isItalic = false, stack) {
    const variants = getFontStyleVariants(weight, isItalic);
    const { families, stylesByFamily } = await getAvailableFonts();
    if (families.length > 0) {
      const candidates = stack ? [...parseFontStack(stack), family] : [family];
      const matchedFamily = matchFamilyStack(candidates, families) ?? matchFamily(family, families);
      if (matchedFamily) {
        const styles = stylesByFamily.get(matchedFamily) ?? [];
        const style = pickStyle(variants, styles) ?? (isItalic ? pickStyle(getFontStyleVariants(weight, false), styles) : null) ?? pickStyle(["Regular", "Normal", "Book", "Medium"], styles) ?? styles[0];
        if (style) {
          try {
            await figma.loadFontAsync({ family: matchedFamily, style });
            return { family: matchedFamily, style };
          } catch {
          }
        }
      }
    }
    const requested = await tryLoadFont(family, variants);
    if (requested) return requested;
    if (isItalic) {
      const nonItalicFont = await tryLoadFont(family, getFontStyleVariants(weight, false));
      if (nonItalicFont) return nonItalicFont;
    }
    if (family !== "Inter") {
      const inter = await tryLoadFont("Inter", getFontStyleVariants(weight, false));
      if (inter) return inter;
    }
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });
    return { family: "Inter", style: "Regular" };
  }

  // plugin/src/main/executor-styles.ts
  var STYLE_FOLDER = "EaseDesign";
  function specNodeName(spec) {
    for (const candidate of [spec.name, spec.componentName, spec.type]) {
      if (typeof candidate === "string" && candidate.length > 0) return candidate;
    }
    return "Node";
  }
  function withCode(err, code) {
    err.code = code;
    return err;
  }
  var warnings = [];
  function resetImportWarnings() {
    warnings = [];
  }
  function pushImportWarning(w) {
    warnings.push(w);
  }
  function getImportWarnings() {
    return warnings.slice();
  }
  function rgbToFigma(c) {
    return { r: c.r, g: c.g, b: c.b };
  }
  function figmaColorToHex(c) {
    if (!c) return "#000000";
    const r = Math.round(c.r * 255);
    const g = Math.round(c.g * 255);
    const b = Math.round(c.b * 255);
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }
  function hexToFigmaColor(hex) {
    const clean = hex.replace("#", "").trim();
    const full = clean.length === 3 ? clean.split("").map((ch) => ch + ch).join("") : clean;
    const int = parseInt(full.slice(0, 6), 16) || 0;
    const a = full.length >= 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
    return { r: (int >> 16 & 255) / 255, g: (int >> 8 & 255) / 255, b: (int & 255) / 255, a };
  }
  function exportFillToPaint(fill) {
    if ((fill.type === "GRADIENT_LINEAR" || fill.type === "GRADIENT_RADIAL" || fill.type === "GRADIENT_ANGULAR") && fill.gradientStops && fill.gradientTransform) {
      return {
        type: fill.type,
        gradientStops: fill.gradientStops.map((stop) => ({
          color: { ...rgbToFigma(stop.color), a: stop.color.a },
          position: stop.position
        })),
        gradientTransform: fill.gradientTransform
      };
    }
    if (fill.color) {
      return { type: "SOLID", color: rgbToFigma(fill.color), opacity: fill.color.a };
    }
    return null;
  }
  function mapExportEffects(effects) {
    return effects.map((e) => {
      if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") {
        return { type: e.type, radius: e.radius, visible: true };
      }
      const color = e.color || { r: 0, g: 0, b: 0, a: 0.25 };
      return {
        type: e.type,
        color: { ...rgbToFigma(color), a: color.a },
        offset: e.offset || { x: 0, y: 0 },
        radius: e.radius,
        spread: e.spread || 0,
        visible: true,
        blendMode: "NORMAL"
      };
    });
  }
  async function createColorStyles(colors) {
    const styleMap = /* @__PURE__ */ new Map();
    for (const token of colors) {
      const style = figma.createPaintStyle();
      style.name = `${STYLE_FOLDER}/${token.name}`;
      style.paints = [{
        type: "SOLID",
        color: rgbToFigma(token.color),
        opacity: token.color.a
      }];
      styleMap.set(token.hex, style);
    }
    return styleMap;
  }
  async function createTextStyles(typography) {
    const styleMap = /* @__PURE__ */ new Map();
    for (const token of typography) {
      const loadedFont = await loadBestFont(token.family, token.weight);
      const style = figma.createTextStyle();
      style.name = `${STYLE_FOLDER}/${token.name}`;
      style.fontName = loadedFont;
      style.fontSize = token.size;
      if (token.lineHeight) {
        style.lineHeight = { value: token.lineHeight, unit: "PIXELS" };
      }
      if (token.letterSpacing) {
        style.letterSpacing = { value: token.letterSpacing, unit: "PIXELS" };
      }
      styleMap.set(token.name, style);
    }
    return styleMap;
  }
  async function createEffectStyles(shadows) {
    const styleMap = /* @__PURE__ */ new Map();
    for (const token of shadows) {
      const style = figma.createEffectStyle();
      style.name = `${STYLE_FOLDER}/${token.name}`;
      style.effects = mapExportEffects([token.effect]);
      styleMap.set(token.name, style);
    }
    return styleMap;
  }

  // plugin/src/main/executor-variables.ts
  var COLLECTION_NAME = "EaseDesign Tokens";
  var VARIABLE_TYPES = ["COLOR", "FLOAT", "STRING", "BOOLEAN"];
  var PAINT_FIELDS = ["fills", "strokes"];
  var BINDABLE_FIELDS = [
    "fills",
    "strokes",
    "cornerRadius",
    "itemSpacing",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "width",
    "height",
    "opacity"
  ];
  async function findOrCreateCollection(name) {
    const all = await figma.variables.getLocalVariableCollectionsAsync();
    return all.find((c) => c.name === name) ?? figma.variables.createVariableCollection(name);
  }
  function valuesEqual(a, b) {
    if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
      if ("r" in a && "r" in b) {
        const ca = a;
        const cb = b;
        const eps = 1 / 512;
        return Math.abs(ca.r - cb.r) < eps && Math.abs(ca.g - cb.g) < eps && Math.abs(ca.b - cb.b) < eps && Math.abs((ca.a ?? 1) - (cb.a ?? 1)) < eps;
      }
      const aa = a;
      const bb = b;
      if (aa.type === "VARIABLE_ALIAS" && bb.type === "VARIABLE_ALIAS") return aa.id === bb.id;
      return JSON.stringify(a) === JSON.stringify(b);
    }
    return a === b;
  }
  async function findReusableVariable(collection, type, value) {
    const vars = await figma.variables.getLocalVariablesAsync(type);
    const modeId = collection.modes[0].modeId;
    for (const v of vars) {
      if (v.variableCollectionId !== collection.id) continue;
      const existing = v.valuesByMode[modeId];
      if (existing === void 0) continue;
      if (typeof existing === "object" && existing !== null && existing.type === "VARIABLE_ALIAS") continue;
      if (valuesEqual(existing, value)) return v;
    }
    return null;
  }
  async function createOrReuseVariable(collection, name, type, value) {
    const existing = await findReusableVariable(collection, type, value);
    if (existing) return { variable: existing, reused: true };
    const variable = figma.variables.createVariable(name, collection, type);
    variable.setValueForMode(collection.modes[0].modeId, value);
    return { variable, reused: false };
  }
  async function createVariablesFromTokens(tokens) {
    const byTokenName = /* @__PURE__ */ new Map();
    try {
      const collection = await findOrCreateCollection(COLLECTION_NAME);
      for (const t of tokens.colors ?? []) {
        const value = { r: t.color.r, g: t.color.g, b: t.color.b, a: t.color.a };
        const { variable } = await createOrReuseVariable(collection, t.name, "COLOR", value);
        byTokenName.set(t.name, variable);
      }
      for (const t of tokens.spacing ?? []) {
        const { variable } = await createOrReuseVariable(collection, t.name, "FLOAT", t.value);
        byTokenName.set(t.name, variable);
      }
      for (const t of tokens.radii ?? []) {
        const { variable } = await createOrReuseVariable(collection, t.name, "FLOAT", t.value);
        byTokenName.set(t.name, variable);
      }
    } catch (err) {
      pushImportWarning(`variable creation failed (plan limits?): ${String(err)}`);
    }
    return byTokenName;
  }
  function bindVariableToField(node, field, variable) {
    if (PAINT_FIELDS.includes(field)) {
      const target = node;
      const current = target[field];
      const paints = Array.isArray(current) && current.length > 0 ? [...current] : [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
      paints[0] = figma.variables.setBoundVariableForPaint(paints[0], "color", variable);
      target[field] = paints;
    } else {
      node.setBoundVariable(field, variable);
    }
  }
  function applyTokenRefs(node, refs, tokenVars) {
    const bind = (field, tokenName) => {
      if (!tokenName) return;
      const variable = tokenVars.get(tokenName);
      if (!variable) {
        pushImportWarning(`token bind ${field}\u2192${tokenName} skipped on "${node.name}": no variable named "${tokenName}" in this file (library/remote token?) \u2014 literal value kept`);
        return;
      }
      try {
        bindVariableToField(node, field, variable);
      } catch (err) {
        pushImportWarning(`token bind ${field}\u2192${tokenName} failed on "${node.name}": ${String(err)}`);
      }
    };
    bind("fills", refs.fill ?? refs.textColor);
    bind("strokes", refs.stroke);
    bind("cornerRadius", refs.radius);
    bind("itemSpacing", refs.gap);
    if (refs.padding) {
      bind("paddingTop", refs.padding);
      bind("paddingRight", refs.padding);
      bind("paddingBottom", refs.padding);
      bind("paddingLeft", refs.padding);
    }
  }
  async function opCreateVariable(params) {
    const name = params.name;
    const type = params.type;
    if (typeof name !== "string" || !name) throw withCode(new Error("CREATE_VARIABLE requires params.name"), "E_INVALID_ARGS");
    if (!VARIABLE_TYPES.includes(type)) {
      throw withCode(new Error(`CREATE_VARIABLE type must be one of ${VARIABLE_TYPES.join("|")}`), "E_INVALID_ARGS");
    }
    let value = params.value;
    if (type === "COLOR" && typeof value === "string") value = hexToFigmaColor(value);
    if (type === "COLOR" && typeof value === "object" && value !== null) {
      const c = value;
      value = { r: c.r, g: c.g, b: c.b, a: c.a ?? 1 };
    }
    if (type === "FLOAT") value = Number(value);
    if (type === "BOOLEAN" && typeof value === "string") value = value === "true";
    if (value === void 0 || type === "FLOAT" && Number.isNaN(value)) {
      throw withCode(new Error("CREATE_VARIABLE requires a params.value matching the type"), "E_INVALID_ARGS");
    }
    const collection = await findOrCreateCollection(typeof params.collection === "string" && params.collection ? params.collection : COLLECTION_NAME);
    const { variable, reused } = await createOrReuseVariable(collection, name, type, value);
    if (typeof params.mode === "string") {
      const mode = collection.modes.find((m) => m.name === params.mode);
      if (!mode) {
        throw withCode(
          new Error(`CREATE_VARIABLE mode "${params.mode}" not found on collection "${collection.name}" \u2014 available modes: ${collection.modes.map((m) => m.name).join(", ")}`),
          "E_INVALID_ARGS"
        );
      }
      variable.setValueForMode(mode.modeId, value);
    }
    return { id: variable.id, name: variable.name, reused };
  }
  async function resolveVariable(ref) {
    if (ref.startsWith("VariableID:")) {
      const byId = await figma.variables.getVariableByIdAsync(ref);
      if (byId) return byId;
    }
    const all = await figma.variables.getLocalVariablesAsync();
    const byName = all.find((v) => v.name === ref);
    if (!byName) throw withCode(new Error(`variable not found: ${ref}`), "E_INVALID_ARGS");
    return byName;
  }
  async function opBindVariable(params) {
    const nodeId = params.nodeId ?? params.node;
    const field = params.field;
    const ref = params.variable;
    if (typeof nodeId !== "string" || typeof field !== "string" || typeof ref !== "string") {
      throw withCode(new Error("BIND_VARIABLE requires params.node, params.field, params.variable"), "E_INVALID_ARGS");
    }
    if (!BINDABLE_FIELDS.includes(field)) {
      throw withCode(new Error(`BIND_VARIABLE field must be one of ${BINDABLE_FIELDS.join("|")}`), "E_INVALID_ARGS");
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node || node.type === "DOCUMENT" || node.type === "PAGE") {
      throw withCode(new Error(`node not found: ${nodeId}`), "E_INVALID_ARGS");
    }
    const variable = await resolveVariable(ref);
    bindVariableToField(node, field, variable);
    return { id: node.id, field, variable: variable.name };
  }

  // plugin/src/main/executor-keyed-vars.ts
  var resolvedByKey = /* @__PURE__ */ new Map();
  var localByKey = null;
  function resetKeyedVariableCache() {
    resolvedByKey.clear();
    localByKey = null;
  }
  async function readLocalVariablesByKey() {
    if (localByKey) return localByKey;
    const map = /* @__PURE__ */ new Map();
    try {
      for (const v of await figma.variables.getLocalVariablesAsync()) {
        if (typeof v.key === "string" && v.key) map.set(v.key, v);
      }
    } catch {
    }
    localByKey = map;
    return map;
  }
  async function resolveKeyedVariable(key) {
    const cached = resolvedByKey.get(key);
    if (cached !== void 0) return cached;
    let variable = (await readLocalVariablesByKey()).get(key) ?? null;
    if (!variable) {
      try {
        variable = await figma.variables.importVariableByKeyAsync(key);
      } catch (err) {
        pushImportWarning(`variable resolve failed for key ${key}: not local, and import failed: ${String(err)}`);
      }
    }
    resolvedByKey.set(key, variable);
    return variable;
  }
  async function applyKeyedBindings(node, bindings) {
    for (const [field, ref] of Object.entries(bindings)) {
      if (!ref || typeof ref.key !== "string" || !ref.key) continue;
      const variable = await resolveKeyedVariable(ref.key);
      if (!variable) {
        pushImportWarning(`keyed bind ${field}\u2192${ref.name ?? ref.key} skipped on "${node.name}": key not resolvable \u2014 literal value kept`);
        continue;
      }
      try {
        bindVariableToField(node, field, variable);
      } catch (err) {
        pushImportWarning(`keyed bind ${field}\u2192${ref.name ?? ref.key} failed on "${node.name}": ${String(err)}`);
      }
    }
  }

  // plugin/src/main/executor-token-var-resolve.ts
  function tokensAreEmpty(tokens) {
    return !(tokens.colors?.length || tokens.spacing?.length || tokens.radii?.length);
  }
  async function readLocalVariableMap() {
    const byName = /* @__PURE__ */ new Map();
    try {
      for (const v of await figma.variables.getLocalVariablesAsync()) {
        if (!byName.has(v.name)) byName.set(v.name, v);
      }
    } catch (err) {
      pushImportWarning(`local variable lookup failed \u2014 tokenRefs left unbound: ${String(err)}`);
    }
    return byName;
  }
  async function resolveTokenVars(tokens) {
    const resolved = await readLocalVariableMap();
    if (tokensAreEmpty(tokens)) return resolved;
    for (const [name, variable] of await createVariablesFromTokens(tokens)) {
      resolved.set(name, variable);
    }
    return resolved;
  }

  // plugin/src/main/executor-text.ts
  async function createTextNode(exportNode, tokenVars) {
    const textNode = figma.createText();
    textNode.name = specNodeName(exportNode);
    const family = exportNode.fontFamily || "Inter";
    const weight = exportNode.fontWeight || 400;
    const isItalic = exportNode.fontStyle === "italic";
    const loadedFont = await loadBestFont(family, weight, isItalic, exportNode.fontStack);
    textNode.fontName = loadedFont;
    textNode.characters = exportNode.characters || "";
    textNode.fontSize = exportNode.fontSize || 16;
    if (exportNode.lineHeight) {
      textNode.lineHeight = { value: exportNode.lineHeight, unit: "PIXELS" };
    }
    if (exportNode.letterSpacing) {
      textNode.letterSpacing = { value: exportNode.letterSpacing, unit: "PIXELS" };
    }
    if (exportNode.textAlignHorizontal) {
      textNode.textAlignHorizontal = exportNode.textAlignHorizontal;
    }
    if (exportNode.textColor) {
      textNode.fills = [{
        type: "SOLID",
        color: rgbToFigma(exportNode.textColor),
        opacity: exportNode.textColor.a
      }];
    }
    if (exportNode.opacity !== void 0 && exportNode.opacity > 0) {
      textNode.opacity = exportNode.opacity;
    }
    if (exportNode.textAutoResize) {
      textNode.textAutoResize = exportNode.textAutoResize;
    }
    if (exportNode.textTruncation === "ENDING") {
      try {
        textNode.textTruncation = "ENDING";
      } catch {
      }
    }
    if (exportNode.textDecoration) {
      textNode.textDecoration = exportNode.textDecoration;
    }
    if (exportNode.textCase) {
      textNode.textCase = exportNode.textCase;
    }
    if (exportNode.textSegments && exportNode.textSegments.length > 1) {
      let offset = 0;
      for (const seg of exportNode.textSegments) {
        const start = offset;
        const end = offset + seg.characters.length;
        if (start >= end || end > textNode.characters.length) {
          offset = end;
          continue;
        }
        try {
          const segFamily = seg.fontFamily || family;
          const segWeight = seg.fontWeight || weight;
          const segFont = await loadBestFont(segFamily, segWeight, seg.fontStyle === "italic");
          textNode.setRangeFontName(start, end, segFont);
          if (seg.fontSize && seg.fontSize !== (exportNode.fontSize || 16)) {
            textNode.setRangeFontSize(start, end, seg.fontSize);
          }
          if (seg.lineHeight) {
            textNode.setRangeLineHeight(start, end, { value: seg.lineHeight, unit: "PIXELS" });
          }
          if (seg.letterSpacing) {
            textNode.setRangeLetterSpacing(start, end, { value: seg.letterSpacing, unit: "PIXELS" });
          }
          if (seg.textColor) {
            textNode.setRangeFills(start, end, [{
              type: "SOLID",
              color: rgbToFigma(seg.textColor),
              opacity: seg.textColor.a
            }]);
          }
          if (seg.textDecoration) {
            textNode.setRangeTextDecoration(start, end, seg.textDecoration);
          }
          if (seg.textCase) {
            textNode.setRangeTextCase(start, end, seg.textCase);
          }
        } catch {
        }
        offset = end;
      }
    }
    if (exportNode.width && exportNode.height && exportNode.textAutoResize !== "WIDTH_AND_HEIGHT") {
      try {
        if (exportNode.textAutoResize === "HEIGHT") {
          textNode.resize(exportNode.width, textNode.height);
        } else {
          textNode.resize(exportNode.width, exportNode.height);
        }
      } catch {
      }
    }
    if (exportNode.tokenRefs) {
      applyTokenRefs(textNode, exportNode.tokenRefs, tokenVars ?? /* @__PURE__ */ new Map());
    }
    return textNode;
  }

  // plugin/src/main/executor-strokes.ts
  var SIDE_FIELDS = {
    top: "strokeTopWeight",
    right: "strokeRightWeight",
    bottom: "strokeBottomWeight",
    left: "strokeLeftWeight"
  };
  function applyStrokes(node, spec) {
    if (!spec.strokes || spec.strokes.length === 0) return;
    node.strokes = spec.strokes.filter((s) => s.color).map((s) => ({
      type: "SOLID",
      color: rgbToFigma(s.color),
      opacity: s.color.a
    }));
    if (spec.strokeWeights) {
      const target = node;
      for (const [side, field] of Object.entries(SIDE_FIELDS)) {
        const w = spec.strokeWeights[side];
        try {
          target[field] = w;
        } catch {
        }
      }
    } else if (spec.strokeWeight !== void 0) {
      node.strokeWeight = spec.strokeWeight;
    } else {
      node.strokeWeight = 1;
    }
    if (spec.strokeAlign) node.strokeAlign = spec.strokeAlign;
  }

  // plugin/src/main/executor-shapes.ts
  var PLACEHOLDER_FILL = { type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.85 }, opacity: 1 };
  async function createRectangleNode(exportNode, colorStyles, tokenVars) {
    const rect = figma.createRectangle();
    rect.name = specNodeName(exportNode);
    if (exportNode.width) rect.resize(exportNode.width, exportNode.height || exportNode.width);
    if (exportNode.fills && exportNode.fills.length > 0) {
      const fill = exportNode.fills[0];
      if (fill.color) {
        const hex = figmaColorToHex(fill.color);
        const paintStyle = colorStyles.get(hex);
        if (paintStyle) {
          await rect.setFillStyleIdAsync(paintStyle.id);
        } else {
          rect.fills = [{
            type: "SOLID",
            color: rgbToFigma(fill.color),
            opacity: fill.color.a
          }];
        }
      }
    }
    if (exportNode.cornerRadius !== void 0) {
      rect.cornerRadius = exportNode.cornerRadius;
    } else if (exportNode.cornerRadii) {
      rect.topLeftRadius = exportNode.cornerRadii.tl;
      rect.topRightRadius = exportNode.cornerRadii.tr;
      rect.bottomRightRadius = exportNode.cornerRadii.br;
      rect.bottomLeftRadius = exportNode.cornerRadii.bl;
    }
    if (exportNode.effects) {
      rect.effects = mapExportEffects(exportNode.effects);
    }
    applyStrokes(rect, exportNode);
    if (exportNode.opacity !== void 0 && exportNode.opacity > 0) {
      rect.opacity = exportNode.opacity;
    }
    if (exportNode.tokenRefs) {
      applyTokenRefs(rect, exportNode.tokenRefs, tokenVars ?? /* @__PURE__ */ new Map());
    }
    return rect;
  }
  function createImageNode(exportNode) {
    const rect = figma.createRectangle();
    rect.name = specNodeName(exportNode);
    rect.resize(exportNode.width || 200, exportNode.height || 200);
    rect.fills = [PLACEHOLDER_FILL];
    rect.cornerRadius = exportNode.cornerRadius || 0;
    return rect;
  }
  function createSvgNode(exportNode) {
    try {
      const frame = figma.createNodeFromSvg(exportNode.svgContent);
      frame.name = specNodeName(exportNode);
      const w = exportNode.width || 24;
      const h = exportNode.height || 24;
      frame.resize(w, h);
      return frame;
    } catch (err) {
      pushImportWarning(`svg import failed for "${exportNode.name}": ${String(err)}`);
      return createImageNode(exportNode);
    }
  }
  async function createImageNodeWithFetch(exportNode) {
    const rect = figma.createRectangle();
    rect.name = specNodeName(exportNode);
    rect.resize(exportNode.width || 200, exportNode.height || 200);
    rect.cornerRadius = exportNode.cornerRadius || 0;
    const url = exportNode.imageUrl || "";
    if (!url || url.startsWith("data:") || url.startsWith("blob:")) {
      if (url.startsWith("data:")) {
        try {
          const image = figma.createImage(decodeDataUrl(url));
          rect.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
          return rect;
        } catch {
        }
      }
      rect.fills = [PLACEHOLDER_FILL];
      return rect;
    }
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      const image = await createImageFromBytes(new Uint8Array(buffer), url);
      rect.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
    } catch (err) {
      pushImportWarning(`image fetch failed for "${exportNode.name}" (${url}): ${String(err)}`);
      rect.fills = [PLACEHOLDER_FILL];
    }
    return rect;
  }
  function decodeDataUrl(url) {
    const comma = url.indexOf(",");
    const b64 = url.slice(comma + 1);
    return figma.base64Decode(b64);
  }
  async function createImageFromBytes(bytes, url) {
    try {
      return figma.createImage(bytes);
    } catch (err) {
      if (url && /^https?:/i.test(url)) return await figma.createImageAsync(url);
      throw err;
    }
  }
  async function resolveImagePaint(url, scaleMode = "FILL") {
    if (!url || url.startsWith("blob:")) return null;
    try {
      let image;
      if (url.startsWith("data:")) {
        image = await createImageFromBytes(decodeDataUrl(url), void 0);
      } else {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        image = await createImageFromBytes(new Uint8Array(buffer), url);
      }
      return { type: "IMAGE", imageHash: image.hash, scaleMode };
    } catch (err) {
      if (/^https?:/i.test(url)) {
        try {
          const image = await figma.createImageAsync(url);
          return { type: "IMAGE", imageHash: image.hash, scaleMode };
        } catch {
        }
      }
      pushImportWarning(`background image fetch failed (${url}): ${String(err)}`);
      return null;
    }
  }

  // plugin/src/main/scan-node-utils.ts
  function safe(read) {
    try {
      const v = read();
      if (typeof v === "symbol") return void 0;
      return v;
    } catch {
      return void 0;
    }
  }
  function aliasId(val) {
    const alias = Array.isArray(val) ? val[0] : val;
    return alias?.id;
  }
  function readBindings(n) {
    const rec = {};
    const bound = safe(() => n.boundVariables);
    if (bound && typeof bound === "object") {
      for (const [field, val] of Object.entries(bound)) {
        const id = aliasId(val);
        if (id) rec[field] = id;
      }
    }
    for (const field of ["fills", "strokes"]) {
      const paints = safe(() => n[field]);
      if (!Array.isArray(paints)) continue;
      for (const p of paints) {
        const id = aliasId(p.boundVariables?.color);
        if (id) {
          rec[field] = id;
          break;
        }
      }
    }
    return rec;
  }

  // plugin/src/main/instance-inner-override-keys.ts
  var INNER_OVERRIDE_FIELDS = [
    "name",
    "width",
    "height",
    "layoutGrow",
    "textAutoResize",
    "primaryAxisSizingMode",
    "counterAxisSizingMode"
  ];
  var FIELD_SET = new Set(INNER_OVERRIDE_FIELDS);
  function innerChildPrefix(instanceId) {
    return instanceId.startsWith("I") ? `${instanceId};` : `I${instanceId};`;
  }
  function innerChildKey(instanceId, nodeId) {
    const prefix = innerChildPrefix(instanceId);
    return nodeId.startsWith(prefix) && nodeId.length > prefix.length ? nodeId.slice(prefix.length) : void 0;
  }
  function keyInnerChildren(instance, instanceId, maxNodes = 2e3) {
    const map = /* @__PURE__ */ new Map();
    const visit = (node) => {
      if (map.size >= maxNodes) return;
      const kids = safe(() => node.children);
      if (!Array.isArray(kids)) return;
      for (const kid of kids) {
        const id = safe(() => kid.id);
        if (typeof id === "string") {
          const key = innerChildKey(instanceId, id);
          if (key !== void 0) map.set(key, kid);
        }
        visit(kid);
      }
    };
    visit(instance);
    return map;
  }

  // plugin/src/main/resolve-main-component.ts
  async function resolveMainComponent(ref) {
    if (ref.componentKey) {
      try {
        return await figma.importComponentByKeyAsync(ref.componentKey);
      } catch {
      }
    }
    if (ref.componentId) {
      try {
        const local = await figma.getNodeByIdAsync(ref.componentId);
        if (local && local.type === "COMPONENT") return local;
        if (local && local.type === "COMPONENT_SET") return local.defaultVariant;
      } catch {
      }
    }
    return null;
  }

  // plugin/src/main/executor-instance-inner-slot.ts
  async function applyChildSwap(child, o, name) {
    if (!o.componentKey && !o.componentId) return false;
    if (safe(() => child.type) !== "INSTANCE") return false;
    const node = child;
    let current = null;
    try {
      current = await node.getMainComponentAsync();
    } catch {
    }
    if (current && (o.componentKey && current.key === o.componentKey || o.componentId && current.id === o.componentId)) {
      return false;
    }
    const target = await resolveMainComponent(o);
    if (!target) {
      pushImportWarning(
        `instance "${name}": inner slot "${o.childKey}" was swapped to a component that cannot be resolved (key=${o.componentKey ?? "\u2014"}, id=${o.componentId ?? "\u2014"}) \u2014 left on the main's default, swap lost`
      );
      return false;
    }
    try {
      node.swapComponent(target);
      return true;
    } catch (err) {
      pushImportWarning(`instance "${name}": inner slot "${o.childKey}" swap failed (${String(err)})`);
      return false;
    }
  }
  function applyChildComponentProperties(child, o, name) {
    const props = o.componentProperties;
    if (!props || !Object.keys(props).length) return false;
    if (safe(() => child.type) !== "INSTANCE") return false;
    const node = child;
    const defs = safe(() => node.componentProperties);
    const changesVariant = Object.keys(props).some(
      (k) => safe(() => defs?.[k]?.type) === "VARIANT" && safe(() => defs?.[k]?.value) !== props[k]
    );
    try {
      node.setProperties(props);
      return changesVariant;
    } catch {
    }
    let any = false;
    for (const [k, v] of Object.entries(props)) {
      try {
        node.setProperties({ [k]: v });
        any = true;
      } catch (err) {
        pushImportWarning(
          `instance "${name}": inner slot "${o.childKey}" property "${k}" failed (${String(err)}) \u2014 left on the main's default`
        );
      }
    }
    return any && changesVariant;
  }

  // plugin/src/main/scan-node-paint.ts
  function paintToFill(p) {
    if (p.type === "SOLID") {
      const a = typeof p.opacity === "number" ? p.opacity : 1;
      return { type: "SOLID", color: { r: p.color.r, g: p.color.g, b: p.color.b, a } };
    }
    if (p.type === "GRADIENT_LINEAR" || p.type === "GRADIENT_RADIAL" || p.type === "GRADIENT_ANGULAR") {
      const g = p;
      return {
        type: p.type,
        gradientStops: g.gradientStops.map((s) => ({
          color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
          position: s.position
        })),
        gradientTransform: g.gradientTransform
      };
    }
    return null;
  }
  function effectToExport(e) {
    if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") {
      return { type: e.type, radius: e.radius };
    }
    const s = e;
    const c = s.color;
    return {
      type: e.type,
      offset: { x: s.offset.x, y: s.offset.y },
      radius: s.radius,
      spread: s.spread ?? 0,
      color: { r: c.r, g: c.g, b: c.b, a: c.a }
    };
  }
  var asFills = (v) => {
    if (!Array.isArray(v) || v.length === 0) return void 0;
    const out = v.map(paintToFill).filter((f) => f !== null);
    return out.length ? out : void 0;
  };

  // plugin/src/main/executor-instance-inner-visual.ts
  function paintsDiffer(current, wanted) {
    if (!Array.isArray(current)) return true;
    return JSON.stringify(asFills(current) ?? []) !== JSON.stringify(wanted);
  }
  async function applyEffectStyle(child, wanted, name, key) {
    if (safe(() => child.effectStyleId) === wanted) return false;
    const set2 = child.setEffectStyleIdAsync;
    if (typeof set2 !== "function") return false;
    try {
      await set2.call(child, wanted);
      return wanted !== "";
    } catch (err) {
      pushImportWarning(
        `instance "${name}": inner override effectStyleId "${wanted}" on "${key}" failed (${String(err)}) \u2014 falling back to the literal effects`
      );
      return false;
    }
  }
  async function applyPaintBinding(child, field, ref, name, key) {
    const variable = await resolveKeyedVariable(ref.key);
    if (!variable) {
      pushImportWarning(
        `instance "${name}": inner override ${field} on "${key}" is bound to ${ref.name ?? ref.key}, which cannot be resolved \u2014 literal paint written instead`
      );
      return false;
    }
    try {
      bindVariableToField(child, field, variable);
      return true;
    } catch (err) {
      pushImportWarning(`instance "${name}": inner override ${field} rebind on "${key}" failed (${String(err)})`);
      return false;
    }
  }
  async function applyPaintField(child, field, visual, name, key) {
    const wanted = visual[field];
    if (!wanted) return;
    const ref = visual.keyedBindings?.[field];
    if (ref && await applyPaintBinding(child, field, ref, name, key)) return;
    if (!paintsDiffer(safe(() => child[field]), wanted)) return;
    const paints = wanted.map(exportFillToPaint).filter((p) => p !== null);
    try {
      child[field] = paints;
    } catch (err) {
      pushImportWarning(`instance "${name}": inner override ${field} on "${key}" failed (${String(err)})`);
    }
  }
  async function applyChildVisual(child, visual, name, key) {
    if (!visual) return;
    for (const field of ["visible", "opacity"]) {
      const wanted = visual[field];
      if (wanted === void 0 || safe(() => child[field]) === wanted) continue;
      try {
        child[field] = wanted;
      } catch (err) {
        pushImportWarning(`instance "${name}": inner override ${field} on "${key}" failed (${String(err)})`);
      }
    }
    const styled = visual.effectStyleId !== void 0 && await applyEffectStyle(child, visual.effectStyleId, name, key);
    if (visual.effects && !styled) {
      const current = safe(() => child.effects);
      const live = Array.isArray(current) ? JSON.stringify(current.map(effectToExport).filter((e) => e !== null)) : null;
      if (live !== JSON.stringify(visual.effects)) {
        try {
          child.effects = mapExportEffects(visual.effects);
        } catch (err) {
          pushImportWarning(`instance "${name}": inner override effects on "${key}" failed (${String(err)})`);
        }
      }
    }
    await applyPaintField(child, "fills", visual, name, key);
    await applyPaintField(child, "strokes", visual, name, key);
  }

  // plugin/src/main/executor-instance-inner-overrides.ts
  var SIDE_EFFECT_FIELDS = ["primaryAxisSizingMode", "counterAxisSizingMode", "textAutoResize"];
  function writeField(child, name, field, value) {
    try {
      child[field] = value;
    } catch (err) {
      pushImportWarning(`instance "${name}": inner override ${field} failed (${String(err)})`);
    }
  }
  function applyChildFields(child, fields, name) {
    const before = {};
    for (const f of SIDE_EFFECT_FIELDS) before[f] = safe(() => child[f]);
    if (typeof fields.name === "string") writeField(child, name, "name", fields.name);
    const w = fields.width;
    const h = fields.height;
    if (typeof w === "number" || typeof h === "number") {
      try {
        const resize = child.resize;
        const cw = typeof w === "number" ? w : child.width;
        const ch = typeof h === "number" ? h : child.height;
        if (typeof resize === "function") resize.call(child, cw, ch);
        if (Math.abs(child.width - cw) > 0.01 || Math.abs(child.height - ch) > 0.01) {
          pushImportWarning(
            `instance "${name}": inner override resize did not take (asked ${cw}x${ch}, got ${String(child.width)}x${String(child.height)}) \u2014 the child is sized by its auto-layout parent (layoutSizing ${String(child.layoutSizingHorizontal)}/${String(child.layoutSizingVertical)}), which overrides resize()`
          );
        }
      } catch (err) {
        pushImportWarning(`instance "${name}": inner override resize failed (${String(err)})`);
      }
    }
    for (const f of SIDE_EFFECT_FIELDS) {
      const wanted = f in fields ? fields[f] : before[f];
      if (wanted === void 0) continue;
      try {
        if (child[f] !== wanted) child[f] = wanted;
      } catch (err) {
        if (f in fields) pushImportWarning(`instance "${name}": inner override ${f} failed (${String(err)})`);
      }
    }
    if (typeof fields.layoutGrow === "number") writeField(child, name, "layoutGrow", fields.layoutGrow);
  }
  async function applyInnerOverrides(instance, spec) {
    const overrides = spec.innerOverrides;
    if (!overrides || !overrides.length) return;
    const root = instance;
    let byKey = keyInnerChildren(root, instance.id);
    const missed = [];
    for (const o of overrides) {
      const child = byKey.get(o.childKey);
      if (!child) {
        missed.push(o.childKey);
        continue;
      }
      const revariant = applyChildComponentProperties(child, o, spec.name);
      const swapped = await applyChildSwap(child, o, spec.name);
      applyChildFields(child, o.fields, spec.name);
      await applyChildVisual(child, o.visual, spec.name, o.childKey);
      if (swapped || revariant) byKey = keyInnerChildren(root, instance.id);
    }
    if (missed.length) {
      pushImportWarning(
        `instance "${spec.name}": ${missed.length} inner override(s) had no matching child (${missed.join(", ")}) \u2014 those inner edits are lost`
      );
    }
  }

  // plugin/src/main/executor-instance.ts
  function applyComponentProperties(instance, spec) {
    if (!spec.componentProperties || Object.keys(spec.componentProperties).length === 0) return;
    try {
      instance.setProperties(spec.componentProperties);
    } catch (err) {
      pushImportWarning(`instance "${spec.name}": setProperties failed \u2014 built with main defaults (${String(err)})`);
    }
  }
  function fillsDiffer(current, wanted) {
    if (typeof current === "symbol") return true;
    return JSON.stringify(asFills(current) ?? []) !== JSON.stringify(wanted);
  }
  function effectsDiffer(current, wanted) {
    if (!Array.isArray(current)) return true;
    const seen = current.map(effectToExport).filter((e) => e !== null);
    return JSON.stringify(seen) !== JSON.stringify(wanted);
  }
  function applyNodeOverrides(instance, spec) {
    if (spec.name && instance.name !== spec.name) {
      try {
        instance.name = spec.name;
      } catch {
      }
    }
    if (spec.width && spec.height && (Math.abs(instance.width - spec.width) > 0.01 || Math.abs(instance.height - spec.height) > 0.01)) {
      try {
        instance.resize(spec.width, spec.height);
      } catch (err) {
        pushImportWarning(`instance "${spec.name}": resize failed (${String(err)})`);
      }
    }
    if (spec.fills && spec.fills.length) {
      const paints = spec.fills.map(exportFillToPaint).filter((p) => p !== null);
      if (paints.length && fillsDiffer(instance.fills, spec.fills)) {
        try {
          instance.fills = paints;
        } catch {
        }
      }
    }
    if (spec.cornerRadius !== void 0 && instance.cornerRadius !== spec.cornerRadius) {
      try {
        instance.cornerRadius = spec.cornerRadius;
      } catch {
      }
    } else if (spec.cornerRadii) {
      try {
        instance.topLeftRadius = spec.cornerRadii.tl;
        instance.topRightRadius = spec.cornerRadii.tr;
        instance.bottomRightRadius = spec.cornerRadii.br;
        instance.bottomLeftRadius = spec.cornerRadii.bl;
      } catch {
      }
    }
    if (spec.opacity !== void 0 && spec.opacity > 0 && instance.opacity !== spec.opacity) {
      try {
        instance.opacity = spec.opacity;
      } catch {
      }
    }
    if (spec.effects && spec.effects.length && effectsDiffer(instance.effects, spec.effects)) {
      try {
        instance.effects = mapExportEffects(spec.effects);
      } catch {
      }
    }
  }
  async function createInstanceNode(spec, frameFallback) {
    const main = await resolveMainComponent(spec);
    if (!main) {
      pushImportWarning(
        `instance "${spec.name}": main component not found (key=${spec.componentKey ?? "\u2014"}, id=${spec.componentId ?? "\u2014"}) \u2014 rebuilt as a plain frame, component link lost`
      );
      return frameFallback(spec);
    }
    let instance;
    try {
      instance = main.createInstance();
    } catch (err) {
      pushImportWarning(`instance "${spec.name}": createInstance failed \u2014 rebuilt as a plain frame (${String(err)})`);
      return frameFallback(spec);
    }
    applyComponentProperties(instance, spec);
    applyNodeOverrides(instance, spec);
    await applyInnerOverrides(instance, spec);
    return instance;
  }

  // plugin/src/main/background-fill.ts
  function backgroundSizeToScaleMode(bgSize) {
    const s = (bgSize || "").trim().toLowerCase();
    if (!s || s === "auto") return "FILL";
    if (s === "cover") return "FILL";
    if (s === "contain") return "FIT";
    if (s.includes("repeat")) return "TILE";
    return "FILL";
  }

  // plugin/src/main/executor-motion.ts
  function mapCssEasingToMotion(css) {
    const c = (css || "").trim().toLowerCase();
    const bez = c.match(/cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
    if (bez) {
      return {
        type: "CUSTOM_CUBIC_BEZIER",
        easingFunctionCubicBezier: {
          x1: parseFloat(bez[1]),
          y1: parseFloat(bez[2]),
          x2: parseFloat(bez[3]),
          y2: parseFloat(bez[4])
        }
      };
    }
    switch (c) {
      case "linear":
        return { type: "LINEAR" };
      case "ease-in":
        return { type: "EASE_IN" };
      case "ease-out":
        return { type: "EASE_OUT" };
      case "ease-in-out":
        return { type: "EASE_IN_AND_OUT" };
      case "ease":
      default:
        return { type: "EASE_IN_AND_OUT" };
    }
  }
  function parseTransform(transform) {
    const out = {};
    const t = (transform || "").trim();
    if (!t) return out;
    if (t === "none") {
      out.translateX = 0;
      out.translateY = 0;
      out.rotate = 0;
      out.scaleX = 1;
      out.scaleY = 1;
      return out;
    }
    const num = (v) => parseFloat(v);
    let m;
    if (m = t.match(/translate\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px\s*\)/)) {
      out.translateX = num(m[1]);
      out.translateY = num(m[2]);
    }
    if (m = t.match(/translate\(\s*([-\d.]+)px\s*\)/)) out.translateX = num(m[1]);
    if (m = t.match(/translateX\(\s*([-\d.]+)px\s*\)/)) out.translateX = num(m[1]);
    if (m = t.match(/translateY\(\s*([-\d.]+)px\s*\)/)) out.translateY = num(m[1]);
    if (m = t.match(/rotate\(\s*([-\d.]+)deg\s*\)/)) out.rotate = num(m[1]);
    if (m = t.match(/scale\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/)) {
      out.scaleX = num(m[1]);
      out.scaleY = num(m[2]);
    } else if (m = t.match(/scale\(\s*([-\d.]+)\s*\)/)) {
      out.scaleX = num(m[1]);
      out.scaleY = num(m[1]);
    }
    if (m = t.match(/scaleX\(\s*([-\d.]+)\s*\)/)) out.scaleX = num(m[1]);
    if (m = t.match(/scaleY\(\s*([-\d.]+)\s*\)/)) out.scaleY = num(m[1]);
    return out;
  }
  var FIELD_EXTRACTORS = [
    { name: "OPACITY", get: (s) => s.opacity !== void 0 && s.opacity !== "" ? parseFloat(s.opacity) : void 0 },
    { name: "TRANSLATION_X", get: (s) => parseTransform(s.transform).translateX },
    { name: "TRANSLATION_Y", get: (s) => parseTransform(s.transform).translateY },
    { name: "ROTATION", get: (s) => parseTransform(s.transform).rotate },
    { name: "SCALE_X", get: (s) => parseTransform(s.transform).scaleX },
    { name: "SCALE_Y", get: (s) => parseTransform(s.transform).scaleY }
  ];
  function buildMotionTracks(steps, durationSec, cssEasing) {
    if (!steps.length || durationSec <= 0) return [];
    const sorted = [...steps].sort((a, b) => a.offset - b.offset);
    const easing = mapCssEasingToMotion(cssEasing);
    const specs = [];
    for (const { name, get: get2 } of FIELD_EXTRACTORS) {
      const points = [];
      for (const step of sorted) {
        const v = get2(step.style);
        if (v !== void 0 && !Number.isNaN(v)) points.push({ offset: step.offset, value: v });
      }
      if (points.length < 2) continue;
      const distinct = new Set(points.map((p) => p.value));
      if (distinct.size < 2) continue;
      const keyframes = points.map((p) => ({
        timelinePosition: Math.round(p.offset * durationSec * 1e3) / 1e3,
        value: { type: "FLOAT", value: p.value },
        easing
      }));
      specs.push({
        field: { type: "PROPERTY", name },
        // Omit baseValue for a NEW track — the Motion API derives it from the node
        // (per the official figma-use-motion skill; API shape validated live 2026-07-09).
        track: { keyframes }
      });
    }
    return specs;
  }
  var motionProbe = null;
  function isMotionSupported(node) {
    if (motionProbe !== null) return motionProbe;
    try {
      const n = node;
      const api = figma.motion;
      motionProbe = typeof n.applyManualKeyframeTrack === "function" && typeof api?.figmaAnimationStyles === "function";
    } catch {
      motionProbe = false;
    }
    return motionProbe;
  }
  function applyMotionTracks(node, steps, durationSec, cssEasing) {
    if (!isMotionSupported(node)) {
      pushImportWarning("Figma Motion API unavailable (metronome) \u2014 falling back to Smart-Animate variants");
      return { applied: false, reason: "unsupported", trackCount: 0 };
    }
    const specs = buildMotionTracks(steps, durationSec, cssEasing);
    if (!specs.length) return { applied: false, reason: "no-animatable-fields", trackCount: 0 };
    const n = node;
    for (const { field, track } of specs) {
      try {
        n.applyManualKeyframeTrack(field, track);
      } catch (err) {
        pushImportWarning(`Motion track ${JSON.stringify(field)} failed: ${String(err)}`);
      }
    }
    try {
      const tl = n.timelines?.[0];
      if (tl) n.setTimelineDuration(tl.id, durationSec);
    } catch {
    }
    return { applied: true, trackCount: specs.length };
  }

  // plugin/src/main/executor-frame.ts
  async function createFigmaNode(exportNode, colorStyles, tokenVars) {
    let node;
    switch (exportNode.type) {
      case "TEXT":
        node = await createTextNode(exportNode, tokenVars);
        break;
      case "IMAGE":
        node = exportNode.svgContent ? createSvgNode(exportNode) : exportNode.imageUrl ? await createImageNodeWithFetch(exportNode) : createImageNode(exportNode);
        break;
      case "RECTANGLE":
        node = await createRectangleNode(exportNode, colorStyles, tokenVars);
        break;
      case "INSTANCE":
        node = await createInstanceNode(exportNode, (spec) => createFrameNode(spec, colorStyles, tokenVars));
        break;
      case "FRAME":
      case "GROUP":
      default:
        node = await createFrameNode(exportNode, colorStyles, tokenVars);
        break;
    }
    if (node && exportNode.keyedBindings) {
      await applyKeyedBindings(node, exportNode.keyedBindings);
    }
    if (node && exportNode.motion && exportNode.motion.steps && exportNode.motion.steps.length >= 2) {
      applyMotionTracks(node, exportNode.motion.steps, exportNode.motion.durationSec, exportNode.motion.easing);
    }
    return node;
  }
  function applyGridLayout(frame, spec, applied) {
    const f = frame;
    try {
      f.layoutMode = "GRID";
      if (f.layoutMode !== "GRID") throw new Error("GRID layoutMode not supported by this Figma version");
      if (spec.gridRowCount) f.gridRowCount = spec.gridRowCount;
      if (spec.gridColumnCount) f.gridColumnCount = spec.gridColumnCount;
      if (spec.gridRowGap !== void 0) f.gridRowGap = spec.gridRowGap;
      if (spec.gridColumnGap !== void 0) f.gridColumnGap = spec.gridColumnGap;
      applied.layoutMode = "GRID";
      applied.gridRowCount = f.gridRowCount;
      applied.gridColumnCount = f.gridColumnCount;
    } catch (err) {
      frame.layoutMode = "HORIZONTAL";
      frame.layoutWrap = "WRAP";
      frame.itemSpacing = spec.gridColumnGap ?? spec.itemSpacing ?? 0;
      try {
        frame.counterAxisSpacing = spec.gridRowGap ?? spec.counterAxisSpacing ?? 0;
      } catch {
      }
      pushImportWarning(`native GRID unavailable on "${frame.name}" \u2014 fell back to HORIZONTAL+WRAP (${String(err)})`);
      applied.layoutMode = "HORIZONTAL_WRAP_FALLBACK";
    }
  }
  function applyAutoLayout(frame, spec, useDefaults) {
    const applied = {};
    const mode = spec.layoutMode;
    if (!mode) return applied;
    if (mode === "NONE") {
      frame.layoutMode = "NONE";
      applied.layoutMode = "NONE";
      return applied;
    }
    if (mode === "GRID") {
      applyGridLayout(frame, spec, applied);
    } else {
      frame.layoutMode = mode;
      applied.layoutMode = mode;
      if (useDefaults || spec.itemSpacing !== void 0) frame.itemSpacing = spec.itemSpacing ?? 0;
      if (spec.primaryAxisSizingMode) frame.primaryAxisSizingMode = spec.primaryAxisSizingMode === "AUTO" ? "AUTO" : "FIXED";
      if (spec.counterAxisSizingMode) frame.counterAxisSizingMode = spec.counterAxisSizingMode === "AUTO" ? "AUTO" : "FIXED";
      if (spec.primaryAxisAlignItems) frame.primaryAxisAlignItems = spec.primaryAxisAlignItems;
      if (spec.counterAxisAlignItems) frame.counterAxisAlignItems = spec.counterAxisAlignItems;
      if (spec.layoutWrap === "WRAP" && frame.layoutMode === "HORIZONTAL") frame.layoutWrap = "WRAP";
      if (spec.counterAxisSpacing !== void 0 && frame.layoutWrap === "WRAP") {
        try {
          frame.counterAxisSpacing = spec.counterAxisSpacing;
        } catch {
        }
      }
    }
    if (useDefaults || spec.paddingTop !== void 0) frame.paddingTop = spec.paddingTop ?? 0;
    if (useDefaults || spec.paddingRight !== void 0) frame.paddingRight = spec.paddingRight ?? 0;
    if (useDefaults || spec.paddingBottom !== void 0) frame.paddingBottom = spec.paddingBottom ?? 0;
    if (useDefaults || spec.paddingLeft !== void 0) frame.paddingLeft = spec.paddingLeft ?? 0;
    if (!useDefaults && spec.layoutSizingHorizontal) {
      try {
        frame.layoutSizingHorizontal = spec.layoutSizingHorizontal;
        applied.layoutSizingHorizontal = spec.layoutSizingHorizontal;
      } catch {
      }
    }
    if (!useDefaults && spec.layoutSizingVertical) {
      try {
        frame.layoutSizingVertical = spec.layoutSizingVertical;
        applied.layoutSizingVertical = spec.layoutSizingVertical;
      } catch {
      }
    }
    return applied;
  }
  function reassertAxisSizing(frame, spec) {
    if (!spec.layoutMode || spec.layoutMode === "NONE" || spec.layoutMode === "GRID") return;
    if (frame.layoutMode === "NONE") return;
    if (spec.primaryAxisSizingMode) {
      try {
        frame.primaryAxisSizingMode = spec.primaryAxisSizingMode;
      } catch {
      }
    }
    if (spec.counterAxisSizingMode) {
      try {
        frame.counterAxisSizingMode = spec.counterAxisSizingMode;
      } catch {
      }
    }
  }
  function applyChildSizingHints(frame, childNode, childExport) {
    if (frame.layoutMode === "NONE") return;
    const child = childNode;
    try {
      if (childExport.layoutSizingHorizontal) {
        child.layoutSizingHorizontal = childExport.layoutSizingHorizontal;
      } else if (frame.layoutMode === "VERTICAL") {
        if (childExport.type === "FRAME" || childExport.type === "GROUP" || childExport.type === "RECTANGLE") {
          child.layoutSizingHorizontal = "FILL";
        } else if (childExport.type === "TEXT") {
          child.layoutSizingHorizontal = childExport.textAutoResize === "HEIGHT" ? "FIXED" : "HUG";
        }
      }
    } catch {
    }
    try {
      if (childExport.layoutSizingVertical) child.layoutSizingVertical = childExport.layoutSizingVertical;
    } catch {
    }
    try {
      if (childExport.type === "TEXT" && childExport.textAutoResize && childNode.textAutoResize !== childExport.textAutoResize) {
        childNode.textAutoResize = childExport.textAutoResize;
      }
    } catch {
    }
    try {
      if (childExport.layoutGrow && childExport.layoutGrow > 0) child.layoutGrow = childExport.layoutGrow;
    } catch {
    }
    if (childExport.type === "FRAME") reassertAxisSizing(childNode, childExport);
  }
  async function createFrameNode(exportNode, colorStyles, tokenVars) {
    const frame = figma.createFrame();
    frame.name = specNodeName(exportNode);
    if (exportNode.layoutMode && exportNode.layoutMode !== "NONE") {
      applyAutoLayout(frame, exportNode, true);
    }
    if (exportNode.width) {
      const h = exportNode.height || 100;
      frame.resize(exportNode.width, h);
      reassertAxisSizing(frame, exportNode);
    }
    const hasBgImage = !!exportNode.backgroundImageUrl;
    if (exportNode.fills && exportNode.fills.length > 0 || hasBgImage) {
      const figmaFills = [];
      let usedPaintStyle = false;
      for (const fill of exportNode.fills ?? []) {
        const paint = exportFillToPaint(fill);
        if (!paint) continue;
        const paintStyle = paint.type === "SOLID" ? colorStyles.get(figmaColorToHex(fill.color)) : void 0;
        if (paintStyle && !hasBgImage) {
          await frame.setFillStyleIdAsync(paintStyle.id);
          usedPaintStyle = true;
        } else {
          figmaFills.push(paint);
        }
      }
      if (hasBgImage) {
        const scaleMode = backgroundSizeToScaleMode(exportNode.backgroundSize);
        const imgPaint = await resolveImagePaint(exportNode.backgroundImageUrl, scaleMode);
        if (imgPaint) figmaFills.push(imgPaint);
      }
      if (figmaFills.length > 0) frame.fills = figmaFills;
      else if (!usedPaintStyle) frame.fills = [];
    } else {
      frame.fills = [];
    }
    if (exportNode.cornerRadius !== void 0) {
      frame.cornerRadius = exportNode.cornerRadius;
    } else if (exportNode.cornerRadii) {
      frame.topLeftRadius = exportNode.cornerRadii.tl;
      frame.topRightRadius = exportNode.cornerRadii.tr;
      frame.bottomRightRadius = exportNode.cornerRadii.br;
      frame.bottomLeftRadius = exportNode.cornerRadii.bl;
    }
    if (exportNode.effects) frame.effects = mapExportEffects(exportNode.effects);
    if (exportNode.rotation) frame.rotation = exportNode.rotation;
    if (exportNode.blendMode) {
      try {
        frame.blendMode = exportNode.blendMode;
      } catch {
      }
    }
    if (exportNode.counterAxisAlignContent) {
      try {
        frame.counterAxisAlignContent = exportNode.counterAxisAlignContent;
      } catch {
      }
    }
    applyStrokes(frame, exportNode);
    if (exportNode.opacity !== void 0 && exportNode.opacity > 0) {
      frame.opacity = exportNode.opacity;
    }
    try {
      if (exportNode.maxWidth) frame.maxWidth = exportNode.maxWidth;
      if (exportNode.minWidth) frame.minWidth = exportNode.minWidth;
      if (exportNode.maxHeight) frame.maxHeight = exportNode.maxHeight;
      if (exportNode.minHeight) frame.minHeight = exportNode.minHeight;
    } catch {
    }
    frame.clipsContent = !!exportNode.clipsContent;
    if (exportNode.tokenRefs) {
      applyTokenRefs(frame, exportNode.tokenRefs, tokenVars ?? /* @__PURE__ */ new Map());
    }
    if (exportNode.children) {
      for (const childExport of exportNode.children) {
        const childNode = await createFigmaNode(childExport, colorStyles, tokenVars);
        if (!childNode) continue;
        frame.appendChild(childNode);
        if (childExport.absolutePosition && childExport.x !== void 0 && childExport.y !== void 0) {
          try {
            if (frame.layoutMode !== "NONE" && "layoutPositioning" in childNode) {
              childNode.layoutPositioning = "ABSOLUTE";
            }
            childNode.x = childExport.x;
            childNode.y = childExport.y;
          } catch (err) {
            pushImportWarning(`absolute positioning failed on "${childNode.name}" \u2014 left in flow (${String(err)})`);
          }
          continue;
        }
        applyChildSizingHints(frame, childNode, childExport);
      }
    }
    reassertAxisSizing(frame, exportNode);
    return frame;
  }

  // plugin/src/main/serialize-node.ts
  var SERIALIZED_NODE_FIELDS = /* @__PURE__ */ new Set(["id", "name", "type", "x", "y", "width", "height", "children"]);
  function serializeNode(node, depth = 1) {
    const out = {
      id: node.id,
      name: node.name,
      type: node.type,
      x: "x" in node ? Math.round(node.x * 100) / 100 : 0,
      y: "y" in node ? Math.round(node.y * 100) / 100 : 0,
      width: "width" in node ? Math.round(node.width * 100) / 100 : 0,
      height: "height" in node ? Math.round(node.height * 100) / 100 : 0
    };
    if (depth > 0 && "children" in node) {
      out.children = node.children.map((c) => serializeNode(c, depth - 1));
    }
    return out;
  }
  function jsonSafe(value) {
    if (value === void 0) return null;
    try {
      return JSON.parse(JSON.stringify(value, (_k, v) => {
        if (typeof v === "function") return "[Function]";
        if (typeof v === "bigint") return String(v);
        return v;
      }));
    } catch {
      return String(value);
    }
  }
  function safeStringify(v) {
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v) ?? String(v);
    } catch {
      return String(v);
    }
  }
  async function serializeDesignSystem() {
    await figma.loadAllPagesAsync();
    const nodes = figma.root.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
    const components = [];
    for (const n of nodes) {
      if (n.type === "COMPONENT" && n.parent && n.parent.type === "COMPONENT_SET") continue;
      const entry = { id: n.id, key: n.key, name: n.name, type: n.type };
      try {
        const defs = n.componentPropertyDefinitions;
        const axes = {};
        for (const [prop, def] of Object.entries(defs)) {
          if (def.type === "VARIANT") axes[prop] = def.variantOptions ?? [];
        }
        if (Object.keys(axes).length > 0) entry.variantAxes = axes;
      } catch {
      }
      components.push(entry);
    }
    const collections = await figma.variables.getLocalVariableCollectionsAsync();
    const variables = await figma.variables.getLocalVariablesAsync();
    const collectionName = new Map(collections.map((c) => [c.id, c.name]));
    const defaultMode = new Map(collections.map((c) => [c.id, c.modes[0] ? c.modes[0].modeId : ""]));
    const tokens = variables.map((v) => ({
      id: v.id,
      name: v.name,
      type: v.resolvedType,
      collection: collectionName.get(v.variableCollectionId) ?? v.variableCollectionId,
      value: jsonSafe(v.valuesByMode[defaultMode.get(v.variableCollectionId) ?? ""] ?? null)
    }));
    const paint = await figma.getLocalPaintStylesAsync();
    const text = await figma.getLocalTextStylesAsync();
    const effect = await figma.getLocalEffectStylesAsync();
    const styles = [
      ...paint.map((s) => ({ id: s.id, name: s.name, type: "PAINT" })),
      ...text.map((s) => ({ id: s.id, name: s.name, type: "TEXT" })),
      ...effect.map((s) => ({ id: s.id, name: s.name, type: "EFFECT" }))
    ];
    return {
      components,
      tokens,
      styles,
      counts: { components: components.length, tokens: tokens.length, styles: styles.length }
    };
  }

  // shared/audit-types.ts
  var AUDIT_FACTS_SCHEMA = 2;

  // plugin/src/main/executor-audit-units.ts
  var MAX_UNIT_NODES = 300;
  var MAX_UNIT_DEPTH = 10;
  var MAX_UNIT_TEXT = 2e3;
  var CAPPED = "\u2026capped";
  function hex2(c) {
    const v = Math.max(0, Math.min(255, Math.round(c * 255)));
    return v.toString(16).padStart(2, "0");
  }
  function paintFingerprint(prefix, p) {
    if (p.type === "SOLID") {
      const bound = p.boundVariables?.color;
      if (bound) return `${prefix}:var:${bound.id}`;
      let s = `${prefix}:#${hex2(p.color.r)}${hex2(p.color.g)}${hex2(p.color.b)}`;
      if (typeof p.opacity === "number" && p.opacity < 1) s += `@${p.opacity.toFixed(2)}`;
      return s;
    }
    return `${prefix}:${p.type}`;
  }
  function collectPaints(node, st) {
    for (const field of ["fills", "strokes"]) {
      if (!(field in node)) continue;
      let paints;
      try {
        paints = node[field];
      } catch {
        continue;
      }
      if (!Array.isArray(paints)) continue;
      const prefix = field === "fills" ? "f" : "s";
      for (const p of paints) st.paints.push(paintFingerprint(prefix, p));
    }
  }
  function walk(node, depth, isRoot, st) {
    if (st.cappedNodes) return;
    if (st.nodes >= MAX_UNIT_NODES) {
      st.structure.push(CAPPED);
      st.cappedNodes = true;
      return;
    }
    st.nodes++;
    let w = 0;
    let h = 0;
    try {
      w = Math.round(node.width);
      h = Math.round(node.height);
    } catch {
      w = 0;
      h = 0;
    }
    st.structure.push(`${depth}:${node.type}:${isRoot ? "" : node.name}:${w}x${h}`);
    if (node.type === "TEXT") {
      try {
        const chars = node.characters;
        if (!st.cappedText) {
          if (st.textLen + chars.length > MAX_UNIT_TEXT) {
            st.texts.push(CAPPED);
            st.cappedText = true;
          } else {
            st.texts.push(chars);
            st.textLen += chars.length;
          }
        }
      } catch {
      }
    }
    collectPaints(node, st);
    if (node.type === "INSTANCE") return;
    if (depth >= MAX_UNIT_DEPTH) return;
    if ("children" in node) {
      for (const child of node.children) {
        if (st.cappedNodes) break;
        walk(child, depth + 1, false, st);
      }
    }
  }
  function unitFact(node) {
    const st = {
      structure: [],
      texts: [],
      paints: [],
      nodes: 0,
      textLen: 0,
      cappedNodes: false,
      cappedText: false
    };
    walk(node, 0, true, st);
    return { id: node.id, name: node.name, structure: st.structure, texts: st.texts, paints: st.paints };
  }

  // plugin/src/main/executor-audit.ts
  function countUnboundPaints(node, field) {
    if (!(field in node)) return 0;
    let paints;
    try {
      paints = node[field];
    } catch {
      return 0;
    }
    if (!Array.isArray(paints)) return 0;
    let n = 0;
    for (const p of paints) {
      if (p.type === "SOLID" && !p.boundVariables?.color) n++;
    }
    return n;
  }
  async function getInstancesAsyncLength(node) {
    const fn = node.getInstancesAsync;
    if (typeof fn !== "function") return null;
    try {
      const instances = await fn.call(node);
      return Array.isArray(instances) ? instances.length : null;
    } catch {
      return null;
    }
  }
  async function factForNode(n, pageName) {
    let variantAxes = {};
    try {
      const defs = n.componentPropertyDefinitions;
      for (const [prop, def] of Object.entries(defs)) {
        if (def.type === "VARIANT") variantAxes[prop] = def.variantOptions ?? [];
      }
    } catch {
      variantAxes = {};
    }
    const variantCount = n.type === "COMPONENT_SET" ? n.children.length : 0;
    let section2 = null;
    let p = n.parent;
    while (p) {
      if (p.type === "SECTION") {
        section2 = p.name;
        break;
      }
      p = p.parent;
    }
    const deprecatedData = n.getSharedPluginData("idp", "status") === "deprecated";
    let width = 0;
    let height = 0;
    try {
      width = Math.round(n.width);
      height = Math.round(n.height);
    } catch {
      width = 0;
      height = 0;
    }
    const rep = n.type === "COMPONENT_SET" ? n.children[0] : n;
    const repChildren = rep && "children" in rep ? [...rep.children] : [];
    let unboundFills = 0;
    let unboundStrokes = 0;
    for (const s of rep ? [rep, ...repChildren] : []) {
      unboundFills += countUnboundPaints(s, "fills");
      unboundStrokes += countUnboundPaints(s, "strokes");
    }
    let units;
    if (n.type === "COMPONENT_SET") {
      units = [];
      for (const child of n.children) {
        units.push({ ...unitFact(child), usageCount: await getInstancesAsyncLength(child) });
      }
    } else {
      units = [{ ...unitFact(n), usageCount: null }];
    }
    return {
      id: n.id,
      key: n.key ?? null,
      name: n.name,
      type: n.type,
      variantCount,
      variantAxes,
      pageName,
      section: section2,
      deprecatedData,
      width,
      height,
      unboundFills,
      unboundStrokes,
      units
    };
  }
  async function inventoryPage(page) {
    const nodes = page.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
    const facts = [];
    for (const n of nodes) {
      if (n.type === "COMPONENT" && n.parent && n.parent.type === "COMPONENT_SET") continue;
      facts.push(await factForNode(n, page.name));
    }
    return facts;
  }
  async function tallyUsagePage(page, usage) {
    var _a, _b;
    const cnt = {};
    const reps = {};
    page.findAll((node) => {
      var _a2;
      if (node.type === "INSTANCE") {
        cnt[node.name] = (cnt[node.name] ?? 0) + 1;
        reps[_a2 = node.name] ?? (reps[_a2] = node);
      }
      return false;
    });
    let tallied = 0;
    for (const name of Object.keys(reps)) {
      const c = cnt[name];
      tallied += c;
      let key = null;
      try {
        const main = await reps[name].getMainComponentAsync();
        if (main) key = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : main;
      } catch {
        key = null;
      }
      if (key) {
        usage.byMainId[key.id] = (usage.byMainId[key.id] ?? 0) + c;
        const pages = (_a = usage.pagesById)[_b = key.id] ?? (_a[_b] = []);
        if (!pages.includes(page.name)) pages.push(page.name);
      } else {
        usage.unresolved += c;
      }
    }
    return tallied;
  }
  async function auditDs() {
    const pages = figma.root.children;
    const components = [];
    const usage = { byMainId: {}, pagesById: {}, unresolved: 0 };
    const skippedPages = [];
    let instancesTallied = 0;
    for (const page of pages) {
      try {
        await figma.setCurrentPageAsync(page);
      } catch {
        skippedPages.push(page.name);
        continue;
      }
      components.push(...await inventoryPage(page));
      instancesTallied += await tallyUsagePage(page, usage);
    }
    const masters = components.length;
    const sets = components.filter((c) => c.type === "COMPONENT_SET").length;
    const variants = components.reduce((sum, c) => sum + c.variantCount, 0);
    return {
      schema: AUDIT_FACTS_SCHEMA,
      // Only plain objects survive past a page boundary (C5) — no SceneNode is retained.
      file: {
        fileName: figma.root.name,
        pages: pages.map((pg) => ({ id: pg.id, name: pg.name })),
        skippedPages
      },
      components,
      usage,
      counts: { masters, sets, standalone: masters - sets, variants, instancesTallied }
    };
  }

  // plugin/src/main/executor-ops.ts
  var PLUGIN_VERSION = "0.1.0";
  var LAYOUT_MODE_MAP = {
    H: "HORIZONTAL",
    V: "VERTICAL",
    HORIZONTAL: "HORIZONTAL",
    VERTICAL: "VERTICAL",
    GRID: "GRID",
    NONE: "NONE"
  };
  var NUM_PARAM_ALIASES = [
    ["itemSpacing", "gap", "itemSpacing"],
    ["counterAxisSpacing", "counterAxisSpacing"],
    ["gridRowCount", "rows", "gridRowCount"],
    ["gridColumnCount", "cols", "gridColumnCount"],
    ["gridRowGap", "rowGap", "gridRowGap"],
    ["gridColumnGap", "colGap", "gridColumnGap"],
    ["paddingTop", "paddingTop"],
    ["paddingRight", "paddingRight"],
    ["paddingBottom", "paddingBottom"],
    ["paddingLeft", "paddingLeft"]
  ];
  var STR_PARAM_ALIASES = [
    ["primaryAxisAlignItems", "alignPrimary"],
    ["counterAxisAlignItems", "alignCounter"],
    ["layoutSizingHorizontal", "sizingH"],
    ["layoutSizingVertical", "sizingV"]
  ];
  function normalizeAutoLayoutParams(params) {
    const num = (v) => typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : void 0;
    const spec = {};
    const rawMode = params.mode ?? params.layoutMode;
    if (typeof rawMode === "string") spec.layoutMode = LAYOUT_MODE_MAP[rawMode.toUpperCase()];
    const padList = Array.isArray(params.pad) ? params.pad : typeof params.pad === "string" ? params.pad.split(",") : null;
    if (padList) {
      const [t, r, b, l] = padList.map((p) => num(p) ?? 0);
      spec.paddingTop = t;
      spec.paddingRight = r ?? t;
      spec.paddingBottom = b ?? t;
      spec.paddingLeft = l ?? r ?? t;
    }
    if (params.padding && typeof params.padding === "object") {
      const p = params.padding;
      if (num(p.top) !== void 0) spec.paddingTop = num(p.top);
      if (num(p.right) !== void 0) spec.paddingRight = num(p.right);
      if (num(p.bottom) !== void 0) spec.paddingBottom = num(p.bottom);
      if (num(p.left) !== void 0) spec.paddingLeft = num(p.left);
    }
    for (const [field, ...aliases] of NUM_PARAM_ALIASES) {
      for (const alias of aliases) {
        const v = num(params[alias]);
        if (v !== void 0) {
          spec[field] = v;
          break;
        }
      }
    }
    for (const [field, alias] of STR_PARAM_ALIASES) {
      if (typeof params[alias] === "string") spec[field] = params[alias].toUpperCase();
    }
    if (params.wrap === true || params.wrap === "WRAP") spec.layoutWrap = "WRAP";
    return spec;
  }
  async function getSceneNode(id, label = "node") {
    if (typeof id !== "string" || !id) throw withCode(new Error(`missing ${label} id`), "E_INVALID_ARGS");
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.type === "DOCUMENT" || node.type === "PAGE") {
      throw withCode(new Error(`${label} not found: ${id}`), "E_INVALID_ARGS");
    }
    return node;
  }
  async function appendToParent(node, params) {
    const parentId = params.parentId ?? params.parent;
    if (typeof parentId === "string" && parentId) {
      const parent = await figma.getNodeByIdAsync(parentId);
      if (parent && "appendChild" in parent) parent.appendChild(node);
    }
    if (typeof params.x === "number") node.x = params.x;
    if (typeof params.y === "number") node.y = params.y;
  }
  function opStatus(bootSkipped2 = [], readOnlyViolations2 = 0, gapfill, capture2) {
    return {
      fileName: figma.root.name,
      page: figma.currentPage.name,
      user: figma.currentUser ? figma.currentUser.name : null,
      pluginVersion: PLUGIN_VERSION,
      // Additive field (absorption phase-02) — phases 03/04 (FigJam, Slides) and
      // shared/editor-surface.ts's guard both read this. Read figma.editorType
      // DIRECTLY, never inferred from the file name or which commands succeeded.
      // `null` (NOT the fork's own silent `|| 'figma'` default, code.js:74) when an
      // older host reports nothing — a guessed default is exactly what this repo bans;
      // the guard treats null as "unknown: refuse and say so".
      editorType: figma.editorType ?? null,
      // Additive field (absorption phase-03) — same "present only once meaningful"
      // contract as the broker's senderMismatchCount/legacyMigrationDeferred (issue
      // #15/#19): which design-only boot capabilities main.ts consciously chose NOT to
      // run this session (e.g. a future editor-specific skip), never left for an agent
      // to infer from a later failure. `bootSkipped` is caller-supplied (main.ts owns
      // the actual list) — this function never guesses what was skipped. Empty today:
      // the phase-03 boot-path trace found nothing in the current boot sequence that
      // needs skipping in FigJam (gap-fill/capture already degrade honestly there; see
      // knowledge/figjam.md) — the field exists so a FUTURE editor (phase-04 Slides, or
      // a later FigJam finding) has somewhere to report one, without a payload shape
      // change.
      ...bootSkipped2.length > 0 && { bootSkipped: [...bootSkipped2] },
      // Concurrency & jobs — same "present only once meaningful" contract as
      // bootSkipped just above and the broker's own senderMismatchCount: a fleet that has
      // never seen a mis-declared `--read-only` EXEC_JS keeps this payload byte-identical
      // to before the field existed; a non-zero count makes a real pattern visible instead
      // of vanishing into a silently-applied mutation.
      ...readOnlyViolations2 > 0 && { readOnlyViolations: readOnlyViolations2 },
      // Reconnect gap-fill's own session record (shared/protocol.ts's GapfillStatus). Unlike
      // the two counters above this block is ALWAYS present once main.ts supplies it, even
      // when every number is zero: "the baseline was never written" is precisely the fact
      // that stayed invisible while the feature was silently broken, so it must have a
      // reading of its own rather than an absence that looks like health. Caller-supplied —
      // this function never re-derives what gap-fill did.
      ...gapfill && { gapfill },
      // Live capture's own session record (document-change-capture.ts). All three keep the
      // present-only-when-meaningful contract of the counters above — a session that filtered
      // nothing, guessed no page and hit no store failure keeps the payload byte-identical to
      // before these fields existed — because each records something that DID happen and
      // would otherwise leave no trace at all:
      //   · how many entries were dropped as the plugin's own bookkeeping echo (a property
      //     change whose every property is `pluginData`): a filtered change is still a change,
      //     and without a count the only way to notice the predicate had started eating real
      //     edits would be a designer reporting a missing one;
      //   · how many live nodes had no resolvable page and were filed under the current one:
      //     that page name is a guess about someone else's edit;
      //   · correction-store failures, as first message + count (the gapfill block's shape) —
      //     the feed is posted regardless, so nothing else would ever report the refusal.
      ...capture2 && capture2.pluginDataChangesDropped > 0 && { pluginDataChangesDropped: capture2.pluginDataChangesDropped },
      ...capture2 && capture2.pageFallbacks > 0 && { pageFallbacks: capture2.pageFallbacks },
      ...capture2 && capture2.firstError !== null && { captureErrors: [capture2.firstError], captureErrorCount: capture2.errorCount }
    };
  }
  function opGetSelection(params) {
    const depth = typeof params.depth === "number" ? params.depth : 1;
    return { selection: figma.currentPage.selection.map((n) => serializeNode(n, depth)) };
  }
  async function opCreateFrame(params) {
    const frame = figma.createFrame();
    frame.name = typeof params.name === "string" && params.name ? params.name : "Frame";
    const w = Number(params.width ?? params.w) || 100;
    const h = Number(params.height ?? params.h) || 100;
    frame.resize(w, h);
    await appendToParent(frame, params);
    return { id: frame.id, name: frame.name };
  }
  async function opCreateInstance(params) {
    const ref = params.component ?? params.key ?? params.id;
    if (typeof ref !== "string" || !ref) {
      throw withCode(new Error("CREATE_INSTANCE requires params.component (library key or local node id)"), "E_INVALID_ARGS");
    }
    let component = null;
    if (!ref.includes(":")) {
      try {
        component = await figma.importComponentByKeyAsync(ref);
      } catch {
      }
    }
    if (!component) {
      const local = await figma.getNodeByIdAsync(ref);
      if (local && local.type === "COMPONENT") component = local;
      else if (local && local.type === "COMPONENT_SET") component = local.defaultVariant;
    }
    if (!component) throw withCode(new Error(`component not found: ${ref}`), "E_INVALID_ARGS");
    const instance = component.createInstance();
    await appendToParent(instance, params);
    return {
      id: instance.id,
      name: instance.name,
      mainComponent: { id: component.id, key: component.key, name: component.name }
    };
  }
  async function opSetVariant(params) {
    const node = await getSceneNode(params.nodeId ?? params.node);
    if (node.type !== "INSTANCE") {
      throw withCode(new Error(`SET_VARIANT target must be an INSTANCE, got ${node.type}`), "E_INVALID_ARGS");
    }
    const props = params.props;
    if (!props || typeof props !== "object") {
      throw withCode(new Error("SET_VARIANT requires params.props {property: value}"), "E_INVALID_ARGS");
    }
    node.setProperties(props);
    const variantProps = {};
    try {
      for (const [k, v] of Object.entries(node.componentProperties)) variantProps[k] = v.value;
    } catch {
    }
    return { id: node.id, variantProps };
  }
  async function opSetAutoLayout(params) {
    const node = await getSceneNode(params.nodeId ?? params.node);
    if (!("layoutMode" in node)) {
      throw withCode(new Error(`node ${node.id} (${node.type}) does not support auto-layout`), "E_INVALID_ARGS");
    }
    const applied = applyAutoLayout(node, normalizeAutoLayoutParams(params), false);
    return { id: node.id, applied };
  }
  async function opSetConstraints(params) {
    const node = await getSceneNode(params.nodeId ?? params.node);
    if (!("constraints" in node)) {
      throw withCode(new Error(`node ${node.id} (${node.type}) does not support constraints`), "E_INVALID_ARGS");
    }
    const horizontal = params.horizontal ?? params.h ?? "MIN";
    const vertical = params.vertical ?? params.v ?? "MIN";
    node.constraints = { horizontal, vertical };
    return { id: node.id };
  }
  async function opSetText(params) {
    const node = await getSceneNode(params.nodeId ?? params.node);
    if (node.type !== "TEXT") {
      throw withCode(new Error(`SET_TEXT target must be TEXT, got ${node.type}`), "E_INVALID_ARGS");
    }
    if (node.characters.length > 0) {
      for (const f of node.getRangeAllFontNames(0, node.characters.length)) await figma.loadFontAsync(f);
    } else if (node.fontName !== figma.mixed) {
      await figma.loadFontAsync(node.fontName);
    }
    const reqFamily = params.fontFamily ?? params.family;
    const reqWeight = params.fontWeight ?? params.weight;
    const reqSize = params.fontSize ?? params.size;
    if (typeof reqFamily === "string" || typeof reqWeight === "number") {
      const family = typeof reqFamily === "string" && reqFamily ? reqFamily : node.fontName !== figma.mixed ? node.fontName.family : "Inter";
      const weight = typeof reqWeight === "number" ? reqWeight : 400;
      node.fontName = await loadBestFont(family, weight);
    }
    if (typeof params.characters === "string") node.characters = params.characters;
    if (typeof reqSize === "number") node.fontSize = reqSize;
    return { id: node.id, name: node.name };
  }
  async function opExportPng(params) {
    const id = params.nodeId ?? params.node;
    const target = typeof id === "string" && id ? await getSceneNode(id) : figma.currentPage.selection[0] ?? null;
    if (!target) throw withCode(new Error("EXPORT_PNG: no node id given and selection is empty"), "E_INVALID_ARGS");
    const scale = typeof params.scale === "number" && params.scale > 0 ? params.scale : 2;
    const bytes = await target.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
    return {
      base64: figma.base64Encode(bytes),
      w: Math.round(target.width * scale),
      h: Math.round(target.height * scale)
    };
  }

  // shared/editor-surface.ts
  var EDITOR_LABEL = {
    figma: "a Figma design file",
    figjam: "a FigJam board",
    slides: "a Figma Slides deck",
    dev: "Dev Mode"
  };
  var NEXT_ACTION = {
    figma: "open this file in Figma (design mode) and re-run",
    figjam: "open this board in FigJam and re-run",
    slides: "open this deck in Figma Slides and re-run",
    dev: "switch to Dev Mode and re-run"
  };
  function editorRefusal(opts) {
    const { capability, required, found } = opts;
    if (found !== null && required.includes(found)) return null;
    const foundLabel = found === null ? "the host did not report an editor type" : EDITOR_LABEL[found];
    const requiredLabels = required.filter((r) => r !== null).map((r) => EDITOR_LABEL[r]);
    const requiredList = requiredLabels.length === 1 ? requiredLabels[0] : `one of: ${requiredLabels.join(", ")}`;
    const firstRequired = required.find((r) => r !== null);
    const nextAction = firstRequired ? NEXT_ACTION[firstRequired] : "reopen the file the capability needs";
    return `${capability} needs ${requiredList}, but ${foundLabel} is open \u2014 ${nextAction}.`;
  }

  // plugin/src/main/exec-stdlib-editor.ts
  function requireEditor(capability, required) {
    const found = figma.editorType ?? null;
    const message = editorRefusal({ capability, required, found });
    if (message !== null) throw withCode(new Error(message), "E_INVALID_ARGS");
  }
  function requireDesignFile(capability) {
    requireEditor(capability, ["figma"]);
  }

  // plugin/src/main/exec-stdlib-instance.ts
  function resolvePropKey(keys, name) {
    if (keys.includes(name)) return name;
    const matches = keys.filter((k) => k.startsWith(`${name}#`));
    if (matches.length === 0) {
      throw new Error(`property "${name}" not found \u2014 available: ${keys.join(", ")}`);
    }
    if (matches.length > 1) {
      throw new Error(`property "${name}" is ambiguous: ${matches.join(", ")}`);
    }
    return matches[0];
  }
  async function setProps(inst, props) {
    requireDesignFile("ui.setProps");
    if (inst.type !== "INSTANCE") {
      throw withCode(new Error(`setProps expects an INSTANCE, got ${inst.type}`), "E_EVAL");
    }
    const current = inst.componentProperties;
    const keys = Object.keys(current);
    const resolved = {};
    for (const [name, rawValue] of Object.entries(props)) {
      let key;
      try {
        key = resolvePropKey(keys, name);
      } catch (err) {
        throw withCode(new Error(`${err instanceof Error ? err.message : String(err)} on "${inst.name}"`), "E_EVAL");
      }
      if (typeof rawValue !== "string" && typeof rawValue !== "boolean") {
        throw withCode(new Error(`property "${key}" needs a string or boolean, got ${typeof rawValue}`), "E_EVAL");
      }
      let value = rawValue;
      if (current[key]?.type === "INSTANCE_SWAP" && typeof value === "string" && !/^\d+:\d+$/.test(value)) {
        const c = await resolveMainComponent({ componentKey: value });
        if (!c) throw withCode(new Error(`component not found for property "${key}": ${value}`), "E_EVAL");
        value = c.id;
      }
      resolved[key] = value;
    }
    try {
      inst.setProperties(resolved);
    } catch (err) {
      throw withCode(
        new Error(`setProps ${JSON.stringify(resolved)} failed: ${err instanceof Error ? err.message : String(err)}`),
        "E_EVAL"
      );
    }
    const reread = inst.componentProperties;
    const out = {};
    for (const [key, value] of Object.entries(resolved)) {
      const actual = reread[key]?.value;
      if (!Object.is(actual, value)) {
        throw withCode(new Error(`setProps applied but "${key}" is still ${String(actual)}`), "E_EVAL");
      }
      out[key] = actual;
    }
    return out;
  }
  async function swapInstance(inst, ref) {
    requireDesignFile("ui.swapInstance");
    if (inst.type !== "INSTANCE") {
      throw withCode(new Error(`swapInstance expects an INSTANCE, got ${inst.type}`), "E_EVAL");
    }
    const component = ref.includes(":") ? await resolveMainComponent({ componentId: ref }) : await resolveMainComponent({ componentKey: ref });
    if (!component) throw withCode(new Error(`component not found: ${ref}`), "E_EVAL");
    inst.swapComponent(component);
    const main = await inst.getMainComponentAsync();
    if (!main || main.id !== component.id) {
      throw withCode(new Error(`swapInstance applied but main is still "${main?.id ?? "unknown"}"`), "E_EVAL");
    }
    return { id: inst.id, mainComponent: { id: component.id, name: component.name } };
  }

  // plugin/src/main/exec-stdlib-variables.ts
  function listWithMore(names, cap = 20) {
    const shown = names.slice(0, cap).join(", ");
    const rest = names.length - cap;
    return rest > 0 ? `${shown} (+${rest} more)` : shown;
  }
  async function resolveCollection(ref) {
    const all = await figma.variables.getLocalVariableCollectionsAsync();
    const byId = all.find((c) => c.id === ref);
    if (byId) return byId;
    const byName = all.find((c) => c.name === ref);
    if (byName) return byName;
    throw withCode(
      new Error(`collection not found: "${ref}" \u2014 available: ${listWithMore(all.map((c) => c.name))}`),
      "E_INVALID_ARGS"
    );
  }
  function modeList(collection) {
    return collection.modes.map((m) => ({ modeId: m.modeId, name: m.name }));
  }
  function findMode(collection, modeId) {
    const mode = collection.modes.find((m) => m.modeId === modeId);
    if (!mode) {
      throw withCode(
        new Error(`mode not found: "${modeId}" on collection "${collection.name}" \u2014 available: ${listWithMore(collection.modes.map((m) => m.name))}`),
        "E_INVALID_ARGS"
      );
    }
    return mode;
  }
  async function rename(ref, newName) {
    if (typeof newName !== "string" || newName.length === 0) {
      throw withCode(new Error("rename requires a non-empty newName"), "E_INVALID_ARGS");
    }
    const variable = await resolveVariable(ref);
    const oldName = variable.name;
    variable.name = newName;
    if (variable.name !== newName) {
      throw withCode(new Error(`rename applied but variable.name is still "${variable.name}"`), "E_EVAL");
    }
    return { id: variable.id, name: variable.name, oldName };
  }
  async function remove(ref) {
    const variable = await resolveVariable(ref);
    const id = variable.id;
    const name = variable.name;
    variable.remove();
    return { id, name, boundReferencesChecked: false };
  }
  async function describe(ref, description) {
    if (typeof description !== "string") {
      throw withCode(new Error("describe requires a string description"), "E_INVALID_ARGS");
    }
    const variable = await resolveVariable(ref);
    variable.description = description;
    if (variable.description !== description) {
      throw withCode(new Error(`describe applied but variable.description is still "${variable.description}"`), "E_EVAL");
    }
    return { id: variable.id, name: variable.name, description: variable.description };
  }
  async function addMode(collectionRef, modeName) {
    if (typeof modeName !== "string" || modeName.length === 0) {
      throw withCode(new Error("addMode requires a non-empty modeName"), "E_INVALID_ARGS");
    }
    const collection = await resolveCollection(collectionRef);
    const before = collection.modes.length;
    let modeId;
    try {
      modeId = collection.addMode(modeName);
    } catch (err) {
      throw withCode(new Error(`addMode "${modeName}" failed: ${String(err)}`), "E_EVAL");
    }
    if (collection.modes.length !== before + 1 || !collection.modes.some((m) => m.modeId === modeId)) {
      throw withCode(new Error(`addMode "${modeName}" did not take \u2014 modes: ${collection.modes.map((m) => m.name).join(", ")}`), "E_EVAL");
    }
    return { collectionId: collection.id, name: collection.name, modes: modeList(collection) };
  }
  async function renameMode(collectionRef, modeId, newName) {
    if (typeof newName !== "string" || newName.length === 0) {
      throw withCode(new Error("renameMode requires a non-empty newName"), "E_INVALID_ARGS");
    }
    const collection = await resolveCollection(collectionRef);
    const mode = findMode(collection, modeId);
    const oldName = mode.name;
    collection.renameMode(modeId, newName);
    const after = findMode(collection, modeId);
    if (after.name !== newName) {
      throw withCode(new Error(`renameMode applied but mode "${modeId}" is still "${after.name}"`), "E_EVAL");
    }
    return { collectionId: collection.id, modes: modeList(collection), oldName };
  }
  async function removeMode(collectionRef, modeId) {
    const collection = await resolveCollection(collectionRef);
    findMode(collection, modeId);
    collection.removeMode(modeId);
    if (collection.modes.some((m) => m.modeId === modeId)) {
      throw withCode(new Error(`removeMode applied but "${modeId}" is still present`), "E_EVAL");
    }
    return { collectionId: collection.id, modes: modeList(collection) };
  }
  async function setModeValue(ref, modeName, value) {
    const variable = await resolveVariable(ref);
    const collection = await resolveCollectionOfVariable(variable);
    const mode = collection.modes.find((m) => m.name === modeName);
    if (!mode) {
      throw withCode(
        new Error(`mode "${modeName}" not found on collection "${collection.name}" \u2014 available: ${listWithMore(collection.modes.map((m) => m.name))}`),
        "E_INVALID_ARGS"
      );
    }
    variable.setValueForMode(mode.modeId, value);
    const actual = variable.valuesByMode[mode.modeId];
    if (!valuesEqual(actual, value)) {
      throw withCode(new Error(`setModeValue applied but "${modeName}" reads back ${JSON.stringify(actual)}, not ${JSON.stringify(value)}`), "E_EVAL");
    }
    return { id: variable.id, name: variable.name, mode: { modeId: mode.modeId, name: mode.name }, value: actual };
  }
  async function resolveCollectionOfVariable(variable) {
    const all = await figma.variables.getLocalVariableCollectionsAsync();
    const collection = all.find((c) => c.id === variable.variableCollectionId);
    if (!collection) {
      throw withCode(new Error(`collection not found for variable "${variable.name}" (${variable.variableCollectionId})`), "E_EVAL");
    }
    return collection;
  }
  function createExecStdlibVars() {
    return { rename, remove, describe, addMode, renameMode, removeMode, setModeValue };
  }

  // plugin/src/main/exec-stdlib-component-matrix.ts
  var MAX_VARIANTS = 100;
  var WARN_ABOVE = 40;
  function assertCleanToken(kind, s) {
    if (s.includes("=") || s.includes(",")) {
      throw withCode(new Error(`${kind} "${s}" must not contain "=" or "," \u2014 Figma parses variant names on those characters`), "E_INVALID_ARGS");
    }
  }
  function comboName(combo, axisOrder) {
    return axisOrder.map((a) => `${a}=${combo[a]}`).join(", ");
  }
  function cartesianProduct(axes) {
    const axisOrder = Object.keys(axes);
    let combos = [{}];
    for (const axis of axisOrder) {
      const next = [];
      for (const c of combos) for (const v of axes[axis]) next.push({ ...c, [axis]: v });
      combos = next;
    }
    return combos;
  }
  function parseComboName(name) {
    const out = {};
    for (const part of name.split(", ")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return out;
  }
  function sameAxisMap(a, b) {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) => a[k] === b[k]);
  }

  // plugin/src/main/exec-stdlib-component-build.ts
  async function buildModeA(base, axes) {
    const baseNode = await figma.getNodeByIdAsync(base);
    if (!baseNode || baseNode.type !== "COMPONENT") {
      throw withCode(new Error(`base must be a COMPONENT node id, got ${baseNode?.type ?? "not found"}: ${base}`), "E_INVALID_ARGS");
    }
    if (baseNode.parent?.type === "COMPONENT_SET") {
      throw withCode(new Error(`base "${baseNode.name}" is already a variant inside "${baseNode.parent.name}"`), "E_INVALID_ARGS");
    }
    const axisOrder = Object.keys(axes);
    for (const axis of axisOrder) {
      assertCleanToken("axis", axis);
      const values = axes[axis];
      if (values.length === 0) throw withCode(new Error(`axis "${axis}" has no values`), "E_INVALID_ARGS");
      for (const v of values) assertCleanToken("value", v);
    }
    const combos = cartesianProduct(axes);
    if (combos.length > MAX_VARIANTS) {
      throw withCode(new Error(`${combos.length} variants requested \u2014 capped at ${MAX_VARIANTS}. Split by one axis and build multiple sets.`), "E_INVALID_ARGS");
    }
    const originalBaseName = baseNode.name;
    const stepY = Math.ceil(baseNode.height) + 40;
    baseNode.name = comboName(combos[0], axisOrder);
    const nodes = [baseNode];
    for (let i = 1; i < combos.length; i++) {
      const clone = baseNode.clone();
      clone.name = comboName(combos[i], axisOrder);
      clone.y = baseNode.y + i * stepY;
      nodes.push(clone);
    }
    const clones = nodes.slice(1);
    return {
      nodes,
      expected: combos,
      warnings: [],
      cleanup() {
        for (const c of clones) c.remove();
        baseNode.name = originalBaseName;
      }
    };
  }
  async function buildModeB(ids, variantProps) {
    if (ids.length > MAX_VARIANTS) {
      throw withCode(new Error(`${ids.length} components requested \u2014 capped at ${MAX_VARIANTS}.`), "E_INVALID_ARGS");
    }
    if (variantProps && variantProps.length !== ids.length) {
      throw withCode(new Error(`variantProps length (${variantProps.length}) must match components length (${ids.length})`), "E_INVALID_ARGS");
    }
    const resolved = [];
    for (let i = 0; i < ids.length; i++) {
      const node = await figma.getNodeByIdAsync(ids[i]);
      if (!node || node.type !== "COMPONENT") {
        throw withCode(new Error(`components[${i}] must be a COMPONENT node id, got ${node?.type ?? "not found"}: ${ids[i]}`), "E_INVALID_ARGS");
      }
      if (node.parent?.type === "COMPONENT_SET") {
        throw withCode(new Error(`components[${i}] "${node.name}" is already a variant inside "${node.parent.name}"`), "E_INVALID_ARGS");
      }
      if (variantProps) {
        const props = variantProps[i];
        const keys = Object.keys(props);
        if (keys.length === 0) throw withCode(new Error(`variantProps[${i}] is empty \u2014 needs at least one property`), "E_INVALID_ARGS");
        for (const k of keys) {
          assertCleanToken("property", k);
          assertCleanToken("value", props[k]);
        }
      }
      resolved.push(node);
    }
    const nodes = [];
    const expected = [];
    const warnings2 = [];
    const renamed = [];
    for (let i = 0; i < resolved.length; i++) {
      const node = resolved[i];
      if (variantProps) {
        const props = variantProps[i];
        const keys = Object.keys(props);
        renamed.push({ node, originalName: node.name });
        node.name = comboName(props, keys);
        expected.push({ ...props });
      } else {
        if (!node.name.includes("=")) {
          warnings2.push(`component "${node.name}" is not named "Prop=Value" \u2014 Figma will file it under "Property 1=${node.name}"`);
          expected.push({});
        } else {
          expected.push(parseComboName(node.name));
        }
      }
      nodes.push(node);
    }
    return {
      nodes,
      expected,
      warnings: warnings2,
      cleanup() {
        for (const { node, originalName } of renamed) node.name = originalName;
      }
    };
  }

  // shared/safe-cleanup.ts
  function safeCleanup(originalError, cleanupFn) {
    try {
      cleanupFn();
    } catch (cleanupError) {
      attachCleanupError(originalError, cleanupError);
    }
    throw originalError;
  }
  function attachCleanupError(originalError, cleanupError) {
    const canAttach = originalError !== null && typeof originalError === "object" && Object.isExtensible(originalError);
    if (!canAttach) {
      console.error("safeCleanup: cleanup failed and originalError is not extensible, logging instead of attaching:", cleanupError);
      return;
    }
    try {
      originalError.cleanupError = cleanupError;
    } catch (attachError) {
      console.error("safeCleanup: failed to attach cleanupError despite isExtensible check:", cleanupError, attachError);
    }
  }

  // plugin/src/main/exec-stdlib-component-set.ts
  var VALID_PARENT_TYPES = /* @__PURE__ */ new Set(["PAGE", "FRAME", "SECTION", "GROUP"]);
  async function resolveParent(ref) {
    if (!ref) return figma.currentPage;
    const node = await figma.getNodeByIdAsync(ref);
    if (!node || !VALID_PARENT_TYPES.has(node.type)) {
      throw withCode(new Error(`parent not found or cannot contain a component set: ${ref}`), "E_INVALID_ARGS");
    }
    return node;
  }
  async function componentSet(opts) {
    requireDesignFile("ui.componentSet");
    const hasBase = typeof opts.base === "string";
    const hasComponents = Array.isArray(opts.components) && opts.components.length > 0;
    if (hasBase === hasComponents) {
      throw withCode(new Error("componentSet needs exactly one of: base + axes, or components"), "E_INVALID_ARGS");
    }
    if (hasBase && (!opts.axes || Object.keys(opts.axes).length === 0)) {
      throw withCode(new Error('axes is required with base \u2014 e.g. { State: ["default","hover"], Size: ["sm","lg"] }'), "E_INVALID_ARGS");
    }
    const build = hasBase ? await buildModeA(opts.base, opts.axes) : await buildModeB(opts.components, opts.variantProps);
    try {
      const parent = await resolveParent(opts.parent);
      const set2 = figma.combineAsVariants(build.nodes, parent);
      if (opts.name) set2.name = opts.name;
      if (typeof opts.x === "number") set2.x = opts.x;
      if (typeof opts.y === "number") set2.y = opts.y;
      const children = set2.children.filter((c) => c.type === "COMPONENT");
      if (children.length !== build.nodes.length) {
        throw withCode(new Error(`componentSet combined ${children.length} children, expected ${build.nodes.length}`), "E_EVAL");
      }
      const actualAxes = children.map((c) => parseComboName(c.name));
      const mismatches = build.expected.map((exp, i) => ({ i, exp, actual: actualAxes[i] })).filter(({ exp, actual }) => !actual || !sameAxisMap(exp, actual));
      if (mismatches.length > 0) {
        throw withCode(new Error(`componentSet variant names did not parse back to the intended axes: ${JSON.stringify(mismatches)}`), "E_EVAL");
      }
      const propertyDefinitions = set2.componentPropertyDefinitions ?? {};
      const variantCount = children.length;
      const sizeWarning = variantCount > WARN_ABOVE ? `${variantCount} variants \u2014 large sets are slow to build; consider splitting by one axis` : void 0;
      return {
        id: set2.id,
        name: set2.name,
        variantCount,
        // Each variant's key AND id — instances come from a variant's key/id, never
        // the set's (fork's hint, write-tools.ts ~3040).
        variants: children.map((c, i) => ({ id: c.id, name: c.name, key: c.key, axes: actualAxes[i] })),
        propertyDefinitions,
        ...sizeWarning ? { sizeWarning } : {},
        ...build.warnings.length ? { warnings: build.warnings } : {}
      };
    } catch (err) {
      safeCleanup(err, () => build.cleanup());
    }
  }
  function createExecStdlibComponentSet() {
    return { componentSet };
  }

  // plugin/src/main/exec-stdlib-slot-resolve.ts
  function readSlotContentId(node) {
    const refs = node.componentPropertyReferences;
    return refs?.slotContentId ?? null;
  }
  function serializeSlotsFromNode(root) {
    const slotNodes = root.findAllWithCriteria({ types: ["SLOT"] });
    return slotNodes.map((slot) => {
      let propertyKey = null;
      try {
        propertyKey = readSlotContentId(slot);
      } catch {
      }
      let children = [];
      try {
        children = slot.children.map((c) => ({ id: c.id, name: c.name, type: c.type }));
      } catch {
      }
      return {
        id: slot.id,
        name: slot.name,
        type: "SLOT",
        width: slot.width,
        height: slot.height,
        layoutMode: slot.layoutMode || "NONE",
        propertyKey,
        children
      };
    });
  }
  async function resolveSlot(target) {
    if (target.slotId) {
      const node = await figma.getNodeByIdAsync(target.slotId);
      if (!node) throw withCode(new Error(`slot not found: ${target.slotId}`), "E_INVALID_ARGS");
      if (node.type !== "SLOT") throw withCode(new Error(`node is not a SLOT, got ${node.type}: ${target.slotId}`), "E_INVALID_ARGS");
      return node;
    }
    if (target.instanceId && target.slotName) {
      const inst = await figma.getNodeByIdAsync(target.instanceId);
      if (!inst) throw withCode(new Error(`instance not found: ${target.instanceId}`), "E_INVALID_ARGS");
      if (inst.type !== "INSTANCE") throw withCode(new Error(`instanceId must be an INSTANCE, got ${inst.type}`), "E_INVALID_ARGS");
      const all = inst.findAllWithCriteria({ types: ["SLOT"] });
      const named = all.filter((n) => n.name === target.slotName);
      if (named.length === 0) {
        throw withCode(new Error(`slot "${target.slotName}" not found on instance \u2014 available: ${all.map((n) => n.name).join(", ") || "(none)"}`), "E_INVALID_ARGS");
      }
      const direct = named.filter((n) => n.parent === inst);
      if (direct.length > 1) {
        throw withCode(new Error(`slot "${target.slotName}" is ambiguous \u2014 ${direct.length} direct matches: ${direct.map((n) => n.id).join(", ")}`), "E_INVALID_ARGS");
      }
      if (direct.length === 1) return direct[0];
      if (named.length > 1) {
        throw withCode(new Error(`slot "${target.slotName}" is ambiguous \u2014 ${named.length} nested matches, no direct child: ${named.map((n) => n.id).join(", ")}`), "E_INVALID_ARGS");
      }
      return named[0];
    }
    throw withCode(new Error("append/reset need slotId, or instanceId + slotName"), "E_INVALID_ARGS");
  }

  // plugin/src/main/exec-stdlib-slot-content.ts
  async function createSlotContentNode(nodeType, props) {
    let node;
    switch (nodeType) {
      case "RECTANGLE":
        node = figma.createRectangle();
        break;
      case "FRAME":
        node = figma.createFrame();
        break;
      case "TEXT": {
        const text = figma.createText();
        await figma.loadFontAsync({ family: "Inter", style: "Regular" });
        text.fontName = { family: "Inter", style: "Regular" };
        if (props.text !== void 0) text.characters = String(props.text);
        node = text;
        break;
      }
      default:
        throw withCode(new Error(`unsupported content.nodeType "${nodeType}" \u2014 supported: RECTANGLE, FRAME, TEXT`), "E_INVALID_ARGS");
    }
    if (props.name !== void 0) node.name = String(props.name);
    if (props.width !== void 0 || props.height !== void 0) {
      const w = props.width !== void 0 ? Number(props.width) : node.width;
      const h = props.height !== void 0 ? Number(props.height) : node.height;
      if (!Number.isNaN(w) && !Number.isNaN(h)) node.resize(w, h);
    }
    return node;
  }
  async function append(target, content2, opts = {}) {
    requireDesignFile("ui.slot.append");
    const slotNode = await resolveSlot(target);
    let appendedNode;
    if (content2.sourceNodeId) {
      const source = await figma.getNodeByIdAsync(content2.sourceNodeId);
      if (!source) throw withCode(new Error(`source node not found: ${content2.sourceNodeId}`), "E_INVALID_ARGS");
      if (source.type === "COMPONENT") {
        throw withCode(new Error("a COMPONENT cannot be appended directly to a slot \u2014 create an INSTANCE first, or clone an existing instance"), "E_INVALID_ARGS");
      }
      appendedNode = content2.clone !== false ? source.clone() : source;
    } else if (content2.nodeType) {
      appendedNode = await createSlotContentNode(content2.nodeType, content2.props ?? {});
    } else {
      throw withCode(new Error("append needs content.sourceNodeId (clone/move existing) or content.nodeType (create new)"), "E_INVALID_ARGS");
    }
    if (opts.clearExisting) {
      for (const child of [...slotNode.children]) child.remove();
    }
    slotNode.appendChild(appendedNode);
    if (!slotNode.layoutMode || slotNode.layoutMode === "NONE") {
      try {
        appendedNode.x = 0;
        appendedNode.y = 0;
      } catch {
      }
    }
    if (!slotNode.children.some((c) => c.id === appendedNode.id)) {
      throw withCode(new Error(`append applied but "${appendedNode.id}" is not in slot "${slotNode.name}"'s children`), "E_EVAL");
    }
    return {
      slot: { id: slotNode.id, name: slotNode.name },
      appended: {
        id: appendedNode.id,
        name: appendedNode.name,
        type: appendedNode.type,
        width: appendedNode.width,
        height: appendedNode.height
      }
    };
  }
  async function reset(target) {
    requireDesignFile("ui.slot.reset");
    const slotNode = await resolveSlot(target);
    const typed = slotNode;
    if (typeof typed.resetSlot !== "function") {
      throw withCode(new Error("resetSlot() is not available on this node \u2014 ensure Figma Desktop supports Slots"), "E_INVALID_ARGS");
    }
    typed.resetSlot();
    return { slot: { id: slotNode.id, name: slotNode.name, childCount: slotNode.children?.length ?? 0 } };
  }

  // plugin/src/main/exec-stdlib-slot-property.ts
  function isNestedInsideAnotherSlot(frame, stopAt) {
    let n = frame.parent;
    while (n && n !== stopAt) {
      if (n.type === "SLOT") return true;
      n = "parent" in n ? n.parent : null;
    }
    return false;
  }
  async function addSlotProperty(componentId, propertyName, frameNodeId, opts = {}) {
    requireDesignFile("ui.slot.addProperty");
    const component = await figma.getNodeByIdAsync(componentId);
    if (!component || component.type !== "COMPONENT" && component.type !== "COMPONENT_SET") {
      throw withCode(new Error(`componentId must be a COMPONENT or COMPONENT_SET, got ${component?.type ?? "not found"}: ${componentId}`), "E_INVALID_ARGS");
    }
    const frame = await figma.getNodeByIdAsync(frameNodeId);
    if (!frame || frame.type !== "FRAME") {
      throw withCode(new Error(`frameNodeId must be a FRAME, got ${frame?.type ?? "not found"}: ${frameNodeId}`), "E_INVALID_ARGS");
    }
    if (isNestedInsideAnotherSlot(frame, component)) {
      throw withCode(new Error(`frame "${frame.name}" is nested inside another slot \u2014 a slot's content frame cannot itself sit inside a different slot`), "E_INVALID_ARGS");
    }
    const directChild = frame.parent === component;
    const variantChild = component.type === "COMPONENT_SET" && frame.parent?.type === "COMPONENT" && frame.parent.parent === component;
    if (!directChild && !variantChild) {
      throw withCode(new Error(
        component.type === "COMPONENT_SET" ? `frame must be a direct child of one of "${component.name}"'s variant components` : `frame must be a direct child of "${component.name}"`
      ), "E_INVALID_ARGS");
    }
    if (frame.layoutMode === "GRID") {
      throw withCode(new Error(`frame "${frame.name}" uses GRID layout \u2014 not allowed as slot content`), "E_INVALID_ARGS");
    }
    const typedComponent = component;
    if (typeof typedComponent.addComponentProperty !== "function") {
      throw withCode(new Error("addComponentProperty() is not available \u2014 update Figma Desktop to a version with Slots support"), "E_INVALID_ARGS");
    }
    const propOpts = {};
    if (opts.description !== void 0) propOpts.description = opts.description;
    if (opts.preferredValues !== void 0) propOpts.preferredValues = opts.preferredValues;
    const propertyKey = typedComponent.addComponentProperty(
      propertyName,
      "SLOT",
      "",
      Object.keys(propOpts).length ? propOpts : void 0
    );
    try {
      const frameTyped = frame;
      frameTyped.componentPropertyReferences = { ...frameTyped.componentPropertyReferences, slotContentId: propertyKey };
      const defs = component.componentPropertyDefinitions;
      if (!defs?.[propertyKey]) {
        throw withCode(new Error(`addProperty applied but "${propertyKey}" is not in componentPropertyDefinitions`), "E_EVAL");
      }
      if (frameTyped.componentPropertyReferences?.slotContentId !== propertyKey) {
        throw withCode(new Error(`addProperty applied but frame "${frame.name}" is not linked to "${propertyKey}"`), "E_EVAL");
      }
    } catch (err) {
      const original = err instanceof Error ? err : new Error(String(err));
      try {
        typedComponent.deleteComponentProperty(propertyKey);
      } catch (cleanupErr) {
        throw withCode(
          new Error(`${original.message} \u2014 additionally, cleanup of the unlinked property "${propertyKey}" failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`),
          original.code ?? "E_EVAL"
        );
      }
      throw original;
    }
    return { propertyKey, frameId: frame.id, frameName: frame.name };
  }

  // plugin/src/main/exec-stdlib-slot.ts
  var CREATE_LAYOUT_MODES = /* @__PURE__ */ new Set(["NONE", "HORIZONTAL", "VERTICAL"]);
  async function create(componentId, opts = {}) {
    requireDesignFile("ui.slot.create");
    const node = await figma.getNodeByIdAsync(componentId);
    if (!node || node.type !== "COMPONENT") {
      throw withCode(new Error(`componentId must be a COMPONENT node id (standalone or a variant inside a COMPONENT_SET \u2014 call once per variant), got ${node?.type ?? "not found"}: ${componentId}`), "E_INVALID_ARGS");
    }
    const target = node;
    if (typeof target.createSlot !== "function") {
      throw withCode(new Error("createSlot() is not available \u2014 update Figma Desktop to a version with Slots support"), "E_INVALID_ARGS");
    }
    if (opts.layoutMode && !CREATE_LAYOUT_MODES.has(opts.layoutMode)) {
      throw withCode(new Error(`layoutMode "${opts.layoutMode}" is not allowed on a slot \u2014 use NONE, HORIZONTAL, or VERTICAL`), "E_INVALID_ARGS");
    }
    const slot = target.createSlot();
    if (opts.name) slot.name = opts.name;
    if (opts.layoutMode) slot.layoutMode = opts.layoutMode;
    if (opts.width !== void 0 || opts.height !== void 0) {
      slot.resize(opts.width ?? slot.width, opts.height ?? slot.height);
    }
    let propertyKey = null;
    try {
      propertyKey = slot.componentPropertyReferences?.slotContentId ?? null;
    } catch {
    }
    if (slot.type !== "SLOT") {
      throw withCode(new Error(`createSlot() returned a ${slot.type}, not SLOT`), "E_EVAL");
    }
    return {
      id: slot.id,
      name: slot.name,
      type: "SLOT",
      propertyKey,
      width: slot.width,
      height: slot.height,
      layoutMode: slot.layoutMode || "NONE"
    };
  }
  async function list(nodeId) {
    requireDesignFile("ui.slot.list");
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node || node.type !== "COMPONENT" && node.type !== "INSTANCE" && node.type !== "COMPONENT_SET") {
      throw withCode(new Error(`nodeId must be a COMPONENT, COMPONENT_SET, or INSTANCE, got ${node?.type ?? "not found"}: ${nodeId}`), "E_INVALID_ARGS");
    }
    let slots;
    if (node.type === "COMPONENT_SET") {
      slots = node.children.filter((c) => c.type === "COMPONENT").flatMap((variant) => serializeSlotsFromNode(variant).map((s) => ({ ...s, variantId: variant.id, variantName: variant.name })));
    } else {
      slots = serializeSlotsFromNode(node);
    }
    return { nodeId: node.id, nodeType: node.type, slots, count: slots.length };
  }
  function createExecStdlibSlot() {
    return { create, list, append, reset, addProperty: addSlotProperty };
  }

  // plugin/src/main/exec-stdlib-annotate.ts
  var ANNOTATION_PROPERTY_TYPES = [
    "width",
    "height",
    "maxWidth",
    "minWidth",
    "maxHeight",
    "minHeight",
    "fills",
    "strokes",
    "effects",
    "strokeWeight",
    "cornerRadius",
    "textStyleId",
    "textAlignHorizontal",
    "fontFamily",
    "fontStyle",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "letterSpacing",
    "itemSpacing",
    "padding",
    "layoutMode",
    "alignItems",
    "opacity",
    "mainComponent",
    "gridRowGap",
    "gridColumnGap",
    "gridRowCount",
    "gridColumnCount",
    "gridRowAnchorIndex",
    "gridColumnAnchorIndex",
    "gridRowSpan",
    "gridColumnSpan"
  ];
  var TYPE_SET = new Set(ANNOTATION_PROPERTY_TYPES);
  function validatePropertyType(type) {
    if (TYPE_SET.has(type)) return;
    throw withCode(
      new Error(`invalid annotation property type "${type}" \u2014 valid: ${ANNOTATION_PROPERTY_TYPES.join(", ")}`),
      "E_INVALID_ARGS"
    );
  }
  async function getCategories() {
    let cats;
    try {
      cats = await figma.annotations.getAnnotationCategoriesAsync();
    } catch (err) {
      throw withCode(
        new Error(`annotation categories unavailable: ${err instanceof Error ? err.message : String(err)}`),
        "E_EVAL"
      );
    }
    return cats.map((c) => ({ id: c.id, name: c.label }));
  }
  function toOutput(a, categoryMap) {
    return {
      label: a.label ?? null,
      labelMarkdown: a.labelMarkdown ?? null,
      properties: a.properties?.length ? a.properties.map((p) => ({ type: p.type })) : null,
      categoryId: a.categoryId ?? null,
      // Fact 4: an unmatched category id reports categoryName:null, never the id echoed.
      categoryName: a.categoryId ? categoryMap.get(a.categoryId) ?? null : null
    };
  }
  async function requireAnnotatable(nodeId) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) throw withCode(new Error(`node not found: ${nodeId}`), "E_INVALID_ARGS");
    if (!("annotations" in node)) {
      throw withCode(new Error(`node type ${node.type} does not support annotations`), "E_INVALID_ARGS");
    }
    return node;
  }
  async function get(nodeId, opts = {}) {
    const node = await requireAnnotatable(nodeId);
    const categories2 = await getCategories();
    const categoryMap = new Map(categories2.map((c) => [c.id, c.name]));
    const nodeAnnotations = (node.annotations ?? []).map((a) => toOutput(a, categoryMap));
    const includeChildren = opts.includeChildren ?? false;
    const maxDepth = opts.depth ?? 1;
    const childResults = [];
    let skippedChildren = 0;
    if (includeChildren && "children" in node) {
      const walk2 = (parent, depth) => {
        if (depth > maxDepth) return;
        for (const child of parent.children) {
          try {
            const anns = "annotations" in child ? (child.annotations ?? []).map((a) => toOutput(a, categoryMap)) : [];
            if (anns.length > 0) childResults.push({ nodeId: child.id, nodeName: child.name, nodeType: child.type, annotations: anns });
            if ("children" in child) walk2(child, depth + 1);
          } catch {
            skippedChildren += 1;
          }
        }
      };
      walk2(node, 1);
    }
    return {
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      annotations: nodeAnnotations,
      annotationCount: nodeAnnotations.length,
      ...includeChildren ? {
        children: childResults,
        childAnnotationCount: childResults.reduce((sum, c) => sum + c.annotations.length, 0),
        skippedChildren
      } : {},
      availableCategories: categories2
    };
  }
  async function set(nodeId, annotations, opts = {}) {
    const node = await requireAnnotatable(nodeId);
    for (const input of annotations) for (const p of input.properties ?? []) validatePropertyType(p.type);
    const built = annotations.map((input) => {
      const ann = {};
      if (input.label) ann.label = input.label;
      if (input.labelMarkdown) ann.labelMarkdown = input.labelMarkdown;
      if (input.properties?.length) ann.properties = input.properties.map((p) => ({ type: p.type }));
      if (input.categoryId) ann.categoryId = input.categoryId;
      return ann;
    });
    const mode = opts.mode ?? "replace";
    let finalAnnotations = built;
    if (mode === "append") {
      const existing = node.annotations ?? [];
      const merged = existing.map((ex) => {
        const copy = {};
        if (ex.labelMarkdown) copy.labelMarkdown = ex.labelMarkdown;
        else if (ex.label) copy.label = ex.label;
        if (ex.properties) copy.properties = ex.properties;
        if (ex.categoryId) copy.categoryId = ex.categoryId;
        return copy;
      });
      finalAnnotations = [...merged, ...built];
    }
    node.annotations = finalAnnotations;
    const categories2 = await getCategories();
    const categoryMap = new Map(categories2.map((c) => [c.id, c.name]));
    const readBack = (node.annotations ?? []).map((a) => toOutput(a, categoryMap));
    const expected = finalAnnotations.map((a) => toOutput(a, categoryMap));
    const mismatch = readBack.length !== expected.length || expected.some((e, i) => JSON.stringify(e) !== JSON.stringify(readBack[i]));
    if (mismatch) {
      throw withCode(
        new Error(`set applied but read back does not match what was written \u2014 expected ${JSON.stringify(expected)}, got ${JSON.stringify(readBack)}`),
        "E_EVAL"
      );
    }
    return { nodeId: node.id, nodeName: node.name, annotationCount: readBack.length, mode, annotations: readBack };
  }
  async function categories() {
    return { categories: await getCategories() };
  }
  function createExecStdlibAnnotate() {
    return { get, set, categories };
  }

  // plugin/src/main/exec-stdlib-figjam-types.ts
  var MAX_STICKIES_PER_BATCH = 200;
  var MAX_TABLE_ROWS = 100;
  var MAX_TABLE_COLUMNS = 50;
  var MAX_TEXT_CHARS = 5e3;
  var MAX_CODE_BLOCK_CHARS = 5e4;
  var MAX_ARRANGE_NODES = 500;
  var MAX_BOARD_READ_NODES = 1e3;
  var MAX_CONNECTORS_READ = 1e3;
  var STICKY_COLORS = {
    YELLOW: { r: 1, g: 0.85, b: 0.4 },
    BLUE: { r: 0.53, g: 0.78, b: 1 },
    GREEN: { r: 0.55, g: 0.87, b: 0.53 },
    PINK: { r: 1, g: 0.6, b: 0.78 },
    ORANGE: { r: 1, g: 0.71, b: 0.42 },
    PURPLE: { r: 0.78, g: 0.65, b: 1 },
    RED: { r: 1, g: 0.55, b: 0.55 },
    LIGHT_GRAY: { r: 0.9, g: 0.9, b: 0.9 },
    GRAY: { r: 0.7, g: 0.7, b: 0.7 }
  };

  // plugin/src/main/exec-stdlib-figjam-content.ts
  var FALLBACK_FONT = { family: "Inter", style: "Medium" };
  async function loadOrFallback(sublayer) {
    try {
      await figma.loadFontAsync(sublayer.fontName);
    } catch {
      await figma.loadFontAsync(FALLBACK_FONT);
      sublayer.fontName = FALLBACK_FONT;
    }
  }
  function assertTextLength(text, field) {
    if (text.length > MAX_TEXT_CHARS) {
      throw withCode(new Error(`${field} exceeds ${MAX_TEXT_CHARS} chars (batch cap, timeout guard \u2014 not a Figma limit)`), "E_INVALID_ARGS");
    }
  }
  async function sticky(text, opts = {}) {
    requireEditor("ui.figjam.sticky", ["figjam"]);
    assertTextLength(text, "sticky text");
    const node = figma.createSticky();
    await figma.loadFontAsync(node.text.fontName);
    node.text.characters = text;
    if (opts.color) {
      const rgb = STICKY_COLORS[opts.color.toUpperCase()];
      if (!rgb) {
        throw withCode(new Error(`unknown sticky color "${opts.color}" \u2014 valid: ${Object.keys(STICKY_COLORS).join(", ")}`), "E_INVALID_ARGS");
      }
      node.fills = [{ type: "SOLID", color: rgb }];
    }
    if (typeof opts.x === "number") node.x = opts.x;
    if (typeof opts.y === "number") node.y = opts.y;
    return { id: node.id, type: "STICKY", name: node.name, x: node.x, y: node.y };
  }
  async function stickies(specs) {
    requireEditor("ui.figjam.stickies", ["figjam"]);
    if (specs.length > MAX_STICKIES_PER_BATCH) {
      throw withCode(new Error(`${specs.length} stickies requested \u2014 capped at ${MAX_STICKIES_PER_BATCH} per batch`), "E_INVALID_ARGS");
    }
    const results = [];
    const errors = [];
    let batchFont = null;
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      try {
        assertTextLength(spec.text, `stickies[${i}].text`);
        const node = figma.createSticky();
        if (!batchFont) batchFont = node.text.fontName;
        await figma.loadFontAsync(batchFont);
        node.text.characters = spec.text;
        if (spec.color) {
          const rgb = STICKY_COLORS[spec.color.toUpperCase()];
          if (!rgb) throw new Error(`unknown sticky color "${spec.color}" \u2014 valid: ${Object.keys(STICKY_COLORS).join(", ")}`);
          node.fills = [{ type: "SOLID", color: rgb }];
        }
        if (typeof spec.x === "number") node.x = spec.x;
        if (typeof spec.y === "number") node.y = spec.y;
        results.push({ id: node.id, type: "STICKY", name: node.name, x: node.x, y: node.y });
      } catch (err) {
        errors.push({ index: i, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { created: results.length, failed: errors.length, results, errors };
  }
  async function connector(startNodeId, endNodeId, opts = {}) {
    requireEditor("ui.figjam.connector", ["figjam"]);
    const startNode = await figma.getNodeByIdAsync(startNodeId);
    if (!startNode) throw withCode(new Error(`connector start node not found: ${startNodeId}`), "E_INVALID_ARGS");
    const endNode = await figma.getNodeByIdAsync(endNodeId);
    if (!endNode) throw withCode(new Error(`connector end node not found: ${endNodeId}`), "E_INVALID_ARGS");
    const node = figma.createConnector();
    node.connectorStart = { endpointNodeId: startNodeId, magnet: opts.startMagnet ?? "AUTO" };
    node.connectorEnd = { endpointNodeId: endNodeId, magnet: opts.endMagnet ?? "AUTO" };
    if (opts.label) {
      assertTextLength(opts.label, "connector label");
      await loadOrFallback(node.text);
      node.text.characters = opts.label;
    }
    return { id: node.id, type: "CONNECTOR", name: node.name };
  }
  async function shape(opts = {}) {
    requireEditor("ui.figjam.shape", ["figjam"]);
    const node = figma.createShapeWithText();
    if (opts.shapeType) node.shapeType = opts.shapeType;
    if (typeof opts.x === "number") node.x = opts.x;
    if (typeof opts.y === "number") node.y = opts.y;
    if (typeof opts.width === "number" || typeof opts.height === "number") {
      node.resize(opts.width ?? node.width, opts.height ?? node.height);
    }
    if (opts.fillColor) node.fills = [{ type: "SOLID", color: rgbToFigma(hexToFigmaColor(opts.fillColor)) }];
    if (opts.strokeColor) node.strokes = [{ type: "SOLID", color: rgbToFigma(hexToFigmaColor(opts.strokeColor)) }];
    if (opts.strokeDashPattern) node.dashPattern = opts.strokeDashPattern;
    if (opts.text) {
      assertTextLength(opts.text, "shape text");
      await loadOrFallback(node.text);
      if (typeof opts.fontSize === "number") node.text.fontSize = opts.fontSize;
      node.text.characters = opts.text;
    }
    return { id: node.id, type: "SHAPE_WITH_TEXT", name: node.name, x: node.x, y: node.y, width: node.width, height: node.height };
  }
  async function section(opts = {}) {
    requireEditor("ui.figjam.section", ["figjam"]);
    const node = figma.createSection();
    if (opts.name) node.name = opts.name;
    if (typeof opts.x === "number") node.x = opts.x;
    if (typeof opts.y === "number") node.y = opts.y;
    if (typeof opts.width === "number" || typeof opts.height === "number") {
      node.resizeWithoutConstraints(opts.width ?? node.width, opts.height ?? node.height);
    }
    if (opts.fillColor) node.fills = [{ type: "SOLID", color: rgbToFigma(hexToFigmaColor(opts.fillColor)) }];
    return { id: node.id, type: "SECTION", name: node.name, x: node.x, y: node.y, width: node.width, height: node.height };
  }

  // plugin/src/main/exec-stdlib-figjam-table.ts
  var FALLBACK_FONT2 = { family: "Inter", style: "Medium" };
  async function table(rows, columns, opts = {}) {
    requireEditor("ui.figjam.table", ["figjam"]);
    if (rows > MAX_TABLE_ROWS || columns > MAX_TABLE_COLUMNS) {
      throw withCode(new Error(`table ${rows}x${columns} exceeds the cap of ${MAX_TABLE_ROWS}x${MAX_TABLE_COLUMNS}`), "E_INVALID_ARGS");
    }
    const node = figma.createTable(rows, columns);
    if (typeof opts.x === "number") node.x = opts.x;
    if (typeof opts.y === "number") node.y = opts.y;
    let cellsWritten = 0;
    let dataRowsIgnored = 0;
    if (opts.data) {
      let cellFont = null;
      for (let r = 0; r < opts.data.length; r++) {
        if (r >= rows) {
          dataRowsIgnored++;
          continue;
        }
        const row = opts.data[r];
        for (let c = 0; c < row.length && c < columns; c++) {
          const cell = node.cellAt(r, c);
          if (!cellFont) cellFont = cell.text.fontName;
          await figma.loadFontAsync(cellFont);
          cell.text.characters = row[c] ?? "";
          cellsWritten++;
        }
      }
    }
    return {
      id: node.id,
      type: "TABLE",
      name: node.name,
      rows: node.numRows,
      columns: node.numColumns,
      cellsWritten,
      ...dataRowsIgnored > 0 && { dataRowsIgnored }
    };
  }
  async function codeBlock(code, opts = {}) {
    requireEditor("ui.figjam.codeBlock", ["figjam"]);
    if (code.length > MAX_CODE_BLOCK_CHARS) {
      throw withCode(new Error(`code block exceeds ${MAX_CODE_BLOCK_CHARS} chars (batch cap)`), "E_INVALID_ARGS");
    }
    const node = figma.createCodeBlock();
    try {
      await figma.loadFontAsync({ family: "Source Code Pro", style: "Medium" });
    } catch {
      await figma.loadFontAsync(FALLBACK_FONT2);
    }
    node.code = code;
    if (opts.language) {
      node.codeLanguage = opts.language;
    }
    if (typeof opts.x === "number") node.x = opts.x;
    if (typeof opts.y === "number") node.y = opts.y;
    return { id: node.id, type: "CODE_BLOCK", name: node.name, x: node.x, y: node.y };
  }

  // plugin/src/main/exec-stdlib-figjam-arrange.ts
  function computeArrangement(nodes, layout, spacing, columns) {
    let x = 0;
    let y = 0;
    let rowHeight = 0;
    let col = 0;
    const cols = layout === "grid" ? columns ?? Math.ceil(Math.sqrt(nodes.length)) : nodes.length;
    for (const node of nodes) {
      if (layout === "horizontal") {
        node.x = x;
        node.y = 0;
        x += node.width + spacing;
      } else if (layout === "vertical") {
        node.x = 0;
        node.y = y;
        y += node.height + spacing;
      } else {
        node.x = x;
        node.y = y;
        rowHeight = Math.max(rowHeight, node.height);
        col += 1;
        x += node.width + spacing;
        if (col >= cols) {
          col = 0;
          x = 0;
          y += rowHeight + spacing;
          rowHeight = 0;
        }
      }
    }
  }
  async function arrange(nodeIds, opts = {}) {
    requireEditor("ui.figjam.arrange", ["figjam"]);
    if (nodeIds.length > MAX_ARRANGE_NODES) {
      throw withCode(new Error(`${nodeIds.length} nodes requested \u2014 capped at ${MAX_ARRANGE_NODES} per arrange`), "E_INVALID_ARGS");
    }
    const layout = opts.layout ?? "grid";
    const spacing = opts.spacing ?? 20;
    const resolved = [];
    const skipped = [];
    for (const id of nodeIds) {
      const node = await figma.getNodeByIdAsync(id);
      if (!node || !("x" in node) || !("width" in node)) {
        skipped.push(id);
        continue;
      }
      resolved.push(node);
    }
    computeArrangement(resolved, layout, spacing, opts.columns);
    return { arranged: resolved.length, layout, skipped };
  }

  // plugin/src/main/exec-stdlib-figjam-read.ts
  var TABLE_READ_ROW_CAP = 10;
  var FIGJAM_READABLE_TYPES = /* @__PURE__ */ new Set([
    "STICKY",
    "SHAPE_WITH_TEXT",
    "CONNECTOR",
    "CODE_BLOCK",
    "TABLE",
    "SECTION",
    "FRAME",
    "TEXT"
  ]);
  function firstSolidFillHex(fills) {
    if (!Array.isArray(fills) || fills.length === 0) return null;
    const solid = fills.find((f) => f?.type === "SOLID");
    if (!solid) return null;
    return figmaColorToHex(solid.color);
  }
  function extractBoardNode(node) {
    const base = { id: node.id, name: node.name, type: node.type };
    switch (node.type) {
      case "STICKY": {
        const sticky2 = node;
        return { ...base, text: sticky2.text.characters, color: firstSolidFillHex(sticky2.fills) };
      }
      case "SHAPE_WITH_TEXT": {
        const shapeNode = node;
        return { ...base, text: shapeNode.text.characters, shapeType: shapeNode.shapeType };
      }
      case "CONNECTOR": {
        const conn = node;
        return {
          ...base,
          label: conn.text.characters || null,
          start: "endpointNodeId" in conn.connectorStart ? conn.connectorStart.endpointNodeId : null,
          end: "endpointNodeId" in conn.connectorEnd ? conn.connectorEnd.endpointNodeId : null
        };
      }
      case "CODE_BLOCK": {
        const code = node;
        return { ...base, code: code.code, language: code.codeLanguage };
      }
      case "TABLE": {
        const tableNode = node;
        const rowCap = Math.min(TABLE_READ_ROW_CAP, tableNode.numRows);
        const data = [];
        for (let r = 0; r < rowCap; r++) {
          const row = [];
          for (let c = 0; c < tableNode.numColumns; c++) row.push(tableNode.cellAt(r, c).text.characters);
          data.push(row);
        }
        return {
          ...base,
          rows: tableNode.numRows,
          columns: tableNode.numColumns,
          data,
          cellDataTruncated: tableNode.numRows > TABLE_READ_ROW_CAP
        };
      }
      case "SECTION": {
        const sectionNode = node;
        return { ...base, childCount: sectionNode.children.length };
      }
      case "TEXT": {
        const text = node;
        return { ...base, text: text.characters };
      }
      default:
        return base;
    }
  }
  async function board(opts = {}) {
    requireEditor("ui.figjam.board", ["figjam"]);
    const maxNodes = opts.maxNodes ?? MAX_BOARD_READ_NODES;
    const topLevel = figma.currentPage.children;
    const matching = opts.nodeTypes ? topLevel.filter((c) => opts.nodeTypes.includes(c.type)) : topLevel.filter((c) => FIGJAM_READABLE_TYPES.has(c.type));
    const truncated = matching.length > maxNodes;
    const nodes = matching.slice(0, maxNodes).map(extractBoardNode);
    return { nodes, totalFound: matching.length, truncated, page: figma.currentPage.name, scope: "page-top-level" };
  }
  function toEndpointResult(ep) {
    return { nodeId: ep.nodeId, unresolved: ep.unresolved, position: ep.position };
  }
  async function resolveEndpoint(ep) {
    if (!("endpointNodeId" in ep)) {
      return { nodeId: null, unresolved: false, position: "position" in ep ? ep.position : null, node: null };
    }
    const node = await figma.getNodeByIdAsync(ep.endpointNodeId);
    return { nodeId: ep.endpointNodeId, unresolved: !node, position: null, node };
  }
  async function connections() {
    requireEditor("ui.figjam.connections", ["figjam"]);
    const allConnectors = figma.currentPage.findAll((n) => n.type === "CONNECTOR");
    const truncated = allConnectors.length > MAX_CONNECTORS_READ;
    const connectors = allConnectors.slice(0, MAX_CONNECTORS_READ);
    const connectedNodes = {};
    const edges = [];
    for (const conn of connectors) {
      const start = await resolveEndpoint(conn.connectorStart);
      const end = await resolveEndpoint(conn.connectorEnd);
      edges.push({ id: conn.id, label: conn.text.characters || null, start: toEndpointResult(start), end: toEndpointResult(end) });
      for (const ep of [start, end]) {
        if (!ep.nodeId || ep.unresolved || connectedNodes[ep.nodeId]) continue;
        const node = ep.node;
        if (!node) continue;
        const asText = "characters" in node ? node.characters : void 0;
        connectedNodes[ep.nodeId] = {
          id: node.id,
          type: node.type,
          name: node.name ?? node.id,
          text: typeof asText === "string" ? asText : null
        };
      }
    }
    return {
      edges,
      connectedNodes,
      totalConnectors: allConnectors.length,
      totalConnectedNodes: Object.keys(connectedNodes).length,
      truncated
    };
  }

  // plugin/src/main/exec-stdlib-figjam.ts
  function createExecStdlibFigjam() {
    return { sticky, stickies, connector, shape, section, table, codeBlock, arrange, board, connections };
  }

  // plugin/src/main/exec-stdlib-slides-resolve.ts
  async function resolveSlide(slideId, capability) {
    const node = await figma.getNodeByIdAsync(slideId);
    if (!node) throw withCode(new Error(`${capability}: node not found: ${slideId}`), "E_INVALID_ARGS");
    if (node.type !== "SLIDE") {
      throw withCode(new Error(`${capability}: node ${slideId} is a ${node.type}, not a SLIDE`), "E_INVALID_ARGS");
    }
    return node;
  }

  // plugin/src/main/exec-stdlib-slides-crud.ts
  async function list2() {
    requireEditor("ui.slides.list", ["slides"]);
    const slideGrid = figma.getSlideGrid();
    const slides = [];
    for (let row = 0; row < slideGrid.length; row++) {
      const cols = slideGrid[row];
      for (let col = 0; col < cols.length; col++) {
        const slide = cols[col];
        slides.push({
          id: slide.id,
          name: slide.name,
          row,
          col,
          isSkippedSlide: slide.isSkippedSlide,
          childCount: slide.children.length
        });
      }
    }
    return { slides, totalSlides: slides.length, totalRows: slideGrid.length };
  }
  async function grid() {
    requireEditor("ui.slides.grid", ["slides"]);
    const slideGrid = figma.getSlideGrid();
    const rows = [];
    for (let row = 0; row < slideGrid.length; row++) {
      const cols = slideGrid[row];
      rows.push({
        rowIndex: row,
        slides: cols.map((s, col) => ({ id: s.id, name: s.name, col, isSkippedSlide: s.isSkippedSlide }))
      });
    }
    return { grid: rows, totalRows: rows.length };
  }
  async function create2(opts = {}) {
    requireEditor("ui.slides.create", ["slides"]);
    const slide = typeof opts.row === "number" && typeof opts.col === "number" ? figma.createSlide(opts.row, opts.col) : figma.createSlide();
    return { id: slide.id, name: slide.name };
  }
  async function remove2(slideId) {
    requireEditor("ui.slides.remove", ["slides"]);
    const slide = await resolveSlide(slideId, "ui.slides.remove");
    const name = slide.name;
    slide.remove();
    return { deleted: slideId, name };
  }
  async function duplicate(slideId) {
    requireEditor("ui.slides.duplicate", ["slides"]);
    const slide = await resolveSlide(slideId, "ui.slides.duplicate");
    const clone = slide.clone();
    return { originalId: slideId, newId: clone.id, name: clone.name };
  }
  async function reorder(gridOfIds) {
    requireEditor("ui.slides.reorder", ["slides"]);
    const currentGrid = figma.getSlideGrid();
    const slideMap = /* @__PURE__ */ new Map();
    const currentIds = [];
    for (const row of currentGrid) {
      for (const slide of row) {
        slideMap.set(slide.id, slide);
        currentIds.push(slide.id);
      }
    }
    const inputIds = gridOfIds.flat();
    const inputSeen = /* @__PURE__ */ new Set();
    const duplicated = /* @__PURE__ */ new Set();
    const missing = [];
    for (const id of inputIds) {
      if (inputSeen.has(id)) duplicated.add(id);
      inputSeen.add(id);
      if (!slideMap.has(id)) missing.push(id);
    }
    const dropped = currentIds.filter((id) => !inputSeen.has(id));
    if (missing.length > 0 || duplicated.size > 0 || dropped.length > 0) {
      const parts = [];
      if (missing.length > 0) parts.push(`unknown ids: ${missing.join(", ")}`);
      if (duplicated.size > 0) parts.push(`duplicated ids: ${[...duplicated].join(", ")}`);
      if (dropped.length > 0) parts.push(`missing ids (would silently reorganise the deck): ${dropped.join(", ")}`);
      throw withCode(
        new Error(`ui.slides.reorder: grid does not match the current deck exactly \u2014 ${parts.join("; ")}`),
        "E_INVALID_ARGS"
      );
    }
    const reorderedRows = gridOfIds.map((row) => row.map((id) => slideMap.get(id)));
    figma.setSlideGrid(reorderedRows);
    const after = figma.getSlideGrid();
    return { rows: after.length, grid: after.map((row) => row.map((s) => s.id)) };
  }

  // plugin/src/main/exec-stdlib-slides-types.ts
  var MAX_TEXT_CHARS2 = 1e4;
  var MAX_FONT_SIZE = 1e3;
  var MAX_DIMENSION = 1e4;
  var TRANSITION_STYLES = [
    "NONE",
    "DISSOLVE",
    "SLIDE_FROM_LEFT",
    "SLIDE_FROM_RIGHT",
    "SLIDE_FROM_TOP",
    "SLIDE_FROM_BOTTOM",
    "PUSH_FROM_LEFT",
    "PUSH_FROM_RIGHT",
    "PUSH_FROM_TOP",
    "PUSH_FROM_BOTTOM",
    "MOVE_FROM_LEFT",
    "MOVE_FROM_RIGHT",
    "MOVE_FROM_TOP",
    "MOVE_FROM_BOTTOM",
    "SLIDE_OUT_TO_LEFT",
    "SLIDE_OUT_TO_RIGHT",
    "SLIDE_OUT_TO_TOP",
    "SLIDE_OUT_TO_BOTTOM",
    "MOVE_OUT_TO_LEFT",
    "MOVE_OUT_TO_RIGHT",
    "MOVE_OUT_TO_TOP",
    "MOVE_OUT_TO_BOTTOM",
    "SMART_ANIMATE"
  ];
  var TRANSITION_CURVES = [
    "LINEAR",
    "EASE_IN",
    "EASE_OUT",
    "EASE_IN_AND_OUT",
    "GENTLE",
    "QUICK",
    "BOUNCY",
    "SLOW"
  ];
  var TIMING_TYPES = ["ON_CLICK", "AFTER_DELAY"];

  // plugin/src/main/exec-stdlib-slides-view.ts
  function assertTransition(t, capability) {
    if (!TRANSITION_STYLES.includes(t.style)) {
      throw withCode(new Error(`${capability}: unknown style "${t.style}" \u2014 valid: ${TRANSITION_STYLES.join(", ")}`), "E_INVALID_ARGS");
    }
    if (!TRANSITION_CURVES.includes(t.curve)) {
      throw withCode(new Error(`${capability}: unknown curve "${t.curve}" \u2014 valid: ${TRANSITION_CURVES.join(", ")}`), "E_INVALID_ARGS");
    }
    if (t.timing && !TIMING_TYPES.includes(t.timing.type)) {
      throw withCode(new Error(`${capability}: unknown timing.type "${t.timing.type}" \u2014 valid: ${TIMING_TYPES.join(", ")}`), "E_INVALID_ARGS");
    }
  }
  async function setTransition(slideId, opts) {
    requireEditor("ui.slides.setTransition", ["slides"]);
    const slide = await resolveSlide(slideId, "ui.slides.setTransition");
    const config = { ...opts, timing: opts.timing ?? { type: "ON_CLICK" } };
    assertTransition(config, "ui.slides.setTransition");
    slide.setSlideTransition(config);
    return { id: slideId, transition: slide.getSlideTransition() };
  }
  async function transition(slideId) {
    requireEditor("ui.slides.transition", ["slides"]);
    const slide = await resolveSlide(slideId, "ui.slides.transition");
    return { id: slideId, transition: slide.getSlideTransition() };
  }
  var VIEW_MODES = ["grid", "single-slide"];
  async function viewMode(mode) {
    requireEditor("ui.slides.viewMode", ["slides"]);
    if (!VIEW_MODES.includes(mode)) {
      throw withCode(new Error(`ui.slides.viewMode: unknown mode "${mode}" \u2014 valid: ${VIEW_MODES.join(", ")}`), "E_INVALID_ARGS");
    }
    figma.viewport.slidesView = mode;
    return { mode: figma.viewport.slidesView };
  }
  async function focused() {
    requireEditor("ui.slides.focused", ["slides"]);
    const slide = figma.currentPage.focusedSlide;
    return slide ? { id: slide.id, name: slide.name } : { focused: null };
  }
  async function focus(slideId) {
    requireEditor("ui.slides.focus", ["slides"]);
    const slide = await resolveSlide(slideId, "ui.slides.focus");
    figma.viewport.slidesView = "single-slide";
    figma.currentPage.focusedSlide = slide;
    return { focused: slide.id, name: slide.name, viewMode: figma.viewport.slidesView };
  }
  async function skip(slideId, doSkip) {
    requireEditor("ui.slides.skip", ["slides"]);
    const slide = await resolveSlide(slideId, "ui.slides.skip");
    slide.isSkippedSlide = !!doSkip;
    return { id: slide.id, isSkippedSlide: slide.isSkippedSlide };
  }

  // plugin/src/main/exec-stdlib-slides-content.ts
  var FALLBACK_FONT3 = { family: "Inter", style: "Medium" };
  async function background(slideId, color) {
    requireEditor("ui.slides.background", ["slides"]);
    const slide = await resolveSlide(slideId, "ui.slides.background");
    const hadPriorFill = Array.isArray(slide.fills) && slide.fills.length > 0;
    await slide.setFillsAsync([{ type: "SOLID", color: rgbToFigma(hexToFigmaColor(color)) }]);
    return { slideId, color, hadPriorFill, method: "slide-fill" };
  }
  async function loadTextFont(fontFamily, fontStyle) {
    const requested = { family: fontFamily ?? "Inter", style: fontStyle ?? "Regular" };
    try {
      await figma.loadFontAsync(requested);
      return requested;
    } catch {
      await figma.loadFontAsync(FALLBACK_FONT3);
      return FALLBACK_FONT3;
    }
  }
  function appendAndVerify(slide, node, capability) {
    slide.appendChild(node);
    if (node.parent !== slide) {
      throw withCode(
        new Error(`${capability}: node ${node.id} landed on the wrong slide (parent is ${node.parent?.id ?? "none"}, expected ${slide.id})`),
        "E_EVAL"
      );
    }
  }
  async function addText(slideId, opts) {
    requireEditor("ui.slides.addText", ["slides"]);
    if (opts.text.length > MAX_TEXT_CHARS2) {
      throw withCode(new Error(`ui.slides.addText: text exceeds ${MAX_TEXT_CHARS2} chars`), "E_INVALID_ARGS");
    }
    if (typeof opts.fontSize === "number" && opts.fontSize > MAX_FONT_SIZE) {
      throw withCode(new Error(`ui.slides.addText: fontSize exceeds ${MAX_FONT_SIZE}`), "E_INVALID_ARGS");
    }
    const slide = await resolveSlide(slideId, "ui.slides.addText");
    const node = figma.createText();
    node.fontName = await loadTextFont(opts.fontFamily, opts.fontStyle);
    node.characters = opts.text;
    if (typeof opts.fontSize === "number") node.fontSize = opts.fontSize;
    node.x = typeof opts.x === "number" ? opts.x : 100;
    node.y = typeof opts.y === "number" ? opts.y : 100;
    if (opts.color) node.fills = [{ type: "SOLID", color: rgbToFigma(hexToFigmaColor(opts.color)) }];
    if (opts.textAlign) node.textAlignHorizontal = opts.textAlign;
    if (typeof opts.width === "number") {
      node.resize(opts.width, node.height);
      node.textAutoResize = "HEIGHT";
    }
    if (typeof opts.lineHeight === "number") node.lineHeight = { value: opts.lineHeight, unit: "PIXELS" };
    if (typeof opts.letterSpacing === "number") node.letterSpacing = { value: opts.letterSpacing, unit: "PIXELS" };
    if (opts.textCase) node.textCase = opts.textCase;
    appendAndVerify(slide, node, "ui.slides.addText");
    return { id: node.id, characters: node.characters };
  }
  async function addShape(slideId, opts = {}) {
    requireEditor("ui.slides.addShape", ["slides"]);
    const shapeType = opts.shapeType ?? "RECTANGLE";
    if (shapeType !== "RECTANGLE" && shapeType !== "ELLIPSE") {
      throw withCode(new Error(`ui.slides.addShape: unknown shapeType "${shapeType}" \u2014 valid: RECTANGLE, ELLIPSE`), "E_INVALID_ARGS");
    }
    if (typeof opts.width === "number" && opts.width > MAX_DIMENSION || typeof opts.height === "number" && opts.height > MAX_DIMENSION) {
      throw withCode(new Error(`ui.slides.addShape: dimension exceeds ${MAX_DIMENSION}`), "E_INVALID_ARGS");
    }
    const slide = await resolveSlide(slideId, "ui.slides.addShape");
    const node = shapeType === "ELLIPSE" ? figma.createEllipse() : figma.createRectangle();
    node.x = typeof opts.x === "number" ? opts.x : 100;
    node.y = typeof opts.y === "number" ? opts.y : 100;
    node.resize(typeof opts.width === "number" ? opts.width : 200, typeof opts.height === "number" ? opts.height : 200);
    if (opts.color) {
      if (!/^#?[0-9a-fA-F]{6}$/.test(opts.color)) {
        throw withCode(new Error(`ui.slides.addShape: invalid hex color "${opts.color}"`), "E_INVALID_ARGS");
      }
      node.fills = [{ type: "SOLID", color: rgbToFigma(hexToFigmaColor(opts.color)) }];
    }
    appendAndVerify(slide, node, "ui.slides.addShape");
    return { id: node.id, type: node.type };
  }
  async function content(slideId, opts = {}) {
    requireEditor("ui.slides.content", ["slides"]);
    const slide = await resolveSlide(slideId, "ui.slides.content");
    const serialized = serializeNode(slide, opts.depth ?? 10);
    return jsonSafe(serialized);
  }

  // plugin/src/main/exec-stdlib-slides.ts
  function createExecStdlibSlides() {
    return {
      list: list2,
      grid,
      content,
      create: create2,
      remove: remove2,
      duplicate,
      reorder,
      setTransition,
      transition,
      viewMode,
      focused,
      focus,
      skip,
      background,
      addText,
      addShape
    };
  }

  // plugin/src/main/exec-stdlib.ts
  var BOUND_FIELD_EXPANSIONS = {
    cornerRadius: ["cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"],
    strokeWeight: ["strokeWeight", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"]
  };
  function expansionKeysFor(field) {
    return BOUND_FIELD_EXPANSIONS[field] ?? [field];
  }
  async function boundFill(node, varName, field = "fills") {
    const variable = await resolveVariable(varName);
    bindVariableToField(node, field, variable);
    const bindings = readBindings(node);
    const hit = expansionKeysFor(field).some((k) => bindings[k] === variable.id);
    if (!hit) {
      throw withCode(
        new Error(`bind of "${varName}" to ${field} did not take on "${node.name}" \u2014 bindings: ${JSON.stringify(bindings)}`),
        "E_EVAL"
      );
    }
    return { id: node.id, field, variable: variable.name };
  }
  async function byPath(rootId, names) {
    if (names.length === 0) throw withCode(new Error("byPath needs at least one name"), "E_EVAL");
    const root = await figma.getNodeByIdAsync(rootId);
    if (!root || root.type === "DOCUMENT" || root.type === "PAGE") {
      throw withCode(new Error(`byPath root not found: ${rootId}`), "E_EVAL");
    }
    let n = root;
    while (n && n.type !== "PAGE") n = n.parent;
    const page = n;
    if (page && page !== figma.currentPage) await page.loadAsync();
    let cur = root;
    for (const name of names) {
      if (!("children" in cur)) {
        throw withCode(new Error(`"${cur.name}" (${cur.type}) has no children`), "E_EVAL");
      }
      const children = cur.children;
      const hits = children.filter((c) => c.name === name);
      if (hits.length === 0) {
        const names20 = children.slice(0, 20).map((c) => c.name).join(", ");
        throw withCode(new Error(`byPath: "${name}" not found under "${cur.name}" \u2014 children: ${names20}`), "E_EVAL");
      }
      if (hits.length > 1) {
        throw withCode(
          new Error(`byPath: "${name}" is ambiguous under "${cur.name}" \u2014 ${hits.length} matches: ${hits.map((h) => h.id).join(", ")}`),
          "E_EVAL"
        );
      }
      cur = hits[0];
    }
    return cur;
  }
  function projectSerialized(node, fields) {
    const out = { id: node.id };
    for (const f of fields) {
      if (f === "children") {
        if (node.children) out.children = node.children.map((c) => projectSerialized(c, fields));
      } else {
        out[f] = node[f];
      }
    }
    return out;
  }
  async function q(target, opts = {}) {
    const { depth = 1, fields } = opts;
    let node;
    if (typeof target === "string") {
      const found = await figma.getNodeByIdAsync(target);
      if (!found || found.type === "DOCUMENT" || found.type === "PAGE") {
        throw withCode(new Error(`q: node not found: ${target}`), "E_EVAL");
      }
      node = found;
    } else {
      node = target;
    }
    if (fields) {
      for (const f of fields) {
        if (!SERIALIZED_NODE_FIELDS.has(f)) {
          throw withCode(
            new Error(`q: unknown field "${f}" on "${node.id}" \u2014 available: ${[...SERIALIZED_NODE_FIELDS].join(", ")}`),
            "E_EVAL"
          );
        }
      }
    }
    const full = serializeNode(node, depth);
    return jsonSafe(fields ? projectSerialized(full, fields) : full);
  }
  function createExecStdlib() {
    const { componentSet: componentSet2 } = createExecStdlibComponentSet();
    return {
      setProps,
      swapInstance,
      boundFill,
      byPath,
      q,
      componentSet: componentSet2,
      vars: createExecStdlibVars(),
      slot: createExecStdlibSlot(),
      annotate: createExecStdlibAnnotate(),
      figjam: createExecStdlibFigjam(),
      slides: createExecStdlibSlides()
    };
  }

  // plugin/src/main/exec-js-normalize.ts
  function expressionCandidates(source) {
    const out = [source];
    let semi = source;
    for (let i = 0; i < 4; i++) {
      const stripped = semi.replace(/;+\s*$/, "").trimEnd();
      if (stripped === semi) break;
      semi = stripped;
      out.push(semi);
    }
    let s = semi;
    for (let i = 0; i < 4; i++) {
      const stripped = s.replace(/(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*$/, "").replace(/;+\s*$/, "").trimEnd();
      if (stripped === s) break;
      s = stripped;
      out.push(s);
    }
    return out;
  }
  function compile(code) {
    const source = code.trim();
    for (const candidate of expressionCandidates(source)) {
      try {
        return { fn: (0, eval)(`(async (console, ui) => (${candidate}
))`), mode: "expression" };
      } catch {
      }
    }
    return { fn: (0, eval)(`(async (console, ui) => { ${source}
 })`), mode: "statement" };
  }
  function summarize(value) {
    const n = value;
    if (n && typeof n.id === "string" && typeof n.type === "string" && typeof n.remove === "function") {
      return { id: n.id, name: String(n.name ?? ""), type: n.type };
    }
    if (Array.isArray(value)) return value.map(summarize);
    return jsonSafe(value);
  }
  function isPlainObject(value) {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }
  function resultWarning(result, mode) {
    if (result === void 0) {
      return mode === "statement" ? "no explicit return \u2014 the script ran to completion but returned nothing; side effects may still have applied" : "the expression evaluated to undefined";
    }
    if (result === null) return "returned null \u2014 the node or resource may not exist";
    if (Array.isArray(result) && result.length === 0) return "returned an empty array \u2014 the search matched nothing";
    if (typeof result === "object" && isPlainObject(result) && Object.keys(result).length === 0) {
      return "returned an empty object \u2014 the operation may have matched nothing";
    }
    return void 0;
  }

  // plugin/src/main/executor-exec-js.ts
  var SENTINEL_NAME = "[figma-agent] undo sentinel";
  var SENTINEL_KEY = "figmaAgentUndoSentinel";
  function figmaUndoBracket() {
    let sentinel = null;
    return {
      begin() {
        const page = figma.currentPage;
        for (const n of page.findChildren((c) => c.getPluginData(SENTINEL_KEY) === "1")) n.remove();
        figma.commitUndo();
        const f = figma.createFrame();
        f.name = SENTINEL_NAME;
        f.setPluginData(SENTINEL_KEY, "1");
        f.resize(1, 1);
        f.x = -1e6;
        f.y = -1e6;
        f.visible = false;
        page.appendChild(f);
        sentinel = f;
      },
      commit() {
        try {
          if (sentinel && !sentinel.removed) sentinel.remove();
        } catch {
        }
        figma.commitUndo();
      },
      rollback() {
        figma.commitUndo();
        figma.triggerUndo();
      }
      // sentinel is reverted BY the undo
    };
  }
  async function runInUndoGroup(bracket, run) {
    bracket?.begin();
    let out;
    try {
      out = await run();
    } catch (err) {
      const carrier = typeof err === "object" && err !== null ? err : Object.assign(new Error(String(err)), { originalPrimitive: err });
      if (bracket) {
        try {
          bracket.rollback();
          carrier.rolledBack = true;
        } catch (undoErr) {
          carrier.rollbackFailed = undoErr instanceof Error ? undoErr.message : String(undoErr);
        }
      }
      throw carrier;
    }
    try {
      bracket?.commit();
    } catch {
    }
    return out;
  }
  async function opExecJs(params) {
    const code = params.code ?? params.js;
    if (typeof code !== "string" || !code.trim()) {
      throw withCode(new Error("EXEC_JS requires params.code (string)"), "E_INVALID_ARGS");
    }
    const logs = [];
    const capture2 = (level) => (...args) => {
      logs.push(`[${level}] ${args.map(safeStringify).join(" ")}`);
    };
    const consoleProxy = {
      log: capture2("log"),
      info: capture2("info"),
      warn: capture2("warn"),
      error: capture2("error")
    };
    let compiled;
    try {
      compiled = compile(code);
    } catch (err) {
      throw withCode(new Error(`syntax error: ${err instanceof Error ? err.message : String(err)}`), "E_EVAL");
    }
    const bracket = params.undoGroup === true ? figmaUndoBracket() : null;
    const t0 = Date.now();
    try {
      const raw = await runInUndoGroup(bracket, () => compiled.fn(consoleProxy, createExecStdlib()));
      const warning = resultWarning(raw, compiled.mode);
      return {
        result: summarize(raw),
        console: logs,
        ms: Date.now() - t0,
        executed: true,
        mode: compiled.mode,
        ...warning ? { warning } : {}
      };
    } catch (err) {
      const rolledBack = err?.rolledBack === true;
      const rollbackFailed = err?.rollbackFailed;
      const base = `runtime error: ${err instanceof Error ? err.message : String(err)}`;
      const suffix = rolledBack ? " \u2014 changes rolled back" : rollbackFailed ? ` \u2014 ROLLBACK FAILED (${rollbackFailed}); the canvas may be half-changed` : "";
      const wrapped = withCode(new Error(`${base}${suffix}`), "E_EVAL");
      if (rolledBack) wrapped.rolledBack = true;
      throw wrapped;
    }
  }

  // plugin/src/main/executor-clone-traits.ts
  var TRAIT_GROUPS = [
    "layout",
    "fills-variables",
    "typography",
    "spacing",
    "text"
  ];
  function requestedTraits(value) {
    const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    const traits = raw.map(String).map((item) => item.trim()).filter(Boolean);
    const unknown = traits.filter((item) => !TRAIT_GROUPS.includes(item));
    if (unknown.length > 0) {
      throw withCode(new Error(`unknown traits: ${unknown.join(", ")}; valid: ${TRAIT_GROUPS.join(", ")}`), "E_INVALID_ARGS");
    }
    if (traits.includes("text") && value === void 0) {
      throw withCode(new Error("text copying requires an explicit text trait"), "E_INVALID_ARGS");
    }
    return [...new Set(traits)];
  }
  async function sceneNode(id, label) {
    if (typeof id !== "string" || !id) throw withCode(new Error(`missing ${label} id`), "E_INVALID_ARGS");
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.type === "DOCUMENT" || node.type === "PAGE") {
      throw withCode(new Error(`${label} not found: ${id}`), "E_INVALID_ARGS");
    }
    return node;
  }
  function copyFields(source, target, fields) {
    const applied = [];
    const skipped = [];
    for (const field of fields) {
      if (!(field in source) || !(field in target)) continue;
      try {
        target[field] = source[field];
        applied.push(field);
      } catch {
        skipped.push(field);
      }
    }
    return { applied, skipped };
  }
  async function copyTypography(source, target) {
    if (source.type !== "TEXT" || target.type !== "TEXT") {
      throw withCode(new Error("typography trait requires TEXT source and target"), "E_INVALID_ARGS");
    }
    const font = source.fontName;
    if (font !== figma.mixed) {
      await figma.loadFontAsync(font);
      target.fontName = font;
    }
    return copyFields(source, target, [
      "fontSize",
      "lineHeight",
      "letterSpacing",
      "textAlignHorizontal",
      "textAlignVertical",
      "textCase",
      "textDecoration",
      "paragraphSpacing"
    ]);
  }
  async function opCloneTraits(params) {
    const source = await sceneNode(params.sourceId ?? params.source, "source");
    const target = await sceneNode(params.targetId ?? params.target, "target");
    const traits = requestedTraits(params.traits);
    if (traits.length === 0) throw withCode(new Error("CLONE_TRAITS requires traits"), "E_INVALID_ARGS");
    const applied = [];
    const skipped = [];
    const collect = (result) => {
      applied.push(...result.applied);
      skipped.push(...result.skipped);
    };
    for (const trait of traits) {
      if (trait === "layout") collect(copyFields(source, target, [
        "layoutMode",
        "layoutWrap",
        "primaryAxisAlignItems",
        "counterAxisAlignItems",
        "primaryAxisSizingMode",
        "counterAxisSizingMode",
        "layoutSizingHorizontal",
        "layoutSizingVertical",
        "constraints"
      ]));
      if (trait === "spacing") collect(copyFields(source, target, [
        "itemSpacing",
        "counterAxisSpacing",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft"
      ]));
      if (trait === "fills-variables") collect(copyFields(source, target, [
        "fills",
        "strokes",
        "strokeWeight",
        "opacity"
      ]));
      if (trait === "typography") collect(await copyTypography(source, target));
      if (trait === "text") {
        if (source.type !== "TEXT" || target.type !== "TEXT") {
          throw withCode(new Error("text trait requires TEXT source and target"), "E_INVALID_ARGS");
        }
        collect(await copyTypography(source, target));
        target.characters = source.characters;
        applied.push("characters");
      }
    }
    return { sourceId: source.id, targetId: target.id, traits, applied, skipped };
  }

  // plugin/src/main/executor-gradient.ts
  var GRADIENT_DATA_KEY = "shaderGradientConfig";
  function toBytes(raw) {
    if (raw instanceof Uint8Array) return raw;
    if (Array.isArray(raw)) return new Uint8Array(raw);
    if (raw !== null && typeof raw === "object") {
      const values = Object.values(raw).filter((v) => typeof v === "number");
      if (values.length > 0) return new Uint8Array(values);
    }
    throw new Error("IMPORT_GRADIENT: params.bytes did not carry image data");
  }
  async function importGradient(params) {
    const bytes = toBytes(params.bytes);
    if (bytes.length === 0) throw new Error("IMPORT_GRADIENT: refusing to bake an empty image");
    let target = null;
    if (typeof params.nodeId === "string" && params.nodeId !== "") {
      const node = await figma.getNodeByIdAsync(params.nodeId);
      if (!node) throw new Error(`IMPORT_GRADIENT: no node with id '${params.nodeId}'`);
      if (node.type === "DOCUMENT" || node.type === "PAGE") {
        throw new Error(`IMPORT_GRADIENT: '${params.nodeId}' is a ${node.type}, which carries no fills`);
      }
      target = node;
    } else {
      const selection = figma.currentPage.selection;
      if (selection.length === 0) {
        throw new Error("IMPORT_GRADIENT: nothing selected \u2014 pass --node, or select a node to bake onto");
      }
      if (selection.length > 1) {
        throw new Error(`IMPORT_GRADIENT: ${selection.length} nodes selected \u2014 select exactly one, or pass --node`);
      }
      target = selection[0];
    }
    if (!("fills" in target)) {
      throw new Error(`IMPORT_GRADIENT: a ${target.type} carries no fills`);
    }
    const image = figma.createImage(bytes);
    const paint = { type: "IMAGE", scaleMode: "FILL", imageHash: image.hash };
    target.fills = [paint];
    if (typeof params.config === "string" && params.config !== "") {
      target.setPluginData(
        GRADIENT_DATA_KEY,
        JSON.stringify({
          config: params.config,
          slug: params.slug ?? null,
          renderer: params.renderer ?? null
        })
      );
    }
    return {
      nodeId: target.id,
      name: target.name,
      slug: params.slug ?? null,
      bytes: bytes.length
    };
  }

  // shared/mutating-commands.ts
  var MUTATING_COMMANDS = [
    "CREATE_FRAME",
    "CREATE_INSTANCE",
    "SET_VARIANT",
    "CREATE_VARIABLE",
    "BIND_VARIABLE",
    "SET_AUTOLAYOUT",
    "SET_CONSTRAINTS",
    "SET_TEXT",
    "CLONE_TRAITS",
    "SET_CORRECTION_MEMORY",
    "EXEC_JS",
    "IMPORT_PAYLOAD",
    "CONNECT",
    "DISCONNECT",
    "REROUTE",
    // IMPORT_GRADIENT writes an image fill and plugin data onto an existing node —
    // its own undo step, so one ⌘Z removes the bake and restores the previous fills.
    // SHADER_GRADIENT itself is absent for the same reason HTML_TO_FIGMA is: it never
    // reaches main (it arrives as IMPORT_GRADIENT after the UI renders).
    "IMPORT_GRADIENT"
  ];

  // shared/connector-anchor.ts
  var OPPOSITE = { TOP: "BOTTOM", BOTTOM: "TOP", LEFT: "RIGHT", RIGHT: "LEFT" };
  var NORMAL = {
    TOP: { x: 0, y: -1 },
    BOTTOM: { x: 0, y: 1 },
    LEFT: { x: -1, y: 0 },
    RIGHT: { x: 1, y: 0 }
  };
  function centre(rect) {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }
  function sideMidpoint(rect, side) {
    switch (side) {
      case "TOP":
        return { x: rect.x + rect.width / 2, y: rect.y };
      case "BOTTOM":
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
      case "LEFT":
        return { x: rect.x, y: rect.y + rect.height / 2 };
      case "RIGHT":
        return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
    }
  }
  function anchorOn(rect, side) {
    return { side, point: sideMidpoint(rect, side), normal: NORMAL[side] };
  }
  function resolveAnchors(source, target) {
    const from = centre(source);
    const to = centre(target);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const sourceSide = horizontal ? dx >= 0 ? "RIGHT" : "LEFT" : dy >= 0 ? "BOTTOM" : "TOP";
    return { source: anchorOn(source, sourceSide), target: anchorOn(target, OPPOSITE[sourceSide]) };
  }
  function edgeGap(aStart, aEnd, bStart, bEnd) {
    if (aEnd < bStart) return bStart - aEnd;
    if (bEnd < aStart) return aStart - bEnd;
    return 0;
  }
  function resolveAnnotationAnchors(source, target) {
    const horizontalGap = edgeGap(source.x, source.x + source.width, target.x, target.x + target.width);
    const verticalGap = edgeGap(source.y, source.y + source.height, target.y, target.y + target.height);
    if (horizontalGap === 0 && verticalGap === 0) return resolveAnchors(source, target);
    const from = centre(source);
    const to = centre(target);
    const vertical = verticalGap > 0 && (horizontalGap === 0 || verticalGap <= horizontalGap);
    const sourceSide = vertical ? to.y >= from.y ? "BOTTOM" : "TOP" : to.x >= from.x ? "RIGHT" : "LEFT";
    return { source: anchorOn(source, sourceSide), target: anchorOn(target, OPPOSITE[sourceSide]) };
  }

  // shared/connector-route.ts
  var DEFAULT_CLEARANCE = 24;
  function round(value) {
    const rounded = Math.round(value * 10) / 10;
    return rounded === 0 ? 0 : rounded;
  }
  function roundPoint(point) {
    return { x: round(point.x), y: round(point.y) };
  }
  function samePoint(a, b) {
    return a.x === b.x && a.y === b.y;
  }
  function isRedundant(previous, current, next) {
    const sharedX = previous.x === current.x && current.x === next.x;
    const sharedY = previous.y === current.y && current.y === next.y;
    return sharedX || sharedY;
  }
  function simplify(points) {
    const deduped = [];
    for (const point of points) {
      if (deduped.length === 0 || !samePoint(deduped[deduped.length - 1], point)) deduped.push(point);
    }
    const kept = [];
    for (let i = 0; i < deduped.length; i += 1) {
      const isEnd = i === 0 || i === deduped.length - 1;
      if (isEnd || !isRedundant(deduped[i - 1], deduped[i], deduped[i + 1])) kept.push(deduped[i]);
    }
    return kept;
  }
  function turnCoordinate(from, to, direction) {
    const midpoint = (from + to) / 2;
    return direction >= 0 ? Math.max(midpoint, from) : Math.min(midpoint, from);
  }
  function centre2(rect) {
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }
  function isBackEdge(source, target, intent) {
    if (intent !== "flow") return false;
    const from = centre2(source);
    const to = centre2(target);
    if (Math.abs(to.x - from.x) < Math.abs(to.y - from.y)) return false;
    if (to.x - from.x >= 0) return false;
    const overlapTop = Math.max(source.y, target.y);
    const overlapBottom = Math.min(source.y + source.height, target.y + target.height);
    return overlapTop < overlapBottom;
  }
  function backEdge(source, target, clearance) {
    const exit = { x: source.x + source.width / 2, y: source.y + source.height };
    const entry = { x: target.x + target.width / 2, y: target.y + target.height };
    const depth = Math.max(exit.y, entry.y) + clearance * 2;
    return [exit, { x: exit.x, y: depth }, { x: entry.x, y: depth }, entry];
  }
  function orthogonal(source, target, clearance) {
    const exit = {
      x: source.point.x + source.normal.x * clearance,
      y: source.point.y + source.normal.y * clearance
    };
    const entry = {
      x: target.point.x + target.normal.x * clearance,
      y: target.point.y + target.normal.y * clearance
    };
    if (source.normal.x !== 0) {
      const x = turnCoordinate(exit.x, entry.x, source.normal.x);
      return [source.point, exit, { x, y: exit.y }, { x, y: entry.y }, entry, target.point];
    }
    const y = turnCoordinate(exit.y, entry.y, source.normal.y);
    return [source.point, exit, { x: exit.x, y }, { x: entry.x, y }, entry, target.point];
  }
  function route(input) {
    const anchors = input.intent === "annotation" ? resolveAnnotationAnchors(input.source, input.target) : resolveAnchors(input.source, input.target);
    const clearance = input.clearance ?? DEFAULT_CLEARANCE;
    let raw;
    if (input.intent === "annotation") {
      raw = [anchors.source.point, anchors.target.point];
    } else if (isBackEdge(input.source, input.target, input.intent)) {
      raw = backEdge(input.source, input.target, clearance);
    } else {
      raw = orthogonal(anchors.source, anchors.target, clearance);
    }
    const simplified = simplify(raw.map(roundPoint));
    return simplified.length >= 2 ? simplified : [roundPoint(anchors.source.point), roundPoint(anchors.target.point)];
  }

  // shared/connector-types.ts
  var ROUTER_VERSION = 2;

  // shared/connector-geometry.ts
  function round2(value) {
    const rounded = Math.round(value * 10) / 10;
    return rounded === 0 ? 0 : rounded;
  }
  function pointsToVectorNetwork(points, options) {
    if (points.length < 2) {
      throw new Error(`a connector needs at least two points, got ${points.length}`);
    }
    const origin = {
      x: round2(Math.min(...points.map((p) => p.x))),
      y: round2(Math.min(...points.map((p) => p.y)))
    };
    const lastIndex = points.length - 1;
    const vertices = points.map((point, index) => ({
      x: round2(point.x - origin.x),
      y: round2(point.y - origin.y),
      // The arrow marks the END of the edge and nothing else. Setting the node-level
      // strokeCap instead would cap BOTH open ends — the network reads `figma.mixed` once
      // vertices disagree, which is the tell that per-vertex is the real control.
      strokeCap: options.arrowAtEnd && index === lastIndex ? "ARROW_LINES" : "NONE"
    }));
    const segments = points.slice(1).map((_, index) => ({ start: index, end: index + 1 }));
    return { vertices, segments, origin };
  }

  // plugin/src/main/connector-store.ts
  var NAMESPACE = "ease_design";
  var KEY = "connections-v1";
  var cache = null;
  function parse(raw) {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  function load() {
    if (cache === null) cache = parse(figma.root.getSharedPluginData(NAMESPACE, KEY));
    return cache;
  }
  function flush(next) {
    cache = next;
    figma.root.setSharedPluginData(NAMESPACE, KEY, JSON.stringify(next));
  }
  function listConnections() {
    return [...load()];
  }
  function findConnection(id) {
    return load().find((record) => record.id === id) ?? null;
  }
  function findConnectionByEndpoints(from, to) {
    return load().find((record) => record.from === from && record.to === to) ?? null;
  }
  function upsertConnection(record) {
    const next = load().filter((existing) => existing.id !== record.id);
    next.push(record);
    flush(next);
  }
  function removeConnection(id) {
    const record = findConnection(id);
    if (!record) return null;
    flush(load().filter((existing) => existing.id !== id));
    return record;
  }
  function stampNodeConnectionId(node, connectionId) {
    node.setSharedPluginData(NAMESPACE, "connection_id", connectionId);
  }
  function readNodeConnectionId(node) {
    return node.getSharedPluginData(NAMESPACE, "connection_id");
  }
  function resetConnectionCache() {
    cache = null;
  }

  // plugin/src/main/connector-render.ts
  var LABEL_SIZE = 11;
  var ELECTRIC_BLUE = { r: 37 / 255, g: 71 / 255, b: 255 / 255 };
  var STROKE = { type: "SOLID", color: ELECTRIC_BLUE };
  var PILL_FILL = { type: "SOLID", color: ELECTRIC_BLUE };
  var PILL_TEXT = { type: "SOLID", color: { r: 1, g: 1, b: 1 } };
  var STROKE_WEIGHT = 2;
  var PILL_PADDING_X = 8;
  var PILL_PADDING_Y = 3;
  var PILL_RADIUS = 4;
  function labelAnchor(points) {
    let best = 0;
    let bestLength = -1;
    for (let i = 1; i < points.length; i += 1) {
      const length = Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
      if (length > bestLength) {
        bestLength = length;
        best = i;
      }
    }
    return {
      x: (points[best].x + points[best - 1].x) / 2,
      y: (points[best].y + points[best - 1].y) / 2
    };
  }
  async function applyNetwork(vector, network) {
    await vector.setVectorNetworkAsync({
      vertices: network.vertices.map((v) => ({ x: v.x, y: v.y, strokeCap: v.strokeCap })),
      segments: network.segments.map((s) => ({ start: s.start, end: s.end }))
    });
    vector.strokes = [STROKE];
    vector.strokeWeight = STROKE_WEIGHT;
    vector.x = network.origin.x;
    vector.y = network.origin.y;
  }
  async function renderConnector(input) {
    const network = pointsToVectorNetwork(input.points, { arrowAtEnd: true });
    const vector = input.existingVector ?? figma.createVector();
    if (!input.existingVector) input.page.appendChild(vector);
    vector.name = input.intent === "flow" ? "Flow connector" : "Annotation pointer";
    await applyNetwork(vector, network);
    stampNodeConnectionId(vector, input.connectionId);
    let labelNodeId = null;
    if (input.label) {
      const font = await loadBestFont("Inter", 400);
      const pill = input.existingLabel ?? figma.createFrame();
      if (!input.existingLabel) input.page.appendChild(pill);
      pill.name = `${input.label} \u2014 connector label`;
      pill.layoutMode = "HORIZONTAL";
      pill.primaryAxisSizingMode = "AUTO";
      pill.counterAxisSizingMode = "AUTO";
      pill.paddingLeft = pill.paddingRight = PILL_PADDING_X;
      pill.paddingTop = pill.paddingBottom = PILL_PADDING_Y;
      pill.cornerRadius = PILL_RADIUS;
      pill.fills = [PILL_FILL];
      pill.clipsContent = false;
      const text = pill.children[0] && pill.children[0].type === "TEXT" ? pill.children[0] : figma.createText();
      if (text.parent !== pill) pill.appendChild(text);
      text.fontName = font;
      text.fontSize = LABEL_SIZE;
      text.characters = input.label;
      text.fills = [PILL_TEXT];
      text.textAutoResize = "WIDTH_AND_HEIGHT";
      const anchor = labelAnchor(input.points);
      pill.x = Math.round(anchor.x - pill.width / 2);
      pill.y = Math.round(anchor.y - pill.height - 4);
      stampNodeConnectionId(pill, input.connectionId);
      labelNodeId = pill.id;
    } else if (input.existingLabel) {
      input.existingLabel.remove();
    }
    return { vectorNodeId: vector.id, labelNodeId };
  }

  // shared/supervised-memory.ts
  var CORRECTION_SCHEMA_VERSION = 1;
  var EDGE_RAW_LIMIT = 250;
  var RAW_RETENTION_DAYS = 30;
  function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
      const entries = Object.entries(value).filter(([, child]) => child !== void 0).sort(([a], [b]) => a.localeCompare(b));
      return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  }
  function correctionContentHash(value) {
    const text = canonical(value);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }
  function buildCorrectionEvent(input) {
    const body = { ...input, v: CORRECTION_SCHEMA_VERSION };
    return { ...body, contentHash: correctionContentHash(body) };
  }
  function byTimeThenId(a, b) {
    return a.timestamp.localeCompare(b.timestamp) || a.eventId.localeCompare(b.eventId);
  }
  function retainCorrectionEvents(events, now, limit, maxAgeDays = RAW_RETENTION_DAYS) {
    const cutoff = now.getTime() - maxAgeDays * 864e5;
    const unresolved = events.filter((event) => event.unresolved === true).sort(byTimeThenId);
    const resolvedFresh = events.filter((event) => event.unresolved !== true && Date.parse(event.timestamp) >= cutoff).sort(byTimeThenId);
    const overBudget = Math.max(0, resolvedFresh.length + unresolved.length - Math.max(0, limit));
    const resolvedEvictCount = Math.min(overBudget, resolvedFresh.length);
    const keptResolved = resolvedFresh.slice(resolvedEvictCount);
    const stillOverBudget = overBudget - resolvedEvictCount;
    const evictedUnresolved = stillOverBudget > 0 ? unresolved.slice(0, stillOverBudget) : [];
    const keptUnresolved = stillOverBudget > 0 ? unresolved.slice(stillOverBudget) : unresolved;
    const kept = [...new Map([...keptResolved, ...keptUnresolved].map((event) => [event.eventId, event])).values()].sort(byTimeThenId);
    return { kept, evictedUnresolved };
  }

  // plugin/src/main/correction-edge-store.ts
  var NAMESPACE2 = "ease_design";
  var KEY_V1 = "figma-corrections-v1";
  var MANIFEST_KEY = "figma-corrections-v2-manifest";
  var CHUNK_PREFIX = "figma-corrections-v2-";
  var CHUNK_BYTE_BUDGET = 64e3;
  var FIGMA_ENTRY_BYTE_CAP = 1e5;
  var suppressedUntil = /* @__PURE__ */ new Map();
  var eventSequence = 0;
  function parseEvents(text) {
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  function chunkKey(i) {
    return `${CHUNK_PREFIX}${i}`;
  }
  function readManifest() {
    const raw = figma.root.getSharedPluginData(NAMESPACE2, MANIFEST_KEY);
    if (!raw) return void 0;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.v === 2 && typeof parsed.chunks === "number" && Number.isInteger(parsed.chunks) && parsed.chunks >= 0) {
        const evictedUnresolved = typeof parsed.evictedUnresolved === "number" && Number.isInteger(parsed.evictedUnresolved) && parsed.evictedUnresolved >= 0 ? parsed.evictedUnresolved : 0;
        return { v: 2, chunks: parsed.chunks, evictedUnresolved };
      }
      return void 0;
    } catch {
      return void 0;
    }
  }
  function readEvictedUnresolvedCount() {
    return readManifest()?.evictedUnresolved ?? 0;
  }
  function splitIntoChunks(events) {
    const chunks = [];
    let current = [];
    let currentBytes = 2;
    for (const event of events) {
      const eventBytes = utf8ByteLength(JSON.stringify(event));
      const commaBeforeAdd = current.length > 0 ? 1 : 0;
      if (current.length > 0 && currentBytes + commaBeforeAdd + eventBytes > CHUNK_BYTE_BUDGET) {
        chunks.push(JSON.stringify(current));
        current = [];
        currentBytes = 2;
      }
      const comma = current.length > 0 ? 1 : 0;
      current.push(event);
      currentBytes += comma + eventBytes;
    }
    if (current.length > 0) chunks.push(JSON.stringify(current));
    return chunks;
  }
  function readChunked(manifest) {
    const events = [];
    for (let i = 0; i < manifest.chunks; i++) {
      events.push(...parseEvents(figma.root.getSharedPluginData(NAMESPACE2, chunkKey(i))));
    }
    return events;
  }
  function clearChunkRange(startInclusive, endExclusive) {
    for (let i = startInclusive; i < endExclusive; i++) figma.root.setSharedPluginData(NAMESPACE2, chunkKey(i), "");
  }
  function readEdgeCorrections() {
    const manifest = readManifest();
    return manifest !== void 0 ? readChunked(manifest) : parseEvents(figma.root.getSharedPluginData(NAMESPACE2, KEY_V1));
  }
  function writeEdgeCorrections(events) {
    const priorManifest = readManifest();
    let { kept, evictedUnresolved } = retainCorrectionEvents(events, /* @__PURE__ */ new Date(), EDGE_RAW_LIMIT);
    let chunks = splitIntoChunks(kept);
    let byteCapEvictedUnresolved = 0;
    while (kept.length > 0 && chunks.some((c) => utf8ByteLength(c) > FIGMA_ENTRY_BYTE_CAP)) {
      if (kept[0].unresolved === true) byteCapEvictedUnresolved += 1;
      kept = kept.slice(1);
      chunks = splitIntoChunks(kept);
    }
    for (let i = 0; i < chunks.length; i++) figma.root.setSharedPluginData(NAMESPACE2, chunkKey(i), chunks[i]);
    if (priorManifest !== void 0 && priorManifest.chunks > chunks.length) {
      clearChunkRange(chunks.length, priorManifest.chunks);
    }
    const totalEvictedUnresolved = (priorManifest?.evictedUnresolved ?? 0) + evictedUnresolved.length + byteCapEvictedUnresolved;
    figma.root.setSharedPluginData(
      NAMESPACE2,
      MANIFEST_KEY,
      JSON.stringify({ v: 2, chunks: chunks.length, evictedUnresolved: totalEvictedUnresolved })
    );
    if (figma.root.getSharedPluginData(NAMESPACE2, KEY_V1) !== "") {
      figma.root.setSharedPluginData(NAMESPACE2, KEY_V1, "");
    }
    return kept;
  }
  function eventId(prefix, nodeId) {
    eventSequence += 1;
    return `${prefix}-${Date.now()}-${eventSequence}-${nodeId.replace(/[^a-z0-9]/gi, "-")}`;
  }
  function isDesignerCorrectionCandidate(changeType, properties) {
    if (changeType !== "PROPERTY_CHANGE" || properties.length === 0) return false;
    return !properties.includes("parent") && !properties.includes("relativeTransform");
  }
  function beginAgentMutation(nodeIds) {
    const until = Date.now() + 2e3;
    for (const nodeId of nodeIds) suppressedUntil.set(nodeId, until);
  }
  function recordAgentMutation(nodeId, traits) {
    const event = buildCorrectionEvent({
      eventId: eventId("agent", nodeId),
      fileKey: figma.fileKey ?? "local-file",
      nodeId,
      source: "agent",
      kind: "agent-operation",
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      traits
    });
    writeEdgeCorrections([...readEdgeCorrections(), event]);
    return event;
  }
  function recordAgentMutationBatch(nodeIds, traits) {
    beginAgentMutation(nodeIds);
    return nodeIds.map((nodeId) => recordAgentMutation(nodeId, traits));
  }
  function beginCorrectionBatch() {
    return { events: null, appended: 0 };
  }
  function recordDesignerCorrectionInBatch(batch, nodeId, traits) {
    const changeType = typeof traits.changeType === "string" ? traits.changeType : "";
    const properties = Array.isArray(traits.properties) ? traits.properties.filter((value) => typeof value === "string") : [];
    if (!isDesignerCorrectionCandidate(changeType, properties)) return null;
    if ((suppressedUntil.get(nodeId) ?? 0) >= Date.now()) return null;
    if (batch.events === null) batch.events = readEdgeCorrections();
    const events = batch.events;
    let parent;
    for (let i = events.length - 1; i >= 0; i--) {
      const candidate = events[i];
      if (candidate.nodeId === nodeId && candidate.kind === "agent-operation") {
        parent = candidate;
        break;
      }
    }
    if (!parent) return null;
    const event = buildCorrectionEvent({
      eventId: eventId("correction", nodeId),
      fileKey: figma.fileKey ?? "local-file",
      nodeId,
      source: "designer",
      kind: "designer-correction",
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      causalParent: parent.eventId,
      unresolved: true,
      traits
    });
    events.push(event);
    batch.appended += 1;
    return event;
  }
  function flushCorrectionBatch(batch) {
    if (batch.appended === 0 || batch.events === null) return;
    writeEdgeCorrections(batch.events);
  }

  // plugin/src/main/connector-reroute.ts
  var DEBOUNCE_MS = 120;
  var watchIndex = null;
  var ownNodes = /* @__PURE__ */ new Set();
  var pendingConnections = /* @__PURE__ */ new Set();
  var debounce = null;
  function addWatch(map, nodeId, connectionId) {
    const existing = map.get(nodeId);
    if (existing) existing.add(connectionId);
    else map.set(nodeId, /* @__PURE__ */ new Set([connectionId]));
  }
  async function buildIndex() {
    const map = /* @__PURE__ */ new Map();
    const own = /* @__PURE__ */ new Set();
    for (const record of listConnections()) {
      own.add(record.vectorNodeId);
      if (record.labelNodeId) own.add(record.labelNodeId);
      for (const endpoint of [record.from, record.to]) {
        let node = await figma.getNodeByIdAsync(endpoint);
        while (node) {
          addWatch(map, node.id, record.id);
          node = node.parent;
        }
      }
    }
    ownNodes = own;
    return map;
  }
  function invalidateConnectorIndex() {
    watchIndex = null;
  }
  function boxOf(node) {
    const box = node.absoluteBoundingBox;
    return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
  }
  function samePoints(a, b) {
    return a.length === b.length && a.every((point, i) => point.x === b[i].x && point.y === b[i].y);
  }
  async function rerouteConnections(ids) {
    const wanted = ids ? new Set(ids) : null;
    const outcomes = [];
    for (const record of listConnections()) {
      if (wanted && !wanted.has(record.id)) continue;
      const source = await figma.getNodeByIdAsync(record.from);
      const target = await figma.getNodeByIdAsync(record.to);
      const sourceBox = source && "absoluteBoundingBox" in source ? boxOf(source) : null;
      const targetBox = target && "absoluteBoundingBox" in target ? boxOf(target) : null;
      if (!sourceBox || !targetBox) {
        outcomes.push({ connectionId: record.id, status: "orphan" });
        continue;
      }
      const points = route({ source: sourceBox, target: targetBox, intent: record.intent });
      const vectorNode = await figma.getNodeByIdAsync(record.vectorNodeId);
      const drawnAtRoute = vectorNode && vectorNode.type === "VECTOR" && Math.abs(vectorNode.x - Math.min(...points.map((p) => p.x))) <= 0.5 && Math.abs(vectorNode.y - Math.min(...points.map((p) => p.y))) <= 0.5;
      if (samePoints(points, record.routePoints) && drawnAtRoute) {
        outcomes.push({ connectionId: record.id, status: "unchanged" });
        continue;
      }
      const page = pageOf(source);
      if (!page) {
        outcomes.push({ connectionId: record.id, status: "orphan" });
        continue;
      }
      const labelNode = record.labelNodeId ? await figma.getNodeByIdAsync(record.labelNodeId) : null;
      const rendered = await renderConnector({
        connectionId: record.id,
        page,
        points,
        intent: record.intent,
        label: record.label,
        existingVector: vectorNode && vectorNode.type === "VECTOR" ? vectorNode : null,
        existingLabel: labelNode && labelNode.type === "FRAME" ? labelNode : null
      });
      beginAgentMutation([rendered.vectorNodeId, ...rendered.labelNodeId ? [rendered.labelNodeId] : []]);
      const next = {
        ...record,
        vectorNodeId: rendered.vectorNodeId,
        labelNodeId: rendered.labelNodeId,
        routePoints: points,
        routerVersion: ROUTER_VERSION
      };
      upsertConnection(next);
      outcomes.push({ connectionId: record.id, status: "redrawn" });
    }
    invalidateConnectorIndex();
    return outcomes;
  }
  async function flushPending() {
    debounce = null;
    const ids = [...pendingConnections];
    pendingConnections.clear();
    if (ids.length === 0) return;
    try {
      await rerouteConnections(ids);
    } catch {
    }
  }
  async function noteChangedNodes(nodeIds) {
    if (listConnections().length === 0) return;
    if (watchIndex === null) watchIndex = await buildIndex();
    let queued = false;
    for (const nodeId of nodeIds) {
      if (ownNodes.has(nodeId)) continue;
      const affected = watchIndex.get(nodeId);
      if (!affected) continue;
      for (const connectionId of affected) pendingConnections.add(connectionId);
      queued = true;
    }
    if (!queued) return;
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => {
      void flushPending();
    }, DEBOUNCE_MS);
  }

  // shared/flow-plan.ts
  function routesMatch(a, b, epsilon = 0.5) {
    if (a.length !== b.length) return false;
    return a.every((point, i) => Math.abs(point.x - b[i].x) <= epsilon && Math.abs(point.y - b[i].y) <= epsilon);
  }

  // plugin/src/main/connector-verify.ts
  var EPSILON = 0.5;
  function boxOf2(node) {
    if (!node || !("absoluteBoundingBox" in node)) return null;
    const box = node.absoluteBoundingBox;
    return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
  }
  async function verifyConnections() {
    const reports = [];
    const counts = { orphan: 0, desync: 0, stale: 0, drift: 0 };
    for (const record of listConnections()) {
      const findings = [];
      const detail = [];
      const source = await figma.getNodeByIdAsync(record.from);
      const target = await figma.getNodeByIdAsync(record.to);
      const sourceBox = boxOf2(source);
      const targetBox = boxOf2(target);
      if (!sourceBox || !targetBox) {
        findings.push("orphan");
        detail.push(`endpoint gone: ${!sourceBox ? record.from : record.to}`);
      }
      const vector = await figma.getNodeByIdAsync(record.vectorNodeId);
      if (!vector || vector.type !== "VECTOR") {
        findings.push("desync");
        detail.push(`no vector node at ${record.vectorNodeId}`);
      } else if (readNodeConnectionId(vector) !== record.id) {
        findings.push("desync");
        detail.push(`node ${vector.id} claims a different connection id`);
      }
      if (record.routerVersion !== ROUTER_VERSION) {
        findings.push("stale");
        detail.push(`drawn by router v${record.routerVersion}, current is v${ROUTER_VERSION}`);
      }
      if (sourceBox && targetBox) {
        const fresh = route({ source: sourceBox, target: targetBox, intent: record.intent });
        if (!routesMatch(record.routePoints, fresh, EPSILON)) {
          findings.push("drift");
          detail.push("the stored route no longer matches the endpoints");
        } else if (vector && vector.type === "VECTOR") {
          const drawn = boxOf2(vector);
          const minX = Math.min(...fresh.map((p) => p.x));
          const minY = Math.min(...fresh.map((p) => p.y));
          if (drawn && (Math.abs(drawn.x - minX) > EPSILON || Math.abs(drawn.y - minY) > EPSILON)) {
            findings.push("drift");
            detail.push(`drawn at ${drawn.x},${drawn.y} but the route starts at ${minX},${minY}`);
          }
        }
      }
      for (const finding of findings) counts[finding] += 1;
      reports.push({
        connectionId: record.id,
        from: record.from,
        to: record.to,
        flow: record.flow,
        findings,
        detail
      });
    }
    return {
      checked: reports.length,
      ok: reports.filter((r) => r.findings.length === 0).length,
      findings: counts,
      reports
    };
  }

  // plugin/src/main/executor-connector.ts
  var connectionSequence = 0;
  function requireDesignFile2(capability) {
    resetConnectionCache();
    const refusal = editorRefusal({
      capability,
      required: ["figma"],
      found: figma.editorType ?? null
    });
    if (refusal) throw withCode(new Error(refusal), "E_WRONG_EDITOR");
  }
  function str(params, ...keys) {
    for (const key of keys) {
      const value = params[key];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
    return null;
  }
  var ATTACHABLE = ["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP", "SECTION", "RECTANGLE", "TEXT"];
  async function resolveByName(name, pageName, role) {
    let page = figma.currentPage;
    if (pageName) {
      page = figma.root.children.find((p) => p.name === pageName) ?? null;
      if (!page) throw withCode(new Error(`page not found: ${pageName}`), "E_INVALID_ARGS");
    }
    await page.loadAsync();
    const matches = page.findAll((n) => n.name === name && ATTACHABLE.indexOf(n.type) !== -1);
    if (matches.length === 0) {
      throw withCode(new Error(`${role} node named "${name}" not found on page "${page.name}"`), "E_INVALID_ARGS");
    }
    if (matches.length > 1) {
      throw withCode(new Error(
        `${role} name "${name}" is ambiguous on page "${page.name}" \u2014 ${matches.length} nodes match (${matches.slice(0, 4).map((n) => n.id).join(", ")})`
      ), "E_INVALID_ARGS");
    }
    return matches[0];
  }
  async function resolveEndpoint2(id, role) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node) throw withCode(new Error(`${role} node not found: ${id}`), "E_INVALID_ARGS");
    if (!("absoluteBoundingBox" in node)) {
      throw withCode(new Error(`${role} node ${id} has no geometry (${node.type})`), "E_INVALID_ARGS");
    }
    return node;
  }
  function boxOf3(node, role) {
    const box = node.absoluteBoundingBox;
    if (!box) throw withCode(new Error(`${role} node ${node.id} reports no bounding box`), "E_INVALID_ARGS");
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }
  async function existingNode(id, type) {
    if (!id) return null;
    const node = await figma.getNodeByIdAsync(id);
    return node && node.type === type ? node : null;
  }
  async function opConnect(params) {
    requireDesignFile2("drawing a connector");
    const fromName = str(params, "fromName");
    const toName = str(params, "toName");
    const pageName = str(params, "page");
    let fromId = str(params, "from", "source");
    let toId = str(params, "to", "target");
    if (fromName) fromId = (await resolveByName(fromName, pageName, "source")).id;
    if (toName) toId = (await resolveByName(toName, pageName, "target")).id;
    if (!fromId || !toId) throw withCode(new Error("CONNECT requires params.from/params.to (ids) or params.fromName/params.toName"), "E_INVALID_ARGS");
    if (fromId === toId) throw withCode(new Error("CONNECT needs two different nodes"), "E_INVALID_ARGS");
    const intent = str(params, "intent") === "annotation" ? "annotation" : "flow";
    const label = str(params, "label");
    const flowName = str(params, "flow", "flowName");
    const transitionId = str(params, "transition", "transitionId");
    const clearance = typeof params.clearance === "number" ? params.clearance : void 0;
    const source = await resolveEndpoint2(fromId, "source");
    const target = await resolveEndpoint2(toId, "target");
    const page = pageOf(source);
    if (!page || pageOf(target) !== page) {
      throw withCode(new Error("CONNECT needs both nodes on the same page"), "E_INVALID_ARGS");
    }
    const points = route({ source: boxOf3(source, "source"), target: boxOf3(target, "target"), intent, clearance });
    const existing = findConnectionByEndpoints(fromId, toId);
    connectionSequence += 1;
    const connectionId = existing?.id ?? `conn-${Date.now()}-${connectionSequence}`;
    const rendered = await renderConnector({
      connectionId,
      page,
      points,
      intent,
      label,
      existingVector: await existingNode(existing?.vectorNodeId ?? null, "VECTOR"),
      existingLabel: await existingNode(existing?.labelNodeId ?? null, "FRAME")
    });
    const record = {
      id: connectionId,
      from: fromId,
      to: toId,
      intent,
      // Provenance is what makes the canvas a projection of the linted graph rather than a
      // second graph: an edge that cannot name its transition can be measured but not checked.
      flow: flowName && transitionId ? { name: flowName, transitionId } : null,
      label,
      vectorNodeId: rendered.vectorNodeId,
      labelNodeId: rendered.labelNodeId,
      routePoints: points,
      routerVersion: ROUTER_VERSION
    };
    upsertConnection(record);
    invalidateConnectorIndex();
    return { id: rendered.vectorNodeId, connectionId, redrawn: existing !== null, points, record };
  }
  async function opDisconnect(params) {
    requireDesignFile2("removing a connector");
    const id = str(params, "id", "connectionId");
    const fromId = str(params, "from");
    const toId = str(params, "to");
    const record = id ? findConnection(id) : fromId && toId ? findConnectionByEndpoints(fromId, toId) : null;
    if (!record) throw withCode(new Error("DISCONNECT requires params.id, or both params.from and params.to"), "E_INVALID_ARGS");
    const vector = await existingNode(record.vectorNodeId, "VECTOR");
    const text = record.labelNodeId ? await figma.getNodeByIdAsync(record.labelNodeId) : null;
    if (vector) vector.remove();
    if (text && !text.removed) text.remove();
    removeConnection(record.id);
    invalidateConnectorIndex();
    return { connectionId: record.id, removedVector: vector !== null, removedLabel: text !== null };
  }
  async function opReroute(params) {
    requireDesignFile2("rerouting connectors");
    const id = str(params, "id", "connectionId");
    const flowName = str(params, "flow", "flowName");
    const scoped = id ? [id] : flowName ? listConnections().filter((r) => r.flow?.name === flowName).map((r) => r.id) : void 0;
    const outcomes = await rerouteConnections(scoped);
    const counts = { redrawn: 0, unchanged: 0, orphan: 0 };
    for (const outcome of outcomes) counts[outcome.status] += 1;
    return { checked: outcomes.length, ...counts, outcomes };
  }
  async function opVerifyConnections() {
    resetConnectionCache();
    return verifyConnections();
  }
  function opListConnections() {
    resetConnectionCache();
    const connections2 = listConnections();
    return { count: connections2.length, connections: connections2 };
  }

  // plugin/src/ui/panel-model.ts
  var RAIL_COMPACT_WIDTH = 200;
  var RAIL_ONE_ACTION_WIDTH = 220;
  var RAIL_TWO_ACTIONS_WIDTH = 240;
  var RAIL_HEIGHT = 44;
  var INSPECTOR_WIDTH = 288;
  var INSPECTOR_HEIGHT = 280;
  function viewportFor(mode) {
    if (mode === "inspector") return { width: INSPECTOR_WIDTH, height: INSPECTOR_HEIGHT };
    const width = mode === "rail-compact" ? RAIL_COMPACT_WIDTH : mode === "rail-one-action" ? RAIL_ONE_ACTION_WIDTH : RAIL_TWO_ACTIONS_WIDTH;
    return { width, height: RAIL_HEIGHT };
  }

  // plugin/src/main/readonly-guard.ts
  function createReadOnlyGuardState() {
    return { soleActorChangeEvents: 0 };
  }
  function recordDocumentChangeBatch(state, activeCount2) {
    if (activeCount2 === 1) state.soleActorChangeEvents += 1;
  }
  function snapshotChangeEvents(state) {
    return state.soleActorChangeEvents;
  }
  function violatedSinceSnapshot(state, snapshot) {
    return state.soleActorChangeEvents > snapshot;
  }
  function isReadOnlyExecJs(cmd, readOnly) {
    return cmd === "EXEC_JS" && readOnly === true;
  }

  // plugin/src/main/main.ts
  figma.showUI(__html__, {
    visible: true,
    width: RAIL_COMPACT_WIDTH,
    height: RAIL_HEIGHT,
    title: "design:os by JANG",
    themeColors: true
  });
  var bootSkipped = [];
  var relaunchAttempted = false;
  var relaunchUnboundNoted = false;
  function maybeSetRelaunchData(bound) {
    if (relaunchAttempted) return;
    if (!bound) {
      if (!relaunchUnboundNoted) {
        relaunchUnboundNoted = true;
        bootSkipped.push("relaunchData: skipped (file not bound \u2014 run `figma-agent bind`)");
      }
      return;
    }
    relaunchAttempted = true;
    try {
      figma.root.setRelaunchData({ open: "Reconnect figma-agent" });
    } catch (err) {
      bootSkipped.push(`relaunchData: refused (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  function selectionSummary() {
    const sel = figma.currentPage.selection;
    return { selectionName: sel.length > 0 ? sel[0].name : null, selectionCount: sel.length };
  }
  var announcedFileName = "";
  function announceFileInfo() {
    announcedFileName = figma.root.name;
    figma.ui.postMessage({
      type: "FILE_INFO",
      data: {
        fileName: figma.root.name,
        page: figma.currentPage.name,
        fileKey: figma.fileKey ?? null,
        ...selectionSummary()
      }
    });
  }
  announceFileInfo();
  figma.on("currentpagechange", announceFileInfo);
  figma.on("selectionchange", announceFileInfo);
  function fileContext() {
    const ctx = { fileName: figma.root.name, fileKey: figma.fileKey ?? null };
    if (ctx.fileName !== announcedFileName) announceFileInfo();
    return ctx;
  }
  var activeCount = 0;
  var lastDrainAt = 0;
  var declaredIds = /* @__PURE__ */ new Map();
  var lastAgentAt = /* @__PURE__ */ new Map();
  function actorState() {
    return { activeCount, lastDrainAt, declared: declaredIds, lastAgentAt };
  }
  var readOnlyGuard = createReadOnlyGuardState();
  var readOnlyViolations = 0;
  var idleMs = DEFAULT_IDLE_MS;
  var idleTimer = null;
  var changesSinceCommit = 0;
  var hasEditsSinceSnapshot = false;
  var baselineStore = createClientStorageBaselineStore();
  var gapfillStats = createGapfillStats();
  var triggerBaselineWrite = createSingleFlightWriter(
    () => writeBaseline(figma.root.children, snapshotPage, baselineStore, gapfillStats)
  );
  function resetIdleTimer() {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(fireIdle, idleMs);
  }
  function fireIdle() {
    idleTimer = null;
    if (hasEditsSinceSnapshot) {
      hasEditsSinceSnapshot = false;
      triggerBaselineWrite();
    }
    if (changesSinceCommit <= 0) return;
    figma.ui.postMessage({ type: "IDLE_READY", data: { count: changesSinceCommit } });
    changesSinceCommit = 0;
  }
  var editIdentityCache = createEditIdentityCache();
  var capture = createDocumentChangeCapture({
    now: () => Date.now(),
    onBatchStart: (now) => {
      pruneDeclaredIds(declaredIds, now);
      recordDocumentChangeBatch(readOnlyGuard, activeCount);
    },
    actorState,
    identity: editIdentityCache,
    // The store is read once for the whole batch and written once at its end — never per
    // changed node, which is what made a 50-node drag pay for the whole store 50 times.
    corrections: {
      begin: beginCorrectionBatch,
      record: recordDesignerCorrectionInBatch,
      flush: flushCorrectionBatch
    },
    noteChangedNodes: (nodeIds) => {
      void noteChangedNodes(nodeIds);
    },
    post: (message) => {
      figma.ui.postMessage(message);
    },
    noteComponentChanges: (count) => {
      changesSinceCommit += count;
    },
    noteEdits: () => {
      hasEditsSinceSnapshot = true;
    },
    // the next idle fire refreshes the gap-fill snapshot
    armIdle: resetIdleTimer
  });
  async function reportGapfill() {
    const gapfillEdits = await runGapfillDiff(figma.root.children, baselineStore, gapfillStats);
    if (gapfillEdits.length > 0) {
      figma.ui.postMessage({
        type: "EDIT_FEED",
        data: {
          edits: gapfillEdits,
          fileKey: figma.fileKey ?? null,
          fileName: figma.root.name,
          source: "gapfill"
        }
      });
    }
    clearLegacyGapfillDocumentData(gapfillStats);
  }
  void runBootCapture({
    loadAllPages: () => figma.loadAllPagesAsync(),
    gapfill: reportGapfill,
    subscribe: () => {
      figma.on("documentchange", capture.onDocumentChange);
    },
    notify: (message) => {
      figma.notify(message);
    }
  });
  figma.ui.onmessage = async (msg) => {
    const chrome = msg;
    if (chrome && chrome.type === "PANEL_VIEWPORT" && (chrome.mode === "rail-compact" || chrome.mode === "rail-one-action" || chrome.mode === "rail-two-actions" || chrome.mode === "inspector")) {
      const viewport = viewportFor(chrome.mode);
      figma.ui.resize(viewport.width, viewport.height);
      return;
    }
    if (chrome && chrome.type === "SYNC_CONFIG") {
      const data = chrome.data;
      const raw = data?.idleMs;
      if (typeof raw === "number" && Number.isFinite(raw)) idleMs = Math.max(MIN_IDLE_MS, Math.floor(raw));
      maybeSetRelaunchData(data?.bound === true);
      return;
    }
    if (chrome && chrome.type === "SYNC_DONE") {
      if (chrome.commit === true) changesSinceCommit = 0;
      return;
    }
    if (chrome && chrome.type === "UI_READY") {
      announceFileInfo();
      return;
    }
    const req = msg;
    if (!req || typeof req.requestId !== "string" || typeof req.cmd !== "string") return;
    const ctx = fileContext();
    try {
      if (typeof req.expectedFile === "string" && req.expectedFile.trim() !== "" && !fileMatches(ctx.fileName, req.expectedFile, true)) {
        throw withCode(new Error(
          `this plugin is connected to file "${ctx.fileName}", command expected "${req.expectedFile}" \u2014 nothing was executed`
        ), "E_WRONG_FILE");
      }
      const targetIds = mutationTargetIds(req.cmd, req.params ?? {});
      beginAgentMutation(targetIds);
      activeCount += 1;
      for (const id of targetIds) declaredIds.set(id, Infinity);
      const enforceReadOnly = isReadOnlyExecJs(req.cmd, req.readOnly);
      const readOnlySnapshot = enforceReadOnly ? snapshotChangeEvents(readOnlyGuard) : 0;
      try {
        const result = await dispatch(req.cmd, req.params ?? {});
        if (enforceReadOnly && violatedSinceSnapshot(readOnlyGuard, readOnlySnapshot)) {
          readOnlyViolations += 1;
          throw withCode(new Error(
            "EXEC_JS declared --read-only but mutated the scene \u2014 a read-only-declared script must not write; refused (the mutation already ran and was sealed into its own undo step, not the caller's previous one)"
          ), "E_READONLY_VIOLATION");
        }
        const changedIds = [.../* @__PURE__ */ new Set([...targetIds, ...resultMutationIds(req.cmd, result)])];
        recordAgentMutationBatch(changedIds, { command: req.cmd });
        const completedAt = Date.now();
        for (const nodeId of changedIds) lastAgentAt.set(nodeId, completedAt);
        pruneLastAgentAt(lastAgentAt, completedAt);
        commitIfMutating(req.cmd);
        figma.ui.postMessage({ requestId: req.requestId, ok: true, result, fileContext: ctx });
      } finally {
        const finishedAt = Date.now();
        const expiresAt = finishedAt + AGENT_ECHO_MS;
        for (const id of targetIds) declaredIds.set(id, expiresAt);
        activeCount -= 1;
        if (activeCount === 0) lastDrainAt = finishedAt;
      }
    } catch (err) {
      commitIfMutating(req.cmd);
      figma.ui.postMessage({ requestId: req.requestId, ok: false, error: shapeError(err), fileContext: ctx });
    }
  };
  function commitIfMutating(cmd) {
    if (MUTATING_COMMANDS.indexOf(cmd) !== -1) figma.commitUndo();
  }
  function shapeError(err) {
    const code = err?.code ?? "E_PLUGIN_ERROR";
    const message = err instanceof Error ? err.message : String(err);
    const rolledBack = err?.rolledBack;
    return rolledBack ? { code, message, rolledBack } : { code, message };
  }
  function resultMutationIds(cmd, result) {
    const creating = [
      "CREATE_FRAME",
      "CREATE_INSTANCE",
      "IMPORT_PAYLOAD",
      "HTML_TO_FIGMA",
      "CONNECT"
    ];
    if (!creating.includes(cmd) || !result || typeof result !== "object") return [];
    const id = result.id;
    return typeof id === "string" && id ? [id] : [];
  }
  function mutationTargetIds(cmd, params) {
    const mutating = [
      "SET_VARIANT",
      "BIND_VARIABLE",
      "SET_AUTOLAYOUT",
      "SET_CONSTRAINTS",
      "SET_TEXT",
      "CLONE_TRAITS"
    ];
    if (!mutating.includes(cmd)) return [];
    const raw = cmd === "CLONE_TRAITS" ? params.targetId ?? params.target : params.nodeId ?? params.node;
    return typeof raw === "string" && raw ? [raw] : [];
  }
  async function dispatch(cmd, params) {
    switch (cmd) {
      case "STATUS":
        return opStatus(
          bootSkipped,
          readOnlyViolations,
          toGapfillStatus(gapfillStats),
          capture.stats
        );
      case "GET_SELECTION":
        return opGetSelection(params);
      case "SCAN_DESIGN_SYSTEM":
        return serializeDesignSystem();
      case "AUDIT_DS":
        return auditDs();
      case "CREATE_FRAME":
        return opCreateFrame(params);
      case "CONNECT":
        return opConnect(params);
      case "DISCONNECT":
        return opDisconnect(params);
      case "LIST_CONNECTIONS":
        return opListConnections();
      case "REROUTE":
        return opReroute(params);
      case "VERIFY_CONNECTIONS":
        return opVerifyConnections();
      case "CREATE_INSTANCE":
        return opCreateInstance(params);
      case "SET_VARIANT":
        return opSetVariant(params);
      case "CREATE_VARIABLE":
        return opCreateVariable(params);
      case "BIND_VARIABLE":
        return opBindVariable(params);
      case "SET_AUTOLAYOUT":
        return opSetAutoLayout(params);
      case "SET_CONSTRAINTS":
        return opSetConstraints(params);
      case "SET_TEXT":
        return opSetText(params);
      case "CLONE_TRAITS":
        return opCloneTraits(params);
      // Stage-4 MAJOR7 — `evictedUnresolved` surfaces the edge cache's own eviction count
      // (never a panel UI, just an audit signal `sync-corrections` reports on) so an event
      // dropped here before it was ever synced project-side leaves at least a count, not
      // zero trace.
      case "GET_CORRECTION_MEMORY":
        return { events: readEdgeCorrections(), evictedUnresolved: readEvictedUnresolvedCount() };
      case "SET_CORRECTION_MEMORY": {
        const events = params.events;
        if (!Array.isArray(events)) throw withCode(new Error("SET_CORRECTION_MEMORY requires events[]"), "E_INVALID_ARGS");
        return { events: writeEdgeCorrections(events) };
      }
      case "EXPORT_PNG":
        return opExportPng(params);
      case "EXEC_JS":
        return opExecJs(params);
      case "IMPORT_PAYLOAD":
        return importPayload(params);
      case "IMPORT_GRADIENT":
        return importGradient(params);
      case "BATCH":
        return runBatch(params);
      default:
        throw withCode(new Error(`unknown command: ${cmd}`), "E_INVALID_ARGS");
    }
  }
  async function importPayload(params) {
    const payload = params.payload ?? params;
    if (!payload || typeof payload !== "object" || !payload.rootNode) {
      throw withCode(new Error("IMPORT_PAYLOAD requires params.payload (FigmaExportPayload with rootNode)"), "E_INVALID_ARGS");
    }
    resetImportWarnings();
    resetKeyedVariableCache();
    const tokens = payload.tokens ?? { colors: [], typography: [], spacing: [], radii: [], shadows: [] };
    const colorStyles = await createColorStyles(tokens.colors ?? []);
    await createTextStyles(tokens.typography ?? []);
    await createEffectStyles(tokens.shadows ?? []);
    const tokenVars = await resolveTokenVars(tokens);
    const root = await createFigmaNode(payload.rootNode, colorStyles, tokenVars);
    if (!root) throw new Error("payload rootNode produced no Figma node");
    let replaceTarget = null;
    if (typeof params.replaceId === "string" && params.replaceId) {
      const t = await figma.getNodeByIdAsync(params.replaceId);
      if (t && t.type !== "DOCUMENT" && t.type !== "PAGE") replaceTarget = t;
    }
    let parent = figma.currentPage;
    if (typeof params.parentId === "string" && params.parentId) {
      const p = await figma.getNodeByIdAsync(params.parentId);
      if (p && "appendChild" in p) parent = p;
    }
    parent.appendChild(root);
    if (replaceTarget) {
      root.x = replaceTarget.x;
      root.y = replaceTarget.y;
      replaceTarget.remove();
    } else if (typeof params.x === "number" && typeof params.y === "number") {
      root.x = params.x;
      root.y = params.y;
    } else {
      root.x = Math.round(figma.viewport.center.x - root.width / 2);
      root.y = Math.round(figma.viewport.center.y - root.height / 2);
    }
    try {
      figma.currentPage.selection = [root];
      figma.viewport.scrollAndZoomIntoView([root]);
    } catch {
    }
    figma.notify(`Imported "${payload.name}" (${(tokens.colors ?? []).length} colors, ${(tokens.typography ?? []).length} text styles)`);
    return { id: root.id, name: root.name, warnings: getImportWarnings() };
  }
  async function runBatch(params) {
    const ops = Array.isArray(params) ? params : params.ops;
    if (!Array.isArray(ops)) {
      throw withCode(new Error("BATCH requires params.ops: {cmd, params}[]"), "E_INVALID_ARGS");
    }
    const stopOnError = params.stopOnError === true;
    const results = [];
    for (const op of ops) {
      try {
        results.push({ ok: true, cmd: op.cmd, result: await dispatch(op.cmd, op.params ?? {}) });
        commitIfMutating(op.cmd);
      } catch (err) {
        commitIfMutating(op.cmd);
        results.push({ ok: false, cmd: op.cmd, error: shapeError(err) });
        if (stopOnError) break;
      }
    }
    return { results };
  }
})();
