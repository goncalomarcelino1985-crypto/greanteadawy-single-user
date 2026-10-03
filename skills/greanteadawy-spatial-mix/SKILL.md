---
name: greanteadawy-spatial-mix
description: Make an immersive Dolby Atmos-style 3D mix of a GreanTeaDawy song — place mixer inserts as objects around and above the listener, animate them, monitor binaurally and export binaural, 5.1, 7.1, 7.1.4, object stems or ADM BWF. Use when the user asks for Atmos, spatial, 3D, immersive, surround, binaural or headphone 3D versions.
---

# Spatial (Atmos-style) mixing in GreanTeaDawy

The normal stereo mix is the **bed**; mixer inserts you make **objects** get a position in the room. Coordinates
(ADM/Atmos Cartesian): **x** −1 left … 1 right, **y** −1 back … 1 front, **z** 0 ear height … 1 ceiling; the listener
is at the centre. Only inserts that route straight to the master can be objects (make a bus the object, not the
channels in it). Up to 30 objects.

## Workflow

1. Get a good **stereo** mix first (`greanteadawy-mixing`): spatial placement doesn't fix balance. `save_version
   name="stereo master"`.
2. `set_spatial enabled=true monitor=binaural` — the user hears 3D on headphones while you work.
3. Decide the scene and tell the user in one sentence ("drums and bass in front, keys wide, strings overhead, the
   shaker behind you, the riser circling into the drop").
4. `place_object insert=<channel or insert name> position=<named spot>` (or `x y z`, or `azimuth elevation distance`)
   for each object. Leave the rest in the bed.
5. Movement — sparingly, where it means something: `move_object path=circle|fly-over|rise|fall|left-right|points
   startBar bars` (transitions, risers, a hook's ear candy). Static placement for everything rhythmic.
6. `export_spatial format=binaural` and listen-check with the report; then the speaker/object deliverables.
7. `save_version name="atmos"`.

## Placement that works

| Element | Where | Why |
|---------|-------|-----|
| Kick, bass/808, snare, lead vocal/lead | bed (or `front` / `center`) | anchors the mix; the bed's low end stays in L/R (only objects feed the LFE, through their `lfe` send) |
| Pads, strings, choirs | `overhead`, `top-front-left/right` (z 0.5–1) | envelop without masking the lead |
| Guitars, keys, doubles | `wide-left` / `wide-right` (x ±0.8, y 0.3–0.6) | width beyond the stereo speakers |
| Percussion, shakers, FX, delays | `rear-left`, `rear-right`, `rear` (y −0.5…−1) | depth and surprise |
| Risers, sweeps | moving: `circle` 1–2 turns over the build, or `rise` into the drop | motion = energy |
| Reverb bus | bed | keeps the room coherent |

LFE: `lfe 0.1–0.3` only for big low elements that are objects; most low end belongs in the bed.

## Deliverables (`export_spatial`, 48 kHz / 24-bit)

| Format | For |
|--------|-----|
| `binaural` | headphones, streaming previews, sharing — always make this one |
| `5.1`, `7.1`, `7.1.4` | speaker playback / surround systems (7.1.4 includes 4 height channels) |
| `objects` | bed + mono object stems + a positions JSON (seconds) — for re-rendering elsewhere |
| `adm` | **experimental** ADM BWF (bed + objects + ITU-R BS.2076 metadata) for Atmos-capable tools; not Dolby-certified — the user should check the import |

Objects **skip the master limiter** in speaker/object renders: the export reports every channel's peak — keep object
channels under −1 dBFS (lower that insert with `set_mixer volumeDb`). Binaural keeps the master chain.

## Checks

- The stereo fold-down still works (`set_spatial monitor=stereo`, `render_mix`): don't break the stereo master.
- Rear/overhead elements are support, not the hook. If something important is behind the listener, bring it forward.
- Movement: one or two moving objects at a time; fast circles (more than a turn per bar) sound gimmicky.
