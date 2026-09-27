import { LatestDecodeQueue } from './decode-queue';
import { chartSecondsAtContextTime, chartToSongSeconds, loopToSongRange, songToChartSeconds } from './time';
import { CueSynth } from './synth';
import { WaveformWorkerClient } from './waveform';
import type { WaveformPyramid } from './waveform';
import type {
  AudioCue,
  AudioLoadResult,
  AudioMetadataHint,
  AudioSnapshot,
  AudioTrackMetadata,
  AudioTransportOptions,
  ChartLoop,
  PlaybackRate,
  PlaybackState,
} from './types';
import type { ClockAnchor, SongLoop } from './time';

interface TrackCandidate {
  file: Blob;
  name: string;
  metadataHint?: AudioMetadataHint;
}

interface DecodedTrack {
  buffer: AudioBuffer;
  metadata: AudioTrackMetadata;
}

const DEFAULT_MAX_DURATION_SECONDS = 5 * 60;
const DEFAULT_MAX_DECODED_BYTES = 256 * 1024 * 1024;
const CUE_EPSILON_SECONDS = 0.0005;

/** One Web Audio clock owns song transport and schedules all preview sounds. */
export class AudioTransport {
  readonly context: AudioContext;
  private readonly ownsContext: boolean;
  private readonly synth: CueSynth;
  private readonly decodeQueue: LatestDecodeQueue<TrackCandidate, DecodedTrack>;
  private readonly maxDurationSeconds: number;
  private readonly maxDecodedBytes: number;
  private readonly scheduleAheadSeconds: number;
  private readonly schedulerIntervalMs: number;
  private readonly onChange?: AudioTransportOptions['onChange'];
  private readonly metadataReader: NonNullable<AudioTransportOptions['metadataReader']>;
  private readonly decoder: NonNullable<AudioTransportOptions['decoder']>;

  private buffer: AudioBuffer | null = null;
  private track: AudioTrackMetadata | null = null;
  private state: PlaybackState = 'paused';
  private firstOffsetSeconds = 0;
  private outputCalibrationSeconds = 0;
  private playbackRate: PlaybackRate = 1;
  private loop: ChartLoop | null = null;
  private anchor: ClockAnchor | null = null;
  private pausedSongSeconds = 0;
  private playbackGeneration = 0;
  private source: AudioBufferSourceNode | null = null;
  private cues: AudioCue[] = [];
  private scheduledCueKeys = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private playRequestGeneration = 0;
  private trackGeneration = 0;
  private waveformBuildPending = false;
  private waveformWorker: WaveformWorkerClient | null = null;

  constructor(options: AudioTransportOptions = {}) {
    const AudioContextConstructor = globalThis.AudioContext;
    if (options.context) {
      this.context = options.context;
      this.ownsContext = false;
    } else if (AudioContextConstructor) {
      this.context = new AudioContextConstructor();
      this.ownsContext = true;
    } else {
      throw new Error('当前环境不支持 Web Audio');
    }

    this.maxDurationSeconds = options.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS;
    this.maxDecodedBytes = options.maxDecodedBytes ?? DEFAULT_MAX_DECODED_BYTES;
    this.scheduleAheadSeconds = options.scheduleAheadSeconds ?? 0.15;
    this.schedulerIntervalMs = options.schedulerIntervalMs ?? 25;
    this.outputCalibrationSeconds = options.outputCalibrationSeconds ?? 0;
    this.onChange = options.onChange;
    this.metadataReader = options.metadataReader ?? readBrowserAudioMetadata;
    this.decoder = options.decoder ?? ((bytes, context) => context.decodeAudioData(bytes));
    this.synth = new CueSynth(this.context);

    this.decodeQueue = new LatestDecodeQueue(
      (candidate, isCurrent) => this.decodeCandidate(candidate, isCurrent),
      {
        onSelection: () => this.releaseCurrentTrack(),
        onAccepted: (decoded) => {
          this.buffer = decoded.buffer;
          this.track = decoded.metadata;
          this.pausedSongSeconds = this.firstOffsetSeconds;
          this.loop = null;
          this.anchor = null;
          this.emitChange();
        },
      },
    );
  }

  load(file: Blob, name = 'audio', metadataHint?: AudioMetadataHint): Promise<AudioLoadResult> {
    this.assertUsable();
    return this.decodeQueue.submit({ file, name, metadataHint }).then((result): AudioLoadResult => {
      if (result.status === 'completed') return { status: 'loaded', generation: result.generation, track: result.value.metadata };
      if (result.status === 'superseded') return result;
      return { status: 'rejected', generation: result.generation, error: result.error };
    });
  }

