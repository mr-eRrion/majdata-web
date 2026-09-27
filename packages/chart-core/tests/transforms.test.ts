import { describe, expect, it } from 'vitest';
import { transformNotes } from '../src/index.js';
import type { Note, SlideData } from '../src/types.js';
import type { ChartTransform } from '../src/transforms.js';
import slidePathFixture from '../../../apps/web/src/skin/slide-paths.json';

const modifiers = { break: false, ex: false };

function note(id: string, kind: Note['kind'], position: number, touchArea?: Note['touchArea']): Note {
  return {
    id,
    kind,
    beat: { numerator: 0, denominator: 1 },
    position,
    touchArea,
    order: 0,
    duration: kind === 'hold' || kind === 'touchHold' ? { kind: 'beatsAtStartBpm', division: 4, beats: 1 } : undefined,
    modifiers,
  };
}

function apply(notes: readonly Note[], transform: ChartTransform): Note[] {
  const changes = new Map(transformNotes(notes, transform).map(({ id, patch }) => [id, patch]));
  return notes.map((value) => ({ ...value, ...changes.get(value.id) }));
}

type PathFixture = {
  commands: Record<string, Record<string, number>>;
  paths: Record<string, { points: [number, number][] }>;
};
const slidePaths = slidePathFixture as unknown as PathFixture;

function rotate(point: readonly [number, number], degrees: number): [number, number] {
  const angle = degrees * Math.PI / 180;
  return [
    Math.cos(angle) * point[0] - Math.sin(angle) * point[1],
    Math.sin(angle) * point[0] + Math.cos(angle) * point[1],
  ];
}

function serializedSlidePath(command: string, start: number, end: number): [number, number][] {
  const distance = (end - start + 8) % 8;
  const selectedCommand = start >= 3 && start <= 6
    ? command === '<' ? '>' : command === '>' ? '<' : command
    : command;
  const pathId = slidePaths.commands[selectedCommand][String(distance)];
  return slidePaths.paths[String(pathId)].points.map((point) => rotate(point, (start - 1) * -45));
}

function applyGeometry(point: readonly [number, number], transform: ChartTransform): [number, number] {
  if (transform === 'mirror-horizontal') return [-point[0], point[1]];
  if (transform === 'mirror-vertical') return [point[0], -point[1]];
  return rotate(point, transform === 'rotate-clockwise' ? -45 : 45);
}

function mapLane(lane: number, transform: ChartTransform): number {
  if (transform === 'mirror-horizontal') return 9 - lane;
  if (transform === 'mirror-vertical') return lane <= 4 ? 5 - lane : 13 - lane;
  return transform === 'rotate-clockwise' ? lane % 8 + 1 : (lane + 6) % 8 + 1;
}

function slideNote(id: string, start: number, command: SlideData['command'], end: number): Note {
  return {
    ...note(id, 'slide', start),
    slide: {
      command, endPosition: end, head: 'tap', slideBreak: true,
      wait: { kind: 'beatsAtStartBpm', division: 4, beats: 1 },
      move: { kind: 'seconds', seconds: 1.25 },
    },
  };
}

