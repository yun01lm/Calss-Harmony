/**
 * **课表截图** → 课程（OCR 文字带包围盒 → 7 列网格 → 课程）。
 *
 * 为什么单独一个模块：PDF 通道依赖 `(3-4节)1-16周/思源楼-301/张老师` 这种**结构化详情行**，
 * 而截图里通常只有"课名 + 教室"两三行字，没有任何周次信息 —— 两者不是同一类输入，
 * 硬塞进 `GridFormatParser` 会把两套规则搅在一起。
 *
 * ## 做法（四步）
 *
 * 1. **找表头**：`星期一`…`星期日`（也接受 `周一` / `一`）的 x 中心 → 7 个列的边界。
 * 2. **找节次列**：表头左侧、纯数字的行 → 每个节次的 y 中心 → 行边界。
 *    截图里节次列常常被裁掉，这时退化成"按文字行的纵向间隔分行"，并**明说**这么干了。
 * 3. **按列聚类**：同一列里 y 相邻的行聚成一格（间隔 > 行高 × 1.6 视为换了一格），
 *    这样"一门课跨两节"天然是一格，而不是被切成两门。
 * 4. **每格成课**：首行是课名；其余行里长得像教室的当教室、像人名的当教师。
 *    周次：截图里**没有**周次信息 → 默认覆盖整学期，并在警告里说清楚。
 *
 * ## 明说不猜
 *
 * 截图版式的差异比 PDF 大得多（有无节次列、有无日期、有没有表头）。所以这条通道
 * 的输出**只用于导入预览**，并且凡是"猜出来的东西"都进 warnings：
 * - 表头认不全 → 说认出几天；
 * - 没有节次列 → 说按顺序编号；
 * - 没有周次 → 说默认整学期。
 */
import { ParsingUtils } from './ParsingUtils.ts';
import { type OcrLine, TimetableTextParser } from './TimetableTextParser.ts';
import { type ParseResult, type RawCourse, type RawSchedule } from './PdfModels.ts';
import { WeekMasks } from './WeekMasks.ts';

/** 一列（某个星期）在图片里的横向范围 */
interface Column {
  readonly day: number;
  readonly left: number;
  readonly right: number;
}

/** 一行（某个节次）的纵向中心 */
interface Row {
  readonly period: number;
  readonly centerY: number;
}

/** 一格：同一列里纵向相邻的一串文字 */
interface Cell {
  readonly lines: OcrLine[];
  readonly top: number;
  readonly bottom: number;
}

/** 截图导入的版式名（预览里显示用） */
export const GRID_FROM_OCR_FORMAT = '课表截图';

export class GridFromOcr {
  /** 至少认出几天才认为"这是一张课表截图" */
  static readonly MIN_DAYS: number = 3;

  /** 行高估算的下限：字号很小或只有一行时也要有合理的"换格"阈值 */
  static readonly MIN_LINE_HEIGHT: number = 10;

