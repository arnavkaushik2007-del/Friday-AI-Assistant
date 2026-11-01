// "Start with Windows": one shortcut in the Startup folder, no installer, no admin rights.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

function startupShortcut() {
  const appData = process.env.APPDATA || '';
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'FRIDAY.lnk');
}

function shortcutTarget() {
  return path.join(ROOT, 'scripts', 'app.ps1');
}

export function autostartEnabled() {
  if (process.platform !== 'win32') return false;
  try {
    return fs.existsSync(startupShortcut());
  } catch {
    return false;
  }
}

export function setAutostart(enabled) {
  if (process.platform !== 'win32') return { ok: false, reason: 'Windows only.' };
  const lnk = startupShortcut();
  const ps = path.dirname(path.dirname(lnk));
  const script = enabled
    ? [
        `$dir='${ps}'`,
        'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
        '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:FRIDAY_LNK)',
        "$s.TargetPath='powershell.exe'",
        "$s.Arguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"' + $env:FRIDAY_TARGET + '\"'",
        `$s.WorkingDirectory='${ROOT}'`,
        '$s.Description="FRIDAY - your local assistant"',
        '$s.Save()',
        'Write-Output "ok"'
      ].join('; ')
    : `Remove-Item -LiteralPath $env:FRIDAY_LNK -Force -ErrorAction SilentlyContinue; Write-Output "ok"`;

  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      timeout: 20000,
      env: { ...process.env, FRIDAY_LNK: lnk, FRIDAY_TARGET: shortcutTarget() }
    });
    return { ok: true, enabled: autostartEnabled(), path: lnk };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
