export async function computeWaveform(blob: Blob): Promise<number[]> {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioCtx = new AudioContext();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const data = audioBuffer.getChannelData(0);
    const barCount = 40;
    const step = Math.floor(data.length / barCount);
    const peaks: number[] = [];
    for (let i = 0; i < barCount; i++) {
      let max = 0;
      for (let j = 0; j < step; j++) {
        const v = Math.abs(data[i * step + j] ?? 0);
        if (v > max) max = v;
      }
      peaks.push(max);
    }
    const maxPeak = Math.max(...peaks, 0.01);
    await audioCtx.close();
    return peaks.map((p) => p / maxPeak);
  } catch {
    return Array.from({ length: 40 }, () => 0.5);
  }
}
