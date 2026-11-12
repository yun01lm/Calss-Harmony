/**
 * PDF 文本抽取的**平台侧**：只负责"把 rawfile 里的 PDF 读成 base64"。
 *
 * 真正跑 pdf.js 的地方是 `rawfile/pdfjs/viewer.html`（ArkWeb 里的 JS）；
 * 与它对话用的脚本名/片段在 `logic/PdfScripts.ts`（纯字符串，可在 Node 上断言）。
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
 * ## 结果怎么拿回来（踩过一次坑）
 *
 * 一开始用 `registerJavaScriptProxy` + `refresh()` 让 JS 回调 ArkTS。
 * 但 Web 组件改成"点了导入才创建"之后，创建/注册/重载的时序一旦错开，
 * JS 里的 `window.pdfBridge` 就是 undefined —— 解析结果**静默丢失**，
 * 界面一直卡在"解析中…"。现在改成：JS 把结果写进 `window.__pdfResult`，
 * ArkTS 用 `runJavaScript` **轮询**取（见 `PdfScripts.RESULT_SCRIPT`）。
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
}
