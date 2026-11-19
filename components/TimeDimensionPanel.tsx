'use client';
/**
 * 时间维度胶囊面板（对齐参考站 Ouranic 的五层钻取形态）
 *
 * 五组：大限(绿) / 流年(蓝) / 流月(橙) / 流日(紫) / 流时(青)
 * 非会籍时后三组仍展示但带锁，点击走 onLocked，**不静默失效**。
 */
import { motion } from 'framer-motion';
import type { ZiweiChart } from '@/lib/ziwei/types';
import { STEMS } from '@/lib/ziwei/constants';
import type { Plan, FeatureKey } from '@/lib/membership/plan';
import { canUseTimeDim, type TimeDim } from '@/lib/membership/plan';
import { getYearStemIndex } from './TimeNav';
import {
  buildLiuYue, buildLiuRi, buildLiuShi,
  nominalAge, palaceNameAt, ZHI_NAMES, daysInMonth,
} from '@/lib/ziwei/time-dims';
import { LockIcon } from './ProGate';

export interface TimeDimensionPanelProps {
  chart: ZiweiChart;
  plan: Plan;
  view: TimeDim;
  liunianYear: number;
  liunianMonth: number;
  liunianDay: number;
  liunianHour: number;
  onViewChange: (v: TimeDim) => void;
  onYearChange: (y: number) => void;
  onMonthChange: (m: number) => void;
  onDayChange: (d: number) => void;
  onHourChange: (h: number) => void;
  onLocked: (key: FeatureKey) => void;
}

const LIUNIAN_SPAN = 4; // 当前年前后各 4 年，共 9 枚

