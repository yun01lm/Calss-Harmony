/**
 * 作息表文本解析：从 OCR 文本行还原「第几节 → 起止时间」。
 * 移植自 Android `ocr/TimetableTextParser.kt`（行为逐条对齐）。
 *
 * **纯函数、零平台依赖**：OCR / PDF / 粘贴文本三条通道都先把输入转成 [OcrLine]，
 * 再走同一个解析器 + 同一个校正页，因此可以拿真实截图的实际排版在离线环境逐条验证。
 *
 * ## 目标版式（实测样本：12 节 + 8~9 行课间/大课间）
 * ```
 * 时间   | 节次   | 时间段         | 时长
 * 上午   | 1      | 8: 00-8: 45   | 45分钟     ← 紧贴表头，节次号最容易漏读
 *        | 课间   | 8: 45-8: 50   | 5分钟      ← 没有节次号，必须跳过
 *        | 大课间 | 9: 35-10: 00  | 25分钟     ← 同上
 * 晚上   | 12     | 20: 50-21: 35 | 45分钟     ← 贴着图片下边缘，同样容易漏读
 * ```
 *
 * ## 四条关键规则
 * 1. **节次号 = 时间区间之前的最后一个独立数字**（这样"课间/大课间"行自然排除，
 *    也不受行首分组标签或时长列干扰；同一行被 OCR 合并了多节时逐段都能取到）；
 * 2. 时间容错"冒号后带空格"（实测就是 `8: 00-8: 45`），支持全角冒号、点号、各种破折号，
 *    以及"8点45分"式写法；
 * 3. OCR 会把同一行的不同单元格拆成多行 → 先**按 y 聚类成行**再匹配；某段时间没配到节次号时，
 *    再在同一水平线**左侧**找独立数字兜底，最后才在时间右侧找；
 * 4. **补号**：顶部/底部行的节次号常被漏读，旧实现会整行丢弃（实测"12 节只认出 10 节，
 *    恰好少了首尾两节"）。现在只在「缺号行数 == 可用节次号个数」**完全确定**时才补，
 *    并标记 `inferred`；有一点不确定就绝不猜，改为在警告里点名"第几节没认出来"。
 */

/** OCR 识别出的一行文字及其包围盒（图片像素坐标，原点左上） */
export class OcrLine {
  readonly text: string;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;

  constructor(text: string, left: number, top: number, right: number, bottom: number) {
    this.text = text;
    this.left = left;
    this.top = top;
    this.right = right;
    this.bottom = bottom;
  }

  get centerY(): number {
    return Math.trunc((this.top + this.bottom) / 2);
  }

  get height(): number {
    return Math.max(1, this.bottom - this.top);
  }
}

/** 从作息表里识别出的一节课次时间 */
export interface RecognizedPeriod {
  readonly periodIndex: number;
  readonly startMinute: number;
  readonly endMinute: number;
  /** 上午/下午/晚上…（没识别到则为按节次兜底的分组） */
  readonly group: string;
  /**
   * true = 节次号是**推断**出来的（原始识别里这一格没读出来）。
   * 校正页会标出来提醒核对 —— 补号是好事，但必须让人知道哪几行是补的。
   */
  readonly inferred: boolean;
}

export interface TimetableParseResult {
  readonly periods: RecognizedPeriod[];
  readonly warnings: string[];
  /** 解析用到的原文行，"识别详情"里展示，便于反馈问题时给出证据 */
  readonly rawLines: string[];
  /** 1..最大已认出 之间完全缺失的节次号（界面据此提示"补一节"） */
  readonly missingPeriods: number[];
}

/** 有时间但没节次号的候选行 */
interface OrphanRow {
  readonly centerY: number;
  readonly startMinute: number;
  readonly endMinute: number;
}

/** 按 y 聚类后的一"行"（可能由多个文字块拼成） */
class Row {
  readonly lines: OcrLine[];

  constructor(lines: OcrLine[]) {
    this.lines = lines;
  }

  get centerY(): number {
    let sum = 0;
    for (const l of this.lines) {
      sum += l.centerY;
    }
    return Math.trunc(sum / this.lines.length);
  }

  get height(): number {
    let max = 0;
    for (const l of this.lines) {
      max = Math.max(max, l.height);
    }
    return max;
  }
}

