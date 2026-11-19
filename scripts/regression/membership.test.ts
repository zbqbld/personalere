/**
 * 会员权限层 + 时间维度算法回归
 *
 * 覆盖两类事实：
 *  1) 权限矩阵：免费锁 4 项（流月/流日/流时/十三宫）+ PRO 额度；PRO 全开；off 模式全开。
 *  2) 时间维度起法：小限男顺女逆、流月/流日/流时顺行、虚岁、日名、五虎遁月干。
 *
 * 时间维度口径为「简化口径」，测试锁的是**实现与声明一致**，不代表已与古籍核对。
 */
import assert from 'node:assert/strict';

// ── 在 import store 之前准备最小 window/localStorage 桩 ──
const mem = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
  },
  dispatchEvent: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
};

async function main() {
const { hasFeature, canUseTimeDim, PRO_WEEKLY_QUOTA } = await import('../../lib/membership/plan');
const store = await import('../../lib/membership/store');
const { xiaoXianBranch, liuYueBranch, liuRiBranch, liuShiBranch, nominalAge, dayLabel, monthStemIndex, palaceNameAt } = await import('../../lib/ziwei/time-dims');

// ── 1) 权限矩阵 ──
const LOCKED = ['time.liuyue', 'time.liuri', 'time.liushi', 'analysis.full13', 'ai.proQuota'] as const;
for (const k of LOCKED) assert.equal(hasFeature('free', k), false, `免费版不应有 ${k}`);
for (const k of LOCKED) assert.equal(hasFeature('pro', k), true, `专业版应有 ${k}`);

assert.equal(canUseTimeDim('free', 'mingpan'), true, '本命对免费开放');
assert.equal(canUseTimeDim('free', 'daxian'), true, '大限对免费开放');
assert.equal(canUseTimeDim('free', 'liunian'), true, '流年对免费开放');
assert.equal(canUseTimeDim('free', 'xiaoxian'), true, '小限对免费开放（与参考站一致）');
assert.equal(canUseTimeDim('free', 'liuyue'), false, '流月对免费锁定');
assert.equal(canUseTimeDim('pro', 'liuyue'), true, '流月对专业版开放');

// ── 2) store：模拟开通 / 取消 / 额度 ──
assert.equal(store.loadPlan(), 'free', '默认免费');
assert.equal(store.setPlan('pro'), true, '模拟模式下可开通');
assert.equal(store.loadPlan(), 'pro', '开通后读回专业版');
assert.equal(store.setPlan('free'), true, '可取消');
assert.equal(store.loadPlan(), 'free', '取消后回到免费');

assert.equal(store.proQuotaLeft(), PRO_WEEKLY_QUOTA, '新周额度应为满额');
store.consumeProQuota();
store.consumeProQuota();
assert.equal(store.proQuotaLeft(), PRO_WEEKLY_QUOTA - 2, '消耗 2 次后应剩 138');
store.resetProQuota();
assert.equal(store.proQuotaLeft(), PRO_WEEKLY_QUOTA, '重置后回到满额');

// off 模式：全部解锁
const prev = process.env.NEXT_PUBLIC_MEMBERSHIP_MODE;
process.env.NEXT_PUBLIC_MEMBERSHIP_MODE = 'off';
assert.equal(store.membershipMode(), 'off');
assert.equal(store.loadPlan(), 'pro', 'off 模式下恒为专业版');
assert.equal(store.setPlan('free'), false, 'off 模式下不允许本地切换');
if (prev === undefined) delete process.env.NEXT_PUBLIC_MEMBERSHIP_MODE; else process.env.NEXT_PUBLIC_MEMBERSHIP_MODE = prev;

// ── 3) 时间维度算法 ──
assert.equal(nominalAge(1994, 2026), 33, '1994 年生 2026 年虚岁应为 33');

// 小限：男顺女逆，1 岁在命宫
assert.equal(xiaoXianBranch(3, 'male', 1), 3, '男命 1 岁在命宫');
assert.equal(xiaoXianBranch(3, 'male', 2), 4, '男命 2 岁顺行一宫');
assert.equal(xiaoXianBranch(3, 'female', 1), 3, '女命 1 岁在命宫');
assert.equal(xiaoXianBranch(3, 'female', 2), 2, '女命 2 岁逆行一宫');
assert.equal(xiaoXianBranch(0, 'female', 2), 11, '逆行应正确回绕到亥');

// 流月：流年宫起正月顺行
assert.equal(liuYueBranch(6, 1), 6, '正月在流年宫');
assert.equal(liuYueBranch(6, 2), 7, '二月顺行一宫');
assert.equal(liuYueBranch(11, 2), 0, '顺行应正确回绕');

// 流日 / 流时
assert.equal(liuRiBranch(6, 1), 6, '初一在流月宫');
assert.equal(liuRiBranch(6, 3), 8, '初三顺行两宫');
assert.equal(liuShiBranch(6, 0), 6, '子时在流日宫');
assert.equal(liuShiBranch(6, 11), 5, '亥时顺行十一宫');

// 日名
assert.equal(dayLabel(1), '初一');
assert.equal(dayLabel(10), '初十');
assert.equal(dayLabel(11), '十一');
assert.equal(dayLabel(20), '二十');
assert.equal(dayLabel(21), '廿一');
assert.equal(dayLabel(30), '三十');

// 五虎遁：甲己之年丙作首
assert.equal(monthStemIndex(0, 1), 2, '甲年正月为丙');
assert.equal(monthStemIndex(1, 1), 4, '乙年正月为戊');
assert.equal(monthStemIndex(4, 1), 0, '戊年正月为甲');
assert.equal(monthStemIndex(0, 2), 3, '甲年二月为丁');

// 宫名反查：命宫地支处的宫名应为命宫，逆时针一宫为兄弟
assert.equal(palaceNameAt(3, 3), '命宫');
assert.equal(palaceNameAt(3, 2), '兄弟');
assert.equal(palaceNameAt(3, 1), '夫妻');
assert.equal(palaceNameAt(3, 0), '子女');

console.log('membership.test.ts: PASS (权限矩阵 / 模拟开关 / 周额度 / 时间维度起法与日名干序)');
}
main().catch(e => { console.error(e); process.exit(1); });
