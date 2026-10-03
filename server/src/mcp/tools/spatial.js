// Spatial (Atmos-style) mixing for Claude: turn the 3D mix on, place mixer inserts as objects in the room, move them
// over time (automation) and export binaural / 5.1 / 7.1 / 7.1.4 / object stems / ADM BWF.
import {
  uid, ticksPerBar, STEP, findPattern, MAX_TRACKS, POSITION_PRESETS, polarToPosition, normalizeInsertSpatial,
  isSpatialObject, spatialToNorm, SPATIAL_EXPORTS, SPATIAL_EXPORT_IDS, MAX_SPATIAL_OBJECTS
} from '@greanteadawy/core';
import { z, ok, projectIdArg, annotations as A, pickTrack, barsOf } from '../util.js';
import { progressNotifier } from './mix.js';

const PRESET_NAMES = Object.keys(POSITION_PRESETS);
const r2 = (x) => Math.round(x * 100) / 100;
const fmtPos = (s) => `x ${r2(s.x)}, y ${r2(s.y)}, z ${r2(s.z)}${s.lfe ? `, lfe ${r2(s.lfe)}` : ''}`;

/** Mixer insert from an index, an insert name or a channel name (its insert). */
export function resolveInsert(p, ref) {
  const s = String(ref ?? '').trim();
  if (/^\d+$/.test(s)) {
    const i = Number(s);
    if (i < 1 || i >= p.mixer.length) throw new Error(`Mixer insert ${i} does not exist (1..${p.mixer.length - 1}; the master can't be a 3D object)`);
    return i;
  }
  const byInsert = p.mixer.findIndex((m, i) => i > 0 && m.name.toLowerCase() === s.toLowerCase());
  if (byInsert > 0) return byInsert;
  const ch = p.channels.find((c) => c.name.toLowerCase() === s.toLowerCase());
  if (ch) {
    if (ch.mixerTrack === 0) throw new Error(`Channel "${ch.name}" plays straight into the master; give it its own mixer insert first (update_channel mixerTrack) to make it a 3D object`);
    return ch.mixerTrack;
  }
  throw new Error(`No mixer insert or channel named "${ref}". Inserts: ${p.mixer.slice(1).map((m, i) => `${i + 1} ${m.name}`).join(', ')}`);
}

/** A position from a preset name, polar (azimuth/elevation/distance) or x/y/z (any given axis overrides). */
function positionFrom(args, current) {
  let pos = { x: current.x, y: current.y, z: current.z };
  if (args.position) {
    const [x, y, zz] = POSITION_PRESETS[args.position];
    pos = { x, y, z: zz };
  }
  if (args.azimuth !== undefined || args.elevation !== undefined || args.distance !== undefined) {
    pos = polarToPosition({ azimuth: args.azimuth ?? 0, elevation: args.elevation ?? 0, distance: args.distance ?? 1 });
  }
  for (const k of ['x', 'y', 'z']) if (args[k] !== undefined) pos[k] = args[k];
  return pos;
}

function objectList(p) {
  const lines = [];
  p.mixer.forEach((m, i) => {
    if (i === 0 || !m.spatial?.enabled) return;
    const why = isSpatialObject(p, i) ? '' : m.output ? ` — inactive: routed to insert ${m.output}, only inserts going straight to the master can be objects` : ' — inactive: spatial mix is off';
    lines.push(`- ${i} ${m.name}: ${fmtPos(m.spatial)}${why}`);
  });
  return lines.length ? lines.join('\n') : '(no 3D objects yet — use place_object)';
}

const posSchema = {
  position: z.enum(PRESET_NAMES).optional().describe(`Named spot: ${PRESET_NAMES.join(', ')}`),
  x: z.number().min(-1).max(1).optional().describe('-1 left wall … 0 centre … 1 right wall'),
  y: z.number().min(-1).max(1).optional().describe('-1 back wall … 0 listener … 1 front wall (screen)'),
  z: z.number().min(0).max(1).optional().describe('0 ear height … 1 ceiling'),
  azimuth: z.number().min(-180).max(180).optional().describe('Polar alternative: degrees clockwise from the front (90 = right, -90 = left, 180 = behind)'),
  elevation: z.number().min(0).max(90).optional().describe('Polar: 0 ear height … 90 straight up'),
  distance: z.number().min(0).max(1).optional().describe('Polar: 0 at the listener … 1 at the walls (default 1)')
};

const PATHS = ['circle', 'left-right', 'right-left', 'front-back', 'back-front', 'rise', 'fall', 'fly-over', 'points'];

