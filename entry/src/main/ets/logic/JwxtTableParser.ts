/**
 * 教务系统导出的「学生课表」表格 → 课程 + 作息。
 *
 * ## 输入长什么样（实测某校导出）
 *
 * ```html
 * <table id="manualArrangeCourseTable">
 *   <tr><th>节次/周次</th><th>星期一</th>…<th>星期日</th></tr>
 *   <tr><td>第一节</td><td rowspan=2>
 *         计算机网络        (26271.072402001P.02)
 *                 (尚游)
 *                 ([1-4]  A14-0615(本部))
 *       </td>…</tr>
 *   …
 *   <tr><td>各校区作息时间说明:</td></tr>
 *   <tr><td>本部</td><td>第一节     08:00~ 08:45</td>…</tr>
 * </table>
 * ```
 *
 * 几个必须处理好的地方（都是这份真实文件里出现的写法）：
 *
 * 1. **一格可以塞好几门课**（一周上两次的课在同一格里重复出现，各自带周次与教室）；
 * 2. **周次写法很多**：`[1-4]`、`[6-16]双`、`[9-17]单`、`[1-4],[6-13]`、`[1-2],[5-17],19`、`5`；
 * 3. **停课**：`(4  停课(本部))` —— 那一周不上，不能算进周次；
 * 4. **教室可能为空**（网课：`([1-2],[5-17],19  )`）；
 * 5. **rowspan**：`第一节`格的课通常跨两行（1-2 节），节次范围要按跨行算；
 * 6. 表格底部还有**作息时间**，顺手一起解析出来（一个文件就能同时把课表和作息补齐）。
 *
 * 纯逻辑、零平台依赖，可以直接拿真实导出文件在 Node 上跑断言。
 */
import { type HtmlCell, HtmlTableParser, type HtmlTable } from './HtmlTable.ts';
import { type RawCourse, type RawSchedule } from './PdfModels.ts';
import { WeekMasks } from './WeekMasks.ts';

/** 解析出来的作息一行 */
export interface JwxtSlot {
  readonly periodIndex: number;
  readonly label: string;
  readonly startMinute: number;
  readonly endMinute: number;
}

/** 整份文件的解析结果 */
export interface JwxtParseResult {
  readonly courses: RawCourse[];
  readonly slots: JwxtSlot[];
  /** 课程表的星期列数（7 或更少，用于提示） */
  readonly dayCount: number;
  readonly warnings: string[];
}

/** 一个课程块（一格里的"名称+代码+教师+周次教室"） */
interface Block {
  name: string;
  code: string;
  teachers: string[];
  /** 周次掩码（还没剔除停课周） */
  mask: bigint;
  /** 停课周（最后统一从 mask 里减掉） */
  cancelMask: bigint;
  /** 教室（可能为空：网课） */
  room: string;
  /** 有停课周被剔除（用于汇总提示） */
  cancelled: number;
}

export class JwxtTableParser {
  /** 版式名（导入预览里显示） */
  static readonly FORMAT: string = '教务系统表格';

  /** 节次标签 → 序号（第一节…第十一节，最多认到三十） */
  static periodIndexOf(label: string): number | null {
    const m = /^第\s*([一二三四五六七八九十]+)\s*节/.exec(label.trim());
    if (m === null) {
      return null;
    }
    const n: number = JwxtTableParser.chineseNumber(m[1]);
    return n >= 1 ? n : null;
  }

  /** 中文数字（一…三十）→ 数字；认不出返回 0 */
  static chineseNumber(text: string): number {
    const digits: string = '一二三四五六七八九';
    const t: string = text.trim();
    if (t === '十') {
      return 10;
    }
    // 十一 … 十九
    if (t.startsWith('十') && t.length === 2) {
      const unit: number = digits.indexOf(t.charAt(1)) + 1;
      return unit > 0 ? 10 + unit : 0;
    }
    // 二十 … 二十九
    if (t.startsWith('二') && t.charAt(1) === '十') {
      if (t.length === 2) {
        return 20;
      }
      const unit: number = digits.indexOf(t.charAt(2)) + 1;
      return unit > 0 ? 20 + unit : 0;
    }
    // 三十
    if (t.startsWith('三') && t.charAt(1) === '十') {
      return t.length === 2 ? 30 : 0;
    }
    const single: number = digits.indexOf(t.charAt(0)) + 1;
    return t.length === 1 ? single : 0;
  }

