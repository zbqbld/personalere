/* ─── 本地数据命名空间（账号归属） ───────────────────────────
 * 未登录时所有键名与旧版完全一致；登录后追加 :acct:<ownerId> 后缀，
 * 使本机生辰 / 对话 / 档案不会跨账号或跨登录状态被读到。
 * 实现内联在本模块：scripts/smoke-dom.mjs 用 Node 原生
 * --experimental-strip-types 直接加载本文件，无法解析无扩展名的外部导入。
 */
const ACCOUNT_SCOPE_KEY = 'zw_account_scope';

function readInitialScope(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const store = (window as unknown as { sessionStorage?: Storage }).sessionStorage;
    return store ? store.getItem(ACCOUNT_SCOPE_KEY) || null : null;
  } catch {
    return null;
  }
}

let accountScope: string | null = readInitialScope();

export function getAccountScope(): string | null {
  return accountScope;
}

export function setAccountScope(ownerId: string | null): void {
  accountScope = ownerId && ownerId.trim() ? ownerId.trim() : null;
  if (typeof window === 'undefined') return;
  try {
    const store = (window as unknown as { sessionStorage?: Storage }).sessionStorage;
    if (!store) return;
    if (accountScope) store.setItem(ACCOUNT_SCOPE_KEY, accountScope);
    else store.removeItem(ACCOUNT_SCOPE_KEY);
  } catch { /* 隐私模式下静默降级 */ }
}

export function scopedKey(base: string): string {
  return accountScope ? `${base}:acct:${accountScope}` : base;
}

/**
 * 本地记忆模块 —— 上次起盘填写的姓名 / 生辰信息 + AI 解读对话 + 长期事实
 *
 * 数据仅存于浏览器的 localStorage，不发起任何网络请求。
 * 设计要点：
 *  1. 版本化 key，便于将来升级结构时平滑迁移；
 *  2. 读取时做严格字段校验，损坏 / 伪造 / 越界数据一律丢弃并清除；
 *  3. 所有 localStorage 操作包 try/catch，隐私模式或配额不足时静默降级；
 *  4. 对话按命盘隔离：会话 key 由出生信息哈希生成，不写入明文；不同命盘的
 *     解读互不串用；clearAllMemory() 一次清除生辰、历史与全部对话。
 *  5. 多个起盘用户的档案按 userId 分别保存在 PROFILES_KEY（见
 *     user-profiles.ts）；清除生辰记忆与顶层清除记忆都会一并删除该键。
 *
 * ── 长期上下文优化（本次） ──────────────────────────────────
 * 目标：① 多轮上下文连贯 ② 历史信息准确 ③ 长期状态一致（早前设定的偏好 /
 * 约束在后续任意多轮仍正确沿用）④ 覆盖过期 / 重复 / 冲突边界。
 *
 * 手段：在 messages 之外，从「用户手动输入」中确定性抽取长期事实（偏好、
 * 禁忌、称呼、关注点等），按类别保存每个类别的最后一次设定。事实与对话
 * 存于同一会话 key，因此既有 clearChat / clearAllChats / clearAllMemory
 * 自动覆盖，无需新增清除入口；CHAT_VERSION 与 key 前缀不变，旧数据（无
 * facts 字段）读取时按空数组处理，零迁移。
 *
 * 对外契约与交互不变：HTTP 仍是 { chart, messages:[{role,content}] } 与
 * SSE `data: {"delta":{"text":"..."}}`；无长期事实时构建出的上下文不含
 * system 消息，与优化前等价；UI 元素 / 文案 / 开关 / 清除入口均不改动。
 *
 * 验收标准（见 scripts/regression/long-context.test.ts）：
 *  - 超出 10 条窗口后，早前事实仍出现在每轮上下文锚点中；
 *  - 同类别先后冲突的设定只保留最新一条，锚点不自相矛盾；
 *  - 重复消息 / 重复设定被去重，失败占位与空消息不进入上下文；
 *  - 上下文严格交替、以 user 开头并以 user 结尾，问答对不被拆散；
 *  - 过期事实与过期会话被淘汰；损坏 facts 被丢弃；清除后不留残留。
 */

/** 与 components/BirthForm.tsx 的 BirthFormState 共用的唯一结构定义 */
export interface BirthDraft {
  name: string;
  year: string;
  month: string;
  day: string;
  clockHour: string;
  clockMinute: string;
  unknownTime: boolean;
  province: string;
  city: string;
  longitude: number;
  gender: 'male' | 'female';
}

