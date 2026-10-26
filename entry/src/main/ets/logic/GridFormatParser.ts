/**
 * 网格式课表解析。移植自 Android `pdf/GridFormatParser.kt`。
 *
 * 版式：`时间段 | 节次 | 星期一 … 星期日`，单元格内是若干门课：
 * "课程名（可能折成两行）" + "(N-M节)周次/地点/教师[更多字段]"（可能折行续行）。
 *
 * 三条实测要点：
 * 1. 星期表头水平等距，**列边界 = 相邻表头中心的中点**，与矢量表格线完全吻合
 *    → 用"文本块中心 x 落在哪一列"判星期；
 * 2. 课程名以类别符号 `★☆◆■〇` 结尾 —— 天然锚点，用来区分"新课程名"与"详情续行"；
 * 3. 节次范围直接取自单元格文本里的 "(N-M节)"，不依赖行高几何。
 *
 * 三处 M7 修正（都用真文件回归验证过）：
 * 1. **多页**：每页 y 从自己页顶重新开始 → ①过滤要用"该页自己的表头基线"，②列内排序键用 (page, y)；
 * 2. **折行课名**判定不能只看"下一行带标记"：详情续行后面紧跟的正是下一门课的课名，
 *    所以还要加"本行必须不像详情续行"（见 [looksLikeTail]）；
 * 3. **详情字段个数因校而异**（3 段 / 7 段）→ 规则在 [ParsingUtils.parseGridDetail]。
 */
import {
  type PdfTextRun,
  type ParseResult,
  type RawCourse,
  centerXOf,
  compareByPageThenY,
  emptyResult,
} from './PdfModels.ts';
import { ParsingUtils } from './ParsingUtils.ts';

/** "(3-4节)周次/地点/教师…" */
const DETAIL = /^\(?(\d{1,2})\s*[-~]\s*(\d{1,2})\s*节\)?\s*(.*)$/;

/** 班级号形如 2401/2402，出现在详情续行里 */
const CLASS_NO = /\d{4}/;

/** 详情的尾部字段关键字 */
const TAIL_FIELD = /学分|考试|考查|学时/;

/**
 * 被折行截断的纯数值尾巴：`:1.0`、`分:4.0`、`学分:3.0`、`:80`。
 *
 * 两种形态：冒号前没有汉字（`:1.0`），或冒号前只有学分/学时的字段名（`分:4.0`）。
 * 正常短课名（`体育Ⅲ-网球`、`3D打印`）不带"冒号+数字"，不会被误伤。
 */
const PURE_NUMBER_TAIL = /^(?:(?:学分|学时|周学时|总学时|理论|实验|分|时)?[:：][\d.]*|[\d.]+)$/;

interface HeaderHit {
  readonly day: number;
  readonly run: PdfTextRun;
}

export class GridFormatParser {
  static parse(runs: PdfTextRun[]): ParseResult {
    const hits: HeaderHit[] = [];
    for (const r of runs) {
      const day = ParsingUtils.dayIndexFromLabel(r.text);
      if (day !== null) {
        hits.push({ day, run: r });
      }
    }
    hits.sort((a, b) => centerXOf(a.run) - centerXOf(b.run));
    if (hits.length < 3) {
      return emptyResult(ParsingUtils.FORMAT_GRID, ['未找到星期表头']);
    }

    const days: number[] = hits.map((h) => h.day);
    const centers: number[] = hits.map((h) => centerXOf(h.run));
    const halfGap = centers.length > 1 ? (centers[1] - centers[0]) / 2 : 50;

    const bounds: number[] = [];
    bounds.push(centers[0] - halfGap);
    for (let i = 0; i + 1 < centers.length; i++) {
      bounds.push((centers[i] + centers[i + 1]) / 2);
    }
    bounds.push(centers[centers.length - 1] + halfGap);

    // 表头行以上（标题、学号）与页脚（图例、打印时间）都不是课程。
    // **必须按页各算基线**：第 2 页没有表头且 y 从头开始，用第 1 页的 headerY 过滤
    // 会把第 2 页靠上的行整段丢掉（实测踩过）。
    const headerYByPage = new Map<number, number>();
    for (const h of hits) {
      headerYByPage.set(h.run.page, h.run.y);
    }

    const body: PdfTextRun[] = [];
    for (const r of runs) {
      const cx = centerXOf(r);
      if (cx < bounds[0] || cx >= bounds[bounds.length - 1]) {
        continue;
      }
      if (r.text.indexOf('打印时间') >= 0) {
        continue;
      }
      if (ParsingUtils.LEGEND.test(r.text)) {
        continue;
      }
      if (ParsingUtils.dayIndexFromLabel(r.text) !== null) {
        continue;
      }
      const headerY = headerYByPage.get(r.page);
      if (headerY !== undefined && !(r.y > headerY + 1)) {
        continue;
      }
      body.push(r);
    }

    const courses: RawCourse[] = [];
    const warnings: string[] = [];
    for (let i = 0; i < days.length; i++) {
      const column: PdfTextRun[] = [];
      for (const r of body) {
        const cx = centerXOf(r);
        if (cx >= bounds[i] && cx < bounds[i + 1]) {
          column.push(r);
        }
      }
      // 排序键 = (页, y)：跨页被切断的单元格因此自动接上
      column.sort(compareByPageThenY);
      const skipped: string[] = [];
      for (const c of GridFormatParser.parseColumn(days[i], column, skipped)) {
        courses.push(c);
      }
      if (skipped.length > 0) {
        // 以前这类格子是**静默丢掉**的：用户在预览里只看到"少了门课"，
        // 根本不知道是没认出来还是 PDF 里就没有。宁可多一行提示。
        warnings.push(
          '周' + GridFormatParser.dayNameOf(days[i]) + '有 ' + skipped.length +
            ' 个格子只认出课名、没认出上课时间，已跳过：' + skipped.join('、')
        );
      }
    }

    const result: ParseResult = { courses, format: ParsingUtils.FORMAT_GRID, warnings: warnings };
    return result;
  }

