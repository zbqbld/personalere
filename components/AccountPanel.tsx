'use client';

/**
 * 注册 / 登录面板
 *
 * 账号数据只经服务端接口读写，浏览器不保存会话令牌（HttpOnly Cookie）。
 * 注册成功时把本机匿名空间里已有的档案一次性绑定到新账号，随后清除本地
 * 副本并切换到该账号命名空间；登出后回到匿名空间，账号数据不可再被读取。
 */
import { useEffect, useState } from 'react';
import { useTheme } from '@/components/ThemeProvider';
import {
  applyAccountScope,
  loadAccount,
  loginAccount,
  logoutAccount,
  registerWithEmail,
  sendEmailCode,
  type AccountInfo,
} from '@/lib/account/client';
import { clearUserProfiles, listUserProfiles } from '@/lib/ziwei/user-profiles';

interface AccountPanelProps {
  onAccountChange?: (ownerId: string | null) => void;
  /** 嵌入登录门禁页时去掉自带卡片外壳，由外层统一提供容器 */
  embedded?: boolean;
}

export default function AccountPanel({ onAccountChange, embedded = false }: AccountPanelProps) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [username, setUsername] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(username.trim());

  // 计费（线上 BILLING_MODE=card 时启用；接口未开启返回 enabled:false，整个区块不渲染）
  interface BillingView { freeLimit: number; freeLeft: number; credits: number }
  const [billing, setBilling] = useState<BillingView | null>(null);
  const [cardCode, setCardCode] = useState('');
  const [cardBusy, setCardBusy] = useState(false);
  const [cardMsg, setCardMsg] = useState('');

  useEffect(() => {
    let alive = true;
    loadAccount().then(a => {
      if (!alive) return;
      setAccount(a);
      onAccountChange?.(a?.ownerId ?? null);
      if (!a) applyAccountScope(null);
    });
    fetch('/api/billing')
      .then(r => r.json())
      .then(j => { if (alive && j?.ok && j?.data?.enabled) setBilling(j.data as BillingView); })
      .catch(() => { /* 计费未启用或网络异常：不展示该区块 */ });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  const redeem = async () => {
    const code = cardCode.trim();
    if (!code || cardBusy) return;
    setCardBusy(true);
    setCardMsg('');
    try {
      const res = await fetch('/api/billing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'redeem', code }),
      });
      const j = await res.json().catch(() => null);
      if (j?.ok) {
        setCardMsg(`兑换成功，已加 ${j.data.added} 次，当前卡密剩 ${j.data.credits} 次`);
        setCardCode('');
        setBilling(b => (b ? { ...b, credits: Number(j.data.credits) || 0 } : b));
      } else {
        setCardMsg(j?.message || '兑换失败，请稍后重试');
      }
    } catch {
      setCardMsg('网络异常，请稍后重试');
    } finally {
      setCardBusy(false);
    }
  };

  const publish = (a: AccountInfo | null) => {
    setAccount(a);
    onAccountChange?.(a?.ownerId ?? null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    if (!username.trim() || !password) {
      setError('请输入邮箱与密码');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'register') {
        // 必须在切换命名空间之前读取并清除本机匿名档案
        const bind = listUserProfiles().map(p => ({ userId: p.userId, form: p.form }));
        if (!emailOk) { setError('邮箱格式不正确'); return; }
        if (!emailCode.trim()) { setError('请输入邮箱验证码'); return; }
        const result = await registerWithEmail({
          email: username.trim(),
          code: emailCode.trim(),
          password,
          confirmPassword,
          nickname: nickname.trim() || undefined,
        }, bind);
        if (!result.ok) {
          setError(result.fields?.map(f => f.message).join('；') || result.message);
          return;
        }
        clearUserProfiles();
        applyAccountScope(result.data.account.ownerId);
        publish(result.data.account);
        setNotice('注册成功，本机档案已绑定到该账号');
      } else {
        const result = await loginAccount({ username: username.trim(), password });
        if (!result.ok) {
          setError(result.message);
          return;
        }
        applyAccountScope(result.data.account.ownerId);
        publish(result.data.account);
        setNotice('登录成功，已切换到本人数据空间');
      }
      setPassword('');
      setConfirmPassword('');
      setEmailCode('');
    } finally {
      setBusy(false);
    }
  };

  /** 发送邮箱验证码：60 秒倒计时内不可重发 */
  const sendCode = async () => {
    if (countdown > 0) return;
    if (!emailOk) { setError('请先填写正确的邮箱地址'); return; }
    setError('');
    try {
      const result = await sendEmailCode(username.trim());
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setNotice('验证码已发送到邮箱，10 分钟内有效');
      setCountdown(60);
    } catch {
      setError('网络异常，请稍后重试');
    }
  };

  useEffect(() => {
    if (countdown <= 0) return;
    const t = window.setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => window.clearTimeout(t);
  }, [countdown]);

  const signOut = async () => {
    setBusy(true);
    try {
      await logoutAccount();
      applyAccountScope(null);
      publish(null);
      setNotice('已登出，账号数据已不可访问');
    } finally {
      setBusy(false);
    }
  };

  // iOS 系统色：由主题令牌驱动
  const bg = 'var(--bg-card)';
  const border = 'var(--bdr)';
  const labelClr = 'var(--tx-2)';
  const inputBg = 'var(--bg-2)';
  const inputBorder = 'transparent';
  const inputClr = 'var(--tx-0)';
  const goldText = 'var(--ac-dim)';
  const hintClr = 'var(--tx-3)';

  const inputStyle: React.CSSProperties = {
    background: inputBg, border: `1px solid ${inputBorder}`, color: inputClr,
    borderRadius: '12px', padding: '9px 12px', fontSize: '12px', width: '100%',
    boxSizing: 'border-box', outline: 'none',
  };
  const buttonStyle: React.CSSProperties = {
    padding: '10px 16px', borderRadius: 'var(--r-sm)', fontSize: '14px', fontWeight: 600,
    border: 'none', cursor: busy ? 'not-allowed' : 'pointer',
    background: 'var(--ac)', color: 'var(--btn-fg)', opacity: busy ? 0.6 : 1,
    boxShadow: isDark ? 'none' : '0 2px 8px rgba(168,127,18,0.18)',
  };

  return (
    <section
      style={embedded
        ? { padding: '4px 0 0' }
        : { background: bg, border: `1px solid ${border}`, borderRadius: '20px', padding: '18px 20px', marginBottom: '16px' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <h3 className="ios-section-title" style={{ color: goldText, margin: 0 }}>
          账号与数据归属
        </h3>
        {account && (
          <button type="button" onClick={signOut} disabled={busy}
            style={{ ...buttonStyle, background: 'transparent', color: goldText, border: `1px solid ${border}`, padding: '5px 12px' }}>
            登出
          </button>
        )}
      </div>

      {account ? (
        <div>
          <p style={{ color: inputClr, fontSize: '13px', margin: '0 0 6px' }}>
            已登录：{account.nickname}（{account.username}）
          </p>
          <p style={{ color: hintClr, fontSize: '11px', margin: 0, lineHeight: 1.6 }}>
            本次及后续保存的档案、生辰与解读对话归属该账号，仅本人登录后可见、可改；其他账号、未登录或越权请求一律被拒绝。
          </p>
        </div>
      ) : (
        <form onSubmit={submit}>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            {(['register', 'login'] as const).map(m => (
              <button key={m} type="button" onClick={() => { setMode(m); setError(''); setNotice(''); }}
                style={{ ...buttonStyle, flex: 1,
                  background: mode === m ? 'var(--ac-bg)' : 'transparent',
                  color: mode === m ? goldText : hintClr,
                  boxShadow: 'none',
                  border: `1px solid ${mode === m ? 'var(--ac-bdr)' : border}` }}>
                {m === 'register' ? '注册账号' : '已有账号登录'}
              </button>
            ))}
          </div>

          <label style={{ color: labelClr, fontSize: '11px', display: 'block', marginBottom: '8px' }}>
            邮箱
            <input style={{ ...inputStyle, marginTop: '4px' }} value={username}
              onChange={e => setUsername(e.target.value)} placeholder="用于登录与接收验证码" autoComplete="username" />
          </label>

          {mode === 'register' && (
            <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
              <label style={{ color: labelClr, fontSize: '11px', flex: 1 }}>
                邮箱验证码
                <input style={{ ...inputStyle, marginTop: '4px' }} value={emailCode}
                  onChange={e => setEmailCode(e.target.value)} placeholder="6 位数字" inputMode="numeric" />
              </label>
              <button type="button" onClick={sendCode} disabled={countdown > 0 || busy}
                style={{ ...buttonStyle, alignSelf: 'flex-end', background: 'transparent',
                  color: goldText, border: `1px solid ${border}`, padding: '9px 12px', fontSize: '12px',
                  opacity: countdown > 0 ? 0.5 : 1 }}>
                {countdown > 0 ? `${countdown}s 后重发` : '发送验证码'}
              </button>
            </div>
          )}

          {mode === 'register' && (
            <p style={{ color: hintClr, fontSize: '10px', lineHeight: 1.5, margin: '0 0 10px' }}>
              收不到验证码时，请检查邮箱的「垃圾邮件 / 订阅邮件」文件夹。
            </p>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
            <label style={{ color: labelClr, fontSize: '11px' }}>
              昵称（可选）
              <input style={{ ...inputStyle, marginTop: '4px' }} value={nickname}
                onChange={e => setNickname(e.target.value)} placeholder="展示用名称" disabled={mode === 'login'} />
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: mode === 'register' ? '1fr 1fr' : '1fr', gap: '8px', marginBottom: '10px' }}>
            <label style={{ color: labelClr, fontSize: '11px' }}>
              密码
              <input type="password" style={{ ...inputStyle, marginTop: '4px' }} value={password}
                onChange={e => setPassword(e.target.value)} placeholder="8–64 位，含字母与数字"
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />
            </label>
            {mode === 'register' && (
              <label style={{ color: labelClr, fontSize: '11px' }}>
                确认密码
                <input type="password" style={{ ...inputStyle, marginTop: '4px' }} value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)} placeholder="再次输入密码"
                  autoComplete="new-password" />
              </label>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button type="submit" disabled={busy} style={buttonStyle}>
              {busy ? '处理中…' : mode === 'register' ? '注册' : '登录'}
            </button>
          </div>
        </form>
      )}

      {error && <p style={{ color: '#dc2626', fontSize: '11px', margin: '10px 0 0' }}>✕ {error}</p>}
      {notice && <p style={{ color: goldText, fontSize: '11px', margin: '10px 0 0' }}>✓ {notice}</p>}

      {billing && (
        <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: `1px solid ${border}` }}>
          <p style={{ color: inputClr, fontSize: '13px', margin: '0 0 6px' }}>
            解读额度：免费剩 {billing.freeLeft}/{billing.freeLimit} 次 · 卡密剩 {billing.credits} 次
          </p>
          {!account && (
            <p style={{ color: hintClr, fontSize: '11px', margin: '0 0 8px' }}>
              注册 / 登录后才能兑换卡密（次数绑定到账号，换设备登录仍有效）。
            </p>
          )}
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              value={cardCode}
              onChange={e => setCardCode(e.target.value)}
              placeholder="输入卡密，如 ZW-XXXX-XXXX-XXXX"
              style={{ ...inputStyle, flex: 1 }}
              disabled={cardBusy}
            />
            <button type="button" onClick={redeem} disabled={cardBusy || !account}
              style={{ ...buttonStyle, padding: '9px 14px', fontSize: '12px', opacity: cardBusy || !account ? 0.5 : 1 }}>
              {cardBusy ? '兑换中…' : '兑换'}
            </button>
          </div>
          {cardMsg && (
            <p style={{ color: cardMsg.startsWith('兑换成功') ? inputClr : '#FF9500', fontSize: '11px', margin: '6px 0 0' }}>
              {cardMsg}
            </p>
          )}
          <p style={{ color: hintClr, fontSize: '11px', margin: '6px 0 0' }}>
            每次 AI 解读 / 合盘分析消耗 1 次：先用完累计 3 次免费额度，之后自动扣卡密次数。
            次数不足时向维护者购买卡密，在上方输入即可到账。
          </p>
        </div>
      )}
    </section>
  );
}
