// Spatial ("Dolby Atmos-style") mixing: mixer inserts can be 3D *objects* placed in a room; everything else is the
// stereo *bed*. Positions use the Atmos / ADM Cartesian convention:
//   x  -1 left wall … +1 right wall,  y  -1 back wall … +1 front wall (the screen),  z  0 ear height … 1 ceiling.
// The listener sits in the middle (0, 0, 0). Renders: binaural (headphones), 5.1 / 7.1 / 7.1.4 speaker WAVs, per-object
// stems with position data, and an experimental ADM BWF (ITU-R BS.2076 metadata, not Dolby-certified).
import { automationValueAt } from './timeline.js';
import { PPQ } from './constants.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const r3 = (x) => Math.round(x * 1000) / 1000;

export const SPATIAL_MONITORS = ['stereo', 'binaural'];
export const MAX_SPATIAL_OBJECTS = 30; // an offline render has at most 32 channels: 2 bed + 30 objects

/** Project-level spatial settings: { enabled, monitor }. */
export function normalizeProjectSpatial(s) {
  return { enabled: !!s?.enabled, monitor: SPATIAL_MONITORS.includes(s?.monitor) ? s.monitor : 'stereo' };
}

/** A mixer insert's 3D object settings: { enabled, x, y, z, lfe } (clamped; a new object starts on the front wall at its pan). */
export function normalizeInsertSpatial(s, pan = 0) {
  return {
    enabled: !!s?.enabled,
    x: r3(clamp(num(s?.x, pan), -1, 1)),
    y: r3(clamp(num(s?.y, 1), -1, 1)),
    z: r3(clamp(num(s?.z, 0), 0, 1)),
    lfe: r3(clamp(num(s?.lfe, 0), 0, 1))
  };
}

/** Is mixer insert `index` rendered as a 3D object? (spatial mix on, object enabled, routed straight to the master) */
export function isSpatialObject(project, index) {
  const m = project.mixer[index];
  return index > 0 && !!project.spatial?.enabled && !!m?.spatial?.enabled && (m.output || 0) === 0;
}

export function spatialObjects(project) {
  const out = [];
  project.mixer.forEach((m, i) => { if (isSpatialObject(project, i)) out.push(i); });
  return out;
}

// ------------------------------------------------------------------ automation

/** Automatable position params of a mixer insert and their mapping from the automation's 0..1 value. */
export const SPATIAL_PARAMS = {
  spatialX: { axis: 'x', label: '3D left ↔ right', min: -1, max: 1 },
  spatialY: { axis: 'y', label: '3D back ↔ front', min: -1, max: 1 },
  spatialZ: { axis: 'z', label: '3D height', min: 0, max: 1 }
};
export const spatialFromNorm = (param, v) => { const p = SPATIAL_PARAMS[param]; return p.min + (p.max - p.min) * clamp(v, 0, 1); };
export const spatialToNorm = (param, c) => { const p = SPATIAL_PARAMS[param]; return clamp((c - p.min) / (p.max - p.min), 0, 1); };

/**
 * Position of an object at song tick `tick`, as the engine plays it: inside an automation clip its value; after a
 * clip, the value that clip ended on (until the next one); before any clip, the object's own position.
 */
export function objectPositionAt(project, index, tick) {
  const pos = { ...normalizeInsertSpatial(project.mixer[index]?.spatial, project.mixer[index]?.pan) };
  const tracks = project.playlist.tracks;
  for (const param of Object.keys(SPATIAL_PARAMS)) {
    let value = null;
    let lastEnd = -Infinity;
    for (const clip of project.playlist.clips) {
      if (clip.kind !== 'automation' || clip.mute || tracks[clip.track]?.mute) continue;
      const a = project.automations.find((x) => x.id === clip.refId);
      if (!a || a.target.type !== 'mixer' || a.target.index !== index || a.target.param !== param) continue;
      const end = clip.start + clip.length;
      if (clip.start <= tick && tick < end) {
        value = automationValueAt(a, tick - clip.start + (clip.offset || 0));
        break;
      }
      if (end <= tick && end > lastEnd) {
        lastEnd = end;
        value = automationValueAt(a, clip.length - 1 + (clip.offset || 0));
      }
    }
    if (value !== null) pos[SPATIAL_PARAMS[param].axis] = r3(spatialFromNorm(param, value));
  }
  return pos;
}

