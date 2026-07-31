// `ui.figjam.*` — FigJam capabilities (absorption phase-03). Adapted from the fork's
// FigJam handlers (MIT; see THIRD-PARTY.md), code.js:5970-6524, figjam-tools.ts:8-59.
// Split across four files (this one plus -types/-content/-arrange/-read) to stay
// under the 200-line cap — the same split-by-shape precedent as exec-stdlib-slot.ts.
import { sticky, stickies, connector, shape, section } from './exec-stdlib-figjam-content';
import { table, codeBlock } from './exec-stdlib-figjam-table';
import { arrange } from './exec-stdlib-figjam-arrange';
import { board, connections } from './exec-stdlib-figjam-read';

export interface ExecStdlibFigjam {
  sticky: typeof sticky;
  stickies: typeof stickies;
  connector: typeof connector;
  shape: typeof shape;
  section: typeof section;
  table: typeof table;
  codeBlock: typeof codeBlock;
  arrange: typeof arrange;
  board: typeof board;
  connections: typeof connections;
}

export function createExecStdlibFigjam(): ExecStdlibFigjam {
  return { sticky, stickies, connector, shape, section, table, codeBlock, arrange, board, connections };
}
