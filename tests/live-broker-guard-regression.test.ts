import { describe, expect, it, vi } from 'vitest';
import fs, { openSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import WebSocket from 'ws';
import { ensureBroker } from '../cli/src/transport/broker-discovery.ts';

describe('Live broker guard regression suite', () => {
  it('calling ensureBroker() without a test-level mock rejects with refusing error', async () => {
    await expect(ensureBroker()).rejects.toThrow('refusing to reach a real broker from a test');
  });

  it('calling ensureBroker() after vi.resetModules() still rejects with refusing error', async () => {
    vi.resetModules();
    const mod = await import('../cli/src/transport/broker-discovery.ts');
    await expect(mod.ensureBroker()).rejects.toThrow('refusing to reach a real broker from a test');
  });

  it('attempting to read, write, or open the live broker advertisement or disconnects file throws Live broker guard', () => {
    expect(() => readFileSync('/tmp/figma-agent-broker.json', 'utf8')).toThrow('Live broker guard');
    expect(() => writeFileSync('/tmp/figma-agent-broker.json', '{}')).toThrow('Live broker guard');
    expect(() => openSync('/tmp/figma-agent-broker.json', 'r')).toThrow('Live broker guard');
    expect(() => readFileSync('/tmp/figma-disconnects.jsonl', 'utf8')).toThrow('Live broker guard');
    expect(() => writeFileSync('/tmp/figma-disconnects.jsonl', '')).toThrow('Live broker guard');
  });

  it('attempting to read or write via fs.promises throws Live broker guard', async () => {
    await expect(fs.promises.readFile('/tmp/figma-agent-broker.json')).rejects.toThrow('Live broker guard');
    await expect(fs.promises.writeFile('/tmp/figma-agent-broker.json', '{}')).rejects.toThrow('Live broker guard');
  });

  it('attempting net.connect or WebSocket on live broker ports (9410-9419) throws Live broker guard', async () => {
    expect(() => net.connect(9410, '127.0.0.1')).toThrow('Live broker guard: refusing test network connection to live broker port 9410');
    expect(() => net.connect({ port: 9415, host: '127.0.0.1' })).toThrow('Live broker guard: refusing test network connection to live broker port 9415');

    const ws = new WebSocket('ws://127.0.0.1:9410');
    const err = await new Promise<Error>((resolve) => {
      ws.once('error', (e) => resolve(e));
    });
    expect(err.message).toContain('Live broker guard: refusing test network connection to live broker port 9410');
  });
});
