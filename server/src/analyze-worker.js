// Decodes + analyses a WAV off the main thread (a long file would otherwise block every request for seconds).
// Only the first MAX_SECONDS are analysed so memory stays bounded; the full duration is still reported.
import { parentPort, workerData } from 'node:worker_threads';
import { decodeWav, analyzeAudio } from '@greanteadawy/core';

const MAX_SECONDS = 180;

try {
  const audio = decodeWav(new Uint8Array(workerData.bytes), { maxSeconds: MAX_SECONDS });
  const analysis = analyzeAudio(audio);
  const seconds = audio.totalFrames / audio.sampleRate;
  if (seconds > MAX_SECONDS) analysis.analyzedSeconds = MAX_SECONDS; // a long recording: the analysis covers the start
  parentPort.postMessage({ ok: true, seconds, analysis });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.message });
}
