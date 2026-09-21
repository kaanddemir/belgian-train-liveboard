#!/usr/bin/env node
// SNCB / NMBS board — dev launcher. Starts the Vite dev server behind a
// preflight panel. Zero dependencies: Node stdlib only.
// `npm run dev:vite` still starts Vite on its own.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IS_WIN = process.platform === 'win32';

// ===== Args =====
function parseArgs(argv) {
  const opts = { port: 5173, host: false, color: true, net: true, open: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--port': opts.port = Number(argv[++i]); break;
      case '--host': opts.host = true; break;
      case '--open': opts.open = true; break;
      case '--no-color': opts.color = false; break;
      case '--no-net': opts.net = false; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        console.error(`Unknown option: ${arg}  (try --help)`);
        process.exit(1);
    }
  }
  if (!Number.isInteger(opts.port)) {
    console.error('--port needs a number');
    process.exit(1);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help) {
  console.log(`
  npm run dev — start the SNCB / NMBS departure board

    --port <n>        dev server port (default 5173)
    --host            expose the server on the local network
    --open            open the board in the browser once it is up
    --no-net          skip the iRail reachability check
    --no-color        plain output
    -h, --help        this message
`);
  process.exit(0);
}

// ===== Colour =====
const USE_COLOR = opts.color && !process.env.NO_COLOR && process.stdout.isTTY;
const rgb = (r, g, b) => (s) => (USE_COLOR ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m` : String(s));

// The board's own palette — src/styles.css
const blue = rgb(0x4c, 0x9e, 0xdb);   // title bar #006AB2, lifted for dark terminals
const yellow = rgb(0xff, 0xcc, 0x05);
const red = rgb(0xeb, 0x2e, 0x2b);
const dim = rgb(0x8a, 0x8a, 0x8a);
const green = rgb(0x3f, 0xb9, 0x50);
const amber = rgb(0xe0, 0x9b, 0x2a);

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visibleLength = (s) => s.replace(ANSI_RE, '').length;

// ===== Preflight =====
const checks = [];
let fatal = false;

function ok(label, note, details = []) { checks.push({ status: 'ok', label, note, details }); }
function warn(label, note, details = []) { checks.push({ status: 'warn', label, note, details }); }
function fail(label, note, details = []) {
  checks.push({ status: 'fail', label, note, details });
  fatal = true;
}

const viteBin = path.join(ROOT, 'node_modules', '.bin', IS_WIN ? 'vite.cmd' : 'vite');

function checkDeps() {
  if (!fs.existsSync(viteBin)) {
    fail('node_modules missing', 'run: npm install');
    return;
  }
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 18) {
    fail(`node v${process.versions.node}`, 'Vite 5 needs Node 18 or newer');
    return;
  }
  ok('dependencies', `node v${process.versions.node}`);
}

function bindFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    if (host) srv.listen(port, host); else srv.listen(port);
  });
}

async function checkPorts() {
  const free = (await bindFree(opts.port, null)) && (await bindFree(opts.port, '127.0.0.1'));
  if (!free) fail('port in use', `:${opts.port} (use \`npm run dev -- --port ${opts.port + 1}\`)`);
  else ok('port', `board :${opts.port}`);
}

// The station and the refresh interval are read straight out of src/App.jsx:
// the iRail probe below checks the station the board will actually request.
const config = { station: null, refresh: null };

function checkConfig() {
  const file = path.join(ROOT, 'src', 'App.jsx');
  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch {
    fail('src/App.jsx missing', 'the board cannot start without it');
    return;
  }
  config.station = source.match(/const STATION\s*=\s*'([^']+)'/)?.[1] ?? null;
  const ms = source.match(/refreshMs:\s*([\d_]+)/)?.[1];
  config.refresh = ms ? Number(ms.replace(/_/g, '')) : null;
}

// iRail serves the live data straight to the browser; without it the board
// runs but shows the offline strip, so this is a warning, never fatal.
function checkIrail() {
  if (!opts.net) { warn('iRail API', 'check skipped (--no-net)'); return Promise.resolve(); }
  return new Promise((resolve) => {
    const url = 'https://api.irail.be/v1/liveboard?format=json&arrdep=departure&station='
      + encodeURIComponent(config.station || 'Brussel-Zuid');
    const req = https.get(url, { timeout: 5000 }, (res) => {
      res.resume();
      if (res.statusCode === 200) ok('iRail API', 'live data reachable');
      else warn('iRail API', `responded ${res.statusCode} — the board will show the offline strip`);
      resolve();
    });
    req.on('error', (err) => {
      warn('iRail API', 'unreachable — the board will show the offline strip', [err.message]);
      resolve();
    });
    req.on('timeout', () => {
      req.destroy();
      warn('iRail API', 'timed out — the board will show the offline strip');
      resolve();
    });
  });
}

// ===== Process management =====
const children = [];
let shuttingDown = false;
let activeSpinner = null;

// Vite output may arrive while the status spinner owns the current terminal
// line. Clear that line before printing and redraw it afterwards so prefixes
// and log messages always begin on a clean line.
function printLine(line = '') {
  const currentSpinner = activeSpinner;
  if (currentSpinner) currentSpinner.clear();
  console.log(line);
  if (currentSpinner && activeSpinner === currentSpinner) currentSpinner.render();
}

function stopActiveSpinner() {
  if (activeSpinner) activeSpinner.stop();
}

