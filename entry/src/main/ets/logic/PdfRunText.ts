/**
 * pdf.js 回传文本的解析（纯逻辑，零平台依赖）。
 *
 * ArkWeb 里的 `viewer.html` 用**制表符分隔的纯文本**回传带坐标的文本片段：
 *
 * ```
 * OK
 * 1\t58.20\t123.40\t96.70\t9.00\t星期三
 * 1\t101.50\t123.20\t125.00\t9.00\t5-6
 * END
 * ```
 *
 * 为什么不用 JSON：ArkTS 里 `JSON.parse` 返回 `Object`，逐字段取要写一堆类型断言/强转，
 * 而字段少、结构固定时纯文本 split 更直接，也不会出现"数字被解析成字符串"这种类型漂移。
 *
 * 为什么这一层单独放、还要有断言：它是**跨语言契约**（JS 产、ArkTS 消费）。
 * 一旦哪边改了字段顺序或分隔符，症状会是"PDF 导入莫名其妙只有 0 门课"，
 * 那种问题在真机上排查一次要十几分钟 —— 用断言钉住便宜得多。
 */
import { type PdfExtractResult, type PdfTextRun } from './PdfModels.ts';

export class PdfRunText {
  /** 完好的标记（viewer.html 正常结束时发它） */
  static readonly HEADER_OK: string = 'OK';
  /** 失败标记前缀 */
  static readonly HEADER_ERR: string = 'ERR\t';
  /** 结束标记 */
  static readonly END: string = 'END';

  /** 每行固定 5 个数值字段 + 1 个文本字段 */
  static readonly FIELD_COUNT: number = 6;

  /**
   * 把带坐标的片段还原成"视觉上的行"（左→右、上→下）。
   *
   * 为什么要这一步：**作息表导入**（`TimetableTextParser`）吃的是纯文本行，
   * 而 pdf.js 给的是碎片（`1` / `8:00` / `-` / `8:45` 各是一个片段）。
   * 不还原就直接 join，会得到 `18:00-8:45` 这种拼错的时间。
   *
   * 坐标语义：`viewer.html` 回传的是**视口坐标**（y 向下增大），所以 y 越小越靠上。
   * 同一行的判定用 `max(2, fontSize/2)` 的容差 —— PDF 里同一行的字基线会差零点几，
   * 但不会差半个字高。
   */
  static toLines(runs: PdfTextRun[]): string[] {
    const sorted: PdfTextRun[] = runs.slice().sort((a: PdfTextRun, b: PdfTextRun) => {
      if (a.page !== b.page) {
        return a.page - b.page;
      }
      if (a.y !== b.y) {
        return a.y - b.y;
      }
      return a.x - b.x;
    });

    const lines: string[] = [];
    let bucket: PdfTextRun[] = [];
    let bucketPage: number = 0;
    let bucketY: number = 0;
    let bucketTolerance: number = 2;

    const flush = (): void => {
      if (bucket.length === 0) {
        return;
      }
      bucket.sort((a: PdfTextRun, b: PdfTextRun) => a.x - b.x);
      const parts: string[] = [];
      for (const r of bucket) {
        const text: string = r.text.trim();
        if (text.length > 0) {
          parts.push(text);
        }
      }
      if (parts.length > 0) {
        lines.push(parts.join(' '));
      }
      bucket = [];
    };

    for (const run of sorted) {
      if (run.text.trim().length === 0) {
        continue;
      }
      const tolerance: number = Math.max(2, run.fontSize / 2);
      const sameLine: boolean = bucket.length > 0 && run.page === bucketPage &&
        Math.abs(run.y - bucketY) <= Math.max(tolerance, bucketTolerance);
      if (!sameLine) {
        flush();
        bucketPage = run.page;
        bucketY = run.y;
        bucketTolerance = tolerance;
      }
      bucket.push(run);
    }
    flush();
    return lines;
  }

  static parse(payload: string): PdfExtractResult {
    const runs: PdfTextRun[] = [];
    if (payload.length === 0) {
      return PdfRunText.result(false, '解析结果为空（页面没有回传数据）', runs, 0);
    }

    const lines: string[] = payload.split('\n');
    const header: string = lines.length > 0 ? lines[0] : '';

    if (header !== PdfRunText.HEADER_OK) {
      const error: string = header.startsWith(PdfRunText.HEADER_ERR)
        ? header.substring(PdfRunText.HEADER_ERR.length)
        : '无法识别的回传头：' + header;
      return PdfRunText.result(false, error, runs, 0);
    }

    let malformed = 0;
    for (let i = 1; i < lines.length; i++) {
      const line: string = lines[i];
      if (line === PdfRunText.END) {
        break;
      }
      if (line.length === 0) {
        continue;
      }
      const run: PdfTextRun | null = PdfRunText.parseRun(line);
      if (run === null) {
        malformed++;
      } else {
        runs.push(run);
      }
    }

    let pageCount = 0;
    for (const r of runs) {
      if (r.page > pageCount) {
        pageCount = r.page;
      }
    }
    return PdfRunText.result(true, '', runs, malformed, pageCount);
  }

  /**
   * 一行 → 一个文本片段。
   * 文本字段直接取"第 5 个制表符之后的全部内容"，因此文本里出现制表符也不会错位
   * （viewer.html 会把真正的制表符替换成空格，这里是第二道保险）。
   */
  private static parseRun(line: string): PdfTextRun | null {
    const parts: string[] = [];
    let start = 0;
    for (let k = 0; k < PdfRunText.FIELD_COUNT - 1; k++) {
      const idx: number = line.indexOf('\t', start);
      if (idx < 0) {
        return null;
      }
      parts.push(line.substring(start, idx));
      start = idx + 1;
    }
    parts.push(line.substring(start));

    const page: number = Number.parseFloat(parts[0]);
    const x: number = Number.parseFloat(parts[1]);
    const y: number = Number.parseFloat(parts[2]);
    const endX: number = Number.parseFloat(parts[3]);
    const fontSize: number = Number.parseFloat(parts[4]);
    if (Number.isNaN(page) || Number.isNaN(x) || Number.isNaN(y) ||
      Number.isNaN(endX) || Number.isNaN(fontSize)) {
      return null;
    }
    if (page < 1) {
      return null;
    }
    const run: PdfTextRun = {
      text: parts[5],
      x: x,
      y: y,
      endX: endX,
      fontSize: fontSize,
      page: Math.trunc(page),
    };
    return run;
  }

  private static result(
    ok: boolean,
    error: string,
    runs: PdfTextRun[],
    malformed: number,
    pageCount: number = 0
  ): PdfExtractResult {
    const r: PdfExtractResult = {
      ok: ok,
      error: error,
      runs: runs,
      pageCount: pageCount,
      malformed: malformed,
    };
    return r;
  }
}