/** 一段被识别出的时间区间及其在行文本中的位置 */
interface TimeMatch {
  readonly h1: number;
  readonly m1: number;
  readonly h2: number;
  readonly m2: number;
  readonly startIndex: number;
  readonly endIndex: number;
}

const GROUP_LABELS: string[] = ['上午', '下午', '晚上', '早上', '中午', '傍晚', '夜间'];

/**
 * "8: 00-8: 45" 这类写法（冒号后允许空格；支持全角冒号、点号、各种破折号）。
 *
 * 分隔符里额外放过 `:：·・`：**真实 OCR 会把连字符读成冒号或间隔号**
 * （实测一张真实作息截图，Windows OCR 把 `8: 00-8: 45` 读成 `8 ： 00 ： 45`、
 * 把 `8: 50-9: 35` 读成 `8 ： 50 · 9 ： 35`）。不放过这类分隔符，整张图会一条都认不出。
 * 这不会把"8:00:45"（时:分:秒）误判成区间：区间要求分隔符后面还有一对"数字:两位数字"。
 */
const TIME_RANGE = /(\d{1,2})\s*[:：.]\s*(\d{2})\s*[-~—–－〜:：·・]\s*(\d{1,2})\s*[:：.]\s*(\d{2})/g;

/** "8点45分-9点35分" / "8点-9点" 这类写法（分钟可省略，省略时按 0 计） */
const TIME_RANGE_CN =
  /(\d{1,2})\s*[点时]\s*(\d{1,2})?\s*分?\s*[-~—–－〜]\s*(\d{1,2})\s*[点时]\s*(\d{1,2})?\s*分?/g;

const DURATION = /\d+\s*分钟/g;

export class TimetableTextParser {
  /**
   * 把**纯文本**（一行一条记录）包装成带伪坐标的 [OcrLine]，
   * 让"粘贴文本"与"PDF 提取文字"复用同一套解析，不必各写一份。
   *
   * 伪坐标取法有讲究：行距 20、行高 12。[groupRows] 的合并容差是
   * "行高中位数 × 0.6（最少 6）" = 7 —— 远小于 20，所以**一行就是一行**，不会被错误合并。
   */
  static linesFromText(text: string): OcrLine[] {
    const out: OcrLine[] = [];
    const rows = text.split(/\r?\n/);
    let i = 0;
    for (const raw of rows) {
      const s = raw.trim();
      if (s.length === 0) {
        continue;
      }
      const top = i * 20;
      out.push(new OcrLine(s, 0, top, 0, top + 12));
      i++;
    }
    return out;
  }

