// P4 multi-plugin registry — the pure core of the fix for the two-files-evict-each-
// other bug. Covers add/update/remove/cull, the most-recent-active routing choice,
// the FIGMA_AGENT_FILE substring filter, the park→flush decision, and the status
// list shape. Fake sockets are just `{ readyState }`; a mutable clock drives recency.
import { describe, it, expect } from 'vitest';
import {
  FROZEN_AFTER_MS, PluginRegistry, WS_OPEN, appReadiness, extractScene, suspectedZombie, type RegistrySocket,
} from '../cli/src/transport/plugin-registry.ts';
import { PLUGIN_PONG_TIMEOUT_MS } from '../shared/protocol.ts';

const CLOSED = 3; // WebSocket.CLOSED
const sock = (open = true): RegistrySocket => ({ readyState: open ? WS_OPEN : CLOSED });

/** A registry with a hand-driven clock so lastSeenAt ordering is deterministic. */
function makeReg() {
  let t = 1_000;
  const reg = new PluginRegistry<RegistrySocket>(() => t);
  return { reg, tick: (ms = 1) => { t += ms; return t; }, at: () => t };
}

describe('register — one slot per instance, NEVER evict another instance', () => {
  it('two distinct instanceIds keep two slots (the whole bug fix)', () => {
    const { reg } = makeReg();
    reg.register(sock(), { instanceId: 'a', fileName: 'VSF - PCP' });
    reg.register(sock(), { instanceId: 'b', fileName: 'Design system' });
    expect(reg.size()).toBe(2);
    expect(reg.statusList().map((p) => p.fileName).sort()).toEqual(['Design system', 'VSF - PCP']);
  });

  it('same instanceId re-hello REPLACES its own slot, preserves connectedAt, supersedes the old socket', () => {
    const { reg, tick, at } = makeReg();
    const first = at();
    const wsA = sock();
    const r1 = reg.register(wsA, { instanceId: 'a', fileName: 'F' });
    expect(r1).toMatchObject({ instanceId: 'a', replaced: false, superseded: null });

    tick(50);
    const wsA2 = sock(); // reconnect: same instance, new socket
    const r2 = reg.register(wsA2, { instanceId: 'a', fileName: 'F' });
    expect(r2.replaced).toBe(true);
    expect(r2.superseded).toBe(wsA); // daemon closes the stale socket
    expect(reg.size()).toBe(1); // still ONE slot
    expect(reg.getByWs(wsA2)?.connectedAt).toBe(first); // connectedAt survives the reconnect
  });

  it('same socket re-hello updates in place (no supersede)', () => {
    const { reg } = makeReg();
    const ws = sock();
    reg.register(ws, { instanceId: 'a', fileName: 'F', page: 'One' });
    const r = reg.register(ws, { instanceId: 'a', fileName: 'F', page: 'Two' });
    expect(r).toMatchObject({ replaced: true, superseded: null });
    expect(reg.getByWs(ws)?.scene.page).toBe('Two');
  });

  it('legacy plugin without instanceId → minted id, same socket reuses it', () => {
    const { reg } = makeReg();
    const ws = sock();
    const r1 = reg.register(ws, { fileName: 'Legacy' });
    expect(r1.instanceId).toMatch(/^p_/); // minted
    const r2 = reg.register(ws, { fileName: 'Legacy', page: 'P2' });
    expect(r2.instanceId).toBe(r1.instanceId); // same socket → same minted id
    expect(r2.replaced).toBe(true);
    expect(reg.size()).toBe(1);
  });
});

describe('updateScene / touch', () => {
  it('updateScene merges a FILE_INFO page change and bumps liveness', () => {
    const { reg, tick } = makeReg();
    const ws = sock();
    reg.register(ws, { instanceId: 'a', fileName: 'F', page: 'One' });
    const later = tick(10);
    expect(reg.updateScene(ws, { fileName: 'F', page: 'Two' })).toBe(true);
    const e = reg.getByWs(ws);
    expect(e?.scene).toMatchObject({ fileName: 'F', page: 'Two' });
    expect(e?.lastSeenAt).toBe(later);
  });
  it('touch returns false for an unknown (CLI) socket and true for a plugin', () => {
    const { reg } = makeReg();
    const plugin = sock();
    reg.register(plugin, { instanceId: 'a', fileName: 'F' });
    expect(reg.touch(plugin)).toBe(true);
    expect(reg.touch(sock())).toBe(false); // never registered
  });
});

