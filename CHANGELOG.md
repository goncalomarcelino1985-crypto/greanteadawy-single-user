# Changelog

## 0.7.1 — ten new genre templates

- Ten new genre templates, each pre-mixed with shared reverb/delay buses and (where there is a kick) kick-keyed
  sidechain: **UK Drill** (sliding 808, 3-3-2 hats, dark piano over strings), **Afrobeats** (tresillo kick, congas,
  highlife guitar, finger bass), **Reggaeton** (dembow, nylon-guitar arpeggios, plucked hook), **Liquid Drum & Bass**
  (two-step at 174, reese bass, Rhodes), **Synthwave** (big-room snare, tom runs, FM bass, arp, saw lead), **Disco
  Funk** (slap bass, muted 16th guitar, brass stabs, strings), **Neo-Soul** (lazy swung beat, Rhodes in rootless
  voicings, organ), **Bossa Nova** (batida guitar, upright bass, clave, breathy flute), **Cinematic** (felt piano,
  solo cello, staccato strings, taiko, a reverse swell into a tam-tam) and **Beatbox Jam** (the beatbox collection
  with a lip bass and a hummed hook). 18 templates in all.

## 0.7.0 — sample library folders, wave editor, pitch correction, audio recording

**Sample library** (Browser → Samples)
- **Folders**: every sample lives in one folder or *Unfiled*. Create, rename and delete folders (deleting keeps the
  samples), drag a sample onto a folder or use ⋯ → *Move to folder*, drop audio files on a folder to upload into it,
  fold folders away (remembered per browser).
- **Search** by name, folder, tags and analysis words (`kick`, `vocal 140 bpm`, `pad A minor`).
- A ⋯ menu on every sample (sampler channel, edit, move, rename, details, analyse, delete) and a **select mode** to move
  or delete several at once.
- **Deleting a sample that is in use** first says which projects, channels and clips will go silent. A sample open in
  the wave editor with edits stays there (marked deleted) so the edits can still be saved as a new sample.
- The sampler's sample picker lists samples by folder and has an ✎ button to open the sample in the wave editor.

**Wave editor** (⋯ → *Edit in wave editor*)
- Waveform with zoom, overview strip and ruler; selections that snap to zero crossings; play / loop the selection.
- Cut, copy, paste (also between samples), delete, trim to selection, fade in/out, gain, normalise, reverse, invert,
  silence, remove DC, trim silence, mono/stereo, **speed** (turntable, band-limited, never clips), **time stretch**
  (WSOLA, keeps the pitch) and **pitch shift** (TD-PSOLA for voices and solo instruments below ~1 kHz, keeps formants
  and never clips; band-limited resample + stretch for everything else). Edits that would empty a sample or make it
  longer than 20 minutes are refused.
- Its own undo/redo history; slow processing runs in a worker so the studio keeps playing.
- **Save as new** keeps the original; **Replace original** overwrites the audio everywhere after a warning that lists
  every project, channel and clip using it. Replaced samples keep their id, get a new revision, and every open studio
  reloads them.

