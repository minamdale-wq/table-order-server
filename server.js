'use strict';
/*
 * 테이블 오더 미니 서버
 * - Node.js 18 이상, 외부 패키지 없음 (node server.js 로 실행)
 * - 같은 와이파이의 태블릿들이 http://<이 컴퓨터 IP>:8765 으로 접속 (막혀 있으면 서버가 다른 포트로 옮김)
 * - 데이터는 이 폴더의 data/ 안에 저장 (snapshot.json + journal.jsonl, 매일 backups/)
 */
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), { spawnSync } = require('child_process');

let PORT = Number(process.env.PORT) || 8765;
const PORT_CANDIDATES = [Number(process.env.PORT) || 0, 8765, 8899, 9080, 18080, 28080].filter((v, i, a) => v && a.indexOf(v) === i);
const ROOT = __dirname, PUB = path.join(ROOT, 'public');
const DATA = process.env.TOD_DATA || path.join(ROOT, 'data');
const UP = path.join(DATA, 'uploads'), BK = path.join(DATA, 'backups');
const VERS = path.join(DATA, 'versions');
for (const d of [DATA, UP, BK, VERS]) fs.mkdirSync(d, { recursive: true });
const UPDATE_SRC = (process.env.TOD_UPDATE_URL || 'https://raw.githubusercontent.com/minamdale-wq/table-order-server/main/').replace(/\/?$/, '/');
const SUPERVISED = process.env.TOD_SUPERVISED === '1';
const UPDATABLE = ['server.js', 'public/index.html', 'version.json', 'README.md', 'start-windows.bat', 'start-mac.command', 'table-order.service', 'public/closed.jpg'];
const SNAP = path.join(DATA, 'snapshot.json'), JOUR = path.join(DATA, 'journal.jsonl');
const CONF = path.join(DATA, 'server.json'), ALIVE = path.join(DATA, 'alive.txt');
const VERSION = '1.1.1', MAX_UPLOAD = 2 * 1024 ** 3, MAX_DOC = 256 * 1024, KEEP_BACKUPS = 60;
const TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const EXT_TYPE = Object.fromEntries(Object.entries(TYPES).map(([t, e]) => [e, t]));

const log = (...a) => console.log('[' + new Date().toLocaleString('ko-KR') + ']', ...a);
const pad = n => String(n).padStart(2, '0');
const dayKey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
class E extends Error { constructor(status, code, msg) { super(msg); this.status = status; this.code = code; } }

/* ---------------- 저장소 ---------------- */
const store = new Map(); // 경로 -> { data, version, updatedAt }
let jfd = null, jcount = 0;

function restoreLatestBackup() {
  const files = fs.readdirSync(BK).filter(f => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort();
  if (!files.length) return;
  const f = files[files.length - 1];
  try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(BK, f), 'utf8')))) store.set(k, v); log('백업에서 복구했습니다:', f); }
  catch (e) { log('백업 복구 실패:', e.message); }
}
function loadStore() {
  if (fs.existsSync(SNAP)) {
    try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(SNAP, 'utf8')))) store.set(k, v); }
    catch (e) { log('저장 파일을 읽지 못했습니다:', e.message); fs.renameSync(SNAP, SNAP + '.broken-' + Date.now()); restoreLatestBackup(); }
  }
  if (fs.existsSync(JOUR)) {
    for (const line of fs.readFileSync(JOUR, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e.v === null) store.delete(e.p); else store.set(e.p, e.v); } catch (e) { /* 정전 등으로 잘린 마지막 줄은 무시 */ }
    }
  }
  compact();
}
function compact() {
  const tmp = SNAP + '.tmp', fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, JSON.stringify(Object.fromEntries(store)));
  fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(tmp, SNAP);
  if (jfd !== null) fs.closeSync(jfd);
  jfd = fs.openSync(JOUR, 'w'); jcount = 0;
}
function journal(ch) {
  fs.writeSync(jfd, ch.map(c => JSON.stringify(c)).join('\n') + '\n');
  try { fs.fsyncSync(jfd); } catch (e) { }
  jcount += ch.length;
  if (jcount >= 2000) compact();
}
function dailyBackup() {
  const f = path.join(BK, dayKey(new Date()) + '.json');
  if (fs.existsSync(f)) return;
  fs.writeFileSync(f, JSON.stringify(Object.fromEntries(store)));
  const all = fs.readdirSync(BK).filter(x => /^\d{4}-\d\d-\d\d\.json$/.test(x)).sort();
  while (all.length > KEEP_BACKUPS) fs.unlinkSync(path.join(BK, all.shift()));
  log('하루 백업 저장:', path.basename(f));
}

/* 경로 규칙: 문서 = 짝수 칸(orders/o1), 모음 = 홀수 칸(orders) */
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const segs = p => (typeof p === 'string' && p.length <= 1000) ? p.split('/') : null;
const okSegs = s => s && s.length <= 16 && s.every(x => SEG.test(x) && x !== '.' && x !== '..');
const isDoc = p => { const s = segs(p); return okSegs(s) && s.length % 2 === 0; };
const isCol = p => { const s = segs(p); return okSegs(s) && s.length % 2 === 1; };
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function merge(a, b) {
  const o = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    if (isObj(v) && v.__delete__ === true) { delete o[k]; continue; }
    o[k] = (isObj(v) && isObj(o[k])) ? merge(o[k], v) : v;
  }
  return o;
}
function cmp(a, op, v) {
  switch (op) {
    case '==': case 'eq': return a === v;
    case '!=': case 'ne': return a !== v;
    case '<': case 'lt': return a < v;
    case '<=': case 'lte': return a <= v;
    case '>': case 'gt': return a > v;
    case '>=': case 'gte': return a >= v;
    case 'in': return Array.isArray(v) && v.includes(a);
    case 'not-in': return Array.isArray(v) && !v.includes(a);
    case 'array-contains': return Array.isArray(a) && a.includes(v);
    default: throw new E(400, 'invalid_argument', '지원하지 않는 조건: ' + op);
  }
}
function query(q) {
  if (!isCol(q.col)) throw new E(400, 'invalid_argument', '모음 경로 오류');
  const where = Array.isArray(q.where) ? q.where : [];
  if (where.length > 10) throw new E(400, 'invalid_argument', '조건이 너무 많습니다');
  const depth = q.col.split('/').length + 1, pre = q.col + '/';
  let docs = [];
  for (const [p, v] of store) if (p.startsWith(pre) && p.split('/').length === depth) docs.push({ id: p.slice(pre.length), ...v });
  for (const [f, op, val] of where) docs = docs.filter(d => cmp(d.data[f], op, val));
  if (Array.isArray(q.order)) {
    const [f, dir] = q.order, s = dir === 'desc' ? -1 : 1;
    docs.sort((a, b) => { const x = a.data[f], y = b.data[f]; if (x === undefined) return 1; if (y === undefined) return -1; return (x < y ? -1 : x > y ? 1 : 0) * s; });
  } else docs.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const lim = Number(q.limit);
  if (lim > 0) docs = docs.slice(0, Math.min(lim, 1000));
  return docs;
}

/* 관리 PIN 없이 할 수 있는 쓰기: 고객 주문 생성, 직원 호출, 장애 기록, 부팅 시각 */
const sameOrder = (cur, d) => !!(cur && cur.data && d && cur.data.createdAt !== undefined && cur.data.tabletId === d.tabletId && cur.data.createdAt === d.createdAt);
function allowed(o, cur) {
  const s = o.path.split('/'); if (s.length !== 2) return false;
  const col = s[0], d = o.data || {};
  if (o.op === 'set' && !cur) {
    if (col === 'orders') return d.status === 'new' && d.pay === 'unpaid';
    if (col === 'calls') return d.status === 'open';
    if (col === 'incidents') return true;
  }
  if (o.op === 'set' && cur && col === 'orders') return sameOrder(cur, d);
  if (o.op === 'update' && cur && col === 'tablets') return Object.keys(d).every(k => k === 'lastBoot');
  return false;
}
function applyOps(ops, admin) {
  if (!Array.isArray(ops) || !ops.length || ops.length > 50) throw new E(400, 'invalid_argument', '쓰기 요청 오류');
  for (const o of ops) {
    if (!o || !['set', 'update', 'delete'].includes(o.op) || !isDoc(o.path)) throw new E(400, 'invalid_argument', '잘못된 쓰기');
    if (o.op !== 'delete' && !isObj(o.data)) throw new E(400, 'invalid_argument', '문서 형식 오류');
    if (o.op !== 'delete' && JSON.stringify(o.data).length > MAX_DOC) throw new E(400, 'invalid_argument', '문서가 너무 큽니다');
    const cur = store.get(o.path);
    if (o.op === 'update' && !cur) throw new E(400, 'invalid_argument', '없는 문서입니다');
    if (!admin && o.path.startsWith('orders/') && o.op === 'set' && !cur) { const cfg = store.get('config/main'); if (cfg && cfg.data && cfg.data.open === false) throw new E(403, 'store_closed', '지금은 영업 준비 중이라 주문을 받지 않습니다'); }
    if (!admin && !allowed(o, cur)) throw new E(403, 'not_permitted', '관리 PIN이 필요합니다');
  }
  const now = Date.now(), ch = [], printQ = [];
  for (const o of ops) {
    const cur = store.get(o.path);
    if (o.path.startsWith('orders/') && o.op !== 'delete') {
      const before = cur && cur.data ? cur.data.status : null, after = o.op === 'set' ? o.data.status : (o.data.status !== undefined ? o.data.status : before);
      if (before === 'new' && after === 'accepted') printQ.push({ path: o.path, when: 'accept' });
      if (!cur && after === 'new') printQ.push({ path: o.path, when: 'new' });
    }
    if (o.path.startsWith('calls/') && o.op === 'set' && !cur && o.data.status === 'open') printQ.push({ path: o.path, when: 'call' });
    if (o.op === 'delete') { if (!cur) continue; store.delete(o.path); ch.push({ p: o.path, v: null }); continue; }
    if (o.op === 'set' && o.path.startsWith('orders/') && sameOrder(cur, o.data)) continue; // 같은 주문 재전송은 무시
    const v = { data: o.op === 'set' ? o.data : merge(cur.data, o.data), version: (cur ? cur.version : 0) + 1, updatedAt: now };
    store.set(o.path, v); ch.push({ p: o.path, v });
  }
  if (ch.length) { journal(ch); broadcast('change', { paths: ch.map(c => c.p) }); }
  for (const q of printQ) setImmediate(() => autoPrint(q.path, q.when));
}
const sysWrite = ops => { try { applyOps(ops, true); } catch (e) { log('기록 실패', e.message); } };