  /** 1..7 → 一..日（提示文案用） */
  private static dayNameOf(day: number): string {
    const names: string[] = ['一', '二', '三', '四', '五', '六', '日'];
    return day >= 1 && day <= 7 ? names[day - 1] : String(day);
  }

  /**
   * 逐列扫描。状态机：
   * - 含类别符号的行 → 课程名（若已有详情在收集，说明上一门课结束，先落库）
   * - 匹配 "(N-M节)…" 的行 → 该门课的详情开始
   * - 其余行 → 详情已在收集则并入详情（折行续行），否则并入课程名（名字折成两行）
   */
  private static parseColumn(day: number, lines: PdfTextRun[], skipped: string[]): RawCourse[] {
    const out: RawCourse[] = [];
    let name = '';
    let detail: string | null = null;
    let startPeriod = 0;
    let endPeriod = 0;

    const flush = (): void => {
      const d = detail;
      if (d !== null) {
        const cleaned = ParsingUtils.cleanName(name);
        const cleanName = cleaned[0];
        const category = cleaned[1];
        const fields = ParsingUtils.parseGridDetail(d);
        if (cleanName.length > 0 || fields.weekMask !== 0n) {
          const course: RawCourse = {
            name: cleanName.length > 0 ? cleanName : ParsingUtils.UNNAMED_COURSE,
            teacher: fields.teacher,
            location: fields.location,
            category,
            schedules: [
              {
                dayOfWeek: day,
                startPeriod: Math.max(1, startPeriod),
                endPeriod: Math.max(1, endPeriod),
                weekMask: fields.weekMask,
                classGroup: fields.classGroup,
              },
            ],
          };
          out.push(course);
        }
      } else if (name.trim().length > 0) {
        // 有课名、但整格都没出现 "第N-M节…" 那一行 → 画不出来。以前直接丢，
        // 现在把课名抛给调用方汇总成一条警告。
        const cleanedName = ParsingUtils.cleanName(name);
        const shown: string = cleanedName[0].length > 0 ? cleanedName[0] : name.trim();
        skipped.push(shown);
      }
      name = '';
      detail = null;
    };

    for (let index = 0; index < lines.length; index++) {
      const t = lines[index].text.trim();
      if (t.length === 0) {
        continue;
      }
      const m = DETAIL.exec(t);
      if (ParsingUtils.hasMarker(t)) {
        if (detail !== null) {
          flush();
        }
        name += t;
      } else if (m !== null) {
        if (detail !== null) {
          flush();
        }
        startPeriod = Number.parseInt(m[1], 10);
        endPeriod = Number.parseInt(m[2], 10);
        detail = m[3];
      } else if (detail === null) {
        // 课程名的第一行（类别符号在最后一行，所以名字可能折成两行）
        name += t;
      } else {
        // 折行课名的第一行 = "下一行以类别符号结尾" **且** 本行不像详情续行。
        // 只看下一行不够：详情续行 "智慧教室/杨英法" 后面紧跟的就是下一门课的课名，
        // 只按下一行判断会把续行误当课名首行，名字被污染成 "智慧教室/杨英法数据结构（B）"。
        let next = '';
        for (let k = index + 1; k < lines.length; k++) {
          const nt = lines[k].text.trim();
          if (nt.length > 0) {
            next = nt;
            break;
          }
        }
        if (ParsingUtils.hasMarker(next) && !GridFormatParser.looksLikeTail(t)) {
          flush();
          name += t;
        } else {
          detail = detail + t;
        }
      }
    }
    flush();
    return out;
  }

  /**
   * 这行像不像"上一门课详情的续行"？
   * 实测两所学校折行方式不同，所以判定要多看几眼：含斜杠、含班级号（4 位数字）、
   * 含分号、含"学分/考试/考查/学时"字样，或很短（教师名尾字如"琪""雪华"）。
   */
  static looksLikeTail(text: string): boolean {
    if (text.indexOf('/') >= 0) {
      return true;
    }
    if (CLASS_NO.test(text)) {
      return true;
    }
    if (text.indexOf(';') >= 0 || text.indexOf('；') >= 0) {
      return true;
    }
    if (TAIL_FIELD.test(text)) {
      return true;
    }
    // 被折行截断的纯数值尾巴（`:1.0`、`分:4.0`、`:80`）。
    //
    // 真实课表实测的形态：一格的信息块最后一行是 `…/总学时:16/学分`，学分值被折到下一行变成
    // 孤立的 `:1.0`。它下面紧跟的就是**下一门课的名字**，于是旧逻辑把它当成了课名首行，
    // 名字变成 `:1.0算法分析与设计` —— 课名一脏，后面的"按名称归并"也就合并不了，
    // 同一门课的两次课会变成两门课（真实课表 22 门里 7 门被这样污染）。
    if (PURE_NUMBER_TAIL.test(text)) {
      return true;
    }
    return text.length <= 2;
  }
}
