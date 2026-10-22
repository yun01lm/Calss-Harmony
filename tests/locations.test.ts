/** Locations 断言（15 条真实教室写法，来自三份真实课表 PDF 的实际字段） */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Locations } from '../entry/src/main/ets/logic/Locations.ts';

test('shortLocation：楼名简写 + 房号（15 条真实写法）', () => {
  const cases: Array<[string, string]> = [
    ['思源楼-401', '思源401'],
    ['知行楼-C207-智慧教室', '知行C207'],
    ['实验楼-B503-504', '实验楼B503-504'],
    ['本部-思源楼-301', '思源301'],
    ['本部-计算机基础实验室-2(503-504)', '实验室503-504'],
    ['本部计算机基础实验室-3(505-506)', '实验室505-506'],
    ['思源楼-404', '思源404'],
    ['思源楼-301', '思源301'],
    ['思源楼-435', '思源435'],
    ['思源楼239-智慧教室', '思源239'],
    ['思源楼-207-智慧教室', '思源207'],
    ['计算机基础实验室-3(505-506)', '实验室505-506'],
    ['计算机基础实验室-2(503-504)', '实验室503-504'],
    ['第一实验楼-A204大学物理实验-4', '实验楼A204'],
    ['第一实验楼机房C104', '实验楼C104'],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(Locations.shortLocation(raw), expected, `转换错误：${raw}`);
  }
});

test('roomOf：括号优先、支持字母房号、纯 1 位数字不算房号', () => {
  assert.equal(Locations.roomOf('计算机基础实验室-3(505-506)'), '505-506');
  assert.equal(Locations.roomOf('知行楼-C207-智慧教室'), 'C207');
  assert.equal(Locations.roomOf('实验楼-B503-504'), 'B503-504');
  assert.equal(Locations.roomOf('第一实验楼-A204大学物理实验-4'), 'A204', '不能取到编号尾巴 4');
  assert.equal(Locations.roomOf('思源楼239-智慧教室'), '239');
  assert.equal(Locations.roomOf('操场'), null);
  assert.equal(Locations.roomOf(''), null);
});

test('buildingPhrase：剥校区前缀；带后缀的楼名优先；智慧教室不算楼名', () => {
  assert.equal(Locations.buildingPhrase('本部-思源楼-301', '301'), '思源楼');
  assert.equal(Locations.buildingPhrase('本部计算机基础实验室-3(505-506)', '505-506'),
    '计算机基础实验室');
  assert.equal(Locations.buildingPhrase('知行楼-C207-智慧教室', 'C207'), '知行楼');
  assert.equal(Locations.buildingPhrase('思源楼239-智慧教室', '239'), '思源楼');
  assert.equal(Locations.buildingPhrase('B503-504', 'B503-504'), '', '只有房号时无楼名');
});

test('buildingShort：通用名保留，专名去尾，长名取有信息量的尾词', () => {
  assert.equal(Locations.buildingShort('实验楼'), '实验楼', '通用名不能去掉"楼"');
  assert.equal(Locations.buildingShort('图书馆'), '图书馆');
  assert.equal(Locations.buildingShort('思源楼'), '思源');
  assert.equal(Locations.buildingShort('知行楼'), '知行');
  assert.equal(Locations.buildingShort('计算机基础实验室'), '实验室');
  assert.equal(Locations.buildingShort('第一实验楼'), '实验楼');
  assert.equal(Locations.buildingShort('第一实验楼机房'), '实验楼', '比"机房"更能定位');
  assert.equal(Locations.buildingShort(''), '');
});

test('shortLocation：没有房号时原样返回；空串安全', () => {
  assert.equal(Locations.shortLocation('操场'), '操场');
  assert.equal(Locations.shortLocation('  操场  '), '操场');
  assert.equal(Locations.shortLocation(''), '');
  assert.equal(Locations.shortLocation('   '), '');
});

test('shortLocation：结果长度受控（超长只留房号）', () => {
  const out = Locations.shortLocation('思源楼-1234567-8901234');
  assert.ok(out.length <= Locations.MAX_SHORT, `结果过长：${out}`);
});
