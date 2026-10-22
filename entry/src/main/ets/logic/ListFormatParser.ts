/**
 * 列表式课表解析。移植自 Android `pdf/ListFormatParser.kt`。
 *
 * 版式：`星期（跨行）| 节次 | 课程名 | 详情（周数/地点/教师/…）`
 *
 * 两条实测要点：
 * 1. 详情每门课占两行且**折行会打断字段标签**（"考核方" + "式:考试"），
 *    所以同一详情块的多行必须**无分隔拼接**后再按标签取值；
 * 2. 星期标签竖跨多行、节次标签居中于**合并单元格**，两者都是"居中标签 + 内容成组"结构。
 *    当某格叠了多门课（样本里周四 5-6 节叠 3 门）时，"就近取标签"与"中点切分"都会分错
 *    （实测最后一门课中心距周五标签 21pt、距周四标签 29pt，就近会错分到周五；
 *    相邻标签中点又会切进合并单元格内部）。因此星期与节次两级归属都用
 *    **最小偏差连续分组**（见 [assignGroups]），把"一组内容围绕自己的标签聚拢"显式建模。
 */
import {
  type PdfTextRun,
  type ParseResult,
  type RawCourse,
  emptyResult,
} from './PdfModels.ts';
import { ParsingUtils } from './ParsingUtils.ts';

/** "5-6" 这类节次标签 */
const PERIOD_LABEL = /^(\d{1,2})\s*[-~]\s*(\d{1,2})$/;

interface DayLabel {
  readonly day: number;
  readonly y: number;
}

interface PeriodLabel {
  readonly start: number;
  readonly end: number;
  readonly y: number;
}

interface FloatRange {
  readonly low: number;
  readonly high: number;
}

/** 一门课的详情块（可含折行；centerY 取各行 y 的平均） */
class DetailBlock {
  text: string;
  private sumY: number;
  private lines: number;

  constructor(initial: string, y: number) {
    this.text = initial;
    this.sumY = y;
    this.lines = 1;
  }

  get centerY(): number {
    return this.sumY / this.lines;
  }

  append(more: string, lineY: number): void {
    this.text += more;
    this.sumY += lineY;
    this.lines++;
  }
}

interface PairedBlock {
  readonly name: string;
  readonly block: DetailBlock;
}

