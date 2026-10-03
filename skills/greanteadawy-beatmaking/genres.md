# Genre recipes for GreanTeaDawy

Starting points, not rules — change one thing per genre to make it the user's own. Step strings are one bar of 16ths
(`write_drums`); "swing" is `apply_groove` (or `update_project swing`, 0–100 where MPC 54 % ≈ 16, 58 % ≈ 32,
62 % ≈ 48). Targets are `render_mix target=…`.

| Genre | BPM | Keys / scales | Groove | Target |
|-------|-----|---------------|--------|--------|
| Trap | 130–150 (half-time feel) | minor, harmonic minor, phrygian (C, F, G, A minor) | `trap` | `hip-hop` |
| UK / NY drill | 138–145 | minor, phrygian; dark | `drill` | `hip-hop` |
| Boom bap | 84–95 | minor 7ths, dorian, jazzy | `boom-bap`, ghostNotes | `hip-hop` |
| Lo-fi hip hop | 70–90 | maj7 / m9, dorian, major pentatonic | `lo-fi` | `lo-fi` |
| R&B / neo-soul | 65–95 | extended chords (9, 11, 13), ii–V movement | `dilla` (amount 0.6–1) | `streaming` |
| Deep house | 118–124 | minor 7/9 stabs, dorian | `house` | `club` |
| Techno | 126–135 | one-chord, minor, phrygian | `straight` / `house` 0.5 | `club` |
| Afrobeats | 100–115 | major, mixolydian; bright | `afrobeats` | `streaming` |
| Pop / band | 90–125 | major, I–V–vi–IV family | `straight` (light humanize) | `streaming` |
| Cinematic / ambient | 60–90 | minor, lydian, modal | `straight` | `streaming` / `apple-music` |
| Beatbox / a cappella hip hop | 85–100 | minor, dorian | `boom-bap` | `hip-hop` |
| Bollywood / Indian fusion | 90–110 (dhol/tabla grooves), 70–85 ballads | a thaat (bhairav, kafi = dorian, yaman = lydian) over a Sa–Pa drone | `straight`, light humanize | `streaming` |
| East Asian lo-fi / cinematic | 70–90 | hirajoshi, inSen, yo, major pentatonic | `lo-fi` or `straight` | `lo-fi` / `streaming` |

## Drums

**Trap** (half-time: the backbeat is on step 8)
```
Kick   x------x--x-----     (vary per bar; leave room for the 808)
Clap   --------x-------
Hat    x-x-x---x-x-x-x-     + add_roll on the last beat of every 2nd bar (rate 1/32 or 1/24)
OpenHat ------x---------    (same chokeGroup as the hat: the next closed hat cuts it, so leave its own step free)
```
**Drill** — sliding 808s, sparse kicks, snare on beat 3 and a late hit: `Snare --------x-----x-` (alternate bars
`--------x--x----`), hats in triplet-ish groups (`x--x--x-x--x--x-`), percussion rims.

**Boom bap**
```
Kick   x-------x-x-----
Snare  ----x-------x---     (ghostNotes: true adds "o" ghosts)
Hat    x-x-x-x-x-x-x-x-     (8ths; apply_groove boom-bap swings them)
```
**Lo-fi** — `Kick x-------x--x----`, `Snare ----x-------x---` (preset Rimmy or a soft clap), hats sparse 8ths at
velocity 5–7, a shaker; everything a little late (`lo-fi` groove).

**House / techno**
```
Kick    x---x---x---x---    (four on the floor)
Clap    ----x-------x---
OpenHat --x---x---x---x-    (off-beats; NOT in the closed hat's chokeGroup here, or every 16th cuts it)
Hat     74-474-474-474-4    (digits = velocity 70 % / 40 %; rests under the open hats), or a shaker
```
**Afrobeats** — a 3+3+2 (tresillo) feel: `Kick x--x--x---x-----` (or lighter, `x-----x-x-------`); rim/snare
`----x-------x---`; shaker 16ths with accents (`7373737373737373`); congas (perc Conga/Bongo) answering in the gaps
(`--x--x----x--x--`).

**Pop / band** — `Kick x-------x-x-----`, `Snare ----x-------x---`, `Hat x-x-x-x-x-x-x-x-`; crash (cymbal Crash) on the
first beat of sections; tom fills (`add_fill tom_run`).

## Harmony & bass

| Genre | Progressions (roman, minor unless noted) | Chords | Bass |
|-------|-------------------------------------------|--------|------|
| Trap / drill | `i VI III VII`, `i iv VI V`, `i bII` (phrygian) | pads/bells, `spread` or `close`, long notes | 808 `line` following the kick, slides "~" into octaves |
| Boom bap / lo-fi | `ii7 V7 Imaj7 vi7` (major), `i7 iv7 bVII7 bIIImaj7` | e-piano/keys, `drop2`, `shell`, `rootless`, register E4 | bass guitar Finger/Upright, `R:3 -:1 5:2 R:2 8:4 b7:4` |
| R&B / neo-soul | `IVmaj7 iii7 ii9 V13`, `ii9 V13 Imaj9` | e-piano Suitcase, `rootless`/`drop2`, `stepsPerChord` 8–16 | Finger bass with passing notes, legato |
| House | `i7 iv7` vamps, `vi IV I V` (major) | stabs: `style rhythm`, `rhythm "--x---x---x---x-"` | off-beat `rhythm "--x---x---x---x-"` (Sub Bass / Reese) |
| Techno | one chord or none | `synth Chord Stab`, filter automation | `synth Acid Bass` 16th line (`add_notes` with accented velocities), `add_automation` on a filter cutoff |
| Afrobeats | `I V vi IV` (major), `I IV` vamps | guitar Clean Electric arps (`arp-updown`), e-piano | syncopated Finger bass `R:3 R:3 5:2 R:3 8:3 5:2` |
| Pop / band | `I V vi IV`, `vi IV I V`, `I vi IV V` | piano Grand (block/broken), guitar Acoustic `style rhythm "x--x--x-"` octave 3, strings Ensemble long notes | bass Finger/Pick, roots + approach notes |

