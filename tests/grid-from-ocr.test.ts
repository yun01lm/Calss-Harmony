/**
 * 课表截图 → 课程（`logic/GridFromOcr.ts`）。
 *
 * 输入是 OCR 的**行 + 包围盒**，所以这里用合成坐标造"一张截图"：
 * 7 列（每列 120px 宽）、左侧节次列、每格两行文字（课名 + 教室）。
 * 这样能精确断言"哪一格落成了哪门课、跨几节"，而不依赖某台设备的 OCR 结果。
 *
 * 真机上的验证另有一套（开发者入口里的「用内置课表截图跑…」，见 docs/PLAN.md P4）：
 * 那份会用真实 OCR 输出跑同一条链路，夹具含姓名所以不入库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GridFromOcr } from '../entry/src/main/ets/logic/GridFromOcr.ts';
import { OcrLine } from '../entry/src/main/ets/logic/TimetableTextParser.ts';
import type { ParseResult } from '../entry/src/main/ets/logic/PdfModels.ts';

const TOTAL_WEEKS = 20;

/** 一列宽 120，第一列中心 200（节次列在 x≈60） */
function dayX(day: number): number {
  return 200 + (day - 1) * 120;
}

/** 造一行文字：以 (x, y) 为中心，宽 width、高 16 */
function line(text: string, x: number, y: number, width = 60): OcrLine {
  return new OcrLine(text, x - width / 2, y - 8, x + width / 2, y + 8);
}

/** 表头：星期一…星期日（y=100），节次列 1..4（x=60，y=200/300/400/500） */
function base(): OcrLine[] {
  const out: OcrLine[] = [];
  const names: string[] = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
  for (let d = 1; d <= 7; d++) {
    out.push(line(names[d - 1], dayX(d), 100, 70));
  }
  for (let p = 1; p <= 4; p++) {
    out.push(line(String(p), 60, 160 + (p - 1) * 100, 20));
  }
  return out;
}

test('7 列表头 + 节次列：一格两行（课名 + 教室）→ 一门课，星期与节次都对', () => {
  const lines: OcrLine[] = base();
  // 单节格子：文字落在第 1 节那一带的正中间（行 1 的带是 y≈110..210）
  lines.push(line('高等数学', dayX(2), 150, 100));
  lines.push(line('思源楼-301', dayX(2), 168, 110));

  const r: ParseResult = GridFromOcr.parse(lines, TOTAL_WEEKS);
  assert.equal(r.warnings.length, 1, '截图没有周次 → 必须提示按整学期导入');
  assert.equal(r.courses.length, 1);
  const c = r.courses[0];
  assert.equal(c.name, '高等数学');
  assert.equal(c.location, '思源楼-301');
  assert.equal(c.schedules[0].dayOfWeek, 2);
  assert.equal(c.schedules[0].startPeriod, 1);
  assert.equal(c.schedules[0].endPeriod, 1);
  assert.equal(Number(c.schedules[0].weekMask), (1 << TOTAL_WEEKS) - 1, '整学期掩码');
});

test('跨两节的格子（一门课占 1-2 节）→ startPeriod/endPeriod 覆盖两行', () => {
  const lines: OcrLine[] = base();
  // 真实截图里"占两节"的格子，文字压在两行中间：行界在 210，这里两行落在 200/218
  lines.push(line('大学物理', dayX(4), 200, 100));
  lines.push(line('实验楼-A204', dayX(4), 218, 110));

  const r: ParseResult = GridFromOcr.parse(lines, TOTAL_WEEKS);
  assert.equal(r.courses.length, 1);
  assert.equal(r.courses[0].schedules[0].startPeriod, 1);
  assert.equal(r.courses[0].schedules[0].endPeriod, 2);
});

test('格子里写了周次 → 用格子的，且不再提示"没有周次"', () => {
  const lines: OcrLine[] = base();
  lines.push(line('线性代数', dayX(3), 200, 100));
  lines.push(line('1-8周', dayX(3), 218, 60));

  const r: ParseResult = GridFromOcr.parse(lines, TOTAL_WEEKS);
  assert.equal(r.courses.length, 1);
  assert.equal(Number(r.courses[0].schedules[0].weekMask), 255, '1-8 周');
  assert.deepEqual(r.warnings, []);
});

test('没有节次列时退化按行编号，并明确警告（编号是我们编的）', () => {
  const lines: OcrLine[] = [];
  const names: string[] = ['星期一', '星期二', '星期三', '星期四', '星期五'];
  for (let d = 1; d <= 5; d++) {
    lines.push(line(names[d - 1], dayX(d), 100, 70));
  }
  lines.push(line('离散数学', dayX(1), 200, 100));
  lines.push(line('体育', dayX(2), 320, 100));

  const r: ParseResult = GridFromOcr.parse(lines, TOTAL_WEEKS);
  assert.equal(r.courses.length, 2);
  assert.ok(
    r.warnings.some((w) => w.indexOf('没认出节次列') >= 0),
    JSON.stringify(r.warnings)
  );
  assert.ok(r.courses.some((c) => c.schedules[0].startPeriod >= 1));
});

