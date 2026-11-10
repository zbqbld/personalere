'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import BirthForm, { type BirthFormState } from '@/components/BirthForm';
import ChartBoard from '@/components/ChartBoard';
import InsightPanel from '@/components/InsightPanel';
import { generateChart } from '@/lib/ziwei/algorithm';
import { formToBirthInfo } from '@/lib/ziwei/share';
import { useTheme } from '@/components/ThemeProvider';
import {
  loadLastBirth,
  saveLastBirth,
  clearAllMemory,
  describeBirthDraft,
  formatSavedAt,
  type LastBirthMemory,
} from '@/lib/ziwei/memory';
import { saveUserProfiles } from '@/lib/ziwei/user-profiles';
import AccountPanel from '@/components/AccountPanel';
import { clearAccountProfiles, saveAccountProfiles } from '@/lib/account/client';
import type { ZiweiChart, Palace } from '@/lib/ziwei/types';

/**
 * 命盘页
 *
 * 本地记忆行为：
 *  - 首次起盘并勾选「记住本次信息」→ 表单写入 localStorage（仅本机）。
 *  - 再次打开 → 自动读取并用 generateChart() 复原命盘，直接进入命盘视图，
 *    无需重新输入、无需点击起盘。
 *  - 「沿用上次信息」与「重新起盘」是两个明确分离的入口（见沿用卡片 / 顶栏）。
 *  - AI 解读对话同样按命盘分别持久化（见 lib/ziwei/memory.ts 与 InsightPanel）。
 *  - 每次起盘同时按用户维度写入档案库（见 lib/ziwei/user-profiles.ts）：
 *    多个起盘用户各自保留，重复提交去重，校验不通过时明确提示且不写盘。
 *  - 可随时清除或重置，清除动作带二次确认；顶层清除会连带删除全部对话
 *    与全部用户档案（登录态下同时清空该账号的服务端档案）。
 *  - 注册并登录后，起盘档案归属该账号，只经 /api/profiles 读写；未登录
 *    时保持原有本地流程，不强制登录。
 */