describe('structured note transforms', () => {
  it('uses ring mappings and MajdataEdit D/E mirror phases while leaving Touch C centered', () => {
    const notes = [
      note('ring', 'tap', 1),
      note('a', 'touch', 1, 'A'),
      note('d', 'touchHold', 1, 'D'),
      note('e', 'touch', 3, 'E'),
      note('c', 'touch', 0, 'C'),
    ];
    const horizontal = apply(notes, 'mirror-horizontal');
    expect(horizontal.map(({ position, touchArea }) => [touchArea ?? 'ring', position])).toEqual([
      ['ring', 8], ['A', 8], ['D', 1], ['E', 7], ['C', 0],
    ]);
    const vertical = apply(notes, 'mirror-vertical');
    expect(vertical.map(({ position }) => position)).toEqual([4, 4, 5, 3, 0]);
  });

  it('makes both mirrors involutions and clockwise/counterclockwise rotations inverses', () => {
    const notes = [note('ring', 'hold', 1), note('a', 'touch', 2, 'A'), note('d', 'touch', 8, 'D'), note('c', 'touch', 0, 'C')];
    for (const mirror of ['mirror-horizontal', 'mirror-vertical'] as const) {
      expect(apply(apply(notes, mirror), mirror)).toEqual(notes);
    }
    expect(apply(apply(notes, 'rotate-clockwise'), 'rotate-counterclockwise')).toEqual(notes);
    let rotated = notes;
    for (let turn = 0; turn < 8; turn++) rotated = apply(rotated, 'rotate-clockwise');
    expect(rotated).toEqual(notes);
  });

  it('transforms one-segment Slide endpoints and only changes their command when source rules require it', () => {
    const source = slideNote('s', 2, '<', 5);
    const original = structuredClone(source);
    const horizontal = transformNotes([source], 'mirror-horizontal')[0].patch;
    const vertical = transformNotes([source], 'mirror-vertical')[0].patch;
    const clockwise = transformNotes([source], 'rotate-clockwise')[0].patch;
    const counterclockwise = transformNotes([source], 'rotate-counterclockwise')[0].patch;

    expect(horizontal).toMatchObject({ position: 7, slide: { command: '>', endPosition: 4 } });
    expect(vertical).toMatchObject({ position: 3, slide: { command: '<', endPosition: 8 } });
    expect(clockwise).toMatchObject({ position: 3, slide: { command: '>', endPosition: 6 } });
    expect(counterclockwise).toMatchObject({ position: 1, slide: { command: '<', endPosition: 4 } });
    for (const patch of [horizontal, vertical, clockwise, counterclockwise]) {
      expect(patch.slide).toMatchObject({ head: 'tap', slideBreak: true, wait: source.slide!.wait, move: source.slide!.move });
    }
    expect(source).toEqual(original);

    const wifi = transformNotes([slideNote('w', 1, 'w', 5)], 'rotate-clockwise')[0].patch;
    expect(wifi).toMatchObject({ position: 2, slide: { command: 'w', endPosition: 6 } });
  });

  it('preserves the serialized -<> path geometry for all 21 paths, start lanes, and transforms', () => {
    const originalPathCount = ['-', '<', '>'].reduce((count, command) => count + Object.keys(slidePaths.commands[command]).length, 0);
    expect(originalPathCount).toBe(21);
    const transforms: ChartTransform[] = [
      'mirror-horizontal', 'mirror-vertical', 'rotate-clockwise', 'rotate-counterclockwise',
    ];
    for (const command of ['-', '<', '>'] as const) {
      for (const distance of Object.keys(slidePaths.commands[command]).map(Number)) {
        for (let start = 1; start <= 8; start += 1) {
          const end = ((start - 1 + distance) % 8) + 1;
          const source = slideNote(`${command}-${distance}-${start}`, start, command, end);
          const sourcePoints = serializedSlidePath(command, start, end);
          for (const transform of transforms) {
            const patch = transformNotes([source], transform)[0].patch;
            const transformedSlide = patch.slide!;
            const targetPoints = serializedSlidePath(transformedSlide.command, patch.position, transformedSlide.endPosition);
            expect(targetPoints).toHaveLength(sourcePoints.length);
            sourcePoints.forEach((point, index) => {
              const expected = applyGeometry(point, transform);
              expect(targetPoints[index][0]).toBeCloseTo(expected[0], 4);
              expect(targetPoints[index][1]).toBeCloseTo(expected[1], 4);
            });
          }
        }
      }
    }
  });

  it('preserves v/s/z path mappings and their source transform rules', () => {
    expect(Object.keys(slidePaths.paths)).toHaveLength(29);
    const transforms: ChartTransform[] = [
      'mirror-horizontal', 'mirror-vertical', 'rotate-clockwise', 'rotate-counterclockwise',
    ];
    const paths = [
      { command: 'v' as const, distances: [1, 2, 3, 5, 6, 7] },
      { command: 's' as const, distances: [4] },
      { command: 'z' as const, distances: [4] },
    ];
    for (const { command, distances } of paths) {
      for (const distance of distances) {
        for (let start = 1; start <= 8; start += 1) {
          const end = ((start - 1 + distance) % 8) + 1;
          const source = slideNote(`${command}-${distance}-${start}`, start, command, end);
          const sourcePoints = serializedSlidePath(command, start, end);
          for (const transform of transforms) {
            const patch = transformNotes([source], transform)[0].patch;
            const transformedSlide = patch.slide!;
            const mirrored = transform === 'mirror-horizontal' || transform === 'mirror-vertical';
            const expectedCommand = mirrored && (command === 's' || command === 'z')
              ? command === 's' ? 'z' : 's'
              : command;
            expect(transformedSlide.command).toBe(expectedCommand);
            expect(patch.position).toBe(mapLane(start, transform));
            expect(transformedSlide.endPosition).toBe(mapLane(end, transform));

            const targetPoints = serializedSlidePath(transformedSlide.command, patch.position!, transformedSlide.endPosition);
            expect(targetPoints).toHaveLength(sourcePoints.length);
            let maxError = 0;
            sourcePoints.forEach((point, index) => {
              const expected = applyGeometry(point, transform);
              maxError = Math.max(maxError, Math.hypot(targetPoints[index][0] - expected[0], targetPoints[index][1] - expected[1]));
            });
            // Unity's serialized s/z point sets are close to, but not exact reflections.
            expect(maxError).toBeLessThanOrEqual(mirrored && command !== 'v' ? 0.038 : 0.0001);
          }
        }
      }
    }
  });

  it('transforms every continuation from the preceding endpoint and preserves its path geometry', () => {
    const source = slideNote('connected', 2, '<', 5);
    source.slide!.continuations = [{ command: '>', endPosition: 7 }];
    const originalSegments = [
      { command: '<', start: 2, end: 5 },
      { command: '>', start: 5, end: 7 },
    ] as const;
    for (const transform of ['mirror-horizontal', 'mirror-vertical', 'rotate-clockwise', 'rotate-counterclockwise'] as const) {
      const patch = transformNotes([source], transform)[0].patch;
      const transformed = patch.slide!;
      const routes = [
        { command: transformed.command, end: transformed.endPosition },
        ...(transformed.continuations ?? []).map(({ command, endPosition }) => ({ command, end: endPosition })),
      ];
      let start = patch.position!;
      expect(routes).toHaveLength(originalSegments.length);
      originalSegments.forEach((segment, index) => {
        expect(start).toBe(index === 0 ? patch.position : routes[index - 1].end);
        const before = serializedSlidePath(segment.command, segment.start, segment.end);
        const after = serializedSlidePath(routes[index].command, start, routes[index].end);
        expect(after).toHaveLength(before.length);
        before.forEach((point, pointIndex) => {
          const expected = applyGeometry(point, transform);
          expect(after[pointIndex][0]).toBeCloseTo(expected[0], 4);
          expect(after[pointIndex][1]).toBeCloseTo(expected[1], 4);
        });
        start = routes[index].end;
      });
    }
  });

  it('rejects Slide forms outside the modeled single-segment command and endpoint range', () => {
    const badCommand = slideNote('bad-command', 1, '-', 5);
    badCommand.slide!.command = 'V' as '-' | '<' | '>' | 'w';
    const badEndpoint = slideNote('bad-end', 1, '-', 5);
    badEndpoint.slide!.endPosition = 9;
    const missingPath = { ...slideNote('missing-path', 1, '-', 5), slide: undefined };

    expect(() => transformNotes([badCommand], 'mirror-horizontal')).toThrow('Slide command is not modeled for transforms');
    expect(() => transformNotes([badEndpoint], 'mirror-horizontal')).toThrow('Slide endpoints use positions 1–8');
    expect(() => transformNotes([missingPath], 'mirror-horizontal')).toThrow('Slide notes need path data');
  });
});
