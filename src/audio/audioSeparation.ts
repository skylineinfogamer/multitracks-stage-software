/**
 * Audio Separation and Multi-Channel Utilities
 * Handles splitting combined Click & Guide stereo files (Left = Click, Right = Guide)
 * and encoding mono/stereo AudioBuffers into standard 16-bit PCM WAV byte buffers.
 */

export function isCombinedClickGuide(name: string): boolean {
  if (!name) return false;
  const normalized = name.replace(/[_\-.\s+&/\\()]+/g, ' ').toLowerCase();

  // Explicit combined patterns like "click & guia", "click e guia", "click guide", "click-guide", etc.
  if (
    /\b(click|clique|metr[oô]nomo)\b/i.test(normalized) &&
    /\b(guide|guia|cues?|count|contagem|voz)\b/i.test(normalized)
  ) {
    return true;
  }
  if (
    normalized.includes('click') &&
    (normalized.includes('guide') || normalized.includes('guia') || normalized.includes('cue'))
  ) {
    return true;
  }
  return false;
}

/**
 * Detects if a stereo AudioBuffer has different audio signals on Channel 0 (Left) and Channel 1 (Right).
 * MultiTrack Click/Guide stems are typically stereo files with Left = Click and Right = Guide.
 */
export function isDualChannelClickGuide(buffer: AudioBuffer): boolean {
  if (buffer.numberOfChannels < 2) return false;
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const step = Math.max(1, Math.floor(buffer.length / 5000));
  let diffSum = 0;
  let samplesChecked = 0;
  for (let i = 0; i < buffer.length; i += step) {
    diffSum += Math.abs(left[i] - right[i]);
    samplesChecked++;
  }
  const avgDiff = samplesChecked > 0 ? diffSum / samplesChecked : 0;
  return avgDiff > 0.005;
}

/**
 * Extracts a single channel (0 = Left, 1 = Right) from an AudioBuffer into a pristine 1-channel mono AudioBuffer.
 */
export function extractMonoChannel(ctx: AudioContext, buffer: AudioBuffer, channelIndex = 0): AudioBuffer {
  const safeCh = Math.min(channelIndex, buffer.numberOfChannels - 1);
  const monoBuf = ctx.createBuffer(1, buffer.length, buffer.sampleRate);
  monoBuf.copyToChannel(buffer.getChannelData(safeCh), 0);
  return monoBuf;
}

/**
 * Converts an AudioBuffer (or a single channel of an AudioBuffer) into a standard 16-bit PCM WAV ArrayBuffer.
 */
export function audioBufferToWav(buf: AudioBuffer, channelIndex?: number): ArrayBuffer {
  const isMono = channelIndex !== undefined || buf.numberOfChannels === 1;
  const numChannels = isMono ? 1 : 2;
  const sampleRate = buf.sampleRate;
  const length = buf.length * numChannels * 2;
  const buffer = new ArrayBuffer(44 + length);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + length, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, length, true);

  if (isMono) {
    const ch = buf.getChannelData(channelIndex !== undefined ? channelIndex : 0);
    let offset = 44;
    for (let i = 0; i < buf.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i])) * 32767;
      view.setInt16(offset, s, true);
      offset += 2;
    }
  } else {
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
    let offset = 44;
    for (let i = 0; i < buf.length; i++) {
      const s0 = Math.max(-1, Math.min(1, ch0[i])) * 32767;
      const s1 = Math.max(-1, Math.min(1, ch1[i])) * 32767;
      view.setInt16(offset, s0, true);
      view.setInt16(offset + 2, s1, true);
      offset += 4;
    }
  }

  return buffer;
}

/**
 * Splits a stereo Click/Guide AudioBuffer into two completely isolated mono AudioBuffers:
 * - Channel 0 (Left)  -> CLICK (Metronome)
 * - Channel 1 (Right) -> GUIA (Vocal Guide Cues)
 */
export function splitStereoClickGuide(
  ctx: AudioContext,
  stereoBuffer: AudioBuffer,
): {
  clickBuffer: AudioBuffer;
  guideBuffer: AudioBuffer;
  clickWav: ArrayBuffer;
  guideWav: ArrayBuffer;
} {
  const length = stereoBuffer.length;
  const sampleRate = stereoBuffer.sampleRate;

  // Create two separate single-channel (mono) buffers
  const clickBuffer = ctx.createBuffer(1, length, sampleRate);
  const guideBuffer = ctx.createBuffer(1, length, sampleRate);

  const leftChannel = stereoBuffer.getChannelData(0);
  const rightChannel = stereoBuffer.numberOfChannels > 1 ? stereoBuffer.getChannelData(1) : leftChannel;

  clickBuffer.copyToChannel(leftChannel, 0);
  guideBuffer.copyToChannel(rightChannel, 0);

  const clickWav = audioBufferToWav(clickBuffer, 0);
  const guideWav = audioBufferToWav(guideBuffer, 0);

  return {
    clickBuffer,
    guideBuffer,
    clickWav,
    guideWav,
  };
}
