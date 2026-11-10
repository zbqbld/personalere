'use client';

/**
 * 起盘历史 hook —— 基于按用户维度的档案库（lib/ziwei/user-profiles.ts）
 *
 * 与旧实现的差异（对应保存要求）：
 *  - id 曾是 Date.now()，同一毫秒重复提交会撞号；现在 id = 稳定 userId。
 *  - 旧去重键为「出生年月日 + 性别 + 时分」，不同用户同生辰会互相覆盖；
 *    现在以 userId 为唯一键，内容指纹决定 created / updated / duplicate。
 *  - 旧实现 slice(0, 10) 会静默丢弃第 11 个用户；现在不截断，超出容量时
 *    明确拒绝新增（见 MAX_PROFILES / STORE_FULL）。
 *  - 旧实现在 setState updater 内直接写 localStorage（React 严格模式下会
 *    重复执行副作用），且读取时 JSON.parse 无校验；现在统一由存储层做
 *    「读最新快照 → 计算 → 单次写入」，写入后再刷新内存，并监听 storage
 *    事件同步其它标签页，保证多次保存后内存与磁盘状态一致。
 *
 * 对外兼容：仍返回 { history, save, remove }；另有批量 / 按用户更新 / 查询
 * / 重载能力。HistoryEntry 保留 id / label / form / savedAt 四个原字段。
 */
import { useCallback, useEffect, useState } from 'react';
import type { BirthFormState } from '@/components/BirthForm';
import { PROFILES_KEY } from '@/lib/ziwei/memory';
import {
  type ProfileInput,
  type ProfileResult,
  type SaveResult,
  type UserProfile,
  getUserProfile,
  listUserProfiles,
  removeUserProfile,
  saveUserProfiles,
  updateUserProfile,
} from '@/lib/ziwei/user-profiles';

export interface HistoryEntry {
  /** 稳定用户主键（旧版为时间戳） */
  id: string;
  userId: string;
  label: string;
  form: BirthFormState;
  savedAt: number;
  revision: number;
}

function toEntry(p: UserProfile): HistoryEntry {
  return {
    id: p.userId,
    userId: p.userId,
    label: p.label,
    form: p.form,
    savedAt: p.updatedAt,
    revision: p.revision,
  };
}

export function useHistory() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const reload = useCallback(() => {
    setHistory(listUserProfiles().map(toEntry));
  }, []);

  useEffect(() => {
    reload();
    // 其它标签页写入同一键时同步，避免两个窗口各自持有过期快照互相覆盖
    const onStorage = (e: StorageEvent) => {
      if (e.key === PROFILES_KEY || e.key === null) reload();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [reload]);

  /** 保存单个用户；返回结构化结果（校验错误、去重状态均在 result 中） */
  const save = useCallback((form: BirthFormState, userId?: string): ProfileResult => {
    const result = saveUserProfiles([{ userId, form }]).results[0];
    reload();
    return result;
  }, [reload]);

  /** 批量新增 / 批量更新，一次写入 */
  const saveMany = useCallback((inputs: ProfileInput[]): SaveResult => {
    const result = saveUserProfiles(inputs);
    reload();
    return result;
  }, [reload]);

  /** 按用户更新：只修改指定 userId 的字段 */
  const update = useCallback((userId: string, patch: Partial<BirthFormState>): ProfileResult => {
    const result = updateUserProfile(userId, patch);
    reload();
    return result;
  }, [reload]);

  const remove = useCallback((id: string): boolean => {
    const ok = removeUserProfile(id);
    reload();
    return ok;
  }, [reload]);

  const getByUser = useCallback((userId: string): HistoryEntry | null => {
    const profile = getUserProfile(userId);
    return profile ? toEntry(profile) : null;
  }, []);

  return { history, save, saveMany, update, remove, getByUser, reload };
}
