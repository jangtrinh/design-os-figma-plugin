# Reusable script helpers — copy at the top of mutation scripts

Generalized helper block encoding the lessons. Parametrize `FILE`, `FONTS`, page names from the project adapter. Wrapper rules per bridge: `use_figma` = top-level await, NO IIFE · figma-agent `exec-js` = `(async () => { … })()` with NO trailing `;`.

```js
// ===== Guard + setup =====
const FILE = '<expected Figma file name>';                    // from adapter
if (figma.root.name !== FILE) throw new Error('WRONG FILE: ' + figma.root.name);

const FONTS = [/* from adapter, e.g. */ { family: 'Inter', style: 'Regular' }, { family: 'Inter', style: 'Semi Bold' }];
for (const f of FONTS) await figma.loadFontAsync(f);          // fail loud — no try-catch

const page = figma.root.children.find(p => p.name === '<target page>');
await figma.setCurrentPageAsync(page);                        // resets every call — always re-set

// ===== Variable + style lookups (fail-loud) =====
const cols = await figma.variables.getLocalVariableCollectionsAsync();
const vars = {};
for (const col of cols) for (const id of col.variableIds) {
  const v = await figma.variables.getVariableByIdAsync(id); if (v) vars[v.name] = v;
}
const styleByName = Object.fromEntries((await figma.getLocalTextStylesAsync()).map(t => [t.name, t]));
const effectByName = Object.fromEntries((await figma.getLocalEffectStylesAsync()).map(e => [e.name, e]));

const errors = [];                                            // collect — never swallow

function hex(h) { const m = h.replace('#',''); return { r: parseInt(m.slice(0,2),16)/255, g: parseInt(m.slice(2,4),16)/255, b: parseInt(m.slice(4,6),16)/255 }; }

// Fail-loud bound paint: asserts the variable exists BEFORE, and the bind AFTER (undefined var = silent skip otherwise)
function boundFill(varName, fallbackHex) {
  const v = vars[varName];
  if (!v) throw new Error('variable not found: ' + varName);
  const p = figma.variables.setBoundVariableForPaint({ type:'SOLID', color: hex(fallbackHex), opacity: 1 }, 'color', v);
  if (!p.boundVariables || !p.boundVariables.color) throw new Error('bind failed: ' + varName);
  return p;
}

async function applyTS(node, styleName) {                     // sync setter silently no-ops — async only
  const s = styleByName[styleName]; if (!s) throw new Error('text style not found: ' + styleName);
  await node.setTextStyleIdAsync(s.id);
}
async function applyEffect(node, styleName) {
  const s = effectByName[styleName]; if (!s) throw new Error('effect style not found: ' + styleName);
  await node.setEffectStyleIdAsync(s.id);
}

// ===== Props: keys carry '#nodeId' suffix — prefix-match, fail-loud =====
function setProps(inst, kv) {
  const props = inst.componentProperties || {};
  for (const [name, value] of Object.entries(kv)) {
    const key = Object.keys(props).find(k => k.split('#')[0] === name);
    if (!key) { errors.push('prop not found: ' + name + ' on ' + inst.name); continue; }
    inst.setProperties({ [key]: value });
  }
}

// ===== Stroke-only icon recolor (stroke-based icon sets; NEVER set fills) =====
function recolorStroke(iconInst, varName, fallbackHex) {
  for (const vec of iconInst.findAll(n => n.type === 'VECTOR')) vec.strokes = [boundFill(varName, fallbackHex)];
}

// ===== Text override (font first) =====
async function overrideText(node, s) { await figma.loadFontAsync(node.fontName); node.characters = s; }

// ===== Idempotency tag — every created node =====
const RUN_ID = '<yymmdd-hhmm>-<slug>';
function tag(node, key) { node.setSharedPluginData('<ns>', 'run_id', RUN_ID); node.setSharedPluginData('<ns>', 'key', key); }

// ===== Stuck-prop preflight before addComponentProperty batches =====
function cleanStuckProps(set, prefixes) {
  for (const key of Object.keys(set.componentPropertyDefinitions || {}))
    if (prefixes.some(p => key.startsWith(p))) { try { set.deleteComponentProperty(key); } catch (e) {} }
}

// ===== SAFE WRAPPERS — make the top runtime-error classes impossible =====
// Harvested from the plugin error log; use these INSTEAD of the raw API.

// combineAsVariants throws "Grouped nodes must be in the same page as the parent"
// → appendChild every variant into the container FIRST, then combine.
function combineVariantsSafe(variants, container) {
  for (const v of variants) container.appendChild(v);
  const set = figma.combineAsVariants(variants, container);
  return set;   // still verify child count + names in a FRESH call (Class B)
}

// set fontName throws "Cannot use unloaded font" → always load first.
async function setFont(node, family, style) {
  await figma.loadFontAsync({ family, style });
  node.fontName = { family, style };
}

// layoutSizing FILL throws "can only be set on children of auto-layout frames"
// → assert placement BEFORE setting; enforces the reparent→resize→sizing order.
function sizing(node, { h, v }) {
  const p = node.parent;
  const inAuto = p && 'layoutMode' in p && p.layoutMode !== 'NONE';
  if ((h === 'FILL' || v === 'FILL') && !inAuto)
    throw new Error(`sizing FILL on "${node.name}": parent "${p && p.name}" is not auto-layout — reparent FIRST`);
  if (h) node.layoutSizingHorizontal = h;
  if (v) node.layoutSizingVertical = v;
}

// #1 error family in the harvest (21 hits): sync APIs under documentAccess: dynamic-page.
// NEVER call: figma.getNodeById · node.mainComponent · figma.getLocalTextStyles/PaintStyles ·
// figma.currentPage= · node.textStyleId= — always the Async variants (see pre-dispatch lint).
async function getNode(id) {
  const n = await figma.getNodeByIdAsync(id);
  if (!n) throw new Error('node not found (stale id?): ' + id + ' — re-locate by name/tag');
  return n;
}

// #2 family (~20 hits): null-deref on find results ("cannot read property of null").
// Never chain off a bare findOne — name the target so the failure names itself.
function mustFind(scope, pred, label) {
  const n = scope.findOne(pred);
  if (!n) throw new Error('mustFind failed: ' + label + ' in ' + (scope.name || scope.type));
  return n;
}

// Structural ops inside an INSTANCE throw/rollback (insertChild/remove/appendChild).
function assertNotInInstance(node, op) {
  for (let p = node.parent; p; p = p.parent)
    if (p.type === 'INSTANCE') throw new Error(op + ' on "' + node.name + '": inside instance "' + p.name + '" — use visible=false / variant swap / wrapper frame');
}

// ... work ...
// return STRUCTURED data — the agent sees only what you return:
// return { created: [...ids], counts: {...}, errors };
```