test('表头只有 5 天：只导入这 5 天，并警告"其余天不会导入"', () => {
  const lines: OcrLine[] = [];
  const names: string[] = ['星期一', '星期二', '星期三', '星期四', '星期五'];
  for (let d = 1; d <= 5; d++) {
    lines.push(line(names[d - 1], dayX(d), 100, 70));
  }
  lines.push(line('1', 60, 200, 20));
  lines.push(line('2', 60, 300, 20));
  lines.push(line('3', 60, 400, 20));
  lines.push(line('数据结构', dayX(5), 200, 100));

  const r: ParseResult = GridFromOcr.parse(lines, TOTAL_WEEKS);
  assert.equal(r.courses.length, 1);
  assert.equal(r.courses[0].schedules[0].dayOfWeek, 5);
  assert.ok(r.warnings.some((w) => w.indexOf('只认出 5 天的表头') >= 0), JSON.stringify(r.warnings));
});

test('认不出表头 → 明确报原因（不返回一堆乱七八糟的课）', () => {
  const lines: OcrLine[] = [line('随便一段文字', 200, 100, 120), line('另一段', 200, 130, 100)];
  const r: ParseResult = GridFromOcr.parse(lines, TOTAL_WEEKS);
  assert.equal(r.courses.length, 0);
  assert.ok(r.warnings[0].indexOf('没认出星期表头') >= 0, r.warnings[0]);
});

test('空图不炸', () => {
  const r: ParseResult = GridFromOcr.parse([], TOTAL_WEEKS);
  assert.equal(r.courses.length, 0);
  assert.equal(r.warnings.length, 1);
});

test('截图里若带结构化详情（PDF 打印稿）→ 教室/教师/周次按详情解析', () => {
  const lines: OcrLine[] = base();
  lines.push(line('概率论与数理统计', dayX(6), 160, 160));
  lines.push(line('(3-4节)1-12周/思源楼-230/史梦蝶', dayX(6), 178, 200));

  const r: ParseResult = GridFromOcr.parse(lines, TOTAL_WEEKS);
  assert.equal(r.courses.length, 1);
  const c = r.courses[0];
  assert.equal(c.location, '思源楼-230');
  assert.equal(c.teacher, '史梦蝶');
  assert.equal(c.schedules[0].startPeriod, 3);
  assert.equal(c.schedules[0].endPeriod, 4);
  assert.equal(Number(c.schedules[0].weekMask), 4095, '1-12 周');
});

test('fullSemester：总周数不合法时退回 20 周（不是空掩码）', () => {
  assert.equal(Number(GridFromOcr.fullSemester(0)), (1 << 20) - 1);
  assert.equal(Number(GridFromOcr.fullSemester(18)), (1 << 18) - 1);
});

// ---------------------------------------------------------------- 回归：真机/样张上踩到的两条

test('门牌号不会被当周次（"实验室503-504" 不是 3-50 周）', () => {
  const lines: OcrLine[] = base();
  lines.push(line('软件工程', dayX(1), 150, 100));
  lines.push(line('实验室503-504', dayX(1), 168, 130));

  const r: ParseResult = GridFromOcr.parse(lines, TOTAL_WEEKS);
  assert.equal(r.courses.length, 1);
  assert.equal(r.courses[0].location, '实验室503-504');
  assert.equal(
    Number(r.courses[0].schedules[0].weekMask),
    (1 << TOTAL_WEEKS) - 1,
    '没有"周"字的数字区间不能当周次，应回落到整学期'
  );
  assert.ok(r.warnings.some((w) => w.indexOf('没有周次') >= 0), '并且要提示按整学期导入');
});

test('表头以上的标题不会被当成一门课', () => {
  const lines: OcrLine[] = [];
  const names: string[] = ['星期一', '星期二', '星期三', '星期四', '星期五'];
  for (let d = 1; d <= 5; d++) {
    lines.push(line(names[d - 1], dayX(d), 100, 70));
  }
  // 表头上方：学期标题
  lines.push(line('2026 春季学期课表', dayX(3), 60, 200));
  for (let p = 1; p <= 3; p++) {
    lines.push(line(String(p), 60, 160 + (p - 1) * 100, 20));
  }
  lines.push(line('操作系统', dayX(3), 150, 100));

  const r: ParseResult = GridFromOcr.parse(lines, TOTAL_WEEKS);
  assert.equal(r.courses.length, 1, '只应有真正的课程');
  assert.equal(r.courses[0].name, '操作系统');
});

test('教室里排在课名上面时，不会把门牌号当课名', () => {
  const lines: OcrLine[] = base();
  // 先教室、后课名（真实截图里很常见）
  lines.push(line('1-101', dayX(5), 150, 60));
  lines.push(line('高等数学', dayX(5), 168, 100));

  const r: ParseResult = GridFromOcr.parse(lines, TOTAL_WEEKS);
  assert.equal(r.courses.length, 1);
  assert.equal(r.courses[0].name, '高等数学');
  assert.equal(r.courses[0].location, '1-101');
});