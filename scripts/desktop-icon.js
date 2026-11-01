// Makes the FRIDAY icon and puts a shortcut on the Desktop.
// Run once (npm run shortcut); safe to run again any time.
//
// The icon is drawn here pixel by pixel (4x supersampled) so the project needs no
// image tools, then packed into a multi-size .ico - Windows picks 16px for the
// desktop label and 256px for the large view.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const assetsDir = path.join(root, 'assets');
const icoPath = path.join(assetsDir, 'friday.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG_TOP = hex('#0a141f');
const BG_BOTTOM = hex('#123043');
const RIM = hex('#2f6d88');
const GLOW = hex('#38e2f5');
const MARK = hex('#eafdff');

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Rounded-square coverage: 1 inside, 0 outside, 1px-ish soft edge. */
function roundedBox(u, v, inset, radius) {
  const lo = inset;
  const hi = 1 - inset;
  if (u < lo || u > hi || v < lo || v > hi) return 0;
  const cx = Math.min(Math.max(u, lo + radius), hi - radius);
  const cy = Math.min(Math.max(v, lo + radius), hi - radius);
  const dx = u - cx;
  const dy = v - cy;
  return Math.hypot(dx, dy) <= radius ? 1 : 0;
}

/** One sample of the finished icon at unit coordinates. */
function sample(u, v) {
  if (!roundedBox(u, v, 0.02, 0.2)) return [0, 0, 0, 0];

  // vertical gradient body
  const t = Math.min(1, Math.max(0, (v - 0.02) / 0.96));
  let rgb = mix(BG_TOP, BG_BOTTOM, t);

  // cyan halo behind the mark
  const dist = Math.hypot(u - 0.5, v - 0.5);
  const glow = Math.max(0, 0.4 - dist * 0.55);
  if (glow > 0) rgb = mix(rgb, GLOW, glow * 0.5);

  // rim light along the edge
  const edge = Math.min(u - 0.02, v - 0.02, 0.98 - u, 0.98 - v);
  if (edge >= 0 && edge < 0.018) rgb = mix(rgb, RIM, 0.85);

  // the "F" - three solid bars, geometric so it stays sharp at 16px
  const bars = [
    [0.35, 0.25, 0.455, 0.775], // stem
    [0.35, 0.25, 0.68, 0.345], // top bar
    [0.35, 0.455, 0.615, 0.55] // middle bar
  ];
  for (const [x0, y0, x1, y1] of bars) {
    if (u >= x0 && u <= x1 && v >= y0 && v <= y1) {
      rgb = MARK;
      break;
    }
  }

  return [rgb[0], rgb[1], rgb[2], 255];
}

function drawRGBA(size) {
  const SS = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const [sr, sg, sb, sa] = sample(u, v);
          const w = sa / 255;
          r += sr * w;
          g += sg * w;
          b += sb * w;
          a += sa;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const weight = Math.max(1e-6, alpha / 255);
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n / weight);
      out[o + 1] = Math.round(g / n / weight);
      out[o + 2] = Math.round(b / n / weight);
      out[o + 3] = Math.round(alpha);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* ICO packing (32-bit DIB per size - the format Windows always reads) */
/* ------------------------------------------------------------------ */

function dibPayload(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // header size
  header.writeInt32LE(size, 4); // width
  header.writeInt32LE(size * 2, 8); // height (image + mask)
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bits per pixel
  header.writeUInt32LE(size * size * 4, 20); // image size

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4; // bottom-up
    rgba.copy(pixels, y * size * 4, srcRow, srcRow + size * 4);
  }
  // BGRA order, and the AND mask is all zeros (the alpha channel does the work)
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    pixels[i] = pixels[i + 2];
    pixels[i + 2] = r;
  }
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);
  return Buffer.concat([header, pixels, mask]);
}

function buildIco() {
  const images = SIZES.map((size) => dibPayload(size, drawRGBA(size)));
  const dir = Buffer.alloc(6 + SIZES.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(SIZES.length, 4);

  let offset = dir.length;
  SIZES.forEach((size, i) => {
    const at = 6 + i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, at + 0);
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1);
    dir.writeUInt8(0, at + 2);
    dir.writeUInt8(0, at + 3);
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(images[i].length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += images[i].length;
  });

  return Buffer.concat([dir, ...images]);
}

/* ------------------------------------------------------------------ */
/* Shortcut                                                            */
/* ------------------------------------------------------------------ */

function makeShortcut() {
  const script = `
    $desktop = [Environment]::GetFolderPath('Desktop')
    $lnk = Join-Path $desktop 'FRIDAY.lnk'
    $ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    $ws = New-Object -ComObject WScript.Shell
    $sc = $ws.CreateShortcut($lnk)
    $sc.TargetPath = $ps
    $sc.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${path.join(root, 'scripts', 'app.ps1')}"'
    $sc.WorkingDirectory = '${root.replace(/'/g, "''")}'
    $sc.IconLocation = '${icoPath.replace(/'/g, "''")},0'
    $sc.Description = 'FRIDAY - your assistant'
    $sc.WindowStyle = 7
    $sc.Save()

    $check = $ws.CreateShortcut($lnk)
    @{
      path = $lnk
      exists = (Test-Path $lnk)
      target = $check.TargetPath
      icon = $check.IconLocation
      workdir = $check.WorkingDirectory
    } | ConvertTo-Json -Compress`;

  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    timeout: 30000
  }).trim();
  const start = out.search(/[[{]/);
  return JSON.parse(out.slice(start));
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

fs.mkdirSync(assetsDir, { recursive: true });
const ico = buildIco();
fs.writeFileSync(icoPath, ico);
console.log(`icon      ${icoPath} (${(ico.length / 1024).toFixed(1)} KB, ${SIZES.length} sizes)`);

try {
  const info = makeShortcut();
  console.log(`shortcut  ${info.path}`);
  console.log(`          ${info.exists ? 'created' : 'MISSING'} · icon ${info.icon}`);
  console.log(`          -> ${info.target}`);
} catch (err) {
  console.error(`shortcut failed: ${err.message}`);
  process.exit(1);
}
