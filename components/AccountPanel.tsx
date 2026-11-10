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
  registerAccount,
  type AccountInfo,
} from '@/lib/account/client';
import { clearUserProfiles, listUserProfiles } from '@/lib/ziwei/user-profiles';

interface AccountPanelProps {
  onAccountChange?: (ownerId: string | null) => void;
}

export default function AccountPanel({ onAccountChange }: AccountPanelProps) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let alive = true;
    loadAccount().then(a => {
      if (!alive) return;
      setAccount(a);
      onAccountChange?.(a?.ownerId ?? null);
      if (!a) applyAccountScope(null);
    });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const publish = (a: AccountInfo | null) => {
    setAccount(a);
    onAccountChange?.(a?.ownerId ?? null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    if (!username.trim() || !password) {
      setError('请输入账号与密码');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'register') {
        // 必须在切换命名空间之前读取并清除本机匿名档案
        const bind = listUserProfiles().map(p => ({ userId: p.userId, form: p.form }));
        const result = await registerAccount({
          username: username.trim(),
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
        setNotice(`注册成功，已将本机 ${result.data.bound} 条档案绑定到该账号`);
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
    } finally {
      setBusy(false);
    }
  };

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
    background: 'var(--ac)', color: '#FFFFFF', opacity: busy ? 0.6 : 1,
    boxShadow: isDark ? 'none' : '0 2px 8px rgba(0,122,255,0.18)',
  };

  return (
    <section style={{ background: bg, border: `1px solid ${border}`, borderRadius: '20px', padding: '18px 20px', marginBottom: '16px' }}>
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
              <button key={m} type="button" onClick={() => { setMode(m); setError(''); }}
                style={{ ...buttonStyle, flex: 1,
                  background: mode === m ? 'var(--ac-bg)' : 'transparent',
                  color: mode === m ? goldText : hintClr,
                  boxShadow: 'none',
                  border: `1px solid ${mode === m ? 'var(--ac-bdr)' : border}` }}>
                {m === 'register' ? '注册账号' : '已有账号登录'}
              </button>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
            <label style={{ color: labelClr, fontSize: '11px' }}>
              账号
              <input style={{ ...inputStyle, marginTop: '4px' }} value={username}
                onChange={e => setUsername(e.target.value)} placeholder="2–32 位中英文 / 数字" autoComplete="username" />
            </label>
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
              {busy ? '处理中…' : mode === 'register' ? '注册并绑定本机档案' : '登录'}
            </button>
            <span style={{ color: hintClr, fontSize: '10px', lineHeight: 1.5 }}>
              不注册也可继续匿名起盘，数据仅存本机
            </span>
          </div>
        </form>
      )}

      {error && <p style={{ color: '#dc2626', fontSize: '11px', margin: '10px 0 0' }}>✕ {error}</p>}
      {notice && <p style={{ color: goldText, fontSize: '11px', margin: '10px 0 0' }}>✓ {notice}</p>}
    </section>
  );
}
