import { writeFile } from 'node:fs/promises';

const sampleRate = 48_000;
const channels = 2;
const durationSeconds = 10;
const frameCount = sampleRate * durationSeconds;
const bytesPerSample = 2;
const dataSize = frameCount * channels * bytesPerSample;
const wav = Buffer.alloc(44 + dataSize);

wav.write('RIFF', 0);
wav.writeUInt32LE(36 + dataSize, 4);
wav.write('WAVE', 8);
wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(channels, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
wav.writeUInt16LE(channels * bytesPerSample, 32);
wav.writeUInt16LE(bytesPerSample * 8, 34);
wav.write('data', 36);
wav.writeUInt32LE(dataSize, 40);

const markers = [0, 2, 4, 6, 8];
for (let frame = 0; frame < frameCount; frame += 1) {
  const time = frame / sampleRate;
  let sample = Math.sin(2 * Math.PI * 220 * time) * 0.08;
  for (const marker of markers) {
    const markerTime = time - marker;
    if (markerTime >= 0 && markerTime < 0.08) sample += Math.sin(2 * Math.PI * 1200 * markerTime) * 0.45;
  }
  const pcm = Math.max(-1, Math.min(1, sample));
  const offset = 44 + frame * channels * bytesPerSample;
  wav.writeInt16LE(Math.round(pcm * 32_767), offset);
  wav.writeInt16LE(Math.round(pcm * 32_767), offset + 2);
}

await writeFile(new URL('./reference-tone.wav', import.meta.url), wav);

