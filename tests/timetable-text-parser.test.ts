/**
 * TimetableTextParser 断言。
 *
 * 用例数据**逐格抄自真实截图**（`samples/作息时间表_全校作息时间调整方案.jpg`），
 * 与 Android 侧 `tools/verify_timetable_ocr.py` 的 7 组场景一一对应：
 * 12 节 + 9 行课间/大课间（6 课间 + 3 大课间）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OcrLine,
  TimetableTextParser,
  type RecognizedPeriod,
  type TimetableParseResult,
} from '../entry/src/main/ets/logic/TimetableTextParser.ts';

// ---------------------------------------------------------------- 真实样本
// [节次列文字, 时间段, 时长]
const SAMPLE_ROWS: Array<[string, string, string]> = [
  ['1', '8: 00-8: 45', '45分钟'],
  ['课间', '8: 45-8: 50', '5分钟'],
  ['2', '8: 50-9: 35', '45分钟'],
  ['大课间', '9: 35-10: 00', '25分钟'],
  ['3', '10: 00-10: 45', '45分钟'],
  ['课间', '10: 45-10: 50', '5分钟'],
  ['4', '10: 50-11: 35', '45分钟'],
  ['5', '13: 30-14: 15', '45分钟'],
  ['课间', '14: 15-14: 20', '5分钟'],
  ['6', '14: 20-15: 05', '45分钟'],
  ['大课间', '15: 05-15: 30', '25分钟'],
  ['7', '15: 30-16: 15', '45分钟'],
  ['课间', '16: 15-16: 20', '5分钟'],
  ['8', '16: 20-17: 05', '45分钟'],
  ['9', '18: 00-18: 45', '45分钟'],
  ['课间', '18: 45-18: 50', '5分钟'],
  ['10', '18: 50-19: 35', '45分钟'],
  ['大课间', '19: 35-20: 00', '25分钟'],
  ['11', '20: 00-20: 45', '45分钟'],
  ['课间', '20: 45-20: 50', '5分钟'],
  ['12', '20: 50-21: 35', '45分钟'],
];

/** 每节应当对应的分钟数（图上的真实时间） */
const EXPECTED: Map<number, [number, number]> = new Map<number, [number, number]>([
  [1, [480, 525]], [2, [530, 575]], [3, [600, 645]], [4, [650, 695]],
  [5, [810, 855]], [6, [860, 905]], [7, [930, 975]], [8, [980, 1025]],
  [9, [1080, 1125]], [10, [1130, 1175]], [11, [1200, 1245]], [12, [1250, 1295]],
]);

/** 休息时间（必须没有任何"节次"落在这里） */
const REST_TIMES: Array<[number, number]> = [
  [525, 530], [575, 600], [645, 650], [855, 860], [905, 930],
  [975, 980], [1125, 1130], [1175, 1200], [1245, 1250],
];

const X_GROUP = 30;
const X_PERIOD = 105;
const X_TIME = 180;
const X_DURATION = 290;
const ROW_H = 24;

type Mode = 'joined' | 'split';

function buildLines(mode: Mode, dropPeriodRows: number[] = [], dropTimeRows: number[] = []): OcrLine[] {
  const lines: OcrLine[] = [];
  // 标题与发布信息（真实截图里存在，不该干扰解析）
  lines.push(new OcrLine('全校作息时间调整方案', 100, 30, 300, 50));
  lines.push(new OcrLine('发布时间: 2026-09-02 17:23:25 浏览人数: 177', 60, 55, 340, 70));
  // 表头
  lines.push(new OcrLine('时间', X_GROUP, 78, X_GROUP + 40, 94));
  lines.push(new OcrLine('节次', X_PERIOD, 78, X_PERIOD + 40, 94));
  lines.push(new OcrLine('时间段', X_TIME, 78, X_TIME + 40, 94));
  lines.push(new OcrLine('时长', X_DURATION, 78, X_DURATION + 40, 94));
  // 合并单元格里的分组标签
  lines.push(new OcrLine('上午', X_GROUP, 150, X_GROUP + 30, 190));
  lines.push(new OcrLine('下午', X_GROUP, 380, X_GROUP + 30, 420));
  lines.push(new OcrLine('晚上', X_GROUP, 550, X_GROUP + 30, 590));

  SAMPLE_ROWS.forEach((row, i) => {
    const y = 110 + i * 26;
    const cells: Array<[string, number]> = [];
    if (dropPeriodRows.indexOf(i) < 0) {
      cells.push([row[0], X_PERIOD]);
    }
    if (dropTimeRows.indexOf(i) < 0) {
      cells.push([row[1], X_TIME]);
    }
    cells.push([row[2], X_DURATION]);

    if (mode === 'joined') {
      const texts: string[] = [];
      for (const c of cells) {
        texts.push(c[0]);
      }
      const firstX = cells[0][1];
      lines.push(new OcrLine(texts.join(' '), firstX, y - ROW_H / 2, X_DURATION + 60, y + ROW_H / 2));
    } else {
      for (const c of cells) {
        lines.push(new OcrLine(c[0], c[1], y - ROW_H / 2, c[1] + 60, y + ROW_H / 2));
      }
    }
  });
  return lines;
}

