export function downloadBytes(bytes: Uint8Array, filename: string): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export async function readChartFile(file: File, maxBytes = 4 * 1024 * 1024): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('谱面文件上限无效。');
  if (file.size > maxBytes) throw new RangeError(`谱面文件不能超过 ${(maxBytes / (1024 * 1024)).toFixed(0)} MiB。`);
  return new Uint8Array(await file.arrayBuffer());
}
