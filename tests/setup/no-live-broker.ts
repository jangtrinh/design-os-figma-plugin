// Structural guard: a test that reaches `ensureBroker` would replace the developer's
// live broker (a newer source build supersedes an older running one). Every test module
// gets a broker-discovery whose `ensureBroker` throws; a test that legitimately needs a
// stub declares its own `vi.mock` for the module, which takes precedence over this one.
import { vi } from 'vitest';

vi.mock('../../cli/src/transport/broker-discovery.ts', async () => {
  const actual = await vi.importActual<typeof import('../../cli/src/transport/broker-discovery.ts')>(
    '../../cli/src/transport/broker-discovery.ts',
  );
  return {
    ...actual,
    ensureBroker: async () => {
      throw new Error('refusing to reach a real broker from a test');
    },
  };
});