export class ListFormatParser {
  static parse(runs: PdfTextRun[]): ParseResult {
    const warnings: string[] = [];

    const dayLabels: DayLabel[] = [];
    for (const r of runs) {
      const d = ParsingUtils.dayIndexFromLabel(r.text);
      if (d !== null) {
        dayLabels.push({ day: d, y: r.y });
      }
    }
    dayLabels.sort((a, b) => a.y - b.y);
    if (dayLabels.length === 0) {
      return emptyResult(ParsingUtils.FORMAT_LIST, ['未找到星期列']);
    }

    // 详情列起点：所有含"周数"的块里最靠左的 x（列划分由数据自身推导，不写死坐标）
    let detailX: number | null = null;
    for (const r of runs) {
      if (r.text.indexOf('周数') >= 0) {
        if (detailX === null || r.x < detailX) {
          detailX = r.x;
        }
      }
    }
    if (detailX === null) {
      return emptyResult(ParsingUtils.FORMAT_LIST, ['未找到课程详情行（周数）']);
    }

    const periodRuns: PdfTextRun[] = [];
    let periodMaxX = 0;
    for (const r of runs) {
      if (PERIOD_LABEL.test(r.text)) {
        periodRuns.push(r);
        periodMaxX = Math.max(periodMaxX, r.endX);
      }
    }

    const nameRuns: PdfTextRun[] = [];
    const detailRuns: PdfTextRun[] = [];
    for (const r of runs) {
      if (r.x > periodMaxX && r.x < detailX - 1) {
        nameRuns.push(r);
      } else if (r.x >= detailX - 1) {
        detailRuns.push(r);
      }
    }

    // 1) 详情块：以含"周数"的行开头，其后的折行并入同一块
    const blocks: DetailBlock[] = [];
    detailRuns.sort((a, b) => a.y - b.y);
    for (const r of detailRuns) {
      const last = blocks.length > 0 ? blocks[blocks.length - 1] : null;
      if (last !== null && r.text.indexOf('周数') < 0) {
        last.append(r.text, r.y);
      } else {
        blocks.push(new DetailBlock(r.text, r.y));
      }
    }
    const validBlocks: DetailBlock[] = [];
    for (const b of blocks) {
      if (b.text.indexOf('周数') >= 0) {
        validBlocks.push(b);
      }
    }
    if (validBlocks.length === 0) {
      return emptyResult(ParsingUtils.FORMAT_LIST, ['未找到课程详情行（周数）']);
    }

    // 2) 课程名 ↔ 详情块：全局按 y 就近配对（同一行的课程名与详情块中心几乎重合）
    const names: PdfTextRun[] = nameRuns.slice().sort((a, b) => a.y - b.y);
    const ordered: PairedBlock[] = [];
    for (const b of validBlocks) {
      if (names.length === 0) {
        continue;
      }
      let bestIdx = -1;
      let bestDelta = Number.MAX_VALUE;
      for (let i = 0; i < names.length; i++) {
        const delta = Math.abs(names[i].y - b.centerY);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) {
        continue;
      }
      ordered.push({ name: names[bestIdx].text, block: b });
      names.splice(bestIdx, 1);
    }
    if (ordered.length < validBlocks.length) {
      warnings.push(`有 ${validBlocks.length - ordered.length} 条课程详情没有匹配到课程名`);
    }
    ordered.sort((a, b) => a.block.centerY - b.block.centerY);

    // 3) 课程 → 星期（最小偏差连续分组）
    const dayIndex = ListFormatParser.assignGroups(
      ordered.map((o) => o.block.centerY),
      dayLabels.map((d) => d.y)
    );

    // 4) 每个节次标签归给距离最近的那一天（用各星期课程的 y 范围衡量距离）
    const extents = new Map<number, FloatRange>();
    for (let i = 0; i < dayIndex.length; i++) {
      const d = dayIndex[i];
      const y = ordered[i].block.centerY;
      const cur = extents.get(d);
      if (cur === undefined) {
        extents.set(d, { low: y, high: y });
      } else {
        extents.set(d, { low: Math.min(cur.low, y), high: Math.max(cur.high, y) });
      }
    }

    const distanceToDay = (y: number, dayIdx: number): number => {
      const e = extents.get(dayIdx);
      if (e === undefined) {
        return Number.MAX_VALUE;
      }
      if (y < e.low) {
        return e.low - y;
      }
      if (y > e.high) {
        return y - e.high;
      }
      return 0;
    };

    const labels: PeriodLabel[] = [];
    for (const r of periodRuns) {
      const m = PERIOD_LABEL.exec(r.text);
      if (m !== null) {
        labels.push({
          start: Number.parseInt(m[1], 10),
          end: Number.parseInt(m[2], 10),
          y: r.y,
        });
      }
    }
    labels.sort((a, b) => a.y - b.y);

    // 节次标签 → 归属星期（取距离最近的一天）
    const labelOwner: number[] = [];
    for (const l of labels) {
      let owner = 0;
      let best = Number.MAX_VALUE;
      const dayKeys: number[] = [];
      extents.forEach((v: FloatRange, k: number) => dayKeys.push(k));
      for (const k of dayKeys) {
        const dist = distanceToDay(l.y, k);
        if (dist < best) {
          best = dist;
          owner = k;
        }
      }
      labelOwner.push(owner);
    }

    // 5) 每个星期内部：课程 → 节次（同样用最小偏差连续分组）
    const result: RawCourse[] = [];
    const dayKeysAll: number[] = [];
    for (let i = 0; i < dayIndex.length; i++) {
      if (dayKeysAll.indexOf(dayIndex[i]) < 0) {
        dayKeysAll.push(dayIndex[i]);
      }
    }
    for (const dayIdx of dayKeysAll) {
      const courseIdxList: number[] = [];
      for (let i = 0; i < dayIndex.length; i++) {
        if (dayIndex[i] === dayIdx) {
          courseIdxList.push(i);
        }
      }
      const dayLabel = dayIdx >= 0 && dayIdx < dayLabels.length ? dayLabels[dayIdx] : null;
      if (dayLabel === null) {
        continue;
      }
      const day = dayLabel.day;

      const labelsForDay: PeriodLabel[] = [];
      for (let i = 0; i < labels.length; i++) {
        if (labelOwner[i] === dayIdx) {
          labelsForDay.push(labels[i]);
        }
      }
      if (labelsForDay.length === 0) {
        warnings.push(`周${day} 没有找到节次标签，节次暂按第 1 节处理`);
      }

      courseIdxList.sort((a, b) => a - b);
      const centers = courseIdxList.map((ci) => ordered[ci].block.centerY);
      const assigned = ListFormatParser.assignGroups(
        centers,
        labelsForDay.map((l) => l.y)
      );

      for (let k = 0; k < courseIdxList.length; k++) {
        const entry = ordered[courseIdxList[k]];
        const cleaned = ParsingUtils.cleanName(entry.name);
        const cleanName = cleaned[0];
        const category = cleaned[1];
        const fields = ParsingUtils.parseListDetail(entry.block.text);
        const pos = k < assigned.length ? assigned[k] : 0;
        const period = pos >= 0 && pos < labelsForDay.length ? labelsForDay[pos] : null;

        // 名字缺失时保留条目（占位名）而不是丢弃：宁可让用户在确认页看到一条
        // 可疑记录去改/取消，也不要静默少一门课
        const course: RawCourse = {
          name: cleanName.length > 0 ? cleanName : ParsingUtils.UNNAMED_COURSE,
          teacher: fields.teacher,
          location: fields.location,
          category,
          schedules: [
            {
              dayOfWeek: day,
              startPeriod: period !== null ? period.start : 1,
              endPeriod: period !== null ? period.end : 1,
              weekMask: fields.weekMask,
            },
          ],
        };
        result.push(course);
      }
    }

    const out: ParseResult = { courses: result, format: ParsingUtils.FORMAT_LIST, warnings };
    return out;
  }

