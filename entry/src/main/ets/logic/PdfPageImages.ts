/**
 * 「PDF 没有文字层 → 渲染成图 → 设备端 OCR」这一段里的**纯逻辑**（零平台依赖）。
 *
 * 背景：扫描件、以及字形码没有 Unicode 映射的 PDF（CID 字体缺 ToUnicode），
 * pdf.js 的 `getTextContent()` 一个可读字符都取不出来 —— 这不是 bug，是文件本身的限制。
 * 唯一的出路是把页面画成位图再识别，而识别那一步是系统 OCR（`platform/Ocr.ts`）。
 *
 * 这里放两件在 Node 上就能钉住的事：
 * 1. `viewer.html` 的渲染回传格式（`IMG\t<base64>` / `ERR\t<原因>`）—— 跨语言契约，
 *    和 `PdfRunText` 的制表符载荷一样，改错一边的症状是"识别莫名其妙空白"；
 * 2. 多页 OCR 结果按页拼成一份带 y 偏移的行列表 —— 不偏移的话第 2 页的行会和第 1 页
 *    交错（作息解析按"谁在谁上面"排顺序，交错就会读出乱序的节次）。
 */
import { OcrLine } from './TimetableTextParser.ts';

/** 一页渲染后的识别结果（坐标是 OCR 实际解码后的像素坐标） */
export interface OcrPage {
  /** 1 起 */
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly lines: OcrLine[];
}

/** 渲染回传的解析结果 */
export interface PageImagePayload {
  readonly ok: boolean;
  readonly error: string;
  readonly base64: string;
}

export class PdfPageImages {
  /** 渲染成功的标记（`viewer.html` 的 `__ocrRender` 写入） */
  static readonly HEADER_IMAGE: string = 'IMG\t';
  /** 渲染失败的标记前缀 */
  static readonly HEADER_ERROR: string = 'ERR\t';

  /** 页与页之间留的空隙（像素）；纯为了"下一页的行永远在第一页下面" */
  static readonly PAGE_GAP: number = 24;

  /** 一次最多识别几页：多页课表罕见，而每页都是一次完整的 OCR（时间 + 内存） */
  static readonly MAX_PAGES: number = 3;

  /** 渲染宽度（像素）：小字要看清，又不能大到让 base64 撑爆 `runJavaScript` 的返回值 */
  static readonly RENDER_WIDTH: number = 1400;

  /** `IMG\t<base64>` / `ERR\t<原因>` → 可用结果 */
  static parse(payload: string): PageImagePayload {
    if (payload.length === 0) {
      return PdfPageImages.result(false, '渲染结果为空（页面没有回传数据）', '');
    }
    if (payload.startsWith(PdfPageImages.HEADER_ERROR)) {
      return PdfPageImages.result(false, payload.substring(PdfPageImages.HEADER_ERROR.length), '');
    }
    if (!payload.startsWith(PdfPageImages.HEADER_IMAGE)) {
      const head: string = payload.length > 24 ? payload.substring(0, 24) : payload;
      return PdfPageImages.result(false, '无法识别的渲染回传：' + head, '');
    }
    const base64: string = payload.substring(PdfPageImages.HEADER_IMAGE.length);
    if (base64.length === 0) {
      return PdfPageImages.result(false, '渲染回传里没有图片数据', '');
    }
    return PdfPageImages.result(true, '', base64);
  }

  /** 实际要识别几页（不超过 `MAX_PAGES`） */
  static pagesToRender(numPages: number): number {
    if (numPages < 1) {
      return 0;
    }
    return numPages > PdfPageImages.MAX_PAGES ? PdfPageImages.MAX_PAGES : numPages;
  }

  /**
   * 多页识别结果 → 一份行列表（按页顺序，后一页的 y 平移到最后一行下面）。
   *
   * 为什么要平移：`OcrLine` 的坐标是**每页各自**的像素坐标，两页的 y 都是从 0 开始。
   * 直接拼起来，第 2 页第一行的 y 会比第 1 页最后一行还小 —— 任何按 y 排序的解析器
   * 都会把两页交错。
   */
  static stackPages(pages: OcrPage[]): OcrLine[] {
    const out: OcrLine[] = [];
    let offset: number = 0;
    for (const page of pages) {
      for (const line of page.lines) {
        out.push(new OcrLine(line.text, line.left, line.top + offset, line.right, line.bottom + offset));
      }
      const h: number = page.height > 0 ? page.height : 0;
      offset += h + PdfPageImages.PAGE_GAP;
    }
    return out;
  }

  private static result(ok: boolean, error: string, base64: string): PageImagePayload {
    const r: PageImagePayload = { ok: ok, error: error, base64: base64 };
    return r;
  }
}
