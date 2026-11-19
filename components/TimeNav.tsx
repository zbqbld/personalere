'use client';
import { motion } from 'framer-motion';
import { STEMS, SI_HUA_TABLE } from '@/lib/ziwei/constants';
import type { ZiweiChart } from '@/lib/ziwei/types';
import type { Plan, FeatureKey, TimeDim } from '@/lib/membership/plan';
import { canUseTimeDim } from '@/lib/membership/plan';
import TimeDimensionPanel from './TimeDimensionPanel';
import { LockIcon } from './ProGate';

/** 时间维度视图：基础三视图 + 小限 + 流月/流日/流时 */
export type TimeView = TimeDim;

interface TimeNavProps {
  chart: ZiweiChart;
  view: TimeView;
  liunianYear: number;
  onViewChange: (view: TimeView) => void;
  onYearChange: (year: number) => void;
  /** 会员等级：用于时间维度锁定 */
  plan: Plan;
  /** 流月/流日/流时当前选择 */
  liunianMonth: number;
  liunianDay: number;
  liunianHour: number;
  onMonthChange: (m: number) => void;
  onDayChange: (d: number) => void;
  onHourChange: (h: number) => void;
  /** 点锁定维度时的回调（弹升级说明，不静默失效） */
  onLocked: (key: FeatureKey) => void;
}

/** 由年份计算天干索引 (0-9) */
export function getYearStemIndex(year: number): number {
  return ((year - 4) % 10 + 10) % 10;
}

/** 根据天干索引返回四化映射：starName → SiHua */
export function buildSiHuaOverlay(stemIndex: number): Record<string, string> {
  const stars = SI_HUA_TABLE[stemIndex];
  if (!stars) return {};
  return {
    [stars[0]]: '禄',
    [stars[1]]: '权',
    [stars[2]]: '科',
    [stars[3]]: '忌',
  };
}

const SIHUA_COLORS: Record<string, string> = {
  '禄': '#4ade80',
  '权': '#60a5fa',
  '科': '#facc15',
  '忌': '#f87171',
};

