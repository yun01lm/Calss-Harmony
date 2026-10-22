/**
 * 启动时该打开哪张课表 —— 纯规则，零平台依赖（可在 Node 上直接断言）。
 *
 * 与 Android 版 `ScheduleRepository.pickStartupTimetable` 的语义一致：
 * 1. 一张课表都没有 → null（调用方负责补建默认课表）；
 * 2. 用户勾了"启动时总是打开主课表" **且确实有主课表** → 用主课表；
 *    （勾了但一张主课表都没标 → 退回"上次用的那张"，否则每次启动都进同一张，反而更怪）
 * 3. 否则用上次用的那张（存在的话）；
 * 4. 再否则用主课表，最后兜底第一张（按创建时间）。
 */
export interface TimetableChoice {
  readonly id: number;
  readonly isPrimary: boolean;
  readonly createdAt: number;
}

export function pickStartupTimetable(
  all: TimetableChoice[],
  lastId: number | null,
  openPrimary: boolean
): number | null {
  if (all.length === 0) {
    return null;
  }

  const sorted = all.slice().sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    return a.id - b.id;
  });

  const primary = sorted.find((t) => t.isPrimary) ?? null;

  if (openPrimary && primary !== null) {
    return primary.id;
  }

  if (lastId !== null) {
    const found = sorted.find((t) => t.id === lastId);
    if (found !== undefined) {
      return found.id;
    }
  }

  if (primary !== null) {
    return primary.id;
  }

  return sorted[0].id;
}
