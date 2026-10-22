/**
 * 时间冲突判定与"并排车道"。移植自 Android
 * `HomeViewModel.markConflicts` + `WeekGrid.lanesFor`。
 *
 * 背景：同一格同一周出现两门时间重叠的课时，
 * - 以前是叠着画，看着像一块，光看格子发现不了冲突；
 * - 现在**并排各占一半宽**画出来，并在详情卡里点名"与《X》上课时间重叠"。
 */

/** 参与冲突计算的最小信息（课程与自定义安排都满足） */
export interface GridSlot {
  readonly dayOfWeek: number;
  readonly startPeriod: number;
  readonly endPeriod: number;
  readonly title: string;
}

export interface ConflictMark {
  /** 与它时间重叠的其他条目名称（去重）。空数组 = 不冲突 */
  readonly conflicts: string[];
}

/** 每条"道"的分配结果：道号（从 0 开始）与该簇的总道数 */
export interface Lane {
  readonly lane: number;
  readonly laneCount: number;
}

export class Conflicts {
  /** 标出同一格里**时间重叠**的条目（同一周内两两区间相交判断） */
  static markConflicts(items: GridSlot[]): ConflictMark[] {
    const partners: string[][] = [];
    for (let i = 0; i < items.length; i++) {
      partners.push([]);
    }
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        if (a.dayOfWeek !== b.dayOfWeek) {
          continue;
        }
        const overlap = a.startPeriod <= b.endPeriod && b.startPeriod <= a.endPeriod;
        if (!overlap) {
          continue;
        }
        if (!partners[i].includes(b.title)) {
          partners[i].push(b.title);
        }
        if (!partners[j].includes(a.title)) {
          partners[j].push(a.title);
        }
      }
    }
    const out: ConflictMark[] = [];
    for (const p of partners) {
      const mark: ConflictMark = { conflicts: p };
      out.push(mark);
    }
    return out;
  }

  /**
   * 给同一格里**时间重叠**的条目分配"道"，让它们并排显示。
   *
   * 做法：按天把条目按开始节次排序，时间上连通的归为一簇；簇内依次找"已经结束的道"占位，
   * 道数 = 该簇最多同时重叠的条目数。不冲突的条目不属于任何簇 → 单道、占满整格宽度。
   *
   * 按 (开始节次, 结束节次, 标题) 排序，保证渲染结果**稳定可复现**，与数据库返回顺序无关。
   */
  static lanesFor(items: GridSlot[]): Lane[] {
    const out: Lane[] = [];
    for (let i = 0; i < items.length; i++) {
      const init: Lane = { lane: 0, laneCount: 1 };
      out.push(init);
    }

    const byDay = new Map<number, number[]>();
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const list = byDay.get(item.dayOfWeek);
      if (list === undefined) {
        byDay.set(item.dayOfWeek, [index]);
      } else {
        list.push(index);
      }
    }

    byDay.forEach((indexes: number[]) => {
      const order = indexes.slice().sort((x: number, y: number): number => {
        const a = items[x];
        const b = items[y];
        if (a.startPeriod !== b.startPeriod) {
          return a.startPeriod - b.startPeriod;
        }
        if (a.endPeriod !== b.endPeriod) {
          return a.endPeriod - b.endPeriod;
        }
        return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
      });

      let cluster: number[] = [];
      let clusterEnd = 0;

      const flush = (): void => {
        if (cluster.length === 0) {
          return;
        }
        const laneEnds: number[] = [];
        const assignedIndexes: number[] = [];
        const assignedLanes: number[] = [];
        for (const i of cluster) {
          const sp = items[i].startPeriod;
          let lane = -1;
          for (let k = 0; k < laneEnds.length; k++) {
            if (laneEnds[k] < sp) {
              lane = k;
              break;
            }
          }
          if (lane < 0) {
            lane = laneEnds.length;
            laneEnds.push(0);
          }
          laneEnds[lane] = items[i].endPeriod;
          assignedIndexes.push(i);
          assignedLanes.push(lane);
        }
        for (let k = 0; k < assignedIndexes.length; k++) {
          const result: Lane = { lane: assignedLanes[k], laneCount: laneEnds.length };
          out[assignedIndexes[k]] = result;
        }
        cluster = [];
      };

      for (const i of order) {
        if (cluster.length > 0 && items[i].startPeriod > clusterEnd) {
          flush();
        }
        cluster.push(i);
        clusterEnd = Math.max(clusterEnd, items[i].endPeriod);
      }
      flush();
    });

    return out;
  }

  /** 某条目是否冲突（便于渲染判断） */
  static hasConflict(mark: ConflictMark): boolean {
    return mark.conflicts.length > 0;
  }
}
