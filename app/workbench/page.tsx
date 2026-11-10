'use client';

/**
 * 命盘工作台：手机与电脑共用的入口页
 *
 * 数据全部来自本机 localStorage（匿名档案 / 上次生辰 / 解读会话）与
 * 当前登录账号，保持项目「仅存本机、账号数据服务端隔离」的隐私模型。
 * 布局单列/双列随视口切换，手机端提供底部标签栏，桌面端用顶部导航。
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTheme } from '@/components/ThemeProvider';
import {
  CHAT_KEY_PREFIX,
  scopedKey,
  loadLastBirth,
  describeBirthDraft,
  formatSavedAt,
  countChats,
  type ChatMemory,
  type LastBirthMemory,
} from '@/lib/ziwei/memory';
import { listUserProfiles, type UserProfile } from '@/lib/ziwei/user-profiles';
import { loadAccount, type AccountInfo } from '@/lib/account/client';

interface RecentChat {
  label: string;
  savedAt: number;
  messages: number;
}

/** 按当前账号命名空间读取最近解读会话，不改动任何数据 */
function readRecentChats(): RecentChat[] {
  if (typeof window === 'undefined') return [];
  const prefix = scopedKey(CHAT_KEY_PREFIX);
  const out: RecentChat[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const mem = JSON.parse(raw) as ChatMemory;
      if (!mem || !Array.isArray(mem.messages)) continue;
      out.push({
        label: mem.label || '命理解读',
        savedAt: typeof mem.savedAt === 'number' ? mem.savedAt : 0,
        messages: mem.messages.length,
      });
    }
  } catch { /* 损坏数据跳过 */ }
  return out.sort((a, b) => b.savedAt - a.savedAt).slice(0, 5);
}