/* ---------------- 주문서 프린터: COM 포트(시리얼) ESC/POS ---------------- */
const { execFile } = require('child_process');
const execFileP = (cmd, args, opt) => new Promise((ok, no) => execFile(cmd, args, { timeout: 15000, windowsHide: true, ...(opt || {}) }, (e, so, se) => e ? no(Object.assign(e, { out: String(so || '') + String(se || '') })) : ok(String(so || ''))));
let KR = null;
function krMap() {
  if (KR) return KR; KR = new Map();
  try { const dec = new TextDecoder('euc-kr'); for (let a = 0x81; a <= 0xFE; a++) for (let b = 0x41; b <= 0xFE; b++) { const c = dec.decode(Buffer.from([a, b])); if (c.length === 1 && c !== '�' && !KR.has(c)) KR.set(c, [a, b]); } } catch (e) { log('한글 인코딩 표를 만들지 못했습니다:', e.message); }
  return KR;
}
function encKR(str) { const m = krMap(), out = []; for (const ch of String(str)) { const c = ch.codePointAt(0); if (c < 0x80) { out.push(c); continue; } const v = m.get(ch); if (v) out.push(v[0], v[1]); else out.push(0x3F); } return Buffer.from(out); }
const dw = s => [...String(s)].reduce((n, ch) => n + (ch.codePointAt(0) < 0x80 ? 1 : 2), 0);
function cutW(s, w) { let r = '', n = 0; for (const ch of String(s)) { const k = ch.codePointAt(0) < 0x80 ? 1 : 2; if (n + k > w) break; r += ch; n += k; } return r; }
function wrapW(s, w) { const out = []; let line = '', n = 0; for (const ch of String(s)) { const k = ch.codePointAt(0) < 0x80 ? 1 : 2; if (n + k > w) { out.push(line); line = ''; n = 0; } line += ch; n += k; } if (line) out.push(line); return out.length ? out : ['']; }
function lr(l, r, w) { const sp = w - dw(l) - dw(r); if (sp >= 1) return l + ' '.repeat(sp) + r; const ls = wrapW(l, w); return ls.join('\n') + '\n' + ' '.repeat(Math.max(0, w - dw(r))) + r; }
const wonS = n => (Number(n) || 0).toLocaleString('ko-KR') + '원';
function roomName(o) { const t = store.get('tablets/' + o.tabletId); const d = t && t.data ? t.data : {}; return String(d.voiceName || (d.role !== 'counter' && Number(d.no) ? d.no + '번방' : '') || o.place || o.tabletName || o.tabletId || '').trim(); }
function receipt(o, pc, opts) {
  const W = pc.paper === '58' ? 32 : pc.paper === '80n' ? 42 : 48, ESC = 0x1B, GS = 0x1D, FS = 0x1C, parts = [];
  const raw = (...b) => parts.push(Buffer.from(b)), txt = s => parts.push(encKR(s));
  const cfg = (store.get('config/main') || {}).data || {};
  raw(ESC, 0x40); if (pc.kor !== false) raw(FS, 0x26);
  raw(ESC, 0x61, 1); raw(GS, 0x21, 0x11); txt((opts && opts.title) || '주 문 서'); txt('\n'); raw(GS, 0x21, 0);
  if (cfg.storeName) txt(cfg.storeName + '\n');
  txt('\n'); raw(GS, 0x21, 0x11); txt(cutW(roomName(o), Math.floor(W / 2)) + '\n'); raw(GS, 0x21, 0);
  raw(ESC, 0x61, 0);
  const d = new Date(o.createdAt || Date.now()), hm = d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  txt('-'.repeat(W) + '\n'); txt(lr('주문 ' + hm, o.test ? '[테스트]' : ('#' + String(o.id || '').slice(-4)), W) + '\n'); txt('-'.repeat(W) + '\n');
  for (const it of (o.items || [])) {
    raw(GS, 0x21, 0x01); txt(lr(String(it.name || '') + ' x' + (it.qty || 1), wonS((it.unit || 0) * (it.qty || 1)), W) + '\n'); raw(GS, 0x21, 0);
    for (const op of (it.opts || [])) txt(cutW('   - ' + (op.g ? op.g + ': ' : '') + op.n + (op.p ? ' (+' + wonS(op.p) + ')' : ''), W) + '\n');
  }
  txt('-'.repeat(W) + '\n'); raw(GS, 0x21, 0x01); txt(lr('합계', wonS(o.total), W) + '\n'); raw(GS, 0x21, 0);
  if (o.memo) for (const l of wrapW('요청: ' + o.memo, W)) txt(l + '\n');
  txt('결제: 후불 (카운터)\n');
  raw(ESC, 0x64, 4); if (pc.cut !== false) raw(GS, 0x56, 0x42, 0x00);
  return Buffer.concat(parts);
}
async function serialWrite(pc, buf) {
  const port = String(pc.port || '').trim(), baud = Number(pc.baud) || 9600;
  if (!port) throw new E(400, 'no_port', '프린터 COM 포트가 정해지지 않았습니다');
  let dev;
  if (process.platform === 'win32') {
    if (!/^COM\d{1,3}$/i.test(port)) throw new E(400, 'bad_port', '포트 이름은 COM3처럼 넣어 주세요');
    try { await execFileP('cmd', ['/c', 'mode', port.toUpperCase() + ':', 'BAUD=' + baud, 'PARITY=N', 'DATA=8', 'STOP=1', 'TO=ON', 'DTR=ON', 'RTS=ON']); }
    catch (e) { throw new E(500, 'port_mode', port + ' 포트를 열 수 없습니다. 포트 이름이 맞는지, 다른 프로그램(포스 등)이 쓰고 있지 않은지 확인해 주세요'); }
    dev = '\\\\.\\' + port.toUpperCase();
  } else {
    if (!/^\/dev\/[\w.\-]+$/.test(port)) throw new E(400, 'bad_port', '포트 이름 오류');
    await execFileP('stty', [process.platform === 'darwin' ? '-f' : '-F', port, String(baud), 'raw', '-echo']).catch(() => { });
    dev = port;
  }
  let fh;
  try { fh = await fs.promises.open(dev, 'w'); }
  catch (e) { throw new E(500, 'port_open', port + ' 포트를 열 수 없습니다 (' + (e.code || e.message) + '). 다른 프로그램이 쓰고 있거나 포트 이름이 다릅니다'); }
  try {
    await Promise.race([fh.write(buf), new Promise((_, no) => setTimeout(() => no(new E(504, 'print_timeout', '프린터가 응답하지 않습니다. 전원·케이블·속도(Baud)를 확인해 주세요')), 15000))]);
  } finally { fh.close().catch(() => { }); }
}
let printChain = Promise.resolve();
function printJob(pc, buf, label) {
  const copies = Math.max(1, Math.min(3, Number(pc.copies) || 1));
  const job = printChain.then(async () => { for (let i = 0; i < copies; i++) await serialWrite(pc, buf); log('주문서 출력:', label); });
  printChain = job.catch(() => { });
  return job;
}
function printFail(label, e) {
  log('주문서 출력 실패:', label, e.message);
  const at = Date.now();
  sysWrite([{ op: 'set', path: 'incidents/p' + at.toString(36), data: { tabletId: 'printer', tabletName: '주문서 프린터', kind: '프린터 오류', source: 'server', at, endAt: at, note: label + ' · ' + e.message, dateKey: dayKey(new Date(at)) } }]);
}
function callSlip(c, pc) {
  const W = pc.paper === '58' ? 32 : pc.paper === '80n' ? 42 : 48, ESC = 0x1B, GS = 0x1D, FS = 0x1C, parts = [];
  const raw = (...b) => parts.push(Buffer.from(b)), txt = s => parts.push(encKR(s));
  raw(ESC, 0x40); if (pc.kor !== false) raw(FS, 0x26);
  raw(ESC, 0x61, 1); raw(GS, 0x21, 0x11); txt('직 원 호 출\n\n'); txt(cutW(roomName(c), Math.floor(W / 2)) + '\n'); raw(GS, 0x21, 0);
  if (c.reason) { raw(GS, 0x21, 0x01); txt('\n' + cutW(c.reason, W) + '\n'); raw(GS, 0x21, 0); }
  const d = new Date(c.at || Date.now());
  txt('\n' + d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + (c.test ? '  [테스트]' : '') + '\n');
  raw(ESC, 0x61, 0); raw(ESC, 0x64, 4); if (pc.cut !== false) raw(GS, 0x56, 0x42, 0x00);
  return Buffer.concat(parts);
}
function autoPrint(p, when) {
  const cfg = (store.get('config/main') || {}).data || {}, pc = cfg.printer || {};
  if (!pc.on || !pc.port) return;
  if (when === 'call') {
    if (pc.calls === false) return;
    const d = store.get(p); if (!d || !d.data) return;
    const c = { id: p.split('/')[1], ...d.data };
    printJob({ ...pc, copies: 1 }, callSlip(c, pc), roomName(c) + ' 직원 호출').catch(e => printFail(roomName(c) + ' 호출', e));
    return;
  }
  if ((pc.when || 'new') !== when) return;
  const d = store.get(p); if (!d || !d.data) return;
  const o = { id: p.split('/')[1], ...d.data };
  printJob(pc, receipt(o, pc), roomName(o) + ' ' + (o.items || []).length + '개 메뉴').catch(e => printFail(roomName(o), e));
}
async function listPorts() {
  if (process.platform === 'win32') {
    try { const out = await execFileP('powershell', ['-NoProfile', '-Command', '[System.IO.Ports.SerialPort]::GetPortNames() -join ","']); return [...new Set(out.trim().split(',').map(x => x.trim()).filter(Boolean))].sort(); }
    catch (e) { const out = await execFileP('cmd', ['/c', 'mode']).catch(() => ''); return [...new Set((out.match(/COM\d+/g) || []))].sort(); }
  }
  try { return fs.readdirSync('/dev').filter(n => /^(cu\.|tty\.usb|ttyUSB|ttyACM|ttyS\d)/.test(n)).map(n => '/dev/' + n); } catch (e) { return []; }
}
setTimeout(() => { try {
  const c = store.get('config/main'); const pc = c && c.data && c.data.printer;
  if (pc && !pc.m146) { sysWrite([{ op: 'update', path: 'config/main', data: { printer: { ...pc, when: pc.when === 'accept' ? 'new' : (pc.when || 'new'), calls: pc.calls !== false, m146: true } } }]); log('프린터 설정: 주문이 들어오면 바로 출력, 직원 호출도 출력으로 바꿨습니다'); }
} catch (e) { } }, 1500);
/* ---------------- 손님 태블릿 안내 음성: 윈도우 한국어 음성(SAPI)으로 WAV 생성 ---------------- */
const TTSDIR = path.join(DATA, 'tts');
async function ttsWav(text) {
  if (process.platform !== 'win32') throw new E(404, 'no_tts', '이 서버에서는 음성을 만들 수 없습니다');
  const f = path.join(TTSDIR, crypto.createHash('sha1').update(text).digest('hex').slice(0, 20) + '.wav');
  if (fs.existsSync(f)) return f;
  fs.mkdirSync(TTSDIR, { recursive: true });
  const ps = "Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $v=$s.GetInstalledVoices()|Where-Object{$_.VoiceInfo.Culture.Name -eq 'ko-KR'}|Select-Object -First 1; if(-not $v){exit 3}; $s.SelectVoice($v.VoiceInfo.Name); $s.Rate=0; $s.SetOutputToWaveFile($env:TOD_TTS_OUT); $s.Speak($env:TOD_TTS_TEXT); $s.Dispose()";
  await execFileP('powershell', ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { env: { ...process.env, TOD_TTS_OUT: f + '.tmp', TOD_TTS_TEXT: text } })
    .catch(e => { throw new E(404, 'no_tts', '한국어 음성을 만들 수 없습니다'); });
  fs.renameSync(f + '.tmp', f); return f;
}
function ttsAllowed(t) { const v = ((store.get('config/main') || {}).data || {}).voice || {}; return [v.custOrder, v.custCall, '주문이 접수되었습니다. 조리를 시작합니다.', '직원이 곧 도착합니다.'].includes(t); }


