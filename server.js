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
const UPDATABLE = ['server.js', 'public/index.html', 'version.json', 'README.md', 'start-windows.bat', 'start-mac.command', 'table-order.service'];
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
    if (!admin && !allowed(o, cur)) throw new E(403, 'not_permitted', '관리 PIN이 필요합니다');
  }
  const now = Date.now(), ch = [];
  for (const o of ops) {
    const cur = store.get(o.path);
    if (o.op === 'delete') { if (!cur) continue; store.delete(o.path); ch.push({ p: o.path, v: null }); continue; }
    if (o.op === 'set' && o.path.startsWith('orders/') && sameOrder(cur, o.data)) continue; // 같은 주문 재전송은 무시
    const v = { data: o.op === 'set' ? o.data : merge(cur.data, o.data), version: (cur ? cur.version : 0) + 1, updatedAt: now };
    store.set(o.path, v); ch.push({ p: o.path, v });
  }
  if (ch.length) { journal(ch); broadcast('change', { paths: ch.map(c => c.p) }); }
}
const sysWrite = ops => { try { applyOps(ops, true); } catch (e) { log('기록 실패', e.message); } };

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
  if ((m === 'GET' || m === 'HEAD') && (p === '/' || p === '/index.html')) return serveFile(req, res, path.join(PUB, 'index.html'), 'text/html; charset=utf-8', true);
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
function refreshPageHash() { try { pageHash = sha(fs.readFileSync(path.join(PUB, 'index.html'))); } catch (e) { pageHash = ''; } }
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
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst + '.new', buf); fs.renameSync(dst + '.new', dst);
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
      let b = ''; r.on('data', c => { b += c; }); r.on('end', () => done(b.includes(tok) ? 'ok' : 'other')); r.on('error', () => done('other'));
    });
    req.on('timeout', () => { req.destroy(); done('timeout'); });
    req.on('error', e => done(e.code === 'ECONNRESET' || /hang up/i.test(e.message) ? 'other' : 'error:' + (e.code || e.message)));
  });
}
function banner(addrs, results) {
  console.log('\n==================== 테이블 오더 미니 서버 v' + curVersion() + ' ====================');
  if (!addrs.length) console.log('  와이파이/랜에 연결되어 있지 않습니다. 네트워크를 확인해 주세요.');
  for (const a of addrs) {
    console.log('  주문받는 태블릿 :  http://' + a + ':' + PORT + '/#t7');
    console.log('  주문용 태블릿   :  http://' + a + ':' + PORT + '/#t1  ~  #t6');
    const r = results[a];
    if (r && r !== 'ok') console.log('  ※ 이 주소 접속 자가 확인 실패(' + r + '). 방화벽·보안 프로그램 설정을 확인해 주세요.');
  }
  console.log('  이 컴퓨터에서만 열 때 :  http://localhost:' + PORT + '/#t7');
  console.log('  데이터 폴더     :  ' + DATA);
  console.log('  이 창을 닫으면 주문이 멈춥니다. 서버 컴퓨터는 항상 켜 두세요.');
  console.log('==========================================================================\n');
}
const preferred = Number(process.env.PORT) || conf.port;
const ports = [preferred, ...PORT_CANDIDATES].filter((v, i, a) => v && a.indexOf(v) === i);
function tryListen(i) {
  if (i >= ports.length) { log('쓸 수 있는 포트를 찾지 못했습니다. 컴퓨터를 다시 시작한 뒤 다시 켜 주세요.'); process.exit(1); }
  PORT = ports[i];
  const onErr = e => {
    server.removeListener('listening', onOk);
    if (e.code === 'EADDRINUSE' || e.code === 'EACCES') { log('포트 ' + PORT + '은(는) 다른 프로그램이 쓰고 있어 다음 포트를 시도합니다.'); return tryListen(i + 1); }
    log('서버 오류:', e.message); process.exit(1);
  };
  const onOk = async () => {
    server.removeListener('error', onErr);
    const addrs = lanAddresses(), results = {};
    for (const a of addrs) results[a] = await probe(a, PORT);
    if (addrs.some(a => results[a] === 'other')) {
      log('포트 ' + PORT + '을(를) 다른 프로그램이 가로채고 있어 다음 포트로 옮깁니다.');
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
function shutdown() { log('서버를 끕니다…'); try { compact(); } catch (e) { } process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
