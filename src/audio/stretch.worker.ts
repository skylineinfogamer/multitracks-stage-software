/// <reference lib="webworker" />
/**
 * WSOLA (Waveform Similarity Overlap-Add) analysis worker.
 *
 * Receives a decimated mono analysis signal (the mix of all stems) and returns,
 * for every synthesis frame, the input sample position that best continues the
 * waveform. The same positions are then applied to every stem/channel on the
 * main thread, so all stems stay perfectly phase-aligned with each other.
 */

export interface StretchRequest {
  id: number;
  analysis: Float32Array; // decimated mono mix
  decimation: number; // analysis sample = input sample / decimation
  inputLength: number; // full-rate input length (samples)
  frameSize: number; // full-rate frame (N)
  synthHop: number; // full-rate synthesis hop (Hs = N/2)
  stretch: number; // output length = input length * stretch
  searchRadius: number; // full-rate search radius (samples)
}

export interface StretchResponse {
  id: number;
  positions: Int32Array;
}

self.onmessage = (ev: MessageEvent<StretchRequest>) => {
  const { id, analysis, decimation: D, inputLength, frameSize: N, synthHop: Hs, stretch, searchRadius } = ev.data;
  const Ha = Hs / stretch; // analysis hop
  const overlap = N - Hs;
  const outLen = Math.ceil(inputLength * stretch);
  const frames = Math.ceil(outLen / Hs) + 1;
  const positions = new Int32Array(frames);

  const ovD = Math.max(8, Math.floor(overlap / D));
  const radD = Math.max(1, Math.floor(searchRadius / D));
  const maxStart = inputLength - N - 1;

  let prev = 0;
  positions[0] = 0;
  for (let m = 1; m < frames; m++) {
    const nominal = Math.round(m * Ha);
    if (nominal >= maxStart) {
      positions[m] = Math.max(0, Math.min(maxStart, nominal));
      prev = positions[m];
      continue;
    }
    // natural continuation of previous frame
    const natD = Math.floor((prev + Hs) / D);
    const nomD = Math.floor(nominal / D);
    let best = nomD;
    let bestScore = -Infinity;
    const lo = Math.max(0, nomD - radD);
    const hi = Math.min(Math.floor(maxStart / D), nomD + radD);
    for (let c = lo; c <= hi; c++) {
      let dot = 0;
      let en = 1e-9;
      for (let i = 0; i < ovD; i++) {
        const a = analysis[c + i];
        dot += a * analysis[natD + i];
        en += a * a;
      }
      const score = dot / Math.sqrt(en);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    const pos = Math.max(0, Math.min(maxStart, best * D));
    positions[m] = pos;
    prev = pos;
  }

  const res: StretchResponse = { id, positions };
  (self as unknown as Worker).postMessage(res, [positions.buffer]);
};
