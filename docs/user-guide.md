# User guide

GreanTeaDawy uses a pattern-and-playlist workflow: you build **patterns** (drum grooves, chord parts,
melodies) in the **channel rack** and **piano roll**, arrange them in the **playlist**, and balance everything in the
**mixer**. Everything saves automatically and syncs live between your browser tabs and Claude.

![The studio](screenshots/studio.png)

## Layout

- **Toolbar** — menu (◆), undo/redo, PAT/SONG mode, play/stop/record, 🎙 (the audio recorder), tempo (drag or double-click; TAP for tap tempo),
  metronome, song position, current pattern (‹ › and + for pattern options), master volume and output meter
  (click it for scope/spectrum), window buttons, Settings, MIDI, Claude activity light, connection light, **About**
  (ⓘ, top right: a dialog with the app name and version, the server's version and what's built in; also ◆ → About)
  and your account menu. If the About dialog says the server runs another version, reload the page.
- **Browser** (left, Alt+F8) — *Sounds* (all instruments and presets: click to add, drag onto the rack),
  *Samples* (your sample library in folders: upload, record, search, edit), *Projects* (templates,
  open/duplicate/delete, exports),
  *Claude* (MCP setup and a live activity log of what Claude did).
- **Windows** — Playlist (F5), Channel rack (F6), Piano roll (F7), Channel settings (F8), Mixer (F9), plus Automation,
  Versions, Settings, Help, the **wave editor** and the **recorder**. Drag a title bar anywhere outside its buttons and fields to move the window, the corner
  to resize, double-click the bar to maximize. The layout is
  remembered per browser.
- On narrow screens the windows become full-screen tabs (bottom bar). One finger drags/pans the piano roll and
  playlist, a tap draws.

## Channel rack & step sequencer

![Channel rack and piano roll](screenshots/piano-roll.png)

- Each row is a **channel** (an instrument) with mute/solo LED, volume and pan knobs, mixer insert number, name and
  16+ steps. Click steps to toggle them, drag to paint, right-click to erase, mouse-wheel on a step for velocity.
- **Swing** and **Steps** (pattern length) are in the rack header.
- Right-click a channel name: piano roll, settings, rename, colour, clone, fill every 2/4/8 steps, shift, randomize,
  clear, move, delete.
- Channels whose notes don't fit the step grid (melodies, chords, off-grid timing) show a mini piano roll instead of
  steps — click it to open the piano roll.
- **+ Channel** adds instruments: synthesized drums (kick, snare, clap, hat, tom, rim, cowbell, cymbal, shaker, perc),
  808 bass, a three-oscillator subtractive synth, FM synth, the **sampler** (your uploaded audio) and the band instruments (Browser
  categories *Keys*, *Guitar*, *Bass*, *Strings*):
  - **Grand Piano** — a modelled piano (inharmonic strings, hammer hardness follows velocity, beating unisons). A note
    rings until it ends, so long notes work like the sustain pedal; *Damper* sets how fast a released note stops.
  - **Electric Piano** — tine (Rhodes-style) or reed (Wurlitzer-style), *Bark* for the growl of hard notes, *Bell* for
    the attack ding, stereo or amplitude tremolo.
  - **Drawbar Organ** — nine drawbars (16′ … 1′), percussion (2nd/3rd harmonic), key click, drive and a slow/fast
    rotary speaker. Barely velocity-sensitive, like the real thing.
  - **Guitar** — a plucked-string model with an acoustic, nylon or electric body, pluck point, palm mute and drive.
  - **Bass Guitar** — finger, pick, slap or upright; mono with glide by default (overlapping notes slide).
  - **String Ensemble** — 1–8 players per note (1 = solo cello/violin), delayed vibrato, legato, staccato or
    pizzicato articulations.

  Piano, guitar, bass and pizzicato notes are rendered once per pitch and velocity layer in the background (a few
  hundred milliseconds after you add them) and then cost almost nothing to play.
