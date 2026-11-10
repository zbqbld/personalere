'use client';
import { useState, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { ZiweiChart, Palace } from '@/lib/ziwei/types';
import type { TimeView } from './TimeNav';
import { buildTurns, messagesWithoutTurn, type ChatTurn } from '@/lib/ziwei/chat-turns';
import { parseAiText } from '@/lib/ziwei/markdown';
import {
  chatKeyForBirth,
  describeChatLabel,
  loadChat,
  saveChat,
  clearChat,
  formatSavedAt,
  extractLongTermFacts,
  buildApiMessages,
  type ChatMessage,
  type LongTermFact,
  type ApiMessage,
} from '@/lib/ziwei/memory';

/** 与 lib/ziwei/memory.ts 的 ChatMessage 保持同一结构 */
type Message = ChatMessage;

interface SelectedSiHua {
  starName: string;
  siHua: string;
  view: TimeView;
}

interface InsightPanelProps {
  chart: ZiweiChart;
  selectedPalace?: Palace | null;
  selectedSiHua?: SelectedSiHua | null;
  /** 顶层执行「清除全部记忆」时递增，用于同步清空内存中的对话 */
  chatResetSignal?: number;
}

/**
 * 上下文构建统一走 lib/ziwei/memory.ts 的 buildApiMessages：
 * 「长期事实锚点 + 结构合法化的最近窗口」，保证早前设定的偏好 / 约束跨多轮沿用。
 * 组件不再自行 slice 截断 —— 那会让窗口外的长期设定永久丢失。
 * 对外请求体仍是 { chart, messages:[{role,content}] }，UI 与交互不变。
 */

/* ── 长对话浏览与删除的参数 ───────────────────────────────── */
/** 默认只渲染最近 12 轮，更早的由「查看更早」按需展开 */
const VISIBLE_TURNS = 12;
/** 单条解读超过该字数时默认折叠，避免一条消息撑满整屏 */
const LONG_TEXT_THRESHOLD = 700;
const LONG_PREVIEW_CHARS = 420;
const CONFIRM_TTL_MS = 4000;
const UNDO_TTL_MS = 6000;

const TOPICS = [
  { key: 'overview',     label: '命格' },
  { key: 'love',        label: '感情' },
  { key: 'career',      label: '事业' },
  { key: 'wealth',      label: '财运' },
  { key: 'health',      label: '健康' },
  { key: 'personality', label: '性格' },
] as const;

const TOPIC_PROMPTS: Record<string, string> = {
  overview: `请生成命格总览，按以下结构输出：

**【命格定性】**
用一句话概括这个命盘的核心格局与命主气质。

**【主星解读】**
命宫主星的核心特质，引用倪海厦原话或观点。

**【三方四正】**
财、官、迁三宫的联动分析及整体格局。

**【当前大限】**
当下大限运势方向与最值得关注的事项。

**【优势与注意】**
命盘天赋优势，以及需要注意的风险或功课。`,

  love: `请深度分析感情婚姻运，按以下结构输出：

**【感情格局】**
一句话定性感情命格。

**【夫妻宫分析】**
夫妻宫主星、四化，以及倪海厦体系的具体解读。

**【三方联动】**
相关宫位对感情的影响。

**【当前大限感情运】**
当下10年感情走向与关键节点。

**【实际建议】**
具体可行的感情建议。`,

  career: `请深度分析事业运，按以下结构输出：

**【事业格局】**
一句话定性事业命格，宜任职或宜创业。

**【官禄宫分析】**
官禄宫主星、四化，以及倪师对这种配置的判断。

**【财帛宫联动】**
财运与事业的关系，财路来源分析。

**【当前大限事业运】**
当下10年事业走向。

**【实际建议】**
适合的方向、行业与策略。`,

  wealth: `请深度分析财运，按以下结构输出：

**【财运格局】**
一句话定性财运模式，是主动财还是被动财。

**【财帛宫分析】**
财帛宫主星、四化，财富来源与流动模式。

**【田宅宫（财库）】**
积蓄能力与不动产运势分析。

**【当前大限财运】**
当下财运走向与注意事项。

**【理财建议】**
具体的财务建议。`,

  health: `请分析健康运势，按以下结构输出：

**【疾厄宫主星】**
疾厄宫星曜与健康含义。

**【主要风险】**
结合倪海厦子午流注理论，分析主要健康隐患与需关注的部位。

**【大限健康走势】**
当下健康趋势与关键时间段。

**【预防建议】**
具体注意事项与养生方向。`,

  personality: `请深度解析性格特质，按以下结构输出：

**【命宫主星性格】**
命宫主星的核心性格特质，引用倪师原话。

**【三方性格综合】**
财、官、迁三宫对性格的影响，全貌描绘。

**【人际关系模式】**
与他人互动方式、待人处世风格。

**【优势与人生课题】**
天赋优势，以及需要面对的人生功课。`,
};

const PALACE_ROLES: Record<string, string> = {
  '命宫':   '自我、性格、先天格局',
  '兄弟宫': '兄弟关系、合伙人',
  '夫妻宫': '感情关系、婚姻状态',
  '子女宫': '子女缘分、下属关系',
  '财帛宫': '财运来源、收入方式',
  '疾厄宫': '身体健康、意外',
  '迁移宫': '外出机遇、人际格局',
  '交友宫': '朋友圈、贵人、小人',
  '官禄宫': '事业成就、社会地位',
  '田宅宫': '不动产、家庭环境',
  '福德宫': '精神享受、内心福分',
  '父母宫': '父母关系、文书契约',
};

/** 行内加粗 **...** 解析，标题 / 列表内的加粗同样生效 */
function InlineText({ text }: { text: string }) {
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
}

/**
 * AI 解读 Markdown 渲染：# 标题、## 小节、- 列表、1. 列表、--- 分隔线、
 * **【章节】**、> 引用与正文各自成块，不再把标记符号原样显示。
 */
function AiContent({ text, streaming }: { text: string; streaming?: boolean }) {
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
}

export default function InsightPanel({ chart, selectedPalace, selectedSiHua, chatResetSignal = 0 }: InsightPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeTopic, setActiveTopic] = useState<string>('overview');
  const messagesRef = useRef<Message[]>([]); // always-current copy for closures
  const loadingRef = useRef(false);
  const autoLoaded = useRef(false);
  const lastPalaceBranch = useRef<number | undefined>(undefined);
  const lastSiHuaKey = useRef<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── 长对话浏览 / 单轮删除（仅 UI 层，不改变消息与上下文契约）──
  /** 三档密度：舒适 / 紧凑 / 极简，默认紧凑 */
  const [density, setDensity] = useState<'comfortable' | 'compact' | 'tight'>('compact');
  const [showAllTurns, setShowAllTurns] = useState(false);
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [undoSnapshot, setUndoSnapshot] = useState<{
    messages: Message[]; facts: LongTermFact[]; label: string;
  } | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  // ── 对话记忆（按命盘隔离，仅存本机 localStorage） ─────────
  const chatKey = useMemo(() => chatKeyForBirth(chart.birthInfo), [chart.birthInfo]);
  const chatLabel = useMemo(() => describeChatLabel(chart.birthInfo), [chart.birthInfo]);
  const [chatReady, setChatReady] = useState(false);
  const [rememberChat, setRememberChat] = useState(true);
  const [restored, setRestored] = useState<{ count: number; savedAt: number } | null>(null);
  const [chatCleared, setChatCleared] = useState(false);
  const [confirmClearChat, setConfirmClearChat] = useState(false);
  const suppressAutoRef = useRef(false);
  const skipNextSaveRef = useRef(false);
  const lastResetRef = useRef(chatResetSignal);
  /** 长期事实（偏好 / 约束）。与 messages 分开保存，窗口裁剪后依然存活 */
  const factsRef = useRef<LongTermFact[]>([]);

  // Keep refs in sync
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { loadingRef.current = loading; }, [loading]);

  // Auto-scroll：仅在用户本来就停在底部时跟随新消息，浏览历史时保持阅读位置
  useEffect(() => {
    if (scrollRef.current && atBottom) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, atBottom]);

  // ── 恢复这张命盘上次的对话 ────────────────────────────────
  // 必须声明在「自动生成命格总览」之前：有历史时设 autoLoaded，避免重复生成。
  useEffect(() => {
    const mem = loadChat(chatKey);
    if (mem && mem.messages.length > 0) {
      messagesRef.current = mem.messages;   // 同步 ref，防止用户立刻追问时丢上下文
      setMessages(mem.messages);
      // 旧缓存没有 facts 字段时从消息重新抽取，实现零迁移的平滑升级
      factsRef.current = mem.facts.length > 0
        ? mem.facts
        : extractLongTermFacts(mem.messages);
      setRestored({ count: mem.messages.length, savedAt: mem.savedAt });
      setChatCleared(false);
      autoLoaded.current = true;
      skipNextSaveRef.current = true;       // 恢复动作本身不刷新保存时间
    } else {
      messagesRef.current = [];
      factsRef.current = [];
      setMessages([]);
      setRestored(null);
    }
    setChatReady(true);
  }, [chatKey]);

  // ── 防抖持久化：流式逐 token 不写盘，输出结束（loading=false）立即落盘 ──
  useEffect(() => {
    if (!chatReady || !rememberChat) return;
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    if (messages.length === 0) return;
    const t = window.setTimeout(() => {
      saveChat(chatKey, chatLabel, messages, factsRef.current);
    }, loading ? 800 : 250);
    return () => window.clearTimeout(t);
  }, [messages, loading, chatKey, chatLabel, chatReady, rememberChat]);

  // 关闭「记住对话」时立即删除本机这份会话（不影响屏幕上的内容）
  useEffect(() => {
    if (chatReady && !rememberChat) clearChat(chatKey);
  }, [rememberChat, chatReady, chatKey]);

  // 「清空对话」二次确认 4 秒后自动撤销，避免误触残留
  useEffect(() => {
    if (!confirmClearChat) return;
    const t = window.setTimeout(() => setConfirmClearChat(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirmClearChat]);

  // 顶层「清除记忆」联动：仅在信号变化时清内存（首次挂载不触发）
  useEffect(() => {
    if (chatResetSignal === lastResetRef.current) return;
    lastResetRef.current = chatResetSignal;
    suppressAutoRef.current = true;
    autoLoaded.current = true;
    messagesRef.current = [];
    factsRef.current = [];
    setMessages([]);
    setRestored(null);
    setChatCleared(true);
    setConfirmClearChat(false);
  }, [chatResetSignal]);

  const handleClearChat = () => {
    if (!confirmClearChat) {
      setConfirmClearChat(true);
      return;
    }
    clearChat(chatKey);
    suppressAutoRef.current = true;
    autoLoaded.current = true;
    messagesRef.current = [];
    factsRef.current = [];
    setMessages([]);
    setRestored(null);
    setChatCleared(true);
    setConfirmClearChat(false);
  };

  // 二次确认与撤销入口都自动过期，避免误删状态长期残留
  useEffect(() => {
    if (pendingDelete === null) return;
    const t = window.setTimeout(() => setPendingDelete(null), CONFIRM_TTL_MS);
    return () => window.clearTimeout(t);
  }, [pendingDelete]);

  useEffect(() => {
    if (!undoSnapshot) return;
    const t = window.setTimeout(() => setUndoSnapshot(null), UNDO_TTL_MS);
    return () => window.clearTimeout(t);
  }, [undoSnapshot]);

  /** 删除一整轮（含隐藏的自动提问）；第一次点击只进入确认态 */
  const handleDeleteTurn = (turn: ChatTurn) => {
    if (pendingDelete !== turn.start) {
      setPendingDelete(turn.start);
      return;
    }
    const before = messagesRef.current.slice();
    const beforeFacts = factsRef.current.slice();
    const next = messagesWithoutTurn(before, turn);
    // 长期事实从剩余消息重新抽取，被删轮次设定的偏好不会继续影响后续解读
    const nextFacts = extractLongTermFacts(next);

    setUndoSnapshot({ messages: before, facts: beforeFacts, label: '1 轮对话' });
    messagesRef.current = next;
    factsRef.current = nextFacts;
    setMessages(next);
    setPendingDelete(null);
    setExpandedTurns(prev => {
      const s = new Set(prev);
      s.delete(turn.start);
      return s;
    });

    if (next.length === 0) {
      // 删空时必须同步清除本机会话，否则刷新后被删内容会重新出现
      clearChat(chatKey);
      suppressAutoRef.current = true;
      autoLoaded.current = true;
      setRestored(null);
      setChatCleared(true);
    } else {
      saveChat(chatKey, chatLabel, next, nextFacts);
      setChatCleared(false);
    }
  };

  const handleUndoDelete = () => {
    if (!undoSnapshot) return;
    messagesRef.current = undoSnapshot.messages;
    factsRef.current = undoSnapshot.facts;
    setMessages(undoSnapshot.messages);
    saveChat(chatKey, chatLabel, undoSnapshot.messages, undoSnapshot.facts);
    setRestored({ count: undoSnapshot.messages.length, savedAt: Date.now() });
    setChatCleared(false);
    setUndoSnapshot(null);
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setAtBottom(true);
  };

  // Auto-generate 命格总览 on mount（已恢复或被清空时跳过）
  useEffect(() => {
    if (autoLoaded.current || suppressAutoRef.current) return;
    autoLoaded.current = true;
    sendMessage(TOPIC_PROMPTS.overview, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Inject palace analysis when palace selected
  useEffect(() => {
    if (!selectedPalace || selectedPalace.branch === lastPalaceBranch.current) return;
    lastPalaceBranch.current = selectedPalace.branch;

    const majorStars = selectedPalace.stars.filter(s => s.type === 'major');
    const starDesc = majorStars.length > 0
      ? majorStars.map(s => `${s.name}${s.siHua ? '化' + s.siHua : ''}`).join('、')
      : '空宫（借对宫）';
    const role = PALACE_ROLES[selectedPalace.name] ?? '';

    const prompt = `请重点分析【${selectedPalace.name}】（主管：${role}），该宫主星为${starDesc}，按以下结构输出：

**【宫位定性】**
${selectedPalace.name}在命盘中的意义，以及这种星曜配置的整体判断。

**【主星解读】**
主星在此宫的倪海厦体系解读，引用具体观点。

**【三方四正联动】**
三方四正宫位对此宫的影响。

**【实际建议】**
基于此宫的具体建议。`;

    sendMessage(prompt, true);
  }, [selectedPalace]); // eslint-disable-line react-hooks/exhaustive-deps

  // 注入四化飞化分析
  useEffect(() => {
    if (!selectedSiHua) return;
    const key = `${selectedSiHua.starName}-${selectedSiHua.siHua}-${selectedSiHua.view}`;
    if (key === lastSiHuaKey.current) return;
    lastSiHuaKey.current = key;

    // 找出该星所在宫位
    const palaceOfStar = chart.palaces.find(p =>
      p.stars.some(s => s.name === selectedSiHua.starName)
    );
    const palaceName = palaceOfStar?.name ?? '未知宫位';
    const viewLabel = selectedSiHua.view === 'daxian' ? '大限' : '流年';

    const prompt = `请分析【${viewLabel}${selectedSiHua.starName}化${selectedSiHua.siHua}】的飞化影响，按以下结构输出：

**【化${selectedSiHua.siHua}基本含义】**
化${selectedSiHua.siHua}在倪海厦体系中的核心含义，以及${selectedSiHua.starName}化${selectedSiHua.siHua}的特殊含义。

**【落宫影响】**
${selectedSiHua.starName}化${selectedSiHua.siHua}落在【${palaceName}】，该宫主管的领域受到何种影响，倪师如何解读。

**【三方四正飞化路径】**
化${selectedSiHua.siHua}入${palaceName}后，对其三方四正（对宫、两个三合宫）的联动影响。

**【当前运势影响】**
在${viewLabel}时间维度下，此化${selectedSiHua.siHua}对命主近期运势的具体影响。

**【实际建议】**
基于此四化的具体可操作建议。`;

    sendMessage(prompt, true);
  }, [selectedSiHua]); // eslint-disable-line react-hooks/exhaustive-deps

  const streamResponse = async (apiMessages: ApiMessage[]) => {
    try {
      const res = await fetch('/api/interpret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chart, messages: apiMessages }),
      });
      if (res.status === 404) throw new Error('api-missing');
      if (!res.ok) throw new Error('请求失败');
      if (!res.body) throw new Error('无响应流');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = '';

      setMessages(prev => [...prev, { role: 'assistant', content: '', ts: Date.now() }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') break;
          try {
            const delta = JSON.parse(data).delta?.text ?? '';
            assistantText += delta;
            setMessages(prev => {
              const updated = [...prev];
              updated[updated.length - 1] = {
                ...updated[updated.length - 1],
                role: 'assistant',
                content: assistantText,
              };
              return updated;
            });
          } catch { /* skip */ }
        }
      }
    } catch (e) {
      const missing = e instanceof Error && e.message === 'api-missing';
      setMessages(prev => [...prev, { role: 'assistant', content: missing ? '开源版不含 AI 解读接口（/api/interpret），需要你自己实现后才能用，详见 README「快速开始」。排盘本身不需要任何 API Key。' : '解读失败，请稍后重试。', ts: Date.now() }]);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  };

  const sendMessage = (text: string, hidden = false) => {
    if (!text.trim() || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setChatCleared(false);

    const userMsg: Message = { role: 'user', content: text, hidden, ts: Date.now() };
    const full = [...messagesRef.current, userMsg];
    // 每轮都基于完整历史刷新长期事实：早前设定不会因窗口滚动丢失；
    // 冲突按「后写覆盖」消解，重复按类别收敛，过期条目自动淘汰。
    factsRef.current = extractLongTermFacts(full, factsRef.current);
    const apiMessages = buildApiMessages(full, factsRef.current);

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    streamResponse(apiMessages);
  };

  const handleTopicClick = (topicKey: string) => {
    if (loadingRef.current) return;
    setActiveTopic(topicKey);
    sendMessage(TOPIC_PROMPTS[topicKey], true);
  };

  const handleSend = () => {
    sendMessage(input);
  };

  const turns = useMemo(() => buildTurns(messages), [messages]);
  const visibleTurns = useMemo(() => turns.filter(t => t.visible), [turns]);
  const olderCount = Math.max(0, visibleTurns.length - VISIBLE_TURNS);
  const shownTurns = showAllTurns ? visibleTurns : visibleTurns.slice(-VISIBLE_TURNS);
  const lastTurnStart = visibleTurns.length > 0
    ? visibleTurns[visibleTurns.length - 1].start : -1;
  const currentTopicLabel = TOPICS.find(t => t.key === activeTopic)?.label ?? '命格';

  const toggleExpanded = (key: number) => {
    setExpandedTurns(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** 追问输入栏上方的快捷问题，点击即发送，让「追问」入口更显眼 */
  const QUICK_PROMPTS = ['今年适合换工作吗？', '感情走势如何？', '财运要注意什么？'];

  return (
    <div className="flex flex-col h-full rounded-xl overflow-hidden card-glass">

      {/* ── 对话记忆条：开关 / 恢复状态 / 清空入口 ── */}
      <div className="zw-chat-bar">
        <label className="zw-chat-toggle">
          <input
            type="checkbox"
            checked={rememberChat}
            onChange={e => setRememberChat(e.target.checked)}
          />
          <span>记住对话</span>
        </label>
        <span className={`zw-chat-state ios-status ${restored ? 'ios-status-info' : rememberChat ? 'ios-status-neutral' : 'ios-status-warning'}`}>
          {restored
            ? `已恢复 ${restored.count} 条 · ${formatSavedAt(restored.savedAt)}`
            : (rememberChat ? `仅存本机 · ${visibleTurns.length} 轮对话` : '本次对话不保存')}
        </span>
        <button
          type="button"
          className={`zw-link zw-chat-clear${confirmClearChat ? ' ios-emp-danger' : ''}`}
          onClick={handleClearChat}
          disabled={loading}
        >
          {confirmClearChat ? '再点一次确认清空' : '清空对话'}
        </button>
      </div>

      {/* ── Topic buttons ── */}
      <div className="flex-shrink-0 px-2 pt-2.5 pb-2" style={{ borderBottom: '1px solid var(--t-border)' }}>
        <div className="grid grid-cols-6 gap-1">
          {TOPICS.map(t => {
            const isActive = activeTopic === t.key;
            return (
              <button
                key={t.key}
                onClick={() => handleTopicClick(t.key)}
                disabled={loading}
                className="py-1.5 text-[10px] font-medium rounded-lg transition-all duration-150 disabled:opacity-40"
                style={{
                  background: isActive ? 'rgba(212,168,67,0.12)' : 'transparent',
                  border: `1px solid ${isActive ? 'rgba(212,168,67,0.3)' : 'var(--t-border)'}`,
                  color: isActive ? 'var(--t-gold)' : 'var(--t-faint)',
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Messages：iMessage 气泡 + 长对话浏览 + 单轮删除 ── */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={`ios-chat-scroll flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0 ${density === 'compact' ? 'ios-density-compact' : density === 'tight' ? 'ios-density-tight' : ''}`}
      >
        {/* 当前会话主题：粘性标题，滚动长对话时仍可见 */}
        <div className="ios-topic-strip">
          <span className="ios-emp-label">当前主题</span>
          <span className="ios-emp-key">{currentTopicLabel}</span>
          <span className="ios-topic-count">{visibleTurns.length} 轮</span>
          <button
            type="button"
            className="ios-density-btn"
            onClick={() => setDensity(d => d === 'comfortable' ? 'compact' : d === 'compact' ? 'tight' : 'comfortable')}
            title="切换密度：舒适 / 紧凑 / 极简"
          >
            {density === 'comfortable' ? '紧凑' : density === 'compact' ? '极简' : '舒适'}
          </button>
        </div>

        {/* 方法一：折叠较早消息，按需展开 */}
        {olderCount > 0 && !showAllTurns && (
          <button type="button" className="ios-load-older" onClick={() => setShowAllTurns(true)}>
            查看更早的 {olderCount} 轮对话
          </button>
        )}
        {showAllTurns && olderCount > 0 && (
          <button type="button" className="ios-load-older" onClick={() => setShowAllTurns(false)}>
            收起较早的 {olderCount} 轮对话
          </button>
        )}

        {/* Empty / loading state */}
        {visibleTurns.length === 0 && (
          <div className="flex flex-col items-center justify-center min-h-[160px] text-center">
            <div className="ios-empty-icon">✦</div>
            {chatCleared ? (
              <span className="ios-status ios-status-info">对话已清空，点击上方话题或输入问题开始新解读</span>
            ) : (
              <span className="ios-status ios-status-info animate-pulse">命格解读生成中…</span>
            )}
          </div>
        )}

        <AnimatePresence initial={false}>
          {shownTurns.map(turn => {
            const assistantText = turn.assistant?.content ?? '';
            // 方法二：超长单条解读默认折叠，避免一条消息撑满整屏
            const isLong = assistantText.length > LONG_TEXT_THRESHOLD;
            const expanded = expandedTurns.has(turn.start);
            const shownText = isLong && !expanded
              ? `${assistantText.slice(0, LONG_PREVIEW_CHARS)}…`
              : assistantText;
            const streaming = loading && turn.start === lastTurnStart && (!isLong || expanded);
            const confirming = pendingDelete === turn.start;

            return (
              <motion.div
                key={`turn-${turn.start}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="ios-turn"
              >
                {turn.user && !turn.user.hidden && (
                  <div className="flex justify-end">
                    <div className="ios-bubble ios-bubble-user">{turn.user.content}</div>
                  </div>
                )}

                {assistantText.trim() && (
                  <div className="flex justify-start items-end gap-2">
                    <span className="ios-avatar" aria-hidden="true">✦</span>
                    <div className="ios-bubble ios-bubble-assistant">
                      <div className="ios-bubble-name">命理解读</div>
                      <AiContent text={shownText} streaming={streaming} />
                      {isLong && (
                        <button type="button" className="ios-expand" onClick={() => toggleExpanded(turn.start)}>
                          {expanded ? '收起' : `展开全文（还有 ${assistantText.length - LONG_PREVIEW_CHARS} 字）`}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                <div className="ios-turn-actions">
                  <button
                    type="button"
                    className={`ios-turn-del${confirming ? ' ios-turn-del-confirm' : ''}`}
                    onClick={() => handleDeleteTurn(turn)}
                    title={confirming ? '再点一次确认删除' : '删除这一轮对话'}
                  >
                    {confirming ? '确认删除' : '删除这轮'}
                  </button>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>

        {/* 方法三：浏览历史时快速回到最新 */}
        {!atBottom && (
          <div className="ios-jump-wrap">
            <button type="button" className="ios-jump-bottom" onClick={jumpToBottom}>回到最新 ↓</button>
          </div>
        )}
      </div>

      {/* 删除后的界面反馈：限时撤销 */}
      {undoSnapshot && (
        <div className="ios-undo" role="status">
          <span>已删除 {undoSnapshot.label}</span>
          <button type="button" onClick={handleUndoDelete}>撤销</button>
        </div>
      )}

      {/* ── 追问输入栏：显眼标题 + 快捷问题 + iOS 信息输入框 ── */}
      <div className="ios-compose">
        <div className="ios-compose-head">
          <span className="ios-compose-label">继续追问</span>
          <div className="ios-quick-list">
            {QUICK_PROMPTS.map(q => (
              <button
                key={q}
                type="button"
                className="ios-quick"
                disabled={loading}
                onClick={() => sendMessage(q)}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
        <div className="ios-compose-row">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder="输入你想问的问题…"
            disabled={loading}
            aria-label="追问内容"
            className="ios-compose-input"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="ios-send"
            aria-label="发送追问"
            title="发送追问"
          >
            {loading ? <span className="ios-send-dot" /> : (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            )}
          </button>
        </div>
      </div>

    </div>
  );
}
