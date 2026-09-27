import { expect, test } from 'vitest';
import fixture from '../../../../fixtures/visual-maimai/warning-oracle.json';
import { checkVisualChart } from './visual-checker';
import type { VisualCheckNote } from './types';

// Golden results from the original C# method; see tools/visual-assets/warning-oracle/.
for (const entry of fixture.cases) test(`original C# collision results: ${entry.name}`, () => {
  expect(checkVisualChart(entry.notes as VisualCheckNote[], entry.bpms)).toEqual(entry.results);
});
