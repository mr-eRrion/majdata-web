import type { Note, SlidePathData, SlideSegmentData } from './types.js';

export type ChartTransform =
  | 'mirror-horizontal'
  | 'mirror-vertical'
  | 'rotate-clockwise'
  | 'rotate-counterclockwise';

export interface NoteUpdateChange {
  id: string;
  patch: Pick<Note, 'position' | 'slide'>;
}

const MIRROR_HORIZONTAL = [0, 8, 7, 6, 5, 4, 3, 2, 1] as const;
const MIRROR_VERTICAL = [0, 4, 3, 2, 1, 8, 7, 6, 5] as const;
const MIRROR_HORIZONTAL_DE = [0, 1, 8, 7, 6, 5, 4, 3, 2] as const;
const MIRROR_VERTICAL_DE = [0, 5, 4, 3, 2, 1, 8, 7, 6] as const;
const ROTATE_CLOCKWISE = [0, 2, 3, 4, 5, 6, 7, 8, 1] as const;
const ROTATE_COUNTERCLOCKWISE = [0, 8, 1, 2, 3, 4, 5, 6, 7] as const;
const SLIDE_ROTATION_BOUNDARY = new Set([1, 2, 7, 8]);

/**
 * Map selected notes to one atomic `update` batch.
 * Touch-area letters stay fixed; D/E use their MajdataEdit mirror phase while
 * 45-degree rotations follow the normal eight-position cycle. Slide mapping
 * follows OperationUtility.FlipNotes/RotateNotes for one modeled segment.
 */
export function transformNotes(notes: readonly Note[], transform: ChartTransform): NoteUpdateChange[] {
  const changes: NoteUpdateChange[] = [];
  for (const note of notes) {
    if (note.kind === 'slide') {
      if (!note.slide) throw new RangeError('Slide notes need path data');
      if (!['-', '<', '>', 'w', 'v', 's', 'z'].includes(note.slide.command))
        throw new RangeError(`Slide command is not modeled for transforms: ${note.slide.command}`);
      if (!Number.isInteger(note.slide.endPosition) || note.slide.endPosition < 1 || note.slide.endPosition > 8)
        throw new RangeError('Slide endpoints use positions 1–8');
      if (!Number.isInteger(note.position) || note.position < 1 || note.position > 8)
        throw new RangeError('Slide starts use positions 1–8');

      const map = mapFor(transform, false);
      const position = map[note.position];
      const transformPath = (path: SlidePathData): SlidePathData => {
        if (path.command === 'w') return {
          command: 'w',
          endPosition: map[path.endPosition],
          slideBreak: path.slideBreak,
          wait: { ...path.wait },
          move: { ...path.move },
        };
        const segments: SlideSegmentData[] = [{ command: path.command, endPosition: path.endPosition }, ...(path.continuations ?? [])];
        let start = note.position;
        const transformed = segments.map((segment) => {
          const transformedStart = map[start];
          const result = {
            command: transformSlideCommand(segment.command, start, transformedStart, transform),
            endPosition: map[segment.endPosition],
          };
          start = segment.endPosition;
          return result;
        });
        return {
          command: transformed[0].command,
          endPosition: transformed[0].endPosition,
          slideBreak: path.slideBreak,
          wait: { ...path.wait },
          move: { ...path.move },
          ...(transformed.length > 1 ? { continuations: transformed.slice(1) } : {}),
        };
      };
      const primary = transformPath(note.slide);
      changes.push({ id: note.id, patch: { position, slide: {
        ...primary,
        head: note.slide.head,
        ...(note.slide.additionalPaths?.length
          ? { additionalPaths: note.slide.additionalPaths.map(transformPath) }
          : {}),
      } } });
      continue;
    }

    const touch = note.kind === 'touch' || note.kind === 'touchHold';
    if (touch && note.modifiers.ex)
      throw new RangeError('EX Touch and Touch Hold notes are not supported');

    if (touch) {
      if (!note.touchArea || !['A', 'B', 'C', 'D', 'E'].includes(note.touchArea))
        throw new RangeError('Touch notes need an A–E sensor area');
      if (note.touchArea === 'C') {
        if (note.position !== 0) throw new RangeError('Touch C uses position 0');
        continue;
      }
      if (!Number.isInteger(note.position) || note.position < 1 || note.position > 8)
        throw new RangeError('Numbered Touch areas use positions 1–8');
    } else if ((note.kind !== 'tap' && note.kind !== 'hold')
      || !Number.isInteger(note.position) || note.position < 1 || note.position > 8) {
      throw new RangeError('Ring notes use positions 1–8');
    }

    const map = mapFor(transform, touch && (note.touchArea === 'D' || note.touchArea === 'E'));
    const position = map[note.position];
    if (position === note.position) continue;
    changes.push({ id: note.id, patch: { position } });
  }
  return changes;
}

function transformSlideCommand(
  command: SlideSegmentData['command'],
  start: number,
  transformedStart: number,
  transform: ChartTransform,
): SlideSegmentData['command'] {
  if ((transform === 'mirror-horizontal' || transform === 'mirror-vertical')
    && (command === 's' || command === 'z'))
    return command === 's' ? 'z' : 's';
  if (command !== '<' && command !== '>') return command;
  if (transform === 'mirror-horizontal') return command === '<' ? '>' : '<';
  if (transform === 'rotate-clockwise' || transform === 'rotate-counterclockwise') {
    if (SLIDE_ROTATION_BOUNDARY.has(start) !== SLIDE_ROTATION_BOUNDARY.has(transformedStart))
      return command === '<' ? '>' : '<';
  }
  return command;
}

function mapFor(transform: ChartTransform, isDETouch: boolean): readonly number[] {
  switch (transform) {
    case 'mirror-horizontal': return isDETouch ? MIRROR_HORIZONTAL_DE : MIRROR_HORIZONTAL;
    case 'mirror-vertical': return isDETouch ? MIRROR_VERTICAL_DE : MIRROR_VERTICAL;
    case 'rotate-clockwise': return ROTATE_CLOCKWISE;
    case 'rotate-counterclockwise': return ROTATE_COUNTERCLOCKWISE;
  }
}