  /**
   * 主入口。
   *
   * @param lines OCR 的原始行（带包围盒）
   * @param totalWeeks 当前课表的总周数：截图里没有周次，默认按整学期导入
   */
  static parse(lines: OcrLine[], totalWeeks: number): ParseResult {
    const warnings: string[] = [];
    const usable: OcrLine[] = [];
    for (const l of lines) {
      if (l.text.trim().length > 0) {
        usable.push(l);
      }
    }
    if (usable.length === 0) {
      return GridFromOcr.empty('这张图里没有识别到文字');
    }

    const headerY: number | null = GridFromOcr.headerRowCenterY(usable);
    const columns: Column[] = GridFromOcr.columns(usable, headerY);
    if (columns.length < GridFromOcr.MIN_DAYS) {
      return GridFromOcr.empty(
        '没认出星期表头（只找到 ' + columns.length + ' 天）：课表截图需要能看到"星期一…星期日"这一行'
      );
    }
    if (columns.length < 7) {
      warnings.push('只认出 ' + columns.length + ' 天的表头，其余天的课不会导入');
    }

    const dayLinePool: OcrLine[] = [];
    for (const l of usable) {
      if (GridFromOcr.dayOf(l.text) === null) {
        dayLinePool.push(l);
      }
    }

    const rows: Row[] = GridFromOcr.rows(dayLinePool, columns, warnings);
    const body: OcrLine[] = [];
    for (const l of dayLinePool) {
      // 节次列本身的数字不参与成格
      if (GridFromOcr.isPeriodNumber(l)) {
        continue;
      }
      if (GridFromOcr.dayOf(l.text) !== null) {
        continue;
      }
      body.push(l);
    }

    const courses: RawCourse[] = [];
    let missingWeeks = 0;
    for (const col of columns) {
      const own: OcrLine[] = [];
      for (const l of body) {
        const cx: number = GridFromOcr.centerX(l);
        if (cx >= col.left && cx < col.right) {
          own.push(l);
        }
      }
      own.sort((a: OcrLine, b: OcrLine) => a.centerY - b.centerY);
      for (const cell of GridFromOcr.cellsOf(own)) {
        const built: RawCourse | null = GridFromOcr.courseOf(cell, col.day, rows, totalWeeks);
        if (built === null) {
          continue;
        }
        if (GridFromOcr.hasExplicitWeeks(cell)) {
          courses.push(built);
        } else {
          missingWeeks++;
          courses.push(built);
        }
      }
    }

    if (missingWeeks > 0) {
      warnings.push(
        '截图里没有周次信息：' + missingWeeks + ' 门课按 1-' + totalWeeks + ' 周导入，请在导入后核对'
      );
    }
    if (courses.length === 0) {
      warnings.push('认出了表头，但格子里没有可用文字');
    }

    const result: ParseResult = {
      courses: courses,
      format: GRID_FROM_OCR_FORMAT,
      warnings: warnings,
    };
    return result;
  }

  // ---------------------------------------------------------------- 表头与列

  /** 表头行的 y 中心（有多个"星期X"时取它们 y 的中位数，避免被正文里偶尔出现的"周一"带偏） */
  private static headerRowCenterY(lines: OcrLine[]): number | null {
    const ys: number[] = [];
    for (const l of lines) {
      if (GridFromOcr.dayOf(l.text) !== null) {
        ys.push(l.centerY);
      }
    }
    if (ys.length === 0) {
      return null;
    }
    ys.sort((a: number, b: number) => a - b);
    return ys[Math.trunc(ys.length / 2)];
  }

  /** 表头文字 → 星期（比 `ParsingUtils.dayIndexFromLabel` 宽容：也认 `周一` / `一` / `周一 10/26`） */
  static dayOf(text: string): number | null {
    const exact: number | null = ParsingUtils.dayIndexFromLabel(text);
    if (exact !== null) {
      return exact;
    }
    const t: string = text.trim();
    const m = /^(?:星期|周|礼拜)?\s*([一二三四五六日天])(?:\s|$|\d)/.exec(t);
    if (m === null) {
      return null;
    }
    switch (m[1]) {
      case '一': return 1;
      case '二': return 2;
      case '三': return 3;
      case '四': return 4;
      case '五': return 5;
      case '六': return 6;
      default: return 7;
    }
  }