export default function TimeDimensionPanel({
  chart, plan, view, liunianYear, liunianMonth, liunianDay, liunianHour,
  onViewChange, onYearChange, onMonthChange, onDayChange, onHourChange, onLocked,
}: TimeDimensionPanelProps) {
  const mingBranch = chart.mingGongBranch;
  const yearStemIndex = getYearStemIndex(liunianYear);
  const yearBranch = ((liunianYear - 4) % 12 + 12) % 12;

  const canMonth = canUseTimeDim(plan, 'liuyue');
  const canDay = canUseTimeDim(plan, 'liuri');
  const canHour = canUseTimeDim(plan, 'liushi');

  const liuYue = buildLiuYue(yearBranch, yearStemIndex);
  const monthBranch = liuYue[liunianMonth - 1]?.branch ?? yearBranch;
  const liuRi = buildLiuRi(monthBranch, liunianYear, Math.min(12, Math.max(1, liunianMonth)));
  // 流日胶囊按「农历式日名」展示，但月份天数取公历（近似，界面上已标注）
  const dayTotal = daysInMonth(liunianYear, Math.min(12, Math.max(1, liunianMonth)));
  const liuShi = buildLiuShi(liuRi[Math.min(liunianDay, dayTotal) - 1]?.branch ?? monthBranch);

  /** 统一的胶囊渲染 */
  const pill = (
    opts: {
      active: boolean;
      locked?: boolean;
      main: React.ReactNode;
      sub?: React.ReactNode;
      onClick: () => void;
      title?: string;
    },
  ) => (
    <button
      type="button"
      className={`zw-timepill${opts.active ? ' is-active' : ''}${opts.locked ? ' is-locked' : ''}`}
      onClick={opts.onClick}
      title={opts.title}
    >
      <span className="zw-timepill-main">
        {opts.main}
        {opts.locked && <span className="zw-timepill-lock"><LockIcon size={9} /></span>}
      </span>
      {opts.sub && <span className="zw-timepill-sub">{opts.sub}</span>}
    </button>
  );

  return (
    <motion.div
      className="zw-timepanel"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      transition={{ duration: 0.22 }}
    >
      {/* 大限（绿） */}
      <section className="zw-timegroup" data-dim="daxian">
        <div className="zw-timegroup-head">
          <span className="zw-timegroup-name">大限</span>
          <span className="zw-timegroup-hint">绿色为所选大限 · 点击切换</span>
        </div>
        <div className="zw-timeline-row">
          {chart.daXians.map((dx, i) => {
            const isActive = view === 'daxian' && i === chart.currentDaXianIndex;
            return pill({
              active: isActive,
              main: `${dx.startAge}~${dx.endAge}岁`,
              sub: `${dx.stemName ?? ''}${ZHI_NAMES[dx.palaceBranch]} ${dx.palaceName}`,
              title: `第 ${dx.startAge}–${dx.endAge} 岁大限`,
              onClick: () => onViewChange('daxian'),
            });
          })}
        </div>
      </section>

      {/* 流年（蓝） */}
      <section className="zw-timegroup" data-dim="liunian">
        <div className="zw-timegroup-head">
          <span className="zw-timegroup-name">流年</span>
          <span className="zw-timegroup-hint">蓝色为所选流年 · 点击任一年切换</span>
        </div>
        <div className="zw-timeline-row">
          {Array.from({ length: LIUNIAN_SPAN * 2 + 1 }, (_, i) => liunianYear - LIUNIAN_SPAN + i).map(y => {
            const stem = STEMS[getYearStemIndex(y)];
            const branch = ((y - 4) % 12 + 12) % 12;
            const age = nominalAge(chart.birthInfo.year, y);
            return pill({
              active: view === 'liunian' && y === liunianYear,
              main: String(y),
              sub: `${age}岁 ${stem}${ZHI_NAMES[branch]}`,
              onClick: () => { onViewChange('liunian'); onYearChange(y); },
            });
          })}
        </div>
      </section>

      {/* 流月（橙） */}
      <section className="zw-timegroup" data-dim="liuyue">
        <div className="zw-timegroup-head">
          <span className="zw-timegroup-name">流月</span>
          <span className="zw-timegroup-hint">
            {canMonth ? '精细到每月 · 点击切换' : '专业版功能 · 点击查看说明'}
          </span>
        </div>
        <div className="zw-timeline-row">
          {liuYue.map(item => pill({
            active: view === 'liuyue' && liunianMonth === item.month,
            locked: !canMonth,
            main: item.label,
            sub: `${STEMS[item.stemIndex]}${item.zhiName} ${palaceNameAt(mingBranch, item.branch)}`,
            onClick: () => {
              if (!canMonth) { onLocked('time.liuyue'); return; }
              onMonthChange(item.month);
              onViewChange('liuyue');
            },
          }))}
        </div>
      </section>

      {/* 流日（紫） */}
      <section className="zw-timegroup" data-dim="liuri">
        <div className="zw-timegroup-head">
          <span className="zw-timegroup-name">流日</span>
          <span className="zw-timegroup-hint">
            {canDay ? '精细到每天 · 点击切换' : '专业版功能 · 点击查看说明'}
          </span>
        </div>
        <div className="zw-timeline-row">
          {liuRi.map(item => pill({
            active: view === 'liuri' && liunianDay === item.day,
            locked: !canDay,
            main: item.label,
            sub: `${item.zhiName} ${palaceNameAt(mingBranch, item.branch)}`,
            onClick: () => {
              if (!canDay) { onLocked('time.liuri'); return; }
              onDayChange(item.day);
              onViewChange('liuri');
            },
          }))}
        </div>
      </section>

      {/* 流时（青） */}
      <section className="zw-timegroup" data-dim="liushi">
        <div className="zw-timegroup-head">
          <span className="zw-timegroup-name">流时</span>
          <span className="zw-timegroup-hint">
            {canHour ? '精细到时辰 · 点击切换' : '专业版功能 · 点击查看说明'}
          </span>
        </div>
        <div className="zw-timeline-row">
          {liuShi.map(item => pill({
            active: view === 'liushi' && liunianHour === item.hourIndex,
            locked: !canHour,
            main: item.label,
            sub: `${item.zhiName} ${palaceNameAt(mingBranch, item.branch)}`,
            onClick: () => {
              if (!canHour) { onLocked('time.liushi'); return; }
              onHourChange(item.hourIndex);
              onViewChange('liushi');
            },
          }))}
        </div>
      </section>

      <p className="zw-timegroup-hint" style={{ marginTop: 2, opacity: .7 }}>
        流月/流日/流时采用常见简化口径，与传统斗君法可能不同；正式解读前需核对古籍。
      </p>
    </motion.div>
  );
}
