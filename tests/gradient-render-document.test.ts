import { describe, expect, it } from 'vitest';
import { buildRenderDocument } from '../plugin/src/ui/gradient-host';

describe('gradient render document', () => {
  it('escapes script-closing sequences in both config and correlation data', () => {
    const attack = '</script><script>parent.document.body.dataset.owned="true"</script>';
    const document = buildRenderDocument({
      props: { shader: attack } as never,
      width: 1,
      height: 1,
      scale: 1,
      staticFrame: true,
    }, attack);
    expect(document).not.toContain(attack);
    expect(document.match(/<\/script>/g)).toHaveLength(1);
    expect(document).toContain('\\u003c/script\\u003e');
  });

  it('keeps the pinned settle-frame contract', () => {
    const document = buildRenderDocument({ props: {} as never, width: 1, height: 1, scale: 1, staticFrame: true }, 'id');
    expect(document).toContain('"settle":8');
  });
});