  /**
   * 把按 y 排序的条目切成与标签数量相同的**连续**分组，使各组中心与对应标签的 y 偏差之和最小
   * （动态规划），返回每个条目所属的标签下标。
   *
   * 为什么不用"就近取标签"或"中点切分"：标签居中于高度可变的合并单元格，
   * 单元格内容多时会被拉长，一旦跨过中点就会整组错分。连续分组把
   * "一组内容围绕自己的标签聚拢"这一结构约束显式建模。
   */
  static assignGroups(centers: number[], labelYs: number[]): number[] {
    const n = centers.length;
    const m = labelYs.length;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(0);
    }
    if (n === 0) {
      return [];
    }
    if (m === 0) {
      return out;
    }

    const nearest = (y: number): number => {
      let idx = 0;
      let best = Number.MAX_VALUE;
      for (let i = 0; i < labelYs.length; i++) {
        const d = Math.abs(labelYs[i] - y);
        if (d < best) {
          best = d;
          idx = i;
        }
      }
      return idx;
    };

    if (n < m) {
      return centers.map(nearest);
    }

    const INF = Number.MAX_VALUE;
    const dp: number[][] = [];
    const from: number[][] = [];
    for (let k = 0; k <= m; k++) {
      const rowDp: number[] = [];
      const rowFrom: number[] = [];
      for (let i = 0; i <= n; i++) {
        rowDp.push(INF);
        rowFrom.push(-1);
      }
      dp.push(rowDp);
      from.push(rowFrom);
    }
    dp[0][0] = 0;

    for (let k = 1; k <= m; k++) {
      for (let i = k; i <= n; i++) {
        for (let j = k - 1; j < i; j++) {
          if (dp[k - 1][j] === INF) {
            continue;
          }
          let sum = 0;
          for (let t = j; t < i; t++) {
            sum += centers[t];
          }
          const cost = dp[k - 1][j] + Math.abs(sum / (i - j) - labelYs[k - 1]);
          if (cost < dp[k][i]) {
            dp[k][i] = cost;
            from[k][i] = j;
          }
        }
      }
    }

    if (dp[m][n] === INF) {
      return centers.map(nearest);
    }

    const result: number[] = [];
    for (let i = 0; i < n; i++) {
      result.push(0);
    }
    let i = n;
    for (let k = m; k >= 1; k--) {
      const j = from[k][i];
      if (j < 0) {
        return centers.map(nearest);
      }
      for (let t = j; t < i; t++) {
        result[t] = k - 1;
      }
      i = j;
    }
    return result;
  }
}
