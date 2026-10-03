# Spatial mixing (Dolby Atmos-style 3D)

GreanTeaDawy can place parts of a song **around and above the listener**, the way object-based formats such as Dolby
Atmos work, and render the result for headphones (binaural), surround speakers (5.1, 7.1, 7.1.4) or as objects with
position metadata (object stems, an experimental ADM BWF).

![Spatial mixer](screenshots/spatial.png)

## Bed and objects

- The **bed** is the normal stereo mix: everything that isn't an object, including the master effects. In speaker
  renders it plays from the front left/right speakers.
- An **object** is a mixer insert with **3D** enabled. It has a position in the room and leaves the stereo bed: it is
  rendered at its position for headphones or speakers. Only inserts that go **straight to the master** can be objects
  (an insert routed into a bus stays in the bed — make the bus the object instead). Sends still work: an object's
  reverb send feeds the (bed) reverb bus, like a real Atmos session.
- Positions use the Atmos / ADM Cartesian convention: **x** −1 left wall … +1 right wall, **y** −1 back … +1 front
  (the screen), **z** 0 ear height … 1 ceiling; the listener sits at (0, 0, 0). Close to the listener the sound
  spreads over all speakers.
- **LFE** sends some of an object to the subwoofer channel (low-passed at 120 Hz) in speaker renders.

## The Spatial window

Open it with the cube button in the toolbar (or a mixer strip's right-click → *Make 3D object…*).

- **3D ON/OFF** — the spatial mix. Off: objects are ignored and everything is the stereo mix.
- **Monitor** — what you hear while working: *Stereo fold-down* (objects panned left/right by their x) or
  **Binaural (headphones)** — every object through head-related (HRTF) filters, so front/back/above become audible on
  headphones. The master effects still apply in both.
- The **room** seen from above (front at the top): drag objects; the dashed ring grows with height. Circles are the
  ear-level speakers, squares the height speakers of a 7.1.4 room.
- The **object panel**: left/right, back/front, height and LFE knobs, quick positions (FL, C, FR, L, Top, R, RL, Rear,
  RR).
- **Inserts**: tick an insert to make it an object. In the mixer, objects show **3D** instead of a pan knob.
- **Export** — the deliverables below (also in the File menu → *Export spatial mix (3D)…*).

**Moving objects**: positions are automatable — *spatialX*, *spatialY* and *spatialZ* of a mixer insert, in automation
clips like any other parameter (song mode). After a clip ends the object stays where the clip left it. Claude's
`move_object` builds these clips for you (circle, fly-over, rise, left-right, keyframes).

## Exports (48 kHz, 24-bit, into Projects → Exports)

| Format | What you get |
|--------|--------------|
| **Binaural** | a stereo WAV for headphones; objects around and above you, the bed and master effects as usual |
| **5.1** | 6-channel WAV (WAVE_FORMAT_EXTENSIBLE): L R C LFE Ls Rs |
| **7.1** | 8-channel WAV: L R C LFE Lrs Rrs Lss Rss (the extensible order: back before side) |
| **7.1.4** | 12-channel WAV: 7.1 + Ltf Rtf Ltr Rtr (height) |
| **Object stems** | the stereo bed, one mono WAV per object (`…-obj01-Name.wav`) and `…-positions.json` (every object's position over time, in seconds) |
| **ADM BWF** *(experimental)* | one WAV: bed (tracks 1–2) + one track per object, with `bext`, `chna` and `axml` chunks — ITU-R BS.2076 metadata with timed Cartesian positions |

Notes:

- Speaker renders map the room onto the layout like an object renderer — the front corners are L/R, the side walls
  the side surrounds (7.1) and the rear corners the rear surrounds, so `front-left` plays from L alone — then pan each
  object between the two nearest speakers of the ear-level ring (constant power) and crossfade onto the height ring
  as it rises; without height speakers, high objects fold down onto the ear level.
- In binaural monitoring and exports the 3D objects are trimmed by 3.5 dB (head-related filters add energy), so the
  binaural mix sits at the stereo mix's loudness; the bed is unchanged.
- In speaker and object renders, **objects skip the master bus** (limiter included), as in an Atmos renderer. The
  export reports every channel's peak — lower an object's fader if it reaches 0 dBFS.
- Objects are mono: a stereo source is summed as (L + R)/√2. Make a stereo pair two objects if you need width.
- At most 30 objects can be exported as object tracks (an offline render has 32 channels).
- **ADM BWF is not Dolby-certified.** It follows the ITU-R BS.2076 (ADM) and BS.2088-style chunk layout so
  Atmos-capable tools can import beds and objects, but some tools expect specific profiles (e.g. a 7.1.2 bed): check
  the object/bed assignment after import. Object positions are written as timed blocks that glide between positions
sampled every 32nd note (a straight move becomes one block); holds are blocks with `jumpPosition`. The object stems'
positions JSON uses the same blocks. Files over 4 GB (BW64) aren't supported — the export says so before rendering;
render a shorter part.

## With Claude

Claude has `set_spatial`, `place_object`, `move_object` and `export_spatial` (and the `spatial_mix` prompt):

> *"Make an Atmos version: strings overhead, guitars wide, the shaker behind me, let the riser circle the room before
> the drop, then give me a binaural and a 7.1.4 file."*

See [Making music with Claude](claude-mcp.md#spatial-atmos-style-mixing).
