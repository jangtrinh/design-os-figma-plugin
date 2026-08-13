import { createHash } from 'node:crypto';

export function computePluginBuildId(parts) {
  const hash = createHash('sha256');
  for (const [name, content] of Object.entries(parts).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 7);
}

const EMBEDDED_BUILD_ID = /true \? "([a-f0-9]{7})" : "dev"/;

export function extractPluginBuildId(uiHtml) {
  return uiHtml.match(EMBEDDED_BUILD_ID)?.[1] ?? null;
}

export function canonicalizePluginUi(uiHtml) {
  return uiHtml.replace(EMBEDDED_BUILD_ID, 'true ? "pending" : "dev"');
}
