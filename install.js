#!/usr/bin/env node
'use strict';

/*
 * Cross-platform installer for the Ruusian Retro Emulator.
 *
 * Detects the OS / environment (Windows, Linux, macOS, Android Termux),
 * clones (or reuses) the repository, installs npm dependencies and wires up
 * a `ruusian` launcher that opens the CLI dashboard.
 *
 * Node >= 18 is required (for global fetch).
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_NAME = 'Ruusian Retro Emulator';
const REPO_URL = 'https://github.com/RuusianP/RuusianRetroEmulator.git';
const PKG_NAME = 'ruusian-retro-emulator';
const MIN_NODE = 18;

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};
function c(code, str) { return C[code] + str + C.reset; }

function log() { console.log.apply(null, arguments); }
function info(msg) { log(c('green', '✔ ') + msg); }
function warn(msg) { log(c('yellow', '⚠ ') + msg); }
function fail(msg) { log(c('red', '✖ ') + msg); }

function run(cmd, args, opts) {
  const res = spawnSync(cmd, args, Object.assign({ stdio: 'inherit' }, opts || {}));
  if (res.error) throw res.error;
  return res.status === 0;
}

function which(name) {
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { /* next */ }
    }
  }
  return null;
}

function nodeMajor() {
  const m = /^(\d+)/.exec(process.versions.node || '');
  return m ? parseInt(m[1], 10) : 0;
}

function detectPlatform() {
  const isTermux = Boolean(process.env.PREFIX) && fs.existsSync('/data/data/com.termux');
  if (isTermux) return 'termux';
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return 'other';
}

function isRepo(dir) {
  try {
    const pkgPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.name === PKG_NAME
      || (fs.existsSync(path.join(dir, 'dashboard.js')) && fs.existsSync(path.join(dir, 'src', 'server.js')));
  } catch (e) { return false; }
}

function chooseTargetDir() {
  const cwd = process.cwd();
  if (isRepo(cwd)) return cwd;
  const home = path.join(os.homedir(), PKG_NAME);
  if (isRepo(home)) return home;
  return home;
}

function ensureRepo(target) {
  if (isRepo(target)) {
    info(`Using existing installation at ${cwdish(target)}`);
    return true;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    // Not a valid checkout — back it up rather than clobber.
    const backup = target + '.old-' + Date.now();
    warn(`${target} exists but is not a valid install; moving it to ${backup}`);
    fs.renameSync(target, backup);
  }
  info(`Cloning ${REPO_URL} …`);
  if (!run('git', ['clone', '--depth', '1', REPO_URL, target])) {
    fail('git clone failed. Make sure git is installed and you are online.');
    return false;
  }
  info(`Installed to ${target}`);
  return true;
}

function npmInstall(target) {
  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  info(`Installing npm dependencies in ${target} …`);
  if (!run(cmd, ['install', '--no-audit', '--no-fund'], { cwd: target })) {
    fail('npm install failed.');
    return false;
  }
  return true;
}

