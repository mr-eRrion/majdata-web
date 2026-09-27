import type { DisplayNote, DisplaySlidePath } from '../../../../packages/chart-core/src/types.js';

/** A single parallel route view; connected geometry stays in its ordered segments. */
export type DisplaySlidePathNote = DisplayNote & Pick<DisplaySlidePath, 'segments'>;

/** Expands shared-head paths without splitting a connected route into extra notes. */
export function displaySlidePaths(note: DisplayNote): DisplaySlidePathNote[] {
  if (note.kind !== 'slide' || !note.slide) return [];

  const paths: readonly DisplaySlidePath[] = note.slidePaths ?? [{
    ...note.slide,
    moveStartSeconds: note.moveStartSeconds ?? note.startSeconds,
    endSeconds: note.endSeconds,
  }];

  return paths.map((path, index) => {
    const { moveStartSeconds, endSeconds, segments, ...pathData } = path;
    return {
      ...note,
      id: index === 0 ? note.id : `${note.id}:path:${index}`,
      slide: {
        ...pathData,
        head: index === 0 ? note.slide!.head : 'none',
        additionalPaths: undefined,
      },
      slidePaths: undefined,
      moveStartSeconds,
      endSeconds,
      segments,
    };
  });
}