  /** 用表头的 x 中心切出列边界（相邻中心的中点；两端各外扩半个间距） */
  private static columns(lines: OcrLine[], headerY: number | null): Column[] {
    const found: Array<[number, number]> = [];
    for (const l of lines) {
      const day: number | null = GridFromOcr.dayOf(l.text);
      if (day === null) {
        continue;
      }
      // 只看表头那一带：正文里出现的"周一"是课程内容，不是表头
      if (headerY !== null && Math.abs(l.centerY - headerY) > Math.max(l.height, 24)) {
        continue;
      }
      found.push([day, GridFromOcr.centerX(l)]);
    }
    if (found.length === 0) {
      return [];
    }
    found.sort((a: [number, number], b: [number, number]) => a[1] - b[1]);
    // 同一天出现多次（表头折行）时只留最左的
    const byDay: Map<number, number> = new Map<number, number>();
    for (const [day, x] of found) {
      if (!byDay.has(day)) {
        byDay.set(day, x);
      }
    }
    const days: number[] = [];
    byDay.forEach((x: number, day: number) => {
      days.push(day);
    });
    days.sort((a: number, b: number) => GridFromOcr.centerOfX(byDay, a) - GridFromOcr.centerOfX(byDay, b));

    const centers: number[] = [];
    for (const d of days) {
      centers.push(GridFromOcr.centerOfX(byDay, d));
    }
    const out: Column[] = [];
    for (let i = 0; i < days.length; i++) {
      const left: number = i === 0
        ? centers[0] - (centers.length > 1 ? (centers[1] - centers[0]) / 2 : 100)
        : (centers[i - 1] + centers[i]) / 2;
      const right: number = i === days.length - 1
        ? centers[i] + (i > 0 ? (centers[i] - centers[i - 1]) / 2 : 100)
        : (centers[i] + centers[i + 1]) / 2;
      const col: Column = { day: days[i], left: left, right: right };
      out.push(col);
    }
    return out;
  }

  private static centerOfX(byDay: Map<number, number>, day: number): number {
    const x: number | undefined = byDay.get(day);
    return x === undefined ? 0 : x;
  }

  // ---------------------------------------------------------------- 节次行

  /**
   * 行：优先用表头左侧的纯数字（节次列）；没有就按"正文行的纵向间隔"退化分箱。
   *
   * 退化时会往 warnings 里写一条 —— 编号是我们编的，用户必须核对。
   */
  private static rows(body: OcrLine[], columns: Column[], warnings: string[]): Row[] {
    const leftEdge: number = columns.length > 0 ? columns[0].left : Number.MAX_SAFE_INTEGER;
    const numbered: OcrLine[] = [];
    for (const l of body) {
      if (GridFromOcr.isPeriodNumber(l) && GridFromOcr.centerX(l) < leftEdge) {
        numbered.push(l);
      }
    }
    const out: Row[] = [];
    if (numbered.length >= 3) {
      numbered.sort((a: OcrLine, b: OcrLine) => a.centerY - b.centerY);
      for (const l of numbered) {
        const p: number = Number.parseInt(l.text.trim(), 10);
        out.push({ period: p, centerY: l.centerY });
      }
      return out;
    }

    // 退化：把所有正文行按中心 y 排序，间隔明显变大就换一行
    const ys: number[] = [];
    for (const l of body) {
      if (GridFromOcr.centerX(l) >= leftEdge) {
        ys.push(l.centerY);
      }
    }
    ys.sort((a: number, b: number) => a - b);
    const centers: number[] = [];
    let last: number = -Number.MAX_SAFE_INTEGER;
    const gap: number = GridFromOcr.medianLineHeight(body) * 1.6;
    for (const y of ys) {
      if (centers.length === 0 || y - last > gap) {
        centers.push(y);
        last = y;
      }
    }
    for (let i = 0; i < centers.length; i++) {
      out.push({ period: i + 1, centerY: centers[i] });
    }
    warnings.push(
      '没认出节次列（左侧的 1、2、3…）：已按文字从上到下编号为 1-' + centers.length + ' 节，请核对'
    );
    return out;
  }

  private static isPeriodNumber(line: OcrLine): boolean {
    return /^\d{1,2}$/.test(line.text.trim());
  }

  private static medianLineHeight(lines: OcrLine[]): number {
    if (lines.length === 0) {
      return GridFromOcr.MIN_LINE_HEIGHT * 2;
    }
    const heights: number[] = [];
    for (const l of lines) {
      heights.push(l.height);
    }
    heights.sort((a: number, b: number) => a - b);
    const med: number = heights[Math.trunc(heights.length / 2)];
    return med < GridFromOcr.MIN_LINE_HEIGHT ? GridFromOcr.MIN_LINE_HEIGHT * 2 : med;
  }

