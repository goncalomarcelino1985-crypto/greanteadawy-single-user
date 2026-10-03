---
name: greanteadawy-arranging
description: Turn loops into a full song in GreanTeaDawy — section structure, energy curve, variations, fills, transitions, automation and band-instrument parts. Use when the user asks to arrange, structure, extend, add an intro/verse/hook/drop/bridge/outro, or make a beat "go somewhere".
---

# Arranging in GreanTeaDawy

A loop becomes a song through **contrast**: what enters, what leaves and what changes between sections. In
GreanTeaDawy patterns are the building blocks and the playlist is the timeline.

## Workflow

1. `get_project` — list the patterns and what each holds. Missing variations? Make them first:
   `duplicate_pattern` ("Drums B", "Chords Sparse"), `add_fill` (a fill version for section ends), `transform_notes`
   on the copy (`transpose 12` for a lift, `stretch 2` for a half-time feel — run it for each drum channel, it works on
   one channel at a time — `velocity` for a softer verse).
2. Plan the form with bar counts (multiples of 4 or 8) and the energy of each section (1–5). Say it to the user in
   one line before building.
3. `arrange_song sections=[{name, bars, patterns}]` — one call builds the playlist, one track per pattern, and
   **markers** for the named sections.
4. Section ends: the fill pattern **replaces** the main drum pattern at the end of the section. `add_fill` rewrites the
   *last beats of a full copy* of the pattern, so the fill pattern is as long as the original (a 2-bar drum pattern →
   a 2-bar fill pattern): shorten the main drum clip by the fill pattern's length (`update_clips bars`) and
   `place_pattern` the whole fill pattern right after it on the same track. Layered on top, a `dropout` fill can't
   drop anything.
5. Into hooks and drops: `add_transition` — riser (4–8 bars) + `snare_build` (2 bars) + `impact` or `crash` on the
   downbeat, and a `dropout` fill in the bar before. Out of big sections: `downlifter`; 808 tracks: `sub_drop`.
6. Movement inside sections: `add_automation` (filter cutoff opening over an intro, reverb mix rising into a
   breakdown, volume swells).
7. `render_mix` (song mode) — check **loudness per section**: each step up in energy should measure 1–3 dB louder,
   breakdowns quieter. Flat numbers = not enough contrast.
8. `play mode=song` and walk the user through the sections by bar.

## Forms that work

| Genre | Form (bars) |
|-------|-------------|
| Trap / drill / hip-hop | Intro 8 → Hook 16 → Verse 16 → Hook 16 → Verse 16 → Hook 16 → Outro 8 |
| Pop / band | Intro 4 → Verse 8 → Pre 4 → Chorus 8 → Verse 8 → Pre 4 → Chorus 8 → Bridge 8 → Chorus 8 ×2 → Outro 4 |
| House / techno | Intro 16 (drums) → Build 16 → Drop 32 → Break 16 → Build 8 → Drop 32 → Outro 16 (DJ-friendly 16/32s) |
| Lo-fi / beat tape | Intro 4 → A 8 → B 8 → A 8 → Outro 4 (2–3 min, gentle changes) |
| EDM / future bass | Intro 8 → Verse 16 → Build 8 → Drop 16 → Break 8 → Build 8 → Drop 16 → Outro 8 |

## Energy tools (least to most)

- **Remove** something (kick out in the pre-chorus, drums out for the first half of a verse, bass out for a bar).
- **Register**: chords an octave up, melody doubled an octave higher (`copy_notes` with transpose).
- **Rhythm density**: hats 8ths → 16ths → rolls (`add_roll`); half-time drums (a copy with `stretch 2` on each drum
  channel) for a bridge.
- **New layer** on the hook only (counter-melody, strings, claps on 2 and 4 doubled).
- **Width/space** in the hook (pads wider, more reverb send), drier verses.
- Transitions as above. Use the same transition at most twice per song.

## Band arrangements (piano, guitar, bass, strings, organ)

- Give each instrument its own register: bass E1–G2, guitar strums octave 3, piano chords C3–C5 (left hand an octave
  lower in verses only), strings legato above the piano (register "G4"), organ pads low and soft.
- Let piano/guitar chord notes ring to the next chord (long notes = pedal); strings use long notes for legato and the
  Staccato/Pizzicato presets for rhythm.
- Verse: piano + bass + light drums; pre: add guitar strums; chorus: everything + strings; bridge: strip back to one
  instrument and build again.
- A real drummer plays a crash on section downbeats and a tom fill into them (`add_fill tom_run`).

## Checks

- Every section start has a marker (`set_markers` to rename/add); `get_project` shows the playlist by track.
- No accidental silence: clips shorter than their section, muted tracks (`update_track`), patterns placed past the end.
- `save_version` before rearranging; `copy_bars` repeats sections (bar ranges are inclusive: 9–16 = 8 bars).
