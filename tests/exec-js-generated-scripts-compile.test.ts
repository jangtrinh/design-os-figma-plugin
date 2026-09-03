// The CLI hand-assembles EXEC_JS source for two walks — scan-conventions'
// buildWalkCode and scan-node's buildScanNodeCode — and ships it straight to the
// plugin sandbox. Neither generator is a user-authored script, so today NOTHING
// proves the text it emits actually compiles in the plugin's own eval wrapper, or
// would pass the same preflight lint a hand-written script is held to; a broken
// generator currently only surfaces live, as an `E_EVAL` the user sees mid-walk.
//
// This suite closes that gap by running each generator's REAL output through the
// REAL seam: plugin/src/main/exec-js-normalize.ts's `compile()` (the exact eval
// wrapper executor-exec-js.ts uses) and cli/src/commands/exec-js-preflight.ts's
// `preflightExecJs()` (the exact lint exec-js.ts runs before every dispatch). No
// regex re-implementation, no mock of either seam — only their real exports.
//
// `compile()` only ever PARSES the source into an async function value; it is never
// invoked here, so this stays read-only with respect to a live Figma document — the
// same reason plugin/src/main/exec-js-normalize.ts needs no `figma` global to import.
import { describe, it, expect } from 'vitest';
import { buildWalkCode } from '../cli/src/commands/scan-conventions.ts';
import { buildScanNodeCode } from '../cli/src/commands/scan-node.ts';
import { compile } from '../plugin/src/main/exec-js-normalize.ts';
import { preflightExecJs } from '../cli/src/commands/exec-js-preflight.ts';

describe('generated EXEC_JS scripts compile and pass the real preflight lint', () => {
  it('scan-conventions.buildWalkCode output compiles and lints clean', () => {
    const code = buildWalkCode(['123:456', '789:12'], 500);
    expect(() => compile(code)).not.toThrow();
    expect(() => preflightExecJs(code)).not.toThrow();
  });

  it('scan-node.buildScanNodeCode output compiles and lints clean', () => {
    const code = buildScanNodeCode('123:456');
    expect(() => compile(code)).not.toThrow();
    expect(() => preflightExecJs(code)).not.toThrow();
  });
});
