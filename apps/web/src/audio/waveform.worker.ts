import { summarizeWaveformChunk } from './waveform';

interface WaveformRequest {
  id: number;
  startBin: number;
  samplesPerBaseBin: number;
  channels: ArrayBuffer[];
  frameCount: number;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WaveformRequest>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

scope.onmessage = (event) => {
  const request = event.data;
  try {
    const channels = request.channels.map((data) => new Float32Array(data));
    const chunk = summarizeWaveformChunk(channels, request.frameCount, request.samplesPerBaseBin);
    const transfer = [...chunk.min, ...chunk.max].map((bins) => bins.buffer as ArrayBuffer);
    scope.postMessage({ id: request.id, startBin: request.startBin, min: chunk.min, max: chunk.max }, transfer);
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : String(caught);
    scope.postMessage({ id: request.id, startBin: request.startBin, error });
  }
};
