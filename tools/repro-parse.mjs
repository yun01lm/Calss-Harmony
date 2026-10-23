/**
 * 在本地把"设备上跑的导入解析"完整重放一遍（**只用于本地调试**，不进 HAP）。
 *
 * 为什么值得写：真实课表的版式差异是无穷的，而"改一行解析 → 装到设备 → 点开导入 →
 * 等 15 秒 → 看预览"这条回路太慢，而且只看得到前 6 门课。这个脚本把
 * `tools/pdf-text-dump.mjs --runs` 的输出喂给**和设备同一套** `PdfRunText` +
 * `GridFormatParser` / `ListFormatParser`，一次打印全部课程。
 *
 * 用法：
 *   node tools/repro-parse.mjs "C:\\path\\to\\课表.pdf"
 *
 * 注意：输出含真实课表内容，**不要提交**（/tools/fixtures/ 已在 .gitignore）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PdfRunText } from '../entry/src/main/ets/logic/PdfRunText.ts';
import { GridFormatParser } from '../entry/src/main/ets/logic/GridFormatParser.ts';
import { ListFormatParser } from '../entry/src/main/ets/logic/ListFormatParser.ts';
import { WeekMasks } from '../entry/src/main/ets/logic/WeekMasks.ts';

const here = dirname(fileURLToPath(import.meta.url));
const input = process.argv[2];
if (input === undefined) {
  console.error('用法: node tools/repro-parse.mjs <pdf | payload.txt>');
  process.exit(1);
}

// `.txt` = 设备上 dump 出来的 pdf.js 回传原文（`filesDir/pdf-runs.txt`），保真度最高
const payload = input.endsWith('.txt')
  ? readFileSync(input, 'utf8')
  : execFileSync(process.execPath, [join(here, 'pdf-text-dump.mjs'), input, '--runs'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

const result = PdfRunText.parse(payload);
if (!result.ok) {
  console.error('回传解析失败：' + result.error);
  process.exit(1);
}
console.log(`runs=${result.runs.length} pages=${result.pageCount} malformed=${result.malformed}`);

for (const [label, parser] of [['GridFormatParser', GridFormatParser], ['ListFormatParser', ListFormatParser]]) {
  const parsed = parser.parse(result.runs);
  console.log(`\n=== ${label}: ${parsed.courses.length} 门，warnings=${parsed.warnings.length} ===`);
  for (const w of parsed.warnings) {
    console.log('  ! ' + w);
  }
  parsed.courses.forEach((c, i) => {
    const s = c.schedules[0];
    const sched = s === undefined
      ? '（无时段）'
      : `周${s.dayOfWeek} ${s.startPeriod}-${s.endPeriod} 节 · ${WeekMasks.format(s.weekMask)}`;
    console.log(
      `  ${String(i + 1).padStart(2)}. ${JSON.stringify(c.name)} | 教师=${JSON.stringify(c.teacher)}` +
        ` | 地点=${JSON.stringify(c.location)} | ${sched}`
    );
  });
}
