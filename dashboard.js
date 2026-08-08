#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const APP_NAME = 'Ruusian Retro Emulator';
const REPO_ROOT = __dirname;
const SERVER_SCRIPT = path.join(REPO_ROOT, 'src', 'server.js');
const STATE_FILE = path.join(REPO_ROOT, '.dashboard-state.json');
const LOG_FILE = path.join(REPO_ROOT, 'logs', 'server.log');
const DEFAULT_PORT = 3000;
const isTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);

const COLORS = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};
function c(code, str) { return isTTY ? COLORS[code] + str + COLORS.reset : str; }

let state = null;
function loadState() {
  if (state) return state;
  state = { port: DEFAULT_PORT, pid: null };
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port < 65536) state.port = parsed.port;
    if (Number.isInteger(parsed.pid)) state.pid = parsed.pid;
  } catch (e) { /* no state yet */ }
  return state;
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { /* ignore */ }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function url(port, p) { return `http://localhost:${port}${p}`; }

async function fetchJson(endpoint, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  try {
    const res = await fetch(endpoint, Object.assign({ signal: ctrl.signal }, opts || {}));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally { clearTimeout(timer); }
}

async function health(port) {
  try {
    const r = await fetchJson(url(port, '/health'), {}, 4000);
    return r.ok ? r.json : null;
  } catch (e) { return null; }
}

function ensureLogDir() { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); }

async function startServer(verbose) {
  const port = state.port;
  const up = await health(port);
  if (up) {
    if (verbose) console.log(c('yellow', `⚠  Server already running on port ${port}.`));
    return false;
  }
  ensureLogDir();
  const fd = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(fd, `\n${new Date().toISOString()} [dashboard] starting server on port ${port}\n`);
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    cwd: REPO_ROOT,
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  child.on('exit', (code, signal) => {
    if (state.pid === child.pid) state.pid = null;
    if (verbose) console.log(c('dim', `server process exited (${signal || code})`));
  });
  const got = await waitForHealth(port, 12000);
  if (got) {
    state.pid = child.pid;
    saveState();
    if (verbose) {
      console.log(c('green', `✔  Server running on http://localhost:${port} (pid ${child.pid})`));
      console.log(c('dim', `   ${got.roms} ROM(s) · Node ${got.node} · ${got.memory}`));
    }
    return true;
  }
  if (child.exitCode !== null) {
    if (verbose) {
      console.log(c('red', `✖  Server failed to start (exit code ${child.exitCode}). Last log lines:`));
      tailLogs(15);
    }
  } else if (verbose) {
    console.log(c('red', `✖  Server did not become healthy on port ${port} within 12s.`));
  }
  return false;
}

async function waitForHealth(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const h = await health(port);
    if (h) return h;
    await sleep(400);
  }
  return null;
}

async function stopServer(verbose) {
  const port = state.port;
  const managedPid = pidAlive(state.pid) ? state.pid : null;
  const up = await health(port);
  if (!up) {
    if (verbose) console.log(c('yellow', `ℹ  Server is not running on port ${port}.`));
    return true;
  }
  if (!managedPid) {
    if (verbose) console.log(c('yellow', `⚠  A server is running on port ${port} but it was started outside this dashboard; refusing to kill it.`));
    return false;
  }
  if (verbose) console.log(`Stopping server (pid ${managedPid})…`);
  try { process.kill(managedPid, 'SIGTERM'); } catch (e) { /* gone */ }
  for (let i = 0; i < 25; i++) {
    const h = await health(port);
    if (!h) {
      state.pid = null;
      saveState();
      if (verbose) console.log(c('green', '✔  Server stopped.'));
      return true;
    }
    await sleep(400);
  }
  try { process.kill(managedPid, 'SIGKILL'); } catch (e) { /* gone */ }
  state.pid = null;
  saveState();
  if (verbose) console.log(c('yellow', '⚠  Server did not stop gracefully; force killed.'));
  return true;
}

async function restartServer() {
  await stopServer(true);
  await sleep(500);
  await startServer(true);
}

async function statusView() {
  const h = await health(state.port);
  const managed = pidAlive(state.pid);
  if (h) {
    console.log(c('green', `●  Server: RUNNING   port ${state.port}${managed ? `  (pid ${state.pid}, managed)` : '  (external, not managed)'}`));
    console.log(`   uptime  : ${h.uptime}s`);
    console.log(`   ROMs    : ${h.roms}`);
    console.log(`   memory  : ${h.memory}`);
    console.log(`   node    : ${h.node}`);
  } else {
    console.log(c('red', `○  Server: STOPPED   port ${state.port}`));
    if (managed) console.log(c('dim', '   (state says a process is running, but it is unresponsive)'));
  }
}

