---
name: greanteadawy-mixing
description: Mix and master a song in GreanTeaDawy by the numbers — gain staging, EQ, sidechain, buses, master limiter — using render_mix reports against a delivery target, then export it in the right format. Use when the user asks to mix, master, balance, make louder, fix muddiness/harshness, or deliver a track from GreanTeaDawy.
---

# Mixing & mastering in GreanTeaDawy

You can't hear, but `render_mix` measures the mix in the user's browser like a mastering engineer's meters (BS.1770
LUFS, true peak, limiter gain reduction, spectrum, low-end note and width, loudness per section, per-channel stems).
Mix in a loop: **measure → change one thing per problem → measure again**. Never report a mix as done without a clean
render.

## 0. Prepare

- `get_studio_status` (a studio tab must be open), `get_project` (inserts, routing, effects), `save_version
  name="before mix"`.
- Pick the target with the user: `streaming` (−14 LUFS, −1 dBTP), `apple-music` (−16), `hip-hop` (−9), `club` (−8),
  `edm` (−7), `lo-fi` (−14), `broadcast` (−23), `podcast` (−16). Loud targets cost dynamics — say so.

## 1. First measurement

`render_mix target=<target>` (stems are on by default; `mode=pattern` for a loop). Read, in order: INVALID RENDER
(broken audio) → clipping/true peak → stem balance → spectrum/low end → target delta and limiter. The report's
**Hints** list the problems it found; [fixes.md](fixes.md) maps each one to tool calls.

## 2. Balance (the stems)

Start from the kick and set everything relative to it (stem LUFS from the report, change with `set_mixer volumeDb`
on the insert or `update_channel volume`):

| Element | Level |
|---------|-------|
| Kick | stem peak ≈ −6 dBFS |
| 808 / bass | kick +1…+3 dB (trap, drill) · kick −2…0 dB (house, pop) |
| Snare / clap | kick −1…−3 dB |
| Lead / vocal / topline | kick −2…0 dB |
| Hats, shakers | kick −8…−12 dB |
| Pads, chords, keys | kick −10…−12 dB |
| FX, risers | below the pads, except on transitions |

## 3. Clean up

- **High-pass** everything that isn't kick or bass: `add_effect type=eq params={"hpf":120}` (100–200 Hz pads, keys,
  leads, hats; 60–80 Hz snares/claps).
- One effect of a type per insert keeps `effectId=<type>` unambiguous; otherwise use the effect ids `get_project` shows.
- **Mud** (low-mid > 25 %): eq `{"mid":-3,"midFreq":300,"midQ":1}` on pads/keys/bass.
- **Harsh** (high-mid+high > 40 %): eq `{"high":-3,"highFreq":6000}` on hats/cymbals/bright synths. **Dull** (< 6 %):
  `{"high":2,"highFreq":8000}` on hats or the master.
- **Low end in mono**: `stereo {"monoBelow":120,"width":1}` on bass/808/pads; never widen a bass.
- **Kick vs 808**: `analyze_sound` both; fundamentals ≥ 2 semitones apart (kick `tune`), short kick (decay ≤ 0.3 s),
  then **sidechain**: `add_effect type=pump params={"source":"Kick","depth":0.4,"shape":0.25}` on the 808/bass insert
  (pads: depth 0.6–0.8, shape 0.4–0.5 for an audible pump).

## 4. Space and glue

- **Shared reverb**: a free insert no channel routes to (`get_project` shows them; `set_mixer insert=<n> name="Reverb"`
  creates/names it), `reverb {"mix":1,"decay":2,"size":0.5}`, eq hpf 200 on it;
  feed it with `set_mixer insert=<n> sends=[{"to":<reverb insert>,"amount":0.2}]` (0.1–0.3). Same for a delay bus
  (`delay {"mix":1,"feedback":0.35}`). One bus each beats a reverb on every channel.
- **Drum bus**: route drum inserts to one insert (`set_mixer output=<bus>`), then `compressor
  {"threshold":-30,"ratio":6,"attack":0.005,"release":0.1,"makeup":12,"mix":0.4}` (parallel glue — raise Makeup until
  the level matches bypassed) + `distortion {"drive":0.15,"mix":0.3}`.
- Pan supporting parts (hats ±0.2–0.4, percussion, doubled guitars ±0.6–0.9); kick, bass, snare, lead centered.

## 5. Master

- The master (insert 0) already has a limiter: set it, don't add a second one —
  `update_effect insert=0 effectId=limiter params={"ceiling":-1}` (−0.5 for club/EDM). Keep the master fader at 0 dB
  (it sits *after* the limiter).
- `render_mix target=…` gives the exact change: "change the master limiter input gain by +X dB". Apply it with
  `update_effect insert=0 effectId=<limiter> params={"gain":…}`.
- If the report says the limiter reduces more than ~6–8 dB, stop pushing: fix the balance, tame the loudest stem, or
  add parallel compression instead.
- Check **loudness per section**: the hook should be 1–3 dB louder than verses; if not, it's an arrangement problem
  (see `greanteadawy-arranging`), not a mix one.

## 6. Deliver

- `save_version name="mix v1"`.
- `list_export_formats` → `export_audio format=wav bitDepth=24` (master), `flac`, `mp3 bitrate=320`, `aac` …
  (formats other than WAV need ffmpeg on the server; the tool says when they're unavailable).
- `export_stems` for a mixing engineer or collaborator (each channel with its insert FX and sends, no master bus).
- Tell the user the final numbers (LUFS, true peak, limiter reduction) and what you changed.

[fixes.md](fixes.md) — report hint → fix.
