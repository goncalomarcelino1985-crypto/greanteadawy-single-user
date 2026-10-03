# GreanTeaDawy plugin API reference (apiVersion 1)

## plugin.json

| Field | Required | Notes |
|-------|----------|-------|
| `id` | ✓ | `^[a-z0-9][a-z0-9.-]{1,62}[a-z0-9]$`, e.g. `acme.tape-echo`; same id = update |
| `name` | ✓ | ≤ 48 chars |
| `version` | ✓ | `1.0.0` (optionally `-beta.1`) |
| `type` | ✓ | `instrument` · `effect` · `generator` |
| `apiVersion` | | `1` |
| `main` | DSP, generators | the one `.js` file |
| `permissions` | ✓ | see below |
| `params` | | ≤ 48 |
| `presets` | | `{ "Name": { key: value } }`, ≤ 64; the first is the default — keep it `{}` (= param defaults) |
| `samples` | sample instruments | ≤ 128 zones |
| `author`, `description` (≤ 600), `license`, `homepage` (https) | | shown to the user and to Claude |
| `color` | | `#rrggbb` |
| `defaultKey` | | instruments: MIDI note the step sequencer plays (default 60) |
| `polyphony` | | instruments: 1–64 voices per channel (default 16) |
| `melodic` | | instruments: `false` for drum-like sounds (default `true`) |

Allowed files: `.json .js .wav .mp3 .ogg .flac .md .txt .png`; only `main` may be `.js`; names: letters, digits,
`_ . - /`, ≤ 6 levels; hidden files are skipped; ≤ 256 files, 30 MB per file, 60 MB unpacked, 20 MB zipped; files over
1 MB compress at most 200:1; `plugin.json` ≤ 64 KB; code ≤ 512 KB. Select params: 1–24 options of ≤ 24 characters.

### Permissions

| Permission | Types | |
|------------|-------|---|
| `audio-processing` | instrument (DSP), effect | required when there's `main` |
| `samples` | instrument (samples) | required with `samples` |
| `generator` | generator | required |
| `project-read` | generator | optional: receive the pattern's existing notes |

Never granted (refused): `network`, `internet`, `storage`, `files`, `account`, `cookies`, `clipboard`, `microphone`,
`camera`.

### Params

```json
{ "key": "cutoff", "label": "Cutoff", "min": 40, "max": 18000, "default": 2000, "curve": "log", "unit": "Hz", "automatable": true, "group": "Filter", "step": 1 }
{ "key": "wave", "label": "Wave", "type": "select", "options": ["saw", "square"], "default": "saw" }
{ "key": "sync", "label": "Sync", "type": "bool", "default": false }
```

`key`: `[A-Za-z][A-Za-z0-9_]*`, ≤ 32, not starting with `gtd`. Numbers need `min < max`, `default` inside; `log`
needs `min > 0`. `automatable` (effects): becomes an AudioParam (automation, smooth changes). Values reach your code
already clamped.

## DSP instruments

```js
gtd.registerInstrument({
  createVoice({ sampleRate, key, frequency, velocity, params }) {   // velocity 0..1; params fixed for the voice
    return {
      release() {},                         // note-off (optional)
      process(output, frames) {             // output[0] = left, output[1] = right (Float32Array)
        // fill output[c][0..frames-1]; the first block may start mid-block (shorter)
        return true;                        // false = the voice is finished
      }
    };
  }
});
```

The harness ends a voice at most 10 s after note-off; beyond `polyphony` the oldest released voice is cut first, then
the oldest held one.

## Effects

```js
gtd.registerEffect({
  create({ sampleRate, params }) {          // once per insert slot
    return {
      update(params) {},                    // optional: non-automatable params changed
      process(input, output, frames, params) {  // stereo in → stereo out; params = current values
      }
    };
  }
});
```

In scope: `sampleRate`, `currentFrame`, `currentTime`, `Math`, typed arrays. Output is cleaned (NaN/∞ → 0, clamped to
±8); an exception bypasses the effect / ends the voice and is shown to the user.

## Sample instruments

```json
"permissions": ["samples"],
"samples": [{ "file": "samples/c4.wav", "root": 60, "lo": 54, "hi": 65, "velLo": 0, "velHi": 1, "loop": false }]
```

For a note, zones containing its key and velocity are candidates; the closest `root` wins. Params named `gain`
(0–2), `attack`, `release` (seconds) are used if declared.

## Generators

```js
gtd.registerGenerator({
  generate(input) {
    // input: { params, steps, bars, stepsPerBar, key, scale, scaleNotes (pitch classes 0-11), bpm, timeSig,
    //          channel: { name, kind, melodic, rootKey }, seed, random(), notes? (project-read) }
    return [{ step: 0, length: 2, key: 60, velocity: 0.8 }];   // steps = 16ths from 0; quarter-step resolution
  }
});
```

`notes` (with `project-read`): `[{ channel, step, length, key, velocity }]` already in the range. Output is checked:
invalid notes dropped, values clamped (key 0–127, velocity 0.01–1, length ≥ 0.25), ≤ 4096 notes, inside
`[0, steps)`. 2-second limit per run.