/** The project with only the automation clips/automations that move this insert (same positions, much faster). */
function positionsOnly(project, index) {
  const autos = project.automations.filter((a) => a.target.type === 'mixer' && a.target.index === index && SPATIAL_PARAMS[a.target.param]);
  const ids = new Set(autos.map((a) => a.id));
  return { ...project, automations: autos, playlist: { ...project.playlist, clips: project.playlist.clips.filter((c) => c.kind === 'automation' && ids.has(c.refId)) } };
}

/**
 * Positions sampled every `step` ticks over [from, to) and simplified: points that lie (within 0.01) on the straight
 * line between their neighbours are dropped — consumers glide linearly between the points (objectBlocks writes them
 * as ADM blocks that do exactly that). [{ tick, x, y, z }]
 */
export function objectPositionTrack(project, index, { from = 0, to, step = 24, song = true, tolerance = 0.01 } = {}) {
  const fixed = normalizeInsertSpatial(project.mixer[index]?.spatial, project.mixer[index]?.pan);
  if (!song) return [{ tick: from, x: fixed.x, y: fixed.y, z: fixed.z }];
  project = positionsOnly(project, index); // sampled thousands of times: only the clips that move this object
  const pts = [];
  for (let t = from; t < to; t += step) {
    const p = objectPositionAt(project, index, t);
    pts.push({ tick: t, x: p.x, y: p.y, z: p.z });
  }
  if (pts.length < 3) return pts;
  // Douglas–Peucker: keep the fewest points such that every sample lies within `tolerance` of the straight line
  // between the kept points around it (checked against every sample, so slow moves keep their start and end)
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, c] = stack.pop();
    let worst = -1;
    let off = tolerance;
    for (let i = a + 1; i < c; i++) {
      const f = (pts[i].tick - pts[a].tick) / (pts[c].tick - pts[a].tick);
      const d = Math.max(...['x', 'y', 'z'].map((k) => Math.abs(pts[a][k] + (pts[c][k] - pts[a][k]) * f - pts[i][k])));
      if (d > off) { off = d; worst = i; }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, c]);
    }
  }
  const out = pts.filter((_, i) => keep[i]);
  // a static object ends where it started: one point is enough
  const [first, last] = [out[0], out[out.length - 1]];
  return out.length === 2 && first.x === last.x && first.y === last.y && first.z === last.z ? [first] : out;
}

// ------------------------------------------------------------------ named positions & polar input

export const POSITION_PRESETS = {
  center: [0, 1, 0], front: [0, 1, 0], 'front-left': [-1, 1, 0], 'front-right': [1, 1, 0],
  'wide-left': [-1, 0.5, 0], 'wide-right': [1, 0.5, 0],
  left: [-1, 0, 0], right: [1, 0, 0], 'rear-left': [-1, -1, 0], 'rear-right': [1, -1, 0], rear: [0, -1, 0],
  overhead: [0, 0, 1], 'top-front-left': [-1, 1, 1], 'top-front-right': [1, 1, 1], 'top-front': [0, 1, 1],
  'top-rear-left': [-1, -1, 1], 'top-rear-right': [1, -1, 1], 'top-rear': [0, -1, 1], room: [0, 0, 0]
};

/**
 * Polar → Cartesian room position. azimuth: degrees clockwise from the front (90 = right, -90 = left, 180 = behind);
 * elevation: 0 ear height … 90 overhead; distance 0 (the listener) … 1 (the walls/ceiling).
 */
export function polarToPosition({ azimuth = 0, elevation = 0, distance = 1 }) {
  const az = (num(azimuth, 0) * Math.PI) / 180;
  const el = (clamp(num(elevation, 0), 0, 90) * Math.PI) / 180;
  const d = [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)];
  const m = Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])) || 1;
  const k = clamp(num(distance, 1), 0, 1) / m; // onto the cube's surface, scaled by distance
  return { x: r3(clamp(d[0] * k, -1, 1)), y: r3(clamp(d[1] * k, -1, 1)), z: r3(clamp(d[2] * k, 0, 1)) };
}

// ------------------------------------------------------------------ speaker layouts

const dir = (azDeg, elDeg = 0) => {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)];
};

/**
 * Speaker layouts (ITU-R BS.2051 angles; azimuth clockwise, so left speakers are negative). `order` is the WAV channel
 * order of WAVE_FORMAT_EXTENSIBLE (FL FR FC LFE BL BR SL SR TFL TFR TBL TBR) and `mask` its dwChannelMask.
 */
