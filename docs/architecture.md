# Architecture

```
 Browser (React + Web Audio)                     Node.js server                                  Claude
┌────────────────────────────┐   WebSocket /ws  ┌───────────────────────────────┐  /mcp (HTTP)  ┌──────────────┐
│ zustand store ─ applyOps   │◄────────────────►│ Hub (live sync, jobs,         │◄──────────────│ Claude Code  │
│ (optimistic) + undo/redo   │   ops / acks     │      activity, transport)     │   or stdio    │ Claude Desktop│
│ Audio engine (realtime)    │   jobs ◄─────────│ ProjectStore (ops, lock,      │   bridge ────►│ …            │
│ Offline render + analysis  │── job results ──►│      versions, undo)          │               └──────────────┘
│ UI windows                 │   REST /api      │ SampleLibrary (metadata,      │
└────────────────────────────┘◄────────────────►│      analysis worker)         │
                                                │ Users / Sessions / Auth       │
          @greanteadawy/core (shared) ──────────│ MCP tools ─► backend          │
                                                └──────────────┬────────────────┘
                                                               ▼
                                     DATA_DIR: projects/*.json, versions/, samples/, exports/<user>/,
                                               plugins/<user>/, users.json, sessions.json
```

## Packages

- **`packages/core`** — pure JavaScript used by both sides: the project model and its repair (`normalizeProject`), the
  op system (`applyOps`, `prepareOps`, `describeOps`), instrument/effect catalogs, music theory, notation parsers,
  generators (chords, basslines, melodies, rolls), templates, MIDI import/export, WAV codec, audio analysis and
  human-readable project summaries for Claude.
- **`server`** — Express app, WebSocket hub, stores, auth, REST API and the MCP server.
- **`client`** — React UI, zustand store, WebSocket sync and the Web Audio engine.

## The project model

A project is plain JSON: `bpm`, `timeSig`, `swing`, `key`, `scale`, `channels[]` (instrument + mixer routing),
`patterns[]` (notes per channel), `playlist { tracks[], clips[] }` (pattern/audio/automation clips), `automations[]`
and `mixer[]` (insert 0 = master; volume, pan, routing, sends, effects). Time is measured in ticks
(`PPQ = 96` per beat, 24 per 16th step). Everything loaded from disk, imported or restored passes through
`normalizeProject`, which fills defaults, clamps values, drops invalid references and breaks routing cycles.

## Ops: the only way to edit

Every change — a click in the piano roll, a REST call, an MCP tool — is a list of **ops** such as
`{ type: 'notes/add', patternId, channelId, notes }`. `applyOps` validates and applies a batch atomically with immer
(an invalid op rejects the whole batch). The flow for a UI edit:

1. `store.dispatch(ops)` runs `prepareOps` (assigns ids and colours), applies the ops locally (optimistic UI), records
   undo history and sends `{ type: 'ops', opId, ops }` over the socket.
2. The server's `ProjectStore.applyOps` serialises edits per project (a promise-chain lock), prepares + applies them,
   bumps `rev`, schedules a debounced atomic save, and emits an `ops` event.
3. The hub acks the sender (`ack` with the new `rev`) and broadcasts the prepared ops to the user's other tabs. Because
   ids were fixed before applying, every replica builds the identical project.
4. If the server rejects an op, the sender gets `reject` with the authoritative project and re-applies its still-pending
   edits on top. If remote ops interleave with pending local ops, the client resyncs once its outbox drains. Ops are
   re-sent after reconnects; the hub de-duplicates by `opId` and add-ops are idempotent.

MCP edits take the same path (`backend.applyOps`), so they appear live in the browser and in the activity log, and the
server keeps an undo stack for them (the `undo` tool). Named **versions** are full snapshots in `versions/<projectId>/`.

## Browser jobs

Some work needs Web Audio, which only exists in the browser. The server asks one of the user's open tabs to do it
(`JOB_KINDS` in `server/src/api.js`, handlers in `client/src/lib/jobs.js`):

