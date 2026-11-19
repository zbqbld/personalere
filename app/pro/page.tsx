'use client';
/**
 * 专业版页面
 *
 * 本地模拟实现（未接真实支付）：
 *  - 两栏对比（PRO / FREE）+ 功能矩阵，对齐参考站的信息层级；
 *  - 「开通」写入本机等级，「取消」还原为免费，用于完整验证两套权限；
 *  - 显示当前模式（off / simulate / real）与 PRO 周额度状态，避免误以为已付费。
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { FEATURES, PRO_PRICE, PRO_WEEKLY_QUOTA, type FeatureKey, type Plan } from '@/lib/membership/plan';
import {
  loadMembership, setPlan, subscribePlan, membershipMode,
  proQuotaLeft, resetProQuota, MEMBERSHIP_MODE_LABEL,
} from '@/lib/membership/store';

interface Row {
  label: string;
  free: string;
  pro: string;
}

const MATRIX: Row[] = [
  { label: '排盘层次', free: '本命 · 大限 · 流年 · 小限', pro: '再加流月 · 流日 · 流时' },
  { label: '解读范围', free: '核心六维（命格/财运/事业/感情/性格/健康）', pro: '十三宫全维开放' },
  { label: '解读额度', free: '免费 3 次，之后用卡密次数', pro: `每周 ${PRO_WEEKLY_QUOTA} 次，不消耗卡密` },
  { label: '格局识别', free: '古籍格表自动识别', pro: '同左（不另行收费）' },
  { label: '数据归属', free: '本机保存 / 可绑定账号', pro: '同左（不另行收费）' },
];

const PRO_LIST: FeatureKey[] = ['time.liuyue', 'time.liuri', 'time.liushi', 'analysis.full13', 'ai.proQuota'];

export default function ProPage() {
  const [plan, setPl] = useState<Plan>('free');
  const [mode, setMode] = useState(membershipMode());
  const [left, setLeft] = useState(0);
  const [flash, setFlash] = useState('');

  const refresh = () => {
    setPl(loadMembership().plan);
    setMode(membershipMode());
    setLeft(proQuotaLeft());
  };
  useEffect(() => {
    refresh();
    return subscribePlan(refresh);
  }, []);

  const toggle = () => {
    const next: Plan = plan === 'pro' ? 'free' : 'pro';
    if (!setPlan(next)) {
      setFlash('当前模式不允许在本地切换等级。');
      window.setTimeout(() => setFlash(''), 2600);
      return;
    }
    setFlash(next === 'pro' ? '已开通（本地模拟）。所有专业版功能现在可用。' : '已取消专业版，还原为免费等级。');
    window.setTimeout(() => setFlash(''), 2600);
  };

  return (
    <>
      <header className="zw-pro-head">
        <Link href="/chart" className="zw-pro-back">
          <span aria-hidden="true">‹</span>
          <span>返回命盘</span>
        </Link>
        <div className="zw-pro-head-sep" />
        <span className="zw-pro-brand">紫微命盘</span>
        <span className={`zw-pro-plan ${plan === 'pro' ? 'is-pro' : ''}`}>
          当前：{plan === 'pro' ? '专业版' : '免费版'}
        </span>
      </header>

      <main className="zw-pro-main">
        <div className="zw-pro-hero">
          <h1 className="zw-pro-title">升级专业版，读盘更完整</h1>
          <p className="zw-pro-sub">免费入门体验 · 专业版解锁完整研读</p>
          <p className="zw-pro-mode">{MEMBERSHIP_MODE_LABEL[mode]}　·　未接入真实支付，本页用于本地验证</p>
        </div>

        {flash && <div className="zw-pro-flash" role="status">{flash}</div>}

        <div className="zw-pro-grid">
          {/* PRO */}
          <section className={`zw-pro-card ${plan === 'pro' ? 'is-active' : ''}`} aria-labelledby="pro-card-title">
            <div className="zw-pro-kicker">PRO</div>
            <h2 id="pro-card-title" className="zw-pro-card-title">适合完整研读与随身问盘</h2>
            <div className="zw-pro-price">
              <span className="zw-pro-price-num">¥{PRO_PRICE.cny}</span>
              <span className="zw-pro-price-was">¥{PRO_PRICE.original}</span>
            </div>
            <p className="zw-pro-price-note">{PRO_PRICE.note}</p>

            <dl className="zw-pro-facts">
              <div><dt>解读范围</dt><dd>十三宫全开</dd></div>
              <div><dt>排盘层次</dt><dd>到流月/流日/流时</dd></div>
              <div><dt>解读额度</dt><dd>每周 {PRO_WEEKLY_QUOTA} 次</dd></div>
            </dl>

            <button
              type="button"
              className={`zw-pro-cta ${plan === 'pro' ? 'is-ghost' : ''}`}
              onClick={toggle}
            >
              {plan === 'pro' ? '取消模拟开通' : '本地模拟开通'}
            </button>

            {plan === 'pro' && (
              <div className="zw-pro-quota">
                本周剩余 {left} / {PRO_WEEKLY_QUOTA} 次
                <button type="button" className="zw-pro-quota-reset" onClick={() => { resetProQuota(); refresh(); }}>
                  重置
                </button>
              </div>
            )}

            <ul className="zw-pro-list">
              {PRO_LIST.map(k => (
                <li key={k}><span className="zw-pro-tick">✓</span>{FEATURES[k].label}</li>
              ))}
              <li><span className="zw-pro-tick">✓</span>古籍格局全表识别</li>
            </ul>
            <p className="zw-pro-disclaimer">当前为本地模拟，不产生任何实际扣费。</p>
          </section>

          {/* FREE */}
          <section className={`zw-pro-card ${plan === 'free' ? 'is-active' : ''}`} aria-labelledby="free-card-title">
            <div className="zw-pro-kicker">FREE</div>
            <h2 id="free-card-title" className="zw-pro-card-title">适合入门排盘与轻度体验</h2>
            <div className="zw-pro-price">
              <span className="zw-pro-price-num">¥0</span>
            </div>
            <p className="zw-pro-price-note">免费使用</p>

            <dl className="zw-pro-facts">
              <div><dt>解读范围</dt><dd>核心六维</dd></div>
              <div><dt>排盘层次</dt><dd>本命 · 大限 · 流年 · 小限</dd></div>
              <div><dt>解读额度</dt><dd>免费 3 次 + 卡密</dd></div>
            </dl>

            <button type="button" className="zw-pro-cta is-ghost" disabled>
              {plan === 'free' ? '当前使用中' : '切换回免费'}
            </button>

            <ul className="zw-pro-list">
              <li><span className="zw-pro-tick">✓</span>核心六维解读</li>
              <li><span className="zw-pro-tick">✓</span>本命 · 大限 · 流年排盘</li>
              <li><span className="zw-pro-tick">✓</span>完整命盘与十二宫</li>
            </ul>
          </section>
        </div>

        {/* 功能矩阵 */}
        <section className="zw-pro-table-wrap">
          <h2 className="zw-pro-table-title">两档对比</h2>
          <table className="zw-pro-table">
            <thead>
              <tr><th scope="col">项目</th><th scope="col">免费版</th><th scope="col">专业版</th></tr>
            </thead>
            <tbody>
              {MATRIX.map(r => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  <td>{r.free}</td>
                  <td className="is-pro-col">{r.pro}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <p className="zw-pro-foot">
          想关闭会员限制（个人自用）：在 <code>.env.local</code> 设置
          <code> NEXT_PUBLIC_MEMBERSHIP_MODE=off</code> 后重启。
        </p>
      </main>
    </>
  );
}
