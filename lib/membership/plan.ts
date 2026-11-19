/**
 * 会员等级与功能矩阵
 *
 * 现状：本站原本只有「卡密次数制」计次（免费 3 次 + 卡密次数），没有等级概念。
 * 参考站 Ouranic 的分层（实测）为：
 *   - 免费：命盘 / 大限 / 流年 / 小限、核心六维分析、无 AI 追问
 *   - 专业版（¥159 买断）：流月 / 流日 / 流时、十三宫全维分析、每周 140 次 AI
 *
 * 本项目据此推断出受控功能点，并保持一条硬约束：
 *   「原有功能对免费用户不降级」——只对**新增**能力设等级限制。
 *   因此本命 / 大限 / 流年 / 六维分析 / 卡密计次全部维持原样，
 *   流月 / 流日 / 流时 / 十三宫全维 / PRO 周额度为新增能力。
 */

export type Plan = 'free' | 'pro';

/** 受控功能点（新增能力才有等级要求） */
export type FeatureKey =
  | 'time.liuyue'
  | 'time.liuri'
  | 'time.liushi'
  | 'analysis.full13'
  | 'ai.proQuota';

export interface FeatureMeta {
  key: FeatureKey;
  /** 界面展示名 */
  label: string;
  /** 锁定时的说明（告诉用户升了什么才能用） */
  hint: string;
}

export const FEATURES: Record<FeatureKey, FeatureMeta> = {
  'time.liuyue': {
    key: 'time.liuyue',
    label: '流月排盘',
    hint: '专业版按月份切换流月盘，精细到每月运势。',
  },
  'time.liuri': {
    key: 'time.liuri',
    label: '流日排盘',
    hint: '专业版按日切换流日盘，可用于择日参考。',
  },
  'time.liushi': {
    key: 'time.liushi',
    label: '流时排盘',
    hint: '专业版按时辰切换流时盘，精确到时辰。',
  },
  'analysis.full13': {
    key: 'analysis.full13',
    label: '十三宫全维分析',
    hint: '免费版开放核心六维（命格/财运/事业/感情/性格/健康），专业版开放全部宫位。',
  },
  'ai.proQuota': {
    key: 'ai.proQuota',
    label: '每周 140 次解读',
    hint: '专业版每周 140 次解读额度，不消耗卡密次数。',
  },
};

/** 免费可用；其余需 PRO */
export const FREE_FEATURES: readonly FeatureKey[] = [];

const PRO_ONLY: readonly FeatureKey[] = Object.keys(FEATURES) as FeatureKey[];

export function hasFeature(plan: Plan, key: FeatureKey): boolean {
  if (plan === 'pro') return true;
  if (FREE_FEATURES.includes(key)) return true;
  return !PRO_ONLY.includes(key);
}

/** 时间维度视图的等级要求；小限等基础维度免费（与参考站一致） */
export type TimeDim = 'mingpan' | 'daxian' | 'liunian' | 'xiaoxian' | 'liuyue' | 'liuri' | 'liushi';

export const TIME_DIM_FEATURE: Partial<Record<TimeDim, FeatureKey>> = {
  liuyue: 'time.liuyue',
  liuri: 'time.liuri',
  liushi: 'time.liushi',
};

export function canUseTimeDim(plan: Plan, dim: TimeDim): boolean {
  const f = TIME_DIM_FEATURE[dim];
  return f ? hasFeature(plan, f) : true;
}

/** PRO 每周追问额度（与参考站一致） */
export const PRO_WEEKLY_QUOTA = 140;

/** 价格（本地模拟展示用；真实支付未接入） */
export const PRO_PRICE = {
  cny: 159,
  original: 168,
  note: '一次性支付，永久有效',
} as const;