- **World collections** (Browser sections *Flutes*, *Beatbox*, *Indian*, *East Asian*; in **+ Channel** each section
  is a submenu → instrument → preset):
  - **Flutes** — Flute (Concert, Breathy, Lo-fi, Trap, Alto, Piccolo), Pan Flute, Recorder, Tin Whistle and Ocarina
    share one breath engine: *Tone* (blowing harder overblows brighter, as does velocity), *Breath* (air noise),
    *Chiff* (the tongued attack), delayed *Vibrato*. Turn on *Mono* to slur overlapping notes.
  - **Beatbox** — mouth sounds: *Kick* ("B" lip burst), *Snare* (Pf, Psh spit, inward K, Kch), *Hat* (t, ts, inward,
    tch), *Bass* (a lip/throat buzz through an "oo/oh/ah/mm" vowel, growl and "wub" wobble) and *FX* (click roll,
    vocal scratch, laser zap, siren). Put the closed and open hats in one choke group.
  - **Indian** — **Sitar** (a modelled string on a buzzing *jawari* bridge, sympathetic strings tuned to the major
    scale of *Sa*; mono by default so overlapping notes slide — *meend*), **Tanpura** (the buzzing drone: play Sa and
    Pa as long, repeated notes), **Tabla** (one channel per bol: na, tin, tun, te, ge, ke, dha, dhin; *Bend* is the
    palm glide on ge; the treble drum sits on C at C4 — play the note of your Sa to tune it), **Bansuri** (breathy
    bamboo flute with meend), **Shehnai** (nasal double reed), **Santoor** (hammered strings that ring on) and
    **Harmonium** (bass/male/female reed banks and a bellows pulse shared by all notes).
  - **East Asian** — **Koto** and **Guzheng** (plucked zithers; *Mono* for pressed-string bends), **Pipa** (bright
    nail-plucked lute; fast repeated notes give its tremolo), **Shamisen** (bachi "thwack" and buzzing sawari;
    Tsugaru preset), **Erhu** (singing two-string fiddle with deep vibrato and slides), **Shakuhachi** (breathy,
    swelling attacks), **Dizi** (bright flute with a buzzing membrane), **Suona** (loud festive double reed),
    **Taiko** (odaiko, chudaiko, shime, kara rim) and **Gong** (tam-tam bloom, opera gongs that bend down or up,
    temple bell).
  - Sitar, tanpura, santoor, koto, guzheng, pipa and shamisen are physical models rendered in the background like the
    guitar. Their scales are in the piano roll's scale list: *hirajoshi*, *inSen*, *iwato*, *yo* (Japanese) and the
    thaats *bhairav*, *todi*, *purvi*, *marwa* (Bilawal, Kalyan, Khamaj, Kafi, Asavari and Bhairavi are major, lydian,
    mixolydian, dorian, minor and phrygian).
- **Velocity** follows a squared curve like hardware instruments (1.0 = 0 dB, 0.8 = −4 dB, a ghost note at 0.45 =
  −14 dB), and softer notes are darker too: snares, hats, claps, synth filters, FM brightness, sampler cutoff and the
  piano/e-piano/guitar/bass tone all respond. Programming accents and quiet off-beats is what makes a groove breathe.

## Channel settings (F8)

Instrument type and preset, every instrument parameter (oscillators, envelopes, filter, glide/mono, FM ratios, 808
distortion…), channel volume/pan/pitch, channel filter (cutoff/resonance), **choke group** (e.g. open/closed hats
cut each other off), step note (root key) and mixer routing. Drop a sample on the rack to create a sampler channel.

- **Groove**: *Nudge* plays the channel up to 50 ms early (−) or late (+) — a lazy snare at +10…+20 ms, pushed hats
  at −3 ms — and *Swing* sets how much of the project swing this channel gets (swung hats over a straight kick).
  Swing also applies to notes that sit slightly off the grid, so humanized parts keep their feel.
- **Sampler**: start/end trim, a sustain **loop** (loop start/end, plays while the note is held when *One shot* is
  off), reverse, a velocity-sensitive low-pass **cutoff**, gain and an amp envelope.
- Presets worth knowing: *Lo-fi Keys*, *Strings*, *Riser Noise*, *Reverse Swell* (subtractive synth), *Felt Piano* (FM),
  *Sub Drop* (808).

## Piano roll (F7)

- Tools: **Draw** (click to add, drag to move, drag the right edge to resize), **Select** (box; Ctrl+drag also
  selects), **Erase** (or right-click), **Chord stamp** (choose major, minor, 7ths, 9ths… and click to place a chord).
- Snap grid, quantize (Ctrl+Q), legato, humanize, octave up/down, scale highlighting (key + scale), ghost notes of other
  channels, zoom and key height.