  // ---------------------------------------------------------------- 成格

  /** 同一列里按纵向间隔切格：间隔超过行高 × 1.6 就算换了一格 */
  private static cellsOf(column: OcrLine[]): Cell[] {
    const out: Cell[] = [];
    if (column.length === 0) {
      return out;
    }
    const gap: number = GridFromOcr.medianLineHeight(column) * 1.6;
    let current: OcrLine[] = [];
    let lastBottom: number = -Number.MAX_SAFE_INTEGER;
    const flush = (): void => {
      if (current.length === 0) {
        return;
      }
      let top: number = current[0].top;
      let bottom: number = current[0].bottom;
      for (const l of current) {
        top = Math.min(top, l.top);
        bottom = Math.max(bottom, l.bottom);
      }
      const cell: Cell = { lines: current, top: top, bottom: bottom };
      out.push(cell);
      current = [];
    };
    for (const l of column) {
      if (current.length > 0 && l.top - lastBottom > gap) {
        flush();
      }
      current.push(l);
      lastBottom = l.bottom;
    }
    flush();
    return out;
  }

  /** 一格 → 课程（认不出课名就返回 null） */
  private static courseOf(
    cell: Cell,
    day: number,
    rows: Row[],
    totalWeeks: number
  ): RawCourse | null {
    const names: string[] = [];
    const extras: string[] = [];
    for (const l of cell.lines) {
      const t: string = l.text.trim();
      if (t.length === 0) {
        continue;
      }
      if (names.length === 0) {
        names.push(t);
      } else {
        extras.push(t);
      }
    }
    if (names.length === 0) {
      return null;
    }
    const cleaned = ParsingUtils.cleanName(names[0]);
    const name: string = cleaned[0].length > 0 ? cleaned[0] : names[0].trim();
    if (name.length === 0) {
      return null;
    }

    // 详情行里可能藏着 "(3-4节)1-16周/教室/老师" 这种结构化尾巴（有些截图是 PDF 打印稿）
    let weekMask: bigint = BigInt(0);
    let location: string = '';
    let teacher: string = '';
    let classGroup: string = '';
    let explicitStart: number = 0;
    let explicitEnd: number = 0;
    const joined: string = extras.join(' ');
    const detailMatch = /(\d{1,2})\s*-\s*(\d{1,2})\s*节/.exec(joined);
    if (detailMatch !== null) {
      const fields = ParsingUtils.parseGridDetail(joined);
      weekMask = fields.weekMask;
      location = fields.location;
      teacher = fields.teacher;
      classGroup = fields.classGroup;
      // 文字里写了第几节就**用文字**：截图可能被缩放/裁切，纵向位置不如白纸黑字可靠
      explicitStart = Number.parseInt(detailMatch[1], 10);
      explicitEnd = Number.parseInt(detailMatch[2], 10);
    }
    if (weekMask === BigInt(0)) {
      // 没有结构化详情：从剩下的行里猜教室/教师，认不出的直接丢掉（不塞进课名）
      for (const e of extras) {
        if (location.length === 0 && GridFromOcr.looksLikeRoom(e)) {
          location = e;
        } else if (teacher.length === 0 && GridFromOcr.looksLikePerson(e)) {
          teacher = e;
        }
      }
      weekMask = GridFromOcr.weeksOf(cell, totalWeeks);
    }

    let startPeriod: number = explicitStart;
    let endPeriod: number = explicitEnd;
    if (startPeriod <= 0 || endPeriod < startPeriod) {
      const periods: number[] = GridFromOcr.periodsOf(cell, rows);
      startPeriod = periods[0];
      endPeriod = periods[periods.length - 1];
    }
    const schedule: RawSchedule = {
      dayOfWeek: day,
      startPeriod: startPeriod,
      endPeriod: endPeriod,
      weekMask: weekMask,
      classGroup: classGroup,
    };
    const course: RawCourse = {
      name: name,
      teacher: teacher,
      location: location,
      category: cleaned[1],
      schedules: [schedule],
    };
    return course;
  }

