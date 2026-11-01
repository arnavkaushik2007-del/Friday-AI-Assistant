// Gives your iPhone an https link to FRIDAY.
// iPhone Safari only allows the microphone on https, so plain http://192.168.x.x will not
// let you talk to her. This starts a free Cloudflare quick tunnel (no account, no signup)
// and prints a link with your access token already inside it.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, ROOT } from '../src/config.js';

const cfg = loadConfig();
const PORT = cfg.port;
const LOCAL = `http://127.0.0.1:${PORT}`;
const BIN_DIR = path.join(ROOT, 'tools', 'bin');
const EXE = process.platform === 'win32' ? path.join(BIN_DIR, 'cloudflared.exe') : path.join(BIN_DIR, 'cloudflared');
const DOWNLOAD =
  process.platform === 'win32'
    ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    : process.platform === 'darwin'
      ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz'
      : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';

const children = [];
let serverChild = null;

function log(msg) {
  console.log(msg);
}

async function serverAlive() {
  try {
    const res = await fetch(`${LOCAL}/api/health`, {
      headers: { 'x-friday-token': cfg.token },
      signal: AbortSignal.timeout(1500)
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await serverAlive()) return;
  log('• FRIDAY is not running — starting it…');
  serverChild = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--no-open'], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true
  });
  children.push(serverChild);
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    if (await serverAlive()) {
      log('• server is up');
      return;
    }
  }
  throw new Error('server did not start — run "npm start" in another window and try again');
}

function haveCloudflared() {
  if (fs.existsSync(EXE)) return true;
  return false;
}

async function downloadCloudflared() {
  if (process.platform !== 'win32') {
    throw new Error('cloudflared is not installed. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });
  log('• first run: downloading cloudflared (~40 MB, one time)…');
  const res = await fetch(DOWNLOAD, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(EXE, buf);
  log('• saved tools/bin/cloudflared.exe');
}

function startCloudflared() {
  return new Promise((resolve, reject) => {
    const child = spawn(EXE, ['tunnel', '--no-autoupdate', '--url', LOCAL], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(child);

    let found = false;
    let buffer = '';
    const timer = setTimeout(() => {
      if (!found) {
        child.kill();
        reject(new Error('tunnel did not return a link in time'));
      }
    }, 45000);

    const scan = (chunk) => {
      buffer += chunk.toString();
      const matches = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
      if (matches && matches.length) {
        const base = matches[matches.length - 1];
        if (!found) {
          found = true;
          clearTimeout(timer);
          resolve(base);
        }
      }
      if (buffer.length > 20000) buffer = buffer.slice(-4000);
    };

    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (!found) {
        clearTimeout(timer);
        reject(new Error(`cloudflared exited (${code})`));
      }
    });
  });
}

async function tryLocalhostRun() {
  // Zero-install fallback: localhost.run over ssh (free, no account).
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-R', `80:127.0.0.1:${PORT}`, 'nokey@localhost.run'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(child);
    let found = false;
    let buffer = '';
    const timer = setTimeout(() => {
      if (!found) {
        child.kill();
        reject(new Error('localhost.run did not respond'));
      }
    }, 30000);
    const scan = (chunk) => {
      buffer += chunk.toString();
      const m = buffer.match(/https:\/\/[a-z0-9-]+\.(?:lhr\.life|localhost\.run)/i);
      if (m && !found) {
        found = true;
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function banner(url) {
  const link = `${url}/?t=${cfg.token}`;
  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  console.log('  FRIDAY · phone link ready');
  console.log(line);
  console.log(`  ${link}`);
  console.log(line);
  console.log('  Open that on your iPhone (same wifi or mobile data).');
  console.log('  Then: Share → Add to Home Screen. Microphone works on https.');
  console.log('  Keep this window open. Ctrl+C stops the link.');
  console.log(`${line}\n`);
}

function cleanup() {
  for (const c of children) {
    try {
      c.kill();
    } catch {}
  }
}

process.on('SIGINT', () => {
  console.log('\n• closing phone link');
  cleanup();
  process.exit(0);
});
process.on('exit', cleanup);

(async () => {
  try {
    await ensureServer();
  } catch (err) {
    console.error(`\n✖ ${err.message}\n`);
    process.exit(1);
  }

  let baseUrl = null;

  try {
    if (!haveCloudflared()) await downloadCloudflared();
    log('• opening a free https tunnel…');
    baseUrl = await startCloudflared();
  } catch (err) {
    log(`• cloudflared route failed: ${err.message}`);
    try {
      log('• trying the no-install route (ssh localhost.run)…');
      baseUrl = await tryLocalhostRun();
    } catch (err2) {
      console.error(`\n✖ Could not create an https link: ${err2.message}`);
      console.error('  You can still use FRIDAY on this PC, and on the phone over plain http');
      console.error('  (typing only, no microphone).\n');
      cleanup();
      process.exit(1);
    }
  }

  banner(baseUrl);
  setInterval(() => {}, 1 << 30);
})();