export const SPEAKER_LAYOUTS = {
  '5.1': {
    label: '5.1 (L R C LFE Ls Rs)', mask: 0x3f,
    speakers: [['L', dir(-30)], ['R', dir(30)], ['C', dir(0)], ['LFE', null], ['Ls', dir(-110)], ['Rs', dir(110)]]
  },
  '7.1': {
    label: '7.1 (L R C LFE Lrs Rrs Lss Rss)', mask: 0x63f,
    speakers: [['L', dir(-30)], ['R', dir(30)], ['C', dir(0)], ['LFE', null], ['Lrs', dir(-135)], ['Rrs', dir(135)], ['Lss', dir(-90)], ['Rss', dir(90)]]
  },
  '7.1.4': {
    label: '7.1.4 (7.1 + Ltf Rtf Ltr Rtr)', mask: 0x2d63f,
    speakers: [
      ['L', dir(-30)], ['R', dir(30)], ['C', dir(0)], ['LFE', null], ['Lrs', dir(-135)], ['Rrs', dir(135)], ['Lss', dir(-90)], ['Rss', dir(90)],
      ['Ltf', dir(-45, 45)], ['Rtf', dir(45, 45)], ['Ltr', dir(-135, 45)], ['Rtr', dir(135, 45)]
    ]
  }
};
export const SPEAKER_LAYOUT_IDS = Object.keys(SPEAKER_LAYOUTS);

const azOf = (d) => (Math.atan2(d[0], d[1]) * 180) / Math.PI; // clockwise from the front

/** Constant-power pairwise panning on a ring of speakers ([{ i, az }]) for azimuth `az` (degrees). */
function ringPan(ring, az, gains, weight) {
  if (!ring.length || weight <= 0) return;
  if (ring.length === 1) { gains[ring[0].i] += weight; return; }
  const sorted = [...ring].sort((a, b) => a.az - b.az);
  const norm = (a) => ((a % 360) + 360) % 360;
  for (let k = 0; k < sorted.length; k++) {
    const a = sorted[k];
    const b = sorted[(k + 1) % sorted.length];
    const span = norm(b.az - a.az) || 360;
    const off = norm(az - a.az);
    if (off <= span) {
      const t = off / span;
      gains[a.i] += weight * Math.cos((t * Math.PI) / 2);
      gains[b.i] += weight * Math.sin((t * Math.PI) / 2);
      return;
    }
  }
}

/**
 * Map a direction in the (square) room onto a speaker ring, the way object renderers do for Cartesian positions: the
 * room's front corners land on the front L/R speakers, its sides on side speakers (when the layout has them) and its
 * rear corners on the rearmost surrounds — so `front-left` (-1, 1) is exactly L and `rear-left` exactly Ls/Lrs.
 */
function warpAz(ring, az) {
  const abs = ring.map((s) => Math.abs(s.az)).filter((a) => a > 1 && a < 179);
  const fronts = abs.filter((a) => a <= 60);
  const rears = abs.filter((a) => a > 105);
  const front = fronts.length ? Math.min(...fronts) : 45;
  const side = abs.find((a) => a >= 75 && a <= 105);
  const rear = rears.length ? Math.max(...rears) : 135;
  const anchors = [[0, 0], [45, front], ...(side ? [[90, side]] : []), [135, rear], [180, 180]];
  const a = Math.abs(az);
  for (let k = 1; k < anchors.length; k++) {
    const [x0, y0] = anchors[k - 1];
    const [x1, y1] = anchors[k];
    if (a <= x1) return Math.sign(az) * (y0 + ((a - x0) / (x1 - x0)) * (y1 - y0));
  }
  return az;
}

/**
 * Energy-preserving speaker gains for an object at `pos` (the LFE gets 0 — objects reach it through their lfe send).
 * The direction is panned between the two nearest speakers of the ear-level ring (constant power), the height (z)
 * crossfades onto the height ring when the layout has one (otherwise elevated objects fold down onto the ear level),
 * and objects near the middle of the room spread over the whole ring.
 */