describe('removeByWs / cullClosed — each dead socket drops only ITS entry', () => {
  it('removeByWs removes just that entry and returns its id', () => {
    const { reg } = makeReg();
    const a = sock();
    const b = sock();
    reg.register(a, { instanceId: 'a', fileName: 'A' });
    reg.register(b, { instanceId: 'b', fileName: 'B' });
    expect(reg.removeByWs(a)).toBe('a');
    expect(reg.size()).toBe(1);
    expect(reg.removeByWs(a)).toBeNull(); // already gone
    expect(reg.getByWs(b)?.instanceId).toBe('b');
  });

  it('cullClosed removes only sockets that are no longer OPEN', () => {
    const { reg } = makeReg();
    const a = sock();
    const b = sock();
    reg.register(a, { instanceId: 'a', fileName: 'A' });
    reg.register(b, { instanceId: 'b', fileName: 'B' });
    b.readyState = CLOSED; // b's socket died
    expect(reg.cullClosed()).toEqual(['b']);
    expect(reg.size()).toBe(1);
    expect(reg.getByWs(a)?.instanceId).toBe('a');
  });
});

describe('selectTarget — most-recently-active wins; closed sockets ignored', () => {
  it('picks the file with the newest lastActiveAt (the file touched last)', () => {
    const { reg, tick } = makeReg();
    const a = sock();
    const b = sock();
    reg.register(a, { instanceId: 'a', fileName: 'A' });
    reg.register(b, { instanceId: 'b', fileName: 'B' });
    tick(5);
    reg.touchActive(a); // A saw real interaction — now the routing target
    expect(reg.selectTarget()?.instanceId).toBe('a');
    tick(5);
    reg.touchActive(b); // now B
    expect(reg.selectTarget()?.instanceId).toBe('b');
  });

  it('heartbeat touch() does NOT steal the routing target (only real interaction does)', () => {
    const { reg, tick } = makeReg();
    const a = sock();
    const b = sock();
    reg.register(a, { instanceId: 'a', fileName: 'A' });
    reg.register(b, { instanceId: 'b', fileName: 'B' });
    tick(5);
    reg.touchActive(a); // user touched A
    tick(5);
    reg.touch(b); // B only heartbeat-PONGed — liveness bumps, routing must NOT flip
    expect(reg.selectTarget()?.instanceId).toBe('a');
    tick(5);
    reg.updateScene(b, { page: 'Page 2' }); // FILE_INFO = real interaction → now B
    expect(reg.selectTarget()?.instanceId).toBe('b');
  });

  it('never returns a closed socket', () => {
    const { reg, tick } = makeReg();
    const a = sock();
    const b = sock();
    reg.register(a, { instanceId: 'a', fileName: 'A' });
    tick(5);
    reg.register(b, { instanceId: 'b', fileName: 'B' }); // b newer
    b.readyState = CLOSED; // …but dead
    expect(reg.selectTarget()?.instanceId).toBe('a'); // falls to the live one
  });

  it('empty registry → null', () => {
    expect(makeReg().reg.selectTarget()).toBeNull();
  });
});

describe('selectTarget(filter) — FIGMA_AGENT_FILE substring match', () => {
  const seed = () => {
    const { reg, tick } = makeReg();
    reg.register(sock(), { instanceId: 'a', fileName: 'VSF - PCP' });
    tick(5);
    reg.register(sock(), { instanceId: 'b', fileName: 'Design system' });
    return reg;
  };
  it('matches case-insensitively on a substring', () => {
    expect(seed().selectTarget('vsf')?.instanceId).toBe('a');
    expect(seed().selectTarget('DESIGN')?.instanceId).toBe('b');
  });
  it('no candidate matches → null (drives the park / no-match error)', () => {
    expect(seed().selectTarget('nope')).toBeNull();
  });
  it('among multiple matches, still the most-recent', () => {
    const { reg, tick } = makeReg();
    reg.register(sock(), { instanceId: 'a', fileName: 'Shop web' });
    tick(5);
    reg.register(sock(), { instanceId: 'b', fileName: 'Shop mobile' });
    expect(reg.selectTarget('shop')?.instanceId).toBe('b'); // newest of the two matches
  });
  it('a blank/whitespace filter is treated as no filter', () => {
    expect(seed().selectTarget('   ')).not.toBeNull();
  });
});