function TabIcon({ name }: { name: 'grid' | 'chart' | 'chat' | 'book' }) {
  const common = { width: 19, height: 19, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (name === 'grid') return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></svg>;
  if (name === 'chart') return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 3v18M3 12h18" /></svg>;
  if (name === 'chat') return <svg {...common}><path d="M20 15a3 3 0 0 1-3 3H8l-4 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z" /></svg>;
  return <svg {...common}><path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z" /><path d="M8 7h7M8 11h7" /></svg>;
}

const SHORTCUTS = [
  { href: '/chart', label: '开始起盘', hint: '填写生辰生成命盘', icon: 'chart' as const },
  { href: '/knowledge', label: '星曜知识', hint: '十四主星与宫位', icon: 'grid' as const },
  { href: '/library', label: '古籍研读', hint: '全集 · 全书 · 骨髓赋', icon: 'book' as const },
  { href: '/heming', label: '合盘分析', hint: '两人缘分与契合度', icon: 'chat' as const },
];

export default function WorkbenchPage() {
  const { theme, toggle } = useTheme();
  const [ready, setReady] = useState(false);
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [chats, setChats] = useState<RecentChat[]>([]);
  const [chatCount, setChatCount] = useState(0);
  const [lastBirth, setLastBirth] = useState<LastBirthMemory | null>(null);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [today, setToday] = useState('');

  useEffect(() => {
    // 日期放在客户端计算，避免服务端与浏览器时区不同造成水合不一致
    setToday(new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    }).format(new Date()));
  }, []);

  useEffect(() => {
    // 先恢复账号命名空间，再读取该空间下的本机数据，避免读到别人的键
    loadAccount().then(a => {
      setAccount(a);
      setProfiles(listUserProfiles());
      setChats(readRecentChats());
      setChatCount(countChats());
      setLastBirth(loadLastBirth());
      setReady(true);
    }).catch(() => {
      setProfiles(listUserProfiles());
      setReady(true);
    });
  }, []);

  return (
    <div className="wb-page">
      <header className="wb-topbar">
        <div className="wb-topbar-inner">
          <div className="wb-brand">
            <span className="zw-brand-mark" aria-hidden="true">
              <svg viewBox="0 0 64 64" width="30" height="30">
                <rect width="64" height="64" rx="16" fill="#007AFF" />
                <circle cx="32" cy="32" r="20" fill="none" stroke="#FFFFFF" strokeWidth="1.5" opacity="0.5" />
                <circle cx="32" cy="32" r="12.5" fill="none" stroke="#FFFFFF" strokeWidth="1.2" opacity="0.32" />
                <path d="M32 15 L34.5 27.5 L47 30 L34.5 32.5 L32 45 L29.5 32.5 L17 30 L29.5 27.5 Z" fill="#FFFFFF" />
                <circle cx="32" cy="30" r="2.4" fill="#007AFF" />
                <circle cx="47.5" cy="16.5" r="2.5" fill="#FFFFFF" opacity="0.95" />
                <circle cx="16.5" cy="47.5" r="1.8" fill="#FFFFFF" opacity="0.7" />
              </svg>
            </span>
            <div>
              <div className="wb-brand-title">紫微命盘</div>
              <div className="wb-brand-sub">命盘工作台</div>
            </div>
          </div>

          <nav className="wb-topnav">
            <Link href="/chart" className="wb-nav-link">命盘</Link>
            <Link href="/knowledge" className="wb-nav-link">知识库</Link>
            <Link href="/library" className="wb-nav-link">古籍</Link>
            <button type="button" className="wb-theme" onClick={toggle} aria-label="切换明暗主题" title="切换明暗主题">
              {theme === 'dark' ? '☀' : '☾'}
            </button>
          </nav>
        </div>
      </header>

      <main className="wb-main">
        <section className="wb-hero">
          <p className="wb-eyebrow">WORKBENCH{today ? ` · ${today}` : ''}</p>
          <h1>命盘工作台</h1>
          <p className="wb-hero-sub">一屏掌握档案、解读与起盘入口。数据仅保存在本机与你的账号空间。</p>
        </section>

        <section className="wb-stats" aria-label="概览">
          <div className="wb-stat">
            <span className="wb-stat-label">命盘档案</span>
            <strong className="wb-stat-value">{ready ? profiles.length : '—'}</strong>
            <span className="wb-stat-foot">本机 / 当前账号</span>
          </div>
          <div className="wb-stat">
            <span className="wb-stat-label">解读会话</span>
            <strong className="wb-stat-value">{ready ? chatCount : '—'}</strong>
            <span className="wb-stat-foot">按命盘分开保存</span>
          </div>
          <div className="wb-stat">
            <span className="wb-stat-label">最近起盘</span>
            <strong className="wb-stat-value wb-stat-value-sm">
              {ready ? (lastBirth ? formatSavedAt(lastBirth.savedAt) : '暂无') : '—'}
            </strong>
            <span className="wb-stat-foot">{lastBirth ? describeBirthDraft(lastBirth.form) : '起一张命盘开始'}</span>
          </div>
          <div className="wb-stat">
            <span className="wb-stat-label">当前账号</span>
            <strong className="wb-stat-value wb-stat-value-sm">{account ? account.nickname : '匿名模式'}</strong>
            <span className="wb-stat-foot">{account ? '档案归属本人账号' : '数据仅存本机'}</span>
          </div>
        </section>

        <div className="wb-grid">
          <section className="wb-card">
            <div className="wb-card-head">
              <h2>快捷操作</h2>
              <span className="wb-card-note">常用入口</span>
            </div>
            <div className="wb-shortcuts">
              {SHORTCUTS.map(s => (
                <Link key={s.href} href={s.href} className="wb-shortcut">
                  <span className="wb-shortcut-icon"><TabIcon name={s.icon} /></span>
                  <span className="wb-shortcut-copy">
                    <strong>{s.label}</strong>
                    <span>{s.hint}</span>
                  </span>
                  <span className="wb-shortcut-arrow">›</span>
                </Link>
              ))}
            </div>
          </section>

          <div className="wb-stack">
            <section className="wb-card">
              <div className="wb-card-head">
                <h2>命盘档案</h2>
                <Link href="/chart" className="wb-card-link">去起盘 ›</Link>
              </div>
              {profiles.length === 0 ? (
                <p className="wb-empty">还没有档案。起一张命盘后，这里会按用户分别保存。</p>
              ) : (
                <ul className="wb-list">
                  {profiles.slice(0, 6).map(p => (
                    <li key={p.userId} className="wb-row">
                      <span className="wb-row-dot" />
                      <span className="wb-row-copy">
                        <strong>{p.displayName}</strong>
                        <span>{describeBirthDraft(p.form)}</span>
                      </span>
                      <span className="wb-row-time">{formatSavedAt(p.updatedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="wb-card">
              <div className="wb-card-head">
                <h2>最近解读</h2>
                <Link href="/chart" className="wb-card-link">继续追问 ›</Link>
              </div>
              {chats.length === 0 ? (
                <p className="wb-empty">暂无解读记录。打开命盘后，解读对话会按命盘自动保存。</p>
              ) : (
                <ul className="wb-list">
                  {chats.map((c, i) => (
                    <li key={`${c.label}-${i}`} className="wb-row">
                      <span className="wb-row-dot wb-row-dot-alt" />
                      <span className="wb-row-copy">
                        <strong>{c.label}</strong>
                        <span>{c.messages} 条对话</span>
                      </span>
                      <span className="wb-row-time">{formatSavedAt(c.savedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>

        <section className="wb-tips">
          <h2>使用提示</h2>
          <div className="wb-tip-grid">
            <div className="wb-tip"><strong>真太阳时</strong><span>填写出生地可自动校正时辰，排盘更准确。</span></div>
            <div className="wb-tip"><strong>自动恢复</strong><span>勾选「记住本次信息」，下次打开直接回到命盘。</span></div>
            <div className="wb-tip"><strong>对话隔离</strong><span>解读按命盘分开保存，可在解读面板单独清空。</span></div>
          </div>
        </section>
      </main>

      <nav className="wb-tabbar" aria-label="底部导航">
        <Link href="/workbench" className="wb-tab wb-tab-active"><TabIcon name="grid" /><span>工作台</span></Link>
        <Link href="/chart" className="wb-tab"><TabIcon name="chart" /><span>起盘</span></Link>
        <Link href="/chart" className="wb-tab"><TabIcon name="chat" /><span>解读</span></Link>
        <Link href="/library" className="wb-tab"><TabIcon name="book" /><span>古籍</span></Link>
      </nav>
    </div>
  );
}
