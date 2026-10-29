#!/usr/bin/env node
'use strict';
/*
 * BOTLAUNCH Lokal — server untuk HP (Termux). Tanpa dependency: hanya Node >= 18 + perintah unzip/zip/npm.
 * Menyajikan dashboard BOTLAUNCH dan API-nya di http://localhost:8787 (hanya bisa diakses dari HP itu sendiri).
 * Semua data ada di ~/.botlaunch (proyek, sesi WhatsApp, env, backup). Tidak ada server luar.
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.BOTLAUNCH_HOST || '127.0.0.1';
const TOKEN = process.env.BOTLAUNCH_TOKEN || '';
const HOME_DIR = process.env.BOTLAUNCH_HOME || path.join(os.homedir(), '.botlaunch');
const PROJECTS_DIR = path.join(HOME_DIR, 'projects');
const BACKUPS_DIR = path.join(HOME_DIR, 'backups');
const TMP_DIR = path.join(HOME_DIR, 'tmp');
const EVENTS_FILE = path.join(HOME_DIR, 'events.jsonl');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_MB = parseFloat(process.env.BOTLAUNCH_MAX_UPLOAD_MB || '50');
const MAX_UPLOAD = MAX_MB * 1024 * 1024;
const MAX_UNPACKED = 500 * 1024 * 1024;
const MAX_FILES = 30000;
const MAX_RESTARTS = 6;
const BACKOFF_MS = parseInt(process.env.BOTLAUNCH_BACKOFF_MS || '5000', 10);
const LOOPBACK = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';

if (!LOOPBACK && !TOKEN) {
  console.error('Menolak start: BOTLAUNCH_HOST bukan loopback tetapi BOTLAUNCH_TOKEN kosong. Set token dulu.');
  process.exit(1);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ID_RE = /^[a-f0-9]{12}$/;

function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
    });
  });
}
function missingTool(err, tool, pkg) {
  return err && err.code === 'ENOENT'
    ? new HttpError(500, `Perintah "${tool}" tidak ditemukan. Jalankan di Termux: pkg install ${pkg}`)
    : null;
}

// ---------------------------------------------------------------- event log
const events = [];
function fmtTime(d) {
  try {
    return d.toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch { return d.toISOString(); }
}
function logEvent(level, message, projectId) {
  const e = { level, message, time: fmtTime(new Date()), projectId: projectId || null };
  events.push(e);
  if (events.length > 500) events.shift();
  fs.appendFile(EVENTS_FILE, JSON.stringify(e) + '\n', () => {});
  console.log(`[${e.time}] ${level.toUpperCase().padEnd(5)} ${message}`);
}
function loadEvents() {
  try {
    const lines = fs.readFileSync(EVENTS_FILE, 'utf8').trim().split('\n').slice(-300);
    for (const l of lines) { try { events.push(JSON.parse(l)); } catch { /* baris rusak */ } }
    if (fs.statSync(EVENTS_FILE).size > 1024 * 1024) fs.writeFileSync(EVENTS_FILE, lines.join('\n') + '\n');
  } catch { /* belum ada */ }
}

// ---------------------------------------------------------------- penyimpanan proyek
const metas = new Map();       // id -> meta (disimpan di meta.json)
const envCache = new Map();    // id -> {KEY: value}
const runtime = new Map();     // id -> {child, state, startedAt, crashes, timer}
const installing = new Set();
const runBuf = new Map();      // id -> array baris terakhir

const pdir = (id) => path.join(PROJECTS_DIR, id);
const appBase = (id) => path.join(pdir(id), 'app');
function appRoot(m) {
  const root = appBase(m.projectId);
  return m.appDir ? path.join(root, ...m.appDir.split('/')) : root;
}
async function writeJsonAtomic(file, obj, mode) {
  const tmp = file + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), { mode: mode || 0o644 });
  await fsp.rename(tmp, file);
}
const saveMeta = (m) => writeJsonAtomic(path.join(pdir(m.projectId), 'meta.json'), m);
function need(id) {
  if (!ID_RE.test(id || '') || !metas.has(id)) throw new HttpError(404, 'Proyek tidak ditemukan.');
  return metas.get(id);
}
function getEnv(id) {
  if (!envCache.has(id)) {
    let o = {};
    try { o = JSON.parse(fs.readFileSync(path.join(pdir(id), 'env.json'), 'utf8')); } catch { /* kosong */ }
    envCache.set(id, o && typeof o === 'object' ? o : {});
  }
  return envCache.get(id);
}
function statusOf(m) {
  if (installing.has(m.projectId)) return 'installing';
  if (runtime.has(m.projectId)) return 'online';
  if (m.lastState === 'error') return 'error';
  if (!m.extracted) return 'analyzed';
  return m.everStarted ? 'stopped' : 'ready';
}
function view(m) {
  return {
    projectId: m.projectId, name: m.name, fileCount: m.fileCount, size: m.size, compatible: m.compatible,
    language: m.language, entryPoint: m.entryPoint, packageManager: m.packageManager,
    dependencies: m.dependencies, warnings: m.warnings, features: m.features, envKeys: m.envKeys,
    envSet: Object.keys(getEnv(m.projectId)), extracted: m.extracted, installed: m.installed,
    createdAt: m.createdAt, runtimeStatus: statusOf(m),
  };
}
async function loadProjects() {
  await fsp.mkdir(PROJECTS_DIR, { recursive: true });
  for (const id of await fsp.readdir(PROJECTS_DIR)) {
    if (!ID_RE.test(id)) continue;
    try {
      const m = JSON.parse(await fsp.readFile(path.join(pdir(id), 'meta.json'), 'utf8'));
      if (m && m.projectId === id) metas.set(id, m);
    } catch { /* proyek rusak diabaikan */ }
  }
}

