// <DATA_DIR>/server.lock marks a running server (pid + port), so maintenance commands don't edit data under it.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const lockPath = (dataDir) => path.join(dataDir, 'server.lock');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Does anything accept connections on host:port? A refused connection proves the lock is stale; on a timeout we
 *  assume a (busy) server, which is the safe answer for maintenance commands. */
function listening(host, port, timeoutMs = 1500) {
  const target = !host || host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return new Promise((resolve) => {
    const socket = net.connect({ host: target, port });
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs, () => done(true));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** { pid, port, host, file } of a live server using dataDir, or null. Stale lock files — dead pid, or a reused pid
 *  with nothing listening on the recorded port — are ignored. */
export async function runningServer(dataDir) {
  const file = lockPath(dataDir);
  let info;
  try {
    info = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return null;
  }
  if (!Number.isInteger(info?.pid) || info.pid === process.pid || !alive(info.pid)) return null;
  if (Number.isInteger(info.port) && !(await listening(info.host, info.port))) return null;
  return { ...info, file };
}

/** Write the lock; returns a function that removes it (also called on process exit). */
export function writeLock(dataDir, port, host) {
  const file = lockPath(dataDir);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port, host, startedAt: new Date().toISOString() }));
  const remove = () => {
    try {
      const info = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (info.pid === process.pid) fs.rmSync(file, { force: true });
    } catch { /* already gone */ }
  };
  process.once('exit', remove);
  return remove;
}