describe('matching(filter, {exact}) — exact mode + the ambiguity input', () => {
  it('selectTarget(filter) unchanged: substring + most-recently-active', () => {
    const { reg, tick } = makeReg();
    reg.register(sock(), { instanceId: 'a', fileName: 'Design System' });
    tick(5);
    reg.register(sock(), { instanceId: 'b', fileName: 'Design' });
    expect(reg.selectTarget('design')?.instanceId).toBe('b'); // most-recently-active of the substring matches
  });

  it('selectTarget(filter, {exact:true}) → only the exact-named one', () => {
    const { reg, tick } = makeReg();
    reg.register(sock(), { instanceId: 'a', fileName: 'Design System' });
    tick(5);
    reg.register(sock(), { instanceId: 'b', fileName: 'Design' });
    expect(reg.selectTarget('design', { exact: true })?.instanceId).toBe('b');
    expect(reg.selectTarget('Design System', { exact: true })?.instanceId).toBe('a');
  });

  it('matching(filter, {exact:true}).length === 2 for a duplicate-named pair — the ambiguity input', () => {
    const { reg, tick } = makeReg();
    reg.register(sock(), { instanceId: 'a', fileName: 'Design' });
    tick(5);
    reg.register(sock(), { instanceId: 'b', fileName: 'Design' });
    reg.register(sock(), { instanceId: 'c', fileName: 'Design System' });
    const hits = reg.matching('Design', { exact: true });
    expect(hits.length).toBe(2);
    expect(hits.map((h) => h.instanceId).sort()).toEqual(['a', 'b']);
  });

  it('a filter matching nothing → [] / null (the park path)', () => {
    const { reg } = makeReg();
    reg.register(sock(), { instanceId: 'a', fileName: 'Design' });
    expect(reg.matching('nope', { exact: true })).toEqual([]);
    expect(reg.selectTarget('nope', { exact: true })).toBeNull();
  });
});

describe('matching/selectTarget(filter, {kind:"instance"}) — instanceId targeting', () => {
  it('a known live instanceId → the single matching entry, never a name-fuzzy list', () => {
    const { reg, tick } = makeReg();
    reg.register(sock(), { instanceId: 'p_1_100', fileName: 'Design' });
    tick(5);
    reg.register(sock(), { instanceId: 'p_2_100', fileName: 'Design' }); // duplicate name on purpose
    const hits = reg.matching('p_1_100', { kind: 'instance' });
    expect(hits.map((h) => h.instanceId)).toEqual(['p_1_100']); // exact instance, not the other same-named one
    expect(reg.selectTarget('p_1_100', { kind: 'instance' })?.instanceId).toBe('p_1_100');
  });

  it('an unknown instanceId → [] / null, never falls back to a name match', () => {
    const { reg } = makeReg();
    reg.register(sock(), { instanceId: 'p_1_100', fileName: 'Design' });
    expect(reg.matching('nope', { kind: 'instance' })).toEqual([]);
    expect(reg.selectTarget('nope', { kind: 'instance' })).toBeNull();
  });

  it('a DISCONNECTED (closed-socket) instanceId → [] / null, not the stale entry', () => {
    const { reg } = makeReg();
    const ws = sock(false);
    reg.register(ws, { instanceId: 'p_1_100', fileName: 'Design' });
    ws.readyState = CLOSED;
    expect(reg.matching('p_1_100', { kind: 'instance' })).toEqual([]);
    expect(reg.selectTarget('p_1_100', { kind: 'instance' })).toBeNull();
  });

  it('kind:"instance" with two live entries sharing a fileName still isolates by id only', () => {
    const { reg } = makeReg();
    reg.register(sock(), { instanceId: 'a', fileName: 'Untitled' });
    reg.register(sock(), { instanceId: 'b', fileName: 'Untitled' });
    expect(reg.matching('a', { kind: 'instance' }).map((h) => h.instanceId)).toEqual(['a']);
    expect(reg.matching('b', { kind: 'instance' }).map((h) => h.instanceId)).toEqual(['b']);
  });

  it('a blank instanceId filter with kind:"instance" → [] (never "unfiltered = everything")', () => {
    const { reg } = makeReg();
    reg.register(sock(), { instanceId: 'a', fileName: 'Design' });
    expect(reg.matching('   ', { kind: 'instance' })).toEqual([]);
  });
});

