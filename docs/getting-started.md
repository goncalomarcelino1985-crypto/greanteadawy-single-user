# Getting started

## Requirements

- **Node.js 20.19+** (22 LTS recommended) and npm
- A modern desktop browser (Chrome, Edge, Firefox or Safari). Phones work too, with a simplified tab layout.
- Optional: [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) or Claude Desktop to make music with Claude.
- Optional: **ffmpeg** on the server for MP3/AAC/Ogg/Opus/FLAC/ALAC/AIFF exports (`apt install ffmpeg`,
  `brew install ffmpeg`, `winget install ffmpeg`). WAV export never needs it.

Prefer containers? `docker compose up -d --build` runs everything (ffmpeg included) — see [Docker](docker.md).

## Install & run

```bash
git clone <your fork or the release zip> greanteadawy
cd greanteadawy
npm install
npm run build      # builds the web UI into client/dist
npm start          # http://127.0.0.1:3001
```

For development with hot reload use `npm run dev` and open **http://localhost:5173** (Vite proxies `/api`, `/mcp` and
`/ws` to the server on port 3001).

Data (projects, versions, samples, exports, accounts) is stored in `./data` — change it with `DATA_DIR`. See
[deployment](deployment.md) for all settings.

## First run: create the admin account

![First-run setup](screenshots/setup.png)

The first visit shows **Create the admin account**. The admin manages users, sign-up and MCP access; every account's
projects and samples are private to that account.

- In a browser on the same computer as the server, no code is needed.
- From any other computer — or through a reverse proxy / tunnel, or when `TRUST_PROXY` / a public `PUBLIC_URL` is
  set — the form also asks for a **setup code**. It is printed in the server log at startup (or set your own with
  `SETUP_CODE`), so nobody else can claim the admin account of a freshly deployed server.

Every new account starts with a playable **Welcome Trap Beat** project. Click anywhere once to enable audio (browsers
require a gesture), then press **Space**.

## Make a beat by hand (2 minutes)

1. **Channel rack** (F6): click steps to program the kick, clap and hats. Right-click erases.
2. **Piano roll** (F7): select a melodic channel, draw notes, drag to move, drag the right edge to resize.
3. **Playlist** (F5): pick a pattern in the toolbar and paint it into the arrangement; switch to **SONG** mode.
4. **Mixer** (F9): balance the inserts, add effects (EQ, compressor, reverb, delay, pump, limiter…).
5. **File menu → Export** to WAV or MIDI, or save a **version** before big changes.

The [user guide](user-guide.md) covers everything in detail.

## Make a beat with Claude

1. Open **Settings → API & MCP** (gear icon or the avatar menu).
2. Optionally generate a personal **API token** (recommended; required when MCP is used over a network).
3. Copy the command for Claude Code, e.g.

   ```bash
   claude mcp add --transport http greanteadawy http://localhost:3001/mcp \
     --header "Authorization: Bearer gtd_…"
   ```

4. Keep the studio open in the browser and ask: *"Make a dark trap beat at 145 BPM with a sliding 808, arrange it into
   intro/hook/verse, mix it to about −14 LUFS and play it."* You'll watch Claude's edits appear live.

Details, Claude Desktop setup and tips: [Making music with Claude](claude-mcp.md).

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| No sound | Click once in the page (audio unlock banner). Check the master fader and that the channel/insert isn't muted. |
| "Can't reach the server" | Is `npm start` / `npm run dev` running? Is the port free? |
| Claude says "No studio is open in a browser" | `render_mix`, `play` and analysing MP3s need the studio open (and signed in to the same account). |
| Claude gets 401 from `/mcp` | Generate a token in Settings → API & MCP and pass it as a Bearer header (or `?token=`). Token-less MCP only works from the same computer when the admin allows it. |
| Forgot a password | Admins can set a new password for any user in **Settings → Users**. For the admin itself: stop the server and run `npm run reset-password -- <username>`. |