function periodMap(r: TimetableParseResult): Map<number, [number, number]> {
  const m = new Map<number, [number, number]>();
  for (const p of r.periods) {
    m.set(p.periodIndex, [p.startMinute, p.endMinute]);
  }
  return m;
}

function inferredList(r: TimetableParseResult): number[] {
  const out: number[] = [];
  for (const p of r.periods) {
    if (p.inferred) out.push(p.periodIndex);
  }
  return out.sort((a, b) => a - b);
}

function periodsOnRestTimes(r: TimetableParseResult): number[] {
  const out: number[] = [];
  for (const p of r.periods) {
    for (const rest of REST_TIMES) {
      if (p.startMinute === rest[0] && p.endMinute === rest[1]) {
        out.push(p.periodIndex);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- S1 / S2
test('S1 每行四格被 OCR 合成一行：12 节、时间全对、9 行课间被跳过', () => {
  const r = TimetableTextParser.parse(buildLines('joined'));
  assert.equal(r.periods.length, 12);
  assert.deepEqual(periodMap(r), EXPECTED);
  assert.deepEqual(inferredList(r), [], '不该有推断的序号');
  assert.deepEqual(r.missingPeriods, []);
  assert.deepEqual(periodsOnRestTimes(r), [], '没有任何节次落在休息时间上');
  assert.ok(r.warnings.some((w) => w.indexOf('9 行') >= 0), `应提示跳过 9 行休息：${r.warnings}`);
});

test('S2 每个单元格各自一行（表格被拆散）：结果与 S1 一致', () => {
  const r = TimetableTextParser.parse(buildLines('split'));
  assert.equal(r.periods.length, 12);
  assert.deepEqual(periodMap(r), EXPECTED);
  assert.deepEqual(r.missingPeriods, []);
  assert.deepEqual(periodsOnRestTimes(r), []);
});

// ---------------------------------------------------------------- S3 / S4
test('S3 首尾两行的节次号都没读出来：补回 1 与 12，标记 inferred，且不算"缺失"', () => {
  const r = TimetableTextParser.parse(buildLines('joined', [0, 20]));
  assert.equal(r.periods.length, 12, '修复前只有 10 节');
  assert.deepEqual(periodMap(r), EXPECTED);
  assert.deepEqual(inferredList(r), [1, 12]);
  assert.deepEqual(r.missingPeriods, [], '补上了就不是缺失');
  assert.ok(r.warnings.some((w) => w.indexOf('推断') >= 0), '必须提醒核对推断行');
});

test('S4 只有首行节次号没读出来：只补第 1 节', () => {
  const r = TimetableTextParser.parse(buildLines('joined', [0]));
  assert.equal(r.periods.length, 12);
  assert.deepEqual(inferredList(r), [1]);
  assert.deepEqual(periodMap(r).get(1), EXPECTED.get(1));
});

// ---------------------------------------------------------------- S5
test('S5 首尾两行连时间都没读出来：只剩 10 节，且点名缺失第 1 与第 12 节', () => {
  const r = TimetableTextParser.parse(buildLines('joined', [0, 20], [0, 20]));
  assert.equal(r.periods.length, 10);
  assert.deepEqual(r.missingPeriods, [1, 12], '第 1 节（中间段）+ 第 12 节（末行是课间推出来的）');
  assert.ok(r.warnings.some((w) => w.indexOf('没认出来') >= 0), '绝不能静默丢');
  assert.ok(r.warnings.some((w) => w.indexOf('最后一行是课间') >= 0), '要有末行截断提示');
});

// ---------------------------------------------------------------- S6 / S7
test('S6 第 1 节与课间被并成一行：第 1 节仍正确，课间不被当成节次', () => {
  const lines = buildLines('joined');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].text === '1 8: 00-8: 45 45分钟') {
      const y = lines[i].top;
      lines[i] = new OcrLine('1 8: 00-8: 45 45分钟 课间 8: 45-8: 50 5分钟', lines[i].left, y, X_DURATION + 60, lines[i].bottom);
    }
  }
  const r = TimetableTextParser.parse(lines);
  assert.deepEqual(periodMap(r).get(1), EXPECTED.get(1), '第 1 节仍被认出');
  assert.equal(r.periods.length, 12, '课间没被当成一节');
  assert.deepEqual(periodsOnRestTimes(r), [], '课间时间没被塞进任何节次');
});

test('S7 首行节次号丢失（合并行形态）：补回第 1 节，总数 12', () => {
  const r = TimetableTextParser.parse(buildLines('joined', [0]));
  assert.deepEqual(periodMap(r).get(1), EXPECTED.get(1));
  assert.equal(r.periods.length, 12);
});

// ---------------------------------------------------------------- 粘贴文本通道
test('粘贴文本：一行一条记录，节次号在时间之后也能认', () => {
  const text = [
    '上午 1 8: 00-8: 45 45分钟',
    '课间 8: 45-8: 50 5分钟',
    '上午 2 8: 50-9: 35 45分钟',
  ].join('\n');
  const r = TimetableTextParser.parse(TimetableTextParser.linesFromText(text));
  assert.equal(r.periods.length, 2);
  assert.deepEqual(periodMap(r).get(1), [480, 525]);
  assert.deepEqual(periodMap(r).get(2), [530, 575]);
});

test('linesFromText：行距 20 / 行高 12，一行就是一行（不会被错误合并）', () => {
  const lines = TimetableTextParser.linesFromText('a\nb\nc');
  assert.equal(lines.length, 3);
  assert.equal(lines[0].centerY, 6);
  assert.equal(lines[1].centerY, 26);
  assert.equal(lines[2].centerY, 46);
  assert.equal(lines[0].height, 12);
});

test('中文时间写法（8点45分-9点35分）也能认', () => {
  const r = TimetableTextParser.parse(TimetableTextParser.linesFromText('1 8点45分-9点35分'));
  assert.deepEqual(periodMap(r).get(1), [525, 575]);
});

test('中文写法省略"分"时按 0 分算（8点-9点 → 480-540，不是 NaN）', () => {
  const r = TimetableTextParser.parse(TimetableTextParser.linesFromText('1 8点-9点'));
  assert.deepEqual(periodMap(r).get(1), [480, 540]);
  const r2 = TimetableTextParser.parse(TimetableTextParser.linesFromText('1 8点-9点35分'));
  assert.deepEqual(periodMap(r2).get(1), [480, 575]);
  for (const p of r.periods) {
    assert.equal(Number.isNaN(p.startMinute), false, '认出来的时间不能是 NaN');
    assert.equal(Number.isNaN(p.endMinute), false, '认出来的时间不能是 NaN');
  }
});

// ---------------------------------------------------------------- 异常与边界
test('空输入：明确提示没有识别到文字', () => {
  const r = TimetableTextParser.parse([]);
  assert.equal(r.periods.length, 0);
  assert.ok(r.warnings.length > 0);
});

test('非法时间（开始晚于结束）被忽略并提示', () => {
  const r = TimetableTextParser.parse(TimetableTextParser.linesFromText('1 9: 00-8: 00'));
  assert.equal(r.periods.length, 0);
  assert.ok(r.warnings.some((w) => w.indexOf('不合法') >= 0), `期望时间不合法提示：${r.warnings}`);
});

test('重复时间只记一次，并提示重复', () => {
  const r = TimetableTextParser.parse(
    TimetableTextParser.linesFromText('1 8: 00-8: 45\n2 8: 00-8: 45')
  );
  assert.equal(r.periods.length, 1);
  assert.ok(r.warnings.some((w) => w.indexOf('重复') >= 0), `期望重复提示：${r.warnings}`);
});

test('缺节次：1、2、4 → 点名缺第 3 节', () => {
  const r = TimetableTextParser.parse(
    TimetableTextParser.linesFromText('1 8: 00-8: 45\n2 8: 50-9: 35\n4 10: 50-11: 35')
  );
  assert.deepEqual(r.missingPeriods, [3]);
});

test('时间乱序：第 2 节比第 1 节更早 → 提示核对', () => {
  const r = TimetableTextParser.parse(
    TimetableTextParser.linesFromText('1 9: 00-9: 45\n2 8: 00-8: 45')
  );
  assert.ok(r.warnings.some((w) => w.indexOf('顺序') >= 0), `期望顺序提示：${r.warnings}`);
});

test('节次太少时提示仔细核对（只认出 2 节）', () => {
  const r = TimetableTextParser.parse(
    TimetableTextParser.linesFromText('1 8: 00-8: 45\n2 8: 50-9: 35')
  );
  assert.ok(r.warnings.some((w) => w.indexOf('只认出') >= 0), `期望"只认出"提示：${r.warnings}`);
});

test('分组标签：上午/下午/晚上的 y 距离最近者生效', () => {
  const lines: OcrLine[] = [
    new OcrLine('上午', 30, 0, 60, 20),
    new OcrLine('1', 105, 0, 125, 20),
    new OcrLine('8: 00-8: 45', 180, 0, 280, 20),
    new OcrLine('下午', 30, 200, 60, 220),
    new OcrLine('5', 105, 200, 125, 220),
    new OcrLine('13: 30-14: 15', 180, 200, 280, 220),
  ];
  const r = TimetableTextParser.parse(lines);
  const byPeriod = new Map<number, RecognizedPeriod>();
  for (const p of r.periods) {
    byPeriod.set(p.periodIndex, p);
  }
  assert.equal(byPeriod.get(1)!.group, '上午');
  assert.equal(byPeriod.get(5)!.group, '下午');
});

test('rawLines：保留原文行，便于用户对照纠错', () => {
  const r = TimetableTextParser.parse(buildLines('joined'));
  assert.ok(r.rawLines.length > 20);
  assert.ok(r.rawLines.some((l) => l.indexOf('全校作息时间调整方案') >= 0));
});
