export interface WaveformLevel {
  samplesPerBin: number;
  min: Float32Array[];
  max: Float32Array[];
}

export interface WaveformPyramid {
  sampleRateHz: number;
  frameCount: number;
  samplesPerBaseBin: number;
  levels: WaveformLevel[];
  byteLength: number;
}

export interface WaveformOptions {
  maxBaseBins?: number;
  maxOutputBytes?: number;
  yieldEveryBins?: number;
  signal?: AbortSignal;
}

export interface PcmAudioBuffer {
  length: number;
  numberOfChannels: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

export interface WaveformBaseChunk {
  min: Float32Array[];
  max: Float32Array[];
}

export const DEFAULT_WAVEFORM_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_BASE_BINS = 16_384;
const WORKER_CHUNK_BINS = 512;

export async function buildWaveformPyramid(
  channels: readonly Float32Array[],
  sampleRateHz: number,
  frameCount: number,
  options: WaveformOptions = {},
): Promise<WaveformPyramid> {
  if (channels.length === 0 || !Number.isInteger(frameCount) || frameCount <= 0) {
    throw new Error('波形输入不能为空');
  }
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) throw new Error('采样率无效');

  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_WAVEFORM_OUTPUT_BYTES;
  const maxBaseBins = options.maxBaseBins ?? DEFAULT_MAX_BASE_BINS;
  const budgetedBins = Math.floor(maxOutputBytes / (channels.length * 16));
  if (budgetedBins < 1) throw new Error('波形摘要预算不足');
  if (channels.some((channel) => channel.length < frameCount)) throw new Error('PCM 通道长度不足');
  const samplesPerBaseBin = Math.max(
    1,
    Math.ceil(frameCount / Math.min(maxBaseBins, budgetedBins)),
  );
  const yieldEveryBins = Math.max(1, options.yieldEveryBins ?? 512);
  const baseBinCount = Math.ceil(frameCount / samplesPerBaseBin);
  const min = channels.map(() => new Float32Array(baseBinCount));
  const max = channels.map(() => new Float32Array(baseBinCount));
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
    const samples = channels[channelIndex];
    for (let bin = 0; bin < baseBinCount; bin += 1) {
      if (options.signal?.aborted) throw new DOMException('波形计算已取消', 'AbortError');
      const start = bin * samplesPerBaseBin;
      const end = Math.min(frameCount, start + samplesPerBaseBin, samples.length);
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (let frame = start; frame < end; frame += 1) {
        const value = samples[frame];
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
      min[channelIndex][bin] = end > start ? lo : 0;
      max[channelIndex][bin] = end > start ? hi : 0;
      if ((bin + 1) % yieldEveryBins === 0) await yieldToEventLoop();
    }
  }

  return assembleWaveformPyramid(sampleRateHz, frameCount, samplesPerBaseBin, min, max, maxOutputBytes);
}

export function summarizeWaveformChunk(
  channels: readonly Float32Array[],
  frameCount: number,
  samplesPerBaseBin: number,
): WaveformBaseChunk {
  if (channels.length === 0 || !Number.isInteger(frameCount) || frameCount <= 0) throw new Error('波形分块不能为空');
  if (!Number.isInteger(samplesPerBaseBin) || samplesPerBaseBin <= 0) throw new Error('波形分块基元无效');
  if (channels.some((channel) => channel.length < frameCount)) throw new Error('PCM 分块通道长度不足');
  const binCount = Math.ceil(frameCount / samplesPerBaseBin);
  const min = channels.map(() => new Float32Array(binCount));
  const max = channels.map(() => new Float32Array(binCount));
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
    const samples = channels[channelIndex];
    for (let bin = 0; bin < binCount; bin += 1) {
      const start = bin * samplesPerBaseBin;
      const end = Math.min(frameCount, start + samplesPerBaseBin, samples.length);
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (let frame = start; frame < end; frame += 1) {
        const value = samples[frame];
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
      min[channelIndex][bin] = end > start ? lo : 0;
      max[channelIndex][bin] = end > start ? hi : 0;
    }
  }
  return { min, max };
}

function assembleWaveformPyramid(
  sampleRateHz: number,
  frameCount: number,
  samplesPerBaseBin: number,
  baseMin: Float32Array[],
  baseMax: Float32Array[],
  maxOutputBytes: number,
): WaveformPyramid {
  const levels: WaveformLevel[] = [{ samplesPerBin: samplesPerBaseBin, min: baseMin, max: baseMax }];
  let previous = levels[0];
  while (previous.min[0].length > 1) {
    const nextCount = Math.ceil(previous.min[0].length / 2);
    const nextMin = previous.min.map(() => new Float32Array(nextCount));
    const nextMax = previous.max.map(() => new Float32Array(nextCount));
    for (let channelIndex = 0; channelIndex < previous.min.length; channelIndex += 1) {
      for (let bin = 0; bin < nextCount; bin += 1) {
        const left = bin * 2;
        const right = left + 1;
        nextMin[channelIndex][bin] = right < previous.min[channelIndex].length
          ? Math.min(previous.min[channelIndex][left], previous.min[channelIndex][right])
          : previous.min[channelIndex][left];
        nextMax[channelIndex][bin] = right < previous.max[channelIndex].length
          ? Math.max(previous.max[channelIndex][left], previous.max[channelIndex][right])
          : previous.max[channelIndex][left];
      }
    }
    previous = {
      samplesPerBin: levels[levels.length - 1].samplesPerBin * 2,
      min: nextMin,
      max: nextMax,
    };
    levels.push(previous);
  }

  const byteLength = levels.reduce((sum, level) => sum + level.min.reduce((n, bins) => n + bins.byteLength, 0)
    + level.max.reduce((n, bins) => n + bins.byteLength, 0), 0);
  if (byteLength > maxOutputBytes) throw new Error('波形摘要超出内存预算');
  return { sampleRateHz, frameCount, samplesPerBaseBin, levels, byteLength };
}

