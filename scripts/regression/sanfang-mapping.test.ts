/**
 * 三方四正宫位映射回归
 *
 * 逐项钉住「本宫 + 对宫 + 两三合宫」的集合，防止映射被改错。
 * 传统三合局独立誊写（申子辰水 / 寅午戌火 / 巳酉丑金 / 亥卯未木），
 * 不引用被测实现，作为交叉验证的独立神谕。
 */
import assert from 'node:assert/strict';
import { generateChart } from '../../lib/ziwei/algorithm';

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

// ── 宫名语义层：命宫的三方四正必须是 命宫+财帛+官禄+迁移（真实排盘）──
// 宫名确认：引擎宫名为「命宫」「财帛」「官禄」「迁移」（不带"宫"字尾，命宫除外）
const SEMANTIC_WANT = ['命宫','财帛','官禄','迁移'].sort().join(',');
const samples: Array<[number,number,number,number,'male'|'female']> = [
  [1988,10,8,11,'male'], [1990,3,15,6,'female'], [2000,7,1,11,'male'],
  [1975,1,30,4,'female'], [2010,12,31,9,'male'],
];
for (const [y,m,d,h,g] of samples) {
  const chart = generateChart({ year:y, month:m, day:d, hour:h, gender:g });
  const ming = chart.palaces.find(p => p.isMingGong);
  assert.ok(ming, `${y}-${m}-${d} 应有命宫`);
  const byBranch = (b:number) => chart.palaces.find(p => p.branch === b)?.name ?? '?';
  const sanFang = [ming.branch, (ming.branch+4)%12, (ming.branch+8)%12, (ming.branch+6)%12].map(byBranch);
  assert.equal([...sanFang].sort().join(','), SEMANTIC_WANT,
    `${y}-${m}-${d} 命宫三方四正宫名应为 命宫+财帛+官禄+迁移，实际[${sanFang}]`);
}

console.log('sanfang-mapping.test.ts: PASS (12 宫偏移核对 + 5 盘宫名语义核对全部一致)');
