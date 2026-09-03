// The `context` design-intent channel, wired into the walk: what the DESIGNER meant, added
// to a record that already says what the node IS.
//
// The field shapes live in `context-intent-readers.ts`. What this file owns is the wiring,
// and it is two decisions:
//
//   1. It WRAPS `buildContextRecord` rather than editing it. `ContextWalkOptions.buildRecord`
//      is already an injection point, so neither the per-node reader nor the walker grows a
//      line, and the intent reads ride inside the same `Promise.all` batch as the CSS reads.
//   2. A component's description is resolved ONCE PER COMPONENT KEY into `refs.components`,
//      not once per instance. Forty instances of one button cost one resolution — and every
//      key that was asked about is remembered even when it answered empty, so an undocumented
//      component is asked about once too.
//
// Every read is wrapped: a throw keeps the node, sets `intentError` to the FIRST message (the
// P1 placement, beside `cssError` / `mainComponentError` / `childrenError`) and counts the
// record in `budget.partial`, so `complete` goes false.
import {
  hasComponentIntent, readAnnotations, readComponentIntent, readDevStatus,
  type ComponentIntent, type SubtreeDevResources,
} from './context-intent-readers';
import { buildContextRecord, messageOf, type ContextNodeLike, type ContextRecordResult } from './context-node-record';
import { safe } from './scan-node-utils';

export { noDevResourcesRead, readSubtreeDevResources } from './context-intent-readers';
export type { ComponentIntent, DevResourceEntry, SubtreeDevResources } from './context-intent-readers';

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export interface ContextIntentOptions {
  devResources: SubtreeDevResources;
  /** Injected so the "once per key" claim is testable without also counting the base record
   *  builder's own resolutions. Defaults to the node's own async getter — the sync
   *  `mainComponent` getter throws under `documentAccess: "dynamic-page"`. */
  mainComponentOf?: (node: ContextNodeLike) => Promise<ContextNodeLike | null>;
  /** Injected only by tests that need to observe the base reader. */
  build?: typeof buildContextRecord;
}

export interface ContextIntentReader {
  buildRecord: typeof buildContextRecord;
  /** Component key → intent, for merging into `refs.components`. Only keys with something to
   *  say appear: an empty description leaves the P1 `{name}` row exactly as it was. */
  components: () => Record<string, ComponentIntent>;
  /** How many dev-resource LINKS landed on an emitted record — the same unit as `found`, so
   *  the two are comparable. Counting RECORDS here reported `{found: 3, attached: 2}` for a
   *  frame with two links plus a child with one, both emitted: every node and every link
   *  present, yet the numbers said something was missing. */
  attachedDevResources: () => number;
}

const defaultMainComponentOf = async (node: ContextNodeLike): Promise<ContextNodeLike | null> => {
  const get = safe(() => node.getMainComponentAsync) as (() => Promise<ContextNodeLike | null>) | undefined;
  return typeof get === 'function' ? get.call(node) : null;
};

export function createContextIntentReader(opts: ContextIntentOptions): ContextIntentReader {
  const build = opts.build ?? buildContextRecord;
  const mainComponentOf = opts.mainComponentOf ?? defaultMainComponentOf;
  /** Every key asked about, including the ones that answered empty — so a second instance of
   *  an undocumented component costs nothing either. */
  const asked = new Map<string, ComponentIntent>();
  let attached = 0;

  /** The component key a record may point at, resolving each key at most once. `null` when
   *  there is nothing to point at. */
  async function resolveByKey(key: string, source: () => Promise<ContextNodeLike | null>): Promise<string | null> {
    const known = asked.get(key);
    if (known !== undefined) return hasComponentIntent(known) ? key : null;
    const component = await source();
    // A null answer is an answer, and it is remembered: without this, forty instances of one
    // unresolvable component are forty host round trips — the per-node cost this memo exists
    // to refuse. An empty-name entry has no intent, so it never reaches `refs.components`.
    const intent = component === null ? { name: '' } : readComponentIntent(component);
    asked.set(key, intent);
    return hasComponentIntent(intent) ? key : null;
  }

  async function readComponent(
    node: ContextNodeLike, record: Record<string, unknown>, type: string,
  ): Promise<{ componentKey?: string; component?: ComponentIntent }> {
    if (type === 'COMPONENT' || type === 'COMPONENT_SET') {
      const key = str(safe(() => node.key));
      // No key means nothing to dedup BY, so the words ride inline rather than going nowhere.
      // The component itself is right here, so this costs no extra resolve.
      if (key === '') {
        const intent = readComponentIntent(node);
        return hasComponentIntent(intent) ? { component: intent } : {};
      }
      const pointed = await resolveByKey(key, async () => node);
      return pointed === null ? {} : { componentKey: pointed };
    }
    if (type !== 'INSTANCE') return {};
    const main = record.mainComponent as { key?: unknown } | undefined;
    const key = str(safe(() => main?.key));
    // An instance whose main component carries no key gets no component intent: there would
    // be no key to resolve once per, and one resolve per instance is exactly the per-node cost
    // this module exists to refuse.
    if (key === '') return {};
    const pointed = await resolveByKey(key, () => mainComponentOf(node));
    return pointed === null ? {} : { componentKey: pointed };
  }

  const buildRecord: typeof buildContextRecord = async (node, recordOpts): Promise<ContextRecordResult> => {
    const result = await build(node, recordOpts);
    // A reference that refused its own identity refuses everything after it, and the minimal
    // `{id, readError}` record has nowhere to hang intent anyway.
    if (typeof result.record.readError === 'string') return result;

    let firstError: string | null = null;
    const note = (message: string): void => { if (firstError === null) firstError = message; };
    const intent: Record<string, unknown> = {};

    try {
      const devStatus = readDevStatus(node);
      if (devStatus !== null) intent.devStatus = devStatus;
    } catch (err) { note(messageOf(err)); }

    try {
      const annotations = readAnnotations(node);
      if (annotations !== null) intent.annotations = annotations;
    } catch (err) { note(messageOf(err)); }

    const id = str(result.record.id);
    const resources = id === '' ? undefined : opts.devResources.byNode.get(id);
    if (resources !== undefined && resources.length > 0) {
      intent.devResources = resources;
      attached += resources.length;
    }

    try {
      const component = await readComponent(node, result.record, str(result.record.type));
      if (component.componentKey !== undefined) intent.componentKey = component.componentKey;
      if (component.component !== undefined) intent.component = component.component;
    } catch (err) { note(messageOf(err)); }

    if (Object.keys(intent).length > 0) result.record.intent = intent;
    if (firstError !== null) {
      result.record.intentError = firstError;
      return { ...result, incomplete: true };
    }
    return result;
  };

  return {
    buildRecord,
    components: (): Record<string, ComponentIntent> => {
      const out: Record<string, ComponentIntent> = {};
      for (const [key, intent] of asked) if (hasComponentIntent(intent)) out[key] = intent;
      return out;
    },
    attachedDevResources: (): number => attached,
  };
}
