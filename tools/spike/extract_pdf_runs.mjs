/**
 * 从真实 PDF 抽取"带坐标的文本片段"，用于在**本机**验证 pdf.js → 解析器整条链。
 *
 * 为什么要有这个脚本：设备上跑一遍要 build + install + 点按钮，而且真实课表里有姓名，
 * 不适合塞进 App 的 rawfile。这里在 Node 里跑同样的 pdf.js 逻辑（同一份 UMD 构建，
 * 与 `rawfile/pdfjs/viewer.html` 用的是同一个文件），输出制表符文本，交给 `analyze_runs.mjs`
 * 用**仓库里真实的解析器**去解析。
 *
 * 用法（输出请放到仓库外，避免把真实姓名带进 git）：
 *   node tools/spike/extract_pdf_runs.mjs <input.pdf> <output.tsv>
 *
 * 注意：本项目没有 npm 依赖；脚本直接 require 仓库里的 `pdf.min.js`（pdf.js 3.11 legacy UMD）。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(here, '../../entry/src/main/resources/rawfile/pdfjs');
const PDFJS = path.join(buildDir, 'pdf.min.js');
const PDFJS_WORKER = path.join(buildDir, 'pdf.worker.min.js');

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) {
  console.error('用法: node tools/spike/extract_pdf_runs.mjs <input.pdf> <output.tsv>');
  process.exit(2);
}

// pdf.js 的 UMD 构建在 Node 里需要这两个全局占位（只做文本抽取，不渲染画布）
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}
const mod = require(PDFJS);
// UMD 构建在 Node 里会把接口挂到 window/globalThis 上，module.exports 可能是空的 —— 两边都试
const pdfjsLib = (mod && typeof mod.getDocument === 'function')
  ? mod
  : (globalThis.pdfjsLib || globalThis.window.pdfjsLib);
if (!pdfjsLib || typeof pdfjsLib.getDocument !== 'function') {
  console.error('拿不到 pdf.js 接口');
  process.exit(3);
}
// Node 里没有真实 Worker：指定 workerSrc 让 pdf.js 用 fake worker 跑（只做文本抽取，够用）
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;

const data = new Uint8Array(fs.readFileSync(input));
const loadingTask = pdfjsLib.getDocument({
  data: data,
  disableWorker: true,
  isEvalSupported: false,
  useSystemFonts: false,
});

const doc = await loadingTask.promise;
const lines = ['OK'];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  for (const item of content.items) {
    if (typeof item.str !== 'string' || item.str.length === 0) {
      continue;
    }
    // 与 viewer.html 完全相同的坐标换算：左上原点、y 向下
    const m = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const x = m[4];
    const y = m[5];
    const fontSize = Math.hypot(m[2], m[3]);
    const endX = x + (item.width || 0);
    lines.push(
      [p, x.toFixed(2), y.toFixed(2), endX.toFixed(2), fontSize.toFixed(2), item.str.replace(/[\t\r\n]/g, ' ')].join('\t')
    );
  }
  page.cleanup();
}
lines.push('END');
fs.writeFileSync(output, lines.join('\n'), 'utf8');
console.log(`pages=${doc.numPages} runs=${lines.length - 2} -> ${output}`);
await doc.destroy();


