#!/usr/bin/env node
// Reset a user's password from the command line (e.g. a forgotten admin password). Also re-enables the account,
// ends its sessions and revokes its API token. The server must be stopped: it keeps its own copy of the accounts.
//   npm run reset-password -- <username>            (prompts for the new password)
//   NEW_PASSWORD=... npm run reset-password -- <username>
import readline from 'node:readline';
import { loadConfig, loadDotEnv } from '../config.js';
import { UserStore } from '../auth/users.js';
import { SessionStore } from '../auth/sessions.js';
import { runningServer } from '../lockfile.js';

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); }; // don't echo the password
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  loadDotEnv();
  const username = process.argv[2];
  if (!username) {
    console.error('Usage: npm run reset-password -- <username>');
    process.exit(2);
  }
  const { dataDir, sessionTtlDays } = loadConfig();
  const running = await runningServer(dataDir);
  if (running) {
    console.error(`The server is running (pid ${running.pid}) on this data directory. Stop it first, then run this again.`);
    console.error(`(If no server is running, delete ${running.file}.)`);
    process.exit(1);
  }
  const users = await new UserStore(dataDir).init();
  const user = users.findByUsername(username);
  if (!user) {
    console.error(`No user "${username}" in ${dataDir}. Users: ${users.list().map((u) => u.username).join(', ') || 'none'}`);
    process.exit(1);
  }
  const wasDisabled = user.disabled;
  const password = process.env.NEW_PASSWORD || (await ask('New password (8+ characters): '));
  await users.setPassword(user.id, password);
  if (wasDisabled) await users.update(user.id, { disabled: false });
  if (user.apiToken) await users.revokeToken(user.id);
  const sessions = await new SessionStore(dataDir, { ttlDays: sessionTtlDays }).init();
  sessions.destroyForUser(user.id);
  await sessions.flush();
  console.log(`Password for "${user.username}" (${user.role}) was reset${wasDisabled ? ' and the account re-enabled' : ''}. Sign-ins were ended and the API token (if any) revoked.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