  async play(): Promise<void> {
    this.assertUsable();
    if (this.state === 'playing') return;
    const requestGeneration = ++this.playRequestGeneration;
    await this.context.resume();
    if (this.disposed || requestGeneration !== this.playRequestGeneration) return;
    if (this.buffer && !this.loop && this.pausedSongSeconds >= this.buffer.duration) {
      this.pausedSongSeconds = this.buffer.duration;
      this.emitChange();
      return;
    }
    const now = this.context.currentTime;
    this.playbackGeneration += 1;
    this.anchor = { contextTime: now, songSeconds: this.pausedSongSeconds };
    this.state = 'playing';
    this.startMusicSource(now, this.playbackGeneration);
    this.startScheduler();
    this.scheduleUpcomingCues(now);
    this.emitChange();
  }

  pause(): void {
    this.assertUsable();
    this.playRequestGeneration += 1;
    if (this.state === 'paused') return;
    this.pausedSongSeconds = this.readSongSeconds(this.context.currentTime);
    this.state = 'paused';
    this.anchor = null;
    this.playbackGeneration += 1;
    this.stopScheduler();
    this.stopPlaybackNodes();
    this.emitChange();
  }

  seekChartSeconds(chartSeconds: number): void {
    this.assertUsable();
    if (!Number.isFinite(chartSeconds)) throw new Error('seek 时间必须是有限数值');
    this.reanchor(chartToSongSeconds(chartSeconds, this.firstOffsetSeconds));
  }

  setPlaybackRate(rate: PlaybackRate): void {
    this.assertUsable();
    if (rate !== 0.5 && rate !== 1 && rate !== 2) throw new Error('只支持 0.5、1、2 倍速');
    if (rate === this.playbackRate) return;
    const songSeconds = this.readSongSeconds(this.context.currentTime);
    this.playbackRate = rate;
    this.reanchor(songSeconds);
  }

  setFirstOffsetSeconds(offsetSeconds: number): void {
    this.assertUsable();
    if (!Number.isFinite(offsetSeconds)) throw new Error('first 偏移必须是有限数值');
    const chartSeconds = this.readChartSeconds(this.context.currentTime);
    const nextSongSeconds = chartToSongSeconds(chartSeconds, offsetSeconds);
    const nextLoopRange = this.loop ? loopToSongRange(this.loop, offsetSeconds) : null;
    this.validateLoopSongRange(nextLoopRange);
    this.firstOffsetSeconds = offsetSeconds;
    this.reanchor(nextSongSeconds);
  }

  /** Positive values move the calibrated display cursor forward; cue timing stays unchanged. */
  setOutputCalibrationSeconds(calibrationSeconds: number): void {
    this.assertUsable();
    if (!Number.isFinite(calibrationSeconds) || Math.abs(calibrationSeconds) > 2) {
      throw new Error('设备校准值需为 -2 到 2 秒之间的有限数值');
    }
    this.outputCalibrationSeconds = calibrationSeconds;
    this.emitChange();
  }

  setLoop(loop: ChartLoop | null): void {
    this.assertUsable();
    const next = loop ? { ...loop } : null;
    if (next) {
      if (!Number.isFinite(next.startChartSeconds) || !Number.isFinite(next.endChartSeconds)) {
        throw new Error('循环边界必须是有限数值');
      }
      if (next.endChartSeconds - next.startChartSeconds < 0.05) throw new Error('循环长度至少为 0.05 秒');
      this.validateLoopSongRange(loopToSongRange(next, this.firstOffsetSeconds));
    }

    let songSeconds = this.readSongSeconds(this.context.currentTime);
    this.loop = next;
    if (next && this.readChartSeconds(this.context.currentTime) >= next.endChartSeconds) {
      songSeconds = chartToSongSeconds(next.startChartSeconds, this.firstOffsetSeconds);
    }
    this.reanchor(songSeconds);
  }

  setCues(cues: readonly AudioCue[]): void {
    this.assertUsable();
    this.cues = cues.map((cue) => {
      if (!cue.id || !Number.isFinite(cue.chartSeconds)) throw new Error('音效事件需要 id 和有限时间');
      return { ...cue };
    }).sort((a, b) => a.chartSeconds - b.chartSeconds || a.id.localeCompare(b.id));
    if (this.state === 'playing') {
      this.synth.stopAll();
      this.scheduledCueKeys.clear();
      this.scheduleUpcomingCues(this.context.currentTime);
    }
  }

