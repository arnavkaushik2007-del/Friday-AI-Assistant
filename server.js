// FRIDAY - start here:  node server.js
import { spawn } from 'node:child_process';
import { loadConfig, lanAddresses } from './src/config.js';
import { makeLlm, makeHybridLlm } from './src/llm.js';
import { makeCloudLlm } from './src/cloud.js';
import { makeServer } from './src/app.js';
import { ensureOllama, runtimeState } from './src/runtime.js';

const args = process.argv.slice(2);
const cfg = loadConfig();

if (args.includes('--port')) cfg.port = Number(args[args.indexOf('--port') + 1]) || cfg.port;
if (args.includes('--model')) cfg.model = args[args.indexOf('--model') + 1] || cfg.model;

// local brain always exists; the cloud one is used only when you gave it a free key
const cloud = makeCloudLlm(cfg);
const llm = makeHybridLlm({ cfg, local: makeLlm(cfg), cloud });
let stopServer = () => {};
const { server, brain } = makeServer({ cfg, llm, cloud, onQuit: () => stopServer() });
stopServer = () => {
  try {
    server.close();
  } catch {
    /* already closing */
  }
};

server.listen(cfg.port, cfg.host, () => {
  const local = `http://localhost:${cfg.port}/?t=${cfg.token}`;
  const lan = lanAddresses().map((a) => `http://${a.address}:${cfg.port}/?t=${cfg.token}`);
  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  console.log('  F R I D A Y   ·   online');
  console.log(line);
  console.log(`  This PC      ${local}`);
  for (const url of lan) console.log(`  Phone/wifi   ${url}`);
  console.log(`  Model        ${cfg.model}  (${cfg.ollamaUrl})`);
  if (!runtimeState().portable) console.log('  Brain        not installed yet — open the app, she will offer a one-click download');
  console.log(`  Allowed in   ${cfg.allowAllPaths ? 'whole disk (allowAllPaths=true)' : cfg.allowRoots.join(', ')}`);
  console.log(`${line}`);
  console.log('  App window   Start FRIDAY.bat   (settings: start with Windows, always listening)');
  console.log('  iPhone mic note: Safari needs HTTPS for the microphone.');
  console.log('  Run  npm run phone  to get a free https link you can open on your phone.');
  console.log(`${line}\n`);

  if (!args.includes('--no-open')) {
    // open the browser once the brain is awake, so the first reply is instant
    setTimeout(openBrowser, 250);
  }

  function openBrowser() {
    const url = `http://localhost:${cfg.port}/?t=${cfg.token}`;
    try {
      if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      /* opening a browser is optional */
    }
  }

  // bring the local brain up in the background (bundled portable build)
  ensureOllama(cfg).then(async (res) => {
    if (!res.ok) {
      console.log(`[friday] brain cold: ${res.reason || 'not running'}`);
      return;
    }
    console.log(res.started ? '[friday] brain started' : '[friday] brain already running');
    // load the weights and prime the prompt cache while you are still reading the screen
    const warm = await brain.warmUp();
    if (warm) console.log('[friday] brain warmed up');
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${cfg.port} is already in use. Close the other FRIDAY window, or run:  node server.js --port 4174\n`);
    process.exit(1);
  }
  console.error('[friday] server error:', err);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n[friday] shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