describe('selectTarget — suspected-zombie deprioritization (no-filter recency path only)', () => {
  /** Re-HELLOs the same instance on an unchanged scene enough times to trip the
   *  throttled-flapper branch of `suspectedZombie` — each re-HELLO also bumps
   *  `lastActiveAt`, so a flapping zombie can end up MORE recent than a healthy
   *  plugin that has not touched anything in a while. Ticks stay well under
   *  FROZEN_AFTER_MS so an untouched healthy fixture in the same test never
   *  drifts into the OTHER (frozen) zombie branch purely from elapsed time. */
  function flapToZombie(reg: ReturnType<typeof makeReg>['reg'], tick: (ms?: number) => number, instanceId: string, fileName: string) {
    let ws = sock();
    reg.register(ws, { instanceId, fileName });
    for (let i = 0; i < 3; i++) {
      tick(2_000); // within the streak-locality window, well outside a single tick
      ws = sock();
      reg.register(ws, { instanceId, fileName });
    }
    return ws;
  }

  it('a no-flag selectTarget prefers the HEALTHY plugin even though the zombie re-HELLO\'d more recently', () => {
    const { reg, tick } = makeReg();
    reg.register(sock(), { instanceId: 'h', fileName: 'Healthy' });
    tick(5);
    const healthy = reg.getByInstanceId('h')!;
    const zombieWs = flapToZombie(reg, tick, 'z', 'Zombie');
    const zombie = reg.getByWs(zombieWs)!;
    expect(zombie.sameSceneStreak).toBe(3); // confirms it IS suspected
    expect(zombie.lastActiveAt).toBeGreaterThan(healthy.lastActiveAt); // sanity: recency alone would pick the zombie
    expect(reg.selectTarget()?.instanceId).toBe('h'); // healthy wins despite lower recency
  });

  it('explicit --instance and exact --file targeting still reach a suspected zombie', () => {
    const { reg, tick } = makeReg();
    reg.register(sock(), { instanceId: 'h', fileName: 'Healthy' });
    tick(5);
    flapToZombie(reg, tick, 'z', 'Zombie');
    expect(reg.selectTarget('z', { kind: 'instance' })?.instanceId).toBe('z');
    expect(reg.selectTarget('Zombie', { exact: true })?.instanceId).toBe('z');
  });

  it('all live entries suspected → most-recent among them, no refusal', () => {
    const { reg, tick } = makeReg();
    flapToZombie(reg, tick, 'z1', 'Z1');
    tick(2_000);
    flapToZombie(reg, tick, 'z2', 'Z2');
    expect(reg.selectTarget()?.instanceId).toBe('z2'); // more-recently-flapped zombie, not a null refusal
  });

  it('with no suspected zombies, selectTarget stays pure recency (unchanged behavior)', () => {
    const { reg, tick } = makeReg();
    reg.register(sock(), { instanceId: 'a', fileName: 'A' });
    tick(5);
    reg.register(sock(), { instanceId: 'b', fileName: 'B' });
    expect(reg.selectTarget()?.instanceId).toBe('b');
  });
});

describe('park → flush decision (what the daemon keys off)', () => {
  it('filter set + only a NON-matching file → no target (park); matching file appears → target (flush)', () => {
    const { reg, tick } = makeReg();
    reg.register(sock(), { instanceId: 'ds', fileName: 'Design system' });
    expect(reg.selectTarget('VSF')).toBeNull(); // request parks — no matching plugin yet
    tick(5);
    reg.register(sock(), { instanceId: 'vsf', fileName: 'VSF - PCP' });
    expect(reg.selectTarget('VSF')?.instanceId).toBe('vsf'); // now flushes to the match
  });
});

