export interface SlideStripGroup<T extends { rendererIndex: number }> {
  depth: number;
  strips: readonly T[];
}

/** Transparent fragment groups draw far-to-near; renderer order applies within a fragment. */
export function orderSlideStripGroups<T extends { rendererIndex: number }>(groups: readonly SlideStripGroup<T>[]): T[] {
  return groups
    .map((group, sourceOrder) => ({ group, sourceOrder }))
    .sort((a, b) => b.group.depth - a.group.depth || a.sourceOrder - b.sourceOrder)
    .flatMap(({ group }) => group.strips
      .map((strip, sourceOrder) => ({ strip, sourceOrder }))
      .sort((a, b) => a.strip.rendererIndex - b.strip.rendererIndex || a.sourceOrder - b.sourceOrder)
      .map(({ strip }) => strip));
}