  static parse(lines: OcrLine[]): TimetableParseResult {
    const usable = lines.map((l) => l.text.trim()).filter((t) => t.length > 0);
    const empty: TimetableParseResult = {
      periods: [],
      warnings: ['这张图里没有识别到文字'],
      rawLines: [],
      missingPeriods: [],
    };
    if (usable.length === 0) {
      return empty;
    }
    // 保留原始 OcrLine 以做坐标聚类与兜底
    const usableLines: OcrLine[] = [];
    for (const l of lines) {
      const t = l.text.trim();
      if (t.length > 0) {
        usableLines.push(new OcrLine(t, l.left, l.top, l.right, l.bottom));
      }
    }
    const rawLines: string[] = usable;

    const warnings: string[] = [];
    const groups: Array<[string, number]> = [];
    for (const l of usableLines) {
      if (GROUP_LABELS.indexOf(l.text) >= 0) {
        groups.push([l.text, l.centerY]);
      }
    }

    const found = new Map<number, RecognizedPeriod>();
    const anchors: Array<[number, number]> = [];
    const orphans: OrphanRow[] = [];
    const restYs: number[] = [];
    let duplicates = 0;
    let badTime = 0;
    let restRows = 0;

    for (const row of TimetableTextParser.groupRows(usableLines)) {
      const ordered = row.lines.slice().sort((a, b) => a.left - b.left);
      let rowText = '';
      for (const l of ordered) {
        rowText += (rowText.length === 0 ? '' : ' ') + l.text;
      }

      const matches: TimeMatch[] = [];
      for (const m of TimetableTextParser.findAll(TIME_RANGE, rowText)) {
        const t = TimetableTextParser.toMinutes(m, false);
        if (t !== null) {
          matches.push(t);
        } else {
          badTime++;
        }
      }
      for (const m of TimetableTextParser.findAll(TIME_RANGE_CN, rowText)) {
        const t = TimetableTextParser.toMinutes(m, true);
        if (t !== null) {
          matches.push(t);
        } else {
          badTime++;
        }
      }
      matches.sort((a, b) => a.startIndex - b.startIndex);

      for (const match of matches) {
        const startMinute = match.h1 * 60 + match.m1;
        const endMinute = match.h2 * 60 + match.m2;

        // 同一段时间被识别到两次：算重复，且**不参与补号** ——
        // 否则补号会照着它编出一个根本不存在的节次
        let sameTime = false;
        found.forEach((p: RecognizedPeriod) => {
          if (p.startMinute === startMinute && p.endMinute === endMinute) {
            sameTime = true;
          }
        });
        if (sameTime) {
          duplicates++;
          continue;
        }

        const resolved = TimetableTextParser.resolvePeriod(row, rowText, match, usableLines);
        if (resolved === null) {
          if (TimetableTextParser.looksLikePeriodRow(rowText)) {
            const orphan: OrphanRow = {
              centerY: row.centerY,
              startMinute,
              endMinute,
            };
            orphans.push(orphan);
          } else {
            restRows++;
            restYs.push(row.centerY);
          }
          continue;
        }
        if (found.has(resolved)) {
          duplicates++;
          continue;
        }
        const period: RecognizedPeriod = {
          periodIndex: resolved,
          startMinute,
          endMinute,
          group: TimetableTextParser.groupFor(row.centerY, groups, resolved),
          inferred: false,
        };
        found.set(resolved, period);
        anchors.push([resolved, row.centerY]);
      }
    }

    const inferred = TimetableTextParser.repairOrphans(found, anchors, orphans, groups);

    if (found.size === 0) {
      // 与 Android 版的差异（记录于 docs/COMPAT.md）：Android 在这里只返回一句
      // "没能从图片里认出作息时间"，把"有几处时间不合法 / 有几行是课间"的具体原因丢了，
      // 用户没法判断是自己截错了图还是时间格式怪。这里把已统计到的原因一并带上。
      const early: string[] = [];
      if (duplicates > 0) {
        early.push(`有 ${duplicates} 处内容重复（同一时间识别到两次），已忽略`);
      }
      if (badTime > 0) {
        early.push(`有 ${badTime} 处时间不合法（如开始晚于结束），已忽略`);
      }
      if (restRows > 0) {
        early.push(`有 ${restRows} 行是课间/大课间这类休息时间，已跳过（这是对的）`);
      }
      early.push('没能从图片里认出作息时间，可以在下面手动添加节次');
      const none: TimetableParseResult = {
        periods: [],
        warnings: early,
        rawLines,
        missingPeriods: [],
      };
      return none;
    }

    const sorted: RecognizedPeriod[] = [];
    found.forEach((p: RecognizedPeriod) => sorted.push(p));
    sorted.sort((a, b) => a.periodIndex - b.periodIndex);

    const maxPeriod = sorted[sorted.length - 1].periodIndex;
    const missing: number[] = [];
    for (let w = 1; w <= maxPeriod; w++) {
      if (!found.has(w)) {
        missing.push(w);
      }
    }

    // 表格结构上的常识：**休息行只出现在两节之间**。所以"最后一行是课间"意味着
    // 它后面还有一节没被读出来（末节整行漏读时，光看已认出的节次发现不了 ——
    // 这是用户报的"12 节只认出 10 节"里最隐蔽的一种）。
    let restLastY: number | null = null;
    for (const y of restYs) {
      if (restLastY === null || y > restLastY) {
        restLastY = y;
      }
    }
    let maxAnchorY: number | null = null;
    for (const a of anchors) {
      if (maxAnchorY === null || a[1] > maxAnchorY) {
        maxAnchorY = a[1];
      }
    }
    const tailTruncated =
      restLastY !== null && anchors.length > 0 && maxAnchorY !== null && restLastY > maxAnchorY;
    if (tailTruncated) {
      missing.push(maxPeriod + 1);
    }

    if (duplicates > 0) {
      warnings.push(`有 ${duplicates} 处内容重复（同一时间识别到两次），已忽略`);
    }
    if (badTime > 0) {
      warnings.push(`有 ${badTime} 处时间不合法（如开始晚于结束），已忽略`);
    }
    if (restRows > 0) {
      warnings.push(`有 ${restRows} 行是课间/大课间这类休息时间，已跳过（这是对的）`);
    }
    if (inferred > 0) {
      warnings.push(`有 ${inferred} 个节次的序号是按上下顺序推断的（那一格没读出来），请核对`);
    }
    if (tailTruncated) {
      warnings.push(
        `表格最后一行是课间，说明后面还有第 ${maxPeriod + 1} 节没认出来，请核对或点「补一节」`
      );
    }
    if (missing.length > 0) {
      warnings.push(`第 ${missing.join('、')} 节没认出来，可点「补一节」手动加上`);
    }
    if (sorted.length < 3) {
      warnings.push(`只认出 ${sorted.length} 个节次，请仔细核对`);
    }
    let wrongOrder = 0;
    for (let i = 0; i + 1 < sorted.length; i++) {
      if (sorted[i + 1].startMinute <= sorted[i].startMinute) {
        wrongOrder++;
      }
    }
    if (wrongOrder > 0) {
      warnings.push(`有 ${wrongOrder} 处时间顺序不对（后面的节次反而更早），请核对`);
    }

    const result: TimetableParseResult = {
      periods: sorted,
      warnings,
      rawLines,
      missingPeriods: missing,
    };
    return result;
  }