| Kind | What the tab does | MCP tool |
|------|-------------------|----------|
| `render` | offline mixdown, analysis of the mix and of stems in the same pass, optional WAV upload | `render_mix` |
| `analyze-sample` | decode a compressed upload with the browser's codecs and analyse it | `analyze_sample` |
| `sound` | render one note of one channel (dry or through its insert) and measure pitch, low peak, envelope | `analyze_sound` |
| `export-stems` | render each channel alone and upload every WAV with `POST /api/jobs/:id/files` | `export_stems` |
| `spatial` | render the 3D mix (binaural, 5.1/7.1/7.1.4, bed + objects) at 48 kHz, upload WAV(s); the server writes the objects' positions JSON from the result (`lib/spatialExport.js`) | `export_spatial` |
| `generator` | fetch a generator plugin's code and run it in the sandbox iframe (`lib/sandbox.js`), return its notes; the server cleans them and applies the ops | `run_generator` |
| `sample-edit` | decode a sample at its own rate, run the edit operations in the edit worker (`audio/editWorker.js`), upload the result as a new sample or `PUT /api/samples/:id/file`; returns the sample id | `edit_sample` |

`export_audio` reuses the `render` job (saving a 24-bit WAV), then the server converts it with ffmpeg
(`server/src/ffmpeg.js`: file-only protocol, forced input format, timeout, job limit) and removes the intermediate WAV.


```
MCP render_mix ─► hub.requestJob(user, job) ─► WS {type:'job'} ─► client lib/jobs.js
   ▲                                                            │ render + analyse (+ WAV)
   └──── result ◄── POST /api/jobs/:id/result (multipart) ◄─────┘   job-progress ─► MCP progress notifications
```

Jobs time out, fail fast when the tab closes, and only the owning user's tab can answer.

## Audio engine (client)

- **Graph**: channel strips (filter → volume → pan) → mixer inserts (effects chain → fader → pan → mute → post) →
  routing/sends → master insert → output. Audio clips go through a dedicated clip bus into the master.
- **Instruments** are synthesized per note (`audio/instruments.js`, band instruments in `audio/band.js`): each note is
  a `Voice` that owns its sources and supports release, choke groups, mono/glide and fast kill. Piano, guitar, bass and
  pizzicato are **physical models rendered into buffers** (`audio/models.js`, pure JS): `modelPool.js` prewarms every
  note a project plays in background Web Workers (`modelWorker.js`) into an LRU cache (≈ 96 MB), offline renders wait
  for them, and a note that still isn't ready renders on the spot.
- **Spatial** (`audio/spatial.js`, coordinates/layouts/ADM in `core/spatial.js`): a `SpatialRig` takes 3D-object
  inserts out of the stereo routing — HRTF `PannerNode`s into the master (binaural monitoring/export), per-speaker
  gains into a `ChannelMerger` (5.1/7.1/7.1.4, bed = master on L/R, objects skip the master bus) or one merger channel
  per object (object stems / ADM). Position automation drives the panners or re-pans the speaker gains at every
  automation point.
- **Plugins** (`audio/plugins.js`, manifests in `core/plugins.js`, server side `server/src/plugins.js`): the store
  keeps the user's plugin registry; DSP plugins are loaded once per audio context with `audioWorklet.addModule()` from
  `/api/plugins/:id/worklet.js` (a server-generated harness around the plugin's code; processor name = id + package
  hash), each note becomes an `AudioWorkletNode` inside a normal `Voice` (gate/kill AudioParams for release and fast
  kill, polyphony cap per channel), effects are worklet nodes between the insert's slot input/output (pass-through
  until loaded, bypassed on error), sample instruments use the built-in sample voice with the plugin's zones. Offline
  renders `await preparePlugins()` first. Generators never touch the audio engine: `lib/sandbox.js` runs them in the
  `/sandbox/generator.html` iframe (opaque origin, no network) in a throwaway Worker. See [plugins.md](plugins.md).