// ---------------------------------------------------------------- log keluaran bot (QR WhatsApp ada di sini)
function cleanLine(s) {
  s = s.replace(/\x1b\[47m( +)\x1b\[0m/g, (_, sp) => '\u2588'.repeat(sp.length)) // QR mode ANSI: putih -> blok
    .replace(/\x1b\[40m( +)\x1b\[0m/g, '$1');                                       //               hitam -> spasi
  s = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  return s.length > 2000 ? s.slice(0, 2000) + '\u2026' : s;
}
function tailLines(id) {
  let buf = runBuf.get(id);
  if (buf) return buf;
  buf = [];
  try {
    const f = path.join(pdir(id), 'run.log');
    const st = fs.statSync(f);
    const fd = fs.openSync(f, 'r');
    const n = Math.min(st.size, 96 * 1024);
    const b = Buffer.alloc(n);
    fs.readSync(fd, b, 0, n, st.size - n);
    fs.closeSync(fd);
    buf = b.toString('utf8').split('\n').filter((x, i) => x !== '' || i > 0).slice(-400);
    if (st.size > 1024 * 1024) fs.writeFileSync(f, buf.join('\n') + '\n');
  } catch { /* belum ada */ }
  runBuf.set(id, buf);
  return buf;
}
function appendRun(id, lines) {
  if (!lines.length) return;
  const buf = tailLines(id);
  buf.push(...lines);
  if (buf.length > 400) buf.splice(0, buf.length - 400);
  fs.appendFile(path.join(pdir(id), 'run.log'), lines.join('\n') + '\n', () => {});
}
function lineSink(id, prefix) {
  let rest = '', timer = null;
  const flush = () => { if (rest) { appendRun(id, [prefix + cleanLine(rest)]); rest = ''; } };
  return (chunk) => {
    clearTimeout(timer);
    rest += chunk.toString('utf8');
    const parts = rest.split(/\r\n|\n|\r/);
    rest = parts.pop();
    if (rest.length > 4000) { parts.push(rest); rest = ''; }
    if (parts.length) appendRun(id, parts.map((l) => prefix + cleanLine(l)));
    if (rest) timer = setTimeout(flush, 400);
  };
}

// ---------------------------------------------------------------- ZIP: validasi + analisis
function safeName(n) {
  if (!n || n.includes('\0')) return false;
  const parts = n.replace(/\\/g, '/').split('/');
  return !n.startsWith('/') && !parts.includes('..');
}
const isExcluded = (n) => /(^|\/)(node_modules|\.git)(\/|$)/.test(n);
const globEsc = (n) => n.replace(/([\[\]*?\\])/g, '\\$1');

async function zipEntries(zip) {
  let out;
  try { out = (await exec('unzip', ['-Z', zip])).stdout; }
  catch (e) {
    const mt = missingTool(e, 'unzip', 'unzip zip'); if (mt) throw mt;
    throw new HttpError(400, 'File bukan ZIP yang valid atau rusak.');
  }
  const files = [];
  let symlinks = 0;
  for (const line of out.split('\n')) {
    // awalan "?" = tipe file tidak tercatat di zip (umum untuk zip buatan aplikasi Android) -> anggap file biasa
    const m = /^([-dl?])\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'd' || m[3].endsWith('/')) continue;
    if (m[1] === 'l') { symlinks++; continue; }
    files.push({ name: m[3], size: parseInt(m[2], 10) });
  }
  return { files, symlinks };
}
async function zipRead(zip, names) {
  const list = names.map(globEsc);
  if (!list.length) return '';
  try { return (await exec('unzip', ['-p', zip, ...list])).stdout; } catch { return ''; }
}

const NOISE_ENV = new Set(['PATH', 'HOME', 'PWD', 'USER', 'SHELL', 'TERM', 'LANG', 'TMPDIR', 'NODE_ENV', 'CI', 'HOSTNAME', 'TZ', 'DEBUG', 'npm_package_version', 'NODE_OPTIONS']);
const FEATURES = [
  [/^(@whiskeysockets\/baileys|baileys|@adiwajshing\/baileys|@itsukichan\/baileys)$/, 'WhatsApp (Baileys)'],
  [/^(whatsapp-web\.js)$/, 'WhatsApp Web.js'],
  [/^(telegraf|node-telegram-bot-api|grammy)$/, 'Telegram'],
  [/^(discord\.js)$/, 'Discord'],
  [/^(openai|@google\/generative-ai|groq-sdk|@anthropic-ai\/sdk)$/, 'AI chat'],
  [/^(express|fastify|koa)$/, 'HTTP server'],
  [/^(qrcode-terminal|qrcode)$/, 'QR login'],
  [/^(node-cron|cron|node-schedule)$/, 'Scheduler'],
  [/^(jimp|sharp|canvas)$/, 'Pemrosesan gambar'],
  [/^(ffmpeg|fluent-ffmpeg)$/, 'Media/ffmpeg'],
];
const NATIVE = new Set(['sharp', 'canvas', 'better-sqlite3', 'sqlite3', 'puppeteer', 'node-pty', 'bcrypt']);

function parseStart(script) {
  if (!script || /[;&|<>`$()]/.test(script)) return null;
  const t = script.trim().split(/\s+/);
  if (t[0] !== 'node') return null;
  if (!t.slice(1).some((x) => !x.startsWith('-'))) return null;
  return t.slice(1);
}

async function analyzeZip(zip, filename) {
  const { files, symlinks } = await zipEntries(zip);
  const bad = files.find((f) => !safeName(f.name));
  if (bad) throw new HttpError(400, 'ZIP ditolak: ada path berbahaya (' + bad.name.slice(0, 80) + ').');
  const kept = files.filter((f) => !isExcluded(f.name));
  const size = kept.reduce((a, f) => a + f.size, 0);
  if (kept.length > MAX_FILES) throw new HttpError(400, `ZIP berisi terlalu banyak file (maks ${MAX_FILES}).`);
  if (size > MAX_UNPACKED) throw new HttpError(400, 'Isi ZIP terlalu besar setelah diekstrak (maks 500 MB).');
  if (!kept.length) throw new HttpError(400, 'ZIP kosong.');
  const names = new Set(kept.map((f) => f.name));
  const warnings = [];
  if (files.length !== kept.length) warnings.push('node_modules dan .git di dalam ZIP diabaikan; dependencies dipasang ulang lewat npm.');
  if (symlinks) warnings.push('Symlink di dalam ZIP diabaikan.');

  const pkgName = [...names].filter((n) => /^([^/]+\/)?package\.json$/.test(n)).sort((a, b) => a.length - b.length)[0];
  const base = String(filename || 'bot').replace(/\.zip$/i, '').replace(/[^\p{L}\p{N} ._()-]+/gu, '_').trim().slice(0, 60) || 'bot';
  const res = {
    name: base, fileCount: kept.length, size, compatible: false, language: 'Unknown', entryPoint: '',
    packageManager: '', dependencies: [], warnings, features: [], envKeys: [], appDir: '', startScript: '', nodeArgs: null,
  };

  if (!pkgName) {
    if ([...names].some((n) => /(^|\/)requirements\.txt$|\.py$/.test(n))) {
      res.language = 'Python';
      warnings.push('Python runner is not available yet.');
    } else warnings.push('package.json tidak ditemukan di root ZIP (atau satu folder di dalamnya).');
    return res;
  }
  res.appDir = pkgName.includes('/') ? pkgName.split('/')[0] : '';
  const dirPrefix = res.appDir ? res.appDir + '/' : '';
  let pkg = {};
  try { pkg = JSON.parse(await zipRead(zip, [pkgName])); } catch { warnings.push('package.json tidak bisa dibaca (JSON rusak).'); return res; }
  const deps = Object.keys(pkg.dependencies || {});
  const allDeps = new Set([...deps, ...Object.keys(pkg.devDependencies || {})]);
  res.dependencies = deps;
  res.language = allDeps.has('typescript') || names.has(dirPrefix + 'tsconfig.json') ? 'TypeScript' : 'Node.js';
  res.packageManager = (typeof pkg.packageManager === 'string' && pkg.packageManager.split('@')[0]) ||
    (names.has(dirPrefix + 'pnpm-lock.yaml') ? 'pnpm' : names.has(dirPrefix + 'yarn.lock') ? 'yarn' : 'npm');
  if (res.packageManager !== 'npm') warnings.push(`Project memakai ${res.packageManager}; di HP install dijalankan dengan npm.`);

  const startScript = pkg.scripts && typeof pkg.scripts.start === 'string' ? pkg.scripts.start : '';
  const nodeArgs = parseStart(startScript);
  const cands = ['index.js', 'main.js', 'bot.js', 'app.js', 'start.js', 'src/index.js', 'src/main.js', 'src/bot.js', 'index.mjs', 'index.ts', 'src/index.ts', 'main.ts'];
  let entry = '';
  if (nodeArgs) entry = nodeArgs.find((x) => !x.startsWith('-')) || '';
  if (!entry && typeof pkg.main === 'string' && names.has(dirPrefix + pkg.main.replace(/^\.\//, ''))) entry = pkg.main.replace(/^\.\//, '');
  if (!entry) entry = cands.find((c) => names.has(dirPrefix + c)) || '';
  res.entryPoint = entry || (startScript ? 'npm start' : '');
  res.startScript = startScript;
  res.nodeArgs = nodeArgs || (!startScript && entry ? [entry] : null);
  res.compatible = !!(entry || startScript);
  if (!res.compatible) warnings.push('Entry point tidak ditemukan. Tambahkan field "main" atau script "start" di package.json.');
  if (res.language === 'TypeScript' && !startScript && /\.ts$/.test(entry)) {
    res.compatible = false;
    warnings.push('TypeScript tanpa script "start": tambahkan script start/build di package.json.');
  }
  for (const [re, label] of FEATURES) if (deps.some((d) => re.test(d))) res.features.push({ name: label });
  if (deps.includes('whatsapp-web.js')) warnings.push('whatsapp-web.js butuh Chromium/Puppeteer; di HP lebih cocok template Baileys.');
  const nat = deps.filter((d) => NATIVE.has(d));
  if (nat.length) warnings.push(`Dependency native (${nat.join(', ')}) butuh kompilasi dan bisa gagal di HP karena install memakai --ignore-scripts.`);

  // nama variabel environment: .env.example + process.env.X di kode
  const keys = new Set();
  const envFiles = ['.env.example', '.env.sample', '.env.template', '.env.dist', 'example.env', 'sample.env'].map((n) => dirPrefix + n).filter((n) => names.has(n));
  const envText = await zipRead(zip, envFiles);
  for (const l of envText.split('\n')) { const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l); if (m) keys.add(m[1]); }
  const src = kept.filter((f) => /\.(c|m)?(js|ts)$/.test(f.name) && f.size < 200 * 1024 && f.name.startsWith(dirPrefix)).sort((a, b) => a.size - b.size).slice(0, 40).map((f) => f.name);
  const code = await zipRead(zip, src);
  for (const m of code.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g)) keys.add(m[1] || m[2]);
  res.envKeys = [...keys].filter((k) => !NOISE_ENV.has(k)).slice(0, 40);
  return res;
}

// ---------------------------------------------------------------- upload multipart (tanpa dependency)
async function receiveUpload(req) {
  const len = parseInt(req.headers['content-length'] || '0', 10);
  if (!len) throw new HttpError(411, 'Upload tidak valid (Content-Length kosong).');
  if (len > MAX_UPLOAD + 1024 * 1024) throw new HttpError(413, `ZIP terlalu besar (maks ${MAX_MB} MB).`);
  const ct = req.headers['content-type'] || '';
  const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!/multipart\/form-data/i.test(ct) || !bm) throw new HttpError(400, 'Upload harus multipart/form-data.');
  const boundary = bm[1] || bm[2];
  await fsp.mkdir(TMP_DIR, { recursive: true });
  const tmp = path.join(TMP_DIR, 'up-' + crypto.randomBytes(6).toString('hex'));
  let n = 0;
  const limiter = new Transform({
    transform(chunk, _e, cb) { n += chunk.length; n > MAX_UPLOAD + 1024 * 1024 ? cb(new HttpError(413, `ZIP terlalu besar (maks ${MAX_MB} MB).`)) : cb(null, chunk); },
  });
  try { await pipeline(req, limiter, fs.createWriteStream(tmp)); }
  catch (e) { await fsp.rm(tmp, { force: true }); throw e instanceof HttpError ? e : new HttpError(400, 'Upload terputus.'); }
  try {
    const fh = await fsp.open(tmp, 'r');
    try {
      const size = (await fh.stat()).size;
      const head = Buffer.alloc(Math.min(size, 16384));
      await fh.read(head, 0, head.length, 0);
      const hs = head.toString('latin1');
      const he = hs.indexOf('\r\n\r\n');
      if (he < 0) throw new HttpError(400, 'Upload multipart rusak.');
      const headers = hs.slice(0, he);
      if (!/name="template"/i.test(headers)) throw new HttpError(400, 'Field "template" tidak ditemukan.');
      const fm = /filename="([^"]*)"/i.exec(headers);
      const filename = fm ? Buffer.from(fm[1], 'latin1').toString('utf8').split(/[\\/]/).pop() : 'bot.zip';
      const tailLen = Math.min(size, boundary.length + 64);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      const ti = tail.toString('latin1').lastIndexOf('\r\n--' + boundary);
      if (ti < 0) throw new HttpError(400, 'Upload multipart rusak (akhir tidak ditemukan).');
      return { tmp, start: he + 4, end: size - tailLen + ti, filename };
    } finally { await fh.close(); }
  } catch (e) { await fsp.rm(tmp, { force: true }); throw e; }
}

async function createProject(req) {
  const up = await receiveUpload(req);
  const id = crypto.randomBytes(6).toString('hex');
  const dir = pdir(id);
  try {
    await fsp.mkdir(dir, { recursive: true });
    const zip = path.join(dir, 'template.zip');
    if (up.end - up.start < 22) throw new HttpError(400, 'File bukan ZIP yang valid.');
    await pipeline(fs.createReadStream(up.tmp, { start: up.start, end: up.end - 1 }), fs.createWriteStream(zip));
    const fh = await fsp.open(zip, 'r');
    const magic = Buffer.alloc(2);
    await fh.read(magic, 0, 2, 0); await fh.close();
    if (magic.toString('latin1') !== 'PK') throw new HttpError(400, 'File bukan ZIP yang valid.');
    const a = await analyzeZip(zip, up.filename);
    const m = {
      projectId: id, ...a, createdAt: new Date().toISOString(), extracted: false, installed: false,
      desired: 'stopped', everStarted: false,
    };
    metas.set(id, m);
    await saveMeta(m);
    logEvent('info', `Template dianalisis: ${m.name} (${m.fileCount} file)`, id);
    return m;
  } catch (e) {
    metas.delete(id);
    await fsp.rm(dir, { recursive: true, force: true });
    throw e;
  } finally { await fsp.rm(up.tmp, { force: true }); }
}

// ---------------------------------------------------------------- setup / install / jalankan bot
async function stripSymlinks(dir) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) await fsp.unlink(p);
    else if (e.isDirectory()) await stripSymlinks(p);
  }
}
async function setupWorkspace(id) {
  const m = need(id);
  if (!m.compatible) throw new HttpError(400, 'Template belum kompatibel. Baca peringatan di laporan analisis.');
  if (runtime.has(id)) throw new HttpError(409, 'Hentikan bot dulu sebelum menyiapkan ulang workspace.');
  const dir = appBase(id);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  try {
    await exec('unzip', ['-q', '-o', path.join(pdir(id), 'template.zip'), '-d', dir, '-x', 'node_modules/*', '*/node_modules/*', '.git/*', '*/.git/*']);
  } catch (e) {
    const mt = missingTool(e, 'unzip', 'unzip zip'); if (mt) throw mt;
    if (!(e.code === 1)) throw new HttpError(500, 'Gagal mengekstrak ZIP: ' + String(e.stderr || e.message).slice(0, 200));
  }
  await stripSymlinks(dir);
  m.extracted = true; m.installed = false; m.lastState = undefined;
  await saveMeta(m);
  logEvent('info', `Workspace disiapkan: ${m.name}`, id);
  return m;
}

function runLogged(id, cmd, args, opts, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const out = lineSink(id, ''), err = lineSink(id, '');
    child.stdout.on('data', out); child.stderr.on('data', err);
    const t = setTimeout(() => { appendRun(id, ['[botlaunch] install melewati batas waktu, dihentikan.']); killTree(child, 'SIGKILL'); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}
async function installDeps(id) {
  const m = need(id);
  if (!m.extracted) throw new HttpError(400, 'Siapkan workspace dulu (Prepare workspace).');
  if (installing.has(id)) throw new HttpError(409, 'Install sedang berjalan.');
  if (runtime.has(id)) throw new HttpError(409, 'Hentikan bot dulu sebelum install.');
  installing.add(id);
  logEvent('info', `Install dependencies dimulai: ${m.name}`, id);
  appendRun(id, ['[botlaunch] npm install --ignore-scripts ...']);
  try {
    let code;
    try {
      code = await runLogged(id, 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-progress'],
        { cwd: appRoot(m), env: { ...process.env, npm_config_loglevel: 'http' } }, 20 * 60 * 1000);
    } catch (e) { throw missingTool(e, 'npm', 'nodejs') || e; }
    if (code !== 0) {
      logEvent('error', `npm install gagal (kode ${code}): ${m.name}`, id);
      throw new HttpError(500, `npm install gagal (kode ${code}). Lihat Bot console.`);
    }
    m.installed = true; m.lastState = undefined;
    await saveMeta(m);
    logEvent('info', `Dependencies terpasang: ${m.name}`, id);
  } finally { installing.delete(id); }
  return m;
}

function killTree(child, sig) {
  try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* sudah mati */ } }
}
function botEnv(m) {
  const home = path.join(pdir(m.projectId), 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { PATH: process.env.PATH || '', HOME: home, TERM: 'dumb', BOTLAUNCH: '1', TMPDIR: process.env.TMPDIR || os.tmpdir() };
  for (const k of ['LANG', 'LC_ALL', 'TZ', 'PREFIX']) if (process.env[k]) env[k] = process.env[k];
  if (/termux-exec/.test(process.env.LD_PRELOAD || '')) env.LD_PRELOAD = process.env.LD_PRELOAD;
  return { ...env, ...getEnv(m.projectId) };
}
function launchSpec(m) {
  if (m.nodeArgs) return { cmd: process.execPath, args: m.nodeArgs };
  return { cmd: 'npm', args: ['start', '--silent'] };
}
async function startBot(id) {
  const m = need(id);
  if (!m.extracted) throw new HttpError(400, 'Siapkan workspace dulu (Prepare workspace).');
  if (installing.has(id)) throw new HttpError(409, 'Install sedang berjalan.');
  if (m.dependencies.length && !m.installed) throw new HttpError(400, 'Dependencies belum terpasang. Klik Install dependencies dulu.');
  const cur = runtime.get(id);
  if (cur && cur.child && cur.state === 'running') return false;
  if (cur && cur.timer) clearTimeout(cur.timer);
  const { cmd, args } = launchSpec(m);
  let child;
  try { child = spawn(cmd, args, { cwd: appRoot(m), env: botEnv(m), detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { throw new HttpError(500, 'Gagal menjalankan bot: ' + e.message); }
  const r = { child, state: 'running', startedAt: Date.now(), crashes: cur ? cur.crashes : 0, timer: null };
  runtime.set(id, r);
  m.desired = 'running'; m.everStarted = true; m.lastState = undefined;
  await saveMeta(m);
  appendRun(id, [`[botlaunch] bot dijalankan: ${cmd === process.execPath ? 'node' : cmd} ${args.join(' ')}`]);
  logEvent('info', `Bot dijalankan: ${m.name}`, id);
  child.stdout.on('data', lineSink(id, ''));
  child.stderr.on('data', lineSink(id, ''));
  child.on('error', (e) => {
    appendRun(id, ['[botlaunch] gagal start: ' + (e.code === 'ENOENT' ? `"${cmd}" tidak ditemukan` : e.message)]);
  });
  child.on('exit', (code, sig) => onExit(id, r, code, sig));
  return true;
}
function onExit(id, r, code, sig) {
  if (runtime.get(id) !== r) return;
  const m = metas.get(id);
  if (!m) { runtime.delete(id); return; }
  if (r.state === 'stopping') { runtime.delete(id); m.lastState = 'stopped'; logEvent('info', `Bot dihentikan: ${m.name}`, id); return; }
  const up = Date.now() - r.startedAt;
  appendRun(id, [`[botlaunch] bot berhenti (kode ${code === null ? '-' : code}${sig ? ', sinyal ' + sig : ''}) setelah ${Math.round(up / 1000)} detik`]);
  if (code === 0) {
    runtime.delete(id); m.desired = 'stopped'; m.lastState = 'stopped'; saveMeta(m).catch(() => {});
    logEvent('info', `Bot selesai sendiri (kode 0): ${m.name}`, id);
    return;
  }
  r.crashes = up > 120000 ? 1 : r.crashes + 1;
  if (r.crashes > MAX_RESTARTS) {
    runtime.delete(id); m.desired = 'stopped'; m.lastState = 'error'; saveMeta(m).catch(() => {});
    appendRun(id, ['[botlaunch] bot crash berulang, auto-restart dihentikan. Periksa log di atas lalu tekan Start.']);
    logEvent('error', `Bot crash berulang, berhenti: ${m.name}`, id);
    return;
  }
  const delay = Math.min(60000, BACKOFF_MS * 2 ** (r.crashes - 1));
  r.state = 'backoff'; r.child = null;
  appendRun(id, [`[botlaunch] mencoba start ulang dalam ${Math.round(delay / 100) / 10} detik (percobaan ${r.crashes}/${MAX_RESTARTS})`]);
  logEvent('warn', `Bot crash, start ulang ${Math.round(delay / 100) / 10}s: ${m.name}`, id);
  r.timer = setTimeout(() => {
    startBot(id).catch((e) => { runtime.delete(id); appendRun(id, ['[botlaunch] ' + e.message]); });
  }, delay);
}
async function stopBot(id) {
  const m = need(id);
  m.desired = 'stopped';
  await saveMeta(m);
  const r = runtime.get(id);
  if (!r) return false;
  if (r.timer) { clearTimeout(r.timer); r.timer = null; }
  if (!r.child) { runtime.delete(id); m.lastState = 'stopped'; return true; }
  r.state = 'stopping';
  const child = r.child;
  const exited = new Promise((res) => child.once('exit', res));
  killTree(child, 'SIGTERM');
  const kt = setTimeout(() => killTree(child, 'SIGKILL'), 5000);
  await Promise.race([exited, sleep(9000)]);
  clearTimeout(kt);
  if (runtime.get(id) === r) runtime.delete(id);
  return true;
}
async function deleteProject(id) {
  const m = need(id);
  if (installing.has(id)) throw new HttpError(409, 'Install sedang berjalan.');
  await stopBot(id);
  metas.delete(id); envCache.delete(id); runBuf.delete(id);
  await fsp.rm(pdir(id), { recursive: true, force: true });
  logEvent('info', `Proyek dihapus: ${m.name}`, id);
}

// ---------------------------------------------------------------- backup (sesi WhatsApp ikut, node_modules & env tidak)
async function makeBackup(id) {
  const m = need(id);
  if (!m.extracted) throw new HttpError(400, 'Belum ada workspace untuk dibackup.');
  await fsp.mkdir(BACKUPS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const file = `${m.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'bot'}-${stamp}.zip`;
  try { await exec('zip', ['-qr', path.join(BACKUPS_DIR, file), '.', '-x', 'node_modules/*', '*/node_modules/*'], { cwd: appBase(id) }); }
  catch (e) { throw missingTool(e, 'zip', 'zip') || new HttpError(500, 'Gagal membuat backup.'); }
  const all = (await fsp.readdir(BACKUPS_DIR)).filter((f) => f.endsWith('.zip')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 10))) await fsp.rm(path.join(BACKUPS_DIR, old), { force: true });
  logEvent('info', `Backup dibuat: ${file}`, id);
  return file;
}

// ---------------------------------------------------------------- HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}
function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new HttpError(413, 'Body terlalu besar.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new HttpError(400, 'JSON tidak valid.')); } });
    req.on('error', reject);
  });
}
// Anti serangan dari website lain (CSRF / DNS rebinding): server ini punya hak menjalankan kode di HP.
function guard(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (LOOPBACK) {
    const okHost = [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`].includes(host);
    if (!okHost) throw new HttpError(403, 'Host tidak diizinkan.');
  }
  const origin = req.headers.origin;
  if (origin && origin !== 'http://' + host) throw new HttpError(403, 'Origin tidak diizinkan.');
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') throw new HttpError(403, 'Permintaan lintas-situs ditolak.');
}
function authed(req) {
  const m = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

async function api(req, res, url) {
  guard(req);
  const p = url.pathname.replace(/\/+$/, '');
  const method = req.method;
  if (p === '/api/session' && method === 'GET') return sendJson(res, 200, { authRequired: !!TOKEN, runnerEnabled: true, runnerRequested: true });
  if (TOKEN && !authed(req)) throw new HttpError(401, 'Token tidak valid.');

  if (p === '/api/projects' && method === 'GET') return sendJson(res, 200, { projects: [...metas.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(view) });
  if (p === '/api/logs' && method === 'GET') {
    const pid = url.searchParams.get('projectId') || url.searchParams.get('project');
    const list = events.filter((e) => !pid || e.projectId === pid || !e.projectId).slice(-200);
    return sendJson(res, 200, { logs: list.map(({ level, message, time }) => ({ level, message, time })) });
  }
  if (p === '/api/analyze' && method === 'POST') return sendJson(res, 200, { project: view(await createProject(req)) });

  let m;
  if ((m = /^\/api\/downloads\/([^/]+)$/.exec(p)) && method === 'GET') {
    const f = decodeURIComponent(m[1]);
    if (!/^[A-Za-z0-9._-]+\.zip$/.test(f)) throw new HttpError(400, 'Nama file tidak valid.');
    const fp = path.join(BACKUPS_DIR, f);
    let st; try { st = await fsp.stat(fp); } catch { throw new HttpError(404, 'File tidak ditemukan.'); }
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${f}"`, 'Cache-Control': 'no-store' });
    return fs.createReadStream(fp).pipe(res);
  }
  if ((m = /^\/api\/projects\/([^/]+)\/(setup|install|start|stop|restart|delete|backup)$/.exec(p)) && method === 'POST') {
    const id = m[1], action = m[2];
    const pj = need(id);
    if (action === 'setup') { await setupWorkspace(id); return sendJson(res, 200, { message: 'Workspace disiapkan.', project: view(pj) }); }
    if (action === 'install') { await installDeps(id); return sendJson(res, 200, { message: 'Dependencies terpasang.', project: view(pj) }); }
    if (action === 'start') { const started = await startBot(id); return sendJson(res, 200, { message: started ? 'Bot dijalankan. Lihat Bot console.' : 'Bot sudah berjalan.', project: view(pj) }); }
    if (action === 'stop') { const was = await stopBot(id); return sendJson(res, 200, { message: was ? 'Bot dihentikan.' : 'Bot memang tidak berjalan.', project: view(pj) }); }
    if (action === 'restart') { await stopBot(id); await startBot(id); return sendJson(res, 200, { message: 'Bot dijalankan ulang.', project: view(pj) }); }
    if (action === 'delete') { await deleteProject(id); return sendJson(res, 200, { message: 'Proyek dihapus.' }); }
    if (action === 'backup') { const f = await makeBackup(id); return sendJson(res, 200, { message: 'Backup dibuat. Nilai environment tidak ikut.', downloadUrl: '/api/downloads/' + encodeURIComponent(f) }); }
  }
  if ((m = /^\/api\/projects\/([^/]+)\/runlog$/.exec(p)) && method === 'GET') { need(m[1]); return sendJson(res, 200, { lines: tailLines(m[1]).slice(-300) }); }
  if ((m = /^\/api\/projects\/([^/]+)\/env$/.exec(p))) {
    const id = m[1]; need(id);
    if (method === 'GET') return sendJson(res, 200, { set: Object.keys(getEnv(id)) });
    if (method === 'PUT') {
      const body = await readJson(req);
      const env = { ...getEnv(id) };
      const set = body.set && typeof body.set === 'object' ? body.set : {};
      for (const [k, v] of Object.entries(set)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new HttpError(400, `Nama variabel tidak valid: ${k}`);
        if (/^(PATH|HOME|LD_PRELOAD|LD_LIBRARY_PATH)$/i.test(k)) throw new HttpError(400, `Nama variabel dilindungi: ${k}`);
        if (typeof v !== 'string' || v.length > 10000) throw new HttpError(400, `Nilai ${k} tidak valid.`);
        env[k] = v;
      }
      for (const k of Array.isArray(body.remove) ? body.remove : []) delete env[String(k)];
      if (Object.keys(env).length > 100) throw new HttpError(400, 'Terlalu banyak variabel (maks 100).');
      await writeJsonAtomic(path.join(pdir(id), 'env.json'), env, 0o600);
      envCache.set(id, env);
      return sendJson(res, 200, { set: Object.keys(env), message: 'Tersimpan. Restart bot agar berlaku.' });
    }
  }
  throw new HttpError(404, 'Endpoint tidak ditemukan.');
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method tidak didukung.');
  let rel = decodeURIComponent(url.pathname);
  if (rel.includes('\0')) throw new HttpError(400, 'Path tidak valid.');
  let fp = path.join(PUBLIC_DIR, rel === '/' ? 'index.html' : rel);
  if (fp !== PUBLIC_DIR && !fp.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Dilarang.');
  let st = await fsp.stat(fp).catch(() => null);
  if (!st || !st.isFile()) { fp = path.join(PUBLIC_DIR, 'index.html'); st = await fsp.stat(fp); } // fallback SPA
  const ext = path.extname(fp).toLowerCase();
  const immutable = rel.startsWith('/assets/');
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(fp).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await api(req, res, url);
    else await serveStatic(req, res, url);
  } catch (e) {
    if (res.headersSent) { res.end(); return; }
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (status === 413) { res.setHeader('Connection', 'close'); res.on('finish', () => req.destroy()); }
    sendJson(res, status, { error: status === 500 ? 'Kesalahan server.' : e.message });
  }
});

async function shutdown() {
  console.log('\nMenghentikan bot...');
  for (const r of runtime.values()) { if (r.timer) clearTimeout(r.timer); if (r.child) { r.state = 'stopping'; killTree(r.child, 'SIGTERM'); } }
  await sleep(1500);
  for (const r of runtime.values()) if (r.child) killTree(r.child, 'SIGKILL');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

(async () => {
  await fsp.mkdir(HOME_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  for (const f of await fsp.readdir(TMP_DIR).catch(() => [])) fsp.rm(path.join(TMP_DIR, f), { force: true });
  loadEvents();
  await loadProjects();
  for (const tool of [['unzip', ['-v']], ['zip', ['-v']], ['npm', ['-v']]]) {
    try { await exec(tool[0], tool[1]); } catch { console.warn(`PERINGATAN: "${tool[0]}" tidak ditemukan. Jalankan: pkg install nodejs unzip zip`); }
  }
  server.listen(PORT, HOST, () => {
    console.log('\n  BOTLAUNCH Lokal siap');
    console.log(`  Buka di Chrome : http://localhost:${PORT}`);
    console.log(`  Data           : ${HOME_DIR}`);
    console.log('  Hentikan       : Ctrl+C\n');
    logEvent('info', `Server lokal berjalan di port ${PORT}`);
    // hidupkan lagi bot yang tadinya jalan (mis. setelah Termux/HP restart)
    let i = 0;
    for (const m of metas.values()) {
      if (m.desired === 'running' && m.extracted) setTimeout(() => startBot(m.projectId).catch((e) => logEvent('error', `Auto-start gagal (${m.name}): ${e.message}`, m.projectId)), 1500 * ++i);
    }
  });
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} sudah dipakai. BOTLAUNCH mungkin sudah berjalan.` : e);
    process.exit(1);
  });
})();