## Guards that make a false green impossible

Each wrapper below exists because the plain form returned a confident wrong answer on a real
run. Prose telling you to remember these already existed; the errors kept firing, so they are
functions now.

```js
// Visibility is the ANCESTOR CHAIN, not the node. A node can be visible:true inside a hidden
// parent and render nowhere — a check reading only the node reports text no human can see.
function effectivelyVisible(node) {
  for (let n = node; n && n.type !== 'PAGE'; n = n.parent) if (n.visible === false) return false;
  return true;
}

// Counts must be measured NOW. Evidence from before the mutation, or truncated by a scan
// budget, describes a canvas that no longer exists. Refuse rather than assert on a stale number.
function assertCount(nodes, expected, what) {
  const live = nodes.length;
  if (expected == null) throw new Error(`REFUSE: no measured count for ${what}`);
  if (live !== expected) throw new Error(`count mismatch for ${what}: expected ${expected}, canvas has ${live}`);
  return live;
}

// Deletion has no typed command, so it runs through exec-js — the most destructive operation
// on the least-guarded path. Removing a master breaks every instance in the file, including
// ones outside your scope.
function safeRemove(ids) {
  const targets = ids.map(id => figma.getNodeById(id));
  if (targets.some(n => !n)) throw new Error('REFUSE: some ids no longer exist — re-scan first');
  const master = targets.find(n => n.type === 'COMPONENT' || n.type === 'COMPONENT_SET');
  if (master) throw new Error(`REFUSE: ${master.name} is a master; removing it breaks every instance`);
  targets.forEach(n => n.remove());
  return { deleted: targets.length };
}

// Blast radius BEFORE the edit. In a componentised file nearly every node sits inside SOME
// instance, so that fact alone is noise. What separates local from shared is how often the
// same componentId recurs across the set you are touching.
function masterFrequency(nodes) {
  const uses = new Map();
  for (const n of nodes) {
    const id = n.type === 'INSTANCE' ? n.componentId : null;
    if (id) uses.set(id, (uses.get(id) || 0) + 1);
  }
  return uses;   // a componentId hit more than once needs owner approval before editing it
}
```

Always run mutations with `--undo-group` so a task collapses to one undo step and reverts on
error, and never pass `--no-lint` to save a round trip — the preflight is the only check that
runs before your code touches the document.

## Ordering laws baked into usage

1. `appendChild`/reparent FIRST → `resize()` → `layoutSizing*` LAST (earlier sets are silently swallowed/reverted).
2. Nested variant BEFORE its text (`setProperties({Tone})` can reset text overrides).
3. `characters =` BEFORE range formatting (`setRangeFills`/`setRangeFontName` — characters reset ranges).
4. After `swapComponent` on an icon slot: `slot.visible = true` (fresh instances often default hidden), then recolor strokes if on a colored background.
5. New top-level node: position explicitly next to a named anchor; never leave at (0,0).
