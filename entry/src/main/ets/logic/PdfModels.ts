/**
 * PDF 解析的数据形状与公共类型。
 *
 * 与 Android 版 `pdf/TextRun.kt`＋`pdf/SchedulePdfParser.kt` 里的数据类型一一对应。
 * **纯数据、零平台依赖**：坐标从哪来（PDF Kit / pdf.js / 其它）由 `platform/` 层决定，
 * 这里只负责"拿到带坐标的文字块之后怎么还原成课表"。
 */

/**
 * 一段带坐标的文本块（PDF 里一次 Tj 绘制的文字）。
 *
 * 坐标约定：**x 向右递增、y 向下递增**（与 Android 侧 PdfBox 的 getXDirAdj/getYDirAdj
 * 归一化结果一致）。`page` 从 1 开始 —— 多页课表必须有它：
 * 每页 y 都从自己页顶重新开始，只用 y 排序会把第 2 页内容插到第 1 页中间
 * （实测某校课表正是因为缺这个字段，12 门课被解析成 12 条全乱记录）。
 */
export interface PdfTextRun {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly endX: number;
  readonly fontSize: number;
  readonly page: number;
}

/** 文本块中心 x（判"落在哪一列"用） */
export function centerXOf(run: PdfTextRun): number {
  return (run.x + run.endX) / 2;
}

/** 一门课的一个上课时段 */
export interface RawSchedule {
  readonly dayOfWeek: number;
  readonly startPeriod: number;
  readonly endPeriod: number;
  /** 周次位掩码（bigint，对应 Android 的 Long） */
  readonly weekMask: bigint;
}

/** 解析出来的一门课（尚未入库） */
export interface RawCourse {
  readonly name: string;
  readonly teacher: string;
  readonly location: string;
  readonly category: string;
  readonly schedules: RawSchedule[];
}

/** 一次解析的结果 */
export interface ParseResult {
  readonly courses: RawCourse[];
  readonly format: string;
  readonly warnings: string[];
}

/** 空结果（带格式与原因） */
export function emptyResult(format: string, warnings: string[]): ParseResult {
  const r: ParseResult = { courses: [], format, warnings };
  return r;
}

/** 按多个键稳定排序的辅助：先用比较器序列，便于写成 (page, y) 这种复合键 */
export function compareByPageThenY(a: PdfTextRun, b: PdfTextRun): number {
  if (a.page !== b.page) {
    return a.page - b.page;
  }
  return a.y - b.y;
}

/** 去掉首尾的指定字符（等价于 Kotlin 的 trim(',', '，', …)） */
export function trimChars(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.indexOf(text.charAt(start)) >= 0) {
    start++;
  }
  while (end > start && chars.indexOf(text.charAt(end - 1)) >= 0) {
    end--;
  }
  return text.substring(start, end);
}
