/**
 * 超越基础三视图的时间维度计算：小限 / 流月 / 流日 / 流时
 *
 * ⚠️ 口径说明（必须核对古籍后再用于正式解读）
 * 这四种维度的起法在流派间有分歧，本文件采用**最常见、可验证的简化口径**，
 * 目的是先把交互与权限链路跑通；盘面语义若要与《全书》完全一致，需逐条核对。
 *
 *   小限：男命 1 岁起命宫顺行，女命 1 岁起命宫逆行，一年一宫（虚岁）。
 *         另有「起于迁移宫」的流派说法，本实现未采用。
 *   流月：以流年太岁宫起正月，顺行一月一宫（简化口径）。
 *         严格斗君法需结合生月与生时（流年支起正月 → 数至生月 → 逆数至生时），
 *         本实现未采用，故与斗君法结果不同。
 *   流日：以流月宫起初一，顺行一日一宫。
 *   流时：以流日宫起子时，顺行一时辰一宫（子时 index 0）。
 *
 * 不含日干支：流日干需要历法换算，本文件不做，避免给出未经验证的干支。
 */

/** 与 BirthInfo.gender 同一口径（types.ts 未单独导出该字面量联合类型） */
type Gender = 'male' | 'female';

/** 十二地支名（0=子 … 11=亥） */
export const ZHI_NAMES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'] as const;

export const MONTH_NAMES = [
  '正月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '冬月', '腊月',
] as const;

export const SHICHEN_LABELS = [
  '子时', '丑时', '寅时', '卯时', '辰时', '巳时',
  '午时', '未时', '申时', '酉时', '戌时', '亥时',
] as const;

const mod12 = (n: number): number => ((n % 12) + 12) % 12;

/**
 * 虚岁：按公历年差 +1（农历跨年可能差 1 岁，属已知偏差，界面上标注）
 * @param birthYear 出生公历年
 * @param atYear    目标年
 */
export function nominalAge(birthYear: number, atYear: number): number {
  return atYear - birthYear + 1;
}

/**
 * 小限所在宫位的地支
 * @param mingGongBranch 命宫地支
 * @param gender         male 顺行 / female 逆行
 * @param age            虚岁（>=1）
 */
export function xiaoXianBranch(mingGongBranch: number, gender: Gender, age: number): number {
  const step = Math.max(1, Math.floor(age)) - 1;
  return mod12(gender === 'male' ? mingGongBranch + step : mingGongBranch - step);
}

/**
 * 流月所在宫位的地支（简化口径：流年宫起正月顺行）
 * @param yearBranch 流年地支
 * @param month      1–12（正月=1）
 */
export function liuYueBranch(yearBranch: number, month: number): number {
  return mod12(yearBranch + (Math.max(1, Math.min(12, Math.floor(month))) - 1));
}

/**
 * 流日所在宫位的地支（流月宫起初一顺行）
 * @param monthBranch 流月地支
 * @param day         1–30
 */
export function liuRiBranch(monthBranch: number, day: number): number {
  return mod12(monthBranch + (Math.max(1, Math.floor(day)) - 1));
}

/**
 * 流时所在宫位的地支（流日宫起子时顺行）
 * @param dayBranch 流日地支
 * @param hourIndex 时辰索引 0=子 … 11=亥
 */
export function liuShiBranch(dayBranch: number, hourIndex: number): number {
  return mod12(dayBranch + Math.max(0, Math.min(11, Math.floor(hourIndex))));
}

/** 某月的天数（用于流日胶囊的数量；2 月按 28/29 处理由调用方给年份） */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * 五虎遁：由年干与月序求月干索引
 * 甲己之年丙作首……即 正月月干 = (年干*2 + 2) % 10
 * @param yearStemIndex 年干索引 0=甲
 * @param month         1–12（正月=1）
 */
export function monthStemIndex(yearStemIndex: number, month: number): number {
  return ((yearStemIndex * 2 + 2 + Math.max(1, Math.min(12, Math.floor(month))) - 1) % 10 + 10) % 10;
}

export interface LiuYueItem {
  month: number;
  label: string;
  branch: number;
  zhiName: string;
  stemIndex: number;
}

/** 生成 12 个月胶囊数据 */
export function buildLiuYue(yearBranch: number, yearStemIndex: number): LiuYueItem[] {
  return MONTH_NAMES.map((label, i) => {
    const month = i + 1;
    const branch = liuYueBranch(yearBranch, month);
    return {
      month,
      label,
      branch,
      zhiName: ZHI_NAMES[branch],
      stemIndex: monthStemIndex(yearStemIndex, month),
    };
  });
}

export interface LiuRiItem {
  day: number;
  label: string;
  branch: number;
  zhiName: string;
}

const CN_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 农历式日名：初一…初十、十一…十九、二十、廿一…廿九、三十 */
export function dayLabel(day: number): string {
  const d = Math.max(1, Math.min(30, Math.floor(day)));
  if (d <= 10) return `初${CN_NUM[d]}`;
  if (d < 20) return `十${CN_NUM[d - 10]}`;
  if (d === 20) return '二十';
  if (d < 30) return `廿${CN_NUM[d - 20]}`;
  return '三十';
}

/** 生成当月流日胶囊数据 */
export function buildLiuRi(monthBranch: number, year: number, month: number): LiuRiItem[] {
  const total = daysInMonth(year, month);
  return Array.from({ length: total }, (_, i) => {
    const day = i + 1;
    const branch = liuRiBranch(monthBranch, day);
    return { day, label: dayLabel(day), branch, zhiName: ZHI_NAMES[branch] };
  });
}

export interface LiuShiItem {
  hourIndex: number;
  label: string;
  branch: number;
  zhiName: string;
}

/** 生成 12 个时辰胶囊数据 */
export function buildLiuShi(dayBranch: number): LiuShiItem[] {
  return SHICHEN_LABELS.map((label, i) => {
    const branch = liuShiBranch(dayBranch, i);
    return { hourIndex: i, label, branch, zhiName: ZHI_NAMES[branch] };
  });
}

/** 十二宫名（与引擎宫名口径一致：命宫带「宫」，其余不带） */
const PALACE_ORDER = [
  '命宫', '兄弟', '夫妻', '子女', '财帛', '疾厄',
  '迁移', '交友', '官禄', '田宅', '福德', '父母',
] as const;

/**
 * 由地支反查宫名（用于胶囊上显示「该限/该月走到哪个宫」）
 * 十二宫自命宫起**逆时针**排列：宫序 k 对应 branch = 命宫 - k
 */
export function palaceNameAt(mingGongBranch: number, branch: number): string {
  const k = mod12(mingGongBranch - branch);
  return PALACE_ORDER[k] ?? '';
}
