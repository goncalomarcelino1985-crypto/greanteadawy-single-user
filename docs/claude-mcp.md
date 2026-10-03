# Making music with Claude (MCP)

GreanTeaDawy includes a [Model Context Protocol](https://modelcontextprotocol.io) server. Once connected, Claude can
create projects, design sounds, program drums, write chords, basslines and melodies, give them a groove, add fills
and transitions, use your samples, arrange the song, automate, mix, render and *measure* the mix and single sounds,
export stems, save versions and press play — while you watch every edit appear in the studio.

![Claude activity in the studio](screenshots/claude-activity.png)

## Two ways to connect

| | Streamable HTTP (`/mcp`) | stdio bridge (`server/src/mcp/stdio.js`) |
|---|---|---|
| Best for | Claude Code, any HTTP-capable MCP client, remote servers | Claude Desktop and other stdio-only clients |
| How it reaches the studio | Directly | Forwards to the running web server over REST (`GREANTEADAWY_URL`) |
| Auth | `Authorization: Bearer gtd_…` or `?token=gtd_…` | `GREANTEADAWY_TOKEN=gtd_…` |
| Live in the browser | Yes | Yes (when the web server runs; otherwise it edits the files directly, without live updates or rendering) |

The studio's **Settings → API & MCP** shows ready-to-copy commands with your server's URL and token.

### Claude Code

```bash
claude mcp add --transport http greanteadawy http://localhost:3001/mcp \
  --header "Authorization: Bearer gtd_xxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "greanteadawy": {
      "command": "node",
      "args": ["/absolute/path/to/greanteadawy/server/src/mcp/stdio.js"],
      "env": {
        "GREANTEADAWY_URL": "http://127.0.0.1:3001",
        "GREANTEADAWY_TOKEN": "gtd_xxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

### Clients that can't send headers

Use the URL form `https://your-server/mcp?token=gtd_…`. Treat that URL like a password.

## API tokens (optional, recommended)

- Each account has at most one personal token. **Generate** shows it once — copy it right away. **Regenerate**
  replaces it (the old one stops working immediately, and open connections using it are closed). **Delete** revokes it.
- Tokens are stored only as SHA-256 hashes on the server.
- A token acts as *you*: Claude sees and edits only your projects and samples. Tokens can't manage accounts, change
  passwords or create tokens — that needs a signed-in browser.
- **Without a token**: allowed only when an admin enables *Allow MCP without a token from this computer*
  (Settings → Server, on by default for local installs) and only for requests from the same machine addressed to
  `localhost`. Such requests act as the account chosen in Settings → Server (default: the first admin). Anything coming
  over the network always needs a token. Setting `MCP_TOKEN` in the environment also turns token-less access off.

## What Claude can do

78 tools in nine groups — see the full [MCP reference](MCP.md):

- **Projects**: status, list/create/open/duplicate/delete projects, get the song as a readable summary, update tempo,
  key, scale, swing, time signature, versions (save/list/restore), undo.
- **Sounds**: list instruments & effects with every parameter, add/update/clone/move/remove channels (incl. groove:
  nudge and swing share), preview a sound, **analyze_sound** (pitch, low-end note, envelope of one note), music theory
  (scales, diatonic chords spelled for the key, chord notes).
- **Notes**: patterns, drum step strings, piano-roll notes, melodies from compact strings, chord progressions (symbols or
  roman numerals, voice-led, block/rhythm/arp/broken styles, **voicings** close/open/drop2/drop3/spread/shell/rootless,
  register), basslines from a rhythm or a **degree line with slides**, rolls, copy/transform (transpose, shift, quantize,
  humanize, legato, velocity, double, reverse, stretch, strum).
- **Arrangement**: place patterns, arrange whole songs from sections (with **markers**), move/resize/remove clips, copy
  bar ranges, tracks, automation clips, play/stop, MIDI export.
- **Production**: **apply_groove** (genre feel presets), **add_fill** (snare rolls, tom runs, hat rolls, stutters,
  drop-outs, kick builds), **add_transition** (risers, downlifters, swells, snare builds, crashes, sub drops, impacts).
- **Mix**: mixer inserts (volume in dB, pan, routing, sends), effects (add/update/move/remove; kick-triggered sidechain
  with `pump` `source`), **render_mix** with delivery targets, **export_stems**, and **list_export_formats** /
  **export_audio** (MP3, AAC, Ogg, Opus, FLAC, ALAC, AIFF via ffmpeg).
- **Spatial**: `set_spatial`, `place_object`, `move_object`, `export_spatial` (binaural, 5.1, 7.1, 7.1.4, object stems,
  ADM BWF).
- **Plugins**: `list_plugins`, `run_generator`; plugin instruments and effects through `add_channel` / `add_effect`.
- **Samples**: list and search (by folder, name, tags, key, tempo), full metadata & analysis, re-analyse, rename,
  folders (`sample_folders`, `move_samples`), delete (with what goes silent), **edit** (`edit_sample`: trim, fades, gain,
  normalise, reverse, speed, time stretch, pitch shift and **pitch correction**, saved as a new sample or over the
  original), use as sampler channels or audio clips (with gain, fades and repitch-to-tempo).

Ready-made **prompts**: `make_beat` (genre, mood, bpm, reference), `mix_review` (target), `use_my_samples` (idea)
and `spatial_mix`.

### Skills

The repository's [`skills/`](../skills) folder has skills that teach Claude producer workflows on top of these tools —
beat making (genre recipes), arranging, mixing by the numbers, spatial mixing and writing plugins. Run
`npm run skills:pack` and upload the zips in Claude Desktop / claude.ai (Customize → Skills), or copy the folders to
`~/.claude/skills/` for Claude Code. See [skills/README.md](../skills/README.md).

## How Claude "hears": render_mix

`render_mix` renders the song (or a pattern) **in your open browser tab** and returns a report like:

```
MIX ANALYSIS — "Welcome Trap Beat" (song, 28.9s, 16 bars)
Loudness: -13.8 LUFS integrated, short-term max -12.3 LUFS, loudness range 6.1 LU, peak -1.4 dBFS, true peak -0.9 dBTP, crest 9.6 dB
Master limiter: gain reduction avg -1.2 dB, max -3.9 dB, working 41% of the time (input gain 0 dB, ceiling -1 dB); master fader after it 0 dB
Target streaming (Spotify/YouTube/Apple normalise to about -14 LUFS): -14 LUFS, true peak ≤ -1 dBTP → -0.2 dB: on target
Spectrum: sub 44.3% · low 49.2% · … (centroid 280 Hz, dark; strongest low frequency 65 Hz ≈ C2 +6c)
Stereo: correlation 0.99, width 0.08 (side/mid), low end (<150 Hz) width 0.02, L/R balance 0 dB
Loudness per 4 bars: 1:-20.9  2:-12.8  3:-12.8  4:-12.9  5:-34.8
Stems (loudest first; measured after each channel's own mixer insert …):
  808             -11.1 LUFS  peak   -4.8 dBFS  centroid    71 Hz  mostly low (61.2%)  low peak 65 Hz (C2 +6c)  width 0
  Kick            -15.2 LUFS  peak   -3.7 dBFS  centroid    61 Hz  mostly sub (65%)  low peak 52 Hz (G#1 +20c)  width 0
  …
Hints:
- True peak -0.9 dBTP is above -1 dBTP: lossy encoding (MP3/AAC/Opus) will clip — lower the master limiter ceiling by 0.3 dB (to -1.3 dB).
```

`target` picks the delivery standard (`streaming`, `apple-music`, `club`, `hip-hop`, `edm`, `lo-fi`, `broadcast`,
`podcast`) or `targetLufs` a number; the report then says exactly how far to move the master limiter's input gain.
Hints also flag a limiter that's squashing, a wide low end, missing dynamics between sections and stems whose low
peaks collide (kick vs 808 masking).

| Metric | Meaning | Typical targets |
|--------|---------|-----------------|
| Integrated LUFS (BS.1770, gated) | perceived loudness of the whole render | streaming ≈ −14, club/EDM ≈ −9…−6 |
| Loudness range (LU, EBU R128) | dynamics between sections | pop/hip-hop 4–8, film/classical 10+ |
| Peak dBFS / true peak dBTP | highest sample / highest inter-sample level (4× oversampled) | true peak ≤ −1 for streaming |
| Limiter gain reduction | how hard the master limiter works | more than ~6 dB = squashed |
| Crest dB | peak-to-RMS: punch vs. squash | < 6 dB sounds over-compressed |
| Spectral balance | share of energy in sub/low/low-mid/mid/high-mid/high | muddy if low-mid > 25 %, dull if high-mid+high < 6 % |
| Stereo correlation / width | mono compatibility / side energy | correlation < 0.2 = phase risk |
| Low-end width | side/mid below 150 Hz | ≈ 0 (bass in mono) |
| Low peak (Hz + note) | the strongest 25–300 Hz frequency of the mix / each bass stem | kick and 808 ≥ 2 semitones apart |
| Loudness per section | energy curve of the arrangement | drops & builds should be visible |
| Stems | each channel's loudness and spectrum, in one pass | kick vs 808 balance, masking |

The render happens in your browser (one pass; stems are metered from taps in the same render), and over HTTP long
renders stream progress notifications to the MCP client. `save=true` also stores a 24-bit WAV (or `bitDepth: 16`,
dithered) under *Projects → Exports* and returns a download link.

### Measuring one sound: analyze_sound

`analyze_sound` renders a single note of a channel (dry, or `through: "insert"` with its effects) and reports level,
true peak, pitch with cents, the strongest low frequency as a note, spectrum, and the envelope (attack, time to −20/−40/
−60 dB). Claude uses it to tune 808s and kicks to the key, keep their fundamentals apart, and make sure an 808 tail
doesn't run into the next hit.

### Stems: export_stems

`export_stems` renders every channel that plays (and the audio clips) on its own into *Projects → Exports* — 24-bit by
default, each with its insert effects and sends, without the master bus (`masterFx: true` to include it). The same is
in the studio's File menu → *Export stems*.

### Any format: list_export_formats + export_audio

`list_export_formats` tells Claude what this server can export right now: WAV always, and MP3, AAC (.m4a), Ogg Vorbis,
Opus, FLAC, Apple Lossless and AIFF when ffmpeg is installed — with the ffmpeg version, each format's bitrates and why
a format is unavailable. `export_audio` renders the song (or a pattern) in your browser and has the server convert it:

> *"Export the song as a 320 kbps MP3 titled 'Night Drive' and a 24-bit FLAC for the master."*

The file is tagged (title = project name unless given, artist = your display name), saved in *Projects → Exports*, and
Claude gets its download link. Lossy formats are encoded from a 24-bit render; the intermediate WAV is removed unless
`keepWav: true`.

## Spatial (Atmos-style) mixing

- `set_spatial` turns the 3D mix on/off and sets what the studio monitors (`stereo` or `binaural` for headphones).
- `place_object` makes a mixer insert — or a channel's insert, by name — a 3D object: a named spot (`front-left`,
  `overhead`, `rear-right`…), `x`/`y`/`z` (x −1 left…1 right, y −1 back…1 front, z 0 ear…1 ceiling) or
  `azimuth`/`elevation`/`distance`, plus an `lfe` send. `enabled: false` returns it to the stereo bed.