export const LAST_BIRTH_KEY = 'ziwei_last_birth_v1';
/** 与 lib/ziwei/history.ts 保持一致；旧版历史数组，首次读取用户库时会迁移 */
export const HISTORY_KEY = 'ziwei_history';
/** 按用户维度保存的档案库键；定义于此以避免与 user-profiles.ts 循环依赖 */
export const PROFILES_KEY = 'ziwei_user_profiles_v1';
export const MEMORY_VERSION = 1;

export interface LastBirthMemory {
  version: typeof MEMORY_VERSION;
  form: BirthDraft;
  savedAt: number;
}

const MAX_TEXT = 60;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown, max = MAX_TEXT): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function digit(v: unknown): string {
  if (typeof v === 'string') return v.slice(0, 6);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function isValidDate(y: number, m: number, d: number): boolean {
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/**
 * 把任意来源的数据规整为可信的 BirthDraft。
 * 校验失败返回 null —— 绝不把不可信数据喂给排盘引擎。
 */
export function normalizeBirthDraft(raw: unknown): BirthDraft | null {
  if (!isRecord(raw)) return null;

  const year = digit(raw.year);
  const month = digit(raw.month);
  const day = digit(raw.day);
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);

  if (!/^\d{4}$/.test(year)) return null;
  const maxYear = new Date().getFullYear();
  if (y < 1900 || y > maxYear) return null;
  if (!/^\d{1,2}$/.test(month) || m < 1 || m > 12) return null;
  if (!/^\d{1,2}$/.test(day) || d < 1 || d > 31) return null;
  if (!isValidDate(y, m, d)) return null;

  let clockHour = digit(raw.clockHour);
  let clockMinute = digit(raw.clockMinute);
  const h = Number(clockHour);
  const min = Number(clockMinute);
  if (!/^\d{1,2}$/.test(clockHour) || h < 0 || h > 23) clockHour = '8';
  if (!/^\d{1,2}$/.test(clockMinute) || min < 0 || min > 59) clockMinute = '0';

  const lonRaw = raw.longitude;
  let longitude = 120;
  if (typeof lonRaw === 'number' && Number.isFinite(lonRaw)) {
    longitude = Math.min(180, Math.max(-180, lonRaw));
  } else if (typeof lonRaw === 'string' && Number.isFinite(Number(lonRaw))) {
    longitude = Math.min(180, Math.max(-180, Number(lonRaw)));
  }

  return {
    name: text(raw.name),
    year,
    month,
    day,
    clockHour,
    clockMinute,
    unknownTime: raw.unknownTime === true,
    province: text(raw.province),
    city: text(raw.city),
    longitude,
    gender: raw.gender === 'female' ? 'female' : 'male',
  };
}

/** 读取上次信息；数据不存在或损坏时返回 null 并清除损坏键 */
export function loadLastBirth(): LastBirthMemory | null {
  if (typeof window === 'undefined') return null;
  const key = scopedKey(LAST_BIRTH_KEY);
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== MEMORY_VERSION) throw new Error('version');
    const form = normalizeBirthDraft(parsed.form);
    if (!form) throw new Error('form');
    const savedAt =
      typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt) && parsed.savedAt > 0
        ? parsed.savedAt
        : Date.now();
    return { version: MEMORY_VERSION, form, savedAt };
  } catch {
    try { window.localStorage.removeItem(key); } catch { /* ignore */ }
    return null;
  }
}

/** 保存本次信息；返回实际写入的记录，失败（禁存储 / 配额满）返回 null */
export function saveLastBirth(form: BirthDraft): LastBirthMemory | null {
  if (typeof window === 'undefined') return null;
  const normalized = normalizeBirthDraft(form);
  if (!normalized) return null;
  const entry: LastBirthMemory = {
    version: MEMORY_VERSION,
    form: normalized,
    savedAt: Date.now(),
  };
  try {
    window.localStorage.setItem(scopedKey(LAST_BIRTH_KEY), JSON.stringify(entry));
    return entry;
  } catch {
    return null;
  }
}