async function listRoms() {
  const h = await health(state.port);
  if (!h) { console.log(c('red', `✖  Server not running on port ${state.port}. Start it first.`)); return; }
  const r = await fetchJson(url(state.port, '/roms/info'));
  if (!r.ok || !Array.isArray(r.json)) { console.log(c('red', '✖  Failed to list ROMs.')); return; }
  const rows = r.json;
  if (!rows.length) { console.log('No ROMs found.'); return; }
  console.log(`${c('bold', 'ROM')}  ${c('bold', 'SIZE')}  ${c('bold', 'MAPPER')}  ${c('bold', 'SUPPORTED')}`);
  for (const rom of rows) {
    const name = rom.name.length > 44 ? rom.name.slice(0, 41) + '…' : rom.name;
    const size = (rom.size / 1024).toFixed(1) + 'K';
    const map = rom.mapperName || 'Unknown';
    const ok = rom.supported ? c('green', 'yes') : c('red', 'no');
    console.log(`${name.padEnd(46)} ${size.padStart(7)}  ${map.padEnd(16)} ${ok}`);
  }
}

async function uploadRom(filePath) {
  const h = await health(state.port);
  if (!h) { console.log(c('red', `✖  Server not running on port ${state.port}. Start it first.`)); return; }
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) { console.log(c('red', `✖  File not found: ${filePath}`)); return; }
  const buf = fs.readFileSync(abs);
  const form = new FormData();
  form.append('rom', new Blob([buf]), path.basename(abs));
  const r = await fetchJson(url(state.port, '/roms/upload'), { method: 'POST', body: form }, 30000);
  if (r.ok) console.log(c('green', `✔  Uploaded ${r.json.name} (${(r.json.size / 1024).toFixed(1)}K).`));
  else console.log(c('red', `✖  Upload failed: ${(r.json && r.json.error) || r.text}`));
}

async function deleteRom(name) {
  const r = await fetchJson(url(state.port, `/roms/delete?name=${encodeURIComponent(name)}`), { method: 'DELETE' });
  if (r.ok) console.log(c('green', `✔  Deleted ${name}.`));
  else console.log(c('red', `✖  Delete failed: ${(r.json && r.json.error) || r.text}`));
}

async function listSaves() {
  const h = await health(state.port);
  if (!h) { console.log(c('red', `✖  Server not running on port ${state.port}. Start it first.`)); return; }
  const r = await fetchJson(url(state.port, '/api/saves'));
  if (!r.ok || !Array.isArray(r.json)) { console.log(c('red', '✖  Failed to list saves.')); return; }
  if (!r.json.length) { console.log('No server-side saves found.'); return; }
  for (const s of r.json) {
    console.log(`${c('green', s.name)}  ${(s.size / 1024).toFixed(1)}K  ${new Date(s.modified).toLocaleString()}`);
  }
}

function tailLogs(n) {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    for (const line of lines.slice(-(n || 40))) console.log(line);
  } catch (e) {
    console.log(c('dim', '(no log file yet)'));
  }
}

function followLogs() {
  ensureLogDir();
  let pos = 0;
  try { pos = fs.statSync(LOG_FILE).size; } catch (e) { /* new */ }
  console.log(c('dim', 'Following logs (press q or Ctrl+C to stop)…'));
  const iv = setInterval(() => {
    try {
      const size = fs.statSync(LOG_FILE).size;
      if (size > pos) {
        const fd = fs.openSync(LOG_FILE, 'r');
        const buf = Buffer.alloc(size - pos);
        fs.readSync(fd, buf, 0, buf.length, pos);
        fs.closeSync(fd);
        pos = size;
        process.stdout.write(buf.toString('utf8'));
      }
    } catch (e) { /* ignore */ }
  }, 500);
  iv.unref();
}

function openBrowser() {
  const target = url(state.port, '/');
  const platform = process.platform;
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', target], { stdio: 'ignore', detached: true }).unref();
  } else if (platform === 'darwin') {
    spawn('open', [target], { stdio: 'ignore' });
  } else if (process.env.TERMUX_VERSION) {
    spawn('termux-open-url', [target], { stdio: 'ignore' });
  } else {
    spawn('xdg-open', [target], { stdio: 'ignore' });
  }
  console.log(c('green', `Opening ${target}`));
}

async function changePort(n) {
  const port = parseInt(n, 10);
  if (!port || port < 1 || port > 65535) { console.log(c('red', '✖  Invalid port.')); return; }
  const oldPort = state.port;
  const wasUp = await health(oldPort);
  state.port = port;
  if (state.pid) { state.pid = null; }
  saveState();
  console.log(c('green', `✔  Default port set to ${port}.`));
  if (wasUp && port !== oldPort) {
    console.log(c('yellow', `⚠  A server is still running on port ${oldPort}; restart it from the menu or manually.`));
  }
}