  /**
   * 格子在纵向覆盖了哪几行 → 起始/结束节次。
   *
   * 用**行的分带**（相邻节次中心的中点）而不是"行中心是否落在格子附近"：
   * 一门课占 1-2 节时，文字通常压在两行中间，用行中心判定会只算一节。
   */
  private static periodsOf(cell: Cell, rows: Row[]): number[] {
    if (rows.length === 0) {
      return [1];
    }
    const hit: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      const spacing: number = rows.length > 1 ? Math.abs(rows[Math.min(i + 1, rows.length - 1)].centerY - rows[i].centerY) : 50;
      const prevCenter: number = i === 0 ? rows[0].centerY - spacing : rows[i - 1].centerY;
      const nextCenter: number = i === rows.length - 1 ? rows[i].centerY + spacing : rows[i + 1].centerY;
      const top: number = i === 0 ? prevCenter : (prevCenter + rows[i].centerY) / 2;
      const bottom: number = i === rows.length - 1 ? nextCenter : (rows[i].centerY + nextCenter) / 2;
      if (cell.top < bottom && cell.bottom > top) {
        hit.push(rows[i].period);
      }
    }
    if (hit.length === 0) {
      return [rows[0].period];
    }
    hit.sort((a: number, b: number) => a - b);
    return hit;
  }

  /** 格子里写了 `1-16周` / `1-15单` 就按它算，否则整学期 */
  private static weeksOf(cell: Cell, totalWeeks: number): bigint {
    for (const l of cell.lines) {
      const found = /(\d{1,2}\s*[-~–—]\s*\d{1,2}\s*周?(?:[单双])?)/.exec(l.text);
      if (found !== null) {
        const mask: bigint = WeekMasks.parse(found[1]);
        if (mask !== BigInt(0)) {
          return mask;
        }
      }
    }
    return GridFromOcr.fullSemester(totalWeeks);
  }

  private static hasExplicitWeeks(cell: Cell): boolean {
    for (const l of cell.lines) {
      if (/(\d{1,2})\s*[-~–—]\s*(\d{1,2})\s*周/.test(l.text)) {
        return true;
      }
    }
    return false;
  }

  /** 整学期掩码（总周数不合法时退回 20 周） */
  static fullSemester(totalWeeks: number): bigint {
    let weeks: number = 20;
    if (Number.isFinite(totalWeeks) && totalWeeks >= 1 && totalWeeks <= WeekMasks.MAX_WEEK) {
      weeks = Math.trunc(totalWeeks);
    }
    return WeekMasks.range(1, weeks);
  }

  // ---------------------------------------------------------------- 小工具

  private static looksLikeRoom(text: string): boolean {
    const t: string = text.trim();
    if (t.length === 0 || t.length > 20) {
      return false;
    }
    if (/[楼室馆场区座]/.test(t)) {
      return true;
    }
    // `A302`、`B-107`、`3-201` 这类
    return /^[A-Za-z]?\d{1,2}[-－]?\d{0,3}$/.test(t) || /^[A-Za-z]-\d+$/.test(t);
  }

  private static looksLikePerson(text: string): boolean {
    const t: string = text.trim();
    if (t.length < 2 || t.length > 12) {
      return false;
    }
    // 纯中文、不含字母数字、也不像地点：截图里的第二三行常常是教师名
    if (/[0-9A-Za-z]/.test(t) || /[楼室馆场区座]/.test(t)) {
      return false;
    }
    return /^[\u4e00-\u9fa5·]{2,12}$/.test(t);
  }

  private static centerX(line: OcrLine): number {
    return (line.left + line.right) / 2;
  }

  private static empty(reason: string): ParseResult {
    const result: ParseResult = {
      courses: [],
      format: GRID_FROM_OCR_FORMAT,
      warnings: [reason],
    };
    return result;
  }
}
