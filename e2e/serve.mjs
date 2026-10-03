// Starts a throwaway GreanTeaDawy server (fresh data dir) for the Playwright end-to-end tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/src/index.js';
import { loadConfig } from '../server/src/config.js';

const port = Number(process.env.E2E_PORT || 3199);
const dataDir = path.join(os.tmpdir(), `greanteadawy-e2e-${port}`);
fs.rmSync(dataDir, { recursive: true, force: true });

const { server } = await createServer({ ...loadConfig({ ...process.env, HOST: '127.0.0.1', PORT: String(port) }), dataDir });
server.listen(port, '127.0.0.1', () => console.log(`e2e server on http://127.0.0.1:${port} (data: ${dataDir})`));

const stop = () => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