**Pitch correction** (the editor's *Pitch* tab)
- Finds the melody of a voice or solo instrument (YIN pitch tracking, note segmentation that ignores vibrato) and
  shows the sung pitch, the notes and the corrected pitch.
- Auto-tune to the project's key and scale (or chromatic) with **Amount**, **Speed** (0 ms = robotic … natural glides)
  and **Flatten** (vibrato and drift), presets *Natural*, *Tight*, *Robotic*.
- Move notes by hand: drag up/down (semitone snap, Alt/Shift fine), ↑/↓, double-click back to the scale, bypass, keep
  as sung, octave moves, and split or join notes the detection got wrong. Preview, then Apply as one undo step and
  save.
- Note detection keeps a regular vibrato (3.5–8 Hz, ±0.3–1.2 semitones), scoops and falls inside their note, and
  still separates legato singing with 20–60 ms slides between notes, wide leaps between short notes with vibrato and
  fast runs of notes from about 100 ms, also with a jittery pitch track. A very slow, uneven wobble can come out as several notes, a semitone trill sung with slow
  slides as one, and a short passing note right after a note with a wide vibrato can be missed: split or join them by
  hand. Only the stretch that is corrected is
  resynthesised (with a crossfade at each end), so the rest of the take stays bit-identical; audio that starts or ends
  on a sung note is corrected right to its edge.

**Recording audio** (🎙 in the toolbar, or *Record* in the Samples tab)
- Record from a microphone alone, or over the song or the current pattern with a count-in and metronome.
- Latency compensation (the browser's output + input latency, plus a manual offset); echo cancellation, noise
  suppression and auto gain are off by default.
- Every take is saved as a WAV sample in a "Recordings" folder and, over the song, placed on the playlist on a free
  track at the bar where recording started (the song plays on past its end instead of looping while you record). A
  take that can't be saved (connection, upload limit) stays in the list with Retry and Download.
- Space or the studio's Stop ends a take; recording over a pattern puts the SONG/PAT mode back afterwards. Signing out
  or leaving the page asks first while a take is being recorded or saved, or one couldn't be saved yet.
- Level meter with peak hold and clip warning, optional monitoring, take list with play / edit / tune / delete.

**Claude**
- New tools: `sample_folders` (list/create/rename/delete), `move_samples` (a new folder name creates the folder) and
  `edit_sample` (any of the editor's operations plus `pitch_correct` with key/scale/amount/speed/flatten, run in the
  user's browser; saves a new sample unless asked to replace — then it lists the projects that changed). 78 tools.
- `list_samples` groups by folder and takes `folder` and search words; `get_sample_info` shows the folder;
  `delete_sample` takes several ids and reports what goes silent. The guide, the `use_my_samples` prompt and the
  beat-making skill explain the vocal clean-up chain.

**Other**
- REST: sample folders, bulk move/delete, usage, `PUT /api/samples/:id/file`, `folderId`/`name` on upload,
  `maxUploadMb` in `/api/status`. Uploads and replacements must contain playable audio (checked before anything is
  written: also a header that promises audio the file doesn't have — FLAC, MP3, AIFF, WAV — is refused); sample and folder names are cleaned (Unicode NFC, no control or invisible format characters, at least one
  visible character, joiners only between visible characters, bounded size) and a joiner or a different case doesn't
  make a folder name new; a browser analysis of audio that was replaced meanwhile is refused (409).
- `Permissions-Policy` header: the microphone for the studio page only; no camera, location, payment, USB, serial, HID.
- The toolbar fits one row at 1440 px again with the new 🎙 button (slightly narrower scope display); on phones it never
  makes the page scroll sideways (below 400 px the song position is left to the playlist).
- Clicking another window (or the empty workspace) takes the keyboard along: Space and Ctrl+Z no longer stay with a
  control in the window you left; a click on the wave editor's or the recorder's title bar gives them the keys back.

## 0.6.1 — About dialog

- **About** (ⓘ at the top right of the toolbar, or ◆ → *About GreanTeaDawy…*): a dialog box with the app name and
  version, the server's version (with a hint to reload when the open tab runs an older build), the built-in sounds and
  the licence. The version comes from `client/package.json` at build time.
- Wording: the studio, README, docs and skills no longer describe GreanTeaDawy in terms of another DAW; only the MCP
  introduction Claude reads keeps that comparison. The subtractive synth is labelled *Subtractive Synth* (the
  instrument kind is still `synth`, so projects and Claude's calls are unchanged).
- Dialogs: one at a time — a dialog opened over another answers the first with "cancel" instead of leaving it
  waiting — and focus goes back to the button that opened them. On phones the toolbar's small buttons are 28 px.

## 0.6.0 — flute, beatbox, Indian and East Asian collections; selection and window fixes

**New instrument collections** (Browser sections *Flutes*, *Beatbox*, *Indian*, *East Asian*; 27 instruments, 106
presets; `list_instruments category=…` for Claude)
- **Flutes**: Flute (Concert, Breathy, Lo-fi, Trap, Alto, Piccolo), Pan Flute, Recorder, Tin Whistle, Ocarina — one
  breath engine (per-kind harmonic recipe, pitched breath noise, tongued chiff, attack scoop, delayed vibrato,
  velocity overblowing, mono slurs).
- **Beatbox**: mouth Kick ("B" lip burst), Snare (Pf, Psh spit, inward K, Kch), Hat (t, ts, inward, tch), Bass (lip /
  throat buzz through "oo/oh/ah/mm" vowel formants, growl, wobble) and FX (click roll, vocal scratch, laser zap,
  siren).
- **Indian**: modelled **sitar** (jawari bridge buzz that lasts the whole note, sympathetic strings tuned to the
  major scale of *Sa*, meend via mono glide), **tanpura** (blooming jawari drone), **tabla** (bols na, tin, tun, te,
  ge, ke, dha, dhin; palm-glide bend on ge), **bansuri**, **shehnai**, modelled **santoor** (mallet-struck courses
  that beat and ring) and **harmonium** (bass/male/female reed banks, shared bellows pulse).
- **East Asian**: modelled **koto**, **guzheng**, **pipa** and **shamisen** (bachi skin "thwack" and sawari),
  **erhu**, **shakuhachi**, **dizi** (membrane buzz), **suona**, **taiko** (odaiko, chudaiko, shime, kara) and
  **gong** (tam-tam bloom, opera gongs that bend down/up, temple bell).
- The world strings are physical models rendered in the background workers like the guitar. Their Karplus–Strong
  loop holds the requested T60 on high notes too and is tuned with exact phase delays (±2 cents up to C7).
- New templates **Indian Fusion** (keherwa theka, tanpura, sitar alap with meend, harmonium, bansuri) and
  **East Asian Lo-fi** (koto in D hirajoshi, shakuhachi, taiko, temple bell). The tabla follows a template's key.
- New scales: hirajoshi, inSen, iwato, yo, and the thaats bhairav, todi, purvi, marwa. Pentatonics take their chords
  and spelling from the 7-note scale that contains them; `music_theory diatonic_chords` explains that a thaat is
  played over a drone instead of returning misleading triads.
- **+ Channel** is now collection → instrument → preset; the channel settings *Type* list is grouped by collection.
- Levels: every new sound was measured with `analyze_sound` against the existing ones (sustained leads ≈ −21 LUFS
  for a held C5, plucked models −23…−27, beatbox kick ≈ −18, snares ≈ −22).

**Also new**
- `write_melody` (and melody strings everywhere): a `~` after a note's length slides into the next note — meend,
  slurs and bends on mono instruments with glide (`"C4:4~ Db4:2"`). The note overlaps the next by up to half a step,
  like bass-line slides, so swing can't open a gap. A length with junk after it (`"C4:4x"`) is now refused instead of
  silently read as 4.
- `add_transition reverse_swell` plays the tonic chord of the project's scale (sus2/sus4 for scales without a third,
  the scale's own fifth for locrian and iwato) instead of guessing minor/major from the scale's name.
- Roman numerals in the thaats are spelled like the scale (D bhairav's II = Eb).

**Fixes**
- A **velocity-0 note** (allowed by MCP and imports) no longer throws inside the clap, cowbell or click-roll
  envelopes; any note the Web Audio API refuses is now dropped on its own instead of making the scheduler retry the
  same range and stack the other notes on top of each other.
- **Selecting a playlist clip shrank it** (it looked collapsed): the dropdown control's CSS class was `.sel`, the
  same class that marks selected clips, notes, velocity bars and spatial rows, so a selected clip was capped at
  180 px and padded (long selected notes in the piano roll too). Dropdowns are now `.ui-select`.
- **Windows didn't move when dragged by the middle of the title bar**: the toolbar strip swallowed the pointer. The
  whole bar drags now, except its real controls; the drag numbers (BPM, Steps) are marked as controls and gained
  arrow-key support.
- QA round on the new instruments: the siren's wobble stops with the note (live notes leaked a running oscillator);
  the scratch and zap sweeps start at the note (offline renders swept early); slurred flute/reed/erhu notes carry
  their vibrato on (in phase) instead of restarting it; high world-string notes (from about A#5–G6 up,
  depending on sustain) now ring for the sustain they ask for, and C7–C8 no longer click;
  the Indian Fusion template retunes the sitar's sympathetic strings (`sa`) and the tabla to the chosen key;
  `list_instruments` with both `kind` and `category` shows the instrument.

## 0.5.0 — band instruments, spatial audio, ffmpeg export, plugins, Docker

**New instruments (GarageBand-style band)**
- **Grand Piano** (`piano`): modelled — inharmonic partials, hammer hardness and spectrum follow velocity, prompt +
  aftersound decay, beating unison strings, no dampers above G6. Presets Grand, Bright, Upright, Felt, Honky Tonk.
- **Electric Piano** (`epiano`): FM tine or reed model with bark, bell and tremolo that stays in phase across notes.
  Presets Suitcase, Mellow, Bright Tines, Tremolo, Wurli.
- **Drawbar Organ** (`organ`): nine drawbars, percussion, key click, overdrive, slow/fast rotary. Presets Jazz, Gospel,
  Rock, Soft, Church.
- **Guitar** (`guitar`): Karplus–Strong string with fractional-delay tuning, acoustic/nylon/electric body, pluck
  point, palm mute, amp drive. Presets Acoustic, Nylon, Clean Electric, Muted, Overdrive.
- **Bass Guitar** (`bass`): finger, pick, slap, upright; pickup comb, mono glide. Presets Finger, Pick, Slap, Muted,
  Upright.
- **String Ensemble** (`strings`): 1–8 players, delayed vibrato, legato/staccato/pizzicato. Presets Ensemble, Slow
  Strings, Solo Cello, Solo Violin, Staccato, Pizzicato.
- Physical-model notes are rendered per pitch and velocity layer in background Web Workers (prewarmed from the
  project's notes, cached with an LRU budget that spares the open project's notes); offline renders wait for the
  prewarm, playback doesn't have to. A live note that isn't rendered yet plays a rendered neighbour (within a fifth)
  repitched while it renders, and selecting or playing a modelled channel prewarms the octave around it — only a
  note with no neighbour at all is rendered on the spot.
- New **Pop Band** template (piano, bass guitar, acoustic guitar, strings, drums).
- The FM synth now blocks the DC offset that integer ratios produce (inaudible, but it skewed meters).

**Spatial (Dolby Atmos-style) mixing**
- Mixer inserts can be **3D objects** (x/y/height + LFE send) around and above the listener; the rest is the stereo
  bed. Project setting: spatial mix on/off and monitoring (stereo fold-down or **binaural** HRTF on headphones).
- New **Spatial window** (toolbar cube): room view with draggable objects, height/LFE knobs, quick positions, speaker
  layout; mixer strips show **3D** for objects; right-click → *Make 3D object…*.
- Position automation (`spatialX/Y/Z` of an insert) — objects move over time; after a clip they stay put.
- Exports (48 kHz / 24-bit): **binaural**, **5.1**, **7.1**, **7.1.4** (WAVE_FORMAT_EXTENSIBLE with channel masks;
  constant-power pairwise panning + height crossfade; room positions map onto the layout like an object renderer:
  front corners = L/R, sides = side surrounds, rear corners = rear surrounds), **object stems** + positions JSON, and an experimental
  **ADM BWF** (bext + chna + axml, ITU-R BS.2076 timed Cartesian positions; not Dolby-certified).
- MCP: `set_spatial`, `place_object`, `move_object`, `export_spatial`, prompt `spatial_mix`; `get_project` shows
  objects. Binaural monitoring/export is level-matched to the stereo mix (−3.5 dB HRTF trim on objects); ADM
  blocks glide between positions sampled every 32nd note (holds use `jumpPosition`) and cover the render's tail; exports that would exceed the 4 GB WAV
  limit are refused before rendering, and render uploads may now be up to 4 GB. Core: `encodeWav` writes multichannel/extensible WAVs with extra chunks and pads odd data sizes.

**Docker**
- Image with ffmpeg, a non-root user, `tini` and a health check; `docker-compose.yml` with a read-only root
  filesystem, dropped capabilities, memory limit, localhost-only port and an optional Caddy HTTPS profile
  (`deploy/Caddyfile`); `docs/docker.md` (configuration, HTTPS, backups, upgrades, password reset, troubleshooting).
- `/api/health` answers to any Host name (container health checks) — every other route still checks `ALLOWED_HOSTS`.
- The startup banner shows `PUBLIC_URL` when it is set.

**Export formats (ffmpeg)**
- File → **Export song as…** MP3, AAC (.m4a), Ogg Vorbis, Opus, FLAC, Apple Lossless (.m4a) and AIFF (bitrate choice
  for lossy formats, 24-bit lossless, title/artist tags): rendered in the browser, converted by ffmpeg on the server.
- **Settings → Audio export** shows whether ffmpeg is installed (version, encoders, every format's status); admins can
  re-check. `FFMPEG_PATH`, `FFMPEG_TIMEOUT_SEC`, `FFMPEG_MAX_JOBS`.
- MCP: `list_export_formats` (what can be exported here, bitrates) and `export_audio` (render + convert, returns the URL).
- REST: `GET /api/exports/formats`, `GET /api/system/ffmpeg`, `POST /api/system/ffmpeg/refresh` (admin),
  `POST /api/exports/:name/convert`. Exports lists and downloads now include the new formats.
- Hardening: only PCM/float WAVs are converted, with the PCM decoder forced; per-format channel limits with a clear
  message (MP3 stereo, Ogg ≤ 6, Apple Lossless ≤ 7, AAC/Opus/FLAC ≤ 8 channels; lossy formats need speaker
  positions, so ADM/object renders convert to lossless only); conversion failures and timeouts are reported (422/504)
  instead of "Server error"; at most 3 conversions per user queued, output names reserved only when a conversion
  starts; invalid numeric environment values fall back to their defaults.

**Plugins (your own instruments, effects and note generators)**
- Plugins are `.zip` packages with a `plugin.json` manifest: **DSP instruments** and **effects** (one JavaScript file
  run in the browser's AudioWorklet through a generated harness), **sample instruments** (multisampled key/velocity
  zones, no code) and **generators** (write notes into a pattern; run in a sandboxed, network-less iframe worker with a
  2 s limit). Five MIT examples in `plugins/examples` (Chiptune, Kalimba, Tape Wobble, Euclidean Rhythms, Counter
  Melody); `npm run plugin:pack` validates and zips a plugin folder. Guide: `docs/plugins.md`.
- **Settings → Plugins**: install with a review dialog (author, type, permissions, files, SHA-256) and a trust warning
  that must be confirmed; updates, enable/disable, remove, plugin errors. Plugins are per user; admins can turn them off
  (Settings → Server → *Allow plugins*, or `PLUGINS_ENABLED=false`). Open studios pick up installs, updates and the
  admin switch without a reload.
- Instrument plugins in the Browser and Channel settings, effect plugins in every insert (automatable params can be
  automated), **Generate** window (piano roll → *Gen*).
- Explicit permissions (`audio-processing`, `samples`, `generator`, `project-read`); network, storage, files, account
  and similar are never granted. Hardened zip reader; code may not `import`/`importScripts`; DSP output is cleaned
  (NaN/∞/runaway values), crashing effects are bypassed, voices are capped by the manifest's polyphony and end ≤ 10 s
  after note-off; generated notes are validated and clamped. Projects that use a missing or disabled plugin still open
  (silent channel, pass-through effect, settings kept). Details in `docs/security.md#plugins`.
- MCP: `list_plugins`, `run_generator`; `add_channel`/`update_channel` and `add_effect`/`update_effect` take plugins
  with validated params. Claude can't install plugins (API tokens get 403 on install).
- REST: `/api/plugins` (list, inspect, install with `trust: true`, enable/disable, remove, worklet/code/samples),
  `/sandbox/generator.html`; WebSocket hint `plugins-changed`; browser job kind `generator`.

**Skills**
- `skills/`: music-production skills for Claude Desktop / claude.ai / Claude Code users — `greanteadawy-beatmaking`
  (workflow + genre recipes and sound palette), `greanteadawy-arranging`, `greanteadawy-mixing` (mixing by the
  numbers with `render_mix`, report → fix table), `greanteadawy-spatial-mix` and `greanteadawy-plugin-author` (plugin
  templates and a Python packer that ports the studio's install checks). `npm run skills:pack` checks them and writes
  uploadable zips to `skills/dist/`.
- Developer skills in `.claude/skills/`: `spatial-audio`, `plugin-system` (the security invariants), `write-plugin`,
  `export-formats`.

## 0.4.0 — production & sound quality (music-industry review)

**Sound — existing songs will sound a little different**
- Velocity now follows a squared curve (1.0 = 0 dB, 0.8 = −3.9 dB, 0.45 = −14 dB) and softer notes are darker. Notes at
  the default velocity are about 2 dB quieter than before; ghost notes are much quieter (as intended).
- The master limiter now really reaches its ceiling: its compressor's automatic makeup is removed exactly (replicating
  the browser's algorithm), its threshold sits 1.5 dB under the ceiling and an oversampled soft clip takes the last bit.
  Driven masters come out ~1.5–2.5 dB louder at the same settings (new projects another ~1.9 dB from the 0 dB master
  fader); new projects get a −1 dB ceiling. Every effect parameter now starts at its value instead of gliding into it
  at the start of playback/renders.
- **Compressor**: the browser's hidden automatic makeup gain (≈ +7 dB at the defaults) is removed — the Makeup knob is
  the only makeup now. Songs that use a compressor get quieter on that insert; raise Makeup to taste.
- New projects have the master fader at 0 dB (it sits after the limiter); existing projects keep theirs.
- Reverb rooms are generated anew (early reflections, highs decaying faster, independent left/right); the convolver
  normalizes their level. The reverb's damping/low-cut and the delay's tone filter are now flat Butterworth filters
  (before, a ~1 dB-Q bump coloured them slightly), and the delay repeats are high-passed at 120 Hz.
- The sampler fades the last 4 ms of a (trimmed) sample, and audio clips get 3 ms edge ramps, so cuts no longer click.
- `render_mix` ignores solos left on in the studio (Claude always hears the whole mix).

**New**
- Kick-triggered sidechain (`pump` with a trigger channel), EQ high/low-pass, parallel compression (`mix`), stereo
  `monoBelow`, reverb `size`, delay repeats high-passed.
- Per-channel groove (nudge in ms, swing share); swing follows slightly off-grid notes.
- Markers above the playlist; audio clip gain, fades and repitch-to-tempo; sampler trim, sustain loop and cutoff.
- 24-bit and dithered 16-bit WAV export, stem export (File menu and `export_stems`).
- MCP: `apply_groove`, `add_fill`, `add_transition`, `set_markers`, `analyze_sound`, `export_stems`; voicings and register
  for `add_chords`; degree bass lines with slides for `add_bassline`; `render_mix` targets, true peak, loudness range,
  limiter gain reduction, low-end note and width; gain/fade/repitch options for audio clips; a guide with mixing numbers.
- Presets: Lo-fi Keys, Strings, Riser Noise, Reverse Swell (subtractive synth), Felt Piano (FM), Sub Drop (808), Trap kick (short,
  above the 808). Templates use shared reverb/delay buses, high-passes and kick sidechain; the stereo shaper defaults to
  width 1.
- Groove presets humanize in milliseconds (a few ms, not tens), keep accented hats at normal velocities so presets can
  be re-applied, and write ghost snares at 0.4; the guide explains swing vs MPC percentages, sidechain depths per
  role and a drum-bus recipe.

## 0.3.0

Accounts and API tokens, documentation, Claude Code skills and agents, three QA rounds of fixes.
