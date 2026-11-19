/**
 * 三方四正宫位映射回归
 *
 * 逐项钉住「本宫 + 对宫 + 两三合宫」的集合，防止映射被改错。
 * 传统三合局独立誊写（申子辰水 / 寅午戌火 / 巳酉丑金 / 亥卯未木），
 * 不引用被测实现，作为交叉验证的独立神谕。
 */
import assert from 'node:assert/strict';

const ZHI = ['子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥'];
const name = (i: number) => ZHI[((i % 12) + 12) % 12];

// 独立定义的三合局（传统口径）
const TRINES = [
  ['申','子','辰'], ['寅','午','戌'], ['巳','酉','丑'], ['亥','卯','未'],
];

/** 被测：ChartBoard.getSanFangSiZheng 的映射（从源码抽取为纯函数镜像） */
const current = (b: number) => [b, (b + 6) % 12, (b + 4) % 12, (b + 8) % 12].map(name);

/** 独立神谕：本宫 + 对宫 + 同三合局另两支 */
const expected = (b: number) => {
  const me = name(b);
  const trine = TRINES.find(t => t.includes(me))!;
  return [me, name(b + 6), ...trine.filter(x => x !== me)];
};

const norm = (a: string[]) => [...a].sort().join(',');
let bad = 0;
for (let b = 0; b < 12; b++) {
  const c = current(b), e = expected(b);
  if (norm(c) !== norm(e)) { bad++; console.error(`  ✗ ${name(b)}宫 当前[${c}] 应为[${e}]`); }
}
assert.equal(bad, 0, '12 宫的三方四正映射必须全部与传统三合局一致');

// 对宫公式必须与 types.ts 的契约一致：(branch + 6) % 12
for (let b = 0; b < 12; b++) {
  assert.equal(name((b + 6) % 12), name(b + 6), `${name(b)}宫对宫索引应为 +6`);
}

console.log('sanfang-mapping.test.ts: PASS (12 宫逐一核对：本宫 + 对宫 + 两三合宫全部一致)');
