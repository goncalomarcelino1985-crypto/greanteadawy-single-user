# GreanTeaDawy plugins

Example plugins and the place your own can live while you work on them. The full guide — manifest, DSP and generator
APIs, permissions, packaging, the sandbox — is [docs/plugins.md](../docs/plugins.md).

| Folder | Type | What it shows |
|--------|------|---------------|
| [`examples/chiptune`](examples/chiptune) | instrument (DSP) | band-limited pulse voice, envelope, release, select/bool params, presets |
| [`examples/kalimba`](examples/kalimba) | instrument (samples) | key zones mapped to WAVs, no code (`make-samples.mjs` made the samples) |
| [`examples/tape-wobble`](examples/tape-wobble) | effect | modulated delay line, saturation, automatable params |
| [`examples/euclid`](examples/euclid) | generator | Euclidean rhythms, seeded `random()` |
| [`examples/counter-melody`](examples/counter-melody) | generator | `project-read`: harmonizes another channel's melody in the project's scale |

```bash
npm run plugin:pack -- --examples          # → plugins/dist/<id>-<version>.zip for every example
npm run plugin:pack -- plugins/my-plugin   # validate + pack your own folder
```

Install a zip in the studio: **Settings → Plugins → Install plugin…**, review what it asks for, confirm you trust the
author. Only install plugins from people you trust — see [Security](../docs/plugins.md#security).

All examples are MIT-licensed like the rest of GreanTeaDawy: copy them as a starting point.
