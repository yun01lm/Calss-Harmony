/** WeekMasks 断言（对齐 Android `object WeekMasks`；用例来自 verify_inputnorm 周次段 + 边界） */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WeekMasks } from '../entry/src/main/ets/logic/WeekMasks.ts';

function weeks(mask: bigint): number[] {
  const out: number[] = [];
  for (let w = 1; w <= WeekMasks.MAX_WEEK; w++) {
    if (WeekMasks.contains(mask, w)) out.push(w);
  }
  return out;
}

test('of / contains：基本周次', () => {
  assert.deepEqual(weeks(WeekMasks.of(1)), [1]);
  assert.deepEqual(weeks(WeekMasks.of(16)), [16]);
  assert.equal(WeekMasks.contains(WeekMasks.of(3), 3), true);
  assert.equal(WeekMasks.contains(WeekMasks.of(3), 2), false);
});

test('of：非法周次抛错（而不是静默返回 0）', () => {
  assert.throws(() => WeekMasks.of(0), RangeError);
  assert.throws(() => WeekMasks.of(65), RangeError);
  assert.throws(() => WeekMasks.of(1.5), RangeError);
});

test('of：第 64 周可用（bigint 才做得到，number 位运算会溢出）', () => {
  const m = WeekMasks.of(64);
  assert.equal(WeekMasks.contains(m, 64), true);
  assert.deepEqual(weeks(m), [64]);
  assert.equal(m.toString(16), '8000000000000000');
});

test('contains：越界周次返回 false 而不抛错', () => {
  assert.equal(WeekMasks.contains(WeekMasks.of(1), 0), false);
  assert.equal(WeekMasks.contains(WeekMasks.of(1), 65), false);
});

test('range：区间、反序、越界夹取', () => {
  assert.deepEqual(weeks(WeekMasks.range(1, 3)), [1, 2, 3]);
  assert.deepEqual(weeks(WeekMasks.range(3, 1)), [1, 2, 3], '反序自动交换');
  assert.deepEqual(weeks(WeekMasks.range(0, 2)), [1, 2], '下界夹到 1');
  assert.deepEqual(weeks(WeekMasks.range(63, 99)), [63, 64], '上界夹到 64');
});

test('parse：单个、区间、混合分隔', () => {
  assert.deepEqual(weeks(WeekMasks.parse('11')), [11]);
  assert.deepEqual(weeks(WeekMasks.parse('1-16')),
    [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]);
  assert.deepEqual(weeks(WeekMasks.parse('2-8,10-16')), [2,3,4,5,6,7,8,10,11,12,13,14,15,16]);
  assert.deepEqual(weeks(WeekMasks.parse('1,2,3')), [1, 2, 3]);
  assert.deepEqual(weeks(WeekMasks.parse('1，3，5')), [1, 3, 5], '全角逗号');
  assert.deepEqual(weeks(WeekMasks.parse('1、3、5')), [1, 3, 5], '顿号');
  assert.deepEqual(weeks(WeekMasks.parse('1 3 5')), [1, 3, 5], '空格分隔');
});

test('parse：中文单位与波浪号、长短破折号', () => {
  assert.deepEqual(weeks(WeekMasks.parse('1-12周')), [1,2,3,4,5,6,7,8,9,10,11,12]);
  assert.deepEqual(weeks(WeekMasks.parse('1~8')), [1,2,3,4,5,6,7,8]);
  assert.deepEqual(weeks(WeekMasks.parse('1–16')),
    [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], 'en dash');
  assert.deepEqual(weeks(WeekMasks.parse('1—8')), [1,2,3,4,5,6,7,8], 'em dash');
});

test('parse：单双周（实测必需）', () => {
  assert.deepEqual(weeks(WeekMasks.parse('1-15单')), [1,3,5,7,9,11,13,15]);
  assert.deepEqual(weeks(WeekMasks.parse('1-15周(单)')), [1,3,5,7,9,11,13,15]);
  assert.deepEqual(weeks(WeekMasks.parse('1-16单周')), [1,3,5,7,9,11,13,15]);
  assert.deepEqual(weeks(WeekMasks.parse('2-16双')), [2,4,6,8,10,12,14,16]);
  assert.deepEqual(weeks(WeekMasks.parse('2-16周（双）')), [2,4,6,8,10,12,14,16], '全角括号');
});

test('parse：单双周在区间两端的边界', () => {
  assert.deepEqual(weeks(WeekMasks.parse('2-7单')), [3, 5, 7]);
  assert.deepEqual(weeks(WeekMasks.parse('3-8双')), [4, 6, 8]);
});

test('parse：无法识别的片段整段忽略（不猜测）', () => {
  assert.equal(WeekMasks.parse(''), 0n);
  assert.equal(WeekMasks.parse('abc'), 0n);
  assert.equal(WeekMasks.parse('单'), 0n);
  assert.equal(WeekMasks.parse('周'), 0n);
  assert.deepEqual(weeks(WeekMasks.parse('abc,1-2,xyz')), [1, 2]);
});

test('parse：超出 1..64 的周次被忽略（学期外不算错）', () => {
  assert.equal(WeekMasks.parse('0'), 0n);
  assert.equal(WeekMasks.parse('65'), 0n);
  assert.deepEqual(weeks(WeekMasks.parse('63-70')), [63, 64]);
});

test('parse："1-2-3" 只用前两个数字（与 Android 行为一致）', () => {
  assert.deepEqual(weeks(WeekMasks.parse('1-2-3')), [1, 2]);
});

test('format：连续压缩与离散列出', () => {
  assert.equal(WeekMasks.format(0n), '');
  assert.equal(WeekMasks.format(WeekMasks.parse('1-16')), '1-16');
  assert.equal(WeekMasks.format(WeekMasks.parse('13')), '13');
  assert.equal(WeekMasks.format(WeekMasks.parse('1,2,3')), '1-3');
  assert.equal(WeekMasks.format(WeekMasks.parse('2,4,6-8')), '2,4,6-8');
  assert.equal(WeekMasks.format(WeekMasks.parse('1-12,14')), '1-12,14');
});

test('format：纯单双周压回 "1-15单" / "2-16双"', () => {
  assert.equal(WeekMasks.format(WeekMasks.parse('1-15单')), '1-15单');
  assert.equal(WeekMasks.format(WeekMasks.parse('2-16双')), '2-16双');
  assert.equal(WeekMasks.format(WeekMasks.parse('1,3')), '1,3', '少于 4 周不压成单双周写法');
});

test('parse/format 往返：任意掩码都能无损往返', () => {
  const samples = ['1-16', '1,3,5,7', '2-16双', '1-15单', '5', '1-4,8,10-12', '63-64'];
  for (const s of samples) {
    const once = WeekMasks.parse(s);
    const text = WeekMasks.format(once);
    const twice = WeekMasks.parse(text);
    assert.equal(twice, once, `往返失败：${s} → "${text}"`);
  }
});

test('isValid：空/垃圾输入为 false，可解析为 true', () => {
  assert.equal(WeekMasks.isValid(''), false);
  assert.equal(WeekMasks.isValid('abc'), false);
  assert.equal(WeekMasks.isValid('0'), false);
  assert.equal(WeekMasks.isValid('1-16'), true);
  assert.equal(WeekMasks.isValid('1-15单'), true);
});