// ---------------------------------------------------------------------------
// Command mode
// ---------------------------------------------------------------------------

async function runCommand(args) {
  const cmd = (args[0] || '').toLowerCase();
  switch (cmd) {
    case 'start': return startServer(true);
    case 'stop': return stopServer(true);
    case 'restart': return restartServer();
    case 'status': return statusView();
    case 'roms': return listRoms();
    case 'saves': return listSaves();
    case 'logs': return tailLogs(parseInt(args[1], 10) || 40);
    case 'logsfollow': followLogs(); return true;
    case 'open': openBrowser(); return true;
    case 'port': {
      if (!args[1]) { console.log(`Current port: ${state.port}`); return true; }
      return changePort(args[1]);
    }
    case 'upload': {
      if (!args[1]) { console.log('Usage: dashboard upload <path-to-rom.nes>'); return true; }
      return uploadRom(args.slice(1).join(' '));
    }
    case 'delete': {
      if (!args[1]) { console.log('Usage: dashboard delete <rom-name.nes>'); return true; }
      return deleteRom(args.slice(1).join(' '));
    }
    case 'help':
      return printHelp();
    default:
      printHelp();
      return null;
  }
}

function printHelp() {
  console.log(`${c('bold', APP_NAME)} — CLI dashboard`);
  console.log('');
  console.log('Usage:');
  console.log('  node dashboard.js                interactive menu');
  console.log('  node dashboard.js <command>      run a single command');
  console.log('');
  console.log('Commands:');
  console.log('  start            start the emulator server');
  console.log('  stop             stop the emulator server (managed)');
  console.log('  restart          restart the server');
  console.log('  status           show server health / status');
  console.log('  roms             list ROMs (mapper, support)');
  console.log('  upload <file>    upload a .nes ROM file');
  console.log('  delete <name>    delete a ROM');
  console.log('  saves            list server-side saves');
  console.log('  logs [n]         show last n log lines (default 40)');
  console.log('  logsfollow       tail the server log live');
  console.log('  open             open the emulator in your browser');
  console.log('  port [n]         show or set the server port');
  console.log('  help             this help');
}

// ---------------------------------------------------------------------------
// Interactive menu
// ---------------------------------------------------------------------------

const stdin = process.stdin;
let mode = 'menu';          // 'menu' | 'prompt' | 'logs'
let promptHandler = null;
let menu = null;
let cursor = 0;
let history = [];
let dirty = true;

function clearScreen() { process.stdout.write('\x1b[2J\x1b[H'); }

function pushMenu(m) { if (menu) history.push(menu); menu = m; cursor = 0; render(); }
function goBack() {
  menu = history.pop() || null;
  cursor = 0;
  if (menu) render();
  else quit(0);
}

async function currentStatusLine() {
  const h = await health(state.port);
  const managed = pidAlive(state.pid);
  if (h) return c('green', `● running`) + c('dim', `  · port ${state.port} · ${h.uptime}s up · ${h.roms} ROM(s) · ${h.memory}`) + (managed ? c('dim', '  · managed') : c('dim', '  · external'));
  return c('red', '○ stopped') + c('dim', `  · port ${state.port}`);
}

async function render() {
  dirty = false;
  clearScreen();
  const status = await currentStatusLine();
  const pkg = require(path.join(REPO_ROOT, 'package.json'));
  console.log(c('bold', APP_NAME) + c('dim', `  v${pkg.version}`));
  console.log(c('dim', '──────────────────────────────────────────────────'));
  console.log('Server   ' + status);
  console.log('');
  if (menu && menu.title) console.log(c('bold', menu.title));
  if (menu) {
    menu.options.forEach((opt, i) => {
      const marker = i === cursor ? c('cyan', '▸') : ' ';
      const num = opt.index != null ? c('dim', `(${opt.index})`) : '';
      console.log(` ${marker} ${num} ${opt.label}`);
    });
  }
  console.log('');
  console.log(c('dim', '↑/↓ navigate · Enter select · Esc/← back · q quit'));
}

function buildMainMenu() {
  return {
    title: 'Main menu',
    options: [
      { index: 1, label: '▶ Start server', run: async () => { await startServer(true); render(); } },
      { index: 2, label: '■ Stop server', run: async () => { await stopServer(true); render(); } },
      { index: 3, label: '↻ Restart server', run: async () => { await restartServer(); render(); } },
      { index: 4, label: 'ℹ Status / health', run: async () => { await statusView(); await waitKey(); render(); } },
      { index: 5, label: '🎮 ROM manager', run: () => pushMenu(buildRomsMenu()) },
      { index: 6, label: '💾 Save states (server-side)', run: async () => { await listSaves(); await waitKey(); render(); } },
      { index: 7, label: '📜 Live logs', run: () => { tailLogs(40); mode = 'logs'; console.log(c('dim', 'Press q or Ctrl+C to return…')); } },
      { index: 8, label: '🌐 Open in browser', run: async () => { openBrowser(); await sleep(300); render(); } },
      { index: 9, label: '🔧 Change port', run: () => pushMenu(buildPortMenu()) },
      { index: 0, label: 'Exit', run: () => quit(0) },
    ],
  };
}

