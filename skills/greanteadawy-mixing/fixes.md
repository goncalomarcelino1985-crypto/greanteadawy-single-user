# render_mix report → fix

| Report says | Likely cause | Fix |
|-------------|--------------|-----|
| `INVALID RENDER: … NaN/Infinity samples` | an extreme effect/instrument setting (feedback, resonance, drive) or a broken plugin | undo the last sound change; check recently edited params with `get_project`; for plugins, `update_effect enabled=false` and re-render |
| `CLIPPING` / `Peaks hit 0 dBFS` | no limiter, or ceiling at 0 | add/lower the master limiter ceiling (−1 dB), keep the master fader at 0 dB |
| `True peak … above … dBTP` | inter-sample peaks after the limiter | lower the limiter `ceiling` by the amount the report gives |
| `Target …: +X dB` | mix too quiet/loud for the target | `update_effect insert=0 effectId=<limiter> params={"gain": current + X}` (the report computes the value) |
| `The master limiter is squashing up to N dB` | balance problem pushed into the limiter | lower the limiter gain; reduce the loudest stem; parallel-compress the drum bus |
| `low end (<150 Hz) is wide` | chorus/stereo/wide synth on bass or pads | `stereo {"monoBelow":120}` on bass/808/pad inserts; remove wideners from bass |
| `"A" and "B" peak at nearly the same low frequency` | kick and 808/bass masking | `analyze_sound` both; retune the kick (`tune`) ≥ 2 semitones away; `pump source=Kick` on the bass |
| `Bass-heavy` | 808/bass too loud or non-bass parts not high-passed | bass stem −1…−3 dB; eq hpf on everything else |
| `Muddy low-mids` | pads/keys/guitars stacking at 250–500 Hz | eq mid −2…−4 dB at 300 Hz on 1–2 of them; thinner voicings (`voicing shell`) |
| `Dull top end` | dark sounds, low-passed hats | brighter hat preset (Crisp), eq high shelf +2 dB on hats/master |
| `Bright/harsh` | hats/cymbals/supersaws too loud | hats −2 dB, eq high −3 dB at 6–8 kHz, softer hat velocities |
| `Low crest factor` | over-compression/limiting | back off limiter gain and bus compressors |
| `Loudness range is only … LU` / `Little loudness contrast between sections` | every section has every part | arrangement: drop elements in verses/breakdowns, add a dropout fill before the hook |
| `Low stereo correlation` | phase-y wideners | reduce `stereo width`, chorus depth; check mono |
| `Nearly mono mix` | everything centered | pan hats/percs/doubles, chorus on pads (not bass) |
| `Quiet overall` | limiter gain too low | follow the Target line |
| A stem at ≤ −60 LUFS | channel muted, wrong routing, plugin missing/disabled, notes outside the rendered range | `get_project` (mute/solo/routing), `list_plugins`, `get_pattern` |

After each fix: `render_mix` again and compare the same numbers. Two or three rounds is normal.