  // ---------- 正则扫描（不用 lookbehind：那属于引擎可选特性，跨运行时不可靠） ----------

  /** 找出所有时间区间（含位置），用于后面按位置取节次号 */
  private static findAll(re: RegExp, text: string): TimeMatch[] {
    const out: TimeMatch[] = [];
    const r = new RegExp(re.source, 'g');
    let m: RegExpExecArray | null = r.exec(text);
    while (m !== null) {
      out.push({
        h1: Number.parseInt(m[1], 10),
        m1: Number.parseInt(m[2], 10),
        h2: Number.parseInt(m[3], 10),
        m2: Number.parseInt(m[4], 10),
        startIndex: m.index,
        endIndex: m.index + m[0].length,
      });
      if (r.lastIndex === m.index) {
        r.lastIndex++;
      }
      m = r.exec(text);
    }
    return out;
  }

  /** 时间区间 → (起始分钟, 结束分钟)；非法（含开始 >= 结束）返回 null */
  private static toMinutes(m: TimeMatch, isCn: boolean): TimeMatch | null {
    const h1 = m.h1;
    const m1 = m.m1;
    const h2 = m.h2;
    const m2 = m.m2;
    if (h1 < 0 || h1 > 23 || h2 < 0 || h2 > 23 || m1 < 0 || m1 > 59 || m2 < 0 || m2 > 59) {
      return null;
    }
    if (h2 * 60 + m2 <= h1 * 60 + m1) {
      return null;
    }
    return m;
  }

  /**
   * 独立整数（等价于 Kotlin 的 `(?<!\d)(\d{1,2})(?!\d)`）：
   * 数字串长度 1~2 才算"独立"，长度 ≥3 一律不算（避免把 `45分钟`、`100` 当成节次号）。
   */
  private static standaloneInts(text: string): Array<{ value: number; index: number }> {
    const out: Array<{ value: number; index: number }> = [];
    const re = /\d+/g;
    let m: RegExpExecArray | null = re.exec(text);
    while (m !== null) {
      if (m[0].length <= 2) {
        out.push({ value: Number.parseInt(m[0], 10), index: m.index });
      }
      m = re.exec(text);
    }
    return out;
  }

  // ---------- 行聚类 ----------

  private static groupRows(lines: OcrLine[]): Row[] {
    const sorted = lines.slice().sort((a, b) => a.centerY - b.centerY);
    const heights: number[] = sorted.map((l) => l.height).sort((a, b) => a - b);
    const medianHeight = heights[Math.trunc(heights.length / 2)];
    const tolerance = Math.max(6, Math.trunc(medianHeight * 0.6));

    const rows: Row[] = [];
    for (const line of sorted) {
      if (rows.length > 0) {
        const last = rows[rows.length - 1];
        if (Math.abs(line.centerY - last.centerY) <= tolerance) {
          last.lines.push(line);
          continue;
        }
      }
      rows.push(new Row([line]));
    }
    return rows;
  }

  // ---------- 取值 ----------

