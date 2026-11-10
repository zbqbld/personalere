/**
 * 对话轮次与删除范围回归测试
 *
 * 锁定删除功能的语义边界：一问一答（含隐藏的自动提问）是一个不可分割的
 * 删除单元；删除不改动其余消息；删除后从剩余消息重算长期事实，被删轮次
 * 设定的偏好不会残留在后续上下文中。
 */
import assert from 'node:assert/strict';
import { buildTurns, messagesWithoutTurn } from '../../lib/ziwei/chat-turns';
import { extractLongTermFacts, type ChatMessage } from '../../lib/ziwei/memory';

const u = (content: string, hidden = false): ChatMessage =>
  hidden ? { role: 'user', content, hidden } : { role: 'user', content };
const a = (content: string): ChatMessage => ({ role: 'assistant', content });

// 1) 普通一问一答 → 一轮
const simple = buildTurns([u('今年事业如何？'), a('命宫七杀，宜技术。')]);
assert.equal(simple.length, 1);
assert.equal(simple[0].start, 0);
assert.equal(simple[0].end, 1);
assert.equal(simple[0].visible, true);
assert.equal(simple[0].user!.content, '今年事业如何？');
assert.equal(simple[0].assistant!.content, '命宫七杀，宜技术。');

// 2) 隐藏的自动话题提问仍与其回复同轮，且因回复有内容而可见
const hiddenTurn = buildTurns([u('请生成命格总览', true), a('命格总览如下…')]);
assert.equal(hiddenTurn.length, 1);
assert.equal(hiddenTurn[0].user!.hidden, true);
assert.equal(hiddenTurn[0].visible, true, '隐藏提问的回复必须仍可显示');

// 3) 多个 user 连续出现时正确切分；悬空回复单独成轮
const mixed = buildTurns([
  u('问题一'), a('回答一'),
  u('问题二', true), a('回答二'),
  a('悬空回复'),
  u('问题三'),
]);
assert.equal(mixed.length, 4);
assert.deepEqual(mixed.map(t => t.start), [0, 2, 4, 5]);
assert.equal(mixed[3].assistant, undefined, '末尾未回复的提问仍占一轮');

// 4) 空回复 + 隐藏提问 → 不可见
const invisible = buildTurns([u('自动提问', true), a('   ')]);
assert.equal(invisible[0].visible, false, '空白回复不应渲染');

// 5) 删除整轮：隐藏提问一并移除，其余消息顺序与内容不变
const messages: ChatMessage[] = [
  u('第一问'), a('第一答'),
  u('自动话题', true), a('第二答'),
  u('第三问'), a('第三答'),
];
const turns = buildTurns(messages);
assert.equal(turns.length, 3);
const remaining = messagesWithoutTurn(messages, turns[1]);
assert.deepEqual(remaining, [u('第一问'), a('第一答'), u('第三问'), a('第三答')]);
assert.equal(remaining.some(m => m.content === '自动话题'), false, '隐藏提问不得残留');

// 删除首尾轮同样只影响目标轮
assert.deepEqual(messagesWithoutTurn(messages, turns[0]), messages.slice(2));
assert.deepEqual(messagesWithoutTurn(messages, turns[2]), messages.slice(0, 4));

// 6) 删除后长期事实从剩余消息重算，被删轮次设定的偏好消失
const withPreference: ChatMessage[] = [
  u('请以后一直用简体回答'), a('好的。'),
  u('今年事业如何？'), a('命宫七杀。'),
];
const beforeFacts = extractLongTermFacts(withPreference);
assert.ok(beforeFacts.some(f => f.key === '语言'), '删除前应抽取到语言偏好');
const prefTurn = buildTurns(withPreference)[0];
const afterFacts = extractLongTermFacts(messagesWithoutTurn(withPreference, prefTurn));
assert.equal(afterFacts.length, 0, '删除该轮后偏好不得继续影响后续上下文');

console.log('chat-turns.test.ts: PASS (轮次切分 / 隐藏提问 / 悬空回复 / 整轮删除 / 长期事实重算)');
