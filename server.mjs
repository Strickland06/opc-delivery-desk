import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import Redis from 'ioredis';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.OPC_SQLITE_PATH ? dirname(process.env.OPC_SQLITE_PATH) : join(here, 'data');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(process.env.OPC_SQLITE_PATH || join(dataDir, 'opc-standalone.sqlite'));
const port = Number(process.env.PORT || 4177);
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 1, enableOfflineQueue: false });
redis.on('error', error => console.error('Redis connection error:', error.message));
const sessionTtlSeconds = 60 * 60 * 24 * 7;
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    role TEXT NOT NULL CHECK (role IN ('requester', 'worker', 'both', 'admin')), organization_name TEXT NOT NULL DEFAULT '',
    skills TEXT NOT NULL DEFAULT '', availability TEXT NOT NULL DEFAULT '', portfolio_url TEXT NOT NULL DEFAULT '',
    password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
    service_type TEXT NOT NULL, requirements TEXT NOT NULL, budget INTEGER NOT NULL,
    due_date TEXT NOT NULL, min_people INTEGER NOT NULL, max_people INTEGER NOT NULL,
    requester TEXT NOT NULL, requester_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, total_price INTEGER DEFAULT 0,
    created_at TEXT NOT NULL, published_at TEXT
  );
  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    worker TEXT NOT NULL, worker_id TEXT NOT NULL DEFAULT '', skills TEXT NOT NULL, availability TEXT NOT NULL, case_url TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'applied', created_at TEXT NOT NULL,
    UNIQUE(order_id, worker_id)
  );
  CREATE TABLE IF NOT EXISTS milestones (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    title TEXT NOT NULL, deliverable TEXT NOT NULL, due_date TEXT NOT NULL, amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', submission TEXT DEFAULT '', submitted_at TEXT,
    reviewed_at TEXT, review_note TEXT DEFAULT '', position INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
  );
`);

// Upgrade databases created before the admin demo role was introduced.
const accountSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='accounts'").get()?.sql || '';
if (!accountSchema.includes("'admin'") || !accountSchema.includes("'both'")) {
  db.exec(`
    BEGIN;
    CREATE TABLE accounts_v2 (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      role TEXT NOT NULL CHECK (role IN ('requester', 'worker', 'both', 'admin')), organization_name TEXT NOT NULL DEFAULT '',
      skills TEXT NOT NULL DEFAULT '', availability TEXT NOT NULL DEFAULT '', portfolio_url TEXT NOT NULL DEFAULT '',
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO accounts_v2 SELECT * FROM accounts;
    DROP TABLE accounts;
    ALTER TABLE accounts_v2 RENAME TO accounts;
    COMMIT;
  `);
}

const tableColumns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
if (!tableColumns('orders').includes('requester_id')) db.exec("ALTER TABLE orders ADD COLUMN requester_id TEXT NOT NULL DEFAULT ''");
if (!tableColumns('applications').includes('worker_id')) db.exec("ALTER TABLE applications ADD COLUMN worker_id TEXT NOT NULL DEFAULT ''");
db.exec('CREATE INDEX IF NOT EXISTS idx_opc_orders_requester ON orders(requester_id, created_at); CREATE INDEX IF NOT EXISTS idx_opc_applications_worker ON applications(worker_id, order_id);');

const now = () => new Date().toISOString();
const asMoney = (v) => Math.round(Number(v) || 0);
const insertEvent = db.prepare('INSERT INTO events (id,order_id,kind,message,created_at) VALUES (?,?,?,?,?)');
const orderRow = db.prepare('SELECT * FROM orders WHERE id=?');
// Each account starts with its own empty workspace; every project must have a real requester owner.

function getOrder(id) {
  const order = orderRow.get(id);
  if (!order) return null;
  return {
    ...order,
    budget: Number(order.budget), total_price: Number(order.total_price),
    min_people: Number(order.min_people), max_people: Number(order.max_people),
    applications: db.prepare('SELECT * FROM applications WHERE order_id=? ORDER BY created_at').all(id),
    milestones: db.prepare('SELECT * FROM milestones WHERE order_id=? ORDER BY position').all(id),
    events: db.prepare('SELECT * FROM events WHERE order_id=? ORDER BY created_at DESC').all(id),
  };
}
function send(res, status, value, headers={}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw new Error('请求内容过大'); }
  return raw ? JSON.parse(raw) : {};
}
function event(orderId, kind, message) { insertEvent.run(randomUUID(), orderId, kind, message, now()); }
function fail(res, error, status=400) { send(res, status, { error: error.message || String(error) }); }
const publicAccount = account => ({
  id: account.id, displayName: account.display_name, email: account.email, role: account.role,
  organizationName: account.organization_name, skills: account.skills, availability: account.availability,
  portfolioUrl: account.portfolio_url, createdAt: account.created_at,
});
function cookieValue(req, name) {
  const item = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}
async function currentAccount(req) {
  const sessionId = cookieValue(req, 'opc_session');
  if (!sessionId) return null;
  const accountId = await redis.get(`opc:session:${sessionId}`);
  return accountId ? db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId) || null : null;
}
function setSessionCookie(res, token, maxAge) {
  res.setHeader('set-cookie', `opc_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}
