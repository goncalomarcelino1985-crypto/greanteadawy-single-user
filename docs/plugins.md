# Plugins

You can add your own **instruments**, **effects** and **note generators** to GreanTeaDawy. A plugin is a `.zip` with
a `plugin.json` manifest and, depending on its type, one JavaScript file and/or audio samples. Each user installs
plugins for their own account (Settings → Plugins). Claude can use the installed plugins too, but it can't install any.

> **Only install plugins from people you trust.** GreanTeaDawy sandboxes plugin code (no network, no access to your
> account, projects, files or other plugins' data) and checks everything a plugin produces, but a plugin is still
> someone else's code: it can make very loud or unpleasant sound, use a lot of CPU, or do something other than its
> description says. The studio shows this warning, the plugin's author, permissions and SHA-256 hash, and asks you to
> confirm before anything is installed. See [Security](#security) and [security.md](security.md#plugins).

![Installing a plugin: the review with the trust warning](screenshots/settings-plugins.png)

| Type | What it is | Runs where | Code? |
|------|------------|------------|-------|
| `instrument` (DSP) | a synth voice you write: `createVoice()` + `process()` | the browser's audio thread (AudioWorklet) | yes |
| `instrument` (samples) | multisampled audio files mapped across the keyboard, played by the studio's own sample engine | — | **no** |
| `effect` | an insert effect: `create()` + `process(input, output)` | the browser's audio thread (AudioWorklet) | yes |
| `generator` | writes notes into a pattern: `generate(input)` → notes | a sandboxed iframe worker, 2 s limit | yes |

The [examples](../plugins/examples) are complete, MIT-licensed plugins to copy from:

| Example | Type | Shows |
|---------|------|-------|
| `chiptune` | DSP instrument | band-limited pulse voice, envelope, release, select/bool params, presets |
| `kalimba` | sample instrument | key zones, root notes, `gain`/`attack`/`release` params, no code |
| `tape-wobble` | effect | modulated delay line, automatable params, stereo processing |
| `euclid` | generator | params → rhythm, the seeded `random()` |
| `counter-melody` | generator | the `project-read` permission: reads the pattern's notes and the scale |

```bash
npm run plugin:pack -- --examples                 # → plugins/dist/*.zip, ready to install
npm run plugin:pack -- path/to/my-plugin          # pack (and validate) your own folder
```

## Quick start: an effect in 20 lines

`my-gain/plugin.json`:

```json
{
  "id": "me.simple-gain",
  "name": "Simple Gain",
  "version": "1.0.0",
  "type": "effect",
  "author": "Me",
  "description": "Gain with a phase-flip switch.",
  "apiVersion": 1,
  "main": "dsp.js",
  "permissions": ["audio-processing"],
  "params": [
    { "key": "gain", "label": "Gain", "min": 0, "max": 2, "default": 1, "automatable": true },
    { "key": "flip", "label": "Phase flip", "type": "bool", "default": false }
  ],
  "presets": { "Unity": {}, "Half": { "gain": 0.5 } }
}
```

`my-gain/dsp.js`:

```js
gtd.registerEffect({
  create({ sampleRate, params }) {
    return {
      process(input, output, frames, params) {
        const g = params.gain * (params.flip ? -1 : 1);
        for (let c = 0; c < 2; c++) {
          for (let i = 0; i < frames; i++) output[c][i] = input[c][i] * g;
        }
      }
    };
  }
});
```

Then `npm run plugin:pack -- my-gain` and install `plugins/dist/me.simple-gain-1.0.0.zip` in Settings → Plugins.

## plugin.json

| Field | Required | Notes |
|-------|----------|-------|
| `id` | ✓ | 3–64 chars: lowercase letters, digits, `.` and `-`, e.g. `"acme.tape-echo"`. Identifies the plugin in projects; installing a package with the same id **updates** it. |
| `name` | ✓ | up to 48 chars |
| `version` | ✓ | `1.0.0` (semver-ish, `-beta.1` allowed) |
| `type` | ✓ | `instrument`, `effect` or `generator` |
| `apiVersion` | | `1` (the only version so far) |
| `main` | DSP / generators | the one `.js` file with the code |
| `permissions` | ✓ | see below |
| `params` | | up to 48 parameter definitions |
| `presets` | | `{ "Name": { key: value, … } }`, up to 64; the **first preset is the default**. Without presets you get `Default`. |
| `samples` | sample instruments | key zones, see [Sample instruments](#sample-instruments) |
| `author`, `description`, `license` | | shown in the install dialog, Settings and to Claude (`list_plugins`) |
| `homepage` | | `https://` only |
| `color` | | `#rrggbb` for the channel and Browser dot |
| `defaultKey` | | instruments: MIDI key the step sequencer plays (default 60 = C4) |
| `polyphony` | | instruments: 1–64 voices per channel (default 16); beyond that the oldest released, then the oldest held voice is cut |
| `melodic` | | instruments: `false` for drum-like sounds (default `true`); generators see it as `channel.melodic` |

### Permissions

A plugin declares what it needs; the install dialog shows it. Anything outside this list is refused, and some are
**never** granted to any plugin: `network`, `storage`, `files`, `account`, `cookies`, `clipboard`, `microphone`,
`camera` — the sandboxes don't have them in the first place.

| Permission | For | Means |
|------------|-----|-------|
| `audio-processing` | DSP instruments, effects | runs its own audio code in the audio thread |
| `samples` | sample instruments | ships audio files the studio plays (no code) |
| `generator` | generators | generates notes (sandboxed, time-limited) |
| `project-read` | generators (optional) | receives the notes of the pattern it writes into |

### Parameters

The same shape as the built-in instruments and effects: they become knobs in Channel settings / the Mixer, are
validated for Claude, and are stored in projects.

```json
{ "key": "cutoff", "label": "Cutoff", "min": 40, "max": 18000, "default": 2000, "curve": "log", "unit": "Hz", "automatable": true, "group": "Filter" }
{ "key": "wave", "label": "Wave", "type": "select", "options": ["saw", "square"], "default": "saw" }
{ "key": "sync", "label": "Sync", "type": "bool", "default": false }
```

- `key`: a short identifier (`[A-Za-z][A-Za-z0-9_]*`, ≤ 32 chars); names starting with `gtd` are reserved.
- Numbers: `min` < `max`, `default` inside, optional `step`, `unit` (≤ 8 chars), `curve: "log"` (needs `min > 0`).
- Selects: 1–24 `options` of ≤ 24 characters each; `default` is one of them (the first if omitted).
- `automatable: true` (effects): the parameter becomes an AudioParam — it can be automated in the playlist and
  changes smoothly. Other parameters reach the plugin as plain values when they change.
- Values are always clamped to the declared range (and rounded to `step` when it's set) before your code sees them.

## DSP plugins (instruments and effects)

Your `main` file is a plain script (not a module) that calls `gtd.registerInstrument(...)` or
`gtd.registerEffect(...)` once. It runs inside the browser's **AudioWorklet** — the audio thread — wrapped by a
harness the studio generates. In that scope you have JavaScript itself (`Math`, typed arrays, …) plus `sampleRate`,
`currentFrame` and `currentTime`; there is **no** network, DOM, storage, timers or `console` you can rely on. Your code
may not use `import` or `importScripts` (the package is refused), and `eval`/`new Function` are blocked by the
studio's Content-Security-Policy. Keep it to one self-contained file (≤ 512 KB).

Audio arrives and leaves as `Float32Array`s of `frames` samples (128 per call today — don't rely on it), always
stereo: index 0 = left, 1 = right.

### Instruments

```js
gtd.registerInstrument({
  // called for every note
  createVoice({ sampleRate, key, frequency, velocity, params }) {
    let phase = 0;
    let env = 1;
    let released = false;
    return {
      release() { released = true; },            // note-off (optional)
      process(output, frames) {                   // fill output[0] / output[1]
        for (let i = 0; i < frames; i++) {
          if (released) env *= 0.999;
          const s = Math.sin(phase) * env * velocity * velocity * params.gain;
          phase += (2 * Math.PI * frequency) / sampleRate;
          output[0][i] = s;
          output[1][i] = s;
        }
        return env > 0.0001;                      // false = this voice is finished
      }
    };
  }
});
```

- `velocity` is 0..1 (squaring it, like the built-in instruments do, keeps levels consistent with them).
- `params`: the channel's values (defaults + preset + edits), fixed for the voice's lifetime.
- Return `false` from `process` when the voice has died away; the harness also ends it 10 s after note-off at the
  latest. `output` starts at the note's exact start frame (the first block may be shorter).
- Each note is its own processor: be reasonable with per-voice memory, and set `polyphony` in the manifest.

### Effects

```js
gtd.registerEffect({
  create({ sampleRate, params }) {               // once per effect slot
    const buf = new Float32Array(sampleRate);    // allocate here, never in process()
    return {
      update(params) { /* optional: non-automatable params changed */ },
      process(input, output, frames, params) {   // params: current values (automatable ones per block)
        for (let c = 0; c < 2; c++) for (let i = 0; i < frames; i++) output[c][i] = input[c][i];
      }
    };
  }
});
```

### What the harness does for you (and to you)

- **Output is cleaned:** NaN/Infinity becomes 0 and samples are clamped to ±8 before they reach the mix (the master
  limiter does the rest). Still: keep your output around ±1.
- **Errors are contained:** if `create`/`createVoice`/`process` throws, an effect slot is **bypassed** (the audio passes
  through unchanged) and a voice ends. The error is shown in Settings → Plugins and Channel settings.
- **Missing or disabled plugins** don't break projects: their channels are silent, their effect slots pass audio
  through, and their settings are kept — install/enable the plugin again and they come back. The same applies when
  you share a project with someone who doesn't have the plugin.
- Plugins play in live playback **and** offline renders (export, stems, Claude's `render_mix`), so output must not
  depend on wall-clock time.

## Sample instruments

No code: list key zones and the studio's sampler plays them, repitched from each zone's root note.

```json
"permissions": ["samples"],
"samples": [
  { "file": "samples/c3.wav", "root": 48, "lo": 0,  "hi": 53 },
  { "file": "samples/c4.wav", "root": 60, "lo": 54, "hi": 65 },
  { "file": "samples/c4-soft.wav", "root": 60, "lo": 54, "hi": 65, "velHi": 0.5 },
  { "file": "samples/pad.wav", "root": 72, "lo": 66, "hi": 127, "loop": true }
],
"params": [
  { "key": "gain", "min": 0, "max": 2, "default": 1 },
  { "key": "attack", "min": 0.001, "max": 1, "default": 0.002, "curve": "log", "unit": "s" },
  { "key": "release", "min": 0.02, "max": 3, "default": 0.3, "curve": "log", "unit": "s" }
]
```

- Up to 128 zones; `lo`/`hi` are MIDI keys (inclusive), `velLo`/`velHi` 0..1. For a note, the zones that contain the
  key and velocity are candidates and the one with the closest root wins (any zone if none matches).
- Files: `.wav`, `.mp3`, `.ogg` or `.flac` (checked by their content, not just the name). WAV is safest everywhere.
- Params named `gain`, `attack` and `release` are used by the sampler if you declare them.
- `plugins/examples/kalimba/make-samples.mjs` shows how its samples were synthesized.

## Generators

A generator writes notes into a pattern for one channel — from the **Generate** window (piano roll → *Gen*) or by
Claude (`run_generator`). Its code runs in a hidden, sandboxed iframe with an opaque origin and no network access, in
a fresh Web Worker per run that is stopped after **2 seconds**. Only data goes in and out.

```js
gtd.registerGenerator({
  generate(input) {
    const notes = [];
    for (let s = 0; s < input.steps; s += 4) {
      notes.push({ step: s, length: 2, key: input.channel.rootKey, velocity: 0.6 + input.random() * 0.3 });
    }
    return notes;
  }
});
```

`input`:

| Field | |
|-------|--|
| `params` | your parameter values (defaults + preset + what the user/Claude set) |
| `steps`, `bars`, `stepsPerBar` | the range to fill, in 16th-note steps (0-based) |
| `key`, `scale`, `scaleNotes` | the project's key (e.g. `"A"`), scale name and its pitch classes (0–11) |
| `bpm`, `timeSig` | tempo and time signature |
| `channel` | `{ name, kind, melodic, rootKey }` of the target channel |
| `seed`, `random()` | a seeded random number generator: the same seed + params give the same notes |
| `notes` | only with `project-read`: `[{ channel, step, length, key, velocity }]` already in that range of the pattern |

Return an array of `{ step, length?, key, velocity? }` (`length` in steps, default 1; `velocity` 0..1, default 0.8;
quarter-step resolution). The result is treated as untrusted: notes outside the range or with invalid values are
dropped, values clamped, at most 4096 kept. The notes replace that range of the channel in the pattern (one undo step).

Use `random()` rather than `Math.random()` so results are reproducible. `generate` must be synchronous.

## Packaging

```
my-plugin/
  plugin.json
  dsp.js            (or generator.js — whatever "main" says)
  samples/*.wav     (sample instruments)
  README.md, LICENSE, icon.png   (optional, packed if present)
```

`npm run plugin:pack -- my-plugin` validates the folder exactly like the server does (manifest, code checks, a
round trip through the server's zip reader) and writes `plugins/dist/<id>-<version>.zip` with only the files the
plugin needs. Any zip tool works too, as long as:

- `plugin.json` is at the root (or inside a single top-level folder),
- the only `.js` file is `main`, and other files are `.json .wav .mp3 .ogg .flac .md .txt .png`,
- file names use letters, digits, `_ . - /` only (no spaces), at most 6 folder levels; no links, `..` or names that
  are both a file and a folder (hidden files and `__MACOSX/` are skipped);
- at most 256 files, 30 MB per file, 60 MB unpacked, 20 MB uploaded; `plugin.json` ≤ 64 KB, code ≤ 512 KB; files over
  1 MB may not compress more than 200:1.

## Installing, updating, removing

- **Settings → Plugins → Install plugin…** → choose the `.zip`. The studio shows the plugin's name, author, type,
  permissions, files and SHA-256 with the trust warning; tick *I trust … and want to install it* → **Install plugin**.
- A package with an id you already have is shown as an **update** (from version …) and replaces it; open studios switch
  to the new version without a reload.
- Each plugin can be switched **off** (its channels go silent, effects pass audio through) or **removed**.
- Plugins belong to your account; other users don't see or get them. Deleting a user deletes their plugins.
- Admins can turn plugins off for everyone (Settings → Server → *Allow plugins*); `PLUGINS_ENABLED=false` turns them
  off regardless of that setting.
- Installing needs the signed-in studio: API tokens (Claude, scripts) are refused.

## Using plugins

- **Browser → Sounds → Plugins**: instrument plugins with their presets; click to add a channel.
- **Mixer → insert → *+ Add effect…* → *Plugin: …***: effect plugins; knobs from their params, a preset picker;
  automatable params can be
  automated like any other.
- **Piano roll → Gen**: the Generate window (generator, preset, params, length).
- **Claude**: `list_plugins` (ids, params, presets, how to use each), `add_channel instrument="plugin" plugin="<id>"`,
  `add_effect type="plugin" plugin="<id>"`, `update_channel` / `update_effect` with validated params, and
  `run_generator plugin="<id>" pattern=… channel=…` (runs in your open studio's sandbox).

## Security

What protects you, in short (details in [security.md](security.md#plugins)):

1. **You decide**: nothing is installed without the review dialog and your explicit trust confirmation; Claude and API
   tokens can't install.
2. **Validation on upload**: hardened zip reader (paths, links, sizes, zip bombs, CRCs), manifest schema, only known
   permissions, only the main file may be code, no `import`/`importScripts`, samples must be real audio.
3. **The server never runs plugin code.** It stores it per user and serves it only to that user, wrapped:
   - DSP code only as an AudioWorklet module behind a harness that refuses to run anywhere else. The audio thread has
     no network, DOM, cookies or storage; the studio's CSP forbids `eval`.
   - Generator code only as `text/plain` to the studio, which hands it to the sandbox iframe (opaque origin,
     `connect-src 'none'`, its own CSP) where it runs in a Worker with the network APIs removed and a time limit.
4. **Output is data and gets checked**: audio is cleaned (NaN/∞/runaway values), notes are validated and clamped,
   crashes bypass or end the plugin, polyphony and voice lifetime are capped.

What a plugin *can* still do: make any sound (loud, harsh, silent), cost CPU while it plays, misbehave against its
description. DSP plugins of one studio share the audio thread, so a malicious DSP plugin could interfere with the
audio of other plugins or of the studio there — but not read your data or send anything anywhere. That's why the
trust confirmation exists.