export default function ChartPage() {
  const { toggle } = useTheme();

  const [hydrated, setHydrated] = useState(false);
  const [memory, setMemory] = useState<LastBirthMemory | null>(null);
  const [chart, setChart] = useState<ZiweiChart | null>(null);
  const [selectedPalace, setSelectedPalace] = useState<Palace | null>(null);

  const [remember, setRemember] = useState(true);
  const [formSeed, setFormSeed] = useState<Partial<BirthFormState> | undefined>(undefined);
  const [formKey, setFormKey] = useState(0);
  const [autoRestored, setAutoRestored] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [toast, setToast] = useState('');
  /** 顶层「清除记忆」时递增，通知解读面板同步清空内存中的对话 */
  const [chatResetSignal, setChatResetSignal] = useState(0);
  /** 当前登录账号；null 表示匿名模式，用户档案只写本地 */
  const [accountOwnerId, setAccountOwnerId] = useState<string | null>(null);
  const formRef = useRef<BirthFormState | null>(null);

  const buildFrom = useCallback((form: BirthFormState): ZiweiChart | null => {
    try {
      return generateChart(formToBirthInfo(form));
    } catch {
      return null;
    }
  }, []);

  // ── 挂载时恢复：只用本地数据，不访问网络 ──────────────────
  useEffect(() => {
    const mem = loadLastBirth();
    setMemory(mem);
    setFormSeed(mem?.form);
    if (mem) {
      const restored = buildFrom(mem.form);
      if (restored) {
        setChart(restored);
        setAutoRestored(true);
      }
      // 让表单以记忆数据重新挂载（即使自动复原失败，回到表单时也是预填状态）
      setFormKey(k => k + 1);
    }
    setHydrated(true);
  }, [buildFrom]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  // ── 提交新起盘 ────────────────────────────────────────────
  const handleSubmit = async () => {
    const form = formRef.current;
    if (!form) return;
    const next = buildFrom(form);
    if (!next) {
      setToast('起盘失败，请检查出生信息');
      return;
    }
    setChart(next);
    setSelectedPalace(null);
    setAutoRestored(false);
    setConfirmClear(false);

    if (remember) {
      const saved = saveLastBirth(form);
      setMemory(saved);
      if (saved) setFormSeed(saved.form);
      if (accountOwnerId) {
        // 登录态：档案只写服务端账号空间，本地档案库保持为空，避免留明文副本
        const remote = await saveAccountProfiles([{ form }]);
        setToast(remote.ok
          ? '已保存到当前账号（仅本人登录后可见、可改）'
          : `保存失败：${remote.message}`);
      } else {
        // 匿名态：保持原有本地流程不变
        const { results } = saveUserProfiles([{ form }]);
        const result = results[0];
        setToast(
          !saved
            ? '浏览器禁止本地存储，本次未记住'
            : result && result.status === 'rejected'
              ? `信息校验未通过，未写入用户档案：${result.errors[0]?.message ?? '未知原因'}`
              : '已记住本次信息（仅存本机，按用户分别保存）',
        );
      }
    } else {
      clearAllMemory();
      if (accountOwnerId) void clearAccountProfiles();
      setMemory(null);
      setChatResetSignal(x => x + 1);
      setToast('本次信息未保存，已清除本机原有记忆');
    }
  };

  /** 沿用上次信息：不重新输入、不重新起盘，直接回到命盘 */
  const handleResume = () => {
    if (!memory) return;
    const restored = buildFrom(memory.form);
    if (!restored) {
      setToast('上次信息无法读取，请重新起盘');
      return;
    }
    setChart(restored);
    setSelectedPalace(null);
    setAutoRestored(true);
    setConfirmClear(false);
  };

  /** 重新起盘：回到表单，并预填上次信息便于修改 */
  const handleRestart = () => {
    setChart(null);
    setSelectedPalace(null);
    setAutoRestored(false);
    setFormSeed(memory?.form);
    setFormKey(k => k + 1);
    setConfirmClear(false);
  };

  /** 全新填写：空白表单（不删除已有记忆，提交后才覆盖） */
  const handleFresh = () => {
    setChart(null);
    setSelectedPalace(null);
    setAutoRestored(false);
    setFormSeed({});
    setFormKey(k => k + 1);
    setConfirmClear(false);
    formRef.current = null;
  };

  /** 清除本地记忆：二次确认，避免误删 */
  const handleClear = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    clearAllMemory();
    if (accountOwnerId) void clearAccountProfiles();
    setMemory(null);
    setConfirmClear(false);
    setAutoRestored(false);
    setChatResetSignal(x => x + 1);
    setToast('已清除本机保存的信息与全部对话');
  };

  return (
    <div className="zw-page">
      <header className="zw-topbar">
        <div className="zw-topbar-inner">
          <Link href="/workbench" className="zw-brand" title="打开命盘工作台">
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
            <div className="zw-brand-copy">
              <div className="zw-brand-title">紫微命盘</div>
            </div>
          </Link>

          <div className="zw-top-actions">
            <Link href="/workbench" className="zw-wb-link">工作台</Link>
            <span className={`zw-pill${memory ? '' : ' zw-pill-off'}`}>
              {memory ? '已记住' : '未保存'}
            </span>

            {chart && (
              <button type="button" className="zw-btn zw-btn-quiet" onClick={handleRestart}>
                重新起盘
              </button>
            )}

            {memory && (confirmClear ? (
              <>
                <button type="button" className="zw-btn zw-btn-danger" onClick={handleClear}>
                  确认清除
                </button>
                <button type="button" className="zw-link" onClick={() => setConfirmClear(false)}>
                  取消
                </button>
              </>
            ) : (
              <button
                type="button"
                className="zw-btn zw-btn-quiet"
                onClick={handleClear}
                title="清除本机保存的姓名、生辰与全部解读对话"
              >
                清除记忆
              </button>
            ))}

            <button
              type="button"
              className="zw-btn zw-btn-icon"
              onClick={toggle}
              title="切换明暗主题"
              aria-label="切换明暗主题"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* 首帧遮罩：避免「表单 → 自动恢复命盘」的视觉跳变；SSR 与客户端首帧一致 */}
      {!hydrated && <div className="zw-boot">正在恢复上次的信息…</div>}

      {chart ? (
        <>
          {memory && autoRestored && (
            <div className="zw-status-strip">
              <span className="zw-status-tag">已自动沿用上次信息</span>
              <span className="zw-status-text">{describeBirthDraft(memory.form)}</span>
              <span className="zw-status-meta">保存于 {formatSavedAt(memory.savedAt)}</span>
              <button type="button" className="zw-link" onClick={handleRestart}>
                修改信息 / 重新起盘
              </button>
            </div>
          )}

          <div className="zw-workspace">
            <div className="zw-scroll">
              <ChartBoard chart={chart} onPalaceSelect={setSelectedPalace} />
            </div>
            <div className="zw-scroll">
              <InsightPanel
                chart={chart}
                selectedPalace={selectedPalace}
                chatResetSignal={chatResetSignal}
              />
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="zw-hero">
            <h1>起一张你的命盘</h1>
          </div>

          <div className="zw-form-wrap">
            {memory && (
              <section className="zw-memory-card">
                <div className="zw-memory-head">
                  <span className="zw-memory-label">上次的信息</span>
                  <span className="zw-memory-meta">保存于 {formatSavedAt(memory.savedAt)}</span>
                </div>
                <p className="zw-memory-summary">{describeBirthDraft(memory.form)}</p>
                <p className="zw-memory-hint">
                  沿用 = 不重新输入、不重新起盘，直接回到这张命盘，并带回它上次的解读对话；
                  重新起盘 = 填写一份新信息并生成新命盘，对话按命盘分开保存，互不串用。
                </p>
                <div className="zw-memory-actions">
                  <button type="button" className="zw-btn zw-btn-primary" onClick={handleResume}>
                    沿用上次信息 · 直接查看命盘
                  </button>
                  <button type="button" className="zw-btn zw-btn-ghost" onClick={handleFresh}>
                    重新起盘 · 全新填写
                  </button>
                </div>
                <div className="zw-memory-foot">
                  <button type="button" className="zw-link" onClick={handleRestart}>
                    在上次信息上修改
                  </button>
                  <button type="button" className="zw-link" onClick={handleClear}>
                    {confirmClear ? '再点一次确认清除' : '清除本地记忆'}
                  </button>
                </div>
              </section>
            )}

            <AccountPanel onAccountChange={setAccountOwnerId} />

            <BirthForm
              key={formKey}
              initialData={formSeed}
              onFormSave={(f) => { formRef.current = f; }}
              onSubmit={() => { void handleSubmit(); }}
              remember={remember}
              onRememberChange={setRemember}
            />

          </div>
        </>
      )}

      {toast && <div className="zw-toast" role="status">{toast}</div>}
    </div>
  );
}
