// Audio export in any format: list_export_formats (what this server can make — ffmpeg availability, bitrates) and
// export_audio (render in the user's browser, then convert with ffmpeg on the server).
import { findPattern } from '@greanteadawy/core';
import { z, ok, projectIdArg, annotations as A } from '../util.js';
import { FORMAT_IDS } from '../../ffmpeg.js';
import { progressNotifier } from './mix.js';

function describeFormats({ ffmpeg, formats }) {
  const head = ffmpeg.available
    ? `ffmpeg ${ffmpeg.version} is available on the server.`
    : `ffmpeg is NOT available (${ffmpeg.reason}): only WAV can be exported. The user (or admin) can install ffmpeg or set FFMPEG_PATH — see Settings → Audio export.`;
  const lines = formats.map((f) => {
    const opts = f.bitrates ? `bitrates ${f.bitrates.join('/')} kbps (default ${f.defaultBitrate})` : f.id === 'wav' ? 'bitDepth 16 (dithered) or 24' : 'keeps the render\'s bit depth (16 or 24)';
    return `- ${f.id} — ${f.label}${f.available ? '' : ' [unavailable]'}: ${f.description}; ${opts}${f.encoder ? ` (encoder ${f.encoder})` : ''}`;
  });
  return `${head}\n${lines.join('\n')}`;
}

export function registerExportTools({ tool, backend, load }) {
  tool('list_export_formats', {
    title: 'List export formats',
    description: 'Which audio formats this server can export right now: WAV always; MP3, AAC (.m4a), Ogg Vorbis, Opus, FLAC, Apple Lossless and AIFF when ffmpeg is installed on the server. Shows the ffmpeg version, the bitrates of each lossy format and why a format is unavailable. Call it before export_audio when the user asks for a specific format.',
    inputSchema: {},
    annotations: A.readOnly
  }, async () => {
    const r = await backend.exportFormats();
    return ok(describeFormats(r), r);
  });

  tool('export_audio', {
    title: 'Export audio (WAV, MP3, AAC, Ogg, Opus, FLAC, ALAC, AIFF)',
    description: "Render the song (or a pattern) in the user's browser and save it into the user's exports in the requested format: wav (rendered directly), or mp3/aac/ogg/opus/flac/alac/aiff (converted by ffmpeg on the server from a 24-bit render — check list_export_formats first). Tags the file with title/artist/album metadata. Returns the download URL. For a mastered release, check the loudness with render_mix first. Needs the studio open in a browser.",
    inputSchema: {
      projectId: projectIdArg,
      format: z.enum(FORMAT_IDS).describe('wav, mp3, aac, ogg, opus, flac, alac or aiff'),
      mode: z.enum(['song', 'pattern']).optional().describe('Default: song if the playlist has clips, else pattern'),
      pattern: z.string().optional().describe('For mode=pattern (default: first pattern)'),
      loops: z.number().int().min(1).max(16).optional().describe('Pattern mode: loops to render (default 2)'),
      bitrate: z.number().int().optional().describe('Lossy formats: kbps (see list_export_formats; default 320 MP3, 256 AAC, 192 Ogg, 160 Opus)'),
      bitDepth: z.union([z.literal(16), z.literal(24)]).optional().describe('WAV/FLAC/ALAC/AIFF bit depth (default 24; 16-bit is dithered)'),
      title: z.string().max(200).optional().describe('Metadata title (default: the project name)'),
      artist: z.string().max(200).optional().describe("Metadata artist (default: the user's display name)"),
      album: z.string().max(200).optional(),
      genre: z.string().max(100).optional(),
      keepWav: z.boolean().optional().describe('Also keep the intermediate WAV in exports (default false)')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ projectId, format, mode, pattern, loops = 2, bitrate, bitDepth = 24, title, artist, album, genre, keepWav = false }, extra) => {
    const p = await load(projectId);
    // validate everything before the (slow) render: an unavailable format or a bad bitrate fails fast
    const { ffmpeg, formats } = await backend.exportFormats();
    const f = formats.find((x) => x.id === format);
    if (!f.available) throw new Error(`${f.label} can't be exported here: ${f.reason || 'ffmpeg is not available'}. Available: ${formats.filter((x) => x.available).map((x) => x.id).join(', ')}.`);
    if (bitrate !== undefined && !f.bitrates) throw new Error(`${f.label} has no bitrate setting${f.lossless ? ' (it is lossless)' : ''}`);
    if (bitrate !== undefined && !f.bitrates.includes(bitrate)) throw new Error(`${f.label} bitrate must be one of ${f.bitrates.join(', ')} kbps`);
    const m = mode || (p.playlist.clips.length ? 'song' : 'pattern');
    const patternId = pattern ? findPattern(p, pattern).id : p.patterns[0]?.id;
    const depth = format === 'wav' || f.lossless ? bitDepth : 24; // lossy encoders get the best source
    const notify = progressNotifier(extra, 'Rendering in the browser');
    const result = await backend.requestJob(
      { kind: 'render', projectId: p.id, mode: m, patternId, loops, stems: false, save: true, bitDepth: depth, name: p.name },
      { projectId: p.id, timeoutMs: 240000, onProgress: notify ? (x) => notify(x * (format === 'wav' ? 1 : 0.8)) : null }
    );
    const wav = result.export;
    if (!wav) throw new Error('The browser rendered the song but did not save the WAV');
    const loud = result.mix ? ` — ${result.mix.lufs} LUFS integrated, true peak ${result.mix.truePeakDb} dBTP` : '';
    if (format === 'wav') {
      return ok(`Exported ${wav.name} (${depth}-bit WAV, ${Math.round(wav.bytes / 1024)} KB${loud}) to the user's exports (Projects → Exports): ${wav.url}`, { export: { ...wav, format: 'wav', bitDepth: depth } });
    }
    let out;
    try {
      out = await backend.convertExport(wav.name, {
        format, bitrate,
        metadata: { title: title || p.name, ...(artist ? { artist } : {}), ...(album ? { album } : {}), ...(genre ? { genre } : {}) }
      });
    } finally {
      if (!keepWav) await backend.deleteExport(wav.name).catch(() => {});
    }
    notify?.(1);
    const quality = out.bitrate ? `${out.bitrate} kbps` : out.bitDepth ? `${out.bitDepth}-bit` : '';
    return ok(`Exported ${out.name} (${f.label}${quality ? `, ${quality}` : ''}, ${Math.round(out.bytes / 1024)} KB, ffmpeg ${ffmpeg.version}${loud}) to the user's exports (Projects → Exports): ${out.url}${keepWav ? `\nThe ${depth}-bit WAV was kept too: ${wav.url}` : ''}`, { export: out });
  });
}