  /** 依次尝试三种判定：时间前的独立数字 → 同水平线左侧独立数字 → 时间后的独立数字 */
  private static resolvePeriod(
    row: Row,
    rowText: string,
    match: TimeMatch,
    all: OcrLine[]
  ): number | null {
    const before = TimetableTextParser.periodBefore(rowText, match.startIndex);
    if (before !== null) {
      return before;
    }
    const nearby = TimetableTextParser.nearbyPeriod(row, all);
    if (nearby !== null) {
      return nearby;
    }
    return TimetableTextParser.periodAfter(rowText, match.endIndex);
  }

  /** 时间区间之前的最后一个独立数字 = 节次号 */
  private static periodBefore(text: string, timeStart: number): number | null {
    const prefix = text.substring(0, Math.min(timeStart, text.length));
    const ints = TimetableTextParser.standaloneInts(prefix);
    if (ints.length === 0) {
      return null;
    }
    const value = ints[ints.length - 1].value;
    return value >= 1 && value <= 30 ? value : null;
  }

  /**
   * 兜底一：在**同一水平带、且位于时间左侧**找"独立数字行"当节次号。
   * 用在 OCR 把"节次"与"时间段"拆成两行的场合。
   *
   * 两道防护（否则课间行会把 5 分钟的休息时间误配到相邻节次上）：
   * 1. 只有"去掉时间和时长后不剩任何汉字"的行才允许兜底；
   * 2. 候选数字必须在时间所在行的左侧（节次列在时间段列左边）。
   */
  private static nearbyPeriod(row: Row, all: OcrLine[]): number | null {
    let rowText = '';
    for (const l of row.lines) {
      rowText += (rowText.length === 0 ? '' : ' ') + l.text;
    }
    if (TimetableTextParser.hasChineseAfterRemovingTime(rowText)) {
      return null;
    }

    const tolerance = Math.max(8, row.height);
    let minLeft = row.lines[0].left;
    for (const l of row.lines) {
      minLeft = Math.min(minLeft, l.left);
    }

    let best: number | null = null;
    let bestDistance = Number.MAX_SAFE_INTEGER;
    for (const line of all) {
      const trimmed = line.text.trim();
      if (!/^\d+$/.test(trimmed)) {
        continue;
      }
      const value = Number.parseInt(trimmed, 10);
      if (value < 1 || value > 30) {
        continue;
      }
      if (line.left >= minLeft) {
        continue;
      }
      const distance = Math.abs(line.centerY - row.centerY);
      if (distance > tolerance) {
        continue;
      }
      if (distance < bestDistance) {
        bestDistance = distance;
        best = value;
      }
    }
    return best;
  }

  /**
   * 兜底二：节次号写在时间段**之后**的场合（粘贴文本常见，如 `8: 00-8: 45  1  45分钟`）。
   *
   * 只在 periodBefore 与 nearbyPeriod 都失败时才走到这里，所以对已验证的 OCR 样本不可达。
   * 防护同 nearbyPeriod：去掉时间与"N分钟"后若还剩汉字就放弃，
   * 否则"课间 8: 45-8: 50  5分钟"会被误配成第 5 节。
   */
  private static periodAfter(text: string, from: number): number | null {
    const tail = text.substring(Math.min(Math.max(from, 0), text.length));
    const cleaned = tail.replace(new RegExp(DURATION.source, 'g'), ' ');
    if (TimetableTextParser.CJK.test(cleaned)) {
      return null;
    }
    const ints = TimetableTextParser.standaloneInts(cleaned);
    if (ints.length === 0) {
      return null;
    }
    const value = ints[0].value;
    return value >= 1 && value <= 30 ? value : null;
  }

  private static readonly CJK: RegExp = /[\u4E00-\u9FFF]/;

  /** 去掉时间区间与"N分钟"后，是否还剩汉字（剩了说明是"课间/大课间/上午"之类，不是节次行） */
  private static hasChineseAfterRemovingTime(text: string): boolean {
    const stripped = text
      .replace(new RegExp(TIME_RANGE.source, 'g'), ' ')
      .replace(new RegExp(TIME_RANGE_CN.source, 'g'), ' ')
      .replace(new RegExp(DURATION.source, 'g'), ' ');
    return TimetableTextParser.CJK.test(stripped);
  }

  /** 这行去掉时间与"N分钟"后不剩汉字 → 它像个节次行，只是号那一格丢了 */
  private static looksLikePeriodRow(text: string): boolean {
    return !TimetableTextParser.hasChineseAfterRemovingTime(text);
  }