- `move_object` animates it with position automation: `circle` (turns, radius, clockwise), `left-right`,
  `front-back`, `rise`, `fall`, `fly-over` or your own `points`.
- `export_spatial` renders `binaural`, `5.1`, `7.1`, `7.1.4`, `objects` (bed + mono object stems + positions JSON) or
  `adm` (experimental ADM BWF) and reports channel peaks (objects skip the master limiter).

Details: [Spatial mixing](spatial.md).

## Your plugins

Claude can use the plugins you installed (Settings → Plugins), but never install one — that always needs you, in the
studio, confirming you trust the author.

- `list_plugins` — your instrument, effect and generator plugins with their parameters (ranges, defaults), presets,
  permissions and how to use each.
- `add_channel instrument="plugin" plugin="<id>" preset=… params={…}` and `add_effect type="plugin" plugin="<id>"`;
  `update_channel` / `update_effect` change their parameters (validated against the plugin's manifest).
- `run_generator plugin="<id>" pattern=… channel=… params={…} bars=… seed=…` — the generator runs in your open
  studio's sandbox (no network, 2 s limit); Claude gets back how many notes were written and how many invalid ones were
  dropped. The same seed and params give the same notes.

`render_mix`, `export_stems`, `export_audio` and `export_spatial` include plugin instruments and effects (they render
in your browser like everything else).

## Feel, fills and transitions

- `apply_groove` presets: `boom-bap`, `dilla`, `lo-fi`, `trap`, `drill`, `house`, `afrobeats`, `straight`. Each sets
  the swing, per-role nudges (e.g. lazy snares), swing shares, hi-hat accents and light humanizing; `amount` scales it,
  `ghostNotes` adds quiet snare ghosts. Re-running it doesn't stack.
- `add_fill` makes a fill copy of a drum pattern: `snare_roll`, `tom_run`, `hat_roll`, `stutter`, `dropout`,
  `kick_build`.
- `add_transition` lands exactly on a section start: `riser` (noise with filter + volume automation), `downlifter`,
  `reverse_swell`, `snare_build`, `crash`, `sub_drop`, `impact`.

All three only create ordinary channels, patterns, clips and automation, so you can edit everything afterwards.

## Your samples, through Claude's eyes

`list_samples` and `get_sample_info` return the technical metadata (format, codec, lossless, sample rate, bit depth,
channels, bitrate, duration, size, tags) and the analysis (LUFS, peak, crest, clipping, silence, stereo, spectrum,
onsets, tempo + confidence, key, pitch, one-shot vs loop, character). WAVs are analysed on upload by the server; other
formats are decoded by your browser (`analyze_sample` re-runs it). Claude uses this to load one-shots at the right root
key, match loops to the project tempo/key, and balance levels.

Claude sees your folders too, can search them (*"find my dark kicks"*), file samples (`move_samples` — a new folder
name creates the folder) and clean up takes you recorded: *"trim the silence off Take 3, tune it to A minor and put it
at bar 9"* becomes `edit_sample` (`trim_silence`, `pitch_correct` key A scale minor, `normalize`) and `add_audio_clip`.
Edits run in your browser and are saved as a **new** sample unless you ask Claude to replace the original — then the
reply lists every project that changed.

## Tips for good results

- Keep the studio open (and click once to enable audio) so Claude can render, analyse and play.
- Ask for a genre, tempo, key and mood, and a reference feel ("like late-90s boom bap") — Claude won't copy melodies.
- Ask Claude to **save a version** before big changes, and to run `render_mix` with a target and fix what it finds.
- Name the feel and the delivery: *"dilla-style swing, mix for Spotify"* maps straight onto `apply_groove` and
  `render_mix target=streaming`.
- Your edits and Claude's interleave safely; Ctrl+Z in the studio undoes Claude's changes too, and Claude's `undo`
  tool reverts its own last changes.
- Watch the *Claude* tab in the browser for a log of every change.

## Troubleshooting

| Problem | Cause / fix |
|---------|-------------|
| 401 "This server requires an API token" | Create a token (Settings → API & MCP) and pass it; token-less access is local-only and may be disabled. |
| 401 "Invalid API token" | The token was regenerated or deleted — update your client config. |
| "No studio is open in a browser" | Open the studio signed in as the same account as the token. |
| Render times out | Very long songs on slow machines: render a pattern, or keep the tab in the foreground. |
| Edits don't appear live with stdio | Set `GREANTEADAWY_URL` to the running server and `GREANTEADAWY_TOKEN` to your token. |
