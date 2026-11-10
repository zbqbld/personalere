/**
 * AI 解读 Markdown 行解析回归测试
 *
 * 锁定：# / ## / ### 标题、- 与 1. 列表、--- 分隔线、**【章节】**、引用、
 * 空行、正文各自归类；普通文本里的连字符与星号不被误判为列表。
 */
import assert from 'node:assert/strict';
import { parseAiLine, parseAiText } from '../../lib/ziwei/markdown';

const cases: Array<[string, string, string?]> = [
  ['# 财运分析：胥先生命盘', 'h1', '财运分析：胥先生命盘'],
  ['## 一、财帛宫基本盘', 'h2', '一、财帛宫基本盘'],
  ['### 细节补充', 'h3', '细节补充'],
  ['#### 更小节', 'h3', '更小节'],
  ['- 陀罗（庙）：赚钱过程拖磨', 'bullet', '陀罗（庙）：赚钱过程拖磨'],
  ['* 火星（得）：偶有突发性开销', 'bullet', '火星（得）：偶有突发性开销'],
  ['• 圆点列表', 'bullet', '圆点列表'],
  ['1. 第一项', 'ordered', '第一项'],
  ['2) 第二项', 'ordered', '第二项'],
  ['---', 'rule'],
  ['***', 'rule'],
  ['**【命格定性】**', 'section', '命格定性'],
  ['> 这是一句提示', 'quote', '这是一句提示'],
  ['', 'blank'],
  ['   ', 'blank'],
  ['你的财帛宫在戌宫，天府庙旺坐守。', 'paragraph', '你的财帛宫在戌宫，天府庙旺坐守。'],
  ['3-5 年内的变化', 'paragraph', '3-5 年内的变化'],
  ['进财慢 + 耗损多，切忌求快财。', 'paragraph', '进财慢 + 耗损多，切忌求快财。'],
];

for (const [raw, type, text] of cases) {
  const got = parseAiLine(raw);
  assert.equal(got.type, type, `行类型错误：${raw}`);
  if (text !== undefined) assert.equal(got.text, text, `文本内容错误：${raw}`);
}

const ordered = parseAiLine('12. 第十二项');
assert.equal(ordered.marker, '12');
assert.equal(ordered.level, 12);
assert.equal(parseAiLine('# 标题').level, 1);
assert.equal(parseAiLine('## 标题').level, 2);

const sample = [
  '# 财运分析：胥先生命盘',
  '',
  '## 一、财帛宫基本盘',
  '你的财帛宫在戌宫。',
  '',
  '- 陀罗（庙）：赚钱过程拖磨',
  '- 火星（得）：偶有突发性开销',
  '',
  '---',
  '结论：正财运好。',
];
const parsed = parseAiText(sample.join('\n'));
assert.equal(parsed.length, sample.length);
assert.deepEqual(parsed.map(l => l.type), [
  'h1', 'blank', 'h2', 'paragraph', 'blank', 'bullet', 'bullet', 'blank', 'rule', 'paragraph',
]);

console.log('markdown.test.ts: PASS (标题 / 列表 / 分隔线 / 章节 / 引用 / 正文 分类正确)');