/** 清除本机保存的全部生辰数据（含按用户保存的档案库，不影响主题偏好等其他键） */
export function clearBirthMemory(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(scopedKey(LAST_BIRTH_KEY));
    window.localStorage.removeItem(scopedKey(HISTORY_KEY));
    window.localStorage.removeItem(scopedKey(PROFILES_KEY));
  } catch { /* ignore */ }
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

/** 人类可读的摘要，用于「沿用上次信息」卡片 */
export function describeBirthDraft(form: BirthDraft): string {
  return [
    form.name,
    `${form.year}年${Number(form.month)}月${Number(form.day)}日`,
    form.city || form.province || '',
    form.unknownTime ? '时辰不详' : `${pad(Number(form.clockHour))}:${pad(Number(form.clockMinute))}`,
    form.gender === 'male' ? '男' : '女',
  ].filter(Boolean).join(' · ');
}

/** 保存时间的本地化短串 */
export function formatSavedAt(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return '';
  try {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '';
  }
}

/* ─── AI 解读对话记忆 ─────────────────────────────────────────
   与生辰记忆同一模块、同一清除体系，但按命盘隔离存储：
   每张命盘一个 key，避免把 A 的解读历史错误地带入 B 的上下文。 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 自动话题 / 宫位分析的提问不在气泡中显示，但需要保留在上下文里 */
  hidden?: boolean;
  /** 消息产生时间。用于判断长期事实的新旧与过期；旧数据缺失时由调用方兜底 */
  ts?: number;
}

export const CHAT_KEY_PREFIX = 'ziwei_chat_v1:';
export const CHAT_VERSION = 1;
/** 单会话最多保留的轮次；超出后丢弃最早的消息 */
export const CHAT_MAX_MESSAGES = 40;
/** 单条消息最大字符数 */
export const CHAT_MAX_CONTENT = 4000;
/** 单会话累计字符上限，防止占满 localStorage 配额 */
export const CHAT_MAX_TOTAL = 60000;
/** 长期事实与会话的保留期（180 天）；过期后惰性淘汰 */
export const MEMORY_TTL_MS = 180 * 24 * 60 * 60 * 1000;
/** 长期事实最多保留条数（类别数远小于此值，实际仅作防御上限） */
export const FACT_MAX_ITEMS = 16;
/** 单条事实文本上限 */
export const FACT_MAX_VALUE = 160;
/** 送进模型的上下文窗口：最多条数与单条字符数（与优化前保持一致） */
export const CTX_MAX_TURNS = 10;
export const CTX_MAX_CHARS = 1200;

/** 一条长期事实：同一 key 只保留最后一次设定 */
export interface LongTermFact {
  /** 归一化类别（如「语言」「禁忌」），也是冲突消解的主键 */
  key: string;
  /** 归一化后的约束原文 */
  value: string;
  /** 最后一次设定时间 */
  ts: number;
  /** 递增序号：同一时间戳下仍能确定性判定先后 */
  seq: number;
}

export interface ChatMemory {
  version: typeof CHAT_VERSION;
  key: string;
  label: string;
  messages: ChatMessage[];
  savedAt: number;
  /** 长期事实；旧数据无此字段时按空数组处理，保证向后兼容 */
  facts: LongTermFact[];
}

/** 生成会话 id 所需的最小出生信息（兼容 BirthInfo 与表单草稿） */
export interface ChatIdentity {
  year: number | string;
  month: number | string;
  day: number | string;
  hour?: number | string;
  gender?: string;
  name?: string;
  city?: string;
  longitude?: number | string;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 由出生信息生成稳定会话 id。只输出哈希，key 中不含姓名或生辰明文。 */
export function chatKeyForBirth(b: ChatIdentity): string {
  return fnv1a([
    b.year, b.month, b.day,
    b.hour ?? '', b.gender ?? '', b.name ?? '', b.city ?? '', b.longitude ?? '',
  ].map(String).join('|'));
}

export function chatStorageKey(key: string): string {
  const safe = key.slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, '');
  // 账号后缀加在前缀上，使 clearAllChats / countChats 仍能用同一前缀枚举
  return `${scopedKey(CHAT_KEY_PREFIX)}${safe || 'default'}`;
}

/** 会话的可读标签，仅写入 value，用于 UI 展示 */
export function describeChatLabel(b: ChatIdentity): string {
  return [
    b.name ? String(b.name) : '',
    `${b.year}年${b.month}月${b.day}日`,
    b.gender === 'female' ? '女' : '男',
  ].filter(Boolean).join(' · ');
}

