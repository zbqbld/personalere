/**
 * 对话轮次：一问一答为一个不可分割的删除单元
 *
 * 设计原因：自动话题 / 宫位分析的提问带 hidden 标记（界面不显示），但仍参与
 * AI 上下文。若只删除可见气泡，隐藏提问会残留在上下文里，造成「删了却还
 * 记得」的不一致。因此按 user → 其后 assistant 划为一轮，删除时整轮移除，
 * 再由调用方从剩余消息重新抽取长期事实。
 *
 * 纯函数，不触碰 DOM / 存储，可在 Node 回归测试中直接验证。
 */
import type { ChatMessage } from './memory';

export interface ChatTurn {
  start: number;
  end: number;
  user?: ChatMessage;
  assistant?: ChatMessage;
  /** 是否有需要渲染的内容（隐藏提问本身不算，但其回复算） */
  visible: boolean;
}

export function buildTurns(messages: ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let current: ChatTurn | null = null;
  messages.forEach((m, i) => {
    if (m.role === 'user') {
      if (current) turns.push(current);
      current = { start: i, end: i, user: m, visible: !m.hidden };
    } else if (current) {
      if (current.assistant) {
        // 连续两条回复：不覆盖已有内容，拆出独立一轮，保证不丢消息
        turns.push(current);
        turns.push({ start: i, end: i, assistant: m, visible: !!m.content.trim() });
        current = null;
      } else {
        current.assistant = m;
        current.end = i;
        if (m.content.trim()) current.visible = true;
      }
    } else {
      // 异常数据：没有对应提问的悬空回复，单独成轮，避免丢失
      turns.push({ start: i, end: i, assistant: m, visible: !!m.content.trim() });
      current = null;
    }
  });
  if (current) turns.push(current);
  return turns;
}

/** 删除整轮（含隐藏提问），保持其余消息顺序与内容不变 */
export function messagesWithoutTurn(
  messages: ChatMessage[],
  turn: ChatTurn,
): ChatMessage[] {
  return messages.filter((_, i) => i < turn.start || i > turn.end);
}