export function speakerGains(layoutId, pos) {
  const layout = SPEAKER_LAYOUTS[layoutId];
  const x = clamp(num(pos?.x, 0), -1, 1);
  const y = clamp(num(pos?.y, 1), -1, 1);
  const z = clamp(num(pos?.z, 0), 0, 1);
  const ear = [];
  const top = [];
  layout.speakers.forEach(([, d], i) => { if (d) (d[2] > 0.1 ? top : ear).push({ i, az: azOf(d) }); });
  const gains = new Array(layout.speakers.length).fill(0);
  const rH = Math.hypot(x, y);
  const az = rH > 1e-6 ? (Math.atan2(x, y) * 180) / Math.PI : 0;
  const spread = clamp(1 - rH / 0.35, 0, 1); // close to the listener the image widens to the whole ring
  const h = top.length ? z : 0;
  const layers = [[ear, Math.cos((h * Math.PI) / 2)], [top, Math.sin((h * Math.PI) / 2)]];
  for (const [ring, w] of layers) {
    if (!ring.length || w < 1e-9) continue;
    const g = new Array(gains.length).fill(0);
    ringPan(ring, warpAz(ring, az), g, 1);
    for (const sp of ring) g[sp.i] = Math.sqrt((1 - spread) * g[sp.i] * g[sp.i] + spread / ring.length);
    for (const sp of ring) gains[sp.i] += w * g[sp.i];
  }
  const e = Math.sqrt(gains.reduce((a, v) => a + v * v, 0)) || 1;
  return gains.map((v) => v / e);
}

// ------------------------------------------------------------------ ADM (ITU-R BS.2076) metadata