function pipeLines(stream, label, paint) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    // Vite draws its own banner; the panel below already says all of it.
    for (const line of lines) {
      if (!line.trim()) continue;
      printLine(`${paint(`[${label}]`)} ${line}`);
    }
  });
  stream.on('end', () => { if (buf.trim()) printLine(`${paint(`[${label}]`)} ${buf}`); });
}

function start(label, cmd, args, cwd, paint, extraEnv) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.label = label;
  pipeLines(child.stdout, label, paint);
  pipeLines(child.stderr, label, paint);
  child.on('error', (err) => {
    printLine(`${paint(`[${label}]`)} ${red('failed to start:')} ${err.message}`);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    printLine('');
    printLine(`${red('✗')} ${label} exited (${signal ? `signal ${signal}` : `code ${code}`}) — stopping`);
    shutdown(code || 1);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopActiveSpinner();
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
  const timer = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    process.exit(code);
  }, 5000);
  timer.unref();

  const waitAll = Promise.all(children.map((child) =>
    child.exitCode !== null ? Promise.resolve() : new Promise((r) => child.once('exit', r))));
  waitAll.then(() => { clearTimeout(timer); process.exit(code); });
}

process.on('SIGINT', () => { stopActiveSpinner(); console.log(''); shutdown(0); });
process.on('SIGTERM', () => shutdown(0));

// ===== Health polling =====
// Vite may bind IPv4 or IPv6 depending on the platform, so probe whatever
// `localhost` resolves to rather than assuming 127.0.0.1.
function ping(port, urlPath, host = 'localhost') {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: urlPath, timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitFor(port, urlPath, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !shuttingDown) {
    const body = await ping(port, urlPath);
    if (body !== false) return body;
    const v4 = await ping(port, urlPath, '127.0.0.1');
    if (v4 !== false) return v4;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
function spinner(text) {
  if (!process.stdout.isTTY) { console.log(`  ${text}`); return () => {}; }
  let i = 0;
  let rendered = false;
  let id;
  const state = {
    clear() {
      if (!rendered) return;
      process.stdout.write('\r\x1b[2K');
      rendered = false;
    },
    render() {
      if (activeSpinner !== state) return;
      process.stdout.write(`\r  ${blue(SPINNER[i++ % SPINNER.length])} ${dim(text)}`);
      rendered = true;
    },
    stop() {
      clearInterval(id);
      state.clear();
      if (activeSpinner === state) activeSpinner = null;
    },
  };
  activeSpinner = state;
  state.render();
  id = setInterval(() => { state.clear(); state.render(); }, 80);
  return () => state.stop();
}

// ===== Panel =====
function panel(rows) {
  const width = Math.min(Math.max(...rows.map(visibleLength)) + 6, (process.stdout.columns || 80) - 2);
  const line = (s = '') => {
    const pad = Math.max(0, width - 4 - visibleLength(s));
    return `${dim('│')}  ${s}${' '.repeat(pad)}${dim('│')}`;
  };
  console.log(dim(`╭${'─'.repeat(width - 2)}╮`));
  for (const row of rows) console.log(line(row));
  console.log(dim(`╰${'─'.repeat(width - 2)}╯`));
}

const title = `${blue('SNCB')}${dim('/')}${blue('NMBS')}  ${dim('·')}  ${yellow('Vertrek / Départ')}`;
const section = (t) => dim(t.toUpperCase());
const statusRow = (label, status, detail = '') =>
  `  ${label.padEnd(10)} ${status}${detail ? `  ${detail}` : ''}`;

function preflightPanel() {
  const statusMark = { ok: green('✓'), warn: amber('!'), fail: red('✗') };
  const rows = [title, '', section('preflight')];
  for (const check of checks) {
    rows.push(`  ${statusMark[check.status]}  ${check.label.padEnd(16)}${check.note ? dim(check.note) : ''}`);
    for (const detail of check.details) rows.push(`       ${dim(detail)}`);
  }
  panel(rows);
}

// ===== Main =====
async function main() {
  checkDeps();
  if (!fatal) await checkPorts();
  if (!fatal) checkConfig();
  if (!fatal) await checkIrail();
  console.log('');
  preflightPanel();
  console.log('');
  if (fatal) process.exit(1);

  const args = ['--port', String(opts.port), '--strictPort'];
  if (opts.host) args.push('--host');
  if (opts.open) args.push('--open');
  start('vite', viteBin, args, ROOT, blue, { FORCE_COLOR: USE_COLOR ? '1' : '0' });

  const stop = spinner('starting the board…');
  const up = await waitFor(opts.port, '/');
  stop();
  if (shuttingDown) return;

  const mark = up !== false ? green('✓') : amber('!');
  const rows = [
    title,
    '',
    section('board'),
    statusRow('server', mark, `http://localhost:${opts.port}`),
    statusRow('refresh', dim('·'), dim(config.refresh ? `every ${Math.round(config.refresh / 1000)} s` : '—')),
    '',
    section('data'),
    `  ${'iRail'.padEnd(10)} ${dim('https://api.irail.be/v1')}`,
  ];
  if (opts.host) rows.push('', section('network'), `  ${dim('exposed — see the [vite] lines above')}`);

  console.log('');
  panel(rows);
  if (up === false) console.log(`  ${amber('!')} ${dim('the dev server did not respond — check the [vite] logs above')}`);
  console.log(`  ${dim('Ctrl+C to stop')}\n`);
}

main().catch((err) => {
  console.error(red('launcher failed:'), err);
  shutdown(1);
});
