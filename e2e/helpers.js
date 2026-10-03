import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const ADMIN = { username: 'producer', password: 'correct-horse-42', displayName: 'Pat Producer' };

/** Connect an MCP client ("Claude") to the test server, optionally with a personal API token. */
export async function connectMcp(baseURL, token) {
  const client = new Client({ name: 'e2e-claude', version: '1.0.0' });
  const opts = token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {};
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), opts));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.map((c) => c.text).join('\n');
    if (r.isError) throw new Error(`${name}: ${text}`);
    return text;
  };
  return { client, call, close: () => client.close() };
}

/** A small 16-bit PCM WAV (decaying sine) for upload tests. */
export function makeWav({ seconds = 0.6, sampleRate = 44100, freq = 220, channels = 2 } = {}) {
  const n = Math.round(seconds * sampleRate);
  const dataBytes = n * channels * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.sin((2 * Math.PI * freq * i) / sampleRate) * Math.exp(-4 * i / n) * 0.8;
    for (let c = 0; c < channels; c++) buf.writeInt16LE(Math.round(v * 32767), 44 + (i * channels + c) * 2);
  }
  return buf;
}

/**
 * A 16-bit mono WAV of a voice-like tone (four harmonics) singing `notes`: { hz (0 = rest), dur (s), vib (semitones of
 * 5.5 Hz vibrato) }.
 */
export function voiceWav(notes, sr = 44100) {
  const total = Math.round(notes.reduce((a, n) => a + n.dur, 0) * sr);
  const buf = Buffer.alloc(44 + total * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + total * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(total * 2, 40);
  let ph = 0;
  let i = 0;
  for (const n of notes) {
    const N = Math.round(n.dur * sr);
    for (let k = 0; k < N; k++, i++) {
      const f = n.hz ? n.hz * Math.pow(2, ((n.vib || 0) * Math.sin((2 * Math.PI * 5.5 * k) / sr)) / 12) : 0;
      ph += (2 * Math.PI * f) / sr;
      const env = n.hz ? Math.min(1, k / (0.01 * sr), (N - k) / (0.01 * sr)) : 0;
      const v = env * 0.25 * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph) + 0.2 * Math.sin(4 * ph));
      buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
    }
  }
  return buf;
}

/** Click an item in the open context menu by its label. */
export async function menuItem(page, label) {
  await page.locator('.context-menu .cm-item', { hasText: label }).first().click();
}
