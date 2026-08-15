# ShaderGradient bake

`figma-agent shader-gradient` bakes one animated 3D gradient field onto a Figma node as an
image fill, and stores the config that produced it so the bake stays re-editable.

This is the Figma half of a capability whose web half lives in the design-os kernel
(`knowledge/shader-gradient-direction.md` there). The two are deliberately different
contracts and neither substitutes for the other — see "Not the same as the web capability".

## The command

```
figma-agent shader-gradient [--node <id|selection>]
    [--preset <slug> | --url "<customize url>" | --set k=v,k2=v2]
    [--w 1200 --h 800 --scale 2] [--static] [--timeout ms] [--list]
```

- `--preset` takes a kebab slug (`nighty-night`) or upstream's own camelCase key
  (`nightyNight`); both resolve to the same field.
- `--url` takes a `shadergradient.co/customize?...` link — the format upstream's own
  customize page emits, so a field designed there transfers without retyping.
- `--set` overrides either, and wins over both.
- `--static` freezes the field instead of capturing it mid-animation.
- `--list` prints the preset roster and makes no canvas change.

Precedence is lowest-to-highest: preset → url → set.

## How it works

```
CLI (validates config)  →  broker  →  plugin UI iframe (WebGL render → PNG bytes)
                                          ↓  IMPORT_GRADIENT
                                      plugin main (createImage → ImagePaint + setPluginData)
```

The config is resolved and fully validated in the CLI before the broker is touched, then
re-validated in the UI. A bad preset name or an out-of-enum value costs a millisecond
locally instead of a round-trip plus a renderer boot ending in an opaque failure.

`IMPORT_GRADIENT` is a mutating command and seals its own undo step, so one ⌘Z removes the
bake and restores the node's previous fills.

## Why not upstream's own plugin design

ShaderGradient ships its own Figma plugin. Its `apps/figma-plugin/src/ui.tsx` loads the
entire renderer UI from `https://shadergradient.co/figma-plugin` inside a nested iframe.

We deliberately do not follow that:

- it makes the feature a **live dependency on a third party's marketing site** — it breaks
  when that page changes, with no version to pin;
- it sends the user's config **off-machine**, which this repo's broker contract does not do.

Instead the render iframe loads **pinned** ESM (`@shadergradient/react` at an exact version)
from esm.sh, declared in the plugin manifest. The renderer is not vendored: bundling
three + React Three Fiber + the renderer would add roughly a megabyte to a UI bundle that is
inlined into the plugin, for a feature most sessions never invoke.

**Why esm.sh specifically, and not a plain per-package CDN bundle.** A per-package ESM
bundle resolves its own copy of React. Loading the renderer and React as separate bundles
leaves the page with two React instances, so the renderer's hooks read from an instance that
never mounted and the first render dies on `Cannot read properties of null (reading
'useState')`. esm.sh's `?deps=` pins the shared dependencies to a single build of each.

`@react-three/fiber` is pinned for a second, independent reason: unpinned, the latest major
(v9) is resolved, which requires React 19 and fails against React 18 with an equally opaque
internal error. The pinned pair is the one upstream develops against.

**The rendered version is not the version in upstream's `package.json`** at the revision the
presets came from — that one was bumped in-repo and never published. See `THIRD-PARTY.md`.

**The trade this makes:** the bake needs network at render time. That is why every failure
path carries its own code (`E_NO_WEBGL`, `E_IFRAME_LOAD`, `E_RENDER_SCRIPT`,
`E_EMPTY_CAPTURE`, `E_TIMEOUT`) rather than collapsing into one generic error — "it failed"
would leave a user unable to tell an offline machine from an unsupported one.

**Nothing vanishes silently:** the bake never falls back to a blank or placeholder image. An
empty fill would land on the canvas looking like a deliberate design choice.

## Verifying it works

Two checks, answering two different questions. Neither substitutes for the other.

**Can this build render at all?** — `node scripts/verify-gradient-render.mjs`

Runs the real `renderGradientToPng` in a headless Chromium, through the actual iframe,
message plumbing, PNG decode, and teardown, and fails on a non-PNG, an implausibly small
(blank) capture, or a leaked iframe. Not a CI gate: it needs the network and a Chromium
build. **Run it whenever the renderer pin, its dependency pins, or the import block change** —
the two defects that made the first release un-renderable both lived inside the generated
document, where no static check could see them.

**Can THIS Figma client bake?** — `figma-agent shader-gradient --self-test`

The script above cannot answer this: Figma's plugin iframe is its own sandbox and is not
reproducible outside the app. The self-test renders a 64x64 throwaway field through the real
path and reports the outcome. It is **read-only** — no node is selected, no fill is written,
nothing is added to the undo stack — which matters, because the only other way to learn
whether an environment can bake is to bake onto somebody's real file and look.

A failure reports rather than throws, and names the stage:

| `code` | Meaning |
|---|---|
| `E_NO_WEBGL` | this client's plugin iframe grants no WebGL context — the bake cannot work here |
| `E_RENDER_SCRIPT` / `E_IFRAME_LOAD` | the renderer could not be fetched — check network access to the pinned CDN |
| `E_EMPTY_CAPTURE` | the renderer loaded but produced no usable frame |

**Do not conflate the first two.** One means the environment is incapable; the other means it
is merely offline.

## A plane may not cover its frame

`plane`-type presets are a rotated flat mesh, so at some aspect ratios they do not reach every
corner and the capture carries transparent regions. Observed with `halo` at 480x300 (it covers
at 560x360). The fill is applied with `scaleMode: 'FILL'`, which scales to cover and crops, so
this is usually invisible — but a very wide or very tall node can still show it. Prefer a
`waterPlane` or `sphere` preset when the field must cover an unusual aspect ratio, or check the
result.

## Not the same as the web capability

A baked field is **a picture of a gradient**, not a gradient. It does not animate, it does
not respond to `prefers-reduced-motion`, and it has no WebGL fallback, because there is no
live renderer on the canvas at all.

That is exactly why the kernel's web capability carries a two-fallback contract this one does
not: on the web the field is live and can fail two different ways. Here it already failed or
already succeeded before a pixel reached Figma. **Do not port the web contract onto this
command, and do not treat a successful bake as evidence the web field is accessible.**

The design-system colour binding from the kernel's direction file **does** still apply in
spirit: a field baked with upstream's own palette makes the largest surface in the frame the
file's colour authority. Pass the design system's colours via `--set color1=…,color2=…,color3=…`.

## Where the preset values live

`shared/shader-gradient-presets.ts` — generated by evaluating upstream's own `presets.ts` at
a pinned revision, attributed in `THIRD-PARTY.md`. **Regenerate it; never hand-edit it.** A
hand-patched number is indistinguishable from a correct one and would silently disagree with
the revision the file claims.

The kernel's ledger carries the same slugs and axes but no values at all — that split is a
ledger rule there, not a licensing constraint.