describe('statusList — the per-file rows, most-recent first', () => {
  it('emits one live row per file with the documented fields', () => {
    const { reg, tick, at } = makeReg();
    const aConnectedAt = at();
    reg.register(sock(), { instanceId: 'a', fileName: 'A', page: 'P1' });
    const bConnectedAt = tick(20);
    reg.register(sock(), { instanceId: 'b', fileName: 'B', page: 'P2' });
    const list = reg.statusList();
    expect(list[0]).toEqual({
      instanceId: 'b', fileName: 'B', page: 'P2', state: 'connected',
      lastHeartbeatAge: 0, // b was just registered at `now`
      connectedAt: bConnectedAt,
      fileKey: null, // absent from the HELLO payload here — registry-integrity phase 01 §2
      appSilenceMs: 0, // b's HELLO IS an app frame — zombie-watchdog sensor, always present
      appReady: true,
      appState: 'ready',
      appHeartbeatMode: 'legacy',
      appReadinessAge: 0,
    });
    expect(list[1]).toMatchObject({ instanceId: 'a', fileName: 'A', page: 'P1', connectedAt: aConnectedAt });
    expect(list[1].lastHeartbeatAge).toBe(20); // a last seen 20ms ago
  });

  it('carries fileKey from the HELLO scene (registry-integrity phase 01 §2 — bind needs it)', () => {
    const { reg } = makeReg();
    reg.register(sock(), { instanceId: 'a', fileName: 'VSF - PCP', fileKey: 'abc123' });
    reg.register(sock(), { instanceId: 'b', fileName: 'No Key Plugin' }); // non-org plugin
    const list = reg.statusList();
    expect(list.find((p) => p.instanceId === 'a')?.fileKey).toBe('abc123');
    expect(list.find((p) => p.instanceId === 'b')?.fileKey).toBeNull();
  });

  it('lastHeartbeatAge = now − lastSeenAt; sorted newest-first; excludes closed', () => {
    const { reg, tick } = makeReg();
    const a = sock();
    const b = sock();
    reg.register(a, { instanceId: 'a', fileName: 'A' });
    tick(30);
    reg.register(b, { instanceId: 'b', fileName: 'B' });
    tick(10); // now is 10ms after b's register, 40ms after a's
    const list = reg.statusList();
    expect(list.map((p) => p.instanceId)).toEqual(['b', 'a']); // newest first
    expect(list[0].lastHeartbeatAge).toBe(10);
    expect(list[1].lastHeartbeatAge).toBe(40);
    a.readyState = CLOSED;
    expect(reg.statusList().map((p) => p.instanceId)).toEqual(['b']); // closed excluded
  });
});

describe('getByInstanceId — pinned-target resolution (concurrency & jobs)', () => {
  it('resolves a live instance by id, regardless of routing recency/filter', () => {
    const { reg } = makeReg();
    const { instanceId } = reg.register(sock(), { instanceId: 'p1', fileName: 'A' });
    expect(reg.getByInstanceId(instanceId)?.scene.fileName).toBe('A');
  });

  it('returns null for an instance that never existed', () => {
    const { reg } = makeReg();
    expect(reg.getByInstanceId('nope')).toBeNull();
  });

  it('still finds a CLOSED socket\'s entry (the caller checks readyState itself)', () => {
    const { reg } = makeReg();
    const closed = sock(false);
    reg.register(closed, { instanceId: 'p1', fileName: 'A' });
    const found = reg.getByInstanceId('p1');
    expect(found).not.toBeNull();
    expect(found?.ws.readyState).toBe(CLOSED);
  });

  it('removeByWs makes the instance unresolvable', () => {
    const { reg } = makeReg();
    const ws = sock();
    reg.register(ws, { instanceId: 'p1', fileName: 'A' });
    reg.removeByWs(ws);
    expect(reg.getByInstanceId('p1')).toBeNull();
  });
});

describe('zombie-watchdog — transport vs app liveness split', () => {
  it('THE load-bearing test: a transport pong (touch) does NOT clear the frozen flag; only touchApp does', () => {
    const { reg, tick, at } = makeReg();
    const ws = sock();
    reg.register(ws, { instanceId: 'a', fileName: 'F' });
    tick(FROZEN_AFTER_MS + 1_000); // JS has gone silent long past the frozen threshold
    expect(suspectedZombie(reg.getByWs(ws)!, at())).toBe(true);

    reg.touch(ws); // a raw WS pong — Chromium auto-answers this even while frozen
    expect(suspectedZombie(reg.getByWs(ws)!, at())).toBe(true); // still flagged — pong proves nothing

    reg.touchApp(ws); // a real JS-originated frame
    expect(suspectedZombie(reg.getByWs(ws)!, at())).toBe(false); // NOW it clears
  });

  it('suspectedZombie — FROZEN_AFTER_MS boundary: exactly at threshold not flagged, one ms over is', () => {
    const { reg, tick, at } = makeReg();
    const ws = sock();
    reg.register(ws, { instanceId: 'a', fileName: 'F' });
    tick(FROZEN_AFTER_MS);
    expect(suspectedZombie(reg.getByWs(ws)!, at())).toBe(false); // == threshold, not over it
    tick(1);
    expect(suspectedZombie(reg.getByWs(ws)!, at())).toBe(true);
  });
});

