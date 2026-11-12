/**
 * 把桌面 OCR（tools/ocr-with-windows.ps1）输出的 TSV 喂给生产解析器，看真实排版能不能解析出来。
 *
 * 为什么要有它：鸿蒙模拟器没有 OCR 后端，应用内的「渲染 → 识别」这段只能在真机跑；
 * 这个脚本用同一张"设备渲染并裁剪后的图" + 桌面 OCR，验证**识别结果之后**的解析器
 * 对真实排版（表格线、全角冒号、行内空格）是否还成立。
 */
import { readFileSync } from 'node:fs';
import { OcrLine, TimetableTextParser } from '../entry/src/main/ets/logic/TimetableTextParser.ts';

const path = process.argv[2];
if (path === undefined) {
  console.error('用法: node tools/repro-ocr-tsv.mts <ocr.tsv>');
  process.exit(1);
}

const lines: OcrLine[] = [];
for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
  if (raw.trim().length === 0) {
    continue;
  }
  const parts = raw.split('\t');
  if (parts.length < 5) {
    continue;
  }
  const [left, top, right, bottom] = parts.slice(0, 4).map((v: string) => Number.parseFloat(v));
  const text = parts.slice(4).join('\t');
  lines.push(new OcrLine(text, left, top, right, bottom));
}

const parsed = TimetableTextParser.parse(lines);
console.log(`输入 ${lines.length} 行 → 认出 ${parsed.periods.length} 节`);
for (const p of parsed.periods) {
  console.log(`  第 ${p.periodIndex} 节 · ${p.group} · ${p.startMinute}..${p.endMinute}${p.inferred ? '（推断）' : ''}`);
}
console.log('告警：' + (parsed.warnings.length === 0 ? '（无）' : ''));
for (const w of parsed.warnings) {
  console.log('  - ' + w);
}
