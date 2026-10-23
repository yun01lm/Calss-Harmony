/**
 * PDF 文本抽取的**平台侧**：把 PDF 丢给 ArkWeb 里的 pdf.js，拿回带坐标的文本片段。
 *
 * ## 为什么不是 PDF Kit
 *
 * 实测结论（`docs/SPIKES.md`）：
 * 1. `PdfPage.getTextContent()` 只返回**纯字符串**（没有坐标），而课表解析必须知道
 *    "这串字落在星期几那一列"，纯字符串用不上；
 * 2. `PdfPage.getGraphicsObjects()` 只包含用编辑 API **加进去**的对象，拿不到页面原有文字；
 * 3. 这台模拟器的镜像里连模块都没有（`typeof pdfService === undefined`）。
 *
 * 所以改走 ArkWeb + pdf.js：`textContent.items` 带 `transform` 矩阵，坐标齐全。
 *
 * ## 分工
 *
 * - `rawfile/pdfjs/viewer.html`：**唯一**懂 pdf.js 的地方（跑在 WebView 里，JS）；
 * - `logic/PdfRunText.ts`：解析它回传的制表符文本（纯逻辑，Node 上有断言）；
 * - 本文件：把 rawfile 的 PDF 编码成 base64 传进去，并给出取结果的 JS 片段。
 *
 * ## 结果怎么拿回来（踩过一次坑）
 *
 * 一开始用 `registerJavaScriptProxy` + `refresh()` 让 JS 回调 ArkTS。
 * 但 Web 组件改成"点了导入才创建"之后，创建/注册/重载的时序一旦错开，
 * JS 里的 `window.pdfBridge` 就是 undefined —— 解析结果**静默丢失**，
 * 界面一直卡在"解析中…"。现在改成：JS 把结果写进 `window.__pdfResult`，
 * ArkTS 用 `runJavaScript` **轮询**取（见 `pollScript` / `errorScript`）。
 */
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';

export class PdfJs {
  /**
   * 读 rawfile 里的 PDF 并编码成 base64。
   *
   * 为什么用 base64 而不是给 WebView 一个文件路径：ArkWeb 里 `fetch('file://...')`
   * 受同源/CORS 限制，而 `runJavaScript` 传字符串是最稳的一条路。
   * 课表 PDF 通常几百 KB，base64 膨胀 1/3 仍在可用范围。
   */
  static async readRawBase64(ctx: common.UIAbilityContext, name: string): Promise<string> {
    const data: Uint8Array = await ctx.resourceManager.getRawFileContent(name);
    const helper: util.Base64Helper = new util.Base64Helper();
    return helper.encodeToStringSync(data);
  }

  /**
   * 生成调用 `viewer.html` 里 `__runExtract` 的 JS 代码。
   * base64 只含 `A-Za-z0-9+/=`，直接放进双引号里是安全的（不需要转义）。
   */
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

  /** 页面是否已就绪（pdf.js 已加载） */
  static readonly READY_SCRIPT: string = '(window.pdfjsLib ? "1" : "")';
}
