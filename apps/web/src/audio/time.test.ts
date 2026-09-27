import { describe, expect, it } from 'vitest';
import { chartSecondsAtContextTime, chartToSongSeconds, lowerBoundByChartSeconds, songSecondsAtContextTime, songToChartSeconds, wrapSongSeconds } from './time';
import { buildWaveformPyramid, summarizeWaveformChunk } from './waveform';

describe('audio time mapping', () => {
  it('keeps chart time and positive or negative first offset in separate coordinates', () => {
    expect(chartToSongSeconds(0, -0.25)).toBe(-0.25);
    expect(chartToSongSeconds(0.5, 0.25)).toBe(0.75);
    expect(songToChartSeconds(-0.25, -0.25)).toBe(0);
  });

  it('derives position from the AudioContext anchor and current rate', () => {
    const anchor = { contextTime: 4, songSeconds: -0.2 };
    expect(songSecondsAtContextTime(anchor, 4.4, 0.5)).toBeCloseTo(0);
    expect(songSecondsAtContextTime(anchor, 4.4, 2)).toBeCloseTo(0.6);
    expect(chartSecondsAtContextTime(anchor, 4.4, 0.5, -0.2, null)).toBeCloseTo(0.2);
  });

  it('wraps song position at the chart loop end, including virtual negative pre-roll', () => {
    expect(wrapSongSeconds(1.25, { startSongSeconds: 0.2, endSongSeconds: 0.5 })).toBeCloseTo(0.35);
    expect(wrapSongSeconds(-0.1, { startSongSeconds: 0.2, endSongSeconds: 0.5 })).toBe(-0.1);
  });

  it('binary-searches sorted cue times', () => {
    const events = [{ chartSeconds: 0 }, { chartSeconds: 1 }, { chartSeconds: 1 }, { chartSeconds: 2 }];
    expect(lowerBoundByChartSeconds(events, 1)).toBe(1);
    expect(lowerBoundByChartSeconds(events, 1.5)).toBe(3);
  });
});

describe('bounded waveform summaries', () => {
  it('starts at block extrema and builds a small min/max pyramid', async () => {
    const summary = await buildWaveformPyramid([
      Float32Array.from([-1, 0.25, 0.5, -0.5, 1, -0.25, 0.75, 0]),
    ], 48_000, 8, { maxBaseBins: 4, maxOutputBytes: 1024, yieldEveryBins: 1 });
    expect(summary.samplesPerBaseBin).toBe(2);
    expect(Array.from(summary.levels[0].min[0])).toEqual([-1, -0.5, -0.25, 0]);
    expect(Array.from(summary.levels[0].max[0])).toEqual([0.25, 0.5, 1, 0.75]);
    expect(summary.levels.at(-1)?.min[0].length).toBe(1);
    expect(summary.byteLength).toBeLessThanOrEqual(1024);
  });

  it('summarizes bounded worker chunks with the same base-bin extrema', () => {
    const chunk = summarizeWaveformChunk([Float32Array.from([-1, 0.25, -0.5, 0.75])], 3, 2);
    expect(Array.from(chunk.min[0])).toEqual([-1, -0.5]);
    expect(Array.from(chunk.max[0])).toEqual([0.25, -0.5]);
  });
});
