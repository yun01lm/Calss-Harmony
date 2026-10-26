/**
 * 两个**技术可行性验证**（spike）—— 阶段 3 做导入之前必须先把结论拿到手。
 *
 * 只在开发者入口里跑，不进正常流程。验证的是"平台到底给不给我们要的数据"：
 *
 * ## Spike B：PDF Kit 能不能给"带坐标的文本片段"
 * `logic/GridFormatParser.ts` / `ListFormatParser.ts` 依赖每个文本片段的 `(x, y)`：
 * 没有坐标就判断不出"这串字属于星期几那一列"，网格版式直接无从下手。
 * 所以这里依次试三条路，看哪条走得通：
 * 1. `PdfPage.getTextContent()` —— 文档说是纯字符串（无坐标），验证一下到底是不是；
 * 2. `PdfPage.getGraphicsObjects()` —— 返回按位置排序的图形对象，其中的 `OBJECT_TEXT`
 *    带 `x/y` 与 `text`。**关键问题：它包含页面原有的文字，还是只包含自己用 API 加进去的？**
 * 3. `PdfPage.getPagePixelMap()` —— 光栅化。若前两条都不行，PDF 就只能走"渲染成图 + OCR"。
 *
 * ## Spike C：Core Vision Kit 的中文 OCR 粒度
 * `logic/TimetableTextParser.ts` 要的是"一行文字 + 包围盒"。这里把 OCR 结果真的喂给它，
 * 看能不能从合成作息表里认出 10 节以上 —— 比"能识别出字"更强的结论。
 */
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo } from '@kit.CoreFileKit';
import { image } from '@kit.ImageKit';
import { pdfService } from '@kit.PDFKit';
import { textRecognition } from '@kit.CoreVisionKit';
import { OcrLine } from '../logic/TimetableTextParser.ts';
import { TimetableTextParser } from '../logic/TimetableTextParser.ts';
import { type RecognizedPeriod } from '../logic/TimetableTextParser.ts';

/** 一行验证结果 */
export interface SpikeLine {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

export class SpikeProbe {
  static async runAll(ctx: common.UIAbilityContext): Promise<SpikeLine[]> {
    const lines: SpikeLine[] = [];
    // 先看两个 Kit 在这台设备上到底在不在（模拟器常常缺 HMS 能力，这行最直观）
    SpikeProbe.push(
      lines,
      'PDF Kit 模块是否存在',
      pdfService !== undefined && pdfService !== null,
      'typeof pdfService = ' + (typeof pdfService)
    );
    SpikeProbe.push(
      lines,
      'Core Vision 模块是否存在',
      textRecognition !== undefined && textRecognition !== null,
      'typeof textRecognition = ' + (typeof textRecognition)
    );
    await SpikeProbe.pdf(ctx, lines);
    await SpikeProbe.ocr(ctx, lines);
    return lines;
  }

  // ---------------------------------------------------------------- PDF

