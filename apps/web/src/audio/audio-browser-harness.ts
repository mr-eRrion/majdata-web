import { AudioTransport } from './transport';
import type { PlaybackRate } from './types';

export interface AudioBrowserHarnessReport {
  userAgent: string;
  loaded: { durationSeconds: number; sampleRateHz: number; channelCount: number; decodedBytes: number };
  waveformSummary: { baseBinsPerChannel: number; levels: number; byteLength: number; samplesPerBaseBin: number };
  offsetCases: Array<{ firstOffsetSeconds: number; chartSeconds: number; songSeconds: number }>;
  negativePreRoll: { startSongSeconds: number; after100msSongSeconds: number; remainedVirtualBeforeSampleZero: boolean };
  softwareRateMeasurements: Array<{ rate: PlaybackRate; wallSeconds: number; chartDeltaSeconds: number }>;
  loopResult: { startChartSeconds: number; endChartSeconds: number; chartSecondsAfterPlayback: number; withinRange: boolean };
  pauseDriftSeconds: number;
  outputTimestampAvailable: boolean;
  estimatedAudibleChartSeconds: number | null;
  physicalOutputMeasured: false;
}

/** Runs a short browser-only check against the self-generated reference WAV. */
export async function runAudioBrowserHarness(file?: Blob): Promise<AudioBrowserHarnessReport> {
  let reference: Blob;
  if (file) {
    reference = file;
  } else {
    const response = await fetch(new URL('../../../../fixtures/audio/reference-tone.wav', import.meta.url));
    if (!response.ok) throw new Error(`无法载入参考 WAV：${response.status}`);
    reference = await response.blob();
  }
  const transport = new AudioTransport({
    scheduleAheadSeconds: 0.12,
    schedulerIntervalMs: 20,
    metadataReader: async () => ({ durationSeconds: 10, channelCount: 2 }),
  });

  try {
    const loadResult = await transport.load(reference, 'reference-tone.wav', { durationSeconds: 10, channelCount: 2 });
    if (loadResult.status !== 'loaded') throw new Error(loadResult.status === 'rejected' ? loadResult.error.message : '参考音轨被替换');
    const loaded = {
      durationSeconds: loadResult.track.durationSeconds,
      sampleRateHz: loadResult.track.sampleRateHz,
      channelCount: loadResult.track.channelCount,
      decodedBytes: loadResult.track.decodedBytes,
    };
    const waveform = await transport.buildCurrentWaveform();
    if (!waveform) throw new Error('换歌导致旧波形摘要被错误接受');
    const waveformSummary = {
      baseBinsPerChannel: waveform.levels[0].min[0].length,
      levels: waveform.levels.length,
      byteLength: waveform.byteLength,
      samplesPerBaseBin: waveform.samplesPerBaseBin,
    };

    const offsetCases: AudioBrowserHarnessReport['offsetCases'] = [];
    for (const firstOffsetSeconds of [-0.25, 0.25]) {
      transport.setFirstOffsetSeconds(firstOffsetSeconds);
      transport.seekChartSeconds(0.5);
      const snapshot = transport.getSnapshot();
      const expectedSongSeconds = 0.5 + firstOffsetSeconds;
      if (Math.abs(snapshot.songSeconds - expectedSongSeconds) > 1e-6) throw new Error('谱面时间与歌曲时间换算错误');
      offsetCases.push({ firstOffsetSeconds, chartSeconds: snapshot.chartSeconds, songSeconds: snapshot.songSeconds });
    }

    transport.setFirstOffsetSeconds(-0.25);
    transport.seekChartSeconds(0);
    transport.setCues([
      { id: 'pre-roll', chartSeconds: 0, frequencyHz: 660 },
      { id: 'tap-a', chartSeconds: 0.3, frequencyHz: 880 },
      { id: 'tap-b', chartSeconds: 0.8, frequencyHz: 990 },
    ]);
    const beforePreRoll = transport.getSnapshot().songSeconds;
    await transport.play();
    await delay(100);
    const afterPreRoll = transport.getSnapshot().songSeconds;
    transport.pause();
    const negativePreRoll = {
      startSongSeconds: beforePreRoll,
      after100msSongSeconds: afterPreRoll,
      remainedVirtualBeforeSampleZero: beforePreRoll < 0 && afterPreRoll < 0,
    };
    if (!negativePreRoll.remainedVirtualBeforeSampleZero) throw new Error('负预滚未保持虚拟歌曲位置');

    const softwareRateMeasurements: AudioBrowserHarnessReport['softwareRateMeasurements'] = [];
    for (const rate of [0.5, 2] as const) {
      transport.setFirstOffsetSeconds(0);
      transport.seekChartSeconds(1);
      transport.setPlaybackRate(rate);
      await transport.play();
      const start = transport.getSnapshot();
      const wallStart = performance.now();
      const wallSeconds = rate === 0.5 ? 0.24 : 0.14;
      await delay(wallSeconds * 1000);
      const end = transport.getSnapshot();
      transport.pause();
      const elapsedWallSeconds = (performance.now() - wallStart) / 1000;
      const chartDeltaSeconds = end.chartSeconds - start.chartSeconds;
      const expected = elapsedWallSeconds * rate;
      if (Math.abs(chartDeltaSeconds - expected) > Math.max(0.06, expected * 0.4)) {
        throw new Error(`${rate}x 软件时钟速度偏差过大`);
      }
      softwareRateMeasurements.push({ rate, wallSeconds: elapsedWallSeconds, chartDeltaSeconds });
    }

    transport.setFirstOffsetSeconds(-0.1);
    transport.setLoop({ startChartSeconds: 0.3, endChartSeconds: 0.6 });
    transport.seekChartSeconds(0.55);
    transport.setPlaybackRate(2);
    await transport.play();
    await delay(400);
    const afterLoop = transport.getSnapshot();
    transport.pause();
    const loopResult = {
      startChartSeconds: 0.3,
      endChartSeconds: 0.6,
      chartSecondsAfterPlayback: afterLoop.chartSeconds,
      withinRange: afterLoop.chartSeconds >= 0.3 && afterLoop.chartSeconds < 0.6,
    };
    if (!loopResult.withinRange) throw new Error('循环播放头未回到循环区间');

    const pauseAt = transport.getSnapshot().chartSeconds;
    await delay(100);
    const pauseDriftSeconds = transport.getSnapshot().chartSeconds - pauseAt;
    if (Math.abs(pauseDriftSeconds) > 1e-9) throw new Error('暂停后软件播放头仍在移动');

    return {
      userAgent: navigator.userAgent,
      loaded,
      waveformSummary,
      offsetCases,
      negativePreRoll,
      softwareRateMeasurements,
      loopResult,
      pauseDriftSeconds,
      outputTimestampAvailable: typeof transport.context.getOutputTimestamp === 'function',
      estimatedAudibleChartSeconds: afterLoop.estimatedAudibleChartSeconds,
      physicalOutputMeasured: false,
    };
  } finally {
    transport.dispose();
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