  /**
   * 主入口：把一份导出的 HTML 解析成课程 + 作息。
   *
   * @param html 文件原文（UTF-8；GBK 的由调用方先转码）
   */
  static parse(html: string): JwxtParseResult {
    const warnings: string[] = [];
    const tables: HtmlTable[] = HtmlTableParser.parse(html);
    const main: HtmlTable | null = JwxtTableParser.findTimetableTable(tables);
    if (main === null) {
      return {
        courses: [],
        slots: JwxtTableParser.parseSlots(tables, warnings),
        dayCount: 0,
        warnings: JwxtTableParser.withReason(
          warnings,
          '没找到课表表格：文件里没有"节次/周次 + 星期一…"这一行'
        ),
      };
    }

    // 表头：星期列
    let headerRow: number = -1;
    const dayOfCol: Map<number, number> = new Map<number, number>();
    for (let r = 0; r < main.rowCount; r++) {
      const first: HtmlCell | null = HtmlTableParser.cellAt(main, r, 0);
      if (first === null || first.text.indexOf('节次') < 0) {
        continue;
      }
      headerRow = r;
      for (let c = 1; c < main.colCount; c++) {
        const cell: HtmlCell | null = HtmlTableParser.cellAt(main, r, c);
        if (cell === null) {
          continue;
        }
        const day: number | null = JwxtTableParser.dayOfColHeader(cell.text);
        if (day !== null) {
          dayOfCol.set(c, day);
        }
      }
      break;
    }
    if (headerRow < 0 || dayOfCol.size === 0) {
      return {
        courses: [],
        slots: JwxtTableParser.parseSlots(tables, warnings),
        dayCount: 0,
        warnings: JwxtTableParser.withReason(warnings, '表头没认出"星期一…星期日"'),
      };
    }
    if (dayOfCol.size < 7) {
      warnings.push('表头只认出 ' + dayOfCol.size + ' 天（周六/周日可能没有课）');
    }

    // 每一行对应第几节
    const periodOfRow: number[] = [];
    for (let r = 0; r < main.rowCount; r++) {
      const cell: HtmlCell | null = HtmlTableParser.cellAt(main, r, 0);
      const p: number | null = cell === null ? null : JwxtTableParser.periodIndexOf(cell.text);
      periodOfRow.push(p === null ? 0 : p);
    }

    const courses: RawCourse[] = [];
    let blocks: number = 0;
    let cancelled: number = 0;
    let nameless: number = 0;
    for (const cell of main.cells) {
      if (cell.col === 0 || cell.row === headerRow) {
        continue;
      }
      const day: number | undefined = dayOfCol.get(cell.col);
      if (day === undefined) {
        continue;
      }
      const startPeriod: number = JwxtTableParser.firstPeriod(periodOfRow, cell.row, cell.rowSpan);
      const endPeriod: number = JwxtTableParser.lastPeriod(periodOfRow, cell.row, cell.rowSpan);
      if (startPeriod <= 0) {
        continue;
      }
      for (const block of JwxtTableParser.blocksOf(cell.text)) {
        blocks++;
        cancelled += block.cancelled;
        if (block.name.length === 0) {
          nameless++;
          continue;
        }
        if (block.mask === BigInt(0)) {
          // 整格都是"停课"：没有可上的周次
          continue;
        }
        const schedule: RawSchedule = {
          dayOfWeek: day,
          startPeriod: startPeriod,
          endPeriod: endPeriod,
          weekMask: block.mask,
          classGroup: '',
        };
        const course: RawCourse = {
          name: block.name,
          teacher: block.teachers.join('、'),
          location: block.room,
          category: '',
          schedules: [schedule],
        };
        courses.push(course);
      }
    }

    if (cancelled > 0) {
      warnings.push('有 ' + cancelled + ' 处"停课"周已从周次里剔除');
    }
    if (nameless > 0) {
      warnings.push('有 ' + nameless + ' 处没认出课程名（只有代码），已跳过');
    }
    if (courses.length === 0) {
      warnings.push('表格认出来了，但格子里没有可用课程（是不是空课表？）');
    }

    const slots: JwxtSlot[] = JwxtTableParser.parseSlots(tables, warnings);
    const result: JwxtParseResult = {
      courses: courses,
      slots: slots,
      dayCount: dayOfCol.size,
      warnings: warnings,
    };
    return result;
  }