- Keys: Ctrl+A/C/V/D, Delete, ↑/↓ transpose (Shift = octave), ←/→ nudge. Velocity lane at the bottom.
- Click the keyboard on the left to audition notes.

## Playlist (F5) & song mode

- Pick a pattern (toolbar or playlist toolbar) and click to paint it; clips loop their pattern when longer.
  Drag to move, right edge to resize, left edge to trim (the clip starts later in its pattern/audio).
  Shift+drag duplicates; right-click for mute/duplicate/delete.
- Drag a sample from the browser onto a track to create an **audio clip**. Right-click it for **clip gain**, **fades**
  (drawn on the clip) and **Fit to project tempo** — it changes the playback speed (and pitch, like a turntable) so a
  loop of another tempo locks to the grid; *Original speed* undoes it.
- **Markers** name song sections above the ruler: right-click the ruler → *Add marker* (or **+ Marker** in the playlist
  toolbar, at the song start position); click a marker to move the song start there, right-click it to rename or
  delete. Claude's `arrange_song` creates them for each named section.
- **Auto +** creates an automation clip for a channel, mixer, effect or master parameter; edit its curve in the
  Automation window.
- Click the ruler to set the song start, drag on it to set a loop region (right-click → clear loop). Switch to **SONG**
  to play the arrangement (Shift+L toggles PAT/SONG).

## Mixer (F9)

![Mixer](screenshots/mixer.png)

- Insert 0 is the **Master** (with a limiter by default); every channel routes to an insert (the number on its rack row).
- Faders (double-click resets), pan, mute/solo, routing (→) to another insert, and **sends** (e.g. several inserts to a
  shared reverb bus). Routing cycles are prevented automatically.
- The selected insert shows its effect chain. Add, bypass, reorder, remove. Most continuous parameters can be
  automated: create an automation clip with **Auto +** in the playlist.

| Effect | Highlights |
|--------|-----------|
| EQ | low shelf, mid peak, high shelf, plus **high-pass** and **low-pass** (12 dB/oct; 20 Hz / 20 kHz = off) |
| Filter | low/high/band-pass and notch with resonance and mix — automate the cutoff for sweeps |
| Compressor | threshold, ratio, attack, release, knee, makeup and **mix** (below 1 = parallel compression; the dry path is delay-aligned). The browser's automatic makeup is removed, so *Makeup* is the only gain you add |
| Delay | tempo-synced, ping-pong, tone; the repeats are high-passed so echoes stay out of the low end |
| Reverb | decay, **size** (early reflections), pre-delay, damping; a generated room whose highs die faster than its lows |
| Distortion, Chorus, Phaser, Lo-fi Crusher | saturation (4× oversampled), modulation, bit reduction |
| Stereo Shaper | width plus **mono below** (keeps the low end mono, e.g. 120 Hz on bass and pads) |
| Sidechain Pump | **trigger channel**: ducks on every note of that channel (usually the kick — even a muted "ghost" kick); without one it pumps on a tempo grid |
| Limiter | input gain, ceiling (default −1 dB) and release; driven hard, peaks land just under the ceiling (an oversampled soft clip rounds off the last bit — check the true peak with `render_mix`). The master fader comes after it — keep it at 0 dB |

- Good habits the templates follow: one **shared reverb/delay** insert fed by sends instead of a reverb on every
  channel, high-passes on everything but kick and bass, and the bass ducking under the kick.
- Knobs and faders work with the keyboard too: focus them with Tab, then arrow keys (Shift = fine), Page Up/Down,
  Home/End, Delete to reset.

## Spatial mixer (3D)

Place inserts as **3D objects** around and above the listener, monitor them binaurally on headphones and export
binaural, 5.1, 7.1, 7.1.4, object stems with positions or an (experimental) ADM BWF. Everything about it:
[Spatial mixing](spatial.md).

## Plugins

Add your own instruments, effects and note generators (or ones someone you trust made) as `.zip` packages:
**Settings → Plugins → Install plugin…**. Before anything is installed the studio shows who made it, what it asks
for (permissions), its files and fingerprint, with a warning to install only plugins from people you trust — tick
*I trust …* and **Install plugin**. Plugins are yours only; you can switch them off or remove them there.

- **Instrument plugins** appear under *Plugins* at the top of the Browser's Sounds tab; their knobs and presets are in
  Channel settings like any instrument.