describe('application readiness lease', () => {
  it('native pong never renews readiness; a JS frame does, including the exact deadline boundary', () => {
    const { reg, tick, at } = makeReg();
    const ws = sock();
    reg.register(ws, {
      instanceId: 'modern', fileName: 'Modern', caps: ['fileGuard', 'correlatedHeartbeatV1', 'appProbeV1'],
    });

    tick(PLUGIN_PONG_TIMEOUT_MS);
    expect(appReadiness(reg.getByWs(ws)!, at())).toMatchObject({
      appReady: true, appState: 'ready', appHeartbeatMode: 'correlated', appReadinessAge: PLUGIN_PONG_TIMEOUT_MS,
    });
    tick(1);
    expect(appReadiness(reg.getByWs(ws)!, at()).appReady).toBe(false);
    reg.touch(ws);
    expect(appReadiness(reg.getByWs(ws)!, at()).appReady).toBe(false);
    reg.touchApp(ws);
    expect(appReadiness(reg.getByWs(ws)!, at())).toMatchObject({ appReady: true, appState: 'ready', appReadinessAge: 0 });
  });

  it('distinguishes absent legacy capability from an incomplete/unsupported readiness advertisement', () => {
    const { reg, at } = makeReg();
    const legacy = sock();
    const unsupported = sock();
    reg.register(legacy, { instanceId: 'legacy', fileName: 'Legacy', caps: ['fileGuard'] });
    reg.register(unsupported, { instanceId: 'unsupported', fileName: 'Unsupported', caps: ['fileGuard', 'correlatedHeartbeatV1'] });

    expect(appReadiness(reg.getByWs(legacy)!, at())).toMatchObject({ appReady: true, appHeartbeatMode: 'legacy' });
    expect(appReadiness(reg.getByWs(unsupported)!, at())).toMatchObject({
      appReady: null, appState: 'unknown', appHeartbeatMode: 'unknown', appReadinessAge: 0,
    });
  });

  it('keeps explicit identity exact while unfiltered dispatch prefers ready and refuses an all-unready set', () => {
    const { reg, tick } = makeReg();
    const ready = sock();
    const stale = sock();
    reg.register(ready, { instanceId: 'ready', fileName: 'Ready', caps: ['fileGuard'] });
    tick(PLUGIN_PONG_TIMEOUT_MS + 1);
    reg.register(stale, { instanceId: 'stale', fileName: 'Stale', caps: ['fileGuard'] });
    reg.touchApp(ready);
    tick(PLUGIN_PONG_TIMEOUT_MS + 1);
    reg.touchApp(ready);

    expect(reg.selectTarget('Stale', { exact: true })?.instanceId).toBe('stale');
    expect(reg.selectReadyTarget()?.instanceId).toBe('ready');
    tick(PLUGIN_PONG_TIMEOUT_MS + 1);
    expect(reg.selectReadyTarget()).toBeNull();
  });
});

