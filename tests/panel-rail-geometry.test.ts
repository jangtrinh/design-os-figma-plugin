import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { chromium } from 'playwright';
import {
  RAIL_HEIGHT, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH, clampRailWidth, droppedNote, railSentence,
  type RailSentence,
} from '../plugin/src/ui/panel-model.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(`${ROOT}/plugin/src/ui/panel.html`, 'utf8');
const BROWSER_SETUP_TIMEOUT_MS = 30_000;
const LONG = 'Sync failed for VSF - PCP — the reconcile could not read the project index and stopped before touching anything';
let browser: Browser;
let page: Page;

interface Row {
  rail: number;
  document: number;
  /** The lower-priority half — the only text the ellipsis is allowed to reach. */
  restClipped: boolean;
  /** The lost-edit half, which it is not. */
  leadClipped: boolean;
  leadText: string;
}

/** What panel-ui.ts measures after a render, under the host width Figma happens to give us.
 *  The two spans are written exactly the way `render()` writes them. */
async function layeredRow(
  view: Pick<RailSentence, 'lead' | 'rest'>, target: boolean, sync: boolean, hostWidth: number,
): Promise<Row> {
  await page.setViewportSize({ width: hostWidth, height: RAIL_HEIGHT });
  return page.evaluate(({ lead, rest, showTarget, showSync }) => {
    const leadEl = document.getElementById('fga-sentence-lead') as HTMLElement;
    const restEl = document.getElementById('fga-sentence-rest') as HTMLElement;
    leadEl.textContent = lead;
    leadEl.hidden = lead === '';
    restEl.textContent = rest;
    (document.getElementById('fga-target-rail-btn') as HTMLButtonElement).hidden = !showTarget;
    (document.getElementById('fga-sync-rail-btn') as HTMLButtonElement).hidden = !showSync;
    const rail = document.getElementById('fga-rail') as HTMLElement;
    return {
      rail: Math.ceil(rail.getBoundingClientRect().width),
      document: Math.ceil(document.body.getBoundingClientRect().width),
      restClipped: restEl.scrollWidth > restEl.clientWidth,
      leadClipped: leadEl.scrollWidth > leadEl.clientWidth,
      leadText: leadEl.textContent ?? '',
    };
  }, { lead: view.lead, rest: view.rest, showTarget: target, showSync: sync });
}

const row = (sentence: string, target: boolean, sync: boolean, hostWidth: number): Promise<Row> =>
  layeredRow({ lead: '', rest: sentence }, target, sync, hostWidth);

beforeAll(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
  }
  page = await browser.newPage({ viewport: { width: RAIL_MIN_WIDTH, height: RAIL_HEIGHT } });
  await page.setContent(html);
}, BROWSER_SETUP_TIMEOUT_MS);

afterAll(async () => { await browser?.close(); });

describe('the rail hugs its content in Chromium', () => {
  it('measures its content, not the window it was given', async () => {
    const narrow = await row('Idle', false, false, RAIL_MIN_WIDTH);
    const wide = await row('Idle', false, false, RAIL_MAX_WIDTH);
    expect(wide.rail).toBe(narrow.rail);
    expect(narrow.document).toBe(narrow.rail); // the document is the row, so nothing latches it wide
    expect(narrow.rail).toBeLessThan(RAIL_MIN_WIDTH);
    // Idle is narrower than the host title needs, so main's clamp is what opens it at 240.
    expect(clampRailWidth(narrow.rail)).toBe(RAIL_MIN_WIDTH);
  });

  it('grows with the sentence and shrinks back again', async () => {
    const idle = await row('Idle', false, false, RAIL_MIN_WIDTH);
    const busy = await row('Created frame Hero on page Cover', false, false, RAIL_MIN_WIDTH);
    const long = await row(LONG, false, false, RAIL_MIN_WIDTH);
    expect(busy.rail).toBeGreaterThan(idle.rail);
    expect(long.rail).toBeGreaterThan(busy.rail);
    expect(await row('Idle', false, false, RAIL_MIN_WIDTH)).toEqual(idle);
  });

  it('never asks for more than the ceiling, and ellipses instead', async () => {
    const long = await row(LONG, true, true, RAIL_MAX_WIDTH);
    expect(long.rail).toBeLessThanOrEqual(RAIL_MAX_WIDTH);
    expect(clampRailWidth(long.rail)).toBeLessThanOrEqual(RAIL_MAX_WIDTH);
    expect(long.restClipped, 'a sentence past the cap must ellipse').toBe(true);
    const short = await row('Idle', true, true, RAIL_MAX_WIDTH);
    expect(short.restClipped, 'a short sentence must never be clipped').toBe(false);
  });

  it('makes room for each contextual action only while it is shown', async () => {
    const bare = await row('2 changes ready', false, false, RAIL_MIN_WIDTH);
    const one = await row('2 changes ready', false, true, RAIL_MIN_WIDTH);
    const two = await row('2 changes ready', true, true, RAIL_MIN_WIDTH);
    expect(one.rail - bare.rail).toBe(36); // a 32px control plus the 4px gap
    expect(two.rail - one.rail).toBe(36);
  });

  it('spends the ellipsis on the connection line and never on a lost edit', async () => {
    // The worst real pairing: the longest trouble sentence next to a lost-edit count.
    const view = railSentence({ state: 'probing', ageMs: 10_000, hadConnection: true, droppedFrames: 2 });
    const measured = await layeredRow(view, true, true, RAIL_MAX_WIDTH);
    expect(measured.leadText, 'the lost edit leads the line').toBe(droppedNote(2));
    expect(measured.leadClipped, 'a lost edit may never be ellipsed away').toBe(false);
    expect(measured.restClipped, 'the recoverable half is what the ellipsis eats').toBe(true);
    expect(measured.rail, 'and the row still fits the ceiling').toBeLessThanOrEqual(RAIL_MAX_WIDTH);
  });

  it('does not clip either half when both fit', async () => {
    const view = railSentence({ state: 'connected', ageMs: 0, hadConnection: true, droppedFrames: 1 });
    const measured = await layeredRow(view, false, false, RAIL_MIN_WIDTH);
    expect(measured.leadText).toBe(droppedNote(1));
    expect(measured.leadClipped).toBe(false);
    expect(measured.restClipped).toBe(false);
  });
});
