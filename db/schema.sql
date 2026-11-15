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

-- ─── 计费（卡密次数制；BILLING_MODE=card 时启用） ───────────────
-- 卡密：离线批量生成，兑换后标记 used，单次有效
CREATE TABLE IF NOT EXISTS billing_cards (
  code        TEXT PRIMARY KEY,
  credits     INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'unused',  -- unused | used
  batch       TEXT,
  used_by     TEXT,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);
-- 钱包：subject = 'u:<ownerId>'（登录）或 'a:<ipHash>'（匿名）
CREATE TABLE IF NOT EXISTS billing_wallets (
  subject     TEXT PRIMARY KEY,
  credits     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
-- 每日免费额度计数（按自然日，UTC+8）
CREATE TABLE IF NOT EXISTS billing_usage (
  subject     TEXT NOT NULL,
  day         TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (subject, day)
);