/**
 * 严格规整消息数组；结构非法返回 null。
 * 空白内容（流式占位）直接跳过；相邻完全重复的消息去重（自动话题重复触发 /
 * 重试留下的同一条内容），保证历史信息准确且不会重复计入上下文。
 */
function normalizeChatMessages(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ChatMessage[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return null;
    if (item.role !== 'user' && item.role !== 'assistant') return null;
    if (typeof item.content !== 'string') return null;
    const content = item.content.slice(0, CHAT_MAX_CONTENT);
    if (!content.trim()) continue;
    const msg: ChatMessage = { role: item.role, content };
    if (item.hidden === true) msg.hidden = true;
    if (typeof item.ts === 'number' && Number.isFinite(item.ts) && item.ts > 0) {
      msg.ts = item.ts;
    }
    const prev = out[out.length - 1];
    if (prev && prev.role === msg.role && prev.content === msg.content) continue;
    out.push(msg);
  }
  return out.slice(-CHAT_MAX_MESSAGES);
}

function trimForQuota(messages: ChatMessage[]): ChatMessage[] {
  const out = messages.slice(-CHAT_MAX_MESSAGES);
  let total = out.reduce((n, m) => n + m.content.length, 0);
  while (out.length > 1 && total > CHAT_MAX_TOTAL) {
    const removed = out.shift();
    total -= removed ? removed.content.length : 0;
  }
  if (out.length === 1 && out[0].content.length > CHAT_MAX_TOTAL) {
    out[0] = { ...out[0], content: out[0].content.slice(-CHAT_MAX_TOTAL) };
  }
  return out;
}

/**
 * 读取某张命盘的解读对话；数据损坏或已过期时删除该键并返回 null。
 * now 可注入，便于对「历史信息过期」做确定性测试；默认当前时间。
 * facts 为可选字段：旧数据没有时按空数组处理，实现零迁移兼容。
 */
export function loadChat(key: string, now: number = Date.now()): ChatMemory | null {
  if (typeof window === 'undefined') return null;
  const storageKey = chatStorageKey(key);
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== CHAT_VERSION) throw new Error('version');
    const messages = normalizeChatMessages(parsed.messages);
    if (!messages) throw new Error('messages');
    const savedAt =
      typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt) && parsed.savedAt > 0
        ? parsed.savedAt : Date.now();
    // 历史信息过期：超过保留期的会话惰性清除，避免陈旧上下文污染新解读
    if (now - savedAt > MEMORY_TTL_MS) {
      try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
      return null;
    }
    return {
      version: CHAT_VERSION,
      key,
      label: typeof parsed.label === 'string' ? parsed.label.slice(0, 60) : '',
      messages,
      savedAt,
      facts: normalizeFacts(parsed.facts),
    };
  } catch {
    try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
    return null;
  }
}

/**
 * 写入某张命盘的对话；失败（禁存储 / 配额满）返回 null，不影响使用。
 * facts 为可选第 4 参数：未传时自动读取已有事实并与当前消息合并后派生，
 * 因此既有 3 参数调用完全兼容，且即使调用方遗漏也不会丢失长期状态。
 */
export function saveChat(
  key: string,
  label: string,
  messages: ChatMessage[],
  facts?: LongTermFact[],
): ChatMemory | null {
  if (typeof window === 'undefined') return null;
  const normalized = normalizeChatMessages(messages);
  if (!normalized || normalized.length === 0) return null;
  const trimmed = trimForQuota(normalized);
  const previous = facts ?? loadChat(key)?.facts ?? [];
  const entry: ChatMemory = {
    version: CHAT_VERSION,
    key,
    label: label.slice(0, 60),
    messages: trimmed,
    savedAt: Date.now(),
    facts: normalizeFacts(extractLongTermFacts(trimmed, previous)),
  };
  try {
    window.localStorage.setItem(chatStorageKey(key), JSON.stringify(entry));
    return entry;
  } catch {
    return null;
  }
}

/** 只清除当前这张命盘的对话 */
export function clearChat(key: string): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(chatStorageKey(key)); } catch { /* ignore */ }
}