  private static async pdf(ctx: common.UIAbilityContext, lines: SpikeLine[]): Promise<void> {
    let doc: pdfService.PdfDocument | null = null;
    let page: pdfService.PdfPage | null = null;
    try {
      const path: string = await SpikeProbe.copyRawFile(ctx, 'spike-timetable.pdf');
      doc = new pdfService.PdfDocument();
      const parsed: pdfService.ParseResult = doc.loadDocument(path);
      SpikeProbe.push(
        lines,
        'PDF: loadDocument',
        parsed === pdfService.ParseResult.PARSE_SUCCESS,
        'ParseResult=' + parsed
      );
      const pageCount: number = doc.getPageCount();
      SpikeProbe.push(lines, 'PDF: 页数', pageCount > 0, String(pageCount));
      if (pageCount <= 0) {
        return;
      }

      const pageObj: pdfService.PdfPage = doc.getPage(0);
      page = pageObj;
      SpikeProbe.push(
        lines,
        'PDF: 页面尺寸(point)',
        true,
        `${Math.round(pageObj.getWidth())} x ${Math.round(pageObj.getHeight())}`
      );

      // 路线 1：纯文本
      try {
        const text: string = pageObj.getTextContent();
        const head: string = text.length > 200 ? text.substring(0, 200) + '…' : text;
        SpikeProbe.push(
          lines,
          '路线1 getTextContent() 长度',
          text.length > 0,
          `${text.length} 字符：${head.replace(/\n/g, '⏎')}`
        );
      } catch (e) {
        SpikeProbe.push(lines, '路线1 getTextContent()', false, SpikeProbe.errText(e));
      }

      // 路线 2：图形对象里的文本（关键：有没有坐标、含不含页面原有文字）
      try {
        const objects: pdfService.GraphicsObject[] = pageObj.getGraphicsObjects();
        let textCount = 0;
        const samples: string[] = [];
        for (const obj of objects) {
          if (obj.type === pdfService.GraphicsObjectType.OBJECT_TEXT) {
            textCount++;
            if (samples.length < 5) {
              const t = obj as pdfService.TextObject;
              samples.push(`"${t.text}"@(${Math.round(obj.x)},${Math.round(obj.y)})`);
            }
          }
        }
        SpikeProbe.push(
          lines,
          '路线2 getGraphicsObjects() 文本对象数',
          textCount > 0,
          `共 ${objects.length} 个对象，其中文本 ${textCount} 个${samples.length > 0 ? '：' + samples.join(' | ') : '（只有自己加进去的才算）'}`
        );
      } catch (e) {
        SpikeProbe.push(lines, '路线2 getGraphicsObjects()', false, SpikeProbe.errText(e));
      }

      // 路线 3：光栅化（若前两条不通，PDF 只能走"渲染成图 + OCR"）
      try {
        const pixelMap: image.PixelMap = pageObj.getPagePixelMap();
        const info: image.ImageInfo = await pixelMap.getImageInfo();
        SpikeProbe.push(
          lines,
          '路线3 getPagePixelMap() 可渲染',
          info.size.width > 0,
          `${info.size.width} x ${info.size.height}`
        );
        pixelMap.release();
      } catch (e) {
        SpikeProbe.push(lines, '路线3 getPagePixelMap()', false, SpikeProbe.errText(e));
      }

      pageObj.release();
      page = null;
    } catch (e) {
      SpikeProbe.push(lines, 'PDF: 调用失败（可能模拟器不支持该 Kit）', false, SpikeProbe.errText(e));
    } finally {
      // page 原来只在成功路径上 release：抛错时 PDF 页对象留在内存里（每按一次泄漏一个）
      if (page !== null) {
        try {
          page.release();
        } catch (e2) {
          SpikeProbe.push(lines, 'PDF: page.release() 失败', false, SpikeProbe.errText(e2));
        }
      }
      if (doc !== null) {
        try {
          doc.releaseDocument();
        } catch (e) {
          // 释放失败不影响结论
        }
      }
    }
  }

  // ---------------------------------------------------------------- OCR

