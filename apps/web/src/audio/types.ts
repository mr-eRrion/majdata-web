export type PlaybackRate = 0.5 | 1 | 2;

export type PlaybackState = 'paused' | 'playing';

/** Chart coordinates are relative to the chart origin. */
export interface ChartLoop {
  startChartSeconds: number;
  endChartSeconds: number;
}

/** A small synthesized cue attached to an already-compiled chart event. */
export interface AudioCue {
  id: string;
  chartSeconds: number;
  frequencyHz?: number;
  durationSeconds?: number;
  gain?: number;
  waveform?: OscillatorType;
}

export interface AudioTrackMetadata {
  name: string;
  durationSeconds: number;
  sampleRateHz: number;
  channelCount: number;
  decodedBytes: number;
}

export interface AudioSnapshot {
  state: PlaybackState;
  /** Software playhead in chart coordinates, before applying output calibration. */
  chartSeconds: number;
  /** AudioBuffer coordinate, including the chart's first offset: s = c + firstOffset. */
  songSeconds: number;
  /** Null when the browser cannot provide an output timestamp. */
  estimatedAudibleChartSeconds: number | null;
  firstOffsetSeconds: number;
  outputCalibrationSeconds: number;
  playbackRate: PlaybackRate;
  loop: ChartLoop | null;
  track: AudioTrackMetadata | null;
  playbackGeneration: number;
}

export interface AudioMetadataHint {
  durationSeconds: number;
  /** Used for pre-decode PCM admission. Exact decoded channel count is checked afterwards. */
  channelCount?: number;
}

export interface AudioTransportOptions {
  context?: AudioContext;
  maxDurationSeconds?: number;
  maxDecodedBytes?: number;
  scheduleAheadSeconds?: number;
  schedulerIntervalMs?: number;
  outputCalibrationSeconds?: number;
  onChange?: (snapshot: AudioSnapshot) => void;
  metadataReader?: (file: Blob, name: string) => Promise<AudioMetadataHint>;
  decoder?: (bytes: ArrayBuffer, context: AudioContext) => Promise<AudioBuffer>;
}

export type AudioLoadResult =
  | { status: 'loaded'; generation: number; track: AudioTrackMetadata }
  | { status: 'superseded'; generation: number }
  | { status: 'rejected'; generation: number; error: Error };

