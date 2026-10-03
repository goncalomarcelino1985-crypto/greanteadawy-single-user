// MCP prompts: ready-made workflows the user can pick in their MCP client.
import { z } from 'zod';

const msg = (text) => ({ messages: [{ role: 'user', content: { type: 'text', text } }] });

export function registerPrompts({ server }) {
  server.registerPrompt('make_beat', {
    title: 'Make a beat',
    description: 'Have Claude produce a complete, arranged and mixed track in GreanTeaDawy',
    argsSchema: {
      genre: z.string().describe('e.g. trap, house, lo-fi, drill, boom bap, techno, afrobeats, synthwave'),
      mood: z.string().optional().describe('e.g. dark, uplifting, chill'),
      bpm: z.string().optional(),
      reference: z.string().optional().describe('Artists/tracks to take inspiration from (style, not copying)')
    }
  }, ({ genre, mood, bpm, reference }) => msg(`Produce a ${mood ? `${mood} ` : ''}${genre} track in GreanTeaDawy${bpm ? ` at ${bpm} BPM` : ''}${reference ? `, inspired by the style of ${reference} (no copying of melodies)` : ''}.
1. create_project (template "empty") with a fitting name, tempo, key and scale. Check list_samples for anything of the user's you could use.
2. add_channel for drums (kick, snare/clap, closed + open hats in one choke group, percussion) and musical parts (bass/808, chords, lead, pads, fx). Choose presets and shape params to suit the genre.
3. Write parts in separate patterns ("Drums", "Bass", "Chords", "Melody", "Counter", "FX"...). Use write_drums, add_chords (roman numerals in the key are fine; pick a voicing that suits the genre), add_bassline (a degree line with slides for 808s), write_melody / add_notes and add_roll. Give the hook a memorable motif and vary it; use velocity (accents, soft off-beats, ghost notes).
4. apply_groove with the genre's feel; analyze_sound the kick and 808/bass and tune them to the key and apart from each other.
5. add_fill for section ends, then arrange_song into intro / verse / pre / hook / break / outro (at least 48 bars) with clear energy changes; add_transition into hooks/drops (riser, snare_build, impact, reverse_swell) and automation for filter sweeps.
6. Mix by the numbers in the guide: gain staging, high-passes, kick-triggered sidechain (pump source=Kick) on bass/pads where the genre wants it, a shared reverb/delay via sends, master limiter last with a -1 dB ceiling.
7. save_version "first draft", then render_mix target=<fitting target> (stems on), read the numbers, fix balance, masking, loudness and dynamics, and render again until the report is clean.
8. play the song and explain the arrangement and mix choices.`));

  server.registerPrompt('mix_review', {
    title: 'Mix review',
    description: 'Have Claude analyse the current mix with render_mix and improve it like a mixing engineer',
    argsSchema: { target: z.string().optional().describe('e.g. "streaming (-14 LUFS)", "club", "warm and dusty"') }
  }, ({ target }) => msg(`Review and improve the mix of the active GreanTeaDawy project${target ? ` for ${target}` : ''}.
1. get_project to understand the arrangement, then save_version "before mix review".
2. render_mix with stems and a target that fits${target ? ` "${target}"` : ''}. Read loudness (LUFS, loudness range), sample and true peak, limiter gain reduction, crest factor, spectral balance, low-end note and width, section loudness and each stem's level and low peak.
3. Fix the biggest problems first: kick/bass balance and masking (analyze_sound, tuning, pump source=Kick), muddy low-mids, harsh highs, a wide low end (stereo monoBelow), vocals/lead not sitting on top, flat dynamics between sections, true-peak overs.
   Use set_mixer, update_channel, add_effect/update_effect (eq hpf/lpf, compressor incl. parallel mix, reverb/delay sends, pump, stereo, limiter) and automation.
4. Set the master limiter input gain from the report's target delta, render_mix again and report before/after numbers and what you changed.`));

  server.registerPrompt('spatial_mix', {
    title: 'Spatial (Atmos-style) mix',
    description: 'Have Claude turn the current song into an immersive 3D mix and export it for headphones and speakers',
    argsSchema: { deliver: z.string().optional().describe('e.g. "binaural and 7.1.4", "ADM for my Atmos session"') }
  }, ({ deliver }) => msg(`Make an immersive spatial (Dolby Atmos-style) version of the active GreanTeaDawy project${deliver ? ` and deliver ${deliver}` : ''}.
1. get_project, save_version "before spatial mix". Make sure every part you want to place has its own mixer insert routed to the master.
2. Keep kick, bass/808, the lead and the core drums in the bed (or front centre). place_object the rest: pads/strings wide or overhead, guitars/keys wide left/right, percussion, FX and ear candy around and behind. Leave reverb buses in the bed.
3. Add one or two moves on transitions with move_object (e.g. a riser that rises, a sweep that circles, an FX fly-over) — sparingly.
4. set_spatial monitor=binaural so the user can listen on headphones; play the song.
5. export_spatial ${deliver ? `for: ${deliver}` : 'binaural and 7.1.4'} and check the channel peaks in the report (objects skip the master limiter: lower hot objects and export again).
6. Explain the placement choices and list the exported files.`));

  server.registerPrompt('use_my_samples', {
    title: 'Build around my samples',
    description: "Have Claude inspect the user's uploaded samples (bitrate, tempo, key, pitch) and build a track around them",
    argsSchema: { idea: z.string().optional().describe('What to make with them') }
  }, ({ idea }) => msg(`Look at my uploaded and recorded samples (list_samples — they are grouped by folder; then get_sample_info on the interesting ones: check sample rate/bitrate quality, tempo, key, pitch and what each sound is).
Build a track around them${idea ? `: ${idea}` : ''}. Set the project tempo/key to fit the loops (or add_audio_clip fit="repitch"), load one-shots into sampler channels (root key comes from the detected pitch), place loops/vocals as audio clips with gain and fades, and complement them with GreanTeaDawy's own instruments. If a vocal or solo take needs it, clean it up with edit_sample (trim_silence, pitch_correct in the project's key, normalize) as a new sample — never replace the original unless I ask. Finish with render_mix and play.`));
}