/* ---------------- QR 결제 (지금은 테스트 모드 · 나중에 포스/PG 연동) ---------------- */
// QR 코드 그리기: qrcode-generator (MIT, Kazuhiko Arase) 를 그대로 넣음
const qrcodeLib = (function () {
//---------------------------------------------------------------------
//
// QR Code Generator for JavaScript
//
// Copyright (c) 2009 Kazuhiko Arase
//
// URL: http://www.d-project.com/
//
// Licensed under the MIT license:
//  http://www.opensource.org/licenses/mit-license.php
//
// The word 'QR Code' is registered trademark of
// DENSO WAVE INCORPORATED
//  http://www.denso-wave.com/qrcode/faqpatent-e.html
//
//---------------------------------------------------------------------

var qrcode = function() {

  //---------------------------------------------------------------------
  // qrcode
  //---------------------------------------------------------------------

  /**
   * qrcode
   * @param typeNumber 1 to 40
   * @param errorCorrectionLevel 'L','M','Q','H'
   */
  var qrcode = function(typeNumber, errorCorrectionLevel) {

    var PAD0 = 0xEC;
    var PAD1 = 0x11;

    var _typeNumber = typeNumber;
    var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
    var _modules = null;
    var _moduleCount = 0;
    var _dataCache = null;
    var _dataList = [];

    var _this = {};

    var makeImpl = function(test, maskPattern) {

      _moduleCount = _typeNumber * 4 + 17;
      _modules = function(moduleCount) {
        var modules = new Array(moduleCount);
        for (var row = 0; row < moduleCount; row += 1) {
          modules[row] = new Array(moduleCount);
          for (var col = 0; col < moduleCount; col += 1) {
            modules[row][col] = null;
          }
        }
        return modules;
      }(_moduleCount);

      setupPositionProbePattern(0, 0);
      setupPositionProbePattern(_moduleCount - 7, 0);
      setupPositionProbePattern(0, _moduleCount - 7);
      setupPositionAdjustPattern();
      setupTimingPattern();
      setupTypeInfo(test, maskPattern);

      if (_typeNumber >= 7) {
        setupTypeNumber(test);
      }

      if (_dataCache == null) {
        _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
      }

      mapData(_dataCache, maskPattern);
    };

    var setupPositionProbePattern = function(row, col) {

      for (var r = -1; r <= 7; r += 1) {

        if (row + r <= -1 || _moduleCount <= row + r) continue;

        for (var c = -1; c <= 7; c += 1) {

          if (col + c <= -1 || _moduleCount <= col + c) continue;

          if ( (0 <= r && r <= 6 && (c == 0 || c == 6) )
              || (0 <= c && c <= 6 && (r == 0 || r == 6) )
              || (2 <= r && r <= 4 && 2 <= c && c <= 4) ) {
            _modules[row + r][col + c] = true;
          } else {
            _modules[row + r][col + c] = false;
          }
        }
      }
    };

    var getBestMaskPattern = function() {

      var minLostPoint = 0;
      var pattern = 0;

      for (var i = 0; i < 8; i += 1) {

        makeImpl(true, i);

        var lostPoint = QRUtil.getLostPoint(_this);

        if (i == 0 || minLostPoint > lostPoint) {
          minLostPoint = lostPoint;
          pattern = i;
        }
      }

      return pattern;
    };

    var setupTimingPattern = function() {

      for (var r = 8; r < _moduleCount - 8; r += 1) {
        if (_modules[r][6] != null) {
          continue;
        }
        _modules[r][6] = (r % 2 == 0);
      }

      for (var c = 8; c < _moduleCount - 8; c += 1) {
        if (_modules[6][c] != null) {
          continue;
        }
        _modules[6][c] = (c % 2 == 0);
      }
    };

    var setupPositionAdjustPattern = function() {

      var pos = QRUtil.getPatternPosition(_typeNumber);

      for (var i = 0; i < pos.length; i += 1) {

        for (var j = 0; j < pos.length; j += 1) {

          var row = pos[i];
          var col = pos[j];

          if (_modules[row][col] != null) {
            continue;
          }

          for (var r = -2; r <= 2; r += 1) {

            for (var c = -2; c <= 2; c += 1) {

              if (r == -2 || r == 2 || c == -2 || c == 2
                  || (r == 0 && c == 0) ) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        }
      }
    };

    var setupTypeNumber = function(test) {

      var bits = QRUtil.getBCHTypeNumber(_typeNumber);

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
      }

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    };

    var setupTypeInfo = function(test, maskPattern) {

      var data = (_errorCorrectionLevel << 3) | maskPattern;
      var bits = QRUtil.getBCHTypeInfo(data);

      // vertical
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 6) {
          _modules[i][8] = mod;
        } else if (i < 8) {
          _modules[i + 1][8] = mod;
        } else {
          _modules[_moduleCount - 15 + i][8] = mod;
        }
      }

      // horizontal
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 8) {
          _modules[8][_moduleCount - i - 1] = mod;
        } else if (i < 9) {
          _modules[8][15 - i - 1 + 1] = mod;
        } else {
          _modules[8][15 - i - 1] = mod;
        }
      }

      // fixed module
      _modules[_moduleCount - 8][8] = (!test);
    };

    var mapData = function(data, maskPattern) {

      var inc = -1;
      var row = _moduleCount - 1;
      var bitIndex = 7;
      var byteIndex = 0;
      var maskFunc = QRUtil.getMaskFunction(maskPattern);

      for (var col = _moduleCount - 1; col > 0; col -= 2) {

        if (col == 6) col -= 1;

        while (true) {

          for (var c = 0; c < 2; c += 1) {

            if (_modules[row][col - c] == null) {

              var dark = false;

              if (byteIndex < data.length) {
                dark = ( ( (data[byteIndex] >>> bitIndex) & 1) == 1);
              }

              var mask = maskFunc(row, col - c);

              if (mask) {
                dark = !dark;
              }

              _modules[row][col - c] = dark;
              bitIndex -= 1;

              if (bitIndex == -1) {
                byteIndex += 1;
                bitIndex = 7;
              }
            }
          }

          row += inc;

          if (row < 0 || _moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    };

    var createBytes = function(buffer, rsBlocks) {

      var offset = 0;

      var maxDcCount = 0;
      var maxEcCount = 0;

      var dcdata = new Array(rsBlocks.length);
      var ecdata = new Array(rsBlocks.length);

      for (var r = 0; r < rsBlocks.length; r += 1) {

        var dcCount = rsBlocks[r].dataCount;
        var ecCount = rsBlocks[r].totalCount - dcCount;

        maxDcCount = Math.max(maxDcCount, dcCount);
        maxEcCount = Math.max(maxEcCount, ecCount);

        dcdata[r] = new Array(dcCount);

        for (var i = 0; i < dcdata[r].length; i += 1) {
          dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
        }
        offset += dcCount;

        var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
        var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);

        var modPoly = rawPoly.mod(rsPoly);
        ecdata[r] = new Array(rsPoly.getLength() - 1);
        for (var i = 0; i < ecdata[r].length; i += 1) {
          var modIndex = i + modPoly.getLength() - ecdata[r].length;
          ecdata[r][i] = (modIndex >= 0)? modPoly.getAt(modIndex) : 0;
        }
      }

      var totalCodeCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalCodeCount += rsBlocks[i].totalCount;
      }

      var data = new Array(totalCodeCount);
      var index = 0;

      for (var i = 0; i < maxDcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < dcdata[r].length) {
            data[index] = dcdata[r][i];
            index += 1;
          }
        }
      }

      for (var i = 0; i < maxEcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < ecdata[r].length) {
            data[index] = ecdata[r][i];
            index += 1;
          }
        }
      }

      return data;
    };

    var createData = function(typeNumber, errorCorrectionLevel, dataList) {

      var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);

      var buffer = qrBitBuffer();

      for (var i = 0; i < dataList.length; i += 1) {
        var data = dataList[i];
        buffer.put(data.getMode(), 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
        data.write(buffer);
      }

      // calc num max data.
      var totalDataCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalDataCount += rsBlocks[i].dataCount;
      }

      if (buffer.getLengthInBits() > totalDataCount * 8) {
        throw 'code length overflow. ('
          + buffer.getLengthInBits()
          + '>'
          + totalDataCount * 8
          + ')';
      }

      // end code
      if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
        buffer.put(0, 4);
      }

      // padding
      while (buffer.getLengthInBits() % 8 != 0) {
        buffer.putBit(false);
      }

      // padding
      while (true) {

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD0, 8);

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD1, 8);
      }

      return createBytes(buffer, rsBlocks);
    };

    _this.addData = function(data, mode) {

      mode = mode || 'Byte';

      var newData = null;

      switch(mode) {
      case 'Numeric' :
        newData = qrNumber(data);
        break;
      case 'Alphanumeric' :
        newData = qrAlphaNum(data);
        break;
      case 'Byte' :
        newData = qr8BitByte(data);
        break;
      case 'Kanji' :
        newData = qrKanji(data);
        break;
      default :
        throw 'mode:' + mode;
      }

      _dataList.push(newData);
      _dataCache = null;
    };

    _this.isDark = function(row, col) {
      if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
        throw row + ',' + col;
      }
      return _modules[row][col];
    };

    _this.getModuleCount = function() {
      return _moduleCount;
    };

    _this.make = function() {
      if (_typeNumber < 1) {
        var typeNumber = 1;

        for (; typeNumber < 40; typeNumber++) {
          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);
          var buffer = qrBitBuffer();

          for (var i = 0; i < _dataList.length; i++) {
            var data = _dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
            data.write(buffer);
          }

          var totalDataCount = 0;
          for (var i = 0; i < rsBlocks.length; i++) {
            totalDataCount += rsBlocks[i].dataCount;
          }

          if (buffer.getLengthInBits() <= totalDataCount * 8) {
            break;
          }
        }

        _typeNumber = typeNumber;
      }

      makeImpl(false, getBestMaskPattern() );
    };

    _this.createTableTag = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var qrHtml = '';

      qrHtml += '<table style="';
      qrHtml += ' border-width: 0px; border-style: none;';
      qrHtml += ' border-collapse: collapse;';
      qrHtml += ' padding: 0px; margin: ' + margin + 'px;';
      qrHtml += '">';
      qrHtml += '<tbody>';

      for (var r = 0; r < _this.getModuleCount(); r += 1) {

        qrHtml += '<tr>';

        for (var c = 0; c < _this.getModuleCount(); c += 1) {
          qrHtml += '<td style="';
          qrHtml += ' border-width: 0px; border-style: none;';
          qrHtml += ' border-collapse: collapse;';
          qrHtml += ' padding: 0px; margin: 0px;';
          qrHtml += ' width: ' + cellSize + 'px;';
          qrHtml += ' height: ' + cellSize + 'px;';
          qrHtml += ' background-color: ';
          qrHtml += _this.isDark(r, c)? '#000000' : '#ffffff';
          qrHtml += ';';
          qrHtml += '"/>';
        }

        qrHtml += '</tr>';
      }

      qrHtml += '</tbody>';
      qrHtml += '</table>';

      return qrHtml;
    };

    _this.createSvgTag = function(cellSize, margin, alt, title) {

      var opts = {};
      if (typeof arguments[0] == 'object') {
        // Called by options.
        opts = arguments[0];
        // overwrite cellSize and margin.
        cellSize = opts.cellSize;
        margin = opts.margin;
        alt = opts.alt;
        title = opts.title;
      }

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      // Compose alt property surrogate
      alt = (typeof alt === 'string') ? {text: alt} : alt || {};
      alt.text = alt.text || null;
      alt.id = (alt.text) ? alt.id || 'qrcode-description' : null;

      // Compose title property surrogate
      title = (typeof title === 'string') ? {text: title} : title || {};
      title.text = title.text || null;
      title.id = (title.text) ? title.id || 'qrcode-title' : null;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var c, mc, r, mr, qrSvg='', rect;

      rect = 'l' + cellSize + ',0 0,' + cellSize +
        ' -' + cellSize + ',0 0,-' + cellSize + 'z ';

      qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
      qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : '';
      qrSvg += ' viewBox="0 0 ' + size + ' ' + size + '" ';
      qrSvg += ' preserveAspectRatio="xMinYMin meet"';
      qrSvg += (title.text || alt.text) ? ' role="img" aria-labelledby="' +
          escapeXml([title.id, alt.id].join(' ').trim() ) + '"' : '';
      qrSvg += '>';
      qrSvg += (title.text) ? '<title id="' + escapeXml(title.id) + '">' +
          escapeXml(title.text) + '</title>' : '';
      qrSvg += (alt.text) ? '<description id="' + escapeXml(alt.id) + '">' +
          escapeXml(alt.text) + '</description>' : '';
      qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
      qrSvg += '<path d="';

      for (r = 0; r < _this.getModuleCount(); r += 1) {
        mr = r * cellSize + margin;
        for (c = 0; c < _this.getModuleCount(); c += 1) {
          if (_this.isDark(r, c) ) {
            mc = c*cellSize+margin;
            qrSvg += 'M' + mc + ',' + mr + rect;
          }
        }
      }

      qrSvg += '" stroke="transparent" fill="black"/>';
      qrSvg += '</svg>';

      return qrSvg;
    };

    _this.createDataURL = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      return createDataURL(size, size, function(x, y) {
        if (min <= x && x < max && min <= y && y < max) {
          var c = Math.floor( (x - min) / cellSize);
          var r = Math.floor( (y - min) / cellSize);
          return _this.isDark(r, c)? 0 : 1;
        } else {
          return 1;
        }
      } );
    };

    _this.createImgTag = function(cellSize, margin, alt) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;

      var img = '';
      img += '<img';
      img += '\u0020src="';
      img += _this.createDataURL(cellSize, margin);
      img += '"';
      img += '\u0020width="';
      img += size;
      img += '"';
      img += '\u0020height="';
      img += size;
      img += '"';
      if (alt) {
        img += '\u0020alt="';
        img += escapeXml(alt);
        img += '"';
      }
      img += '/>';

      return img;
    };

    var escapeXml = function(s) {
      var escaped = '';
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charAt(i);
        switch(c) {
        case '<': escaped += '&lt;'; break;
        case '>': escaped += '&gt;'; break;
        case '&': escaped += '&amp;'; break;
        case '"': escaped += '&quot;'; break;
        default : escaped += c; break;
        }
      }
      return escaped;
    };

    var _createHalfASCII = function(margin) {
      var cellSize = 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r1, r2, p;

      var blocks = {
        '██': '█',
        '█ ': '▀',
        ' █': '▄',
        '  ': ' '
      };

      var blocksLastLineNoMargin = {
        '██': '▀',
        '█ ': '▀',
        ' █': ' ',
        '  ': ' '
      };

      var ascii = '';
      for (y = 0; y < size; y += 2) {
        r1 = Math.floor((y - min) / cellSize);
        r2 = Math.floor((y + 1 - min) / cellSize);
        for (x = 0; x < size; x += 1) {
          p = '█';

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
            p = ' ';
          }

          if (min <= x && x < max && min <= y+1 && y+1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
            p += ' ';
          }
          else {
            p += '█';
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          ascii += (margin < 1 && y+1 >= max) ? blocksLastLineNoMargin[p] : blocks[p];
        }

        ascii += '\n';
      }

      if (size % 2 && margin > 0) {
        return ascii.substring(0, ascii.length - size - 1) + Array(size+1).join('▀');
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.createASCII = function(cellSize, margin) {
      cellSize = cellSize || 1;

      if (cellSize < 2) {
        return _createHalfASCII(margin);
      }

      cellSize -= 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r, p;

      var white = Array(cellSize+1).join('██');
      var black = Array(cellSize+1).join('  ');

      var ascii = '';
      var line = '';
      for (y = 0; y < size; y += 1) {
        r = Math.floor( (y - min) / cellSize);
        line = '';
        for (x = 0; x < size; x += 1) {
          p = 1;

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
            p = 0;
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          line += p ? white : black;
        }

        for (r = 0; r < cellSize; r += 1) {
          ascii += line + '\n';
        }
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.renderTo2dContext = function(context, cellSize) {
      cellSize = cellSize || 2;
      var length = _this.getModuleCount();
      for (var row = 0; row < length; row++) {
        for (var col = 0; col < length; col++) {
          context.fillStyle = _this.isDark(row, col) ? 'black' : 'white';
          context.fillRect(row * cellSize, col * cellSize, cellSize, cellSize);
        }
      }
    }

    return _this;
  };

  //---------------------------------------------------------------------
  // qrcode.stringToBytes
  //---------------------------------------------------------------------

  qrcode.stringToBytesFuncs = {
    'default' : function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        bytes.push(c & 0xff);
      }
      return bytes;
    }
  };

  qrcode.stringToBytes = qrcode.stringToBytesFuncs['default'];

  //---------------------------------------------------------------------
  // qrcode.createStringToBytes
  //---------------------------------------------------------------------

  /**
   * @param unicodeData base64 string of byte array.
   * [16bit Unicode],[16bit Bytes], ...
   * @param numChars
   */
  qrcode.createStringToBytes = function(unicodeData, numChars) {

    // create conversion map.

    var unicodeMap = function() {

      var bin = base64DecodeInputStream(unicodeData);
      var read = function() {
        var b = bin.read();
        if (b == -1) throw 'eof';
        return b;
      };

      var count = 0;
      var unicodeMap = {};
      while (true) {
        var b0 = bin.read();
        if (b0 == -1) break;
        var b1 = read();
        var b2 = read();
        var b3 = read();
        var k = String.fromCharCode( (b0 << 8) | b1);
        var v = (b2 << 8) | b3;
        unicodeMap[k] = v;
        count += 1;
      }
      if (count != numChars) {
        throw count + ' != ' + numChars;
      }

      return unicodeMap;
    }();

    var unknownChar = '?'.charCodeAt(0);

    return function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        if (c < 128) {
          bytes.push(c);
        } else {
          var b = unicodeMap[s.charAt(i)];
          if (typeof b == 'number') {
            if ( (b & 0xff) == b) {
              // 1byte
              bytes.push(b);
            } else {
              // 2bytes
              bytes.push(b >>> 8);
              bytes.push(b & 0xff);
            }
          } else {
            bytes.push(unknownChar);
          }
        }
      }
      return bytes;
    };
  };

  //---------------------------------------------------------------------
  // QRMode
  //---------------------------------------------------------------------

  var QRMode = {
    MODE_NUMBER :    1 << 0,
    MODE_ALPHA_NUM : 1 << 1,
    MODE_8BIT_BYTE : 1 << 2,
    MODE_KANJI :     1 << 3
  };

  //---------------------------------------------------------------------
  // QRErrorCorrectionLevel
  //---------------------------------------------------------------------

  var QRErrorCorrectionLevel = {
    L : 1,
    M : 0,
    Q : 3,
    H : 2
  };

  //---------------------------------------------------------------------
  // QRMaskPattern
  //---------------------------------------------------------------------

  var QRMaskPattern = {
    PATTERN000 : 0,
    PATTERN001 : 1,
    PATTERN010 : 2,
    PATTERN011 : 3,
    PATTERN100 : 4,
    PATTERN101 : 5,
    PATTERN110 : 6,
    PATTERN111 : 7
  };

  //---------------------------------------------------------------------
  // QRUtil
  //---------------------------------------------------------------------

  var QRUtil = function() {

    var PATTERN_POSITION_TABLE = [
      [],
      [6, 18],
      [6, 22],
      [6, 26],
      [6, 30],
      [6, 34],
      [6, 22, 38],
      [6, 24, 42],
      [6, 26, 46],
      [6, 28, 50],
      [6, 30, 54],
      [6, 32, 58],
      [6, 34, 62],
      [6, 26, 46, 66],
      [6, 26, 48, 70],
      [6, 26, 50, 74],
      [6, 30, 54, 78],
      [6, 30, 56, 82],
      [6, 30, 58, 86],
      [6, 34, 62, 90],
      [6, 28, 50, 72, 94],
      [6, 26, 50, 74, 98],
      [6, 30, 54, 78, 102],
      [6, 28, 54, 80, 106],
      [6, 32, 58, 84, 110],
      [6, 30, 58, 86, 114],
      [6, 34, 62, 90, 118],
      [6, 26, 50, 74, 98, 122],
      [6, 30, 54, 78, 102, 126],
      [6, 26, 52, 78, 104, 130],
      [6, 30, 56, 82, 108, 134],
      [6, 34, 60, 86, 112, 138],
      [6, 30, 58, 86, 114, 142],
      [6, 34, 62, 90, 118, 146],
      [6, 30, 54, 78, 102, 126, 150],
      [6, 24, 50, 76, 102, 128, 154],
      [6, 28, 54, 80, 106, 132, 158],
      [6, 32, 58, 84, 110, 136, 162],
      [6, 26, 54, 82, 110, 138, 166],
      [6, 30, 58, 86, 114, 142, 170]
    ];
    var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
    var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
    var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

    var _this = {};

    var getBCHDigit = function(data) {
      var digit = 0;
      while (data != 0) {
        digit += 1;
        data >>>= 1;
      }
      return digit;
    };

    _this.getBCHTypeInfo = function(data) {
      var d = data << 10;
      while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
        d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15) ) );
      }
      return ( (data << 10) | d) ^ G15_MASK;
    };

    _this.getBCHTypeNumber = function(data) {
      var d = data << 12;
      while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
        d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18) ) );
      }
      return (data << 12) | d;
    };

    _this.getPatternPosition = function(typeNumber) {
      return PATTERN_POSITION_TABLE[typeNumber - 1];
    };

    _this.getMaskFunction = function(maskPattern) {

      switch (maskPattern) {

      case QRMaskPattern.PATTERN000 :
        return function(i, j) { return (i + j) % 2 == 0; };
      case QRMaskPattern.PATTERN001 :
        return function(i, j) { return i % 2 == 0; };
      case QRMaskPattern.PATTERN010 :
        return function(i, j) { return j % 3 == 0; };
      case QRMaskPattern.PATTERN011 :
        return function(i, j) { return (i + j) % 3 == 0; };
      case QRMaskPattern.PATTERN100 :
        return function(i, j) { return (Math.floor(i / 2) + Math.floor(j / 3) ) % 2 == 0; };
      case QRMaskPattern.PATTERN101 :
        return function(i, j) { return (i * j) % 2 + (i * j) % 3 == 0; };
      case QRMaskPattern.PATTERN110 :
        return function(i, j) { return ( (i * j) % 2 + (i * j) % 3) % 2 == 0; };
      case QRMaskPattern.PATTERN111 :
        return function(i, j) { return ( (i * j) % 3 + (i + j) % 2) % 2 == 0; };

      default :
        throw 'bad maskPattern:' + maskPattern;
      }
    };

    _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
      var a = qrPolynomial([1], 0);
      for (var i = 0; i < errorCorrectLength; i += 1) {
        a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0) );
      }
      return a;
    };

    _this.getLengthInBits = function(mode, type) {

      if (1 <= type && type < 10) {

        // 1 - 9

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 10;
        case QRMode.MODE_ALPHA_NUM : return 9;
        case QRMode.MODE_8BIT_BYTE : return 8;
        case QRMode.MODE_KANJI     : return 8;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 27) {

        // 10 - 26

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 12;
        case QRMode.MODE_ALPHA_NUM : return 11;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 10;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 41) {

        // 27 - 40

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 14;
        case QRMode.MODE_ALPHA_NUM : return 13;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 12;
        default :
          throw 'mode:' + mode;
        }

      } else {
        throw 'type:' + type;
      }
    };

    _this.getLostPoint = function(qrcode) {

      var moduleCount = qrcode.getModuleCount();

      var lostPoint = 0;

      // LEVEL1

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount; col += 1) {

          var sameCount = 0;
          var dark = qrcode.isDark(row, col);

          for (var r = -1; r <= 1; r += 1) {

            if (row + r < 0 || moduleCount <= row + r) {
              continue;
            }

            for (var c = -1; c <= 1; c += 1) {

              if (col + c < 0 || moduleCount <= col + c) {
                continue;
              }

              if (r == 0 && c == 0) {
                continue;
              }

              if (dark == qrcode.isDark(row + r, col + c) ) {
                sameCount += 1;
              }
            }
          }

          if (sameCount > 5) {
            lostPoint += (3 + sameCount - 5);
          }
        }
      };

      // LEVEL2

      for (var row = 0; row < moduleCount - 1; row += 1) {
        for (var col = 0; col < moduleCount - 1; col += 1) {
          var count = 0;
          if (qrcode.isDark(row, col) ) count += 1;
          if (qrcode.isDark(row + 1, col) ) count += 1;
          if (qrcode.isDark(row, col + 1) ) count += 1;
          if (qrcode.isDark(row + 1, col + 1) ) count += 1;
          if (count == 0 || count == 4) {
            lostPoint += 3;
          }
        }
      }

      // LEVEL3

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount - 6; col += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row, col + 1)
              &&  qrcode.isDark(row, col + 2)
              &&  qrcode.isDark(row, col + 3)
              &&  qrcode.isDark(row, col + 4)
              && !qrcode.isDark(row, col + 5)
              &&  qrcode.isDark(row, col + 6) ) {
            lostPoint += 40;
          }
        }
      }

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount - 6; row += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row + 1, col)
              &&  qrcode.isDark(row + 2, col)
              &&  qrcode.isDark(row + 3, col)
              &&  qrcode.isDark(row + 4, col)
              && !qrcode.isDark(row + 5, col)
              &&  qrcode.isDark(row + 6, col) ) {
            lostPoint += 40;
          }
        }
      }

      // LEVEL4

      var darkCount = 0;

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount; row += 1) {
          if (qrcode.isDark(row, col) ) {
            darkCount += 1;
          }
        }
      }

      var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
      lostPoint += ratio * 10;

      return lostPoint;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // QRMath
  //---------------------------------------------------------------------

  var QRMath = function() {

    var EXP_TABLE = new Array(256);
    var LOG_TABLE = new Array(256);

    // initialize tables
    for (var i = 0; i < 8; i += 1) {
      EXP_TABLE[i] = 1 << i;
    }
    for (var i = 8; i < 256; i += 1) {
      EXP_TABLE[i] = EXP_TABLE[i - 4]
        ^ EXP_TABLE[i - 5]
        ^ EXP_TABLE[i - 6]
        ^ EXP_TABLE[i - 8];
    }
    for (var i = 0; i < 255; i += 1) {
      LOG_TABLE[EXP_TABLE[i] ] = i;
    }

    var _this = {};

    _this.glog = function(n) {

      if (n < 1) {
        throw 'glog(' + n + ')';
      }

      return LOG_TABLE[n];
    };

    _this.gexp = function(n) {

      while (n < 0) {
        n += 255;
      }

      while (n >= 256) {
        n -= 255;
      }

      return EXP_TABLE[n];
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrPolynomial
  //---------------------------------------------------------------------

  function qrPolynomial(num, shift) {

    if (typeof num.length == 'undefined') {
      throw num.length + '/' + shift;
    }

    var _num = function() {
      var offset = 0;
      while (offset < num.length && num[offset] == 0) {
        offset += 1;
      }
      var _num = new Array(num.length - offset + shift);
      for (var i = 0; i < num.length - offset; i += 1) {
        _num[i] = num[i + offset];
      }
      return _num;
    }();

    var _this = {};

    _this.getAt = function(index) {
      return _num[index];
    };

    _this.getLength = function() {
      return _num.length;
    };

    _this.multiply = function(e) {

      var num = new Array(_this.getLength() + e.getLength() - 1);

      for (var i = 0; i < _this.getLength(); i += 1) {
        for (var j = 0; j < e.getLength(); j += 1) {
          num[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i) ) + QRMath.glog(e.getAt(j) ) );
        }
      }

      return qrPolynomial(num, 0);
    };

    _this.mod = function(e) {

      if (_this.getLength() - e.getLength() < 0) {
        return _this;
      }

      var ratio = QRMath.glog(_this.getAt(0) ) - QRMath.glog(e.getAt(0) );

      var num = new Array(_this.getLength() );
      for (var i = 0; i < _this.getLength(); i += 1) {
        num[i] = _this.getAt(i);
      }

      for (var i = 0; i < e.getLength(); i += 1) {
        num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i) ) + ratio);
      }

      // recursive call
      return qrPolynomial(num, 0).mod(e);
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // QRRSBlock
  //---------------------------------------------------------------------

  var QRRSBlock = function() {

    var RS_BLOCK_TABLE = [

      // L
      // M
      // Q
      // H

      // 1
      [1, 26, 19],
      [1, 26, 16],
      [1, 26, 13],
      [1, 26, 9],

      // 2
      [1, 44, 34],
      [1, 44, 28],
      [1, 44, 22],
      [1, 44, 16],

      // 3
      [1, 70, 55],
      [1, 70, 44],
      [2, 35, 17],
      [2, 35, 13],

      // 4
      [1, 100, 80],
      [2, 50, 32],
      [2, 50, 24],
      [4, 25, 9],

      // 5
      [1, 134, 108],
      [2, 67, 43],
      [2, 33, 15, 2, 34, 16],
      [2, 33, 11, 2, 34, 12],

      // 6
      [2, 86, 68],
      [4, 43, 27],
      [4, 43, 19],
      [4, 43, 15],

      // 7
      [2, 98, 78],
      [4, 49, 31],
      [2, 32, 14, 4, 33, 15],
      [4, 39, 13, 1, 40, 14],

      // 8
      [2, 121, 97],
      [2, 60, 38, 2, 61, 39],
      [4, 40, 18, 2, 41, 19],
      [4, 40, 14, 2, 41, 15],

      // 9
      [2, 146, 116],
      [3, 58, 36, 2, 59, 37],
      [4, 36, 16, 4, 37, 17],
      [4, 36, 12, 4, 37, 13],

      // 10
      [2, 86, 68, 2, 87, 69],
      [4, 69, 43, 1, 70, 44],
      [6, 43, 19, 2, 44, 20],
      [6, 43, 15, 2, 44, 16],

      // 11
      [4, 101, 81],
      [1, 80, 50, 4, 81, 51],
      [4, 50, 22, 4, 51, 23],
      [3, 36, 12, 8, 37, 13],

      // 12
      [2, 116, 92, 2, 117, 93],
      [6, 58, 36, 2, 59, 37],
      [4, 46, 20, 6, 47, 21],
      [7, 42, 14, 4, 43, 15],

      // 13
      [4, 133, 107],
      [8, 59, 37, 1, 60, 38],
      [8, 44, 20, 4, 45, 21],
      [12, 33, 11, 4, 34, 12],

      // 14
      [3, 145, 115, 1, 146, 116],
      [4, 64, 40, 5, 65, 41],
      [11, 36, 16, 5, 37, 17],
      [11, 36, 12, 5, 37, 13],

      // 15
      [5, 109, 87, 1, 110, 88],
      [5, 65, 41, 5, 66, 42],
      [5, 54, 24, 7, 55, 25],
      [11, 36, 12, 7, 37, 13],

      // 16
      [5, 122, 98, 1, 123, 99],
      [7, 73, 45, 3, 74, 46],
      [15, 43, 19, 2, 44, 20],
      [3, 45, 15, 13, 46, 16],

      // 17
      [1, 135, 107, 5, 136, 108],
      [10, 74, 46, 1, 75, 47],
      [1, 50, 22, 15, 51, 23],
      [2, 42, 14, 17, 43, 15],

      // 18
      [5, 150, 120, 1, 151, 121],
      [9, 69, 43, 4, 70, 44],
      [17, 50, 22, 1, 51, 23],
      [2, 42, 14, 19, 43, 15],

      // 19
      [3, 141, 113, 4, 142, 114],
      [3, 70, 44, 11, 71, 45],
      [17, 47, 21, 4, 48, 22],
      [9, 39, 13, 16, 40, 14],

      // 20
      [3, 135, 107, 5, 136, 108],
      [3, 67, 41, 13, 68, 42],
      [15, 54, 24, 5, 55, 25],
      [15, 43, 15, 10, 44, 16],

      // 21
      [4, 144, 116, 4, 145, 117],
      [17, 68, 42],
      [17, 50, 22, 6, 51, 23],
      [19, 46, 16, 6, 47, 17],

      // 22
      [2, 139, 111, 7, 140, 112],
      [17, 74, 46],
      [7, 54, 24, 16, 55, 25],
      [34, 37, 13],

      // 23
      [4, 151, 121, 5, 152, 122],
      [4, 75, 47, 14, 76, 48],
      [11, 54, 24, 14, 55, 25],
      [16, 45, 15, 14, 46, 16],

      // 24
      [6, 147, 117, 4, 148, 118],
      [6, 73, 45, 14, 74, 46],
      [11, 54, 24, 16, 55, 25],
      [30, 46, 16, 2, 47, 17],

      // 25
      [8, 132, 106, 4, 133, 107],
      [8, 75, 47, 13, 76, 48],
      [7, 54, 24, 22, 55, 25],
      [22, 45, 15, 13, 46, 16],

      // 26
      [10, 142, 114, 2, 143, 115],
      [19, 74, 46, 4, 75, 47],
      [28, 50, 22, 6, 51, 23],
      [33, 46, 16, 4, 47, 17],

      // 27
      [8, 152, 122, 4, 153, 123],
      [22, 73, 45, 3, 74, 46],
      [8, 53, 23, 26, 54, 24],
      [12, 45, 15, 28, 46, 16],

      // 28
      [3, 147, 117, 10, 148, 118],
      [3, 73, 45, 23, 74, 46],
      [4, 54, 24, 31, 55, 25],
      [11, 45, 15, 31, 46, 16],

      // 29
      [7, 146, 116, 7, 147, 117],
      [21, 73, 45, 7, 74, 46],
      [1, 53, 23, 37, 54, 24],
      [19, 45, 15, 26, 46, 16],

      // 30
      [5, 145, 115, 10, 146, 116],
      [19, 75, 47, 10, 76, 48],
      [15, 54, 24, 25, 55, 25],
      [23, 45, 15, 25, 46, 16],

      // 31
      [13, 145, 115, 3, 146, 116],
      [2, 74, 46, 29, 75, 47],
      [42, 54, 24, 1, 55, 25],
      [23, 45, 15, 28, 46, 16],

      // 32
      [17, 145, 115],
      [10, 74, 46, 23, 75, 47],
      [10, 54, 24, 35, 55, 25],
      [19, 45, 15, 35, 46, 16],

      // 33
      [17, 145, 115, 1, 146, 116],
      [14, 74, 46, 21, 75, 47],
      [29, 54, 24, 19, 55, 25],
      [11, 45, 15, 46, 46, 16],

      // 34
      [13, 145, 115, 6, 146, 116],
      [14, 74, 46, 23, 75, 47],
      [44, 54, 24, 7, 55, 25],
      [59, 46, 16, 1, 47, 17],

      // 35
      [12, 151, 121, 7, 152, 122],
      [12, 75, 47, 26, 76, 48],
      [39, 54, 24, 14, 55, 25],
      [22, 45, 15, 41, 46, 16],

      // 36
      [6, 151, 121, 14, 152, 122],
      [6, 75, 47, 34, 76, 48],
      [46, 54, 24, 10, 55, 25],
      [2, 45, 15, 64, 46, 16],

      // 37
      [17, 152, 122, 4, 153, 123],
      [29, 74, 46, 14, 75, 47],
      [49, 54, 24, 10, 55, 25],
      [24, 45, 15, 46, 46, 16],

      // 38
      [4, 152, 122, 18, 153, 123],
      [13, 74, 46, 32, 75, 47],
      [48, 54, 24, 14, 55, 25],
      [42, 45, 15, 32, 46, 16],

      // 39
      [20, 147, 117, 4, 148, 118],
      [40, 75, 47, 7, 76, 48],
      [43, 54, 24, 22, 55, 25],
      [10, 45, 15, 67, 46, 16],

      // 40
      [19, 148, 118, 6, 149, 119],
      [18, 75, 47, 31, 76, 48],
      [34, 54, 24, 34, 55, 25],
      [20, 45, 15, 61, 46, 16]
    ];

    var qrRSBlock = function(totalCount, dataCount) {
      var _this = {};
      _this.totalCount = totalCount;
      _this.dataCount = dataCount;
      return _this;
    };

    var _this = {};

    var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {

      switch(errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default :
        return undefined;
      }
    };

    _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {

      var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);

      if (typeof rsBlock == 'undefined') {
        throw 'bad rs block @ typeNumber:' + typeNumber +
            '/errorCorrectionLevel:' + errorCorrectionLevel;
      }

      var length = rsBlock.length / 3;

      var list = [];

      for (var i = 0; i < length; i += 1) {

        var count = rsBlock[i * 3 + 0];
        var totalCount = rsBlock[i * 3 + 1];
        var dataCount = rsBlock[i * 3 + 2];

        for (var j = 0; j < count; j += 1) {
          list.push(qrRSBlock(totalCount, dataCount) );
        }
      }

      return list;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrBitBuffer
  //---------------------------------------------------------------------

  var qrBitBuffer = function() {

    var _buffer = [];
    var _length = 0;

    var _this = {};

    _this.getBuffer = function() {
      return _buffer;
    };

    _this.getAt = function(index) {
      var bufIndex = Math.floor(index / 8);
      return ( (_buffer[bufIndex] >>> (7 - index % 8) ) & 1) == 1;
    };

    _this.put = function(num, length) {
      for (var i = 0; i < length; i += 1) {
        _this.putBit( ( (num >>> (length - i - 1) ) & 1) == 1);
      }
    };

    _this.getLengthInBits = function() {
      return _length;
    };

    _this.putBit = function(bit) {

      var bufIndex = Math.floor(_length / 8);
      if (_buffer.length <= bufIndex) {
        _buffer.push(0);
      }

      if (bit) {
        _buffer[bufIndex] |= (0x80 >>> (_length % 8) );
      }

      _length += 1;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrNumber
  //---------------------------------------------------------------------

  var qrNumber = function(data) {

    var _mode = QRMode.MODE_NUMBER;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var data = _data;

      var i = 0;

      while (i + 2 < data.length) {
        buffer.put(strToNum(data.substring(i, i + 3) ), 10);
        i += 3;
      }

      if (i < data.length) {
        if (data.length - i == 1) {
          buffer.put(strToNum(data.substring(i, i + 1) ), 4);
        } else if (data.length - i == 2) {
          buffer.put(strToNum(data.substring(i, i + 2) ), 7);
        }
      }
    };

    var strToNum = function(s) {
      var num = 0;
      for (var i = 0; i < s.length; i += 1) {
        num = num * 10 + chatToNum(s.charAt(i) );
      }
      return num;
    };

    var chatToNum = function(c) {
      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      }
      throw 'illegal char :' + c;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrAlphaNum
  //---------------------------------------------------------------------

  var qrAlphaNum = function(data) {

    var _mode = QRMode.MODE_ALPHA_NUM;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var s = _data;

      var i = 0;

      while (i + 1 < s.length) {
        buffer.put(
          getCode(s.charAt(i) ) * 45 +
          getCode(s.charAt(i + 1) ), 11);
        i += 2;
      }

      if (i < s.length) {
        buffer.put(getCode(s.charAt(i) ), 6);
      }
    };

    var getCode = function(c) {

      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      } else if ('A' <= c && c <= 'Z') {
        return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
      } else {
        switch (c) {
        case ' ' : return 36;
        case '$' : return 37;
        case '%' : return 38;
        case '*' : return 39;
        case '+' : return 40;
        case '-' : return 41;
        case '.' : return 42;
        case '/' : return 43;
        case ':' : return 44;
        default :
          throw 'illegal char :' + c;
        }
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qr8BitByte
  //---------------------------------------------------------------------

  var qr8BitByte = function(data) {

    var _mode = QRMode.MODE_8BIT_BYTE;
    var _data = data;
    var _bytes = qrcode.stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _bytes.length;
    };

    _this.write = function(buffer) {
      for (var i = 0; i < _bytes.length; i += 1) {
        buffer.put(_bytes[i], 8);
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrKanji
  //---------------------------------------------------------------------

  var qrKanji = function(data) {

    var _mode = QRMode.MODE_KANJI;
    var _data = data;

    var stringToBytes = qrcode.stringToBytesFuncs['SJIS'];
    if (!stringToBytes) {
      throw 'sjis not supported.';
    }
    !function(c, code) {
      // self test for sjis support.
      var test = stringToBytes(c);
      if (test.length != 2 || ( (test[0] << 8) | test[1]) != code) {
        throw 'sjis not supported.';
      }
    }('\u53cb', 0x9746);

    var _bytes = stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return ~~(_bytes.length / 2);
    };

    _this.write = function(buffer) {

      var data = _bytes;

      var i = 0;

      while (i + 1 < data.length) {

        var c = ( (0xff & data[i]) << 8) | (0xff & data[i + 1]);

        if (0x8140 <= c && c <= 0x9FFC) {
          c -= 0x8140;
        } else if (0xE040 <= c && c <= 0xEBBF) {
          c -= 0xC140;
        } else {
          throw 'illegal char at ' + (i + 1) + '/' + c;
        }

        c = ( (c >>> 8) & 0xff) * 0xC0 + (c & 0xff);

        buffer.put(c, 13);

        i += 2;
      }

      if (i < data.length) {
        throw 'illegal char at ' + (i + 1);
      }
    };

    return _this;
  };

  //=====================================================================
  // GIF Support etc.
  //

  //---------------------------------------------------------------------
  // byteArrayOutputStream
  //---------------------------------------------------------------------

  var byteArrayOutputStream = function() {

    var _bytes = [];

    var _this = {};

    _this.writeByte = function(b) {
      _bytes.push(b & 0xff);
    };

    _this.writeShort = function(i) {
      _this.writeByte(i);
      _this.writeByte(i >>> 8);
    };

    _this.writeBytes = function(b, off, len) {
      off = off || 0;
      len = len || b.length;
      for (var i = 0; i < len; i += 1) {
        _this.writeByte(b[i + off]);
      }
    };

    _this.writeString = function(s) {
      for (var i = 0; i < s.length; i += 1) {
        _this.writeByte(s.charCodeAt(i) );
      }
    };

    _this.toByteArray = function() {
      return _bytes;
    };

    _this.toString = function() {
      var s = '';
      s += '[';
      for (var i = 0; i < _bytes.length; i += 1) {
        if (i > 0) {
          s += ',';
        }
        s += _bytes[i];
      }
      s += ']';
      return s;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64EncodeOutputStream
  //---------------------------------------------------------------------

  var base64EncodeOutputStream = function() {

    var _buffer = 0;
    var _buflen = 0;
    var _length = 0;
    var _base64 = '';

    var _this = {};

    var writeEncoded = function(b) {
      _base64 += String.fromCharCode(encode(b & 0x3f) );
    };

    var encode = function(n) {
      if (n < 0) {
        // error.
      } else if (n < 26) {
        return 0x41 + n;
      } else if (n < 52) {
        return 0x61 + (n - 26);
      } else if (n < 62) {
        return 0x30 + (n - 52);
      } else if (n == 62) {
        return 0x2b;
      } else if (n == 63) {
        return 0x2f;
      }
      throw 'n:' + n;
    };

    _this.writeByte = function(n) {

      _buffer = (_buffer << 8) | (n & 0xff);
      _buflen += 8;
      _length += 1;

      while (_buflen >= 6) {
        writeEncoded(_buffer >>> (_buflen - 6) );
        _buflen -= 6;
      }
    };

    _this.flush = function() {

      if (_buflen > 0) {
        writeEncoded(_buffer << (6 - _buflen) );
        _buffer = 0;
        _buflen = 0;
      }

      if (_length % 3 != 0) {
        // padding
        var padlen = 3 - _length % 3;
        for (var i = 0; i < padlen; i += 1) {
          _base64 += '=';
        }
      }
    };

    _this.toString = function() {
      return _base64;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64DecodeInputStream
  //---------------------------------------------------------------------

  var base64DecodeInputStream = function(str) {

    var _str = str;
    var _pos = 0;
    var _buffer = 0;
    var _buflen = 0;

    var _this = {};

    _this.read = function() {

      while (_buflen < 8) {

        if (_pos >= _str.length) {
          if (_buflen == 0) {
            return -1;
          }
          throw 'unexpected end of file./' + _buflen;
        }

        var c = _str.charAt(_pos);
        _pos += 1;

        if (c == '=') {
          _buflen = 0;
          return -1;
        } else if (c.match(/^\s$/) ) {
          // ignore if whitespace.
          continue;
        }

        _buffer = (_buffer << 6) | decode(c.charCodeAt(0) );
        _buflen += 6;
      }

      var n = (_buffer >>> (_buflen - 8) ) & 0xff;
      _buflen -= 8;
      return n;
    };

    var decode = function(c) {
      if (0x41 <= c && c <= 0x5a) {
        return c - 0x41;
      } else if (0x61 <= c && c <= 0x7a) {
        return c - 0x61 + 26;
      } else if (0x30 <= c && c <= 0x39) {
        return c - 0x30 + 52;
      } else if (c == 0x2b) {
        return 62;
      } else if (c == 0x2f) {
        return 63;
      } else {
        throw 'c:' + c;
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // gifImage (B/W)
  //---------------------------------------------------------------------

  var gifImage = function(width, height) {

    var _width = width;
    var _height = height;
    var _data = new Array(width * height);

    var _this = {};

    _this.setPixel = function(x, y, pixel) {
      _data[y * _width + x] = pixel;
    };

    _this.write = function(out) {

      //---------------------------------
      // GIF Signature

      out.writeString('GIF87a');

      //---------------------------------
      // Screen Descriptor

      out.writeShort(_width);
      out.writeShort(_height);

      out.writeByte(0x80); // 2bit
      out.writeByte(0);
      out.writeByte(0);

      //---------------------------------
      // Global Color Map

      // black
      out.writeByte(0x00);
      out.writeByte(0x00);
      out.writeByte(0x00);

      // white
      out.writeByte(0xff);
      out.writeByte(0xff);
      out.writeByte(0xff);

      //---------------------------------
      // Image Descriptor

      out.writeString(',');
      out.writeShort(0);
      out.writeShort(0);
      out.writeShort(_width);
      out.writeShort(_height);
      out.writeByte(0);

      //---------------------------------
      // Local Color Map

      //---------------------------------
      // Raster Data

      var lzwMinCodeSize = 2;
      var raster = getLZWRaster(lzwMinCodeSize);

      out.writeByte(lzwMinCodeSize);

      var offset = 0;

      while (raster.length - offset > 255) {
        out.writeByte(255);
        out.writeBytes(raster, offset, 255);
        offset += 255;
      }

      out.writeByte(raster.length - offset);
      out.writeBytes(raster, offset, raster.length - offset);
      out.writeByte(0x00);

      //---------------------------------
      // GIF Terminator
      out.writeString(';');
    };

    var bitOutputStream = function(out) {

      var _out = out;
      var _bitLength = 0;
      var _bitBuffer = 0;

      var _this = {};

      _this.write = function(data, length) {

        if ( (data >>> length) != 0) {
          throw 'length over';
        }

        while (_bitLength + length >= 8) {
          _out.writeByte(0xff & ( (data << _bitLength) | _bitBuffer) );
          length -= (8 - _bitLength);
          data >>>= (8 - _bitLength);
          _bitBuffer = 0;
          _bitLength = 0;
        }

        _bitBuffer = (data << _bitLength) | _bitBuffer;
        _bitLength = _bitLength + length;
      };

      _this.flush = function() {
        if (_bitLength > 0) {
          _out.writeByte(_bitBuffer);
        }
      };

      return _this;
    };

    var getLZWRaster = function(lzwMinCodeSize) {

      var clearCode = 1 << lzwMinCodeSize;
      var endCode = (1 << lzwMinCodeSize) + 1;
      var bitLength = lzwMinCodeSize + 1;

      // Setup LZWTable
      var table = lzwTable();

      for (var i = 0; i < clearCode; i += 1) {
        table.add(String.fromCharCode(i) );
      }
      table.add(String.fromCharCode(clearCode) );
      table.add(String.fromCharCode(endCode) );

      var byteOut = byteArrayOutputStream();
      var bitOut = bitOutputStream(byteOut);

      // clear code
      bitOut.write(clearCode, bitLength);

      var dataIndex = 0;

      var s = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;

      while (dataIndex < _data.length) {

        var c = String.fromCharCode(_data[dataIndex]);
        dataIndex += 1;

        if (table.contains(s + c) ) {

          s = s + c;

        } else {

          bitOut.write(table.indexOf(s), bitLength);

          if (table.size() < 0xfff) {

            if (table.size() == (1 << bitLength) ) {
              bitLength += 1;
            }

            table.add(s + c);
          }

          s = c;
        }
      }

      bitOut.write(table.indexOf(s), bitLength);

      // end code
      bitOut.write(endCode, bitLength);

      bitOut.flush();

      return byteOut.toByteArray();
    };

    var lzwTable = function() {

      var _map = {};
      var _size = 0;

      var _this = {};

      _this.add = function(key) {
        if (_this.contains(key) ) {
          throw 'dup key:' + key;
        }
        _map[key] = _size;
        _size += 1;
      };

      _this.size = function() {
        return _size;
      };

      _this.indexOf = function(key) {
        return _map[key];
      };

      _this.contains = function(key) {
        return typeof _map[key] != 'undefined';
      };

      return _this;
    };

    return _this;
  };

  var createDataURL = function(width, height, getPixel) {
    var gif = gifImage(width, height);
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        gif.setPixel(x, y, getPixel(x, y) );
      }
    }

    var b = byteArrayOutputStream();
    gif.write(b);

    var base64 = base64EncodeOutputStream();
    var bytes = b.toByteArray();
    for (var i = 0; i < bytes.length; i += 1) {
      base64.writeByte(bytes[i]);
    }
    base64.flush();

    return 'data:image/gif;base64,' + base64;
  };

  //---------------------------------------------------------------------
  // returns qrcode function.

  return qrcode;
}();

// multibyte support
!function() {

  qrcode.stringToBytesFuncs['UTF-8'] = function(s) {
    // http://stackoverflow.com/questions/18729405/how-to-convert-utf8-string-to-byte-array
    function toUTF8Array(str) {
      var utf8 = [];
      for (var i=0; i < str.length; i++) {
        var charcode = str.charCodeAt(i);
        if (charcode < 0x80) utf8.push(charcode);
        else if (charcode < 0x800) {
          utf8.push(0xc0 | (charcode >> 6),
              0x80 | (charcode & 0x3f));
        }
        else if (charcode < 0xd800 || charcode >= 0xe000) {
          utf8.push(0xe0 | (charcode >> 12),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
        // surrogate pair
        else {
          i++;
          // UTF-16 encodes 0x10000-0x10FFFF by
          // subtracting 0x10000 and splitting the
          // 20 bits of 0x0-0xFFFFF into two halves
          charcode = 0x10000 + (((charcode & 0x3ff)<<10)
            | (str.charCodeAt(i) & 0x3ff));
          utf8.push(0xf0 | (charcode >>18),
              0x80 | ((charcode>>12) & 0x3f),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
      }
      return utf8;
    }
    return toUTF8Array(s);
  };

}();


return qrcode;
})();
const PAY_TTL = 5 * 60 * 1000;
const payCfg = () => ({ mode: 'off', counter: true, ...((((store.get('config/main') || {}).data || {}).payment) || {}) });
function priceItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 60) throw new E(400, 'invalid_argument', '장바구니가 비어 있습니다');
  const out = []; let total = 0;
  for (const it of items) {
    const qty = Math.floor(Number(it && it.qty));
    if (!(qty >= 1 && qty <= 99)) throw new E(400, 'invalid_argument', '수량 오류');
    const m = store.get('menu/' + String(it.mid || ''));
    if (!m || !m.data) throw new E(409, 'menu_changed', '메뉴가 바뀌었습니다. 장바구니를 다시 담아 주세요');
    const md = m.data;
    if (md.soldOut || md.hidden) throw new E(409, 'sold_out', (md.name || '메뉴') + '는 품절입니다');
    let unit = Number(md.price) || 0; const opts = [];
    for (const o of (Array.isArray(it.opts) ? it.opts : [])) {
      const g = (md.groups || []).find(x => x.name === o.g); const c = g && (g.choices || []).find(x => x.name === o.n);
      if (!c) throw new E(409, 'menu_changed', (md.name || '메뉴') + ' 옵션이 바뀌었습니다. 다시 담아 주세요');
      unit += Number(c.price) || 0; opts.push({ g: String(o.g), n: String(o.n), p: Number(c.price) || 0 });
    }
    out.push({ mid: String(it.mid), name: md.name, opts, unit, qty }); total += unit * qty;
  }
  if (total <= 0) throw new E(400, 'invalid_argument', '결제할 금액이 없습니다');
  return { items: out, total };
}
function payStart(b, host) {
  const pc = payCfg(); if (pc.mode === 'off') throw new E(400, 'pay_off', 'QR 결제가 꺼져 있습니다');
  const cfg = (store.get('config/main') || {}).data || {};
  if (cfg.open === false) throw new E(403, 'store_closed', '지금은 영업 준비 중입니다');
  const tid = String(b.tabletId || ''); const t = store.get('tablets/' + tid);
  if (!/^[\w-]{1,40}$/.test(tid) || !t || !t.data) throw new E(400, 'invalid_argument', '태블릿 정보 오류');
  const { items, total } = priceItems(b.items);
  const now = Date.now(), pid = 'p' + now.toString(36) + crypto.randomBytes(3).toString('hex');
  const d = { status: 'pending', provider: pc.mode, tabletId: tid, tabletName: t.data.name || '', place: t.data.place || '', items, total, test: !!t.data.testMode || pc.mode === 'test', createdAt: now, expiresAt: now + PAY_TTL, dateKey: dayKey(new Date(now)) };
  applyOps([{ op: 'set', path: 'payments/' + pid, data: d }], true);
  const h = /^[\w.\-]+(:\d+)?$/.test(String(host || '')) ? host : ('localhost:' + PORT);
  return { id: pid, total, expiresAt: d.expiresAt, payUrl: 'http://' + h + '/pay/' + pid };
}
function payComplete(pid, method) {
  const p = store.get('payments/' + pid); if (!p || !p.data) throw new E(404, 'not_found', '결제를 찾을 수 없습니다');
  const d = p.data; if (d.status === 'paid') return d.orderId;
  if (d.status !== 'pending') throw new E(409, 'pay_closed', d.status === 'expired' ? '결제 시간이 지났습니다. 태블릿에서 다시 시도해 주세요' : '취소된 결제입니다');
  if (Date.now() > d.expiresAt) { sysWrite([{ op: 'update', path: 'payments/' + pid, data: { status: 'expired' } }]); throw new E(409, 'pay_closed', '결제 시간이 지났습니다. 태블릿에서 다시 시도해 주세요'); }
  const now = Date.now(), oid = 'o' + now.toString(36) + '-' + d.tabletId + '-q';
  const order = { tabletId: d.tabletId, tabletName: d.tabletName, place: d.place, items: d.items, total: d.total, status: 'new', pay: 'paid', payMethod: method, payId: pid, test: d.test, dateKey: dayKey(new Date(now)), createdAt: now, updatedAt: now, memo: '', log: [{ at: now, t: method + ' 결제 완료 → 주문 (고객 화면)' }] };
  applyOps([{ op: 'set', path: 'orders/' + oid, data: order }, { op: 'update', path: 'payments/' + pid, data: { status: 'paid', paidAt: now, orderId: oid, method } }], true);
  log('QR 결제 완료:', d.tabletName || d.tabletId, d.total + '원', '(' + method + ')');
  return oid;
}
setInterval(() => { const now = Date.now(), ops = []; for (const [k, v] of store) if (k.startsWith('payments/') && v.data && v.data.status === 'pending' && now > v.data.expiresAt) ops.push({ op: 'update', path: k, data: { status: 'expired' } }); if (ops.length) sysWrite(ops.slice(0, 50)); }, 15000);
const payEsc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function payPage(pid) {
  const p = store.get('payments/' + pid); const d = p && p.data;
  const cfg = (store.get('config/main') || {}).data || {}; const nm = payEsc(cfg.storeName || '테이블 오더');
  const won = n => (Number(n) || 0).toLocaleString('ko-KR') + '원';
  const head = '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + nm + ' 결제</title><style>body{margin:0;font-family:-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;background:#f6f1e7;color:#1f2a24}main{max-width:460px;margin:0 auto;padding:22px}h1{font-size:20px;margin:0 0 4px}.room{color:#6b6b6b;margin-bottom:16px}.card{background:#fff;border-radius:16px;padding:16px;box-shadow:0 6px 20px -12px #0004;margin-bottom:14px}.row{display:flex;justify-content:space-between;gap:8px;padding:7px 0;border-bottom:1px dashed #e5ddd0}.row:last-child{border:0}.row small{display:block;color:#8a8a8a}.tot{font-size:22px;font-weight:800;display:flex;justify-content:space-between}.btn{display:block;width:100%;border:0;border-radius:999px;padding:16px;font-size:17px;font-weight:800;margin-top:10px}.pay{background:#1f6b42;color:#fff}.ghost{background:#efe6d6;color:#3b3b3b}.test{background:#fff4d6;color:#7a5a00;border-radius:12px;padding:10px 12px;font-size:14px;margin-bottom:12px}.msg{text-align:center;font-size:18px;font-weight:800;padding:30px 0}</style></head><body><main><h1>' + nm + '</h1>';
  if (!d) return head + '<div class="msg">결제 정보를 찾을 수 없습니다.</div></main></body></html>';
  const st = d.status === 'pending' && Date.now() > d.expiresAt ? 'expired' : d.status;
  let h = head + '<div class="room">' + payEsc(d.tabletName || d.place || '') + ' 주문</div>';
  h += '<div class="card">' + d.items.map(it => '<div class="row"><span>' + payEsc(it.name) + ' × ' + it.qty + (it.opts && it.opts.length ? '<small>' + payEsc(it.opts.map(o => o.n).join(', ')) + '</small>' : '') + '</span><b>' + won(it.unit * it.qty) + '</b></div>').join('') + '</div><div class="card tot"><span>결제 금액</span><span>' + won(d.total) + '</span></div>';
  if (st === 'paid') return h + '<div class="msg">✓ 결제가 완료됐습니다.<br>주문이 매장으로 들어갔어요.</div></main></body></html>';
  if (st !== 'pending') return h + '<div class="msg">' + (st === 'expired' ? '결제 시간이 지났습니다.<br>태블릿에서 다시 결제해 주세요.' : '취소된 결제입니다.') + '</div></main></body></html>';
  if (d.provider === 'test') h += '<div class="test">⚠ 테스트 결제입니다. 실제로 돈이 나가지 않습니다. 실제 결제는 포스 연동(또는 결제 회사 가입) 후 열립니다.</div><form method="post" action="/pay/' + pid + '/test"><button class="btn pay">테스트 결제하기</button></form>';
  else h += '<div class="test">결제 연동 준비 중입니다. 카운터에서 결제해 주세요.</div>';
  return h + '<form method="post" action="/pay/' + pid + '/cancel"><button class="btn ghost">결제 취소</button></form></main></body></html>';
}
function payQrSvg(pid, host) {
  const h = /^[\w.\-]+(:\d+)?$/.test(String(host || '')) ? host : ('localhost:' + PORT);
  const q = qrcodeLib(0, 'M'); q.addData('http://' + h + '/pay/' + pid); q.make();
  return q.createSvgTag({ cellSize: 8, margin: 2 });
}

/* ---------------- 관리 PIN ---------------- */
let conf = {};
try { conf = JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch (e) { }
const saveConf0 = () => fs.writeFileSync(CONF, JSON.stringify(conf, null, 2));
const RESET = path.join(DATA, 'reset-pin.txt');
if (fs.existsSync(RESET)) { delete conf.pinHash; delete conf.salt; saveConf0(); try { fs.unlinkSync(RESET); } catch (e) { } console.log('관리 PIN을 지웠습니다. 주문받는 태블릿에서 새로 만들어 주세요.'); }
const saveConf = () => fs.writeFileSync(CONF, JSON.stringify(conf, null, 2));
const hashPin = (p, salt) => crypto.scryptSync(String(p), salt, 32).toString('hex');
let goodPin = null;
function pinOk(p) {
  if (!p || !conf.pinHash) return false;
  p = String(p);
  if (goodPin !== null && p.length === goodPin.length && crypto.timingSafeEqual(Buffer.from(p), Buffer.from(goodPin))) return true;
  const ok = crypto.timingSafeEqual(Buffer.from(hashPin(p, conf.salt), 'hex'), Buffer.from(conf.pinHash, 'hex'));
  if (ok) goodPin = p;
  return ok;
}
function setPin(p) { conf.salt = crypto.randomBytes(16).toString('hex'); conf.pinHash = hashPin(p, conf.salt); goodPin = null; saveConf(); }
const fails = new Map();
const limited = ip => { const f = fails.get(ip); return !!(f && f.n >= 8 && Date.now() - f.t < 5 * 60000); };
const fail = ip => { const f = fails.get(ip); if (!f || Date.now() - f.t > 5 * 60000) fails.set(ip, { n: 1, t: Date.now() }); else f.n++; };
function adminReq(req, ip) {
  const h = req.headers['x-admin-pin']; if (!h) return false;
  if (limited(ip)) throw new E(429, 'rate_limited', '잠시 후 다시 시도해 주세요');
  const ok = pinOk(h); if (!ok) fail(ip); return ok;
}
const needAdmin = (req, ip) => { if (!adminReq(req, ip)) throw new E(403, 'not_permitted', '관리 PIN이 필요합니다'); };

/* ---------------- 실시간 연결(SSE)과 태블릿 연결 감지 ---------------- */
const clients = new Map(); // 접속 id -> { res, presence, last, pt }
function broadcast(ev, data) {
  const s = 'event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const c of clients.values()) if (c.res) { try { c.res.write(s); } catch (e) { } }
}
const peerList = () => [...clients.values()].filter(c => c.res && c.presence && c.presence.dev).map(c => ({ presence: c.presence, updatedAt: c.pt || 0 }));
function devsOnline() { const s = new Set(); for (const c of clients.values()) if (c.res && c.presence && typeof c.presence.dev === 'string') s.add(c.presence.dev); return s; }
let lastDevs = new Set();
const lostT = new Map(), openInc = new Map();
function peersChanged() {
  broadcast('peers', peerList());
  const cur = devsOnline();
  for (const d of lastDevs) if (!cur.has(d)) devLost(d);
  for (const d of cur) if (!lastDevs.has(d)) devBack(d);
  lastDevs = cur;
}
function devLost(d) {
  if (lostT.has(d) || !store.has('tablets/' + d)) return;
  const at = Date.now();
  lostT.set(d, setTimeout(() => {
    lostT.delete(d);
    if (devsOnline().has(d)) return;
    const t = store.get('tablets/' + d), p = 'incidents/s' + at.toString(36) + '-' + d;
    openInc.set(d, p);
    sysWrite([{ op: 'set', path: p, data: { tabletId: d, tabletName: t ? t.data.name : d, kind: '연결 끊김', source: 'server', at, endAt: null, note: '미니 서버가 감지', dateKey: dayKey(new Date(at)) } }]);
    log('연결 끊김:', t ? t.data.name : d);
  }, 20000));
}
function devBack(d) {
  const t = lostT.get(d); if (t) { clearTimeout(t); lostT.delete(d); }
  const p = openInc.get(d);
  if (p) { openInc.delete(d); if (store.get(p)) sysWrite([{ op: 'update', path: p, data: { endAt: Date.now() } }]); log('다시 연결:', d); }
}
function sanitizePresence(p) {
  const o = {};
  if (isObj(p)) for (const k of ['dev', 'role']) if (typeof p[k] === 'string' && p[k].length <= 64) o[k] = p[k];
  return o;
}
function sse(req, res, u) {
  const cid = String(u.searchParams.get('c') || '');
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(cid)) return json(res, 400, { code: 'invalid_argument' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  let c = clients.get(cid);
  if (c && c.res && c.res !== res) { try { c.res.end(); } catch (e) { } }
  if (!c) { c = { presence: {}, last: Date.now() }; clients.set(cid, c); }
  c.res = res; c.last = Date.now();
  res.write('event: hello\ndata: ' + JSON.stringify({ now: Date.now(), version: curVersion(), page: pageHash }) + '\n\n');
  res.write('event: peers\ndata: ' + JSON.stringify(peerList()) + '\n\n');
  req.on('close', () => { if (c.res === res) { c.res = null; clients.delete(cid); peersChanged(); } });
}
setInterval(() => { // 응답 없는 태블릿 정리(와이파이 끊김 등)
  let changed = false;
  for (const [id, c] of clients) if (Date.now() - c.last > 30000) { try { c.res && c.res.end(); } catch (e) { } clients.delete(id); changed = true; }
  if (changed) peersChanged();
}, 5000);
setInterval(() => { for (const c of clients.values()) if (c.res) { try { c.res.write(': ping\n\n'); } catch (e) { } } }, 15000);

/* ---------------- 파일(동영상·사진) ---------------- */
const assetIdx = new Map(); // id -> 파일 이름
for (const f of fs.readdirSync(UP)) {
  if (f.endsWith('.part')) { try { fs.unlinkSync(path.join(UP, f)); } catch (e) { } continue; }
  const m = /^([a-f0-9]{32})\.(\w+)$/.exec(f); if (m) assetIdx.set(m[1], f);
}
function freeBytes() { try { if (fs.statfsSync) { const s = fs.statfsSync(DATA); return s.bavail * s.bsize; } } catch (e) { } return null; }
function serveFile(req, res, file, type, noCache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { code: 'not_found' });
    const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': noCache ? 'no-cache' : 'public, max-age=31536000, immutable' };
    const range = req.headers.range, head = req.method === 'HEAD';
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      let s, e;
      if (m && m[1] !== '') { s = +m[1]; e = m[2] !== '' ? Math.min(+m[2], st.size - 1) : st.size - 1; }
      else if (m && m[2] !== '') { s = Math.max(0, st.size - +m[2]); e = st.size - 1; }
      if (!m || s > e || s >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      res.writeHead(206, { ...h, 'Content-Range': 'bytes ' + s + '-' + e + '/' + st.size, 'Content-Length': e - s + 1 });
      if (head) return res.end();
      return fs.createReadStream(file, { start: s, end: e }).pipe(res);
    }
    res.writeHead(200, { ...h, 'Content-Length': st.size });
    if (head) return res.end();
    fs.createReadStream(file).pipe(res);
  });
}
function receiveUpload(req, tmp) {
  return new Promise((ok, no) => {
    let n = 0, done = false;
    const ws = fs.createWriteStream(tmp);
    const bad = e => { if (done) return; done = true; ws.destroy(); try { fs.unlinkSync(tmp); } catch (x) { } no(e); };
    req.on('data', c => { n += c.length; if (n > MAX_UPLOAD) { bad(new E(413, 'too_large', '파일이 너무 큽니다 (최대 2GB)')); req.destroy(); } });
    req.on('aborted', () => bad(new E(400, 'invalid_request', '올리기가 중간에 끊겼습니다')));
    req.on('error', bad);
    ws.on('error', bad);
    ws.on('finish', () => { if (!done) { done = true; ok(n); } });
    req.pipe(ws);
  });
}

/* ---------------- HTTP ---------------- */
function json(res, st, o) {
  if (res.headersSent) { try { res.end(); } catch (e) { } return; }
  res.writeHead(st, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(o));
}
function body(req, limit = 1024 * 1024) {
  return new Promise((ok, no) => {
    let n = 0; const ch = [];
    req.on('data', c => { n += c.length; if (n > limit) { no(new E(413, 'invalid_argument', '요청이 너무 큽니다')); req.destroy(); } else ch.push(c); });
    req.on('end', () => { try { ok(ch.length ? JSON.parse(Buffer.concat(ch).toString('utf8')) : {}); } catch (e) { no(new E(400, 'invalid_argument', 'JSON 형식 오류')); } });
    req.on('error', no);
  });
}
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
  return out;
}
async function handle(req, res) {
  const u = new URL(req.url, 'http://local'), p = u.pathname, m = req.method;
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if ((m === 'GET' || m === 'HEAD') && (p === '/' || p === '/index.html')) {
    if (!pageBuf) refreshPageHash(); if (!pageBuf) return json(res, 404, { code: 'not_found' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': pageBuf.length, 'Cache-Control': 'no-cache' });
    return m === 'HEAD' ? res.end() : res.end(pageBuf);
  }
  if (m === 'POST' && p === '/api/pay/start') { const b = await body(req); return json(res, 200, payStart(b, req.headers.host)); }
  if (m === 'POST' && p === '/api/pay/cancel') { const b = await body(req); const x = store.get('payments/' + String(b.id || '')); if (x && x.data && x.data.status === 'pending') applyOps([{ op: 'update', path: 'payments/' + String(b.id), data: { status: 'canceled', canceledAt: Date.now() } }], true); return json(res, 200, { ok: true }); }
  { const mm = /^\/pay\/(p[a-z0-9]{6,30})(\/(test|cancel|qr\.svg))?$/.exec(p);
    if (mm) {
      const pid = mm[1], act = mm[3];
      if (m === 'GET' && act === 'qr.svg') { res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' }); return res.end(payQrSvg(pid, req.headers.host)); }
      if (m === 'POST' && act === 'test') { const x = store.get('payments/' + pid); if (x && x.data && x.data.provider === 'test') { try { payComplete(pid, 'QR결제(테스트)'); } catch (e) { } } res.writeHead(303, { Location: '/pay/' + pid }); return res.end(); }
      if (m === 'POST' && act === 'cancel') { const x = store.get('payments/' + pid); if (x && x.data && x.data.status === 'pending') applyOps([{ op: 'update', path: 'payments/' + pid, data: { status: 'canceled', canceledAt: Date.now() } }], true); res.writeHead(303, { Location: '/pay/' + pid }); return res.end(); }
      if (m === 'GET' && !act) { const html = payPage(pid); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(html); }
    } }
  if (m === 'GET' && p === '/api/tts') {
    const t = String(u.searchParams.get('t') || '').slice(0, 120);
    if (!ttsAllowed(t)) throw new E(403, 'not_permitted', '허용되지 않은 문구');
    const f = await ttsWav(t); return serveFile(req, res, f, 'audio/wav', false);
  }
  if (m === 'GET' && p === '/api/print/ports') { needAdmin(req, ip); return json(res, 200, { ports: await listPorts() }); }
  if (m === 'POST' && p === '/api/print/test') {
    needAdmin(req, ip); const b = await body(req); const pc = isObj(b.printer) ? b.printer : (((store.get('config/main') || {}).data || {}).printer || {});
    const o = { id: 'test', tabletId: 't1', tabletName: '테스트', place: '', test: true, createdAt: Date.now(), total: 8200, memo: '한글 출력 시험: 가나다라마바사 아자차카타파하', items: [{ name: '아메리카노', qty: 1, unit: 3800, opts: [{ g: '온도', n: '아이스', p: 0 }] }, { name: '(한강라면!!)신라면', qty: 1, unit: 4400, opts: [] }] };
    await printJob({ ...pc, copies: 1 }, receipt(o, pc, { title: '테스트 출력' }), '테스트');
    return json(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/print/order') {
    needAdmin(req, ip); const b = await body(req); const d = store.get('orders/' + String(b.id || ''));
    if (!d) throw new E(404, 'not_found', '주문을 찾을 수 없습니다');
    const pc = ((store.get('config/main') || {}).data || {}).printer || {};
    if (!pc.port) throw new E(400, 'no_port', '설정에서 프린터 COM 포트를 먼저 정해 주세요');
    const o = { id: String(b.id), ...d.data };
    await printJob(pc, receipt(o, pc), roomName(o) + ' (다시 출력)');
    return json(res, 200, { ok: true });
  }
  if ((m === 'GET' || m === 'HEAD') && (p === '/app' || p === '/app.apk')) { res.writeHead(302, { Location: 'https://github.com/minamdale-wq/table-order-server/releases/latest/download/table-order-app.apk', 'Cache-Control': 'no-store' }); return res.end(); }
  if ((m === 'GET' || m === 'HEAD') && p === '/closed.jpg') { if (!fs.existsSync(path.join(PUB, 'closed.jpg'))) return json(res, 404, { error: { code: 'not_found' } }); return sendMem(req, res, path.join(PUB, 'closed.jpg'), 'image/jpeg'); }
  if (m === 'GET' && p === '/api/probe') return json(res, 200, { probe: String(u.searchParams.get('t') || '').slice(0, 40) });
  if (m === 'GET' && p === '/api/events') return sse(req, res, u);
  if ((m === 'GET' || m === 'HEAD') && p.startsWith('/_blob/')) {
    const id = p.slice(7), f = /^[a-f0-9]{32}$/.test(id) && assetIdx.get(id);
    if (!f) return json(res, 404, { code: 'not_found' });
    return serveFile(req, res, path.join(UP, f), EXT_TYPE[f.split('.').pop()] || 'application/octet-stream', false);
  }
  if (m === 'POST' && p === '/api/hb') {
    const b = await body(req), c = clients.get(String(b.c || ''));
    if (c) { c.last = Date.now(); const np = sanitizePresence(b.presence); if (JSON.stringify(np) !== JSON.stringify(c.presence)) { c.presence = np; c.pt = Date.now(); peersChanged(); } }
    return json(res, 200, { ok: !!c, now: Date.now() });
  }
  if (m === 'POST' && p === '/api/doc') { const b = await body(req); if (!isDoc(b.path)) throw new E(400, 'invalid_argument', '경로 오류'); return json(res, 200, { doc: store.get(b.path) || null }); }
  if (m === 'POST' && p === '/api/query') return json(res, 200, { docs: query(await body(req)) });
  if (m === 'POST' && p === '/api/write') { const b = await body(req); applyOps(b.ops, adminReq(req, ip)); return json(res, 200, { ok: true }); }

  if (m === 'GET' && p === '/api/auth/status') return json(res, 200, { pinSet: !!conf.pinHash });
  if (m === 'POST' && p === '/api/auth/setup') {
    const b = await body(req);
    if (conf.pinHash) throw new E(409, 'already_set', '관리 PIN이 이미 있습니다');
    if (!/^\d{4,6}$/.test(String(b.pin || ''))) throw new E(400, 'invalid_argument', '숫자 4~6자리');
    setPin(String(b.pin)); log('관리 PIN을 만들었습니다'); return json(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/auth/check') {
    const b = await body(req);
    if (limited(ip)) throw new E(429, 'rate_limited', '잠시 후 다시 시도해 주세요');
    const ok = pinOk(b.pin); if (!ok) fail(ip);
    return json(res, 200, { ok });
  }
  if (m === 'POST' && p === '/api/auth/change') {
    needAdmin(req, ip); const b = await body(req);
    if (!/^\d{4,6}$/.test(String(b.pin || ''))) throw new E(400, 'invalid_argument', '숫자 4~6자리');
    setPin(String(b.pin)); log('관리 PIN을 바꿨습니다'); return json(res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/upload') {
    needAdmin(req, ip);
    const type = String(u.searchParams.get('type') || ''), ext = TYPES[type];
    if (!ext) throw new E(415, 'unsupported_type', 'mp4, webm, png, jpg, webp, gif만 올릴 수 있습니다');
    if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) throw new E(413, 'too_large', '파일이 너무 큽니다 (최대 2GB)');
    const id = crypto.randomBytes(16).toString('hex'), name = id + '.' + ext, file = path.join(UP, name), tmp = file + '.part';
    const n = await receiveUpload(req, tmp);
    if (!n) { try { fs.unlinkSync(tmp); } catch (e) { } throw new E(400, 'invalid_request', '빈 파일입니다'); }
    fs.renameSync(tmp, file); assetIdx.set(id, name);
    log('파일 올림:', name, (n / 1048576).toFixed(1) + 'MB');
    return json(res, 200, { id, url: '/_blob/' + id, sizeBytes: n, contentType: type });
  }
  if (m === 'GET' && p === '/api/assets') {
    const assets = []; let bytes = 0;
    for (const [id, f] of assetIdx) { try { const st = fs.statSync(path.join(UP, f)); bytes += st.size; assets.push({ id, url: '/_blob/' + id, contentType: EXT_TYPE[f.split('.').pop()], sizeBytes: st.size, createdAt: st.mtime.toISOString() }); } catch (e) { } }
    return json(res, 200, { assets, usage: { files: assets.length, bytes, freeBytes: freeBytes() } });
  }
  if (m === 'POST' && p === '/api/assets/delete') {
    needAdmin(req, ip); const b = await body(req); const id = String(b.id || '').replace(/^\/_blob\//, '');
    const f = assetIdx.get(id); if (!f) return json(res, 200, { deleted: false });
    try { fs.unlinkSync(path.join(UP, f)); } catch (e) { }
    assetIdx.delete(id); log('파일 삭제:', f); return json(res, 200, { deleted: true });
  }
  if (m === 'GET' && p === '/api/backup') {
    needAdmin(req, ip);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="table-order-backup-' + dayKey(new Date()) + '.json"', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(Object.fromEntries(store)));
  }
  if (m === 'GET' && p === '/api/update/check') {
    needAdmin(req, ip); const mf = await getManifest();
    return json(res, 200, { current: curVersion(), latest: mf.version, notes: String(mf.notes || ''), available: cmpVer(mf.version, curVersion()) > 0 });
  }
  if (m === 'POST' && p === '/api/update/apply') {
    needAdmin(req, ip); if (updating) throw new E(409, 'busy', '업데이트가 이미 진행 중입니다');
    updating = true;
    try {
      const mf = await getManifest();
      if (cmpVer(mf.version, curVersion()) <= 0) return json(res, 200, { ok: true, upToDate: true, version: curVersion() });
      const files = new Map();
      for (const f of mf.files) files.set(f, await fetchBuf(UPDATE_SRC + f + '?t=' + Date.now()));
      const r = installFiles(files, '업데이트 ' + curVersion() + ' → ' + mf.version);
      json(res, 200, { ok: true, version: mf.version, restart: r.restart, supervised: SUPERVISED });
      if (r.restart && SUPERVISED) restartSoon();
    } finally { updating = false; }
    return;
  }
  if (m === 'GET' && p === '/api/update/backups') { needAdmin(req, ip); return json(res, 200, { backups: listBackups() }); }
  if (m === 'POST' && p === '/api/update/rollback') {
    needAdmin(req, ip); if (updating) throw new E(409, 'busy', '업데이트가 이미 진행 중입니다');
    const b = await body(req), list = listBackups();
    const pick = b.name ? list.find(x => x.name === b.name) : list.find(x => cmpVer(x.version, curVersion()) < 0);
    if (!pick) throw new E(404, 'no_backup', '되돌릴 이전 버전이 없습니다');
    updating = true;
    try {
      const files = new Map();
      for (const f of UPDATABLE) { const src = path.join(VERS, pick.name, f); if (fs.existsSync(src)) files.set(f, fs.readFileSync(src)); }
      const r = installFiles(files, '되돌리기 → ' + pick.version);
      fs.rmSync(path.join(VERS, pick.name), { recursive: true, force: true });
      json(res, 200, { ok: true, version: pick.version, restart: r.restart, supervised: SUPERVISED });
      if (r.restart && SUPERVISED) restartSoon();
    } finally { updating = false; }
    return;
  }
  if (m === 'GET' && p === '/api/info') return json(res, 200, { version: curVersion(), supervised: SUPERVISED, port: PORT, addresses: lanAddresses(), startedAt: STARTED, docs: store.size, now: Date.now() });
  json(res, 404, { code: 'not_found' });
}

/* ---------------- 프로그램 업데이트 (GitHub) ---------------- */
let updating = false;
const sha = b => crypto.createHash('sha1').update(b).digest('hex').slice(0, 12);
let pageHash = '';
// 화면 파일은 메모리에 올려서 보냄 → 느린 태블릿이 파일을 붙잡고 있어 업데이트가 막히는 일을 없앰
let pageBuf = null;
function refreshPageHash() { try { pageBuf = fs.readFileSync(path.join(PUB, 'index.html')); pageHash = sha(pageBuf); } catch (e) { pageBuf = null; pageHash = ''; } }
const memFiles = new Map();
function sendMem(req, res, file, type) {
  let st; try { st = fs.statSync(file); } catch (e) { return json(res, 404, { code: 'not_found' }); }
  let c = memFiles.get(file);
  if (!c || c.mtime !== st.mtimeMs || c.size !== st.size) { try { c = { buf: fs.readFileSync(file), mtime: st.mtimeMs, size: st.size }; memFiles.set(file, c); } catch (e) { return json(res, 404, { code: 'not_found' }); } }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': c.buf.length, 'Cache-Control': 'no-cache' });
  return req.method === 'HEAD' ? res.end() : res.end(c.buf);
}
refreshPageHash();
function curVersion() { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).version || VERSION; } catch (e) { return VERSION; } }
function cmpVer(a, b) { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; }
async function fetchBuf(url) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 30000);
  try { const r = await fetch(url, { signal: ac.signal, cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); return Buffer.from(await r.arrayBuffer()); }
  catch (e) { throw new E(502, 'update_unreachable', '업데이트 서버(GitHub)에 연결할 수 없습니다: ' + e.message); }
  finally { clearTimeout(t); }
}
async function getManifest() {
  let mf; try { mf = JSON.parse((await fetchBuf(UPDATE_SRC + 'version.json?t=' + Date.now())).toString('utf8')); } catch (e) { if (e instanceof E) throw e; throw new E(502, 'update_invalid', '업데이트 정보가 올바르지 않습니다'); }
  if (!mf || !/^\d+\.\d+\.\d+$/.test(String(mf.version)) || !Array.isArray(mf.files) || !mf.files.length || !mf.files.every(f => UPDATABLE.includes(f))) throw new E(502, 'update_invalid', '업데이트 정보가 올바르지 않습니다');
  return mf;
}
function stamp() { const d = new Date(); return dayKey(d).replace(/-/g, '') + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()); }
function listBackups() {
  return fs.readdirSync(VERS).filter(n => /^[\d.]+-\d{8}-\d{6}$/.test(n)).sort((a, b) => b.split('-').slice(1).join('').localeCompare(a.split('-').slice(1).join('')))
    .map(n => ({ name: n, version: n.split('-')[0] }));
}
const sleepMs = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { } };
// 윈도우에서 백신 검사 등으로 파일이 잠깐 잠겨 있으면 이름 바꾸기가 실패하므로 여러 번 다시 시도
function replaceFile(dst, buf) {
  const tmp = dst + '.new'; fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(tmp, buf);
  let last;
  for (let i = 0; i < 20; i++) { try { fs.renameSync(tmp, dst); return; } catch (e) { last = e; sleepMs(250); } }
  try { fs.copyFileSync(tmp, dst); try { fs.unlinkSync(tmp); } catch (e) { } return; } catch (e) { last = e; }
  try { fs.unlinkSync(tmp); } catch (e) { }
  throw last;
}
function installFiles(files, label) {
  // 1) 검사
  const stage = path.join(VERS, '_staging'); fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });
  if (files.has('server.js')) {
    const f = path.join(stage, 'server.js'); fs.writeFileSync(f, files.get('server.js'));
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) { fs.rmSync(stage, { recursive: true, force: true }); throw new E(500, 'update_invalid', '새 server.js에 오류가 있어 업데이트를 취소했습니다'); }
  }
  if (files.has('public/index.html') && !/^\s*<!DOCTYPE html>/i.test(files.get('public/index.html').toString('utf8', 0, 200))) throw new E(500, 'update_invalid', '새 화면 파일이 올바르지 않아 업데이트를 취소했습니다');
  if (files.has('version.json')) { try { JSON.parse(files.get('version.json').toString('utf8')); } catch (e) { throw new E(500, 'update_invalid', 'version.json 오류'); } }
  fs.rmSync(stage, { recursive: true, force: true });
  // 2) 지금 버전 보관
  const bdir = path.join(VERS, curVersion() + '-' + stamp());
  for (const f of UPDATABLE) { const src = path.join(ROOT, f); if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(path.join(bdir, f)), { recursive: true }); fs.copyFileSync(src, path.join(bdir, f)); } }
  const all = listBackups(); for (const b of all.slice(10)) fs.rmSync(path.join(VERS, b.name), { recursive: true, force: true });
  // 3) 교체
  let restart = false;
  for (const [f, buf] of files) {
    const dst = path.join(ROOT, f);
    if (f === 'server.js') { try { restart = !fs.readFileSync(dst).equals(buf); } catch (e) { restart = true; } }
    try { replaceFile(dst, buf); }
    catch (e) { if (['server.js', 'public/index.html', 'version.json'].includes(f)) throw e; log('업데이트 중 ' + f + ' 파일을 바꾸지 못해 건너뜁니다:', e.code || e.message); }
    if (f.endsWith('.command')) { try { fs.chmodSync(dst, 0o755); } catch (e) { } }
  }
  const before = pageHash; refreshPageHash();
  if (pageHash !== before) broadcast('reload', { page: pageHash });
  log(label + ' 완료' + (restart ? ' (서버 다시 시작 필요)' : ''));
  return { restart };
}
function restartSoon() { log('새 서버 프로그램으로 다시 시작합니다…'); setTimeout(() => { try { compact(); } catch (e) { } process.exit(0); }, 1500); }

/* ---------------- 처음 실행 시 기본 데이터 ---------------- */
function seed() {
  if (conf.seeded || store.size) return;
  const ops = [];
  for (let i = 1; i <= 6; i++) ops.push({ op: 'set', path: 'tablets/t' + i, data: { no: i, name: '주문용 ' + i, role: 'customer', place: '', model: '', note: '30인치', testMode: false } });
  ops.push({ op: 'set', path: 'tablets/t7', data: { no: 7, name: '주문받는 태블릿', role: 'counter', place: '카운터', model: '', note: '메뉴·가격·품절 수정은 이 기기에서', testMode: false } });
  const D = [
    ['태블릿 명칭: \'오더용\'과 \'주문용\' 중 어느 쪽이 고객용인가', '요청과 프로젝트 설명의 표현이 서로 반대입니다. 지금은 30인치 6대 = 고객 주문용, 1대 = 주문받고 메뉴를 수정하는 카운터로 만들었습니다.'],
    ['주문용 태블릿 6대와 룸(방) 매칭', '태블릿 탭에서 각 기기의 \'위치·룸 이름\'을 넣으면 고객 화면과 주문 전표에 표시됩니다.'],
    ['태블릿 기종·OS·화면 방향·해상도', '가로 기준으로 짰고 세로에서도 동작합니다. 실제 기기에서 확인이 필요합니다.'],
    ['부팅 자동실행·전체화면·화면 고정 방법', '헤이밥 앱은 삭제 완료(11/24). Fully Kiosk Browser 같은 키오스크 브라우저를 쓸지, 전용 안드로이드 앱을 만들지.'],
    ['서버 컴퓨터 정하기', '윈도우·맥·미니PC 중 무엇을 쓸지. 항상 켜 두고 절전·자동 업데이트 재부팅을 꺼야 합니다. 정전 후 자동 켜짐 설정이 있으면 좋습니다.'],
    ['서버 컴퓨터 IP 고정', '공유기 설정에서 서버 컴퓨터에 고정 IP(DHCP 예약)를 주지 않으면 주소가 바뀌어 태블릿이 접속하지 못할 수 있습니다.'],
    ['손님용 와이파이와 매장 기기 와이파이 분리', '손님이 같은 와이파이에서 서버 주소로 들어오는 것을 막으려면 기기용 와이파이를 따로 두는 것이 안전합니다. 관리 기능은 PIN으로 막혀 있습니다.'],
    ['결제 수단 목록과 카드단말기(VAN) 연동', '지금은 결제를 기존 단말기·현금으로 받고 \'결제 완료\'만 기록합니다(카드/현금/계좌이체/기타).'],
    ['주문 상태 단계', '지금은 신규 → 접수 → 전달 완료(+취소). \'조리 중\' 등이 더 필요한지.'],
    ['고객의 직접 취소·수정 허용 여부', '지금은 주문받는 태블릿에서만 취소·수정할 수 있습니다.'],
    ['영업일 기준(자정 vs 새벽 마감)', '지금은 날짜(자정 기준)로 일자별 매출을 나눕니다. 주문 현황·정산에는 어제·오늘 주문이 함께 보입니다.'],
    ['하단 동영상 소리', '파일(최대 2GB)과 유튜브 링크를 섞어 재생 목록으로 틉니다. 화면 비율은 주문 6 : 동영상 4로 정함. 소리 필요 여부(지금은 무음)만 남음.'],
    ['메뉴·분류·옵션·가격·사진', '아직 입력하지 않았습니다. 메뉴 관리 탭에서 입력하면 모든 주문용 태블릿에 바로 반영됩니다.'],
    ['주문 알림 방식과 주방 프린터', '지금은 화면 표시와 알림음만 있습니다. 전표 프린터 출력이 필요한지.'],
    ['백업 보관 방법', '서버가 매일 data/backups에 자동 백업(60일 보관)합니다. USB나 클라우드로 따로 복사할지, 주기는 어떻게 할지.'],
    ['직원 호출 사유 버튼 목록', '설정 탭에서 쉼표로 구분해 넣습니다. 비워 두면 사유 없이 호출만 합니다.'],
  ];
  D.forEach(([title, detail], i) => ops.push({ op: 'set', path: 'decisions/d' + pad(i + 1), data: { sort: i + 1, status: 'open', answer: '', title, detail } }));
  for (let i = 0; i < ops.length; i += 50) applyOps(ops.slice(i, i + 50), true);
  conf.seeded = true; saveConf();
  log('기본 데이터(태블릿 7대, 확인 필요 목록)를 만들었습니다');
}
function checkDowntime() {
  try {
    const last = Number(fs.readFileSync(ALIVE, 'utf8'));
    if (last && Date.now() - last > 120000) sysWrite([{ op: 'set', path: 'incidents/srv' + last.toString(36), data: { tabletId: 'server', tabletName: '미니 서버', kind: '서버 꺼짐', source: 'server', at: last, endAt: Date.now(), note: '서버 컴퓨터가 꺼져 있었거나 프로그램이 멈춰 있었음', dateKey: dayKey(new Date(last)) } }]);
  } catch (e) { }
  const beat = () => { try { fs.writeFileSync(ALIVE, String(Date.now())); } catch (e) { } };
  beat(); setInterval(beat, 60000);
}

/* ---------------- 시작 ---------------- */
const STARTED = Date.now();
loadStore();
seed();
checkDowntime();
dailyBackup(); setInterval(dailyBackup, 10 * 60 * 1000);
const server = http.createServer((req, res) => {
  if (!String(req.url).startsWith('/api/events')) res.setTimeout(120000, () => { try { res.destroy(); } catch (e) { } });
  handle(req, res).catch(e => {
    if (e instanceof E) return json(res, e.status, { code: e.code, message: e.message });
    log('오류:', e && e.stack || e); json(res, 500, { code: 'upstream_error', message: '서버 오류' });
  });
});
server.requestTimeout = 0; server.timeout = 0; server.keepAliveTimeout = 65000;
/* 같은 포트를 다른 프로그램이 가로채고 있는지 스스로 확인하고, 그렇다면 다른 포트로 옮김 */
function probe(addr, port) {
  return new Promise(done => {
    const tok = crypto.randomBytes(8).toString('hex');
    const req = http.get({ host: addr, port, path: '/api/probe?t=' + tok, timeout: 3000, agent: false }, r => {
      let b = ''; r.on('data', c => { b += c; }); r.on('end', () => done(b.includes(tok) ? 'ok' : 'other(HTTP ' + r.statusCode + ')')); r.on('error', e => done('other(' + (e.code || e.message) + ')'));
    });
    req.on('timeout', () => { req.destroy(); done('timeout'); });
    req.on('error', e => done(e.code === 'ECONNRESET' || /hang up/i.test(e.message) ? 'other(' + (e.code || 'hang up') + ')' : 'error:' + (e.code || e.message)));
  });
}
const isOther = r => typeof r === 'string' && r.startsWith('other');
function banner(addrs, results) {
  console.log('\n==================== 테이블 오더 미니 서버 v' + curVersion() + ' ====================');
  if (!addrs.length) console.log('  와이파이/랜에 연결되어 있지 않습니다. 네트워크를 확인해 주세요.');
  for (const a of addrs) {
    console.log('  주문받는 태블릿 :  http://' + a + ':' + PORT + '/#t7');
    console.log('  주문용 태블릿   :  http://' + a + ':' + PORT + '/#t1  ~  #t6');
    const r = results[a];
    if (r && r !== 'ok') console.log('  ※ 이 컴퓨터에서 이 주소로 자가 확인 실패(' + r + '). 태블릿에서 열리지 않으면 방화벽·보안 프로그램·VPN 설정을 확인해 주세요.');
  }
  console.log('  이 컴퓨터에서만 열 때 :  http://localhost:' + PORT + '/#t7');
  console.log('  데이터 폴더     :  ' + DATA);
  console.log('  이 창을 닫으면 주문이 멈춥니다. 서버 컴퓨터는 항상 켜 두세요.');
  console.log('==========================================================================\n');
}
const preferred = Number(process.env.PORT) || conf.port;
const ports = [preferred, ...PORT_CANDIDATES].filter((v, i, a) => v && a.indexOf(v) === i);
let fallbackOnly = false;
function tryListen(i) {
  if (i >= ports.length) {
    // 모든 포트에서 자가 확인이 실패 = 포트 문제가 아니라 이 컴퓨터의 보안·네트워크 설정 문제. 멈추지 말고 첫 포트로 그냥 켠다.
    const fb = Math.max(0, ports.indexOf(8765));
    log('모든 포트에서 자가 확인이 실패했습니다. 포트 문제가 아니므로 포트 ' + ports[fb] + '(으)로 그냥 켭니다.');
    fallbackOnly = true; return tryListen(fb);
  }
  PORT = ports[i];
  const onErr = async e => {
    server.removeListener('listening', onOk);
    if (e.code === 'EADDRINUSE') {
      // 이 포트를 쓰는 게 테이블 오더 서버(같은 프로그램)라면 이미 켜져 있는 것 → 두 번째 서버는 켜지 않는다 (데이터가 꼬이지 않게)
      const mine = await probe('127.0.0.1', PORT);
      if (mine === 'ok') {
        log('테이블 오더 서버가 이미 다른 창에서 켜져 있습니다 (포트 ' + PORT + '). 이 창은 닫으셔도 됩니다.');
        process.exit(3);
      }
    }
    if (e.code === 'EADDRINUSE' || e.code === 'EACCES') {
      log('포트 ' + PORT + '은(는) 다른 프로그램이 쓰고 있어 다음 포트를 시도합니다.');
      if (fallbackOnly && i + 1 >= ports.length) { log('쓸 수 있는 포트를 찾지 못했습니다. 컴퓨터를 다시 시작한 뒤 다시 켜 주세요.'); process.exit(1); }
      return tryListen(i + 1);
    }
    log('서버 오류:', e.message); process.exit(1);
  };
  const onOk = async () => {
    server.removeListener('error', onErr);
    const addrs = lanAddresses(), results = {};
    const local = await probe('127.0.0.1', PORT);
    for (const a of addrs) results[a] = await probe(a, PORT);
    // 이 컴퓨터 안에서도(127.0.0.1) 다른 프로그램이 답하면 진짜로 포트를 뺏긴 것 → 다음 포트로
    const hijacked = isOther(local) || (!fallbackOnly && addrs.length && addrs.every(a => isOther(results[a])));
    if (hijacked && !fallbackOnly) {
      log('포트 ' + PORT + ' 자가 확인 실패(내부 ' + local + ', 와이파이 ' + addrs.map(a => results[a]).join('/') + ') → 다음 포트로 옮겨 봅니다.');
      return server.close(() => tryListen(i + 1));
    }
    if (conf.port !== PORT) { conf.port = PORT; saveConf(); }
    server.on('error', e => log('서버 오류:', e.message));
    banner(addrs, results);
  };
  server.once('error', onErr);
  server.once('listening', onOk);
  server.listen(PORT, '0.0.0.0');
}
tryListen(0);
/* 준비 중 화면 기본 그림이 없으면 받아 둠 (예전 버전에서 업데이트한 경우) */
// 준비 중 화면 기본 그림: 이 버전에 맞는 그림이 아니면 GitHub에서 받아 바꿈
const CLOSED_SHA1 = '6db00d0272d9006aec90c855e628f7e491c88de1';
(async () => { const f = path.join(PUB, 'closed.jpg');
  try { if (fs.existsSync(f) && crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex') === CLOSED_SHA1) return; } catch (e) { }
  for (let i = 0; i < 3; i++) { try { const b = await fetchBuf(UPDATE_SRC + 'public/closed.jpg?t=' + Date.now());
    if (b && b.length > 1000 && b[0] === 0xFF && b[1] === 0xD8 && crypto.createHash('sha1').update(b).digest('hex') === CLOSED_SHA1) { replaceFile(f, b); log('준비 중 화면 그림을 새 그림으로 바꿨습니다.'); return; }
  } catch (e) { log('준비 중 그림 받기 실패:', e.code || e.message); } await new Promise(r => setTimeout(r, 20000)); }
})();
function shutdown() { log('서버를 끕니다…'); try { compact(); } catch (e) { } process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
