// Broker hardening (issue #5), item 3 — locks the bind/connect/probe host agreement
// that avoids the IPv6-vs-IPv4 loopback bug southleft/figma-console-mcp shipped in
// v1.38.2: on a dual-stack macOS box, Node resolves the bare string 'localhost' to
// the IPv6 loopback for some socket calls and IPv4 for others, so a bind and a
// probe built from separately-typed 'localhost' literals can silently land on
// different address families — every "is the broker alive" check then reports a
// healthy broker as dead.
//
// This repo avoids the bug by construction (bind and connect both use explicit
// IPv4/IPv6 literals, never the bare string), but that agreement lives across three
// files as independently-typed string literals with nothing enforcing they stay in
// sync. This is a source-text regression lock: it fails the moment any transport
// file reintroduces a `'localhost'` (or `"localhost"`) string literal for a
// socket/URL call, which is exactly the shape of the fork's regression.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOOPBACK_HOST } from '../shared/protocol.ts';
import { loopbackWsUrl } from '../cli/src/transport/broker-discovery.ts';

const TRANSPORT_DIR = join(import.meta.dirname, '..', 'cli', 'src', 'transport');
const FILES_THAT_TOUCH_LOOPBACK_SOCKETS = [
  'broker-daemon.ts',
  'broker-discovery.ts',
  'broker-client.ts',
];

describe('loopback host agreement — bind and connect never diverge', () => {
  it('LOOPBACK_HOST is the literal IPv4 loopback address, not the ambiguous hostname', () => {
    expect(LOOPBACK_HOST).toBe('127.0.0.1');
  });

  it('loopbackWsUrl (every WS connect/probe call site) is built from LOOPBACK_HOST', () => {
    expect(loopbackWsUrl(9410)).toBe(`ws://${LOOPBACK_HOST}:9410`);
  });

  it.each(FILES_THAT_TOUCH_LOOPBACK_SOCKETS)(
    "%s never constructs a socket/URL from the bare string 'localhost'",
    (file) => {
      const src = readFileSync(join(TRANSPORT_DIR, file), 'utf8');
      // Matches the string literal in either quote style; comments explaining WHY
      // 'localhost' is avoided (as prose, not a literal) don't match this pattern
      // because they never appear inside quotes immediately preceded by punctuation
      // like `://` or a bare quoted word passed to `host:`.
      expect(src).not.toMatch(/['"]localhost['"]/);
    },
  );
});