  private static async ocr(ctx: common.UIAbilityContext, lines: SpikeLine[]): Promise<void> {
    let pixelMap: image.PixelMap | null = null;
    let source: image.ImageSource | null = null;
    // 服务是否 init 过：只有 init 过才需要 release（没 init 就 release 会抛错，把真结论盖掉）
    let serviceTouched = false;
    try {
      const path: string = await SpikeProbe.copyRawFile(ctx, 'spike-schedule.png');
      source = image.createImageSource(path);
      pixelMap = await source.createPixelMap({
        desiredPixelFormat: image.PixelMapFormat.RGBA_8888,
      });
      const info: image.ImageInfo = await pixelMap.getImageInfo();
      SpikeProbe.push(lines, 'OCR: 图片载入', info.size.width > 0, `${info.size.width} x ${info.size.height}`);

      // init / 语言列表都是"锦上添花"，失败不该埋掉真正的结论（能不能识别）
      let inited = false;
      try {
        inited = await textRecognition.init();
        serviceTouched = true;
        SpikeProbe.push(lines, 'OCR: init()', inited, String(inited));
      } catch (e) {
        SpikeProbe.push(lines, 'OCR: init() 失败（继续试识别）', false, SpikeProbe.errText(e));
      }
      try {
        const languages: Array<string> = await textRecognition.getSupportedLanguages();
        SpikeProbe.push(
          lines,
          'OCR: 支持语言',
          languages.length > 0,
          languages.join(', ')
        );
      } catch (e) {
        SpikeProbe.push(lines, 'OCR: getSupportedLanguages()', false, SpikeProbe.errText(e));
      }

      // 错误码 200 = "Run timed out"（服务在，但这次没算完）。重试 3 次，看是不是首次加载模型的偶发超时
      let result: textRecognition.TextRecognitionResult | null = null;
      let lastError: string = '';
      let attempts = 0;
      for (let i = 0; i < 3; i++) {
        attempts++;
        try {
          result = await textRecognition.recognizeText(
            { pixelMap: pixelMap },
            { isDirectionDetectionSupported: false }
          );
          break;
        } catch (e) {
          lastError = SpikeProbe.errText(e);
        }
      }
      if (result === null) {
        SpikeProbe.push(lines, 'OCR: recognizeText（重试 ' + attempts + ' 次）', false, lastError);
        return;
      }
      SpikeProbe.push(
        lines,
        'OCR: 识别结果',
        result.value.length > 0,
        `${result.blocks.length} 块 / ${result.value.length} 字符`
      );

      // 把 OCR 结果真的喂给作息解析器 —— 比"认得字"更强的结论
      const ocrLines: OcrLine[] = [];
      for (const block of result.blocks) {
        for (const line of block.lines) {
          const box: number[] = SpikeProbe.boundsOf(line.cornerPoints);
          ocrLines.push(new OcrLine(line.value, box[0], box[1], box[2], box[3]));
        }
      }
      SpikeProbe.push(
        lines,
        'OCR: 行数（含包围盒）',
        ocrLines.length > 0,
        `${ocrLines.length} 行` + (ocrLines.length > 0 ? `，首行 "(${ocrLines[0].left},${ocrLines[0].top}) ${ocrLines[0].text}"` : '')
      );

      const parsed: TimetableTextParserResult = TimetableTextParser.parse(ocrLines) as TimetableTextParserResult;
      const periods: RecognizedPeriod[] = parsed.periods;
      let detail = `${periods.length} 节`;
      if (periods.length > 0) {
        const first: RecognizedPeriod = periods[0];
        const last: RecognizedPeriod = periods[periods.length - 1];
        detail += `，第 ${first.periodIndex} 节 ${SpikeProbe.hhmm(first.startMinute)}-${SpikeProbe.hhmm(first.endMinute)}` +
          ` … 第 ${last.periodIndex} 节 ${SpikeProbe.hhmm(last.startMinute)}-${SpikeProbe.hhmm(last.endMinute)}`;
      }
      if (parsed.warnings.length > 0) {
        detail += '；警告：' + parsed.warnings.join(' / ');
      }
      SpikeProbe.push(lines, 'OCR → 作息解析', periods.length >= 8, detail);
    } catch (e) {
      SpikeProbe.push(lines, 'OCR: 调用失败（可能模拟器不支持该 Kit）', false, SpikeProbe.errText(e));
    } finally {
      // 三条资源都必须放 here：原来 `textRecognition.release()` 只在成功路径上调用，
      // 中途 return / 抛错都会漏；`source` 则一次都没释放（每按一次探测泄漏一个 ImageSource）
      if (serviceTouched) {
        try {
          await textRecognition.release();
        } catch (e2) {
          // 释放失败不影响结论，但要留下痕迹
          SpikeProbe.push(lines, 'OCR: release() 失败', false, SpikeProbe.errText(e2));
        }
      }
      if (pixelMap !== null) {
        try {
          pixelMap.release();
        } catch (e3) {
          SpikeProbe.push(lines, 'OCR: pixelMap.release() 失败', false, SpikeProbe.errText(e3));
        }
      }
      if (source !== null) {
        try {
          source.release();
        } catch (e4) {
          SpikeProbe.push(lines, 'OCR: ImageSource.release() 失败', false, SpikeProbe.errText(e4));
        }
      }
    }
  }

  // ---------------------------------------------------------------- 工具

  private static async copyRawFile(ctx: common.UIAbilityContext, name: string): Promise<string> {
    const data: Uint8Array = await ctx.resourceManager.getRawFileContent(name);
    const path: string = ctx.cacheDir + '/' + name;
    const file: fileIo.File = fileIo.openSync(
      path,
      fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC
    );
    try {
      fileIo.writeSync(file.fd, data.buffer as ArrayBuffer);
    } finally {
      fileIo.closeSync(file);
    }
    return path;
  }

  /** 包围盒：取四个角的最小/最大值 */
  private static boundsOf(points: Array<textRecognition.PixelPoint>): number[] {
    let left = Number.MAX_SAFE_INTEGER;
    let top = Number.MAX_SAFE_INTEGER;
    let right = 0;
    let bottom = 0;
    for (const p of points) {
      if (p.x < left) {
        left = p.x;
      }
      if (p.y < top) {
        top = p.y;
      }
      if (p.x > right) {
        right = p.x;
      }
      if (p.y > bottom) {
        bottom = p.y;
      }
    }
    if (points.length === 0) {
      return [0, 0, 0, 0];
    }
    return [left, top, right, bottom];
  }

  private static hhmm(minute: number): string {
    const h: number = Math.floor(minute / 60);
    const m: number = minute % 60;
    return `${h}:${m < 10 ? '0' : ''}${m}`;
  }

  private static push(lines: SpikeLine[], label: string, ok: boolean, detail: string): void {
    const line: SpikeLine = { label: label, ok: ok, detail: detail };
    lines.push(line);
  }

  private static errText(e: object): string {
    const err = e as BusinessError;
    if (err.code !== undefined) {
      return `[${err.code}] ${err.message}`;
    }
    return String(e);
  }
}

/** `TimetableTextParser.parse` 的返回类型（避免把整个模块的类型都 import 进来） */
interface TimetableTextParserResult {
  readonly periods: RecognizedPeriod[];
  readonly warnings: string[];
}