  getSnapshot(): AudioSnapshot {
    const now = this.context.currentTime;
    const songSeconds = this.readSongSeconds(now);
    return {
      state: this.state,
      chartSeconds: songToChartSeconds(songSeconds, this.firstOffsetSeconds),
      songSeconds,
      estimatedAudibleChartSeconds: this.readEstimatedAudibleChartSeconds(),
      firstOffsetSeconds: this.firstOffsetSeconds,
      outputCalibrationSeconds: this.outputCalibrationSeconds,
      playbackRate: this.playbackRate,
      loop: this.loop ? { ...this.loop } : null,
      track: this.track ? { ...this.track } : null,
      playbackGeneration: this.playbackGeneration,
    };
  }

  /** Builds one bounded waveform summary, then releases its temporary worker and PCM copy. */
  async buildCurrentWaveform(maxInputCopyBytes = 128 * 1024 * 1024): Promise<WaveformPyramid | null> {
    this.assertUsable();
    if (!this.buffer) throw new Error('尚未载入歌曲');
    if (this.waveformBuildPending) throw new Error('当前歌曲已有波形任务正在处理');
    const trackGeneration = this.trackGeneration;
    const worker = new WaveformWorkerClient();
    this.waveformWorker = worker;
    this.waveformBuildPending = true;
    try {
      const summary = await worker.build(this.buffer, maxInputCopyBytes);
      return trackGeneration === this.trackGeneration ? summary : null;
    } finally {
      this.waveformBuildPending = false;
      if (this.waveformWorker === worker) this.waveformWorker = null;
      worker.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.playRequestGeneration += 1;
    this.trackGeneration += 1;
    this.decodeQueue.dispose();
    this.state = 'paused';
    this.anchor = null;
    this.stopScheduler();
    this.playbackGeneration += 1;
    this.stopPlaybackNodes();
    this.waveformWorker?.dispose();
    this.waveformWorker = null;
    this.buffer = null;
    this.track = null;
    this.cues = [];
    if (this.ownsContext && this.context.state !== 'closed') void this.context.close();
  }

  private async decodeCandidate(candidate: TrackCandidate, isCurrent: () => boolean): Promise<DecodedTrack> {
    const hint = candidate.metadataHint ?? await this.metadataReader(candidate.file, candidate.name);
    if (!isCurrent()) throw new Error('音频选择已替换');
    if (!Number.isFinite(hint.durationSeconds) || hint.durationSeconds <= 0) throw new Error('无法读取有效的音频时长');
    if (hint.durationSeconds > this.maxDurationSeconds) {
      throw new Error(`歌曲时长超过 ${this.maxDurationSeconds} 秒的首版限制`);
    }

    const hintedChannels = hint.channelCount ?? 2;
    if (!Number.isInteger(hintedChannels) || hintedChannels < 1 || hintedChannels > 32) throw new Error('音频声道数无效');
    const estimatedBytes = hint.durationSeconds * this.context.sampleRate * hintedChannels * Float32Array.BYTES_PER_ELEMENT;
    if (estimatedBytes > this.maxDecodedBytes) throw new Error('预估解码 PCM 超出音频内存预算');

    const encoded = await candidate.file.arrayBuffer();
    if (!isCurrent()) throw new Error('音频选择已替换');
    const buffer = await this.decoder(encoded, this.context);
    const decodedBytes = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
    if (buffer.duration > this.maxDurationSeconds || decodedBytes > this.maxDecodedBytes) {
      throw new Error('实际解码结果超出音频时长或 PCM 内存预算');
    }

    return {
      buffer,
      metadata: {
        name: candidate.name,
        durationSeconds: buffer.duration,
        sampleRateHz: buffer.sampleRate,
        channelCount: buffer.numberOfChannels,
        decodedBytes,
      },
    };
  }

  private releaseCurrentTrack(): void {
    this.playRequestGeneration += 1;
    this.trackGeneration += 1;
    this.waveformWorker?.dispose();
    this.waveformWorker = null;
    if (this.state === 'playing') {
      this.state = 'paused';
      this.stopScheduler();
      this.playbackGeneration += 1;
      this.stopPlaybackNodes();
    }
    this.anchor = null;
    this.pausedSongSeconds = this.firstOffsetSeconds;
    this.buffer = null;
    this.track = null;
    this.loop = null;
    this.emitChange();
  }

  private startMusicSource(now: number, generation: number): void {
    const buffer = this.buffer;
    if (!buffer) return;

    const songSeconds = this.pausedSongSeconds;
    const loopRange = this.currentSongLoopRange();
    if (loopRange && songSeconds >= loopRange.endSongSeconds) {
      this.pausedSongSeconds = loopRange.startSongSeconds;
      if (this.anchor) this.anchor.songSeconds = this.pausedSongSeconds;
    }
    const startSongSeconds = this.pausedSongSeconds;
    if (startSongSeconds >= buffer.duration) return;

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.setValueAtTime(this.playbackRate, now);
    if (loopRange) {
      source.loop = true;
      source.loopStart = loopRange.startSongSeconds;
      source.loopEnd = loopRange.endSongSeconds;
    }
    source.onended = () => {
      if (generation !== this.playbackGeneration || this.state !== 'playing' || this.loop) return;
      this.state = 'paused';
      this.pausedSongSeconds = buffer.duration;
      this.anchor = null;
      this.playbackGeneration += 1;
      this.stopScheduler();
      this.source = null;
      this.synth.stopAll();
      this.scheduledCueKeys.clear();
      this.emitChange();
    };
    source.connect(this.context.destination);
    this.source = source;

    // AudioBufferSourceNode offsets cannot be negative. Keep the chart clock virtual until s reaches zero.
    if (startSongSeconds < 0) {
      source.start(now + -startSongSeconds / this.playbackRate, 0);
    } else {
      source.start(now, startSongSeconds);
    }
  }

  private reanchor(songSeconds: number): void {
    const wasPlaying = this.state === 'playing';
    const now = this.context.currentTime;
    this.playbackGeneration += 1;
    this.stopPlaybackNodes();
    this.pausedSongSeconds = songSeconds;
    if (wasPlaying && this.buffer && !this.loop && songSeconds >= this.buffer.duration) {
      this.pausedSongSeconds = this.buffer.duration;
      this.state = 'paused';
      this.anchor = null;
      this.stopScheduler();
      this.emitChange();
      return;
    }
    if (wasPlaying) {
      this.anchor = { contextTime: now, songSeconds };
      this.startMusicSource(now, this.playbackGeneration);
      this.scheduleUpcomingCues(now);
    } else {
      this.anchor = null;
    }
    this.emitChange();
  }

  private readSongSeconds(contextTime: number): number {
    if (this.state !== 'playing' || !this.anchor) return this.pausedSongSeconds;
    const loop = this.currentSongLoopRange();
    return chartSecondsAtContextTime(this.anchor, contextTime, this.playbackRate, this.firstOffsetSeconds, loop)
      + this.firstOffsetSeconds;
  }

  private readChartSeconds(contextTime: number): number {
    return songToChartSeconds(this.readSongSeconds(contextTime), this.firstOffsetSeconds);
  }

  private currentSongLoopRange(): SongLoop | null {
    return this.loop ? loopToSongRange(this.loop, this.firstOffsetSeconds) : null;
  }

  private validateLoopSongRange(range: SongLoop | null): void {
    if (!range) return;
    if (range.startSongSeconds < 0 || !(range.endSongSeconds > range.startSongSeconds)) {
      throw new Error('循环映射到歌曲音频后必须位于非负时间');
    }
    if (this.track && range.endSongSeconds > this.track.durationSeconds) {
      throw new Error('循环结束点超出歌曲时长');
    }
  }

  private startScheduler(): void {
    this.stopScheduler();
    this.timer = setInterval(() => this.scheduleUpcomingCues(this.context.currentTime), this.schedulerIntervalMs);
  }

  private stopScheduler(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private scheduleUpcomingCues(now: number): void {
    if (this.state !== 'playing' || !this.anchor || this.cues.length === 0) return;
    for (const [key, expiresAt] of this.scheduledCueKeys) {
      if (expiresAt <= now) this.scheduledCueKeys.delete(key);
    }
    const rate = this.playbackRate;
    const loopRange = this.currentSongLoopRange();
    let segmentStartTime = now;
    let currentChart = this.readChartSeconds(now);
    let remainingSeconds = this.scheduleAheadSeconds;
    let iteration = 0;
    let isInitialPrefix = Boolean(loopRange && currentChart < this.loop!.startChartSeconds);

    while (remainingSeconds > 0 && iteration < 16) {
      iteration += 1;
      if (loopRange && currentChart >= this.loop!.endChartSeconds - CUE_EPSILON_SECONDS) {
        currentChart = this.loop!.startChartSeconds;
      }

      const secondsUntilLoopEnd = loopRange
        ? Math.max(0, (this.loop!.endChartSeconds - currentChart) / rate)
        : Number.POSITIVE_INFINITY;
      const segmentSeconds = Math.min(remainingSeconds, secondsUntilLoopEnd);
      if (!(segmentSeconds > CUE_EPSILON_SECONDS)) {
        if (!loopRange) break;
        currentChart = this.loop!.startChartSeconds;
        continue;
      }
      const segmentEndChart = currentChart + segmentSeconds * rate;
      const begin = lowerBoundCues(this.cues, currentChart - CUE_EPSILON_SECONDS);
      for (let index = begin; index < this.cues.length; index += 1) {
        const cue = this.cues[index];
        if (cue.chartSeconds >= segmentEndChart - CUE_EPSILON_SECONDS) break;
        if (loopRange && cue.chartSeconds >= this.loop!.endChartSeconds) continue;
        if (loopRange && cue.chartSeconds < this.loop!.startChartSeconds && !isInitialPrefix) continue;
        if (cue.chartSeconds < currentChart - CUE_EPSILON_SECONDS) continue;
        const due = segmentStartTime + Math.max(0, cue.chartSeconds - currentChart) / rate;
        const key = `${cue.id}:${Math.round(due * 100_000)}`;
        if (this.scheduledCueKeys.has(key)) continue;
        if (!this.synth.schedule(cue, due, key)) continue;
        const cueTail = Math.min(0.15, Math.max(0.008, cue.durationSeconds ?? 0.045));
        this.scheduledCueKeys.set(key, due + cueTail + 0.1);
      }

      remainingSeconds -= segmentSeconds;
      segmentStartTime += segmentSeconds;
      currentChart = segmentEndChart;
      if (loopRange && currentChart >= this.loop!.endChartSeconds - CUE_EPSILON_SECONDS) {
        currentChart = this.loop!.startChartSeconds;
        isInitialPrefix = false;
      } else {
        break;
      }
    }
  }

  private readEstimatedAudibleChartSeconds(): number | null {
    if (this.state !== 'playing') return null;
    const getTimestamp = this.context.getOutputTimestamp?.bind(this.context);
    if (!getTimestamp) return null;
    const timestamp = getTimestamp();
    if (typeof timestamp.contextTime !== 'number' || typeof timestamp.performanceTime !== 'number'
      || !Number.isFinite(timestamp.contextTime) || !Number.isFinite(timestamp.performanceTime) || timestamp.performanceTime <= 0) {
      return null;
    }
    const outputContextTime = timestamp.contextTime + (performance.now() - timestamp.performanceTime) / 1000;
    return this.readChartSeconds(outputContextTime + this.outputCalibrationSeconds);
  }

  private stopPlaybackNodes(): void {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        // The source may already have ended at the same time as a seek or pause.
      }
      this.source.disconnect();
      this.source = null;
    }
    this.synth.stopAll();
    this.scheduledCueKeys.clear();
  }

