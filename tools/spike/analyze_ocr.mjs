/**
 * 把 `ocr_image.ps1` 产出的「文本 + 包围盒」喂给**仓库里真实的**作息解析器，
 * 看它对真实截图（真实 OCR 误差）的识别率。
 *
 * 用法：
 *   node tools/spike/analyze_ocr.mjs %TEMP%\calss-ocr.tsv
 */
import fs from 'node:fs';

import { OcrLine, TimetableTextParser } from '../../entry/src/main/ets/logic/TimetableTextParser.ts';
import { Minutes } from '../../entry/src/main/ets/logic/Minutes.ts';

const input = process.argv[2];
if (!input) {
  console.error('用法: node tools/spike/analyze_ocr.mjs <ocr.tsv>');
  process.exit(2);
}

const text = fs.readFileSync(input, 'utf8');
const rows = text.split(/\r?\n/);
if (rows[0] !== 'OK') {
  console.error('不是预期的 OCR 输出格式（首行应为 OK）');
  process.exit(2);
}

const lines = [];
for (let i = 1; i < rows.length; i++) {
  const row = rows[i];
  if (row === 'END' || row.length === 0) {
    continue;
  }
  const parts = row.split('\t');
  if (parts.length < 5) {
    continue;
  }
  lines.push(new OcrLine(parts[0], Number(parts[1]), Number(parts[2]), Number(parts[3]), Number(parts[4])));
}

const parsed = TimetableTextParser.parse(lines);
console.log(`OCR 行数: ${lines.length}`);
console.log(`认出节次: ${parsed.periods.length}`);
for (const p of parsed.periods) {
  const flag = p.inferred ? '（补号）' : '';
  console.log(
    `  第 ${String(p.periodIndex).padStart(2)} 节  ${Minutes.format(p.startMinute)}-${Minutes.format(p.endMinute)}  ${p.group}${flag}`
  );
}
console.log(`警告 ${parsed.warnings.length} 条:`);
for (const w of parsed.warnings) {
  console.log('  - ' + w);
}

