---
name: greanteadawy-beatmaking
description: Produce a beat or song from an idea in GreanTeaDawy through its MCP tools — pick sounds, program drums, write chords, bass and melody, add groove, arrange, mix by the numbers and play it. Use when the user asks Claude to make, start or finish a track, beat, loop or instrumental in GreanTeaDawy.
---

# Making a beat in GreanTeaDawy

GreanTeaDawy is a pattern-based browser DAW that you drive with its MCP tools; every change appears live in the
user's open studio. This skill is the producer's workflow on top of the tools. The server's own guide
(`greanteadawy://guide` resource) has the notation details — read it once per session if you haven't.

## Before you start

1. `get_studio_status` — is a studio tab open? Without one you can still write the song, but `render_mix`,
   `analyze_sound`, exports and `play` need the browser. Tell the user to open the studio if it's closed.
2. Settle the brief in one line: genre, mood, tempo, key, length, any reference ("dark trap at 140 in F minor, 2 min,
   like a Metro Boomin intro"). If the user gave nothing, pick from [genres.md](genres.md) and say what you chose.
3. Existing project? `get_project` first and build on it; otherwise `create_project` (a genre `template` gives a
   pre-mixed starting kit: trap, drill, house, boombap, lofi, neosoul, techno, dnb, synthwave, disco, afrobeats,
   reggaeton, bossanova, band, cinematic, beatbox, indian, eastasian) and `save_version` before big
   rewrites.

## The build (in this order)

1. **Tempo, key, scale** — `create_project bpm key scale` or `update_project`. Use `music_theory` for the
   diatonic chords and roman-numeral progressions in that key.
2. **Sounds** — `add_channel` per part with a preset (table in [genres.md](genres.md#sound-palette)); open + closed
   hats in the same `chokeGroup`. Beyond drums, synths and the band there are flute, beatbox, Indian and East Asian
   collections (`list_instruments category=…`; recipes in [genres.md](genres.md#world-and-beatbox-grooves)).
   The user's own samples: `list_samples` (by folder; `query` searches names, tags, key and tempo) →
   `add_channel instrument=sampler sampleId`. A vocal or solo take they recorded can be cleaned up first with
   `edit_sample` (`trim_silence`, `pitch_correct` in the song's key, `normalize`) — as a new sample, never replacing
   the original unless they ask — then placed with `add_audio_clip`.
   Their plugins: `list_plugins` → `instrument="plugin" plugin=<id>`. Don't invent plugins they don't have.
3. **Patterns per part** — `create_pattern` "Drums", "808", "Chords", "Melody" (1–4 bars). Separate patterns make the
   arrangement flexible.
4. **Drums** — `write_drums` with step strings (x hit, X accent, o ghost, 1–9 velocity, - rest), one call for all
   drum channels of a pattern. Velocity carries the groove: accents on downbeats, off-beat hats ~0.6–0.7.
   `add_roll` for trap hat/snare rolls.
5. **Harmony** — `add_chords` with a voicing that fits the genre (drop2/rootless for neo-soul and lo-fi keys,
   spread for cinematic pads, shell for sparse comping) and a `register` ("E4" keys, "C5" pads).
6. **Bass** — `add_bassline` following the same chords: a `rhythm` for simple root parts or a degree `line`
   ("R:3 R:1 -:2 5:2 R:2~ 8:4 b7:2", "~" = slide). 808s around octave 1–2.
7. **Topline** — `write_melody` (compact "C5:2 D5:2 Eb5:4" strings) in the scale; leave space (rests) and repeat
   motifs with small changes — call and response beats constant 16ths.
8. **Feel** — `apply_groove preset=<genre>` (swing, nudges, accents, humanizing; `ghostNotes` for boom bap/R&B).
9. **Tune the low end** — `analyze_sound` on the kick and the 808/bass: fundamentals at least 2 semitones apart, 808
   in key; fix with the kick's `tune` param or `update_channel pitch`.
10. **Arrange** — see the `greanteadawy-arranging` skill: `arrange_song` sections with energy changes, `add_fill`
    at section ends, `add_transition` into hooks/drops.
11. **Mix** — see `greanteadawy-mixing`: levels by numbers, high-passes, sidechain `pump source=Kick`, shared
    reverb/delay buses, then `render_mix target=<genre target>` until the report is clean.
12. **Deliver** — `save_version`, `play` (song mode), and describe what you made: tempo/key, sections, sounds, what
    to listen for. Offer `export_audio` (check `list_export_formats`) or `export_stems`.

## Rules of thumb

- Work in steps (16ths) inside patterns, 1-based bars in the playlist; ids come back in [brackets].
- Validate with your ears' substitute: `get_pattern` to read back what you wrote, `render_mix` to hear it as numbers.
  Never claim something sounds good without a render.
- One idea per pattern; variations as copies (`duplicate_pattern`, `add_fill`), not by rewriting the original.
- Keep the user in the loop on taste decisions (sound choice, structure) but don't stall: make a solid first version,
  then offer 2–3 concrete directions.
- If a tool errors, read the message — it says how to fix the call (valid names, ranges).

See [genres.md](genres.md) for tempo/drum/harmony recipes per genre and the sound palette.