function buildRomsMenu() {
  return {
    title: 'ROM manager',
    options: [
      { index: 1, label: 'List ROMs', run: async () => { await listRoms(); await waitKey(); render(); } },
      { index: 2, label: 'Upload ROM (.nes)', run: async () => {
          try {
            const p = await askLine('Path to .nes file:');
            await uploadRom(p);
          } catch (e) { console.log(c('dim', '(cancelled)')); }
          await waitKey(); render();
      } },
      { index: 3, label: 'Delete ROM', run: async () => {
          try {
            const n = await askLine('ROM name:');
            await deleteRom(n);
          } catch (e) { console.log(c('dim', '(cancelled)')); }
          await waitKey(); render();
      } },
      { index: 0, label: '← Back', run: () => goBack() },
    ],
  };
}

function buildPortMenu() {
  return {
    title: 'Change port (current: ' + state.port + ')',
    options: [
      { index: 1, label: 'Set port', run: async () => {
          try {
            const p = await askLine('New port:');
            await changePort(p);
          } catch (e) { console.log(c('dim', '(cancelled)')); }
          await waitKey(); render();
      } },
      { index: 2, label: 'Restart server on new port', run: async () => { await restartServer(); render(); } },
      { index: 0, label: '← Back', run: () => goBack() },
    ],
  };
}

function waitKey() {
  return new Promise(resolve => {
    const onKey = (str, key) => {
      stdin.removeListener('keypress', onKey);
      resolve();
    };
    stdin.on('keypress', onKey);
  });
}

function askLine(question) {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdout.write('\n' + question + ' ');
    promptHandler = (str, key) => {
      if (key && key.ctrl && key.name === 'c') {
        process.stdout.write('\n');
        promptHandler = null;
        reject(new Error('cancelled'));
      } else if (key && key.name === 'return') {
        process.stdout.write('\n');
        promptHandler = null;
        resolve(buf);
      } else if (key && key.name === 'backspace') {
        if (buf.length) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); }
      } else if (key && key.name === 'escape') {
        process.stdout.write('\n');
        promptHandler = null;
        reject(new Error('cancelled'));
      } else if (str && str.length === 1 && !key.ctrl && !key.meta) {
        buf += str;
        process.stdout.write(str);
      }
    };
  });
}

function onKeypress(str, key) {
  if (mode === 'prompt') {
    if (promptHandler) promptHandler(str, key);
    return;
  }
  if (mode === 'logs') {
    if (key && key.ctrl && key.name === 'c') { mode = 'menu'; quit(0); }
    if ((key && key.name === 'q') || (key && key.name === 'return')) {
      mode = 'menu';
      render();
    }
    return;
  }
  if (mode !== 'menu') return;

  if (key && key.ctrl && key.name === 'c') return quit(0);

  if (!menu) return;

  if (key && key.name === 'up') { cursor = (cursor - 1 + menu.options.length) % menu.options.length; render(); }
  else if (key && key.name === 'down') { cursor = (cursor + 1) % menu.options.length; render(); }
  else if (key && key.name === 'return') {
    const opt = menu.options[cursor];
    if (opt && opt.run) opt.run();
  } else if (key && (key.name === 'escape' || key.name === 'backspace')) {
    if (history.length) goBack();
    else render();
  } else if (str && /^[0-9]$/.test(str)) {
    const idx = parseInt(str, 10);
    const opt = menu.options.find(o => o.index === idx);
    if (opt) { cursor = menu.options.indexOf(opt); if (opt.run) opt.run(); }
  } else if (key && key.name === 'q') {
    quit(0);
  }
}

function quit(code) {
  try { process.stdin.setRawMode(false); } catch (e) { /* ignore */ }
  process.stdin.pause();
  process.exit(code);
}

async function interactive() {
  clearScreen();
  menu = buildMainMenu();
  cursor = 0;
  readline.emitKeypressEvents(stdin);
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.on('keypress', onKeypress);
  stdin.resume();
  await render();
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

(async () => {
  loadState();
  const args = process.argv.slice(2);
  if (args.length) {
    await runCommand(args);
  } else if (isTTY) {
    await interactive();
  } else {
    printHelp();
  }
})().catch(err => {
  console.error('dashboard error:', err.message || err);
  process.exit(1);
});
