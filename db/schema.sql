-- Cloudflare D1 表结构：账号 / 会话 / 归属档案
-- 执行：npm run cf:db:init  （或 npx wrangler d1 execute ziwei-doushu --remote --file=db/schema.sql）

CREATE TABLE IF NOT EXISTS accounts (
  username       TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  nickname       TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  password_salt  TEXT NOT NULL,
  password_hash  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_id);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id);

CREATE TABLE IF NOT EXISTS profiles (
  owner_id  TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  payload   TEXT NOT NULL,
  PRIMARY KEY (owner_id, user_id)
);