Melody: stay in the scale (`music_theory`), 2–4 bar motif, repeat it with a changed ending, leave a beat of space per
bar. Leads an octave above the chords' register.

## Sound palette

| Role | Built-in instrument → presets |
|------|-------------------------------|
| Kick | `kick` Punchy (pop/boom bap), Deep, Hard, House Thump, Lo-fi, Trap (short, for 808 tracks) |
| Snare / clap | `snare` Tight, Fat, Trap, Rimmy · `clap` Classic, Tight, Big |
| Hats / cymbals | `hat` Closed, Open, Pedal, Crisp · `cymbal` Crash, Ride, Splash · `shaker` |
| Percussion | `perc` Conga, Bongo, Zap, Woodblock · `rim` · `cowbell` 808 · `tom` |
| 808 / sub | `bass808` Classic, Distorted, Clean, Long, Short, Sub Drop · `synth` Sub Bass |
| Bass | `bass` Finger, Pick, Slap, Muted, Upright · `synth` Reese Bass, Acid Bass · `fm` FM Bass |
| Keys | `piano` Grand, Bright, Upright, Felt, Honky Tonk · `epiano` Suitcase, Mellow, Bright Tines, Tremolo, Wurli · `organ` Jazz, Gospel, Rock, Soft, Church · `fm` E-Piano, Felt Piano · `synth` Warm Keys, Lo-fi Keys |
| Guitar | `guitar` Acoustic, Nylon, Clean Electric, Muted, Overdrive |
| Strings | `strings` Ensemble, Slow Strings, Solo Cello, Solo Violin, Staccato, Pizzicato · `synth` Strings |
| Pads | `synth` Soft Pad, Supersaw, Strings · `fm` Glass |
| Leads / plucks | `synth` Saw Lead, Square Lead, Pluck, Arp Blip, Brass · `fm` Bell, Mallet |
| FX | `synth` Riser Noise, Reverse Swell · `bass808` Sub Drop (or `add_transition`) |
| Flutes | `flute` Concert, Breathy, Lo-fi Flute, Trap Flute, Alto Flute, Piccolo · `panflute` · `recorder` · `whistle` Irish, Low Whistle · `ocarina` · (`bansuri`, `shakuhachi`, `dizi` below) |
| Beatbox | `bbkick` Classic B, Punchy, Deep 808 Mouth, Throat Kick, Lip Pop · `bbsnare` Pf Snare, Psh Spit Snare, Inward K Snare, Kch Rimshot · `bbhat` T Hat, Ts Open Hat, Inward Hat, Tch Hat · `bbbass` Lip Bass, Hum, Throat Bass, Wub · `bbfx` Click Roll, Scratch, Laser Zap, Siren |
| Indian | `sitar` (jawari, taraf tuned by `sa`) · `tanpura` drone · `tabla` one channel per bol: Na, Tin, Tun, Te, Ge, Ke, Dha, Dhin, Ge Slide · `bansuri` · `shehnai` · `santoor` · `harmonium` |
| East Asian | `koto` · `guzheng` · `pipa` · `shamisen` Tsugaru, Nagauta · `erhu` Lament · `shakuhachi` · `dizi` · `suona` · `taiko` Odaiko, Chudaiko, Shime, Kara · `gong` Tam-tam, Opera Gong, Temple Bell |

`list_instruments` shows every parameter; `analyze_sound` measures what you changed.

### World and beatbox grooves

- **Beatbox kit**: `bbkick` "x-----x---x-----", `bbsnare` Psh Spit Snare "----x-------x---", `bbhat` T Hat 8ths with a Ts Open
  Hat on the last off-beat (same choke group), `bbbass` Lip Bass on the roots, a `bbfx` Scratch or Click Roll at the
  end of a 4-bar phrase. Leave the kit dry and close: a short room reverb at most.
- **Tabla theka (teentaal, 16 beats = 4 bars of quarter notes)**: Dha Dhin Dhin Dha | Dha Dhin Dhin Dha | Dha Tin Tin
  Ta | Ta Dhin Dhin Dha — make channels Dha, Dhin, Tin and Na (Ta) and write each bol's steps. Keherwa (8 beats, film
  and folk): Dha Ge Na Tin | Na Ke Dhin Na. Tanpura under it: C3 + G2 (Sa + Pa), whole-bar notes restruck every bar.
- **Indian lead**: sitar, bansuri or shehnai over the drone; `~` after a note in `write_melody` ("G4:4~ Ab4:2") slides
  into the next one (meend); keep the melody in the thaat, ornament the long notes, set the sitar's `sa` to the key. Harmonium doubles the vocal line or holds Sa–Pa.
- **East Asian**: koto or guzheng arpeggios in hirajoshi / pentatonic (`add_chords style arp-up` with sus2/5 chords, or
  `write_melody`), shakuhachi or erhu on long notes with slides, taiko on the downbeats (Odaiko) with Shime 8ths, a gong
  hit (Opera Gong) at section changes.