  /** 在若干张表里找"第一列写着节次、其余列写着星期"的那张 */
  private static findTimetableTable(tables: HtmlTable[]): HtmlTable | null {
    for (const t of tables) {
      for (let r = 0; r < t.rowCount; r++) {
        const first: HtmlCell | null = HtmlTableParser.cellAt(t, r, 0);
        if (first === null || first.text.indexOf('节次') < 0) {
          continue;
        }
        for (let c = 1; c < t.colCount; c++) {
          const cell: HtmlCell | null = HtmlTableParser.cellAt(t, r, c);
          if (cell !== null && JwxtTableParser.dayOfColHeader(cell.text) !== null) {
            return t;
          }
        }
      }
    }
    return null;
  }

  /** 表头文字 → 星期（1..7） */
  static dayOfColHeader(text: string): number | null {
    const t: string = text.trim();
    const m = /(?:星期|周)([一二三四五六日天])/.exec(t);
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

  private static firstPeriod(periodOfRow: number[], row: number, span: number): number {
    for (let r = row; r < row + span && r < periodOfRow.length; r++) {
      if (periodOfRow[r] > 0) {
        return periodOfRow[r];
      }
    }
    return 0;
  }

  private static lastPeriod(periodOfRow: number[], row: number, span: number): number {
    let last: number = 0;
    for (let r = row; r < row + span && r < periodOfRow.length; r++) {
      if (periodOfRow[r] > 0) {
        last = periodOfRow[r];
      }
    }
    return last > 0 ? last : JwxtTableParser.firstPeriod(periodOfRow, row, span);
  }

  /**
   * 一格文本 → 若干课程块。
   *
   * 结构固定三行一组（课名(代码) / (教师) / (周次 教室)），但**一门课的课名可能折行**，
   * 所以用"状态机 + 看下一行长什么样"来切，而不是死按行数分组。
   */
  static blocksOf(text: string): Block[] {
    const out: Block[] = [];
    let current: Block | null = null;
    const lines: string[] = text.split('\n');
    for (const raw of lines) {
      const line: string = raw.trim();
      if (line.length === 0) {
        continue;
      }
      const nameMatch = /^(.+?)\s*\(([0-9A-Za-z._\-]{6,})\)$/.exec(line);
      if (nameMatch !== null && /[0-9]/.test(nameMatch[2])) {
        // 新的课程块
        if (current !== null) {
          out.push(current);
        }
        current = {
          name: nameMatch[1].trim(),
          code: nameMatch[2],
          teachers: [],
          mask: BigInt(0),
          cancelMask: BigInt(0),
          room: '',
          cancelled: 0,
        };
        continue;
      }
      const paren = /^\(([\s\S]*)\)$/.exec(line);
      if (paren === null) {
        // 课名折行：拼到当前块的名字上（没有当前块就先建一个无代码的）
        if (current === null) {
          current = {
            name: line,
            code: '',
            teachers: [],
            mask: BigInt(0),
            cancelMask: BigInt(0),
            room: '',
            cancelled: 0,
          };
        } else {
          current.name = current.name + line;
        }
        continue;
      }
      const inner: string = paren[1].trim();
      const weekParsed: WeekAndRoom = JwxtTableParser.splitWeeks(inner);
      if (weekParsed.isWeeks) {
        if (current === null) {
          continue;
        }
        current.mask = current.mask | weekParsed.mask;
        current.cancelMask = current.cancelMask | weekParsed.cancelMask;
        current.cancelled += weekParsed.cancelled;
        if (weekParsed.room.length > 0 && current.room.length === 0) {
          current.room = weekParsed.room;
        }
        continue;
      }
      if (current === null) {
        continue;
      }
      // 教师行
      const teachers: string[] = [];
      for (const part of inner.split(/[,，、]/)) {
        const t: string = part.trim();
        if (t.length > 0) {
          teachers.push(t);
        }
      }
      if (teachers.length > 0) {
        for (const t of teachers) {
          if (current.teachers.indexOf(t) < 0) {
            current.teachers.push(t);
          }
        }
      }
    }
    if (current !== null) {
      out.push(current);
    }
    // 停课周统一在最后减掉：停课行可能出现在周次行之前或之后，
    // 边解析边减会漏（先停课后周次时，减完又被加回来）
    for (const b of out) {
      if (b.cancelMask !== BigInt(0)) {
        b.mask = b.mask & ~b.cancelMask;
      }
    }
    return out;
  }

  /**
   * `[1-4]  A14-0615(本部)` / `[6-16]双  A14-0618(本部)` / `4  停课(本部)` / `5  A05-0305(本部)`
   * → 周次掩码 + 教室 + 停课周数。
   *
   * 判断"这一行是不是周次行"：以数字或 `[` 开头（教师行不会）。
   */
  static splitWeeks(inner: string): WeekAndRoom {
    const text: string = inner.trim();
    if (text.length === 0) {
      return { isWeeks: false, mask: BigInt(0), cancelMask: BigInt(0), room: '', cancelled: 0 };
    }
    if (!/^[\[0-9]/.test(text)) {
      return { isWeeks: false, mask: BigInt(0), cancelMask: BigInt(0), room: '', cancelled: 0 };
    }

    /*
     * **先认"停课"**：`4  停课(本部)` 这种行以数字开头，如果不先拦下来，
     * 周次循环会把 `4` 当成"第 4 周有课"，于是生成一段"第 4 周、没有教室"的课
     * —— 而真实含义正好相反：那一周不上。实测这份文件里 8 处停课全都这么写。
     */
    const cancel = /^\s*(\d{1,2})(?:\s*[-~]\s*(\d{1,2}))?\s*停课/.exec(text);
    if (cancel !== null) {
      const cFrom: number = Number.parseInt(cancel[1], 10);
      const cTo: number = cancel[2] === undefined ? cFrom : Number.parseInt(cancel[2], 10);
      const cancelMask: bigint =
        cFrom >= 1 && cTo >= cFrom && cTo <= WeekMasks.MAX_WEEK
          ? JwxtTableParser.rangeMask(cFrom, cTo, '')
          : BigInt(0);
      const count: number = cTo >= cFrom ? cTo - cFrom + 1 : 0;
      return { isWeeks: true, mask: BigInt(0), cancelMask: cancelMask, room: '', cancelled: count };
    }

    let mask: bigint = BigInt(0);
    let rest: string = text;

    // 逐个消费周次片段：`[1-4]`、`[6-16]双`、`[1-2]`、`19`、`5`
    while (true) {
      const m = /^\s*\[?\s*(\d{1,2})(?:\s*[-~–—]\s*(\d{1,2}))?\s*\]?\s*([单双])?\s*,?/.exec(rest);
      if (m === null) {
        break;
      }
      const from: number = Number.parseInt(m[1], 10);
      const to: number = m[2] === undefined ? from : Number.parseInt(m[2], 10);
      const parity: string = m[3] === undefined ? '' : m[3];
      if (from >= 1 && to >= from && to <= WeekMasks.MAX_WEEK) {
        mask = mask | JwxtTableParser.rangeMask(from, to, parity);
      }
      rest = rest.substring(m[0].length);
      if (rest.trim().length === 0) {
        break;
      }
      // 下一个片段必须以数字/`[` 开头，否则说明周次写完了（后面是教室）
      if (!/^\s*[\[0-9]/.test(rest)) {
        break;
      }
    }

    if (mask === BigInt(0)) {
      // 形如 `2026` 这种不是周次的数字开头：当成"没认出"，交给上层忽略
      return { isWeeks: false, mask: BigInt(0), cancelMask: BigInt(0), room: '', cancelled: 0 };
    }

    // 教室：把周次部分剩下的东西里，去掉"停课"和校区括号
    let room: string = rest.trim();
    room = room.replace(/停课/gi, ' ');
    room = room.replace(/[（(]\s*(本部|东区|西区|南区|北区|新校区|老校区)\s*[)）]/g, ' ');
    room = room.replace(/^[\s,;，；]+/, '').replace(/[\s,;，；]+$/, '');
    room = room.replace(/\s{2,}/g, ' ');
    return { isWeeks: true, mask: mask, cancelMask: BigInt(0), room: room, cancelled: 0 };
  }

  /**
   * 区间 + 单双周 → 掩码。
   *
   * 逐周拼而不是"区间掩码 ± 奇偶掩码"：WeekMasks.range 已经有夹取逻辑，
   * 这里只需要跳过不符合奇偶的周，逻辑最短也最不容易错。
   */
  static rangeMask(from: number, to: number, parity: string): bigint {
    let mask: bigint = BigInt(0);
    for (let w = from; w <= to; w++) {
      if (parity === '单' && w % 2 === 0) {
        continue;
      }
      if (parity === '双' && w % 2 === 1) {
        continue;
      }
      if (w >= 1 && w <= WeekMasks.MAX_WEEK) {
        mask = mask | WeekMasks.of(w);
      }
    }
    return mask;
  }

  /** 作息时间（表格底部："第一节 08:00~08:45"） */
  static parseSlots(tables: HtmlTable[], warnings: string[]): JwxtSlot[] {
    const byPeriod: Map<number, JwxtSlot> = new Map<number, JwxtSlot>();
    for (const t of tables) {
      for (const cell of t.cells) {
        const compact: string = cell.text.replace(/\n/g, '').replace(/\s+/g, ' ');
        const m = /第\s*([一二三四五六七八九十]+)\s*节\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*[~\-–—]\s*(\d{1,2})\s*[:：]\s*(\d{1,2})/.exec(compact);
        if (m === null) {
          continue;
        }
        const period: number = JwxtTableParser.chineseNumber(m[1]);
        const startMinute: number = Number.parseInt(m[2], 10) * 60 + Number.parseInt(m[3], 10);
        const endMinute: number = Number.parseInt(m[4], 10) * 60 + Number.parseInt(m[5], 10);
        if (period <= 0 || startMinute >= endMinute) {
          continue;
        }
        if (!byPeriod.has(period)) {
          byPeriod.set(period, {
            periodIndex: period,
            label: '第' + m[1] + '节',
            startMinute: startMinute,
            endMinute: endMinute,
          });
        }
      }
    }
    const out: JwxtSlot[] = [];
    byPeriod.forEach((slot: JwxtSlot) => {
      out.push(slot);
    });
    out.sort((a: JwxtSlot, b: JwxtSlot) => a.periodIndex - b.periodIndex);
    if (out.length === 0) {
      warnings.push('文件里没有作息时间表（只有课表），作息保持原样');
    }
    return out;
  }

  private static withReason(warnings: string[], reason: string): string[] {
    const out: string[] = warnings.slice(0);
    out.push(reason);
    return out;
  }
}

/** 周次行的解析结果 */
export interface WeekAndRoom {
  readonly isWeeks: boolean;
  readonly mask: bigint;
  /** 停课周（从课程掩码里减掉） */
  readonly cancelMask: bigint;
  readonly room: string;
  readonly cancelled: number;
}