export default function TimeNav({
  chart,
  view,
  liunianYear,
  onViewChange,
  onYearChange,
  plan,
  liunianMonth,
  liunianDay,
  liunianHour,
  onMonthChange,
  onDayChange,
  onHourChange,
  onLocked,
}: TimeNavProps) {
  const currentDx = chart.daXians[chart.currentDaXianIndex];

  // 计算当前叠加四化信息
  const getOverlayInfo = (): { stemName: string; overlay: Record<string, string> } | null => {
    if (view === 'mingpan') return null;

    if (view === 'daxian' && currentDx) {
      const dxPalace = chart.palaces.find(p => p.branch === currentDx.palaceBranch);
      if (!dxPalace) return null;
      const stemIndex = dxPalace.stem;
      return {
        stemName: STEMS[stemIndex],
        overlay: buildSiHuaOverlay(stemIndex),
      };
    }

    if (view === 'liunian') {
      const stemIndex = getYearStemIndex(liunianYear);
      return {
        stemName: STEMS[stemIndex],
        overlay: buildSiHuaOverlay(stemIndex),
      };
    }

    return null;
  };

  const overlayInfo = getOverlayInfo();

  return (
    <div className="mb-3">
      {/* Tab 行：7 个时间维度，窄屏横向滚动 */}
      <div
        className="flex items-center rounded-xl p-1 gap-1"
        style={{ background: 'var(--t-surface)', border: '1px solid var(--t-border)', overflowX: 'auto', scrollbarWidth: 'none' }}
      >
        {/* 本命 */}
        <TabButton
          active={view === 'mingpan'}
          onClick={() => onViewChange('mingpan')}
        >
          本命
        </TabButton>

        {/* 大限 */}
        <TabButton
          active={view === 'daxian'}
          onClick={() => onViewChange('daxian')}
        >
          {currentDx ? `大限 ${currentDx.startAge}–${currentDx.endAge}` : '大限'}
        </TabButton>

        {/* 流年 — 含年份切换 */}
        <div
          className="relative flex-1 flex items-center justify-center rounded-lg py-1.5 gap-1 transition-all duration-200"
          style={{
            background: view === 'liunian'
              ? 'rgba(212,168,67,0.12)'
              : 'transparent',
            border: view === 'liunian'
              ? '1px solid rgba(212,168,67,0.25)'
              : '1px solid transparent',
          }}
        >
          <button
            onClick={() => onViewChange('liunian')}
            className="text-[10px] font-medium flex-1 text-center"
            style={{ color: view === 'liunian' ? 'var(--t-gold)' : 'var(--t-faint)' }}
          >
            流年
          </button>
          {/* 年份 +/- */}
          <div className="flex items-center gap-0.5">
            <button
              onClick={e => { e.stopPropagation(); onYearChange(liunianYear - 1); if (view !== 'liunian') onViewChange('liunian'); }}
              className="text-[9px] w-4 h-4 flex items-center justify-center rounded"
              style={{ color: 'var(--t-faint)' }}
            >
              ‹
            </button>
            <span
              className="text-[10px] font-mono min-w-[28px] text-center cursor-pointer"
              style={{ color: view === 'liunian' ? 'var(--t-gold)' : 'var(--t-faint)' }}
              onClick={() => onViewChange('liunian')}
            >
              {liunianYear}
            </span>
            <button
              onClick={e => { e.stopPropagation(); onYearChange(liunianYear + 1); if (view !== 'liunian') onViewChange('liunian'); }}
              className="text-[9px] w-4 h-4 flex items-center justify-center rounded"
              style={{ color: 'var(--t-faint)' }}
            >
              ›
            </button>
          </div>
        </div>

        {/* 小限（免费）：一年一宫，男顺女逆 */}
        <TabButton
          active={view === 'xiaoxian'}
          onClick={() => onViewChange('xiaoxian')}
        >
          小限
        </TabButton>

        {/* 流月 / 流日 / 流时：专业版功能，锁定时点击给说明 */}
        <TabButton
          active={view === 'liuyue'}
          locked={!canUseTimeDim(plan, 'liuyue')}
          onClick={() => {
            if (!canUseTimeDim(plan, 'liuyue')) { onLocked('time.liuyue'); return; }
            onViewChange('liuyue');
          }}
        >
          流月
        </TabButton>
        <TabButton
          active={view === 'liuri'}
          locked={!canUseTimeDim(plan, 'liuri')}
          onClick={() => {
            if (!canUseTimeDim(plan, 'liuri')) { onLocked('time.liuri'); return; }
            onViewChange('liuri');
          }}
        >
          流日
        </TabButton>
        <TabButton
          active={view === 'liushi'}
          locked={!canUseTimeDim(plan, 'liushi')}
          onClick={() => {
            if (!canUseTimeDim(plan, 'liushi')) { onLocked('time.liushi'); return; }
            onViewChange('liushi');
          }}
        >
          流时
        </TabButton>
      </div>

      {/* 叠加四化说明行 */}
      {overlayInfo && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="flex items-center gap-2 mt-1.5 px-1 flex-wrap"
        >
          <span className="text-[9px]" style={{ color: 'var(--t-faint)' }}>
            {view === 'daxian' ? '大限' : `${liunianYear}`}·{overlayInfo.stemName}年四化：
          </span>
          {(['禄', '权', '科', '忌'] as const).map(sh => {
            const starName = Object.keys(overlayInfo.overlay).find(k => overlayInfo.overlay[k] === sh);
            if (!starName) return null;
            return (
              <span key={sh} className="text-[9px] font-medium" style={{ color: SIHUA_COLORS[sh] }}>
                {starName}化{sh}
              </span>
            );
          })}
        </motion.div>
      )}
      {/* 五层时间胶囊面板：大限 / 流年 / 流月 / 流日 / 流时 */}
      <TimeDimensionPanel
        chart={chart}
        plan={plan}
        view={view}
        liunianYear={liunianYear}
        liunianMonth={liunianMonth}
        liunianDay={liunianDay}
        liunianHour={liunianHour}
        onViewChange={onViewChange}
        onYearChange={onYearChange}
        onMonthChange={onMonthChange}
        onDayChange={onDayChange}
        onHourChange={onHourChange}
        onLocked={onLocked}
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  locked = false,
  children,
}: {
  active: boolean;
  onClick: () => void;
  locked?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-disabled={locked || undefined}
      className={`flex-1 py-1.5 text-[10px] font-medium rounded-lg transition-all duration-200${locked ? ' zw-dim-locked' : ''}`}
      style={{
        background: active ? 'rgba(212,168,67,0.12)' : 'transparent',
        color: active ? 'var(--t-gold)' : 'var(--t-faint)',
        border: active ? '1px solid rgba(212,168,67,0.25)' : '1px solid transparent',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
      {locked && <span className="zw-timenav-lock"><LockIcon size={8} /></span>}
    </button>
  );
}
