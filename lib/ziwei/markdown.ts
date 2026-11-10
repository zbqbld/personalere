/**
 * AI 解读文本的轻量行级 Markdown 解析
 *
 * 上游模型常直接输出 `# 标题`、`## 小节`、`- 列表`、`1. 列表`、`---`、
 * `**【章节】**` 等标记，旧渲染器会把这些符号原样显示。这里把每行归类为
 * 语义块，由组件渲染成 iOS / 科技感排版；**加粗**仍由组件内联解析。
 *
 * 纯函数，不触碰 DOM，可在回归测试中直接验证。
 */

export type AiLineType =
  | 'h1' | 'h2' | 'h3'
  | 'bullet' | 'ordered'
  | 'rule' | 'section' | 'quote'
  | 'blank' | 'paragraph';

export interface AiLine {
  type: AiLineType;
  text: string;
  /** 标题层级 1–6 或有序列表的序号 */
  level?: number;
  marker?: string;
}

export function parseAiLine(raw: string): AiLine {
  const line = raw.trimEnd();
  const t = line.trim();
  if (!t) return { type: 'blank', text: '' };

  // 分隔线：--- / *** / ___（至少 3 个）
  if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(t)) return { type: 'rule', text: '' };

  // ATX 标题：# / ## / ### ...
  const heading = t.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    const level = heading[1].length;
    return {
      type: level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3',
      text: heading[2].trim(),
      level,
    };
  }

  // 原有章节格式：**【命格定性】**
  const section = t.match(/^\*\*【(.+?)】\*\*$/);
  if (section) return { type: 'section', text: section[1] };

  // 无序列表：- / * / •
  const bullet = t.match(/^[-*•]\s+(.+)$/);
  if (bullet) return { type: 'bullet', text: bullet[1].trim() };

  // 有序列表：1. / 1)
  const ordered = t.match(/^(\d+)[.)]\s+(.+)$/);
  if (ordered) return { type: 'ordered', text: ordered[2].trim(), marker: ordered[1], level: Number(ordered[1]) };

  // 引用
  const quote = t.match(/^>\s*(.+)$/);
  if (quote) return { type: 'quote', text: quote[1].trim() };

  return { type: 'paragraph', text: t };
}

/** 把整段文本解析为行块，供渲染与测试共用 */
export function parseAiText(text: string): AiLine[] {
  return text.split('\n').map(parseAiLine);
}
