// `figma-agent resolve-component --name <n> [--page <p>]` — exactly one component node
// for a name, or an honest refusal. Backlog group 6: the real file carries two live
// `Table / Cell` component sets, and a script that resolved "the" one by name silently
// picked whichever `findOne` reached first. This command reads the design-system
// registry (SCAN_DESIGN_SYSTEM — a broker safe read, so it bypasses the mutation FIFO
// and never queues behind a build) and applies ONE deterministic rule set locally.
import type { CommandArgs } from '../figma-agent.ts';
import { CliError } from '../transport/protocol-helpers.ts';
import { runCommand } from '../transport/broker-client.ts';

export interface ComponentCandidate {
  id: string;
  key?: string;
  name: string;
  type: string;
  /** `null` when the scan predates the page field or the node has no page. */
  page: { id: string; name: string } | null;
}

export type ComponentResolution =
  | { ok: true; node: ComponentCandidate; matched: number; preferred?: 'design-system-page' }
  | { ok: false; code: 'E_AMBIGUOUS' | 'E_NOT_FOUND'; message: string; candidates: ComponentCandidate[] };

/** A page that reads as the library home. `ds` must be a whole token: "Cards", "Fields"
 *  and "Threads" all contain it and are exactly the pages a stray copy lives on. */
export const DESIGN_SYSTEM_PAGE_RE = /design.?system|\bds\b|component|library/i;

const norm = (s: string): string => s.trim().toLowerCase();

function describe(c: ComponentCandidate): string {
  return `${c.id} (${c.type}, page: ${c.page ? JSON.stringify(c.page.name) : 'none'})`;
}

/**
 * Exact-after-trim, case-insensitive name match — never a substring, so "Table / Cell"
 * cannot resolve to "Table / Cell Header". With `--page` the page filter applies first
 * and the design-system heuristic never runs (the caller already said where to look).
 * Without it, a tie is broken ONLY when exactly one hit sits on a design-system-looking
 * page; anything else is E_AMBIGUOUS with every candidate listed.
 */
export function pickComponent(
  components: readonly ComponentCandidate[], name: string, page?: string,
): ComponentResolution {
  const wanted = norm(name);
  const byName = components.filter((c) => norm(c.name) === wanted);
  const hits = page === undefined
    ? byName
    : byName.filter((c) => c.page !== null && norm(c.page.name) === norm(page));
  if (hits.length === 1) return { ok: true, node: hits[0]!, matched: 1 };
  if (hits.length === 0) {
    const where = page !== undefined
      ? byName.length > 0
        ? ` on page "${page}" (${byName.length} live on other pages: ${byName.map(describe).join(', ')})`
        : ` on page "${page}"`
      : '';
    return {
      ok: false, code: 'E_NOT_FOUND', candidates: [],
      message: `no component or component set named "${name.trim()}"${where} — names must match exactly (case-insensitive)`,
    };
  }
  if (page === undefined) {
    const onDsPage = hits.filter((c) => c.page !== null && DESIGN_SYSTEM_PAGE_RE.test(c.page.name));
    if (onDsPage.length === 1) return { ok: true, node: onDsPage[0]!, matched: hits.length, preferred: 'design-system-page' };
  }
  return {
    ok: false, code: 'E_AMBIGUOUS', candidates: hits,
    message: `${hits.length} live nodes are named "${name.trim()}" — pass --page to pick one, or use the id directly: `
      + hits.map(describe).join('; '),
  };
}

export async function run(args: CommandArgs): Promise<unknown> {
  const name = args.req('name');
  if (name.trim() === '') throw new CliError('E_INVALID_ARGS', '--name needs a component name');
  const page = args.str('page');
  const timeoutMs = args.num('timeout');
  const scan = (await runCommand('SCAN_DESIGN_SYSTEM', {}, {
    readOnly: true, activity: `Resolve component · ${name.trim()}`,
    ...(timeoutMs !== undefined && { timeoutMs }),
  })) as { components?: unknown } | null;
  const components = Array.isArray(scan?.components) ? (scan.components as Record<string, unknown>[]) : [];
  const candidates: ComponentCandidate[] = components
    .filter((c) => typeof c.id === 'string' && typeof c.name === 'string' && typeof c.type === 'string')
    .map((c) => ({
      id: c.id as string, name: c.name as string, type: c.type as string,
      ...(typeof c.key === 'string' && { key: c.key }),
      page: c.page && typeof c.page === 'object' ? (c.page as ComponentCandidate['page']) : null,
    }));
  const resolution = pickComponent(candidates, name, page);
  if (!resolution.ok) {
    throw new CliError(resolution.code, resolution.message,
      resolution.candidates.length > 0 ? { candidates: resolution.candidates } : undefined);
  }
  const { node, matched, preferred } = resolution;
  return {
    id: node.id, ...(node.key !== undefined && { key: node.key }), name: node.name, type: node.type, page: node.page,
    matched, ...(preferred !== undefined && { preferred }),
  };
}
