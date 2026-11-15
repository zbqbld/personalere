/**
 * 旧解读会话的生辰回填
 *
 * 背景：2026-11-15 之前保存的解读会话没有 birthInfo 字段，工作台
 * 「最近解读」对它们只能删除、无法一键恢复命盘继续追问。
 *
 * 思路：每次起盘都会把生辰写入「用户档案」（user-profiles），档案里的表单
 * 与当初生成会话 key 用的表单相同，因此用 formToBirthInfo(form) 重算会话
 * key，命中同一段旧会话就补写 birthInfo。对不上任何档案的旧会话保持原样。
 *
 * 幂等：已带 birthInfo 的会话直接跳过，可反复执行。
 */
import {
  chatKeyForBirth,
  chatStorageKey,
  loadLastBirth,
  normalizeChatBirth,
  scopedKey,
  CHAT_KEY_PREFIX,
} from './memory';
import { formToBirthInfo } from './share';
import { listUserProfiles } from './user-profiles';

export function backfillChatBirthInfo(): number {
  if (typeof window === 'undefined') return 0;
  const prefix = scopedKey(CHAT_KEY_PREFIX);
  if (!prefix) return 0;

  const forms = listUserProfiles().map((p) => p.form);
  const last = loadLastBirth();
  if (last?.form) forms.push(last.form);
  if (forms.length === 0) return 0;

  let fixed = 0;
  try {
    for (const form of forms) {
      let birthInfo;
      try {
        birthInfo = formToBirthInfo(form);
      } catch {
        continue; // 档案表单异常，跳过这份
      }
      const key = chatKeyForBirth(birthInfo);
      const storageKey = chatStorageKey(key);
      let raw: string | null = null;
      try {
        raw = window.localStorage.getItem(storageKey);
      } catch {
        return fixed; // 存储被禁，直接放弃本轮
      }
      if (!raw) continue; // 该生辰名下没有会话
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (!parsed || parsed.version !== 1 || parsed.birthInfo) continue;
        const normalized = normalizeChatBirth(birthInfo);
        if (!normalized) continue;
        parsed.birthInfo = normalized;
        window.localStorage.setItem(storageKey, JSON.stringify(parsed));
        fixed++;
      } catch {
        continue; // 损坏数据跳过
      }
    }
  } catch {
    return fixed; // 隐私模式 / 配额异常时静默降级
  }
  return fixed;
}
