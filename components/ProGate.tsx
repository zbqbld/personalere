'use client';
/**
 * 等级门禁的通用 UI：锁定角标、升级弹窗、本地模拟开通按钮
 *
 * 设计约束（来自本项目此前的实测教训）：
 * 锁定的入口必须给明确说明，**不允许静默失效**——用户点了要有反应，
 * 告诉他为什么不能用、怎样才能用。
 */
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FEATURES, PRO_PRICE, type FeatureKey, type Plan } from '@/lib/membership/plan';
import { loadMembership, setPlan, subscribePlan, membershipMode } from '@/lib/membership/store';

/** 锁图标（纯 SVG，不引图标库） */
export function LockIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" style={{ display: 'inline-block' }}>
      <rect x="2" y="5.2" width="8" height="5.8" rx="1.2" fill="currentColor" opacity="0.85" />
      <path d="M4 5.2V3.8a2 2 0 0 1 4 0v1.4" stroke="currentColor" strokeWidth="1.1" fill="none" />
    </svg>
  );
}

export interface UpgradeDialogProps {
  open: boolean;
  feature: FeatureKey | null;
  onClose: () => void;
  onUpgraded?: () => void;
}

/** 升级弹窗：说明缺什么 + 价格 + 本地模拟开通 */
export function UpgradeDialog({ open, feature, onClose, onUpgraded }: UpgradeDialogProps) {
  const meta = feature ? FEATURES[feature] : null;
  const mode = membershipMode();

  const upgrade = () => {
    if (setPlan('pro')) {
      onUpgraded?.();
      onClose();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="zw-gate-mask"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="zw-gate-card"
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.2 }}
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="升级专业版"
          >
            <div className="zw-gate-eyebrow">专业版功能</div>
            <h3 className="zw-gate-title">{meta?.label ?? '专业版功能'}</h3>
            <p className="zw-gate-hint">{meta?.hint ?? '该功能需要专业版。'}</p>

            <div className="zw-gate-price">
              <span className="zw-gate-price-num">¥{PRO_PRICE.cny}</span>
              <span className="zw-gate-price-was">¥{PRO_PRICE.original}</span>
              <span className="zw-gate-price-note">{PRO_PRICE.note}</span>
            </div>

            {mode === 'off' ? (
              <p className="zw-gate-note">当前已关闭会员限制，所有功能可用。</p>
            ) : (
              <>
                <div className="zw-gate-actions">
                  <button type="button" className="zw-gate-cancel" onClick={onClose}>稍后</button>
                  <button type="button" className="zw-gate-upgrade" onClick={upgrade}>
                    本地模拟开通
                  </button>
                </div>
                <p className="zw-gate-note">
                  当前为{mode === 'real' ? '服务端' : '本地模拟'}模式，未接入真实支付。
                  「本地模拟开通」会把本机等级记为专业版，用于完整验证功能；可在
                  <a href="/pro" className="zw-gate-link">专业版页面</a>随时取消。
                </p>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** 读取等级 + 订阅变更的 hook */
export function useMembership(): { plan: Plan; reload: () => void } {
  const [plan, setLocalPlan] = useState<Plan>('free');
  const reload = () => setLocalPlan(loadMembership().plan);
  useEffect(() => {
    reload();
    return subscribePlan(reload);
  }, []);
  return { plan, reload };
}