  private emitChange(): void {
    this.onChange?.(this.getSnapshot());
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('音频传输已释放');
  }
}

function lowerBoundCues(cues: readonly AudioCue[], chartSeconds: number): number {
  let low = 0;
  let high = cues.length;
  while (low < high) {
    const middle = low + ((high - low) >>> 1);
    if (cues[middle].chartSeconds < chartSeconds) low = middle + 1;
    else high = middle;
  }
  return low;
}

async function readBrowserAudioMetadata(file: Blob, name: string): Promise<AudioMetadataHint> {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('此环境需要显式提供音频时长元数据');
  }
  const url = URL.createObjectURL(file);
  const element = document.createElement('audio');
  try {
    element.preload = 'metadata';
    element.src = url;
    const durationSeconds = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`读取 ${name} 元数据超时`)), 10_000);
      const finish = (callback: () => void) => {
        clearTimeout(timeout);
        element.onloadedmetadata = null;
        element.onerror = null;
        callback();
      };
      element.onloadedmetadata = () => finish(() => resolve(element.duration));
      element.onerror = () => finish(() => reject(new Error(`无法读取 ${name} 的音频元数据`)));
      element.load();
    });
    return { durationSeconds };
  } finally {
    element.pause();
    element.removeAttribute('src');
    element.load();
    URL.revokeObjectURL(url);
  }
}