/** Copies and transfers one bounded frame chunk at a time to a dedicated worker. */
export class WaveformWorkerClient {
  private readonly worker: Worker;
  private nextId = 1;
  private pending: { id: number; startBin: number; resolve: (chunk: WaveformBaseChunk & { startBin: number }) => void; reject: (error: Error) => void } | null = null;
  private building = false;
  private disposed = false;

  constructor(worker: Worker = new Worker(new URL('./waveform.worker.ts', import.meta.url), { type: 'module' })) {
    this.worker = worker;
    this.worker.onmessage = (event: MessageEvent<{ id: number; startBin: number; min?: Float32Array[]; max?: Float32Array[]; error?: string }>) => {
      if (!this.pending || event.data.id !== this.pending.id) return;
      const pending = this.pending;
      this.pending = null;
      if (event.data.error || !event.data.min || !event.data.max) pending.reject(new Error(event.data.error ?? '波形分块计算失败'));
      else pending.resolve({ startBin: event.data.startBin, min: event.data.min, max: event.data.max });
    };
    this.worker.onerror = (event) => {
      const pending = this.pending;
      this.pending = null;
      pending?.reject(new Error(event.message || '波形 Worker 失败'));
    };
  }

  async build(audioBuffer: PcmAudioBuffer, maxInputCopyBytes = 128 * 1024 * 1024): Promise<WaveformPyramid> {
    if (this.disposed) throw new Error('波形 Worker 已关闭');
    if (this.building) throw new Error('已有波形任务正在处理');
    const pcmBytes = audioBuffer.length * audioBuffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
    if (pcmBytes > maxInputCopyBytes) throw new Error('音频过大，跳过波形计算以控制 PCM 副本内存');
    this.building = true;
    try {
      const maxOutputBytes = DEFAULT_WAVEFORM_OUTPUT_BYTES;
      const budgetedBins = Math.floor(maxOutputBytes / (audioBuffer.numberOfChannels * 16));
      if (budgetedBins < 1) throw new Error('波形摘要预算不足');
      const samplesPerBaseBin = Math.max(1, Math.ceil(audioBuffer.length / Math.min(DEFAULT_MAX_BASE_BINS, budgetedBins)));
      const baseBinCount = Math.ceil(audioBuffer.length / samplesPerBaseBin);
      const min = Array.from({ length: audioBuffer.numberOfChannels }, () => new Float32Array(baseBinCount));
      const max = Array.from({ length: audioBuffer.numberOfChannels }, () => new Float32Array(baseBinCount));

      for (let startBin = 0; startBin < baseBinCount; startBin += WORKER_CHUNK_BINS) {
        if (this.disposed) throw new Error('波形 Worker 已关闭');
        const binsInChunk = Math.min(WORKER_CHUNK_BINS, baseBinCount - startBin);
        const startFrame = startBin * samplesPerBaseBin;
        const frameCount = Math.min(audioBuffer.length - startFrame, binsInChunk * samplesPerBaseBin);
        const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, channel) =>
          audioBuffer.getChannelData(channel).subarray(startFrame, startFrame + frameCount).slice());
        const chunk = await this.requestChunk(startBin, samplesPerBaseBin, frameCount, channels);
        for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
          min[channel].set(chunk.min[channel], chunk.startBin);
          max[channel].set(chunk.max[channel], chunk.startBin);
        }
        await yieldToEventLoop();
      }

      return assembleWaveformPyramid(audioBuffer.sampleRate, audioBuffer.length, samplesPerBaseBin, min, max, maxOutputBytes);
    } finally {
      this.building = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.terminate();
    this.pending?.reject(new Error('波形 Worker 已关闭'));
    this.pending = null;
  }

  private requestChunk(
    startBin: number,
    samplesPerBaseBin: number,
    frameCount: number,
    channels: Float32Array[],
  ): Promise<WaveformBaseChunk & { startBin: number }> {
    if (this.disposed) return Promise.reject(new Error('波形 Worker 已关闭'));
    const id = this.nextId++;
    const transfer = channels.map((channel) => channel.buffer as ArrayBuffer);
    return new Promise((resolve, reject) => {
      this.pending = { id, startBin, resolve, reject };
      try {
        this.worker.postMessage({ id, startBin, samplesPerBaseBin, frameCount, channels: transfer }, transfer);
      } catch (cause) {
        this.pending = null;
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
