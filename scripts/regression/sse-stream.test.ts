/**
 * SSE 跨网络块解析回归测试
 *
 * 复现线上「解读内容不完整」的根因：SSE 按行传输，但 TCP 块边界不按行切。
 * 如果逐块 split('\n')，被切成两半的 JSON 行会各自解析失败，文本静默丢失。
 * 测试模拟把一行切成任意碎片，验证跨块缓冲实现能完整拼回。
 */
import assert from 'node:assert/strict';

/** 与 InsightPanel 中 handleSseLine 一致的逐行解析（纯逻辑版） */
function parseLine(line: string): string | null {
  if (line.startsWith(':')) return null;
  if (!line.startsWith('data:')) return null;
  const data = line.slice(5).trim();
  if (data === '[DONE]') return null;
  const json = JSON.parse(data);
  if (json?.error) return null;
  return json?.delta?.text ?? '';
}

/** 跨块缓冲解析器：测试对象 */
function feed(chunks: string[], onText: (t: string) => void): void {
  let buffer = '';
  for (const chunk of chunks) {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      const text = parseLine(line);
      if (text) onText(text);
    }
  }
  if (buffer.trim()) {
    const text = parseLine(buffer.trim());
    if (text) onText(text);
  }
}

(async () => {
  const full = 'data: {"delta":{"text":"紫微斗数解读：命宫主星为贪狼，事业宜先立后破。"}}\n';

  // 1) 整块到达
  let out1 = '';
  feed([full], t => { out1 += t; });
  assert.ok(out1.includes('贪狼'), '整块到达应完整解析');

  // 2) 从每个字节位置切开（最严苛的碎片化）
  for (let cut = 1; cut < full.length; cut++) {
    let out = '';
    feed([full.slice(0, cut), full.slice(cut)], t => { out += t; });
    assert.ok(out.includes('贪狼'), `在第 ${cut} 字节切开时内容不应丢失`);
  }

  // 3) 多个事件 + 保活注释 + [DONE] + 尾部无换行
  const multi = [
    'data: {"delta":{"text":"第一段。"}}\n',
    ': keep-alive\n',
    'data: {"delta":{"text":"第二段。"}}\n',
    'data: [DONE]\n',
    'data: {"delta":{"text":"尾段无换行"}}',
  ].join('');
  let out3 = '';
  feed([multi.slice(0, 37), multi.slice(37, 80), multi.slice(80)], t => { out3 += t; });
  assert.ok(out3.includes('第一段'), '多事件场景：第一段应在');
  assert.ok(out3.includes('第二段'), '多事件场景：第二段应在');
  assert.ok(out3.includes('尾段无换行'), '尾部无换行的最后一行也要处理');

  // 4) 旧实现（逐块 split）在切点处确实会丢内容——证明测试有效
  const pieces = [full.slice(0, 12), full.slice(12)];
  let oldOut = '';
  for (const piece of pieces) {
    for (const line of piece.split('\n')) {
      try { oldOut += parseLine(line.trim()) ?? ''; } catch { /* 旧实现静默跳过 */ }
    }
  }
  assert.ok(!oldOut.includes('贪狼'), '旧实现在切点处应确实丢失内容（对照组）');

  console.log('sse-stream.test.ts: PASS (跨块拼接 / 逐字节切分 / 多事件与保活 / 尾部残行 / 旧实现对照)');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
