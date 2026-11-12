/**
 * 生成 `entry/src/main/resources/rawfile/pdfjs/cmaps-data.js`：把 pdf.js 的 **GB 系列 CMap**
 * 以 base64 内联给 ArkWeb 用。
 *
 * 为什么要内联：ArkWeb 里 `resource://rawfile` 上不能发 XHR/fetch（CORS 只允许
 * arkweb/http/https/data），pdf.js 于是报 "Unable to load binary CMap" 并把整页文字丢掉。
 *
 * 为什么要**全量** GB 系列（而不是早先那 5 个）：
 * 中文 PDF 常见的编码不止 `UniGB-UCS2-H`。真实样本里就出现过 `GBKp-EUC-H`（方正/老教务系统
 * 导出）、`GBK2K-H`、`GBT-EUC-H` 等；这些名字不在内联表里时，pdf.js 加载 CMap 失败 →
 * `getTextContent()` 返回**零个可读片段**，界面上就是「这份 PDF 里没有可读文字」——
 * 上架审核报的正是这句话（反馈原文：PDF 文件有内容，提示解析失败，没有可读文本）。
 * 全量 GB 系列压缩后 raw 约 285KB / base64 约 380KB，换来的是"真实中文 PDF 都能取到字"。
 *
 * 数据来源：`pdfjs-dist@3.11.174` 的 `cmaps/*.bcmap`（与包内 `pdf.min.js` 同版本）。
 * 用法：
 *   npm i pdfjs-dist@3.11.174 --no-save
 *   node tools/make-cmaps-data.mjs [cmaps 目录]
 * 不传目录时依次尝试 node_modules/pdfjs-dist/cmaps。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'entry/src/main/resources/rawfile/pdfjs/cmaps-data.js');

const candidates = [
  process.argv[2],
  join(ROOT, 'node_modules/pdfjs-dist/cmaps'),
].filter((p) => p !== undefined);

const dir = candidates.find((p) => existsSync(p));
if (dir === undefined) {
  console.error('找不到 cmaps 目录；先 `npm i pdfjs-dist@3.11.174 --no-save`，或作为参数传入路径');
  process.exit(1);
}

// 只要 GB 系列（含 Adobe-GB1 的 CID 映射）。排除 *-V 之外的其它语系。
const NAME = /^(GB-|GBK|GBKp|GBpc|GBT|GBTpc|GBT2|UniGB-|Adobe-GB1)/;
const files = readdirSync(dir).filter((f) => f.endsWith('.bcmap') && NAME.test(f)).sort();

const entries = [];
let rawBytes = 0;
for (const f of files) {
  const buf = readFileSync(join(dir, f));
  rawBytes += buf.length;
  entries.push(`  '${f.replace(/\.bcmap$/, '')}': '${buf.toString('base64')}'`);
}

const js = `/* 自动生成：把 pdf.js 的 GB 系列 CMap 以 base64 内联
 * 为什么内联：ArkWeb 里 resource://rawfile 上不能发 XHR/fetch（CORS 只允许 arkweb/http/https/data），
 * pdf.js 于是报 "Unable to load binary CMap" 并把整页文字丢掉。
 * 为什么是全量 GB 系列：真实中文 PDF 的 /Encoding 不止 UniGB-UCS2-H（见 tools/make-cmaps-data.mjs）。
 * 生成命令：node tools/make-cmaps-data.mjs（数据源 pdfjs-dist@3.11.174 的 cmaps/*.bcmap）
 * 共 ${files.length} 个 CMap，raw ${rawBytes} 字节。
 */
window.__CMAPS = {
${entries.join(',\n')}
};
`;

writeFileSync(OUT, js, 'utf8');
console.log(`wrote ${OUT}`);
console.log(`cmaps=${files.length} rawBytes=${rawBytes} fileBytes=${Buffer.byteLength(js)}`);
