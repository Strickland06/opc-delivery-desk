import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Redis from 'ioredis';

const email = 'opc-admin-demo@lingang.local';
const displayName = '平台管理员（演示）';
const dbPath = process.env.OPC_SQLITE_PATH || '/data/opc-demo.sqlite';
mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 1 });

try {
  if (db.prepare('SELECT 1 FROM accounts WHERE email=? COLLATE NOCASE').get(email)) {
    throw new Error(`演示管理员已存在：${email}。为避免重置已有密码，脚本不会覆盖账户。`);
  }
  const password = `OpcDemo-${randomBytes(12).toString('base64url')}`;
  const id = randomUUID(), salt = randomBytes(16).toString('hex');
  const passwordHash = scryptSync(password, salt, 64).toString('hex');
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT INTO accounts
    (id,display_name,email,role,organization_name,skills,availability,portfolio_url,password_salt,password_hash,created_at)
    VALUES (?,?,?,'admin','','','','',?,?,?)`).run(id, displayName, email, salt, passwordHash, createdAt);
  const profile = { id, displayName, email, role: 'admin', organizationName: '', skills: '', availability: '', portfolioUrl: '', createdAt };
  await redis.set(`opc:account:${id}`, JSON.stringify(profile));
  await redis.set(`opc:account:email:${email}`, id);
  console.log(JSON.stringify({ email, password, role: 'admin', loginUrl: 'http://localhost:8080/login' }, null, 2));
} finally {
  await redis.quit();
  db.close();
}
