// Runs PowerShell safely: no quoting problems (base64 -EncodedCommand), UTF-8 out, hard timeout.
import { execFile, execFileSync, spawn } from 'node:child_process';

const IS_WIN = process.platform === 'win32';

const PRELUDE = [
  '$ProgressPreference = "SilentlyContinue"',
  '$ErrorActionPreference = "Continue"',
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
  '$OutputEncoding = [System.Text.Encoding]::UTF8'
].join('; ');

export function powershellPath() {
  if (!IS_WIN) return 'pwsh';
  return 'powershell.exe';
}

/**
 * Run a PowerShell script and return { stdout, stderr, code, ms }.
 */
export function runPowerShell(script, { timeout = 25000, cwd } = {}) {
  if (!IS_WIN && !hasPwsh()) {
    return Promise.resolve({
      stdout: '',
      stderr: 'PowerShell is not available on this OS. FRIDAY PC control is Windows-first.',
      code: 127,
      ms: 0
    });
  }
  const full = `${PRELUDE}; ${script}`;
  const encoded = Buffer.from(full, 'utf16le').toString('base64');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
  const started = Date.now();

  return new Promise((resolve) => {
    execFile(
      powershellPath(),
      args,
      { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, cwd, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({
          stdout: (stdout || '').trim(),
          stderr: (stderr || (err && err.killed ? `Command timed out after ${timeout}ms` : '') || (err ? err.message : '')).trim(),
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          ms: Date.now() - started
        });
      }
    );
  });
}

/** Fire-and-forget launch (windows, apps) - detached so it survives. */
export function launchDetached(file, args = []) {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return child.pid;
}

let pwshChecked = false;
let pwshAvailable = false;
function hasPwsh() {
  if (pwshChecked) return pwshAvailable;
  pwshChecked = true;
  try {
    execFileSyncSafe('pwsh', ['-NoProfile', '-Command', 'exit 0']);
    pwshAvailable = true;
  } catch {
    pwshAvailable = false;
  }
  return pwshAvailable;
}

function execFileSyncSafe(cmd, args) {
  return execFileSync(cmd, args, { stdio: 'ignore', timeout: 4000 });
}

/** Parse JSON printed by PowerShell without exploding on warnings. */
export function parseJsonLoose(text) {
  if (!text) return null;
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  const slice = text.slice(start);
  try {
    return JSON.parse(slice);
  } catch {
    // sometimes PowerShell prefixes a warning line; try line by line
    for (const line of slice.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          return JSON.parse(t);
        } catch {}
      }
    }
    return null;
  }
}
