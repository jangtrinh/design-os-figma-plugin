import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inlineImages } from '../cli/src/util/inline-images.ts';

const LIMIT = 8 * 1024 * 1024;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function imageResponse(body: ReadableStream<Uint8Array>, contentLength?: string) {
  return new Response(body, {
    headers: {
      'content-type': 'image/png',
      ...(contentLength === undefined ? {} : { 'content-length': contentLength }),
    },
  });
}

describe('inlineImages', () => {
  it('cancels a stream at the observed 8 MiB overflow without reading another chunk', async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new Uint8Array(LIMIT + 1));
        else if (pulls === 2) controller.enqueue(new Uint8Array([0]));
        else throw new Error('consumer read after overflow');
      },
      cancel() { cancelled = true; },
    });
    globalThis.fetch = vi.fn(async () => imageResponse(body, '1')) as typeof fetch;

    const url = 'https://images.example/too-large.png';
    const result = await inlineImages(`<img src="${url}">`);

    expect(result.html).toContain(url);
    expect(result.warnings).toEqual([expect.stringContaining(`observed at least ${LIMIT + 1} bytes, exceeding ${LIMIT}`)]);
    expect(cancelled).toBe(true);
    // The streams implementation may prefetch once, but a second reader read
    // would cause a third pull and reproduce the pre-fix full-buffer behavior.
    expect(pulls).toBe(2);
  });

  it('keeps exact-limit image bytes intact despite an absent or misleading Content-Length', async () => {
    const bytes = new Uint8Array(LIMIT);
    bytes.set([137, 80, 78, 71], 0);
    for (const length of [undefined, '1', String(LIMIT + 1)]) {
      globalThis.fetch = vi.fn(async () => imageResponse(new ReadableStream({
        start(controller) { controller.enqueue(bytes); controller.close(); },
      }), length)) as typeof fetch;
      const result = await inlineImages('<img src="https://images.example/exact.png">');
      expect(result.warnings).toEqual([]);
      expect(result.html).toContain(Buffer.from(bytes).toString('base64'));
    }
  });

  it('preserves URL replacement, deduplication, and actionable read failures', async () => {
    const url = 'https://images.example/a.png';
    globalThis.fetch = vi.fn(async () => imageResponse(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); },
    }))) as typeof fetch;
    const success = await inlineImages(`<img src="${url}"><style>.x{background:url('${url}')}</style>`);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(success.html).not.toContain(url);
    expect(success.html.match(/data:image\/png;base64,AQID/g)).toHaveLength(2);

    globalThis.fetch = vi.fn(async () => { throw new Error('connection reset'); }) as typeof fetch;
    const failed = await inlineImages(`<img src="${url}">`);
    expect(failed.html).toContain(url);
    expect(failed.warnings).toEqual([expect.stringContaining('connection reset')]);

    globalThis.fetch = vi.fn(async () => imageResponse(new ReadableStream({
      start(controller) { controller.error(new Error('stream read failed')); },
    }))) as typeof fetch;
    const readFailed = await inlineImages(`<img src="${url}">`);
    expect(readFailed.html).toContain(url);
    expect(readFailed.warnings).toEqual([expect.stringContaining('stream read failed')]);

    globalThis.fetch = vi.fn(async () => { throw new DOMException('operation aborted', 'AbortError'); }) as typeof fetch;
    const aborted = await inlineImages(`<img src="${url}">`);
    expect(aborted.html).toContain(url);
    expect(aborted.warnings).toEqual([expect.stringContaining('operation aborted')]);
  });

  it('round-trips a repository PNG through overlapping HTML and CSS URLs', async () => {
    const bytes = readFileSync(new URL('../references/Reference.png', import.meta.url));
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(bytes);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    const shortUrl = `http://127.0.0.1:${address.port}/image.png`;
    const longUrl = `${shortUrl}?variant=long`;
    try {
      const result = await inlineImages(`<img src="${shortUrl}"><img src="${longUrl}"><style>.a{background:url('${shortUrl}')}.b{background:url('${longUrl}')}</style>`);
      const dataUri = `data:image/png;base64,${bytes.toString('base64')}`;
      expect(requests).toBe(2);
      expect(result.warnings).toEqual([]);
      expect(result.html).not.toContain(shortUrl);
      expect(result.html.split(dataUri)).toHaveLength(5);
      expect(Buffer.from(dataUri.split(',')[1], 'base64')).toEqual(bytes);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('aborts a stalled response body at the fetch deadline and closes its socket', async () => {
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    let sentBody = false;
    const server = createServer((request, response) => {
      request.socket.once('close', resolveClosed);
      response.writeHead(200, { 'content-type': 'image/png' });
      response.write(Buffer.from([137]));
      sentBody = true;
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    const url = `http://127.0.0.1:${address.port}/stalled.png`;
    try {
      const result = await inlineImages(`<img src="${url}">`);
      expect(sentBody).toBe(true);
      expect(result.html).toContain(url);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/abort|timeout/i);
      await closed;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it('cancels a real chunked HTTP response and closes its request socket', async () => {
    let resolveRequestClosed!: () => void;
    const requestClosed = new Promise<void>((resolve) => { resolveRequestClosed = resolve; });
    const server = createServer((request, response) => {
      request.once('close', resolveRequestClosed);
      response.writeHead(200, { 'content-type': 'image/png' });
      response.write(Buffer.alloc(LIMIT + 1));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    const url = `http://127.0.0.1:${address.port}/stream.png`;

    try {
      const result = await inlineImages(`<img src="${url}">`);
      expect(result.html).toContain(url);
      expect(result.warnings).toEqual([expect.stringContaining('bytes, exceeding')]);
      await requestClosed;
      server.close();
      await once(server, 'close');
    } finally {
      server.close();
      await once(server, 'close').catch(() => undefined);
    }
  });
});