  // ---------- 补号 ----------

  /**
   * 给"有时间但节次号丢了"的行补号。
   *
   * **只在完全确定时才补**：把缺号行按 y 分组，每段夹在两条"有号行"之间（或落在首/尾），
   * 只有当「这一段缺号行数」与「这一段可用的节次号个数」**恰好相等**时，才按 y 从上到下顺次填入；
   * 补出来的行标记 `inferred = true`，界面提示核对。
   *
   * 补完要把新行也加进 anchors：后面的"末行截断"判断依赖它，
   * 否则刚补好的末节会被当成"没补上"，误报缺一节（这个坑踩过一次）。
   */
  private static repairOrphans(
    found: Map<number, RecognizedPeriod>,
    anchors: Array<[number, number]>,
    orphans: OrphanRow[],
    groups: Array<[string, number]>
  ): number {
    if (orphans.length === 0 || anchors.length === 0) {
      return 0;
    }

    const sortedAnchors = anchors.slice().sort((a, b) => a[1] - b[1]);
    const sortedOrphans = orphans.slice().sort((a, b) => a.centerY - b.centerY);
    const segmentRows: OrphanRow[][] = [];
    const segmentNumbers: number[][] = [];

    const firstAnchor = sortedAnchors[0];
    const head: OrphanRow[] = [];
    for (const o of sortedOrphans) {
      if (o.centerY < firstAnchor[1]) {
        head.push(o);
      }
    }
    if (head.length > 0) {
      const numbers: number[] = [];
      for (let w = 1; w < firstAnchor[0]; w++) {
        numbers.push(w);
      }
      segmentRows.push(head);
      segmentNumbers.push(numbers);
    }

    for (let i = 0; i + 1 < sortedAnchors.length; i++) {
      const a = sortedAnchors[i];
      const b = sortedAnchors[i + 1];
      const run: OrphanRow[] = [];
      for (const o of sortedOrphans) {
        if (o.centerY > a[1] && o.centerY < b[1]) {
          run.push(o);
        }
      }
      if (run.length > 0) {
        const numbers: number[] = [];
        for (let w = a[0] + 1; w < b[0]; w++) {
          if (!found.has(w)) {
            numbers.push(w);
          }
        }
        segmentRows.push(run);
        segmentNumbers.push(numbers);
      }
    }

    const lastAnchor = sortedAnchors[sortedAnchors.length - 1];
    const tail: OrphanRow[] = [];
    for (const o of sortedOrphans) {
      if (o.centerY > lastAnchor[1]) {
        tail.push(o);
      }
    }
    if (tail.length > 0) {
      const numbers: number[] = [];
      for (let i = 0; i < tail.length; i++) {
        numbers.push(lastAnchor[0] + 1 + i);
      }
      segmentRows.push(tail);
      segmentNumbers.push(numbers);
    }

    let repaired = 0;
    for (let s = 0; s < segmentRows.length; s++) {
      const run = segmentRows[s];
      const numbers = segmentNumbers[s];
      if (run.length !== numbers.length) {
        continue;
      }
      for (let i = 0; i < run.length; i++) {
        const period = numbers[i];
        const orphan = run[i];
        if (period < 1 || period > 30 || found.has(period)) {
          continue;
        }
        const filled: RecognizedPeriod = {
          periodIndex: period,
          startMinute: orphan.startMinute,
          endMinute: orphan.endMinute,
          group: TimetableTextParser.groupFor(orphan.centerY, groups, period),
          inferred: true,
        };
        found.set(period, filled);
        anchors.push([period, orphan.centerY]);
        repaired++;
      }
    }
    return repaired;
  }

  /** 分组标签（上午/下午/晚上…）：取 y 最接近的标签；没有标签时按学校常见划分兜底 */
  private static groupFor(centerY: number, groups: Array<[string, number]>, period: number): string {
    let best: string | null = null;
    let bestDistance = Number.MAX_SAFE_INTEGER;
    for (const g of groups) {
      const d = Math.abs(g[1] - centerY);
      if (d < bestDistance) {
        bestDistance = d;
        best = g[0];
      }
    }
    if (best !== null) {
      return best;
    }
    if (period >= 1 && period <= 4) {
      return '上午';
    }
    if (period >= 5 && period <= 8) {
      return '下午';
    }
    return '晚上';
  }
}
