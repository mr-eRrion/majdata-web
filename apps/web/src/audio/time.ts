import type { ChartLoop, PlaybackRate } from './types';

export interface ClockAnchor {
  contextTime: number;
  songSeconds: number;
}

export interface SongLoop {
  startSongSeconds: number;
  endSongSeconds: number;
}

export function chartToSongSeconds(chartSeconds: number, firstOffsetSeconds: number): number {
  return chartSeconds + firstOffsetSeconds;
}

export function songToChartSeconds(songSeconds: number, firstOffsetSeconds: number): number {
  return songSeconds - firstOffsetSeconds;
}

export function songSecondsAtContextTime(
  anchor: ClockAnchor,
  contextTime: number,
  playbackRate: PlaybackRate,
): number {
  return anchor.songSeconds + (contextTime - anchor.contextTime) * playbackRate;
}

export function wrapSongSeconds(songSeconds: number, loop: SongLoop | null): number {
  if (!loop || songSeconds < loop.endSongSeconds) return songSeconds;
  const length = loop.endSongSeconds - loop.startSongSeconds;
  if (!(length > 0)) return songSeconds;
  const afterEnd = songSeconds - loop.endSongSeconds;
  return loop.startSongSeconds + (afterEnd % length);
}

export function chartSecondsAtContextTime(
  anchor: ClockAnchor,
  contextTime: number,
  playbackRate: PlaybackRate,
  firstOffsetSeconds: number,
  loop: SongLoop | null,
): number {
  const raw = songSecondsAtContextTime(anchor, contextTime, playbackRate);
  return songToChartSeconds(wrapSongSeconds(raw, loop), firstOffsetSeconds);
}

export function loopToSongRange(loop: ChartLoop, firstOffsetSeconds: number): SongLoop {
  return {
    startSongSeconds: chartToSongSeconds(loop.startChartSeconds, firstOffsetSeconds),
    endSongSeconds: chartToSongSeconds(loop.endChartSeconds, firstOffsetSeconds),
  };
}

export function lowerBoundByChartSeconds<T extends { chartSeconds: number }>(
  sorted: readonly T[],
  chartSeconds: number,
): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = low + ((high - low) >>> 1);
    if (sorted[middle].chartSeconds < chartSeconds) low = middle + 1;
    else high = middle;
  }
  return low;
}