- **Effect plugins** are in every insert's *+ Add effect…* list (*Plugin: …*), with a preset picker in the slot;
  automatable knobs can be automated.
- **Generators** fill the open pattern/channel with notes: piano roll → **Gen** → pick a generator, preset and length →
  *Generate* (replaces the notes in that range; undo works).
- A project that uses a plugin you don't have (or switched off) still opens: those channels are silent and those
  effects pass audio through until the plugin is back.
- Example plugins: `npm run plugin:pack -- --examples` writes them to `plugins/dist/`. To make your own:
  [Plugins](plugins.md).

## Recording & MIDI

- Play the selected channel from your **computer keyboard** (Z-row and Q-row = two octaves, `-` / `Shift+=` change
  octave) or a **MIDI keyboard** (MIDI button in the toolbar, Web MIDI capable browsers).
- Press **Record** (●) and play while the transport runs: notes are written into the current pattern (optionally
  quantized — Settings → Studio).

### Recording audio (vocals, guitar, anything with a microphone)

![The recorder](screenshots/recorder.png)

Click 🎙 in the toolbar (or *Record* in the Samples tab) and **Enable microphone** (the browser asks once). Pick the
input and mono/stereo; the meter shows the level (keep the peaks out of the red).

- **Play along**: *over the song* (from the song start marker), *over the current pattern* (looping), or *microphone
  only*. With the song or pattern there is a **count-in** (off / 1 / 2 bars) and an optional **metronome**.
- Press **Record**, perform, press **Stop**. Every take is saved straight away as a **WAV sample in the
  "Recordings" folder** ("Take 3 (bar 9) — My Song"). Over the song it is also **placed on the playlist** at the bar
  where you started, on a free track (turn off *Place on playlist* to only keep the sample).
