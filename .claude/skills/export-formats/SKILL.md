---
name: export-formats
description: Add or change an audio export format in GreanTeaDawy (ffmpeg conversions on the server), keeping the safe-spawn rules, Settings → Audio export, the File menu and Claude's list_export_formats/export_audio in sync.
---

# Export formats (ffmpeg)

The browser renders WAV (16/24-bit). Everything else is a **server-side ffmpeg conversion** of a WAV the server
itself stored in the user's exports folder. ffmpeg is optional: WAV must keep working without it.

| Part | File |
|------|------|
| Format table (label, extension, encoders best-first, muxer, bitrates, lossless) | `server/src/ffmpeg.js` → `EXPORT_FORMATS` |
| Detection (version, encoders; cached, admin can re-check) | `createFfmpeg().status()` |
| Conversion arguments | `createFfmpeg().convert()` |
| Allowed export file names (derived from the table) | `EXPORT_NAME` in `server/src/backend.js` |
| REST | `GET /api/exports/formats`, `GET /api/system/ffmpeg`, `POST /api/system/ffmpeg/refresh`, `POST /api/exports/:name/convert` (`server/src/api.js`) |
| MCP | `list_export_formats`, `export_audio` (`server/src/mcp/tools/export.js`; enum from `FORMAT_IDS`) |
| UI | Settings → Audio export (`ExportTab` in `Settings.jsx`), File → *Export song as…* (`exportFormatItems` in `Toolbar.jsx`) |

## Adding a format

1. Add an entry to `EXPORT_FORMATS`: `{ label, ext, encoders: [...best first], muxer, bitrates?, defaultBitrate?,
   lossless?, maxChannels?, suffix? (when two formats share an extension, e.g. ALAC `-alac.m4a`), description }`.
   `maxChannels` is what the encoder really handles at its bitrates (test 5.1, 7.1 and 7.1.4 renders with a real
   ffmpeg: Vorbis fails above 6 at 192k, ALAC remixes 7.1 to 6.1); lossy formats are refused for multichannel WAVs without a speaker mask
   (ADM/object renders).
2. In `convert()`, add only the **codec options** the format needs (sample format, bit depth, container flags) to the
   `codec` array. Never touch the input side.
3. If the extension is new, it joins `EXPORT_EXTENSIONS` (and therefore `EXPORT_NAME`) automatically; check the
   Exports list in the Browser shows it and downloads work (`res.download`).
4. Update the strings that list formats: `Settings.jsx` (ExportTab text), `docs/user-guide.md`, `docs/claude-mcp.md`,
   `README.md`, the `export_audio` `.describe()`, `guide.js` *Exporting*.
5. Tests: `server/test/ffmpeg.test.js` uses a **fake ffmpeg** script (`-encoders` output + writes the output file and
   the argument list as `<out>.args`) — assert the arguments for the new format, availability when the encoder is
   missing (409 with a reason), and bitrate validation. The band e2e exports FLAC when a real ffmpeg is present.

## Rules (security — don't relax these)

- Spawn with an **argument array**, never a shell; the binary comes only from `FFMPEG_PATH` or `PATH`.
- Input: `-protocol_whitelist file -f wav -c:a pcm_<fmt> -i file:<path>` — forced format **and decoder** (from
  `readWavInfo`), no probing, no network protocols, no playlists, no compressed-audio decoders on user data.
  Output: `-f <muxer> file:<path>`.
- Only convert files that pass `EXPORT_NAME`, belong to the user (`exportFilePath`) and are PCM/float WAVs
  (`readWavInfo` returns null for any other codec inside a RIFF file).
- Output names are reserved with an exclusive create (`wx`) next to the input — never overwrite.
- Metadata goes through `cleanMetadata` (known keys, single line, length-limited); `-map_metadata -1` drops the input's.
- Clean environment (no secrets), timeout (`FFMPEG_TIMEOUT_SEC`), at most `FFMPEG_MAX_JOBS` at once and 3 per user
  queued (`owner`), the output name reserved only once a slot is free; delete partial output on failure; failures are
  422/504 with ffmpeg's reason (server paths stripped).

## Check

`npm run lint && npm test`; with ffmpeg installed: File → Export song as… → your format, open the file in a player,
and ask Claude (MCP) for `export_audio format=<id>`. `npm run docs:mcp` when the tool text changed.
