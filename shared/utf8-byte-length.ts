// The ONE UTF-8 byte counter for code that runs inside the Figma plugin main thread.
//
// Why not `TextEncoder`/`Buffer`: neither exists in that sandbox (probed live). The plugin
// tsconfig's `DOM` lib made `TextEncoder` *compile*, so a call to it looked correct and
// threw at runtime on the very first record — silently disabling a whole feature. The
// DOM-less `plugin/tsconfig.main.json` gate now rejects that class of mistake at compile
// time; this module is the sanctioned replacement so nobody hand-rolls a third copy.
//
// Pure, surrogate-pair aware, no globals. `shared/` because both the plugin main thread
// and any future CLI-side sizing of the same payload must agree byte for byte.

/** UTF-8 byte length of `str`, counting a surrogate pair as one 4-byte code point. */
export function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // surrogate pair — one full UTF-16 "character" is 4 UTF-8 bytes
      i += 1; // consume the low surrogate too
    } else bytes += 3;
  }
  return bytes;
}