- **Latency** is compensated automatically (the browser's output and input latency). If takes still land a little late
  or early, set *Offset (ms)* under *Input processing & latency*. Echo cancellation, noise suppression and auto gain
  are off by default (they change the sound); turn them on for a laptop mic without headphones.
- **Monitor** lets you hear yourself — use headphones, or it feeds back.
- From the take list: ▶ plays a take, **Edit** opens it in the wave editor, **Tune** opens it straight in the pitch
  correction view, 🗑 deletes it. A take that couldn't be saved (no connection, over the upload limit) stays in the list
  with **Retry** and **Download** (a WAV file on your computer), so it is never lost. Stopping the studio's transport
  (Space) also ends a take that plays along. Signing out or leaving the page while a take is being recorded or saved
  (or one is still unsaved) asks first.
- Recording needs a secure page: **https://** or **http://localhost**. A take can be up to 10 minutes (less if the
  server's upload limit, `MAX_UPLOAD_MB`, is small: the recorder shows the maximum).

## Samples

![The sample library](screenshots/samples.png)

Upload WAV, MP3, OGG/Opus, FLAC, AIFF, AAC/M4A or WebM (Samples tab → **Upload**, or drag files in), or **record**
them. For each sample the studio stores technical metadata — container/codec, lossless, **sample rate, bit depth,
channels, bitrate**, duration, size and embedded tags (title, artist, BPM, key) — and an **analysis**: loudness (LUFS),
peak, RMS/crest, spectral balance, onsets, **tempo, key, pitch** and a guess of what it is (kick, hat, bass loop,
melodic loop, full mix…). Click ⓘ to see them. Claude sees the same data, so it can pick sounds and set root keys and
tempos correctly.

- **Folders**: every sample is in one folder, or *Unfiled*. Make one with the folder button, then **drag samples onto a
  folder** (or ⋯ → *Move to folder*). Drop audio files on a folder to upload them into it. Folder ⋯: upload into it,
  rename, delete (its samples are kept and become unfiled). Click a folder to fold it away.
- **Search** matches the name, folder, tags and the analysis: `kick`, `vocal 140 bpm`, `pad A minor`.
- **⋯ on a sample**: add as a sampler channel, **edit in the wave editor**, move to a folder, rename, details, analyse
  again, **delete**. Deleting a sample that a project still uses tells you which projects, channels and clips will go
  silent first. If it is open in the wave editor with edits, the editor keeps them (marked deleted) to save as a new
  sample.
- **Select several** (✓ button): tick samples, then *Move to…* or *Delete* them together.

Use samples as **sampler channels** (+ button or drag onto the rack; the root key is set from the detected pitch) or
as **audio clips** in the playlist (no time-stretching: match the project tempo, or use *Fit to project tempo*). The
sampler's sample picker lists them by folder, with a ✎ button that opens the chosen sample in the wave editor.

### Wave editor

![The wave editor](screenshots/wave-editor.png)

⋯ → *Edit in wave editor* on a sample (or ✎ next to a sampler's sample, or *Edit* on a take). Nothing changes the
sample until you save, and every step can be undone.

- **Select** by dragging over the waveform (Shift+click extends, double-click selects everything). With *Zero-cross* on,
  selections snap to where the waveform crosses zero, so cuts don't click. **Space** plays the selection (or from the
  cursor); the loop button repeats it.
- **Edit**: cut, copy, paste (at the cursor or over the selection — also between samples), delete, **Trim** (keep only
  the selection), fade in / out, **Normalise** (peak to −1 dBFS), **Reverse**, and under *More*: gain, silence, invert
  polarity, remove DC / rumble, change speed (pitch follows, like a turntable), **time stretch** (keeps the pitch),
  **pitch shift** (keeps the length; voices keep their character), trim silence at both ends, make mono / stereo.
  Without a selection the processing applies to the whole sample.
- **Zoom** with + / −, Ctrl+wheel or *Fit* / *Sel*; scroll with the wheel or by dragging the overview strip.
- Shortcuts while the editor has focus: Ctrl+Z / Ctrl+Shift+Z undo/redo (the editor's own history, not the project's),
  Ctrl+X/C/V/A, Delete, Home/End, Escape. Clicking another window gives the keys to the studio again; clicking the
  editor (or its title bar) gives them back.
- **Save as new…** keeps the original and adds the edited audio as a new sample in the same folder. **Replace
  original…** overwrites the sample everywhere: the warning lists every project (and its channels and clips) that uses
  it, and the original audio can't be brought back.
- If the sample is replaced elsewhere while it is open (by Claude or in another tab), the editor reloads it — or, with
  unsaved edits, says so and offers to reload. A sample deleted while open can still be saved as a new one. Closing
  the window (or the browser tab), or signing out, with unsaved edits or while a save is running asks first.

### Pitch correction (auto-tune)

![Pitch correction](screenshots/pitch-correction.png)

The **Pitch** tab of the wave editor finds the melody of a solo voice or instrument (one note at a time): the grey line
is the pitch as sung, the blue blocks are the notes it found, the orange line is the corrected pitch. A vibrato, a
scoop into a note or a fall off it stays part of its note; a run faster than about 100 ms a note, a semitone trill
sung with slides, or a short passing note right after a note with a wide vibrato may need a split or a join by hand.

- **Key** and **Scale** (from the project, or *chromatic* = every semitone): each note moves to the nearest note of the
  scale.
- **Amount** — how far notes move (100% = exactly in tune). **Speed** — how long a note takes to get there: 0 ms is the
  hard, robotic effect; 50–100 ms keeps scoops and slides natural. **Flatten** — how much vibrato and drift inside a
  note is ironed out. Presets: *Natural*, *Tight*, *Robotic*.
- **Move notes by hand**: drag a note up or down (it snaps to semitones; hold Alt or Shift for fine moves), or select it
  and use ↑/↓. Double-click (or 0) gives it back to the scale; right-click for *Keep as sung*, *bypass*, octave and
  semitone moves, and to **split** a note where two were sung or **join** it with the next one (when the detection got
  it wrong); B toggles bypass, [ and ] select the previous / next note, Esc deselects. *Snap all* re-snaps the notes you haven't moved, *Reset* all of them.
- **Preview** plays the corrected audio (the selection, or from the cursor); **Apply** writes it into the sample (one
  undo step), then save it as a new sample or over the original. Formants stay put, so a corrected voice still sounds
  like the singer.

## Projects, versions, import & export

- **Projects** tab: new project from a template (Default, Empty, Trap, Deep House, Boom Bap, Lo-fi, Acid Techno, Pop Band,
  Indian Fusion, East Asian Lo-fi, UK Drill, Afrobeats, Reggaeton, Liquid Drum & Bass, Synthwave, Disco Funk, Neo-Soul,
  Bossa Nova, Cinematic, Beatbox Jam), open, duplicate, delete.
- **Versions** (menu → Versions…): named snapshots of the current project. Restore any version (undoable); Claude can
  also save versions before risky changes.
- **Export** (menu): the song as a **16-bit** (dithered, for sharing) or **24-bit** (for mastering) WAV, the pattern loop
  as WAV, **stems** (one 24-bit WAV per channel with its insert effects and sends but no master processing — they sum
  back to the pre-master mix; saved under *Projects → Exports*), **MIDI**, or the project file (.json). Renders and
  stems made by Claude appear under *Projects → Exports* too.
- **Export song as…** (menu) — MP3, AAC (.m4a), Ogg Vorbis, Opus, FLAC, Apple Lossless (.m4a) or AIFF, with a choice of
  bitrates for the lossy formats. The song is rendered as a 24-bit WAV in your browser and converted by **ffmpeg on
  the server** (title and artist tags included); the result downloads and stays in *Projects → Exports*. Lossless
  formats keep 24-bit. Formats show *needs ffmpeg* when the server has no ffmpeg — see *Settings → Audio export*.
- **Import**: MIDI into the current pattern, or a project file.
- **Undo/redo** (Ctrl+Z / Ctrl+Y) covers your edits and the edits Claude makes while you watch.

## Settings

![Settings — API & MCP](screenshots/settings-api.png)

- **Account** — display name, password, sign out.
- **API & MCP** — create, regenerate or delete your personal API token, and copy-paste setup for Claude Code, Claude
  Desktop and URL-only clients. See [Making music with Claude](claude-mcp.md).
- **Studio** — follow Claude (auto-open the projects Claude opens), quantize recordings, metronome, computer-keyboard
  octave, default snap, reset window layout.
- **Audio export** ([screenshot](screenshots/settings-export.png)) — whether the server has **ffmpeg** (and which version), and every export format with its bitrates
  and encoder or the reason it's unavailable. Admins can *Check again* after installing ffmpeg (`apt install ffmpeg`,
  `brew install ffmpeg`, `winget install ffmpeg`, or `FFMPEG_PATH`); the Docker image ships with it.
