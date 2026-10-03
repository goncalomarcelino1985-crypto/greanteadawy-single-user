// WAV (RIFF) encode / decode, pure JS (works in Node and the browser).

/**
 * Decode a PCM/float WAV file.
 * Returns { sampleRate, channels: Float32Array[], bitsPerSample, format: 'pcm' | 'float' }.
 */
/** maxSeconds: decode only the beginning (bounded memory for analysis of long files); totalFrames is still reported. */
export function decodeWav(input, { maxSeconds = Infinity } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= bytes.length) {
    const id = tag(pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      let formatTag = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bitsPerSample = view.getUint16(body + 14, true);
      if (formatTag === 0xfffe && size >= 40) formatTag = view.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
      fmt = { formatTag, channels, sampleRate, bitsPerSample };
    } else if (id === 'data') {
      data = { offset: body, size: Math.min(size, bytes.length - body) };
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV is missing fmt or data chunk');
  const { formatTag, channels, sampleRate, bitsPerSample } = fmt;
  const isFloat = formatTag === 3;
  if (!(formatTag === 1 || isFloat)) throw new Error(`Unsupported WAV encoding (format tag ${formatTag})`);
  if (!channels || !sampleRate) throw new Error('Invalid WAV header');
  const bps = bitsPerSample / 8;
  const totalFrames = Math.floor(data.size / (bps * channels));
  const frames = Math.min(totalFrames, Number.isFinite(maxSeconds) ? Math.floor(maxSeconds * sampleRate) : totalFrames);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  let o = data.offset;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let v;
      if (isFloat) v = bitsPerSample === 64 ? view.getFloat64(o, true) : view.getFloat32(o, true);
      else if (bitsPerSample === 16) v = view.getInt16(o, true) / 32768;
      else if (bitsPerSample === 24) {
        let x = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
        if (x & 0x800000) x -= 0x1000000;
        v = x / 8388608;
      } else if (bitsPerSample === 32) v = view.getInt32(o, true) / 2147483648;
      else if (bitsPerSample === 8) v = (bytes[o] - 128) / 128;
      else throw new Error(`Unsupported WAV bit depth ${bitsPerSample}`);
      out[c][i] = v;
      o += bps;
    }
  }
  return { sampleRate, channels: out, bitsPerSample, format: isFloat ? 'float' : 'pcm', totalFrames };
}

/**
 * Encode float channels as PCM WAV (16 or 24 bit). 16-bit output gets TPDF dither by default (±1 LSB triangular
 * noise, seeded so encodes are reproducible): truncating quiet fades and reverb tails to 16 bits otherwise leaves
 * audible distortion. Pass { dither: false } for bit-exact output (tests, already-dithered audio).
 * More than two channels (or a `channelMask`) are written as WAVE_FORMAT_EXTENSIBLE with that speaker mask (0 = no
 * speaker assignment, e.g. ADM object tracks). `chunks` ([{ id, data: Uint8Array }]) go between fmt and data
 * (Broadcast Wave `bext`, ADM `chna`/`axml`). Returns a Uint8Array.
 */
export function encodeWav(channels, sampleRate, { bitDepth = 16, dither = bitDepth === 16, seed = 0, channelMask, chunks = [] } = {}) {
  if (bitDepth !== 16 && bitDepth !== 24) throw new Error('bitDepth must be 16 or 24');
  const ch = channels.length;
  const len = channels[0]?.length || 0;
  const bytes = bitDepth / 8;
  const dataSize = len * ch * bytes;
  const extensible = ch > 2 || channelMask !== undefined;
  const fmtSize = extensible ? 40 : 16;
  const extra = chunks.reduce((a, c) => a + 8 + c.data.length + (c.data.length % 2), 0);
  const head = 12 + 8 + fmtSize + extra + 8;
  if (head + dataSize > 0xffffffff) throw new Error('WAV would exceed 4 GB: render a shorter part or fewer channels');
  const pad = dataSize % 2; // RIFF chunks are word-aligned (odd sizes: 24-bit mono with an odd frame count)
  const buf = new Uint8Array(head + dataSize + pad);
  const v = new DataView(buf.buffer);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); v.setUint32(4, head - 8 + dataSize + pad, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, fmtSize, true); v.setUint16(20, extensible ? 0xfffe : 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * ch * bytes, true); v.setUint16(32, ch * bytes, true); v.setUint16(34, bitDepth, true);
  let o = 36;
  if (extensible) {
    v.setUint16(36, 22, true); // cbSize
    v.setUint16(38, bitDepth, true); // valid bits
    v.setUint32(40, (channelMask ?? 0) >>> 0, true);
    // KSDATAFORMAT_SUBTYPE_PCM 00000001-0000-0010-8000-00aa00389b71
    buf.set([1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71], 44);
    o = 60;
  }
  for (const c of chunks) {
    w(o, c.id); v.setUint32(o + 4, c.data.length, true);
    buf.set(c.data, o + 8);
    o += 8 + c.data.length + (c.data.length % 2);
  }
  w(o, 'data'); v.setUint32(o + 4, dataSize, true);
  o += 8;
  // a different seed per file (e.g. per stem) keeps the dither of summed stems uncorrelated
  let state = (0x2545f491 ^ Math.imul(seed + 1, 0x9e3779b1)) || 1;
  const rand = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const x = channels[c][i];
      const s = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
      if (bitDepth === 24) {
        const q = Math.round(s * 8388607);
        buf[o] = q & 255; buf[o + 1] = (q >> 8) & 255; buf[o + 2] = (q >> 16) & 255;
        o += 3;
      } else {
        const d = dither ? rand() - rand() : 0; // triangular PDF in (-1, 1) LSB
        v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(s * 32767 + d))), true);
        o += 2;
      }
    }
  }
  return buf;
}
