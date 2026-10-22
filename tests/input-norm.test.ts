/** InputNorm 断言（移植自 verify_inputnorm.ps1 的 47 条：时间/日期/周次/幂等/整数） */
import test from 'node:test';
import assert from 'node:assert/strict';

import { InputNorm } from '../entry/src/main/ets/logic/InputNorm.ts';

test('halfWidth：全角数字与符号转半角', () => {
  assert.equal(InputNorm.halfWidth('０８：００'), '08:00');
  assert.equal(InputNorm.halfWidth('１－１６'), '1-16');
  assert.equal(InputNorm.halfWidth('１～８'), '1~8');
  assert.equal(InputNorm.halfWidth('１，３'), '1,3');
  assert.equal(InputNorm.halfWidth('  1-16  '), '1-16');
});

test('int：全角数字可解析，非法返回 null', () => {
  assert.equal(InputNorm.int('５'), 5);
  assert.equal(InputNorm.int('20'), 20);
  assert.equal(InputNorm.int(' 3 '), 3);
  assert.equal(InputNorm.int('abc'), null);
  assert.equal(InputNorm.int(''), null);
  assert.equal(InputNorm.int('1.5'), null);
});

test('time：能自动纠正的写法', () => {
  assert.equal(InputNorm.time('8:5'), '8:05');
  assert.equal(InputNorm.time('08：00'), '8:00');
  assert.equal(InputNorm.time('8'), '8:00');
  assert.equal(InputNorm.time('800'), '8:00');
  assert.equal(InputNorm.time('1945'), '19:45');
  assert.equal(InputNorm.time('8: 05'), '8:05');
  assert.equal(InputNorm.time('8.5'), '8:05');
  assert.equal(InputNorm.time('0:00'), '0:00');
  assert.equal(InputNorm.time('23:59'), '23:59');
});

test('time：非法值返回 null', () => {
  assert.equal(InputNorm.time('24:00'), null);
  assert.equal(InputNorm.time('8:60'), null);
  assert.equal(InputNorm.time('abc'), null);
  assert.equal(InputNorm.time('080'), null, '0:80 分钟越界');
  assert.equal(InputNorm.time(''), null);
});

test('date：多种写法都自动补零', () => {
  assert.equal(InputNorm.date('2026-9-1'), '2026-09-01');
  assert.equal(InputNorm.date('2026/9/1'), '2026-09-01');
  assert.equal(InputNorm.date('2026.9.1'), '2026-09-01');
  assert.equal(InputNorm.date('2026年9月1日'), '2026-09-01');
  assert.equal(InputNorm.date('20260901'), '2026-09-01');
  assert.equal(InputNorm.date('2026-12-31'), '2026-12-31');
});

test('date：不存在的日期返回 null（含闰年判定）', () => {
  assert.equal(InputNorm.date('2026-2-30'), null);
  assert.equal(InputNorm.date('2026-13-1'), null);
  assert.equal(InputNorm.date('abc'), null);
  assert.equal(InputNorm.date('2026-1-32'), null);
  assert.equal(InputNorm.date('2027-2-29'), null, '2027 非闰年');
  assert.equal(InputNorm.date('2028-2-29'), '2028-02-29', '2028 是闰年');
});

test('weeks：基本写法与压缩', () => {
  assert.equal(InputNorm.weeks('1-16'), '1-16');
  assert.equal(InputNorm.weeks('1~8周'), '1-8');
  assert.equal(InputNorm.weeks('1,2,3'), '1-3');
  assert.equal(InputNorm.weeks('2,4,6-8'), '2,4,6-8');
  assert.equal(InputNorm.weeks('13'), '13');
});

test('weeks：全角符号与分隔符', () => {
  assert.equal(InputNorm.weeks('1－16'), '1-16', '全角连字符');
  assert.equal(InputNorm.weeks('1，3，5'), '1,3,5', '全角逗号');
  assert.equal(InputNorm.weeks('1 3'), '1,3', '空格是分隔符，不能合成 13');
  assert.equal(InputNorm.weeks('1、3'), '1,3', '顿号');
});

test('weeks：单双周规范化', () => {
  assert.equal(InputNorm.weeks('1-15单'), '1-15单');
  assert.equal(InputNorm.weeks('1-15周(单)'), '1-15单');
  assert.equal(InputNorm.weeks('2-16双'), '2-16双');
  assert.equal(InputNorm.weeks('2-16周（双）'), '2-16双');
  assert.equal(InputNorm.weeks('1,3,5,7'), '1-7单', '纯奇数周压成单周写法');
  assert.equal(InputNorm.weeks('2,4,6,8'), '2-8双');
});

test('weeks：认不出的写法必须拒绝（白名单，不许静默部分解析）', () => {
  assert.equal(InputNorm.weeks('第1-3周'), null, '中文"第"不在白名单');
  assert.equal(InputNorm.weeks('abc'), null);
  assert.equal(InputNorm.weeks(''), null);
  assert.equal(InputNorm.weeks('0'), null);
  assert.equal(InputNorm.weeks('65'), null, '超出 64 周');
});

test('幂等性：规范化结果再跑一遍不变', () => {
  for (const raw of ['8:5', '1945', '8: 05', '08：00']) {
    const once = InputNorm.time(raw);
    assert.notEqual(once, null);
    assert.equal(InputNorm.time(once as string), once, `时间幂等失败：${raw}`);
  }
  for (const raw of ['2026-9-1', '20260901', '2026年9月1日']) {
    const once = InputNorm.date(raw);
    assert.notEqual(once, null);
    assert.equal(InputNorm.date(once as string), once, `日期幂等失败：${raw}`);
  }
  for (const raw of ['1~8周', '1,2,3', '1－16', '1 3', '1,3,5,7']) {
    const once = InputNorm.weeks(raw);
    assert.notEqual(once, null);
    assert.equal(InputNorm.weeks(once as string), once, `周次幂等失败：${raw}`);
  }
});