export function registerSpatialTools({ tool, backend, load }) {
  tool('set_spatial', {
    title: 'Spatial mix on/off and monitoring',
    description: 'Turn the spatial (Dolby Atmos-style 3D) mix on or off and choose how the studio monitors it: "binaural" renders every 3D object through head-related filters for headphones, "stereo" folds objects into the normal stereo mix by their left/right position. Mixer inserts become 3D objects with place_object; everything else stays in the stereo bed. Lists the objects.',
    inputSchema: {
      projectId: projectIdArg,
      enabled: z.boolean().optional(),
      monitor: z.enum(['stereo', 'binaural']).optional().describe('What the user hears in the studio (exports pick their own format)')
    },
    annotations: A.edit
  }, async ({ projectId, enabled, monitor }) => {
    const p = await load(projectId);
    const spatial = { ...p.spatial, ...(enabled !== undefined ? { enabled } : {}), ...(monitor ? { monitor } : {}) };
    const next = await backend.applyOps(p.id, [{ type: 'project/update', patch: { spatial } }]);
    const sp = next.spatial;
    return ok(`Spatial mix ${sp.enabled ? 'ON' : 'OFF'}, monitoring ${sp.monitor}${sp.monitor === 'binaural' ? ' (headphones)' : ''}.\nObjects:\n${objectList(next)}`);
  });

  tool('place_object', {
    title: 'Place a 3D object',
    description: 'Make a mixer insert (by insert number/name or a channel name — its insert) a 3D object and put it somewhere in the room: a named spot ("front-left", "rear-right", "overhead"…), x/y/z (Atmos Cartesian: x -1 left…1 right, y -1 back…1 front, z 0 ear height…1 ceiling) or azimuth/elevation/distance. lfe sends some of it to the subwoofer channel in speaker renders. Turns the spatial mix on. The insert must route straight to the master (not into a bus). enabled=false returns it to the stereo bed. Typical: lead vocal/lead synth front centre, pads wide or overhead, percussion and FX around or behind, bass and kick in the bed.',
    inputSchema: {
      projectId: projectIdArg,
      insert: z.union([z.string(), z.number().int()]).describe('Mixer insert number or name, or a channel name'),
      enabled: z.boolean().optional().describe('Default true'),
      ...posSchema,
      lfe: z.number().min(0).max(1).optional().describe('LFE (subwoofer) send for speaker renders, 0..1 (default 0)')
    },
    annotations: A.edit
  }, async (args) => {
    const p = await load(args.projectId);
    const i = resolveInsert(p, args.insert);
    const m = p.mixer[i];
    const enabled = args.enabled !== false;
    if (enabled && m.output) throw new Error(`Insert ${i} "${m.name}" routes into insert ${m.output} "${p.mixer[m.output].name}". Only inserts that go straight to the master can be 3D objects — route it to the master (set_mixer output 0) or place the bus insert instead.`);
    const current = normalizeInsertSpatial(m.spatial, m.pan);
    const pos = positionFrom(args, current);
    const spatial = { ...current, ...pos, enabled, ...(args.lfe !== undefined ? { lfe: args.lfe } : {}) };
    const ops = [{ type: 'mixer/update', index: i, patch: { spatial } }];
    const turnOn = enabled && !p.spatial?.enabled;
    if (turnOn) ops.unshift({ type: 'project/update', patch: { spatial: { ...p.spatial, enabled: true } } });
    const next = await backend.applyOps(p.id, ops);
    const s = next.mixer[i].spatial;
    return ok(`${enabled ? `Placed insert ${i} "${m.name}" at ${fmtPos(s)}` : `Insert ${i} "${m.name}" is back in the stereo bed`}.${turnOn ? ' Spatial mix turned on (monitoring stereo — set_spatial monitor=binaural for headphones).' : ''}\nObjects:\n${objectList(next)}`);
  });

  tool('move_object', {
    title: 'Move a 3D object over time',
    description: `Animate a 3D object with position automation clips (spatialX/spatialY/spatialZ of its mixer insert) in the playlist: "circle" (orbit around the listener; turns, radius, clockwise), "left-right"/"right-left" (pan across the front), "front-back"/"back-front" (fly through the room), "rise"/"fall" (height), "fly-over" (front to back over the listener's head) or "points" (your own keyframes). Plays in song mode. The object's resting position becomes the path's start; after the clip it stays where the path ended. Paths: ${PATHS.join(', ')}.`,
    inputSchema: {
      projectId: projectIdArg,
      insert: z.union([z.string(), z.number().int()]).describe('Mixer insert number or name, or a channel name'),
      path: z.enum(PATHS),
      startBar: z.number().min(1).describe('1-based bar where the movement starts'),
      bars: z.number().min(0.25).max(256).describe('Duration in bars'),
      turns: z.number().min(0.25).max(64).optional().describe('circle: revolutions (default 1)'),
      radius: z.number().min(0.1).max(1).optional().describe('circle: distance from the listener (default 1 = the walls)'),
      height: z.number().min(0).max(1).optional().describe('circle/left-right/front-back: z during the move (default: its current z)'),
      clockwise: z.boolean().optional().describe('circle direction seen from above (default true)'),
      points: z.array(z.object({
        bar: z.number().min(0).describe('Bars from the movement start (0-based)'),
        position: z.enum(PRESET_NAMES).optional(),
        x: z.number().min(-1).max(1).optional(),
        y: z.number().min(-1).max(1).optional(),
        z: z.number().min(0).max(1).optional()
      })).min(2).max(256).optional().describe('path=points: keyframes (positions in between glide linearly)')
    },
    annotations: A.edit
  }, async ({ projectId, insert, path, startBar, bars, turns = 1, radius = 1, height, clockwise = true, points }) => {
    const p = await load(projectId);
    const i = resolveInsert(p, insert);
    const m = p.mixer[i];
    if (m.output) throw new Error(`Insert ${i} "${m.name}" routes into a bus (insert ${m.output}); only inserts that go straight to the master can be 3D objects`);
    const bar = ticksPerBar(p);
    const length = Math.max(STEP, Math.round(bars * bar));
    const cur = normalizeInsertSpatial(m.spatial, m.pan);
    const zz = height ?? cur.z;
    // keyframes as [fraction 0..1, {x,y,z}]
    let keys;
    if (path === 'circle') {
      const steps = Math.max(8, Math.round(16 * turns));
      const a0 = Math.atan2(cur.x, cur.y); // start where the object is (azimuth, clockwise from the front)
      keys = Array.from({ length: steps + 1 }, (_, k) => {
        const a = a0 + (clockwise ? 1 : -1) * 2 * Math.PI * turns * (k / steps);
        return [k / steps, { x: Math.sin(a) * radius, y: Math.cos(a) * radius, z: zz }];
      });
    } else if (path === 'points') {
      if (!points) throw new Error('path=points needs points: [{ bar, x, y, z } | { bar, position }]');
      let last = cur;
      keys = [...points].sort((a, b) => a.bar - b.bar).map((pt) => {
        if (pt.bar > bars) throw new Error(`A point at bar ${pt.bar} lies beyond the movement (${bars} bars)`);
        const base = pt.position ? Object.fromEntries(['x', 'y', 'z'].map((k, j) => [k, POSITION_PRESETS[pt.position][j]])) : last;
        last = { x: pt.x ?? base.x, y: pt.y ?? base.y, z: pt.z ?? base.z };
        return [pt.bar / bars, last];
      });
    } else {
      const lines = {
        'left-right': [{ x: -1, y: cur.y, z: zz }, { x: 1, y: cur.y, z: zz }],
        'right-left': [{ x: 1, y: cur.y, z: zz }, { x: -1, y: cur.y, z: zz }],
        'front-back': [{ x: cur.x, y: 1, z: zz }, { x: cur.x, y: -1, z: zz }],
        'back-front': [{ x: cur.x, y: -1, z: zz }, { x: cur.x, y: 1, z: zz }],
        rise: [{ ...cur, z: 0 }, { ...cur, z: 1 }],
        fall: [{ ...cur, z: 1 }, { ...cur, z: 0 }]
      };
      if (path === 'fly-over') {
        keys = Array.from({ length: 9 }, (_, k) => [k / 8, { x: cur.x, y: 1 - (2 * k) / 8, z: Math.sin((Math.PI * k) / 8) }]);
      } else {
        keys = [[0, lines[path][0]], [1, lines[path][1]]];
      }
    }
    const axes = [['spatialX', 'x'], ['spatialY', 'y'], ['spatialZ', 'z']].filter(([, a]) => new Set(keys.map(([, pos]) => Math.round(pos[a] * 1000))).size > 1);
    if (!axes.length) throw new Error('That path does not move the object (every keyframe is the same position)');
    const start = keys[0][1];
    const ops = [];
    if (!p.spatial?.enabled) ops.push({ type: 'project/update', patch: { spatial: { ...p.spatial, enabled: true } } });
    ops.push({ type: 'mixer/update', index: i, patch: { spatial: { ...cur, ...start, enabled: true } } });
    const used = new Set(p.playlist.clips.map((c) => c.track));
    const created = [];
    for (const [param, axis] of axes) {
      const id = uid('auto');
      let trk = pickTrack(p, id);
      while (used.has(trk) && trk < MAX_TRACKS - 1) trk++;
      used.add(trk);
      if (trk >= p.playlist.tracks.length) ops.push({ type: 'track/add', count: trk - p.playlist.tracks.length + 1 });
      const pts = keys.map(([f, pos]) => ({ t: Math.round(f * length), v: Math.round(spatialToNorm(param, pos[axis]) * 10000) / 10000 }));
      const name = `${m.name} 3D ${axis.toUpperCase()}`;
      ops.push(
        { type: 'automation/add', automation: { id, name, target: { type: 'mixer', index: i, param }, length, points: pts } },
        { type: 'clip/add', clips: [{ id: uid('clip'), kind: 'automation', refId: id, track: trk, start: Math.round((startBar - 1) * bar), length }] }
      );
      created.push(`${name} [${id}] on track ${trk + 1}`);
    }
    await backend.applyOps(p.id, ops);
    const end = keys[keys.length - 1][1];
    return ok(`Moving insert ${i} "${m.name}" (${path}) from bar ${startBar} for ${barsOf(p, length)} bars: from ${fmtPos(start)} to ${fmtPos(end)}. Automation: ${created.join('; ')}. It plays in song mode (place the pattern in the playlist).`);
  });

  tool('export_spatial', {
    title: 'Export the spatial mix',
    description: `Render the 3D mix in the user's browser (48 kHz, 24-bit) into the user's exports: ${SPATIAL_EXPORT_IDS.map((k) => `"${k}" = ${SPATIAL_EXPORTS[k].description}`).join('; ')}. Objects render in 3D even when the studio monitors in stereo. Needs at least one 3D object (place_object); object stems/ADM take at most ${MAX_SPATIAL_OBJECTS} objects. The master bus effects apply to the bed (and to the binaural mix) but not to objects in speaker/object renders, as in an Atmos renderer — check peaks in the report. Needs the studio open in a browser.`,
    inputSchema: {
      projectId: projectIdArg,
      format: z.enum(SPATIAL_EXPORT_IDS),
      mode: z.enum(['song', 'pattern']).optional().describe('Default: song if the playlist has clips, else pattern'),
      pattern: z.string().optional(),
      loops: z.number().int().min(1).max(16).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ projectId, format, mode, pattern, loops = 2 }, extra) => {
    const p = await load(projectId);
    const objects = p.mixer.map((m, i) => i).filter((i) => i > 0 && p.mixer[i].spatial?.enabled && !p.mixer[i].output);
    if (!objects.length) throw new Error('No 3D objects yet: place_object first (e.g. the lead front centre, pads overhead)');
    const m = mode || (p.playlist.clips.length ? 'song' : 'pattern');
    const patternId = pattern ? findPattern(p, pattern).id : p.patterns[0]?.id;
    const r = await backend.requestJob(
      { kind: 'spatial', projectId: p.id, format, mode: m, patternId, loops, name: p.name },
      { projectId: p.id, timeoutMs: 900000, onProgress: progressNotifier(extra, `Rendering ${SPATIAL_EXPORTS[format].label} in the browser`) }
    );
    const files = [...(r.files || []), ...(r.positionsFile ? [r.positionsFile] : [])];
    const lines = [`Exported ${SPATIAL_EXPORTS[format].label} (${r.seconds}s, ${r.sampleRate / 1000} kHz / ${r.bitDepth}-bit) to the user's exports (Projects → Exports):`];
    for (const f of files) lines.push(`- ${f.name} (${Math.round(f.bytes / 1024)} KB): ${f.url}`);
    if (r.lufs !== undefined) lines.push(`Binaural loudness ${r.lufs} LUFS${r.truePeakDb !== null && r.truePeakDb !== undefined ? `, true peak ${r.truePeakDb} dBTP` : ''}.`);
    if (r.channels?.length) {
      const hot = r.channels.filter((c) => c.peakDb > -0.3);
      lines.push(`Channel peaks: ${r.channels.map((c) => `${c.id} ${c.peakDb} dBFS`).join(', ')}.${hot.length ? ` ${hot.map((c) => c.id).join(', ')} reach 0 dBFS — lower those objects' faders (objects skip the master limiter).` : ''}`);
    }
    lines.push(`Objects: ${(r.objects || []).map((o) => `${o.name}${o.moves ? ' (moving)' : ''}`).join(', ')}.`);
    if (format === 'adm') lines.push('ADM BWF is experimental (ITU-R BS.2076 metadata, not Dolby-certified): Atmos tools may need the object/bed assignment checked after import.');
    return ok(lines.join('\n'), { files, objects: r.objects, channels: r.channels || null });
  });
}
