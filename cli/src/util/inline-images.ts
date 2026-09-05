// Inline external images referenced by <img src> and CSS url(...) as data:
// URIs BEFORE html reaches the plugin, so the plugin manifest's networkAccess
// stays narrow (spec §5 note). Failures degrade to warnings, never errors.
const IMG_SRC_RE = /<img\b[^>]*?\bsrc\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi;
const CSS_URL_RE = /url\(\s*(['"]?)(https?:\/\/[^)'"\s]+)\1\s*\)/gi;

const FETCH_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // oversized images left as URLs

const EXTENSION_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
};

function guessMime(url: string, headerMime: string | null): string {
  if (headerMime && headerMime.startsWith('image/')) return headerMime.split(';')[0].trim();
  const match = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(new URL(url).pathname);
  return (match && EXTENSION_MIME[match[1].toLowerCase()]) || 'application/octet-stream';
}

function collectImageUrls(html: string): string[] {
  const urls = new Set<string>();
  for (const re of [IMG_SRC_RE, CSS_URL_RE]) {
    for (const match of html.matchAll(re)) urls.add(match[2]);
  }
  return [...urls];
}

class ImageTooLargeError extends Error {
  constructor(readonly observedBytes: number) {
    super(`observed at least ${observedBytes} bytes, exceeding ${MAX_IMAGE_BYTES}`);
  }
}

async function readImageResponse(response: Response): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let observedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    observedBytes += value.byteLength;
    if (observedBytes > MAX_IMAGE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The oversized response is already being rejected.
      }
      throw new ImageTooLargeError(observedBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, observedBytes);
}

async function fetchAsDataUri(url: string, warnings: string[]): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      warnings.push(`inline-images: ${url} → HTTP ${res.status}, left as URL`);
      return null;
    }
    const buf = await readImageResponse(res);
    return `data:${guessMime(url, res.headers.get('content-type'))};base64,${buf.toString('base64')}`;
  } catch (err) {
    warnings.push(`inline-images: ${url} → ${err instanceof Error ? err.message : String(err)}, left as URL`);
    return null;
  }
}

/**
 * Replace every fetchable external image URL in the HTML with a data: URI.
 * Returns rewritten HTML plus warnings for anything left untouched.
 */
export async function inlineImages(html: string): Promise<{ html: string; warnings: string[] }> {
  const urls = collectImageUrls(html);
  if (urls.length === 0) return { html, warnings: [] };

  const warnings: string[] = [];
  const replacements = new Map<string, string>();
  await Promise.all(
    urls.map(async (url) => {
      const dataUri = await fetchAsDataUri(url, warnings);
      if (dataUri) replacements.set(url, dataUri);
    }),
  );

  // Replace longest URLs first so a URL that prefixes another is not clobbered.
  let out = html;
  for (const url of [...replacements.keys()].sort((a, b) => b.length - a.length)) {
    out = out.split(url).join(replacements.get(url)!);
  }
  return { html: out, warnings };
}
