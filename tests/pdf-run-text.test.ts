/**
 * pdf.js 回传文本的解析断言（`logic/PdfRunText.ts`）。
 *
 * 这是 JS ↔ ArkTS 的**跨语言契约**，出错时的症状是"PDF 导入莫名其妙 0 门课"，
 * 所以每条格式规则都要有断言钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PdfRunText } from '../entry/src/main/ets/logic/PdfRunText.ts';
import { centerXOf, compareByPageThenY, type PdfTextRun } from '../entry/src/main/ets/logic/PdfModels.ts';

const SAMPLE = [
  'OK',
  '1\t58.20\t123.40\t96.70\t9.00\t星期三',
  '1\t101.50\t123.20\t125.00\t9.00\t5-6',
  '1\t150.00\t123.00\t210.00\t10.00\t软件工程★',
  '1\t300.10\t123.80\t360.00\t9.00\t周数:1-16 地点:思源楼-301 教师:张老师',
  'END',
].join('\n');

test('parse：正常回传 → 带坐标的文本片段', () => {
  const r = PdfRunText.parse(SAMPLE);
  assert.equal(r.ok, true);
  assert.equal(r.error, '');
  assert.equal(r.pageCount, 1);
  assert.equal(r.malformed, 0);
  assert.equal(r.runs.length, 4);

  const first = r.runs[0];
  assert.equal(first.text, '星期三');
  assert.equal(first.page, 1);
  assert.equal(first.x, 58.2);
  assert.equal(first.y, 123.4);
  assert.equal(first.endX, 96.7);
  assert.equal(first.fontSize, 9);
  // 中心 x 排序/分列的依据
  assert.equal(centerXOf(first), (58.2 + 96.7) / 2);
});

test('parse：多页时 pageCount 取最大值，且 (page, y) 排序稳定', () => {
  const payload = [
    'OK',
    '2\t10\t20\t30\t9\t第二页',
    '1\t10\t90\t30\t9\t第一页下面',
    '1\t10\t10\t30\t9\t第一页上面',
    'END',
  ].join('\n');
  const r = PdfRunText.parse(payload);
  assert.equal(r.pageCount, 2);
  const sorted = r.runs.slice(0).sort(compareByPageThenY);
  assert.deepEqual(
    sorted.map((x: PdfTextRun) => x.text),
    ['第一页上面', '第一页下面', '第二页']
  );
});

test('parse：ERR 头 → ok=false 且带原因', () => {
  const r = PdfRunText.parse('ERR\tInvalid PDF structure\nEND');
  assert.equal(r.ok, false);
  assert.match(r.error, /Invalid PDF structure/);
  assert.equal(r.runs.length, 0);
});

test('parse：空回传 / 无法识别的头', () => {
  assert.equal(PdfRunText.parse('').ok, false);
  assert.match(PdfRunText.parse('').error, /为空/);
  const bad = PdfRunText.parse('WHAT\nEND');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /无法识别的回传头/);
});

test('parse：字段不足或数字非法的行被跳过并计数（不静默吞掉）', () => {
  const payload = [
    'OK',
    '1\t10\t20\t30\t9\t好的',
    '1\t10\t20\t30',            // 缺字段
    '1\tx\t20\t30\t9\t坏的',     // x 非法
    '0\t10\t20\t30\t9\t页码非法',
    'END',
  ].join('\n');
  const r = PdfRunText.parse(payload);
  assert.equal(r.ok, true);
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].text, '好的');
  assert.equal(r.malformed, 3);
});

test('parse：文本里带制表符时不会把字段挤错位', () => {
  const payload = ['OK', '1\t10\t20\t30\t9\t前\t后', 'END'].join('\n');
  const r = PdfRunText.parse(payload);
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].text, '前\t后');
});

test('parse：END 之后的内容被忽略（防止回传尾部混进脏数据）', () => {
  const payload = ['OK', '1\t10\t20\t30\t9\t只有这条', 'END', '1\t1\t1\t1\t1\t不该出现'].join('\n');
  const r = PdfRunText.parse(payload);
  assert.equal(r.runs.length, 1);
});

test('parse：空文本片段保留（空串也是合法 run，由解析器决定要不要用）', () => {
  const payload = ['OK', '1\t10\t20\t30\t9\t', 'END'].join('\n');
  const r = PdfRunText.parse(payload);
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].text, '');
});
