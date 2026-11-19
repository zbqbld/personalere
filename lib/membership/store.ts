/**
 * 会员状态存储（本地模拟层）
 *
 * 设计目标：**非会员环境下也能完整验证所有 PRO 功能**。
 * 因此等级来源有两处，优先级从高到低：
 *   1. 环境开关 NEXT_PUBLIC_MEMBERSHIP_MODE
 *      - 'off'      ：全部解锁（个人自用 / 关闭会员限制）
 *      - 'simulate' ：默认值。等级存在 localStorage，界面可一键切换，用于验证
 *      - 'real'     ：预留给真实支付；未接入时回退到 simulate，不静默锁死功能
 *   2. localStorage 的会员记录
 *
 * 安全性说明：localStorage 可被用户改写，这在本项目里是**有意为之**——
 * 当前阶段目标是功能验证而非收费防刷。接真实支付时，等级必须改为
 * 服务端签名下发（见 README 的未完成项），前端只做展示。
 */

import type { Plan } from './plan';
import { PRO_WEEKLY_QUOTA } from './plan';

const PLAN_KEY = 'ziwei_membership_v1';
const QUOTA_KEY = 'ziwei_pro_quota_v1';
const EVENT = 'ziwei:membership-change';

export type MembershipMode = 'off' | 'simulate' | 'real';

export function membershipMode(): MembershipMode {
  const raw = process.env.NEXT_PUBLIC_MEMBERSHIP_MODE;
  if (raw === 'off' || raw === 'simulate' || raw === 'real') return raw;
  return 'simulate';
}

export interface MembershipRecord {
  plan: Plan;
  since: number;
  /** local-sim = 本地模拟开通；config = 环境开关强制 */
  source: 'local-sim' | 'config';
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/** 读取当前等级。'off' 模式恒为 pro。 */
export function loadPlan(): Plan {
  if (membershipMode() === 'off') return 'pro';
  if (!isBrowser()) return 'free';
  try {
    const raw = window.localStorage.getItem(PLAN_KEY);
    if (!raw) return 'free';
    const parsed = JSON.parse(raw) as Partial<MembershipRecord>;
    return parsed?.plan === 'pro' ? 'pro' : 'free';
  } catch {
    return 'free';
  }
}

export function loadMembership(): MembershipRecord {
  const plan = loadPlan();
  if (membershipMode() === 'off') return { plan: 'pro', since: 0, source: 'config' };
  if (!isBrowser()) return { plan, since: 0, source: 'local-sim' };
  try {
    const raw = window.localStorage.getItem(PLAN_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MembershipRecord>;
      if (parsed?.plan === 'pro') {
        return {
          plan: 'pro',
          since: typeof parsed.since === 'number' ? parsed.since : 0,
          source: parsed.source === 'config' ? 'config' : 'local-sim',
        };
      }
    }
  } catch { /* 损坏数据按免费处理 */ }
  return { plan: 'free', since: 0, source: 'local-sim' };
}

function emit(): void {
  if (!isBrowser()) return;
  window.dispatchEvent(new Event(EVENT));
}

/** 本地模拟开通 / 取消（仅 simulate 模式生效；'off' 模式恒解锁，无需切换） */
export function setPlan(plan: Plan): boolean {
  if (!isBrowser()) return false;
  const mode = membershipMode();
  if (mode === 'off') return false;
  try {
    if (plan === 'pro') {
      const rec: MembershipRecord = { plan: 'pro', since: Date.now(), source: 'local-sim' };
      window.localStorage.setItem(PLAN_KEY, JSON.stringify(rec));
    } else {
      window.localStorage.removeItem(PLAN_KEY);
    }
    emit();
    return true;
  } catch {
    return false;
  }
}

export function subscribePlan(cb: () => void): () => void {
  if (!isBrowser()) return () => {};
  const handler = () => cb();
  window.addEventListener(EVENT, handler);
  // 跨标签页同步
  const storage = (e: StorageEvent) => { if (e.key === PLAN_KEY) cb(); };
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(EVENT, handler);
    window.removeEventListener('storage', storage);
  };
}

// ── PRO 每周解读额度（本地计数，按 ISO 周重置）──

function isoWeekKey(d = new Date()): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;            // 周一=1 … 周日=7
  date.setUTCDate(date.getUTCDate() + 4 - day); // 移到本周周四
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

interface QuotaRecord { week: string; used: number }

function readQuota(): QuotaRecord {
  if (!isBrowser()) return { week: isoWeekKey(), used: 0 };
  const week = isoWeekKey();
  try {
    const raw = window.localStorage.getItem(QUOTA_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<QuotaRecord>;
      // 跨周自动清零
      if (parsed?.week === week && typeof parsed.used === 'number') {
        return { week, used: Math.max(0, parsed.used) };
      }
    }
  } catch { /* 损坏按新周处理 */ }
  return { week, used: 0 };
}

export function proQuotaLeft(): number {
  const { used } = readQuota();
  return Math.max(0, PRO_WEEKLY_QUOTA - used);
}

/** 记一次 PRO 用量，返回剩余次数 */
export function consumeProQuota(): number {
  const rec = readQuota();
  const next = { week: rec.week, used: rec.used + 1 };
  if (isBrowser()) {
    try { window.localStorage.setItem(QUOTA_KEY, JSON.stringify(next)); } catch { /* 存储不可用则只在本次生效 */ }
  }
  return Math.max(0, PRO_WEEKLY_QUOTA - next.used);
}

/** 仅供测试/演示：重置本周用量 */
export function resetProQuota(): void {
  if (!isBrowser()) return;
  try { window.localStorage.removeItem(QUOTA_KEY); } catch { /* ignore */ }
  emit();
}

export const MEMBERSHIP_MODE_LABEL: Record<MembershipMode, string> = {
  off: '会员限制已关闭（全部解锁）',
  simulate: '本地模拟模式（可切换等级验证）',
  real: '服务端模式（未接支付，暂按模拟）',
};
