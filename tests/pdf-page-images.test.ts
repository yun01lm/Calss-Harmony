/**
 * 「PDF 没有文字层 → 渲染成图 → OCR」这一段里的纯逻辑断言（`logic/PdfPageImages.ts`）。
 *
 * 两件在 Node 上能钉住的事：
 * 1. `viewer.html` 的渲染回传格式（跨语言契约，和 `PdfRunText` 的制表符载荷同级）；
 * 2. 多页结果按页拼 y 偏移（不偏移的话作息解析会把两页的行交错）。
 *
 * 再加一条**契约测试**：`platform/PdfJs.ts` 里的全局变量名必须和 `viewer.html` 里定义的一致。
 * 改 JS 那边忘了改 ArkTS，症状是"渲染超时 45 秒"，在真机上排查一次要十几分钟。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PdfPageImages, type OcrPage } from '../entry/src/main/ets/logic/PdfPageImages.ts';
import { OcrLine } from '../entry/src/main/ets/logic/TimetableTextParser.ts';
import { PdfScripts } from '../entry/src/main/ets/logic/PdfScripts.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function viewerHtml(): string {
  return readFileSync(`${ROOT}entry/src/main/resources/rawfile/pdfjs/viewer.html`, 'utf8');
}

test('parse：IMG 回传 → base64', () => {
  const r = PdfPageImages.parse('IMG\tiVBORw0KGgoAAAANSUhEUg');
  assert.equal(r.ok, true);
  assert.equal(r.error, '');
  assert.equal(r.base64, 'iVBORw0KGgoAAAANSUhEUg');
});

test('parse：ERR 回传 → 带原因、没有图片数据', () => {
  const r = PdfPageImages.parse('ERR\t文档还没打开');
  assert.equal(r.ok, false);
  assert.match(r.error, /文档还没打开/);
  assert.equal(r.base64, '');
});

test('parse：空回传与未知头（不能把 garbage 当 base64 交给解码器）', () => {
  assert.equal(PdfPageImages.parse('').ok, false);
  assert.match(PdfPageImages.parse('').error, /为空/);
  const bad = PdfPageImages.parse('IMG\t');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /没有图片数据/);
  const weird = PdfPageImages.parse('data:image/png;base64,AAAA');
  assert.equal(weird.ok, false);
  assert.match(weird.error, /无法识别的渲染回传/);
});

test('pagesToRender：0 页不识别，超过上限时截断', () => {
  assert.equal(PdfPageImages.pagesToRender(0), 0);
  assert.equal(PdfPageImages.pagesToRender(1), 1);
  assert.equal(PdfPageImages.pagesToRender(PdfPageImages.MAX_PAGES), PdfPageImages.MAX_PAGES);
  assert.equal(PdfPageImages.pagesToRender(PdfPageImages.MAX_PAGES + 5), PdfPageImages.MAX_PAGES);
});

test('stackPages：第 2 页的行整体落到第 1 页下面（不交错）', () => {
  const pages: OcrPage[] = [
    { pageIndex: 1, width: 800, height: 1000, lines: [new OcrLine('1 8:00-8:45', 10, 10, 100, 40)] },
    { pageIndex: 2, width: 800, height: 900, lines: [new OcrLine('11 8:00-8:45', 10, 5, 100, 35)] },
  ];
  const merged = PdfPageImages.stackPages(pages);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].top, 10);
  // 第 2 页的第一行（本页 y=5）必须比第 1 页最后一行（y=10）更靠下
  assert.equal(merged[1].top, 1000 + PdfPageImages.PAGE_GAP + 5);
  assert.ok(merged[1].top > merged[0].bottom);
  // 水平坐标不参与页间平移
  assert.equal(merged[1].left, 10);
});

test('stackPages：空页不影响后面的偏移（页数少时不会负偏移）', () => {
  const pages: OcrPage[] = [
    { pageIndex: 1, width: 800, height: 0, lines: [] },
    { pageIndex: 2, width: 800, height: 600, lines: [new OcrLine('x', 1, 7, 2, 9)] },
  ];
  const merged = PdfPageImages.stackPages(pages);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].top, PdfPageImages.PAGE_GAP + 7);
});

test('契约：PdfScripts 的全局变量名与 viewer.html 里定义的一致', () => {
  const html = viewerHtml();
  // viewer.html 里必须真的定义这些入口/变量，否则 runJavaScript 会静默返回 null
  for (const name of ['__runExtract', '__ocrOpen', '__ocrRender', '__pageImg', '__ocrState',
    '__ocrPages', '__ocrErr']) {
    assert.ok(html.includes(`window.${name}`), `viewer.html 里缺 window.${name}`);
  }
  const globalOf = (script: string): string => {
    return script.replace(/^.*?window\./, '').replace(/;.*$/, '');
  };
  assert.equal(globalOf(PdfScripts.PAGE_IMG_SCRIPT), '__pageImg');
  assert.equal(globalOf(PdfScripts.OCR_STATE_SCRIPT), '__ocrState');
  assert.equal(globalOf(PdfScripts.OCR_PAGES_SCRIPT), '__ocrPages');
  assert.equal(globalOf(PdfScripts.OCR_ERROR_SCRIPT), '__ocrErr');
  assert.equal(globalOf(PdfScripts.RESULT_SCRIPT), '__pdfResult');
  assert.equal(globalOf(PdfScripts.ERROR_SCRIPT), '__pdfError');
  // 就绪判据必须是入口函数，不是 pdfjsLib（pdf.min.js 执行完入口函数还没定义）
  assert.ok(PdfScripts.READY_SCRIPT.includes('__runExtract'));
  assert.ok(!PdfScripts.READY_SCRIPT.includes('pdfjsLib'));
  // 渲染入口的实参顺序：页号、目标宽度
  assert.equal(PdfScripts.ocrRenderCall(2, 1400), '__ocrRender(2, 1400)');
  assert.ok(PdfScripts.ocrOpenCall('AAA').startsWith('__ocrOpen("AAA"'));
});
