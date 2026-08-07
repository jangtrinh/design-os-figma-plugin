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

// ... work ...
// return STRUCTURED data — the agent sees only what you return:
// return { created: [...ids], counts: {...}, errors };
```

## Ordering laws baked into usage

1. `appendChild`/reparent FIRST → `resize()` → `layoutSizing*` LAST (earlier sets are silently swallowed/reverted).
2. Nested variant BEFORE its text (`setProperties({Tone})` can reset text overrides).
3. `characters =` BEFORE range formatting (`setRangeFills`/`setRangeFontName` — characters reset ranges).
4. After `swapComponent` on an icon slot: `slot.visible = true` (fresh instances often default hidden), then recolor strokes if on a colored background.
5. New top-level node: position explicitly next to a named anchor; never leave at (0,0).
