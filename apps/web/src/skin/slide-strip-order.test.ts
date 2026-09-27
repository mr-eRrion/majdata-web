import { expect, it } from 'vitest';
import { orderSlideStripGroups } from './slide-strip-order.js';

it('globally orders interleaved fragments far-to-near and renderer slices within each fragment', () => {
  const ordered = orderSlideStripGroups([
    { depth: 1.5 / 100, strips: [{ id: 'later-branch-0', rendererIndex: 0 }] },
    { depth: 1.4 / 100 + 2 * 0.001, strips: [
      { id: 'earlier-branch-2-renderer-1', rendererIndex: 1 },
      { id: 'earlier-branch-2-renderer-0', rendererIndex: 0 },
    ] },
    { depth: 1.4 / 100, strips: [{ id: 'earlier-branch-0', rendererIndex: 0 }] },
    { depth: 1.5 / 100, strips: [{ id: 'same-depth-source-later', rendererIndex: 0 }] },
  ]);

  expect(ordered.map(({ id }) => id)).toEqual([
    'earlier-branch-2-renderer-0',
    'earlier-branch-2-renderer-1',
    'later-branch-0',
    'same-depth-source-later',
    'earlier-branch-0',
  ]);
});