/** 清除全部命盘的对话（不影响主题偏好等其他键） */
export function clearAllChats(): void {
  if (typeof window === 'undefined') return;
  try {
    const ls = window.localStorage;
    const doomed: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(scopedKey(CHAT_KEY_PREFIX))) doomed.push(k);
    }
    for (const k of doomed) ls.removeItem(k);
  } catch { /* ignore */ }
}

/** 顶层「清除记忆」：生辰 + 历史 + 全部对话一次清空 */
export function clearAllMemory(): void {
  clearBirthMemory();
  clearAllChats();
}

/** 当前保存了几段对话，用于顶栏状态展示 */
export function countChats(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const ls = window.localStorage;
    let n = 0;
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(scopedKey(CHAT_KEY_PREFIX))) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/* ─── 长期上下文：事实抽取 / 冲突消解 / 上下文构建 ───────────────
   纯函数，不触碰 DOM、不发网络请求，可直接在 Node 回归测试中验证。 */

/** 失败提示与接口缺失说明不是真实解读，不参与事实抽取与上下文 */
const FAILURE_PREFIXES = ['解读失败', '开源版不含 AI 解读接口'];
export function isFailureNotice(content: string): boolean {
  return FAILURE_PREFIXES.some(p => content.startsWith(p));
}

/**
 * 事实类别规则。按优先级一句只归入一个类别（整句作为 value 保留全部信息），
 * 冲突消解因此严格发生在「同类设定的新旧」之间，不会被跨类别句子误覆盖。
 * 只从「用户手动输入」（非 hidden）抽取；自动话题模板另有二次排除，
 * 避免把「请生成命格总览」这类系统 prompt 误判成长期偏好。
 */
const FACT_RULES: ReadonlyArray<{ key: string; test: RegExp }> = [
  // 否定约束优先，避免「不要讲术语」被误判成一条新的语言设定而覆盖旧值
  { key: '禁忌', test: /不要|不用|请勿|避免|少讲|少提|不讲|禁用|跳过|别再|别用|别说|别讲|别提|无需|勿/ },
  { key: '称呼', test: /叫我|称呼我|我叫|我姓|称我/ },
  { key: '语言', test: /简体|繁体|英文|中文|白话|文言|术语|口语/ },
  { key: '篇幅', test: /简短|简洁|详细|一句话|展开|精简|长一点|别太长|多写|少写/ },
  { key: '格式', test: /分点|表格|列表|结构化|只给结论|按点|条理|分条/ },
  { key: '关注', test: /重点|关注|侧重|只看|主要看|优先|更关心|只想了解|重点看/ },
  { key: '其他', test: /以后|接下来|一直|始终|每次|记住|从现在|长期|默认/ },
];

function normalizeFactText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, FACT_MAX_VALUE);
}

/** 严格规整长期事实：非法结构一律丢弃；同 key 只保留 seq 最大的一条 */
export function normalizeFacts(raw: unknown): LongTermFact[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, LongTermFact>();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (typeof item.key !== 'string' || typeof item.value !== 'string') continue;
    const key = item.key.slice(0, 16);
    const value = normalizeFactText(item.value);
    if (!key || !value) continue;
    const ts = typeof item.ts === 'number' && Number.isFinite(item.ts) && item.ts > 0
      ? item.ts : 0;
    const seq = typeof item.seq === 'number' && Number.isFinite(item.seq) ? item.seq : 0;
    const fact: LongTermFact = { key, value, ts, seq };
    const prev = byKey.get(key);
    if (!prev || fact.seq >= prev.seq) byKey.set(key, fact);
  }
  return [...byKey.values()]
    .sort((a, b) => b.seq - a.seq)
    .slice(0, FACT_MAX_ITEMS)
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * 从完整对话中确定性抽取长期事实，并与已有事实合并。
 *  - 过期：ts 早于 now - MEMORY_TTL_MS 的事实淘汰；
 *  - 冲突：同一 key 后写覆盖（seq 单调递增，同时间戳下也能判先后）；
 *  - 重复：按 key 收敛，重复设定只留最新一条；
 *  - 稳定：输出按 key 排序，便于测试与锚点渲染。
 * previous 里的设定即使原消息已被 40 条窗口裁掉，也依然保留 —— 这是
 * 「早前设定的偏好在后续多轮仍正确沿用」的关键。
 */