- **Plugins** — install (with the trust confirmation), enable/disable and remove your plugins; errors a plugin reported.
- **Users** (admins) — create users, change roles, disable, reset passwords, delete users with their data.
- **Server** (admins) — open registration, allow plugins, allow MCP without a token from this computer, and which
  account token-less MCP acts as.

## Keyboard shortcuts

The same list is in the studio under ◆ → Help.

| Keys | Action |
|------|--------|
| Space | Play / stop |
| Shift+L | Toggle pattern / song mode |
| F4 | New pattern |
| F5 / F6 / F7 / F8 / F9 | Playlist / Channel rack / Piano roll / Channel settings / Mixer |
| Alt+F8 | Toggle browser |
| Ctrl+Z / Ctrl+Y | Undo / redo (also Claude's edits) |
| Z S X D C V … / Q 2 W 3 E … | Play the selected channel (two octaves) |
| - / Shift+= | Keyboard octave down / up |
| Numpad + / - | Next / previous pattern |
| Channel rack: Ctrl+click a channel light | Solo the channel |
| Piano roll: Shift+click / Ctrl+drag | Add to selection / box select |
| Piano roll: Alt+drag | Duplicate the dragged notes |
| Piano roll: Ctrl+A, Ctrl+C, Ctrl+X, Ctrl+V, Ctrl+D, Del | Select all, copy, cut, paste, duplicate, delete |
| Piano roll: Ctrl+Q | Quantize (selection or all) |
| Piano roll: ↑ ↓ (Shift = octave), ← → | Transpose / nudge selected notes |
| Playlist: Shift+drag, Ctrl+A, Ctrl+D, Del | Duplicate clips, select all, duplicate selection, delete |
| Wave editor: Space, Ctrl+Z / Ctrl+Shift+Z | Play the selection / undo, redo (the editor's own history) |
| Wave editor: Ctrl+X, Ctrl+C, Ctrl+V, Ctrl+A, Del, + / − | Cut, copy, paste, select all, delete, zoom |
| Pitch correction: drag a note (Alt/Shift = fine), ↑ ↓, 0, B, [ ], Esc | Move it, nudge it, back to the scale, bypass, previous / next note, deselect |
| Knobs & faders | Drag up/down (Shift = fine), wheel, double-click to reset; Tab to focus, then arrow keys, Home/End, Delete |
| Menus | Arrow keys to move, → to open a submenu, ← to close it, Enter to choose, Esc to close |