// XML 1.0 can't contain most C0 control characters, even escaped: drop them (names can contain anything)
// eslint-disable-next-line no-control-regex
const xmlEsc = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
/** ADM time: hh:mm:ss.fffff */
export function admTime(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s - h * 3600 - m * 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(5).padStart(8, '0')}`;
}
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');
const hex8 = (n) => n.toString(16).toUpperCase().padStart(8, '0');

/**
 * ADM XML for a stereo bed (common-definition FrontLeft/FrontRight) plus mono objects with timed Cartesian positions.
 * objects: [{ name, blocks: [{ start, duration, x, y, z }] }] (seconds). Tracks: 1–2 bed, 3… objects (see admChna).
 */
export function buildAdmXml({ title = 'GreanTeaDawy mix', duration, sampleRate = 48000, bitDepth = 24, objects = [] }) {
  const L = [];
  const end = admTime(duration);
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<ebuCoreMain xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns="urn:ebu:metadata-schema:ebuCore_2016" schema="EBU_CORE_20161220.xsd" xml:lang="en">');
  L.push('<coreMetadata><format><audioFormatExtended version="ITU-R_BS.2076-2">');
  L.push(`<audioProgramme audioProgrammeID="APR_1001" audioProgrammeName="${xmlEsc(title)}" start="00:00:00.00000" end="${end}">`);
  L.push('<audioContentIDRef>ACO_1001</audioContentIDRef>');
  L.push('</audioProgramme>');
  L.push(`<audioContent audioContentID="ACO_1001" audioContentName="${xmlEsc(title)}">`);
  L.push('<audioObjectIDRef>AO_1001</audioObjectIDRef>');
  objects.forEach((_, i) => L.push(`<audioObjectIDRef>AO_${hex4(0x1002 + i)}</audioObjectIDRef>`));
  L.push('</audioContent>');
  // bed: common-definition stereo pack
  L.push(`<audioObject audioObjectID="AO_1001" audioObjectName="Bed" start="00:00:00.00000" duration="${end}">`);
  L.push('<audioPackFormatIDRef>AP_00010002</audioPackFormatIDRef>');
  L.push('<audioTrackUIDRef>ATU_00000001</audioTrackUIDRef>');
  L.push('<audioTrackUIDRef>ATU_00000002</audioTrackUIDRef>');
  L.push('</audioObject>');
  objects.forEach((o, i) => {
    const n = 0x1001 + i;
    L.push(`<audioObject audioObjectID="AO_${hex4(0x1002 + i)}" audioObjectName="${xmlEsc(o.name)}" start="00:00:00.00000" duration="${end}">`);
    L.push(`<audioPackFormatIDRef>AP_0003${hex4(n)}</audioPackFormatIDRef>`);
    L.push(`<audioTrackUIDRef>ATU_${hex8(3 + i)}</audioTrackUIDRef>`);
    L.push('</audioObject>');
  });
  objects.forEach((o, i) => {
    const n = hex4(0x1001 + i);
    const name = xmlEsc(o.name);
    L.push(`<audioPackFormat audioPackFormatID="AP_0003${n}" audioPackFormatName="${name}" typeLabel="0003" typeDefinition="Objects">`);
    L.push(`<audioChannelFormatIDRef>AC_0003${n}</audioChannelFormatIDRef>`);
    L.push('</audioPackFormat>');
    L.push(`<audioChannelFormat audioChannelFormatID="AC_0003${n}" audioChannelFormatName="${name}" typeLabel="0003" typeDefinition="Objects">`);
    const blocks = o.blocks.length ? [...o.blocks] : [{ start: 0, duration, x: 0, y: 1, z: 0, jump: true }];
    // cover the whole programme (the render's tail included): a holding block stretches, a glide gets a hold after it
    const tail = blocks[blocks.length - 1];
    const tailEnd = tail.start + tail.duration;
    if (duration - tailEnd > 0.0005) {
      if (tail.jump) blocks[blocks.length - 1] = { ...tail, duration: duration - tail.start };
      else blocks.push({ ...tail, start: tailEnd, duration: duration - tailEnd, jump: true });
    }
    blocks.forEach((b, j) => {
      L.push(`<audioBlockFormat audioBlockFormatID="AB_0003${n}_${hex8(j + 1)}" rtime="${admTime(b.start)}" duration="${admTime(b.duration)}">`);
      L.push('<cartesian>1</cartesian>');
      L.push(`<position coordinate="X">${r3(b.x)}</position>`);
      L.push(`<position coordinate="Y">${r3(b.y)}</position>`);
      L.push(`<position coordinate="Z">${r3(b.z)}</position>`);
      // jump: at this position for the whole block; otherwise the object glides here from the previous block
      if (b.jump) L.push('<jumpPosition>1</jumpPosition>');
      L.push('</audioBlockFormat>');
    });
    L.push('</audioChannelFormat>');
    L.push(`<audioStreamFormat audioStreamFormatID="AS_0003${n}" audioStreamFormatName="PCM_${name}" formatLabel="0001" formatDefinition="PCM">`);
    L.push(`<audioChannelFormatIDRef>AC_0003${n}</audioChannelFormatIDRef>`);
    L.push(`<audioTrackFormatIDRef>AT_0003${n}_01</audioTrackFormatIDRef>`);
    L.push('</audioStreamFormat>');
    L.push(`<audioTrackFormat audioTrackFormatID="AT_0003${n}_01" audioTrackFormatName="PCM_${name}" formatLabel="0001" formatDefinition="PCM">`);
    L.push(`<audioStreamFormatIDRef>AS_0003${n}</audioStreamFormatIDRef>`);
    L.push('</audioTrackFormat>');
  });
  const uid = (k, track, pack) => `<audioTrackUID UID="ATU_${hex8(k)}" sampleRate="${sampleRate}" bitDepth="${bitDepth}"><audioTrackFormatIDRef>${track}</audioTrackFormatIDRef><audioPackFormatIDRef>${pack}</audioPackFormatIDRef></audioTrackUID>`;
  L.push(uid(1, 'AT_00010001_01', 'AP_00010002'));
  L.push(uid(2, 'AT_00010002_01', 'AP_00010002'));
  objects.forEach((_, i) => { const n = hex4(0x1001 + i); L.push(uid(3 + i, `AT_0003${n}_01`, `AP_0003${n}`)); });
  L.push('</audioFormatExtended></format></coreMetadata>');
  L.push('</ebuCoreMain>');
  return L.join('\n');
}

/** The `chna` chunk body: which audioTrackUID / track format / pack each WAV track carries. */
export function admChna(objectCount) {
  const rows = [[1, 'ATU_00000001', 'AT_00010001_01', 'AP_00010002'], [2, 'ATU_00000002', 'AT_00010002_01', 'AP_00010002']];
  for (let i = 0; i < objectCount; i++) {
    const n = hex4(0x1001 + i);
    rows.push([3 + i, `ATU_${hex8(3 + i)}`, `AT_0003${n}_01`, `AP_0003${n}`]);
  }
  const buf = new Uint8Array(4 + rows.length * 40);
  const v = new DataView(buf.buffer);
  v.setUint16(0, 2 + objectCount, true); // tracks
  v.setUint16(2, rows.length, true); // UIDs
  rows.forEach(([track, atu, at, ap], i) => {
    const o = 4 + i * 40;
    v.setUint16(o, track, true);
    const put = (s, at0) => { for (let k = 0; k < s.length; k++) buf[o + at0 + k] = s.charCodeAt(k); };
    put(atu, 2); put(at, 14); put(ap, 28); // 12 + 14 + 11 chars, then one pad byte
  });
  return buf;
}

/** A minimal Broadcast Wave `bext` chunk (description, originator, date/time, version 1). */
export function bextChunk({ description = '', originator = 'GreanTeaDawy', date = new Date() } = {}) {
  const buf = new Uint8Array(602);
  const put = (s, at, len) => { const t = String(s).slice(0, len); for (let k = 0; k < t.length; k++) buf[at + k] = t.charCodeAt(k) & 0x7f; };
  put(description, 0, 256);
  put(originator, 256, 32);
  put(date.toISOString().slice(0, 10), 320, 10);
  put(date.toISOString().slice(11, 19), 330, 8);
  new DataView(buf.buffer).setUint16(346, 1, true); // version
  return buf;
}

// ------------------------------------------------------------------ deliverables

/** Spatial export formats (rendered in the browser at 48 kHz / 24-bit). */
export const SPATIAL_EXPORTS = {
  binaural: { label: 'Binaural stereo (headphones)', mode: 'binaural', description: 'a stereo WAV that places every object around the listener on headphones (HRTF)' },
  '5.1': { label: '5.1 speakers', mode: 'speakers', layout: '5.1', description: '6-channel WAV: L R C LFE Ls Rs' },
  '7.1': { label: '7.1 speakers', mode: 'speakers', layout: '7.1', description: '8-channel WAV: L R C LFE Lrs Rrs Lss Rss' },
  '7.1.4': { label: '7.1.4 speakers (Atmos-style)', mode: 'speakers', layout: '7.1.4', description: '12-channel WAV: 7.1 + four height speakers' },
  objects: { label: 'Object stems + positions', mode: 'objects', description: 'the stereo bed and one mono WAV per object, plus a JSON file with every object\'s position over time' },
  adm: { label: 'ADM BWF (experimental)', mode: 'objects', description: 'one WAV with the bed and every object as tracks plus ITU-R BS.2076 (ADM) position metadata (axml/chna) for Atmos-capable tools — experimental, not Dolby-certified' }
};
export const SPATIAL_EXPORT_IDS = Object.keys(SPATIAL_EXPORTS);

/**
 * Timed position blocks (seconds) for an object over a render, with ADM (BS.2076) semantics: a block glides from the
 * previous block's position to its own over its duration; `jump: true` = at that position for the whole block.
 * [{ start, duration, x, y, z, jump? }]. Static objects (and pattern renders) are one block.
 */
export function objectBlocks(project, index, { song, ticks, step = 12 }) {
  const secPerTick = 60 / project.bpm / PPQ;
  const lite = positionsOnly(project, index);
  const track = objectPositionTrack(project, index, { from: 0, to: Math.max(step, ticks), step, song });
  const total = r3(Math.max(0.001, ticks * secPerTick));
  const pos = (p) => ({ x: p.x, y: p.y, z: p.z });
  if (track.length === 1) return [{ start: 0, duration: total, ...pos(track[0]), jump: true }];
  // block edges: a 1 ms first block puts the object at its start position, then one glide per track segment
  const EDGE = 0.001;
  const edges = [0, EDGE, ...track.slice(1).map((p) => Math.max(EDGE, r3(p.tick * secPerTick)))];
  const blocks = [{ start: 0, duration: EDGE, ...pos(track[0]), jump: true }];
  for (let i = 1; i < track.length; i++) {
    const start = edges[i];
    const dur = r3(edges[i + 1] - start);
    if (dur <= 0) continue;
    // a cut in the automation is a jump, not a fast glide: two neighbouring samples far apart, and halfway between
    // them the object is already at one end (a fast but smooth move is somewhere in between)
    const a = track[i - 1];
    const b = track[i];
    const far = (p, q) => Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y), Math.abs(p.z - q.z));
    let cut = false;
    if (b.tick - a.tick <= step && far(a, b) > 0.05) {
      const mid = objectPositionAt(lite, index, a.tick + Math.max(1, Math.floor((b.tick - a.tick) / 2)));
      cut = far(mid, a) < 0.01 || far(mid, b) < 0.01;
    }
    blocks.push({ start, duration: dur, ...pos(b), ...(cut && { jump: true }) });
  }
  const last = edges[edges.length - 1];
  if (total - last > 0.0005) blocks.push({ start: last, duration: r3(total - last), ...pos(track[track.length - 1]), jump: true }); // then it stays
  return blocks;
}
