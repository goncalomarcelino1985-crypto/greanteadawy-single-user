---
name: spatial-audio
description: Work on GreanTeaDawy's spatial (Dolby Atmos-style) mixing — 3D objects, binaural monitoring, speaker layouts, position automation, object stems and ADM BWF exports — in core, the audio engine, the Spatial window and the MCP tools.
---

# Spatial audio

Read `docs/spatial.md` first (the user's view). The pieces:

| Part | File |
|------|------|
| Model: `project.spatial { enabled, monitor }`, `insert.spatial { enabled, x, y, z, lfe }`, normalizers | `packages/core/src/spatial.js` (`normalizeProjectSpatial`, `normalizeInsertSpatial`), `model.js` |
| Ops | `project/update` with `patch.spatial`, `mixer/update` with `patch.spatial` (not on the master) in `packages/core/src/ops.js` |
| Positions over time (automation `spatialX/Y/Z`, held after clips) | `objectPositionAt`, `objectPositionTrack`, `objectBlocks` (core) |
| Speaker layouts + panning (ring-pair constant power, height crossfade) | `SPEAKER_LAYOUTS`, `speakerGains` (core) |
| ADM / BWF metadata | `buildAdmXml`, `admChna`, `bextChunk` (core) + `encodeWav({ extensible, chunks })` in `wav.js` |
| Engine | `client/src/audio/spatial.js` `SpatialRig` — modes `stereo`, `binaural` (HRTF `PannerNode`s), `speakers` (`ChannelMerger` + gains), `objects` (one merger channel per object) |
| Export render | `client/src/lib/spatialExport.js` (browser job `spatial`), positions JSON written by the server |
| UI | `client/src/components/Spatial.jsx` (room view, object panel), mixer strip **3D** badge |
| MCP | `server/src/mcp/tools/spatial.js` (`set_spatial`, `place_object`, `move_object`, `export_spatial`), prompt `spatial_mix` |

## Conventions

- Coordinates are ADM Cartesian: x −1 left … +1 right, y −1 back … +1 front, z 0 ear … 1 ceiling; listener at the
  origin. Automation stores **normalized** 0..1 values — convert with `spatialFromNorm` / `spatialToNorm`.
- Only inserts that route straight to the master can be objects (`isSpatialObject`); `MAX_SPATIAL_OBJECTS = 30`
  (offline renders have 32 channels: 2 bed + 30 objects).
- Objects **skip the master bus** in speaker/object renders (like an Atmos renderer) — report channel peaks so Claude
  can fix levels. Binaural and stereo monitoring keep the master chain.
- Objects are mono ((L+R)/√2). Speaker channel order follows WAVE_FORMAT_EXTENSIBLE masks (7.1: back before side).
- Exports are 48 kHz / 24-bit; ADM BWF is **experimental** (no BW64/>4 GB, not Dolby-certified) — say so in UI/docs.

## Testing

- Core math: `packages/core/test/spatial.test.js` (gains sum to unit power, presets, ADM XML/chna/bext structure).
- MCP + exports with a fake browser: `server/test/spatial.test.js`.
- Real renders: `e2e/workflow-spatial.spec.js` decodes the WAVs and checks where the energy is (e.g. an object
  `rear-left` lands mostly in Ls; `overhead` in the four height channels; binaural is louder in the near ear).
- Listen: Spatial window → Monitor *Binaural*, headphones, drag an object around.