async function requireAccount(req, res, role) {
  const account = await currentAccount(req);
  if (!account) { send(res, 401, { error: '请先登录。', login: '/login.html' }); return null; }
  if (role && account.role !== role && !(account.role === 'both' && ['requester', 'worker'].includes(role))) { send(res, 403, { error: `此操作需要${role === 'requester' ? '请求者' : role === 'worker' ? '工作者' : '管理员'}账户。` }); return null; }
  return account;
}
function canViewOrder(order, account) {
  if (account.role === 'requester') return order.requester_id === account.id;
  if (account.role === 'both' && order.requester_id === account.id) return true;
  return order.status === 'recruiting' || Boolean(db.prepare('SELECT 1 FROM applications WHERE order_id=? AND worker_id=?').get(order.id, account.id));
}

async function structureBrief(input) {
  const text = String(input.brief || '').trim();
  if (!text) throw new Error('先写一段项目需求，再让 AI 帮你拆解。');
  const key = process.env.DEEPSEEK_API_KEY;
  if (key) {
    const response = await fetch(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '你是企业项目需求分析助手。请用中文将输入整理为 JSON，字段为 summary, serviceType, deliverables(字符串数组), milestones(数组，每项含 title, deliverable, dueOffsetDays), missingQuestions(字符串数组), riskFlags(字符串数组)。不虚构预算、日期和已确认的承诺；milestones 的 dueOffsetDays 从今天起建议，最多 4 项。' },
          { role: 'user', content: text },
        ] })
    });
    if (!response.ok) throw new Error(`AI 服务返回 ${response.status}：${(await response.text()).slice(0, 240)}`);
    const json = await response.json();
    return { ...JSON.parse(json.choices?.[0]?.message?.content || '{}'), source: 'DeepSeek API' };
  }
  // Offline demo fallback: deterministic scope checklist so the workflow remains usable without a key.
  const topic = text.slice(0, 42).replace(/[，。；;]+$/g, '');
  const hasAi = /ai|人工智能|大模型|智能|模型|问答|知识库/i.test(text);
  const deliverables = ['需求范围与验收清单', hasAi ? 'AI 功能原型及效果验证记录' : '核心功能原型与交互说明', '部署版本、源文件和使用说明'];
  const milestones = [
    { title: '范围确认', deliverable: '需求边界、关键页面和验收用例', dueOffsetDays: 7 },
    { title: hasAi ? 'AI 能力与核心功能联调' : '核心功能开发与联调', deliverable: deliverables[1], dueOffsetDays: 21 },
    { title: '验收与交付', deliverable: deliverables[2], dueOffsetDays: 30 },
  ];
  const missingQuestions = [];
  if (!/预算|元|万/.test(text)) missingQuestions.push('预算上限和团队总价如何确认？');
  if (!/验收|交付物|交付/.test(text)) missingQuestions.push('请求者将通过哪些具体结果验收？');
  if (!/截止|日期|\d{1,2}月|\d{4}-\d{2}-\d{2}/.test(text)) missingQuestions.push('期望的最终交付日期是什么？');
  return {
    summary: topic, serviceType: hasAi ? 'AI 应用开发' : '软件开发', deliverables, milestones,
    missingQuestions, riskFlags: ['当前使用离线规则助手；配置 DEEPSEEK_API_KEY 后将调用真实大模型。'],
    source: '离线规则助手（演示模式）',
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let path = decodeURIComponent(url.pathname);
  if (path.startsWith('/api/opc/')) path = path.replace('/api/opc', '/api');
  if (path === '/opc' || path === '/opc/') { res.writeHead(302, { location: '/' }); return res.end(); }
  if (req.method === 'OPTIONS') return send(res, 204, {}, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS', 'access-control-allow-headers': 'content-type' });
  try {
    if (req.method === 'GET' && path === '/api/health') return send(res, 200, { ok: true, app: 'Lingang OPC Delivery Desk', aiMode: process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'offline-rules' });
    if (req.method === 'POST' && path === '/api/auth/register') {
      const b = await body(req), displayName = String(b.displayName || '').trim().slice(0, 80), email = String(b.email || '').trim().toLowerCase().slice(0, 254);
      const role = b.role, organizationName = String(b.organizationName || '').trim().slice(0, 120);
      const skills = String(b.skills || '').trim().slice(0, 500), availability = String(b.availability || '').trim().slice(0, 200);
      const portfolioUrl = String(b.portfolioUrl || '').trim().slice(0, 500), password = String(b.password || '');
      if (displayName.length < 2) throw new Error('请填写至少 2 个字的姓名或称呼。');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('请填写有效的邮箱地址。');
      if (!['requester', 'worker', 'both'].includes(role)) throw new Error('请选择请求者、工作者或双角色。');
      if (['requester', 'both'].includes(role) && !organizationName) throw new Error('请填写企业或团队名称。');
      if (['worker', 'both'].includes(role) && !skills) throw new Error('请填写技能方向。');
      if (password.length < 8 || password.length > 200) throw new Error('密码长度需要在 8 到 200 个字符之间。');
      if (portfolioUrl && !/^https?:\/\//i.test(portfolioUrl)) throw new Error('案例链接须以 http:// 或 https:// 开头。');
      const id = randomUUID(), salt = randomBytes(16).toString('hex'), passwordHash = scryptSync(password, salt, 64).toString('hex'), createdAt = now();
      try {
        db.prepare(`INSERT INTO accounts (id,display_name,email,role,organization_name,skills,availability,portfolio_url,password_salt,password_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, displayName, email, role, organizationName, skills, availability, portfolioUrl, salt, passwordHash, createdAt);
      } catch (error) {
        if (String(error).includes('UNIQUE constraint failed: accounts.email')) return send(res, 409, { error: '这个邮箱已经注册过了，请直接登录。' });
        throw error;
      }
      const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(id), profile = publicAccount(account);
      await redis.set(`opc:account:${id}`, JSON.stringify(profile));
      await redis.set(`opc:account:email:${email}`, id);
      return send(res, 201, { account: profile, message: '账户已创建，请使用邮箱和密码登录。' });
    }
    if (req.method === 'POST' && path === '/api/auth/login') {
      const b = await body(req), email = String(b.email || '').trim().toLowerCase(), password = String(b.password || '');
      const account = db.prepare('SELECT * FROM accounts WHERE email=? COLLATE NOCASE').get(email);
      const candidate = account && password ? scryptSync(password, account.password_salt, 64) : Buffer.alloc(64);
      const valid = Boolean(account && password && timingSafeEqual(candidate, Buffer.from(account.password_hash, 'hex')));
      if (!valid) return send(res, 401, { error: '邮箱或密码不正确。' });
      const token = randomBytes(32).toString('base64url');
      await redis.set(`opc:session:${token}`, account.id, 'EX', sessionTtlSeconds);
      setSessionCookie(res, token, sessionTtlSeconds);
      const profile = publicAccount(account);
      await redis.set(`opc:account:${account.id}`, JSON.stringify(profile));
      return send(res, 200, { account: profile });
    }
    if (req.method === 'GET' && path === '/api/auth/session') {
      const account = await currentAccount(req);
      return account ? send(res, 200, { account: publicAccount(account) }) : send(res, 401, { error: '请先登录。' });
    }
    if (req.method === 'POST' && path === '/api/auth/logout') {
      const token = cookieValue(req, 'opc_session');
      if (token) await redis.del(`opc:session:${token}`);
      setSessionCookie(res, '', 0);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/auth/enable-role') {
      const account = await currentAccount(req);
      if (!account) return send(res, 401, { error: '请先登录。', login: '/login.html' });
      if (!['requester', 'worker'].includes(account.role)) return send(res, 409, { error: '当前账户无需变更角色。' });
      const b = await body(req);
      if (account.role === 'requester') {
        const skills = String(b.skills || '').trim().slice(0, 500);
        if (!skills) throw new Error('请填写技能方向，才能开启工作者身份。');
        db.prepare("UPDATE accounts SET role='both',skills=? WHERE id=?").run(skills, account.id);
      } else {
        const organizationName = String(b.organizationName || '').trim().slice(0, 120);
        if (!organizationName) throw new Error('请填写企业或团队名称，才能开启请求者身份。');
        db.prepare("UPDATE accounts SET role='both',organization_name=? WHERE id=?").run(organizationName, account.id);
      }
      const updated = db.prepare('SELECT * FROM accounts WHERE id=?').get(account.id), profile = publicAccount(updated);
      await redis.set(`opc:account:${account.id}`, JSON.stringify(profile));
      await redis.set(`opc:account:email:${updated.email}`, account.id);
      return send(res, 200, { account: profile });
    }
    if (req.method === 'GET' && path === '/api/admin/overview') {
      const account = await requireAccount(req, res, 'admin'); if (!account) return;
      const scalar = sql => Number(db.prepare(sql).get().n || 0);
      return send(res, 200, {
        account: publicAccount(account),
        counts: {
          accounts: scalar('SELECT COUNT(*) n FROM accounts'),
          requesters: scalar("SELECT COUNT(*) n FROM accounts WHERE role='requester'"),
          workers: scalar("SELECT COUNT(*) n FROM accounts WHERE role='worker'"),
          bothRoles: scalar("SELECT COUNT(*) n FROM accounts WHERE role='both'"),
          orders: scalar('SELECT COUNT(*) n FROM orders'),
          recruiting: scalar("SELECT COUNT(*) n FROM orders WHERE status='recruiting'"),
          inProgress: scalar("SELECT COUNT(*) n FROM orders WHERE status IN ('in_progress','ready_to_close')"),
          completed: scalar("SELECT COUNT(*) n FROM orders WHERE status='completed'"),
        },
        recentOrders: db.prepare('SELECT code,title,status,created_at FROM orders ORDER BY created_at DESC LIMIT 8').all(),
      });
    }
    if (req.method === 'GET' && path === '/api/orders') {
      const account = await requireAccount(req, res); if (!account) return;
      const view = url.searchParams.get('view');
      if (view === 'requester' && !['requester', 'both'].includes(account.role)) return send(res, 403, { error: '请先开通请求者身份。' });
      if (view === 'worker' && !['worker', 'both'].includes(account.role)) return send(res, 403, { error: '请先开通工作者身份。' });
      const ids = view === 'requester' || (account.role === 'requester' && !view)
        ? db.prepare('SELECT id FROM orders WHERE requester_id=? ORDER BY created_at DESC').all(account.id)
        : view === 'worker' || account.role === 'worker'
          ? db.prepare("SELECT DISTINCT o.id FROM orders o LEFT JOIN applications a ON a.order_id=o.id WHERE (o.status='recruiting' AND o.requester_id<>?) OR a.worker_id=? ORDER BY o.created_at DESC").all(account.id, account.id)
          : db.prepare("SELECT id FROM orders WHERE requester_id=? OR status='recruiting' OR id IN (SELECT order_id FROM applications WHERE worker_id=?) ORDER BY created_at DESC").all(account.id, account.id);
      return send(res, 200, ids.map(o => getOrder(o.id)));
    }
    if (req.method === 'POST' && path === '/api/ai/structure') {
      const account = await requireAccount(req, res, 'requester'); if (!account) return;
      return send(res, 200, await structureBrief(await body(req)));
    }
    if (req.method === 'POST' && path === '/api/orders') {
      const account = await requireAccount(req, res, 'requester'); if (!account) return;
      const b = await body(req);
      if (!b.title?.trim() || !b.summary?.trim() || !b.requirements?.trim()) throw new Error('项目名称、摘要和需求说明为必填项。');
      if (!Array.isArray(b.milestones) || !b.milestones.length) throw new Error('请至少填写一个验收节点。');
      const id = randomUUID(); const stamp = now(); const code = `OPC-${stamp.slice(0,10).replaceAll('-','')}-${String(Date.now()).slice(-4)}`;
      const status = b.publish ? 'recruiting' : 'draft';
      const requesterName = ['requester', 'both'].includes(account.role) ? `${account.display_name}${account.organization_name ? ` · ${account.organization_name}` : ''}` : account.display_name;
      db.prepare('INSERT INTO orders (id,code,title,summary,service_type,requirements,budget,due_date,min_people,max_people,requester,requester_id,status,total_price,created_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, code, b.title.trim(), b.summary.trim(), b.service_type || '其他', b.requirements.trim(), asMoney(b.budget), b.due_date || '', Math.max(1, Number(b.min_people)||1), Math.max(1, Number(b.max_people)||1), requesterName, account.id, status, 0, stamp, b.publish ? stamp : null);
      for (const [i, m] of (b.milestones || []).entries()) db.prepare('INSERT INTO milestones VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), id, m.title || `交付节点 ${i+1}`, m.deliverable || '待团队协商确认', m.due_date || b.due_date || '', asMoney(m.amount), 'pending', '', null, null, '', i+1);
      event(id, status, status === 'draft' ? '工单草稿已保存。' : '请求者确认并公开招募。');
      return send(res, 201, getOrder(id));
    }
    const orderMatch = path.match(/^\/api\/orders\/([^/]+)$/);
    if (req.method === 'GET' && orderMatch) {
      const account = await requireAccount(req, res); if (!account) return;
      const o = getOrder(orderMatch[1]);
      if (!o) return send(res, 404, { error: '工单不存在' });
      return canViewOrder(o, account) ? send(res, 200, o) : send(res, 403, { error: '无权查看此工单。' });
    }
    const action = path.match(/^\/api\/orders\/([^/]+)\/(apply|select-team|confirm-price|publish|milestones|complete)$/);
    if (!action) {
      const mile = path.match(/^\/api\/orders\/([^/]+)\/milestones\/([^/]+)\/(submit|accept|revise)$/);
      if (mile) {
        const [, orderId, milestoneId, op] = mile;
        const role = op === 'submit' ? 'worker' : 'requester';
        const account = await requireAccount(req, res, role); if (!account) return;
        const order = orderRow.get(orderId);
        if (!order || (role === 'requester' ? order.requester_id !== account.id : !db.prepare("SELECT 1 FROM applications WHERE order_id=? AND worker_id=? AND status='selected'").get(orderId, account.id))) return send(res, 403, { error: '无权操作此工单。' });
        if (op === 'submit' && order.status !== 'in_progress') return send(res, 409, { error: '请等待请求者确认验收计划后再提交交付。' });
        if (op === 'submit') {
          const plan = db.prepare('SELECT COALESCE(SUM(amount),0) total FROM milestones WHERE order_id=?').get(orderId);
          if (!Number(plan.total) || Number(plan.total) !== Number(order.total_price)) return send(res, 409, { error: '阶段金额尚未与团队总价匹配，请请求者先完善验收计划。' });
        }
        const b = await body(req);
        const m = db.prepare('SELECT * FROM milestones WHERE id=? AND order_id=?').get(milestoneId, orderId);
        if (!m) throw new Error('验收节点不存在');
        if (op === 'submit') {
          if (!['pending','in_progress'].includes(m.status)) throw new Error('当前节点不可提交；已提交节点请等待请求者验收或要求修改。');
          if (!b.submission?.trim()) throw new Error('请填写交付链接、说明或文件引用。');
          db.prepare("UPDATE milestones SET status='submitted', submission=?, submitted_at=? WHERE id=?").run(b.submission.trim(), now(), milestoneId);
          event(orderId, 'submission', `工作者提交了「${m.title}」的交付材料。`);
        } else if (op === 'accept') {
          if (m.status !== 'submitted') throw new Error('只有已提交的节点可以验收。');
          db.prepare("UPDATE milestones SET status='accepted', reviewed_at=?, review_note=? WHERE id=?").run(now(), b.note || '验收通过', milestoneId);
          event(orderId, 'settlement', `请求者通过「${m.title}」并登记阶段结算 ¥${Number(m.amount).toLocaleString('zh-CN')}（演示台账）。`);
          const remaining = db.prepare("SELECT COUNT(*) n FROM milestones WHERE order_id=? AND status!='accepted'").get(orderId).n;
          if (!remaining) {
            db.prepare("UPDATE orders SET status='ready_to_close' WHERE id=?").run(orderId);
            event(orderId, 'ready_to_close', '全部验收节点已通过，等待请求者确认整单交付并结项。');
          }
        } else {
          if (m.status !== 'submitted') throw new Error('只有已提交的节点可以要求修改。');
          if (!b.note?.trim()) throw new Error('请填写修改原因。');
          db.prepare("UPDATE milestones SET status='in_progress', reviewed_at=?, review_note=? WHERE id=?").run(now(), b.note.trim(), milestoneId);
          event(orderId, 'revision', `请求者要求修改「${m.title}」：${b.note.trim()}`);
        }
        return send(res, 200, getOrder(orderId));
      }
      return serveStatic(path, res);
    }
    const [, orderId, op] = action;
    const role = op === 'apply' || op === 'confirm-price' ? 'worker' : 'requester';
    const account = await requireAccount(req, res, role); if (!account) return;
    const o = orderRow.get(orderId);
    if (!o) return send(res, 404, { error: '工单不存在' });
    if (role === 'requester' && o.requester_id !== account.id) return send(res, 403, { error: '无权操作此工单。' });
    if (role === 'worker' && !canViewOrder(o, account)) return send(res, 403, { error: '无权操作此工单。' });
    const b = await body(req);
    if (op === 'apply') {
      if (o.requester_id === account.id) return send(res, 403, { error: '不能报名自己发布的工单。' });
      if (o.status !== 'recruiting') return send(res, 409, { error: '该工单当前不在招募阶段。' });
      if (!b.skills?.trim()) throw new Error('请填写技能和经验。');
      const workerName = account.display_name;
      const existingApplication = db.prepare('SELECT id,status FROM applications WHERE order_id=? AND worker_id=?').get(orderId, account.id);
      if (existingApplication && existingApplication.status !== 'not_selected') return send(res, 409, { error: '你已经提交过这份工单的报名。' });
      if (existingApplication) {
        db.prepare("UPDATE applications SET worker=?,skills=?,availability=?,case_url=?,status='applied',created_at=? WHERE id=?")
          .run(workerName, b.skills.trim(), b.availability || '待协商', b.case_url || '', now(), existingApplication.id);
      } else {
        db.prepare('INSERT INTO applications (id,order_id,worker,worker_id,skills,availability,case_url,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(), orderId, workerName, account.id, b.skills.trim(), b.availability || '待协商', b.case_url || '', 'applied', now());
      }
      event(orderId, 'application', `${workerName} 提交了报名。`);
    }
    if (op === 'publish') {
      db.prepare("UPDATE orders SET status='recruiting', published_at=? WHERE id=? AND status='draft'").run(now(), orderId);
      event(orderId, 'published', '请求者确认草稿并公开招募。');
    }
    if (op === 'select-team') {
      if (o.status !== 'recruiting') return send(res, 409, { error: '该工单已结束招募，不能再调整团队。' });
      const workerIds = Array.isArray(b.application_ids) ? b.application_ids : [];
      const count = db.prepare(`SELECT COUNT(*) n FROM applications WHERE order_id=? AND status='applied' AND id IN (${workerIds.map(()=>'?').join(',') || "''"})`).get(orderId, ...workerIds).n;
      if (!workerIds.length) throw new Error('至少选择一位工作者。');
      if (count !== workerIds.length) throw new Error('所选报名已变化，请刷新后重试。');
      if (workerIds.length < Number(o.min_people) || workerIds.length > Number(o.max_people)) throw new Error(`团队人数需在 ${o.min_people}–${o.max_people} 人范围内。`);
      const price = asMoney(b.total_price);
      if (price <= 0 || price > Number(o.budget)) throw new Error('团队总价必须大于 0 且不超过预算上限。');
      const tx = db.prepare("UPDATE applications SET status=CASE WHEN id IN ("+workerIds.map(()=>'?').join(',')+") THEN 'selected' ELSE 'not_selected' END WHERE order_id=?");
      tx.run(...workerIds, orderId);
      db.prepare("UPDATE orders SET status='team_confirming', total_price=? WHERE id=?").run(price, orderId);
      event(orderId, 'team', `请求者选择 ${workerIds.length} 位成员，提出团队总价 ¥${price.toLocaleString('zh-CN')}，待团队负责人确认。`);
    }
    if (op === 'confirm-price') {
      if (o.status !== 'team_confirming') throw new Error('当前工单没有待确认的团队总价。');
      const application = db.prepare("SELECT id FROM applications WHERE order_id=? AND worker_id=? AND status='selected'").get(orderId, account.id);
      if (!application || (b.application_id && b.application_id !== application.id)) return send(res, 403, { error: '只有本人已入选的工作者可以确认总价。' });
      db.prepare("UPDATE orders SET status='milestone_planning' WHERE id=?").run(orderId);
      event(orderId, 'price_confirmed', `工作者团队负责人确认团队总价 ¥${Number(o.total_price).toLocaleString('zh-CN')}。平台记录总价，不托管或代付。等待请求者确认验收节点和阶段金额。`);
    }
    if (op === 'milestones') {
      if (!['milestone_planning', 'in_progress'].includes(o.status)) throw new Error('请先完成团队总价确认，再设置验收计划。');
      if (db.prepare("SELECT 1 FROM milestones WHERE order_id=? AND status IN ('submitted','accepted') LIMIT 1").get(orderId)) throw new Error('已有节点提交或通过验收，不能再改动阶段计划。');
      if (!Array.isArray(b.milestones) || !b.milestones.length) throw new Error('至少需要一个验收节点。');
      if (b.milestones.reduce((s,m)=>s+asMoney(m.amount),0) !== Number(o.total_price)) throw new Error('各阶段金额之和必须等于已确认的团队总价。');
      const existing = db.prepare('SELECT * FROM milestones WHERE order_id=? ORDER BY position').all(orderId);
      if (existing.length !== b.milestones.length) throw new Error('当前版本需要保留全部验收节点；请编辑已有节点。');
      db.exec('BEGIN');
      try {
        const update = db.prepare('UPDATE milestones SET title=?,deliverable=?,due_date=?,amount=?,position=? WHERE id=? AND order_id=?');
        b.milestones.forEach((m,i) => update.run(m.title, m.deliverable, m.due_date, asMoney(m.amount), i+1, existing[i].id, orderId));
        db.prepare("UPDATE orders SET status='in_progress' WHERE id=?").run(orderId);
        event(orderId, 'milestone_plan', '双方确认了验收节点、日期和阶段金额。');
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    if (op === 'complete') {
      if (o.status !== 'ready_to_close') return send(res, 409, { error: '请先完成并验收全部交付节点，再确认整单结项。' });
      const remaining = db.prepare("SELECT COUNT(*) n FROM milestones WHERE order_id=? AND status!='accepted'").get(orderId).n;
      if (remaining) return send(res, 409, { error: '仍有未通过的验收节点，暂时不能结项。' });
      db.prepare("UPDATE orders SET status='completed' WHERE id=? AND status='ready_to_close'").run(orderId);
      event(orderId, 'completed', '请求者确认整单交付完成并结项；各节点结算台账已归档（演示记录，不代表平台托管或支付）。');
    }
    return send(res, 200, getOrder(orderId));
  } catch (error) { return fail(res, error, /not found/i.test(error.message) ? 404 : 400); }
});

async function serveStatic(path, res) {
  const relativePath = path === '/' ? 'index.html' : path === '/requester' ? 'requester.html' : path === '/worker' ? 'worker.html' : path === '/admin' ? 'admin.html' : path === '/register' ? 'register.html' : path === '/login' ? 'login.html' : path.replace(/^\/+/, '');
  const filePath = join(here, 'public', relativePath);
  if (!filePath.startsWith(join(here, 'public'))) return send(res, 403, { error: 'forbidden' });
  try { const data = await readFile(filePath); res.writeHead(200, { 'content-type': mime[extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(data); }
  catch { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found'); }
}
server.listen(port, '0.0.0.0', () => console.log(`Lingang OPC Delivery Desk: http://0.0.0.0:${port}`));
process.on('SIGINT', () => { redis.quit(); db.close(); process.exit(0); });
process.on('SIGTERM', () => { redis.quit(); db.close(); process.exit(0); });