describe('zombie-watchdog — same-scene reconnect (throttled flapper) streak', () => {
  it('3 same-scene reconnects within the window flag; a scene-changing updateScene resets it', () => {
    const { reg, tick } = makeReg();
    let ws = sock();
    reg.register(ws, { instanceId: 'a', fileName: 'F', page: 'P1' });
    tick(1_000);
    ws = sock();
    reg.register(ws, { instanceId: 'a', fileName: 'F', page: 'P1' }); // reconnect 1 — same scene
    expect(reg.getByWs(ws)!.sameSceneStreak).toBe(1);
    tick(1_000);
    ws = sock();
    reg.register(ws, { instanceId: 'a', fileName: 'F', page: 'P1' }); // reconnect 2 — same scene, within window
    expect(reg.getByWs(ws)!.sameSceneStreak).toBe(2);
    expect(reg.statusList()[0].suspectedZombie).toBeUndefined(); // not yet at the threshold
    tick(1_000);
    ws = sock();
    reg.register(ws, { instanceId: 'a', fileName: 'F', page: 'P1' }); // reconnect 3 — flags
    expect(reg.getByWs(ws)!.sameSceneStreak).toBe(3);
    expect(reg.statusList()[0].suspectedZombie).toBe(true);

    reg.updateScene(ws, { page: 'P2' }); // scene actually CHANGED — proves this wasn't flapping
    expect(reg.getByWs(ws)!.sameSceneStreak).toBe(0);
    expect(reg.statusList()[0].suspectedZombie).toBeUndefined();
  });

  it('touchActive (real interaction) resets the streak the same way', () => {
    const { reg, tick } = makeReg();
    let ws = sock();
    reg.register(ws, { instanceId: 'a', fileName: 'F' });
    for (let i = 0; i < 2; i++) {
      tick(1_000);
      ws = sock();
      reg.register(ws, { instanceId: 'a', fileName: 'F' });
    }
    expect(reg.getByWs(ws)!.sameSceneStreak).toBe(2);
    reg.touchActive(ws);
    expect(reg.getByWs(ws)!.sameSceneStreak).toBe(0);
  });

  it('re-sending the identical scene on updateScene does NOT reset the streak (no change = no proof)', () => {
    const { reg, tick } = makeReg();
    let ws = sock();
    reg.register(ws, { instanceId: 'a', fileName: 'F', page: 'P1' });
    for (let i = 0; i < 2; i++) {
      tick(1_000);
      ws = sock();
      reg.register(ws, { instanceId: 'a', fileName: 'F', page: 'P1' });
    }
    expect(reg.getByWs(ws)!.sameSceneStreak).toBe(2);
    reg.updateScene(ws, { page: 'P1' }); // identical — nothing actually changed
    expect(reg.getByWs(ws)!.sameSceneStreak).toBe(2); // unchanged
  });

  it('daily-cadence re-HELLOs (>10 min apart) never accumulate toward the threshold', () => {
    const { reg, tick } = makeReg();
    let ws = sock();
    reg.register(ws, { instanceId: 'a', fileName: 'F' });
    for (let i = 0; i < 4; i++) {
      tick(11 * 60_000); // 11 minutes — always outside the 10-minute streak-locality window
      ws = sock();
      reg.register(ws, { instanceId: 'a', fileName: 'F' });
      expect(reg.getByWs(ws)!.sameSceneStreak).toBe(1); // never grows past 1
    }
  });
});

describe('statusList — zombie-watchdog present-only serialization', () => {
  it('appSilenceMs always present; suspectedZombie/zombieReason/reHelloCount omitted in the healthy zero case', () => {
    const { reg } = makeReg();
    reg.register(sock(), { instanceId: 'a', fileName: 'F' });
    const [row] = reg.statusList();
    expect('appSilenceMs' in row).toBe(true);
    expect(row.appSilenceMs).toBe(0);
    expect('suspectedZombie' in row).toBe(false);
    expect('zombieReason' in row).toBe(false);
    expect('reHelloCount' in row).toBe(false);
  });

  it('reHelloCount appears once > 0, even before any flag trips', () => {
    const { reg, tick } = makeReg();
    let ws = sock();
    reg.register(ws, { instanceId: 'a', fileName: 'F' });
    tick(5);
    ws = sock();
    reg.register(ws, { instanceId: 'a', fileName: 'F' }); // one reconnect — not yet a flapper
    const row = reg.statusList().find((p) => p.instanceId === 'a')!;
    expect(row.reHelloCount).toBe(1);
    expect('suspectedZombie' in row).toBe(false);
  });

  it('suspectedZombie + zombieReason appear together, with the reason naming the cause', () => {
    const { reg, tick } = makeReg();
    const ws = sock();
    reg.register(ws, { instanceId: 'a', fileName: 'F' });
    tick(FROZEN_AFTER_MS + 1_000);
    const row = reg.statusList()[0];
    expect(row.suspectedZombie).toBe(true);
    expect(row.zombieReason).toMatch(/no app heartbeat for \d+s/);
  });
});

describe('extractScene — drops protocol keys, keeps scene identity', () => {
  it('strips instanceId/pluginVersion/protocolV, keeps fileName/page/extras', () => {
    expect(extractScene({ instanceId: 'x', pluginVersion: '0.1.0', protocolV: 1, fileName: 'F', page: 'P', user: 'me' }))
      .toEqual({ fileName: 'F', page: 'P', user: 'me' });
  });
  it('tolerates null/undefined', () => {
    expect(extractScene(null)).toEqual({});
    expect(extractScene(undefined)).toEqual({});
  });
});
