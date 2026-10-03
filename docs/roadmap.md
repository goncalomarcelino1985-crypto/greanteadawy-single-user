# Roadmap & product review

GreanTeaDawy is reviewed by the read-only **music-industry advisor** agent (`.claude/agents/music-industry-advisor.md`):
a producer / mix-and-mastering engineer / A&R / DAW product lead with 20+ years of experience who reads the code and
says what keeps the music from sounding release-ready. This page records the review and what was done about it, so the
next round of development starts from the open items.

## Review 1 — verdict

> As a browser beat-sketching tool with an AI co-producer this is already unusually complete: the op-based model, the
> tool set, roman-numeral harmony, step-string drums and a BS.1770-correct `render_mix` loop are things most hobby DAWs
> never ship. What held the sound at "good demo" level was the signal path rather than the workflow: synthesized-only
> drums, a basic master limiter, grid-only ducking and linear velocity. Fix those and give Claude numeric mix targets,
> and the gap to release-ready closes dramatically.

## Done in response

(Paths: `core/` = `packages/core/src/`, `client/` = `client/src/`, `mcp/` = `server/src/mcp/`.)

| Recommendation | What changed | Where |
|---|---|---|
| Velocity curve and velocity → timbre | squared velocity curve (≈ 40 dB range); softer = darker for snare, hats, clap, kick click, synth filter, FM index, sampler cutoff | `client/src/audio/instruments.js` |
| Note-triggered sidechain | `pump` gets a `source` channel and ducks on every note of it (also muted ghost channels and live notes) | `core/effects.js`, `client/audio/effects.js`, `engine.triggerNote` |
| Master chain | limiter clip stage 4× oversampled, makeup compensation computed from the threshold, default ceiling −1 dB; true-peak meter; TPDF dither for 16-bit; 24-bit exports | `client/audio/effects.js`, `core/analysis.js`, `core/wav.js` |
| Per-channel groove | `nudge` (ms) and `swingMix` per channel; swing is a continuous time warp, so humanized notes keep their swing | `core/model.js`, `core/timeline.js`, Transport |
| Reverb quality | seeded IR with independent L/R, early reflections (`size`), frequency-dependent decay; the convolver normalizes its level; rebuilt only once a knob settles | `client/audio/effects.js` |
| Voicings & a bass language | `add_chords` voicings (open, drop2, drop3, spread, shell, rootless), inversion and register; `add_bassline` degree lines with ties, accents, ghosts and 808 slides | `core/builders.js`, `mcp/tools/notes.js` |
| Mixing primitives | EQ high-/low-pass (flat Butterworth), compressor `mix` (parallel, dry path delayed by the compressor's whole-frame 6 ms look-ahead), stereo `monoBelow` (Linkwitz-Riley crossover), non-resonant delay feedback filters with a high-pass, 4× oversampled distortion | effects |
| Sections, fills, transitions | project **markers** (+ `set_markers`, created by `arrange_song`), `add_fill`, `add_transition` (risers, downlifters, swells, snare builds, crashes, sub drops, impacts) | `core/ops.js`, `mcp/tools/production.js`, Playlist ruler |
| Richer `render_mix` | true peak, loudness range, limiter gain reduction (peaks after vs before the limiter across the render), strongest low frequency (Hz + note) for the mix and every bass stem, low-end width, delivery targets with a feasible fix (limiter gain or master fader), masking and squashing hints | `core/analysis.js`, `client/audio/render.js`, `mcp/tools/mix.js` |
| Stem export | `export_stems` tool and File menu → Export stems (24-bit, insert FX + sends, no master bus) | `client/lib/jobs.js`, `server/src/api.js` |
| Audio clip gain/fades, loop tempo fit | clip `gain`, `fadeIn`/`fadeOut` with anti-click edges, `rate` (repitch to the project tempo) in the engine, UI and MCP | `engine.playAudioClip`, Playlist, `add_audio_clip`/`update_clips` |
| Claude: numbers in the guide | gain staging targets, high-pass habits, sidechain and send recipes, limiter-by-target, velocity table, caveats | `server/src/mcp/guide.js`, prompts |
| Claude: measure one sound | `analyze_sound` (pitch + cents, low-end note, envelope −20/−40/−60 dB) | browser job `sound` |
| Claude: feel presets | `apply_groove` (boom-bap, dilla, lo-fi, trap, drill, house, afrobeats, straight) | `mcp/tools/production.js` |
| Quick wins | 3 ms clip edge ramps, oversampled kick/808 drive, presets *Lo-fi Keys*, *Strings*, *Riser Noise*, *Reverse Swell*, *Felt Piano*, *Sub Drop*; templates rebuilt with shared reverb/delay buses, high-passes and kick sidechain | instruments, templates |

## Review 2 — verdict

> 0.4.0 fixed most of the signal path on paper, and the `render_mix` loop with targets, true peak, limiter gain
> reduction and per-stem low notes is now better than most hobby DAWs. Three implemented pieces still pushed Claude
> toward amateur results — over-random groove presets, a compressor with hidden makeup gain and a limiter that stopped
> short of its ceiling — and the remaining gap to release-ready is mostly sampled drums and a true look-ahead limiter.

Corrections made after review 2: groove humanize in milliseconds and accent floors of 0.75 (re-applicable presets),
ghost snares at 0.4, compressor automatic makeup removed (exact Web Audio/Chromium formula), limiter calibrated so
driven masters land at the ceiling (and the master fader defaults to 0 dB because it sits after the limiter), a
*Trap* kick preset that stays out of the 808's way, quieter risers/swells, sub drops that dive to the real sub octave,
stereo width default 1, swing-vs-MPC conversion and per-role sidechain depths in the guide, a drum-bus recipe, and a
genre-aware "bass-heavy" hint.

## 0.5.0 — what was added

| Area | What changed | Where |
|---|---|---|
| Band instruments (the "A piano/keys instrument beyond FM" item and more) | modelled grand piano, guitar, bass guitar and pizzicato strings rendered in background workers; FM/reed electric piano; drawbar organ with rotary; string ensemble; Pop Band template | `client/audio/band.js`, `models.js`, `modelPool.js`, `core/instruments.js` |
| Share/delivery formats (was "MP3/OGG share export") | ffmpeg conversions to MP3, AAC, Ogg, Opus, FLAC, ALAC, AIFF; availability in Settings; `list_export_formats` / `export_audio` for Claude | `server/src/ffmpeg.js`, Settings → Audio export |
| Spatial mixing | 3D objects with position automation, binaural monitoring, 5.1/7.1/7.1.4, object stems, experimental ADM BWF | `docs/spatial.md` |
| Extensibility | sandboxed user plugins (DSP instruments/effects, sample instruments, note generators) with permissions and a trust review | `docs/plugins.md` |
| Deployment | Docker image + compose with ffmpeg and an HTTPS profile | `docs/docker.md` |
| Skills | music-production skills for Claude users (beat making, arranging, mixing by numbers, spatial, plugin authoring) in `skills/` (`npm run skills:pack`); developer skills for spatial audio, the plugin system, writing plugins and export formats | `skills/`, `.claude/skills/` |

## 0.6.0 — what was added

| Area | What changed | Where |
|---|---|---|
| World collections | flutes (5), beatbox (5), Indian (7) and East Asian (10) instruments; sitar/tanpura/santoor/koto/guzheng/pipa/shamisen as physical models with jawari, sympathetic strings and skin hits; Indian Fusion and East Asian Lo-fi templates; Japanese pentatonic and thaat scales | `core/instruments.js`, `client/audio/world.js`, `models.js`, `core/templates.js`, `core/music.js` |
| UI fixes | selected clips/notes no longer pick up dropdown sizing; windows drag from anywhere on the title bar | `styles.css`, `ui/Window.jsx` |

## Still open (next candidates)

**Must-have**
- **Factory sample kits** (still the loudest "demo" tell according to both reviews) — a small CC0/MIT drum kit per template genre (trap claps, boom-bap snares, lo-fi kicks are
  sampled sounds by nature), flagged as factory in `list_samples`.
- **Look-ahead limiter in an AudioWorklet** with true-peak control (the current limiter is a fast compressor plus an
  oversampled clipper).

**Should-have**
- More grooves (shuffle, 2-step, dembow); sampled factory multisamples (could ship as sample-instrument plugins).
- ~~Audio recording into audio clips~~ — done in 0.7.0 (the recorder: count-in, latency compensation, takes placed on
  the playlist), with a wave editor and pitch correction.
- Time-stretching for audio clips on the playlist (the wave editor can stretch a sample; clips still only repitch),
  sampler slicing and velocity layers, comping several takes into one.
- Per-note slide flag in the piano roll, per-pattern swing, MIDI CC / mod wheel, tempo automation.
- Plugins: a plugin's own custom UI panel (sandboxed iframe) instead of generated knobs; MIDI-effect plugins (arp,
  chord, scale) applied at playback; sharing a project together with the plugins it uses.
- Spatial: Dolby-certified ADM/IAB delivery needs Dolby's tools; a head-tracked binaural preview.

**Nice-to-have**
- Reference-track import with band-by-band comparison in `render_mix`, A/B render of two
  versions, a multiband compressor, a transient shaper for the synthesized drums, a bus spectrum view in the visualizer.

## How to run a review

The advisor is read-only and is meant to run after QA and tests pass, at most a couple of times per release (0.4.0
used both runs; 0.5.0 had none left, so the items above were not re-reviewed). With
Claude Code in this repository: *"Run the music-industry-advisor agent and summarise its top recommendations"*. Record
the outcome here.
