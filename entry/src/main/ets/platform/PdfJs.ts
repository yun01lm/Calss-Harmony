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
 * - 本文件：桥接（注册 JS 代理、把 rawfile 的 PDF 编码成 base64 传进去）。
 *
 * ArkWeb 与 ArkTS 之间的回调必须经过 `registerJavaScriptProxy` 注册的对象；
 * 而那个对象的 `this` 在 JS 调用时不可靠，所以这里用**静态 sink** 把回调转给页面。
 */
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';

/** JS 回传的接收方（页面的一个薄包装，见 `PayloadSink`） */
export interface PdfPayloadSink {
  receive(payload: string): void;
}

/**
 * 挂在 `window.pdfBridge` 上的对象。
 * 注意：方法名必须与 `viewer.html` 里调用的名字一致（`report`），
 * 注册时 `methodList: ['report']` 也要一致，否则 JS 侧调用直接失败。
 */
export class PdfBridge {
  private static sink: PdfPayloadSink | null = null;

  static setSink(sink: PdfPayloadSink | null): void {
    PdfBridge.sink = sink;
  }

  report(payload: string): void {
    const sink: PdfPayloadSink | null = PdfBridge.sink;
    if (sink !== null) {
      sink.receive(payload);
    }
  }
}

/** 把"函数"包成接口实例（ArkTS 的结构体不能直接 implements 接口） */
export class PayloadSink implements PdfPayloadSink {
  private readonly handler: (payload: string) => void;

  constructor(handler: (payload: string) => void) {
    this.handler = handler;
  }

  receive(payload: string): void {
    this.handler(payload);
  }
}

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
}