function writeLauncher(target, platform) {
  const binDir = path.join(target, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  if (platform === 'win') {
    const cmdPath = path.join(binDir, 'ruusian.cmd');
    fs.writeFileSync(cmdPath, '@echo off\r\nnode "%~dp0..\\dashboard.js" %*\r\n');
    info(`Created launcher ${cmdPath}`);
    return cmdPath;
  }
  const shPath = path.join(binDir, 'ruusian');
  fs.writeFileSync(
    shPath,
    '#!/usr/bin/env bash\nDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\nexec node "$DIR/../dashboard.js" "$@"\n'
  );
  try { fs.chmodSync(shPath, 0o755); } catch (e) { /* ignore */ }
  info(`Created launcher ${shPath}`);
  return shPath;
}

function posixRcFiles() {
  const home = os.homedir();
  const candidates = ['.bashrc', '.zshrc', '.profile', '.bash_profile'];
  const files = [];
  for (const f of candidates) {
    const p = path.join(home, f);
    if (fs.existsSync(p)) files.push(p);
  }
  if (!files.length) files.push(path.join(home, '.bashrc'));
  return files;
}

function setupPath(target, platform, launcher) {
  const binDir = path.dirname(launcher);
  if (platform === 'win') {
    // Add <install>\bin to the user PATH via PowerShell.
    try {
      const script =
        '$u=[Environment]::GetEnvironmentVariable("Path","User")??"";' +
        '$needle="' + binDir + '";' +
        'if($u -notlike "*"+$needle+"*"){' +
        '[Environment]::SetEnvironmentVariable("Path",(($u.TrimEnd(";"))+";"+$needle),"User");' +
        'Write-Output "ADDED"}' +
        'else{Write-Output "EXISTS"}';
      const res = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
      if (res.status === 0 && res.stdout) {
        const out = res.stdout.trim();
        info(out === 'ADDED'
          ? `Added ${binDir} to your user PATH.`
          : `${binDir} already on your PATH.`);
      } else {
        warn(`Could not update PATH automatically. Add ${binDir} to your PATH manually.`);
      }
    } catch (e) {
      warn(`Could not update PATH automatically. Add ${binDir} to your PATH manually.`);
    }
    return;
  }
  const line = `export PATH="${binDir}:${'$'}PATH"`;
  let modified = false;
  for (const file of posixRcFiles()) {
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (e) {
      try {
        fs.writeFileSync(file, '# Generated by ' + APP_NAME + ' installer\n');
        content = '';
      } catch (e2) { continue; }
    }
    if (content.indexOf(binDir) !== -1) continue;
    try {
      fs.appendFileSync(file, `\n# Added by ${APP_NAME} installer\n${line}\n`);
      info(`Added ${binDir} to your PATH in ${file}`);
      modified = true;
    } catch (e) { /* try next */ }
  }
  if (!modified) {
    warn(`Could not update a shell rc file. Run this once:  ${line}`);
  }
}

function runDashboard(target) {
  log('');
  info('Installation complete!');
  log('');
  log(c('bold', 'Next steps:'));
  if (process.platform === 'win32') {
    log('  1. Open a NEW terminal (or run:  $env:Path = [Environment]::GetEnvironmentVariable("Path","User"))');
    log('  2. Run  ruusian   to open the CLI dashboard');
  } else {
    log('  1. Open a new terminal (or run:  source ~/.bashrc)');
    log('  2. Run  ruusian   to open the CLI dashboard');
  }
  log(`   Or run directly:  node ${path.join(target, 'dashboard.js')}`);
}

function main() {
  const args = process.argv.slice(2);
  const autoStart = args.indexOf('--start') !== -1;

  log(c('bold', APP_NAME) + c('dim', '  — installer'));
  log('');

  const platform = detectPlatform();
  info(`Detected environment: ${platform}`);
  if (nodeMajor() < MIN_NODE) {
    fail(`Node.js ${MIN_NODE}+ is required (found ${process.version}).`);
    log('Install Node.js, then run this installer again.');
    if (platform === 'termux') log('  Termux:  pkg install -y nodejs');
    else if (platform === 'win') log('  Windows: winget install OpenJS.NodeJS.LTS');
    else if (platform === 'macos') log('  macOS:   brew install node');
    else log('  Linux:   install nodejs/npm via your package manager');
    process.exitCode = 1;
    return;
  }
  if (!which('git')) {
    fail('git is required.');
    process.exitCode = 1;
    return;
  }

  const target = chooseTargetDir();
  if (!ensureRepo(target)) { process.exitCode = 1; return; }
  if (!npmInstall(target)) { process.exitCode = 1; return; }

  const launcher = writeLauncher(target, platform);
  setupPath(target, platform, launcher);
  runDashboard(target);

  if (autoStart) {
    log('');
    info('Starting the CLI dashboard …');
    const res = spawnSync('node', [path.join(target, 'dashboard.js')], { stdio: 'inherit' });
    process.exitCode = res.status === null ? 1 : res.status;
  }
}

function cwdish(target) {
  const cwd = process.cwd();
  return path.resolve(target) === path.resolve(cwd) ? 'current directory' : target;
}

(async () => {
  try {
    main();
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
    process.exitCode = 1;
  }
})();
