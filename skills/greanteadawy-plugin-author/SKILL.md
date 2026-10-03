---
name: greanteadawy-plugin-author
description: Write a GreanTeaDawy plugin — a DSP instrument, a sampled instrument, an audio effect or a note generator — from the user's idea, validate it and pack it as an installable .zip. Use when the user wants a custom synth, effect, sample instrument, arpeggiator/rhythm/melody generator or "my own plugin" for GreanTeaDawy.
---

# Writing GreanTeaDawy plugins

A plugin is a `.zip` with a `plugin.json` manifest and, depending on its type, **one** JavaScript file and/or audio
samples. The user installs it in the studio (Settings → Plugins → Install plugin…) after reviewing what it asks for.
You write it; you can't install it — and you should remind the user to install only plugins they trust (yours included:
they should read the code you give them).

| Type | You write | Runs |
|------|-----------|------|
| DSP instrument | `gtd.registerInstrument({ createVoice })` | browser audio thread (AudioWorklet), per note |
| Sample instrument | no code — `samples` zones + WAV files | the studio's sampler |
| Effect | `gtd.registerEffect({ create })` | browser audio thread, per insert slot |
| Generator | `gtd.registerGenerator({ generate })` → notes | sandboxed iframe worker, 2 s limit, no network |

## Steps

1. **Pin down the idea**: type, sound/behaviour, 3–8 parameters a musician would want (with ranges and units), 2–4
   presets. Generators: what notes, in which range, how many per bar, what makes it musical (scale, accents, rests).
2. **Start from a template** in [templates/](templates) — `effect`, `instrument`, `sample-instrument`, `generator` —
   and adapt `plugin.json` + the code. Full API: [reference.md](reference.md).
3. **Write the code within the rules** (the studio refuses packages that break them):
   - one plain script: `import` and `importScripts` get the package refused; `require` doesn't exist and `eval` /
     `new Function` are blocked where it runs; there is no network, DOM, timers or storage either;
   - DSP: allocate buffers in `create`/`createVoice`, not in `process`; keep output within ±1; square the velocity for
     level; return `false` from a voice's `process` when it has decayed; no denormal-prone feedback (add a tiny DC
     offset or flush small values) and keep feedback < 1;
   - generators: synchronous, use `input.random()` (seeded) instead of `Math.random()`, stay inside `input.steps`,
     use `input.scaleNotes` for pitches.
4. **Validate & pack**: `python3 scripts/pack_plugin.py <folder>` (in this skill's folder) checks the manifest, the
   permissions, the referenced files and the code rules, and writes `dist/<id>-<version>.zip`. Fix whatever it
   reports. (In the GreanTeaDawy repository, `npm run plugin:pack -- <folder>` does the same with the server's own code.)
5. **Hand it over**: give the user the zip (and the source), say what it asks for (permissions) and how to use it:
   Browser → Sounds → Plugins (instruments), mixer insert → *+ Add effect…* → *Plugin: …* (effects), piano roll → **Gen**
   (generators) — or ask Claude with the GreanTeaDawy connector: `list_plugins`, `add_channel instrument="plugin"`,
   `add_effect type="plugin"`, `run_generator`.
6. **Test with the user**: after they install it, `render_mix` with it in the song (no `INVALID RENDER`, sensible
   LUFS); for generators, `run_generator` with two seeds and read the notes back with `get_pattern`.

## Sample instruments

Need real audio files: the user's recordings, or synthesize them (Python's `wave` + `struct`, 44.1/48 kHz, 16/24-bit,
trimmed, peaks around −3 dBFS). One zone per 3–6 semitones sounds natural; set `root` to the note actually recorded.
WAV is the safest format.

## Choosing the id and version

`id` = `yourname.plugin-name` (lowercase, digits, dots, dashes; 3–64 chars) and never changes — installing a zip with
the same id **updates** the plugin, so bump `version` (1.0.0 → 1.1.0) for every change you hand over.