- **Transport**: a lookahead scheduler (25 ms timer, 120 ms horizon) converts pattern/song positions to audio times,
  handles loops, swing (a time warp of each 8th, scaled by each channel's `swingMix`), per-channel `nudge` (ms), tempo
  changes and automation (sampled every 1/32 note).
- **Velocity**: `velocityGain(v) = v²` for level, plus per-instrument timbre scaling (normalized to 1 at v = 0.8).
- **Sidechain**: a pump effect with a `source` channel ducks on that channel's notes — `triggerNote` calls
  `pump.trigger(time)` for every note (before the audibility check, so a muted ghost channel still triggers). Works the
  same in realtime and offline renders.
- **Audio clips** carry `gain`, `fadeIn`/`fadeOut` (ticks) and `rate` (playback speed for repitching); every clip gets
  a short anti-click ramp at its edges.
- **Offline render** (`audio/render.js`) builds the same engine on an `OfflineAudioContext`, schedules in 0.5–1 s chunks
  using `suspend()`, disconnects finished voices between chunks (long songs render several times faster) and can meter
  **stems in the same pass**: analyser taps after each channel's own insert feed `createLevelMeter` (streaming LUFS,
  peak, RMS, spectrum, width).

## Analysis (core)

`analyzeAudio` computes BS.1770 integrated loudness with gating, short-term/momentary maxima, EBU R128 loudness range,
sample peak and **true peak** (4× windowed-sinc interpolation around near-peak samples, `createTruePeakMeter`),
RMS/crest, clipping, DC, head/tail silence, stereo correlation/width/balance and **low-end width** (side/mid below
150 Hz), a 4096-point FFT spectrum (bands, centroid, flatness, the strongest 25–300 Hz frequency as Hz + note),
chroma-based key (Krumhansl profiles), spectral-flux onsets and autocorrelation tempo (with confidence), YIN pitch for
one-shots, and a character guess. `createLevelMeter` streams the same loudness/spectrum/low-end metrics for render
stems, `envelopeTimes` measures attack and −20/−40/−60 dB decay of a single hit. Non-finite samples are counted and
treated as silence. `encodeWav` writes 16-bit (TPDF-dithered, seeded) or 24-bit PCM, multichannel as
WAVE_FORMAT_EXTENSIBLE with a speaker mask, plus extra chunks (Broadcast Wave `bext`, ADM `chna`/`axml`).

## Security model

See [security.md](security.md): per-user ownership on every route and socket message, scrypt passwords, hashed session
ids and API tokens, origin/host checks, CSP, rate limits, setup code for exposed servers, and the plugin sandboxes.

## Samples: library, editing, pitch correction, recording

- **Library** (`server/src/samples.js`): `samples/index.json` (the samples, `folderId` null = unfiled, `rev` = audio
  revision) and `samples/folders.json` (per-user folders). `sampleUsage` scans the user's projects for sampler channels
  (`params.sampleId`) and audio clips (`refId`). Replacing a sample's audio keeps its id and bumps `rev`; sample files
  are cached as immutable, so clients request `/api/samples/:id/file?v=<rev>` (`sampleFileUrl` in `audio/engine.js`)
  and the engine drops decoded audio whose revision changed (`syncSampleLibrary`).
- **Editing** is pure JS in `packages/core`: `audioedit.js` (clips `{ sampleRate, channels }`, every operation returns a
  new clip — the wave editor keeps old ones for undo; `applyEdit` runs a named operation as Claude sends it) and
  `autotune.js` (YIN pitch tracking on a ~16 kHz copy, note segmentation that ignores vibrato, the per-frame correction
  curve from amount/speed/flatten, TD-PSOLA resynthesis that keeps formants, WSOLA time stretch, pitch shift). The
  browser runs the slow ones in `audio/editWorker.js` (`lib/audioEdit.js`); the same code is unit-tested in Node.
- **Recording** (`lib/recorder.js`, `public/recorder-worklet.js`): the microphone goes into the studio's own
  AudioContext; an AudioWorklet copies the input in ~4096-frame blocks stamped with their context frame, so a take is
  rebuilt exactly (a dropout becomes silence, not a shift). Over the song the transport starts at a known context time
  after the count-in (`Transport.play({ at })`) with the loop region pushed past the end; the take is trimmed by the
  output + input latency so it lines up with what the performer heard, saved as a WAV in "Recordings" and placed with
  a `clip/add` op.

