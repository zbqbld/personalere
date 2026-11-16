/**
 * AI 解读内容的纯展示组件（从 InsightPanel 拆出）
 *
 * 只做 markdown 分块渲染，不含任何业务状态：
 *  - 用 React.memo 包裹：流式输出时只有正在生成的那条会重渲染，
 *    历史气泡的 props（text / streaming）不变，直接跳过；
 *  - InlineText 同样 memo，行内加粗解析不再随列表全量重跑。
 */
import { memo, useMemo } from 'react';
import { parseAiText } from '@/lib/ziwei/markdown';

/** 行内加粗 **...** 解析，标题 / 列表内的加粗同样生效 */
export const InlineText = memo(function InlineText({ text }: { text: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/);
  return (
    <>
      {parts.map((part, j) =>
        j % 2 === 0
          ? part
          : <strong key={j} className="ios-md-strong">{part}</strong>
      )}
    </>
  );
});

/**
 * AI 解读 Markdown 渲染：# 标题、## 小节、- 列表、1. 列表、--- 分隔线、
 * **【章节】**、> 引用与正文各自成块，不再把标记符号原样显示。
 */
export const AiContent = memo(function AiContent({ text, streaming }: { text: string; streaming?: boolean }) {
  const lines = useMemo(() => parseAiText(text), [text]);
  return (
    <div className="ios-md">
      {lines.map((line, i) => {
        switch (line.type) {
          case 'blank':
            return <div key={i} className="ios-md-gap" />;
          case 'rule':
            return <div key={i} className="ios-md-rule" />;
          case 'h1':
            return (
              <div key={i} className="ios-md-h1">
                <span className="ios-md-h1-mark" aria-hidden="true" />
                <InlineText text={line.text} />
              </div>
            );
          case 'h2':
            return (
              <div key={i} className="ios-md-h2">
                <span className="ios-md-h2-mark" aria-hidden="true" />
                <InlineText text={line.text} />
              </div>
            );
          case 'h3':
            return <div key={i} className="ios-md-h3"><InlineText text={line.text} /></div>;
          case 'section':
            return <div key={i} className="ios-md-section">【{line.text}】</div>;
          case 'bullet':
            return (
              <div key={i} className="ios-md-li">
                <span className="ios-md-bullet" aria-hidden="true" />
                <span className="ios-md-li-text"><InlineText text={line.text} /></span>
              </div>
            );
          case 'ordered':
            return (
              <div key={i} className="ios-md-li">
                <span className="ios-md-order" aria-hidden="true">{line.marker}</span>
                <span className="ios-md-li-text"><InlineText text={line.text} /></span>
              </div>
            );
          case 'quote':
            return <div key={i} className="ios-md-quote"><InlineText text={line.text} /></div>;
          default:
            return <div key={i} className="ios-md-p"><InlineText text={line.text} /></div>;
        }
      })}
      {streaming && <span className="ios-md-caret" />}
    </div>
  );
});

/** 气泡时间戳：iMessage 风格的两位小时制 */
export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}
