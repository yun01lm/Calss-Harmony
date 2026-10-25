/**
 * 作息表格编辑 / 导入校对页的断言（`logic/SlotDraft.ts` + `PdfRunText.toLines`）。
 *
 * 这两段都直接决定"写进 `time_slots` 的东西对不对"：
 * - `SlotDraft.check` 是手动改与校对页改的**唯一关口**；
 * - `toLines` 是 PDF 通道的**唯一转换点**（碎片 → 行），错了整条通道就废。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SlotDraft } from '../entry/src/main/ets/logic/SlotDraft.ts';
import type { SlotCheckResult, SlotRow } from '../entry/src/main/ets/logic/SlotDraft.ts';
import { PdfRunText } from '../entry/src/main/ets/logic/PdfRunText.ts';
import { ExifOrientation } from '../entry/src/main/ets/logic/ExifOrientation.ts';
import type { PdfTextRun } from '../entry/src/main/ets/logic/PdfModels.ts';

function check(period: string, start: string, end: string, label = '上午'): SlotCheckResult {
  return SlotDraft.check(SlotDraft.form(period, label, start, end));
}

// ---------------------------------------------------------------- 校验：正常

test('正常一行：三个字段都规范化后带出', () => {
  const r: SlotCheckResult = check('3', '9:55', '10:40');
  assert.equal(r.error, '');
  assert.equal(r.badField, SlotDraft.BAD_NONE);
  assert.equal(r.row.periodIndex, 3);
  assert.equal(r.row.label, '上午');
  assert.equal(r.row.startMinute, 9 * 60 + 55);
  assert.equal(r.row.endMinute, 10 * 60 + 40);
  assert.equal(r.row.inferred, false);
});

// ---------------------------------------------------------------- 校验：自动纠正

test('"8:5" / "800" / 全角 都被纠正，并回填规范文本', () => {
  const a: SlotCheckResult = check('3', '8:5', '8:45');
  assert.equal(a.error, '');
  assert.equal(a.form.startText, '8:05');
  assert.equal(a.row.startMinute, 8 * 60 + 5);

  const b: SlotCheckResult = check('3', '800', '845');
  assert.equal(b.error, '');
  assert.equal(b.form.startText, '8:00');
  assert.equal(b.form.endText, '8:45');

  const c: SlotCheckResult = check('３', '８：００', '８：４５');
  assert.equal(c.error, '');
  assert.equal(c.row.periodIndex, 3);
  assert.equal(c.row.startMinute, 480);
});

test('标签两端空白被去掉', () => {
  const r: SlotCheckResult = check('1', '8:00', '8:45', '  上午 ');
  assert.equal(r.row.label, '上午');
});

// ---------------------------------------------------------------- 校验：报错

test('节次号非法 → 标红节次框，且不被时间错误抢在前面', () => {
  const bad: SlotCheckResult = check('0', '乱写', '乱写');
  assert.equal(bad.badField, SlotDraft.BAD_PERIOD);
  assert.ok(bad.error.includes('1 到 ' + SlotDraft.MAX_PERIOD));

  const odd: SlotCheckResult = check('abc', '8:00', '8:45');
  assert.equal(odd.badField, SlotDraft.BAD_PERIOD);
});

test('节次号超过 30 被拒绝（否则周视图会被撑成上千行）', () => {
  const r: SlotCheckResult = check('31', '8:00', '8:45');
  assert.equal(r.badField, SlotDraft.BAD_PERIOD);
  assert.equal(SlotDraft.check(SlotDraft.form('30', '', '8:00', '8:45')).error, '');
});

test('开始时间认不出 → 标红开始框', () => {
  const r: SlotCheckResult = check('1', '早八', '8:45');
  assert.equal(r.badField, SlotDraft.BAD_START);
});

test('结束时间认不出 → 标红结束框', () => {
  const r: SlotCheckResult = check('1', '8:00', '25:00');
  assert.equal(r.badField, SlotDraft.BAD_END);
});

test('结束不晚于开始 → 报"结束时间要晚于开始时间"，标红结束框', () => {
  const same: SlotCheckResult = check('1', '8:00', '8:00');
  assert.equal(same.badField, SlotDraft.BAD_END);
  assert.equal(same.error, '结束时间要晚于开始时间');

  const reversed: SlotCheckResult = check('1', '10:00', '9:00');
  assert.equal(reversed.badField, SlotDraft.BAD_END);
});

test('报错时也回填规范化文本（用户能看见 8:5 变成了 8:05）', () => {
  const r: SlotCheckResult = check('1', '8:5', '8:00');
  assert.ok(r.error.length > 0);
  assert.equal(r.form.startText, '8:05');
});

// ---------------------------------------------------------------- 加一节 / 分组

test('加一节：接在最后一节之后，时长沿用上一节，节次号顺延', () => {
  const rows: SlotRow[] = [
    SlotDraft.row(1, '上午', 8 * 60, 8 * 60 + 40),
    SlotDraft.row(2, '上午', 8 * 60 + 50, 9 * 60 + 30),
  ];
  const next: SlotRow = SlotDraft.nextRow(rows);
  assert.equal(next.periodIndex, 3);
  assert.equal(next.startMinute, 9 * 60 + 30);
  assert.equal(next.endMinute, 9 * 60 + 30 + 40); // 沿用 40 分
  assert.equal(next.label, '上午');
  assert.equal(next.inferred, false);
});

test('加一节：空作息给出 8:00-8:45 的第 1 节', () => {
  const first: SlotRow = SlotDraft.nextRow([]);
  assert.equal(first.periodIndex, 1);
  assert.equal(first.startMinute, 480);
  assert.equal(first.endMinute, 525);
});

test('加一节：上一节到 23:50 之后不再往后堆（回到 8:00）', () => {
  const rows: SlotRow[] = [SlotDraft.row(9, '晚上', 23 * 60 + 5, 23 * 60 + 50)];
  const next: SlotRow = SlotDraft.nextRow(rows);
  assert.equal(next.periodIndex, 10);
  assert.equal(next.startMinute, 480);
});

test('加一节：节次号不超过上限', () => {
  const rows: SlotRow[] = [SlotDraft.row(SlotDraft.MAX_PERIOD, '晚上', 20 * 60, 20 * 60 + 45)];
  assert.equal(SlotDraft.nextRow(rows).periodIndex, SlotDraft.MAX_PERIOD);
});

test('分组：1-4 上午、5-8 下午、9+ 晚上', () => {
  assert.equal(SlotDraft.groupOf(1), '上午');
  assert.equal(SlotDraft.groupOf(4), '上午');
  assert.equal(SlotDraft.groupOf(5), '下午');
  assert.equal(SlotDraft.groupOf(8), '下午');
  assert.equal(SlotDraft.groupOf(9), '晚上');
  assert.equal(SlotDraft.groupOf(13), '晚上');
});

// ---------------------------------------------------------------- 缺号 / 写库前整理

test('gapsOf：找出 1..最大节次之间缺的号', () => {
  const rows: SlotRow[] = [
    SlotDraft.row(1, '上午', 480, 520),
    SlotDraft.row(3, '上午', 600, 640),
  ];
  assert.deepEqual(SlotDraft.gapsOf(rows), [2]);
  assert.deepEqual(SlotDraft.gapsOf([]), []);

  const full: SlotRow[] = [
    SlotDraft.row(1, '上午', 480, 520),
    SlotDraft.row(2, '上午', 530, 570),
  ];
  assert.deepEqual(SlotDraft.gapsOf(full), []);
});

test('sortedUnique：按节次排序且同一节次只留第一条（校对页可能改成重号）', () => {
  const rows: SlotRow[] = [
    SlotDraft.row(3, '上午', 600, 640),
    SlotDraft.row(1, '上午', 480, 520),
    SlotDraft.row(3, '上午', 700, 740), // 重号：应被丢掉
  ];
  const out: SlotRow[] = SlotDraft.sortedUnique(rows);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r: SlotRow) => r.periodIndex), [1, 3]);
  // 留下的是排序后先出现的那条（原数组里 position 0 的 600-640）
  assert.equal(out[1].startMinute, 600);
});

test('missingHint：现有节数比认出来的多时才提示，且说得具体', () => {
  assert.equal(SlotDraft.missingHint(12, 12), '');
  assert.equal(SlotDraft.missingHint(10, 12), '');
  const hint: string = SlotDraft.missingHint(12, 9);
  assert.ok(hint.includes('12'));
  assert.ok(hint.includes('9'));
  assert.ok(hint.includes('补一节'));
});

test('describe：缺标签时用分组兜底', () => {
  assert.equal(SlotDraft.describe(SlotDraft.row(1, '上午', 480, 525)), '第 1 节 · 上午　8:00 - 8:45');
  assert.equal(SlotDraft.describe(SlotDraft.row(5, '', 840, 885)), '第 5 节 · 下午　14:00 - 14:45');
});

// ---------------------------------------------------------------- PDF 碎片 → 行

function run(page: number, x: number, y: number, text: string, fontSize = 9): PdfTextRun {
  return { text: text, x: x, y: y, endX: x + text.length * fontSize * 0.5, fontSize: fontSize, page: page };
}

test('toLines：同一视觉行的碎片按 x 拼回一行（不能拼成 18:00-8:45）', () => {
  const runs: PdfTextRun[] = [
    run(1, 110, 101, '8:45'),
    run(1, 40, 100, '8:00'),
    run(1, 10, 99, '1'),
    run(1, 90, 102, '-'),
    run(1, 10, 140, '2'),
    run(1, 40, 141, '8:50'),
    run(1, 90, 142, '-'),
    run(1, 110, 143, '9:35'),
  ];
  const lines: string[] = PdfRunText.toLines(runs);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '1 8:00 - 8:45');
  assert.equal(lines[1], '2 8:50 - 9:35');
});

test('toLines：y 相差超过半个字高就算两行', () => {
  const runs: PdfTextRun[] = [run(1, 10, 100, '上午'), run(1, 10, 120, '下午')];
  assert.deepEqual(PdfRunText.toLines(runs), ['上午', '下午']);
});

test('toLines：多页按页码顺序，页内仍自上而下', () => {
  const runs: PdfTextRun[] = [
    run(2, 10, 50, '第 3 节'),
    run(1, 10, 200, '第 2 节'),
    run(1, 10, 100, '第 1 节'),
  ];
  assert.deepEqual(PdfRunText.toLines(runs), ['第 1 节', '第 2 节', '第 3 节']);
});

test('toLines：空白片段被丢掉，不会在行里留下多余空格', () => {
  const runs: PdfTextRun[] = [run(1, 10, 100, '  1'), run(1, 30, 100, ' '), run(1, 50, 100, '8:00')];
  assert.deepEqual(PdfRunText.toLines(runs), ['1 8:00']);
  assert.deepEqual(PdfRunText.toLines([]), []);
});

// ---------------------------------------------------------------- EXIF 方向

test('EXIF 方向：只有不镜像的 3 种需要旋转，其余不动', () => {
  assert.equal(ExifOrientation.degreesOf('Right-top'), 90);   // 竖拍
  assert.equal(ExifOrientation.degreesOf('Bottom-right'), 180); // 倒着
  assert.equal(ExifOrientation.degreesOf('Left-bottom'), 270);
  assert.equal(ExifOrientation.degreesOf('Top-left'), 0);      // 正常
  assert.equal(ExifOrientation.degreesOf('Top-right'), 0);     // 镜像：不转（宁可少转也别转错）
  assert.equal(ExifOrientation.degreesOf(''), 0);              // PNG 读不到 EXIF
  assert.equal(ExifOrientation.degreesOf('  未知 '), 0);
});

test('EXIF 方向的大小写与空格不影响判定', () => {
  assert.equal(ExifOrientation.degreesOf(' right-top '), 90);
  assert.equal(ExifOrientation.degreesOf('RIGHT-TOP'), 90);
});

test('describe：把方向翻成人能读的提示', () => {
  assert.equal(ExifOrientation.describe('Right-top'), 'Right-top→转 90°');
  assert.equal(ExifOrientation.describe('Top-left'), 'Top-left');
  assert.equal(ExifOrientation.describe(''), '未知');
});