export function extractLongTermFacts(
  messages: ChatMessage[],
  previous: LongTermFact[] = [],
  now: number = Date.now(),
): LongTermFact[] {
  const merged = new Map<string, LongTermFact>();
  let seq = 0;

  for (const f of normalizeFacts(previous)) {
    if (f.ts > 0 && now - f.ts > MEMORY_TTL_MS) continue;
    merged.set(f.key, { ...f, seq: ++seq });
  }

  for (const m of messages) {
    if (!m || m.role !== 'user' || m.hidden) continue;
    if (typeof m.content !== 'string' || isFailureNotice(m.content)) continue;
    const ts = typeof m.ts === 'number' && Number.isFinite(m.ts) && m.ts > 0 ? m.ts : now;
    for (const sentence of m.content.split(/[。！？!?；;\n]/)) {
      const value = normalizeFactText(sentence);
      if (!value) continue;
      if (/^请(?:生成|深度分析|分析|重点分析)/.test(value)) continue;
      // 一句只归入最优先的一个类别：整句已包含全部约束信息，模型可直接读到，
      // 同时避免同一句话把多个类别的旧设定互相覆盖（冲突边界）。
      for (const rule of FACT_RULES) {
        if (!rule.test.test(value)) continue;
        merged.set(rule.key, { key: rule.key, value, ts, seq: ++seq });
        break;
      }
    }
  }

  return [...merged.values()]
    .filter(f => !(f.ts > 0 && now - f.ts > MEMORY_TTL_MS))
    .sort((a, b) => b.seq - a.seq)
    .slice(0, FACT_MAX_ITEMS)
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** 把长期事实渲染成稳定的 system 锚点；无事实时返回空串（与优化前等价） */
export function renderFactsAnchor(facts: LongTermFact[]): string {
  const valid = normalizeFacts(facts);
  if (valid.length === 0) return '';
  const lines = valid.map(f => `- 【${f.key}】${f.value}`).join('\n');
  return [
    '以下是用户在之前的对话中明确设定、要求长期沿用的偏好与约束。',
    '请在本次及后续所有回答中始终遵守，不要忽略，也不要与这些设定相矛盾。',
    lines,
  ].join('\n');
}

export interface ApiMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * 构建送进 /api/interpret 的上下文。对外仍是 { role, content }[]，契约不变。
 *  - 锚点（system）携带跨窗口仍然有效的长期事实，保证早前设定不丢失；
 *  - 窗口清洗：去空 / 去失败占位 / 相邻完全重复去重 / 连续同角色合并；
 *  - 结构合法化：以 user 开头、以 user 结尾、严格交替，问答对不被拆散；
 *  - 无长期事实时不产生 system 消息，行为与优化前一致。
 */
export function buildApiMessages(
  messages: ChatMessage[],
  facts: LongTermFact[] = [],
  now: number = Date.now(),
): ApiMessage[] {
  const anchor = renderFactsAnchor(extractLongTermFacts(messages, facts, now));

  const cleaned: ChatMessage[] = [];
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    if (typeof m.content !== 'string') continue;
    const content = m.content.slice(0, CTX_MAX_CHARS);
    if (!content.trim()) continue;
    if (m.role === 'assistant' && isFailureNotice(content)) continue;
    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.role === m.role && prev.content === content) continue;
    cleaned.push({ role: m.role, content });
  }

  // 合并连续同角色，保证严格交替（合并后的内容仍受单条字符上限约束）
  const alternated: ChatMessage[] = [];
  for (const m of cleaned) {
    const prev = alternated[alternated.length - 1];
    if (prev && prev.role === m.role) {
      alternated[alternated.length - 1] = {
        role: m.role,
        content: `${prev.content}\n${m.content}`.slice(-CTX_MAX_CHARS),
      };
    } else {
      alternated.push({ ...m });
    }
  }

  // 从末尾取窗口，但把起点后移到最近的 user，避免把一问一答拆散
  let start = Math.max(0, alternated.length - CTX_MAX_TURNS);
  while (start < alternated.length && alternated[start].role !== 'user') start++;
  const contextWindow = alternated.slice(start);
  // 末尾必须是当前提问（user）；异常数据下裁掉悬空的 assistant
  while (contextWindow.length > 0 && contextWindow[contextWindow.length - 1].role !== 'user') {
    contextWindow.pop();
  }

  const out: ApiMessage[] = [];
  if (anchor) out.push({ role: 'system', content: anchor });
  for (const m of contextWindow) out.push({ role: m.role, content: m.content });
  return out;
}
