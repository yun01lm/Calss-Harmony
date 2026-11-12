/**
 * ArkWeb 里 `viewer.html` 那套脚本的**契约常量**（纯字符串，零平台依赖）。
 *
 * 为什么单独放在逻辑层：这些字符串是 JS ↔ ArkTS 之间的接口名（`window.__runExtract`、
 * `window.__pageImg` …）。改了一边忘了另一边，症状是"`runJavaScript` 静默返回 null →
 * 卡在解析中/渲染超时"，而这在真机上排查一次要十几分钟。放在这里就能在 Node 上断言
 * （`tests/pdf-page-images.test.ts`），也让 `platform/PdfJs.ts` 只剩"读文件"这一件平台事。
 *
 * 完整背景见 `platform/PdfJs.ts` 的文档（为什么不用 PDF Kit、为什么不用代理回调）。
 */
export class PdfScripts {
  // ---------------------------------------------------------------- 文字层

  /** 生成调用 `viewer.html` 里 `__runExtract` 的 JS 代码。base64 只含 `A-Za-z0-9+/=`，放双引号里安全 */
  static extractCall(base64: string): string {
    return '__runExtract("' + base64 + '")';
  }

  /** 取"成功结果"的 JS 片段（空串 = 还没算完） */
  static readonly RESULT_SCRIPT: string = 'window.__pdfResult';

  /** 取"失败结果"的 JS 片段（空串 = 没出错） */
  static readonly ERROR_SCRIPT: string = 'window.__pdfError';

  /**
   * 开始新一轮抽取前必须先清空上一次的返回值。
   *
   * 不清的后果是**上一个文件的结果被当成这一个文件的**：`__pdfResult` 一直留着，
   * 新文件的 `__runExtract` 还没开始（或直接失败），轮询第一轮就读到旧值，
   * 界面显示 B 的文件名、里面是 A 的课，"覆盖当前课表"就真的把 A 写进库了。
   */
  static readonly CLEAR_SCRIPT: string =
    'window.__pdfResult = null; window.__pdfError = null; ""';

  /**
   * 页面是否**可以开始解析**：这里认的是入口函数，不是 `pdfjsLib`。
   *
   * 曾经判的是 `window.pdfjsLib`，于是有一个真实的竞态窗口：viewer.html 里
   * `pdf.min.js`（1.3MB）先执行、入口函数在**后面**的内联脚本里才定义。中间隔着
   * `cmaps-data.js`（182KB 字面量）的解析时间 —— 在这段时间里"就绪"已经为真、
   * 入口函数还不存在，紧接着的探针就会报「解析器页面没就绪（入口函数不存在）」。
   * 上架审核（真机、冷启动第一次点导入）就是这么撞上的；模拟器上加载快，从没复现。
   */
  static readonly READY_SCRIPT: string = '(typeof window.__runExtract === "function" ? "1" : "")';

  /** 入口函数是否已定义（就绪之后的第二道确认，见 `Index.ensurePdfReady`） */
  static readonly ENTRY_SCRIPT: string = 'typeof window.__runExtract';

  // ---------------------------------------------------------------- 页面 → 图片（OCR 兜底）

  /**
   * 没有文字层的 PDF 要变成图片才能识别，这一组脚本负责"打开文档 → 逐页渲染成 PNG"。
   *
   * 为什么复用同一个 Web 通道而不是另起一套：PDF 的字节已经以 base64 在 JS 里了，
   * 再走一次 pdf.js 的 `getDocument` 就能拿到 canvas 渲染能力，不需要新的依赖。
   */
  static readonly OCR_RESET_SCRIPT: string =
    'window.__ocrState = ""; window.__ocrPages = 0; window.__ocrErr = "";' +
      ' window.__pageImg = ""; window.__ocrDoc = null; ""';

  /** `ready` = 文档已打开、`pages` 有值；`error` = 打开失败，原因在 `__ocrErr` */
  static readonly OCR_STATE_SCRIPT: string = 'window.__ocrState';
  static readonly OCR_PAGES_SCRIPT: string = 'window.__ocrPages';
  static readonly OCR_ERROR_SCRIPT: string = 'window.__ocrErr';

  /** 渲染结果：空串 = 还没好；`IMG\t<base64>` = 好；`ERR\t<原因>` = 失败 */
  static readonly PAGE_IMG_SCRIPT: string = 'window.__pageImg';
  static readonly PAGE_IMG_RESET_SCRIPT: string = 'window.__pageImg = ""; ""';

  /** 打开 PDF（只建文档对象，不渲染）：`__ocrOpen("<base64>")` */
  static ocrOpenCall(base64: string): string {
    return '__ocrOpen("' + base64 + '")';
  }

  /**
   * 渲染第 `pageNo` 页为 PNG。`targetWidth` 是目标像素宽：
   * 太小识别不清，太大会让回传的 base64 撑爆 `runJavaScript` 的返回值。
   */
  static ocrRenderCall(pageNo: number, targetWidth: number): string {
    return '__ocrRender(' + pageNo + ', ' + targetWidth + ')';
  }
}
