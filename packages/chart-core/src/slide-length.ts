import generated from './slide-path-lengths.json';
import type { SlideSegmentData } from './types.js';

interface SlideLengthData {
  lengths: Record<string, Record<string, number>>;
}

const lengths = (generated as unknown as SlideLengthData).lengths;

/** Returns the serialized Visual Maimai path length for a command between two lanes. */
export function slideSegmentLength(segment: SlideSegmentData, startPosition: number): number {
  let distance = segment.endPosition - startPosition;
  if (distance < 0) distance += 8;
  const command = startPosition >= 3 && startPosition <= 6
    ? segment.command === '<' ? '>' : segment.command === '>' ? '<' : segment.command
    : segment.command;
  const length = lengths[command]?.[String(distance)];
  if (length === undefined || !Number.isFinite(length) || length <= 0)
    throw new RangeError(`No serialized Visual Maimai path length for ${segment.command} ${startPosition}→${segment.endPosition}`);
  return length;
}
