/** CellLayout 断言（移植自 verify_grid_layout.py 第 5 节：5 档字体 × 3 种高度 + 不变量） */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CellLayout } from '../entry/src/main/ets/logic/CellLayout.ts';

test('排版真值表：5 档字体缩放 × 3 种格子高度', () => {
  const expected: Array<[number, number, number, number]> = [
    [1.00, 56, 2, 1],
    [1.00, 64, 3, 1],
    [1.00, 100, 4, 2],
    [1.15, 56, 2, 1],
    [1.15, 64, 2, 1],
    [1.15, 100, 4, 2],
    [1.30, 56, 1, 2],
    [1.30, 64, 2, 1],
    [1.30, 100, 3, 2],
    [1.50, 56, 1, 1],
    [1.50, 64, 1, 2],
    [1.50, 100, 3, 1],
    [2.00, 56, 1, 0],
    [2.00, 64, 1, 1],
    [2.00, 100, 2, 1],
  ];
  for (const [scale, h, nameLines, locationLines] of expected) {
    const got = CellLayout.cellLines(h, scale);
    assert.equal(got.nameLines, nameLines, `字体 ${scale}× / ${h}vp 的课名行数`);
    assert.equal(got.locationLines, locationLines, `字体 ${scale}× / ${h}vp 的教室行数`);
  }
});

test('核心不变量（合法域内）：内容占高不超过可用高度', () => {
  for (const scale of [1.0, 1.15, 1.3, 1.5, 1.8, 2.0, 2.5, 3.0, 3.5]) {
    for (let h = 56; h <= 200; h += 2) {
      const r = CellLayout.cellLines(h, scale);
      assert.ok(r.used <= r.available + 1e-9,
        `溢出：字体 ${scale}× / ${h}vp → used=${r.used} available=${r.available}`);
      assert.equal(r.clipped, false, `合法域内不应裁切：字体 ${scale}× / ${h}vp`);
      assert.ok(r.nameLines >= 1, '课名至少一行');
      assert.ok(r.locationLines >= 0 && r.locationLines <= 2);
    }
  }
});

test('域外输入（低于最小格子 / 极端字体）：标记 clipped 而不是假装放得下', () => {
  const tiny = CellLayout.cellLines(40, 2.5);
  assert.equal(tiny.nameLines, 1);
  assert.equal(tiny.locationLines, 0);
  assert.equal(tiny.clipped, true);
  assert.ok(tiny.used > tiny.available);
  assert.equal(CellLayout.cellLines(56, 4.0).clipped, true);
});

test('教室优先：还剩得下一行就一定给教室', () => {
  const r = CellLayout.cellLines(64, 1.0);
  assert.equal(r.nameLines, 3);
  assert.equal(r.locationLines, 1);
});

test('跨两节的宽裕格子字号更大（11fp / 14fp 行距）', () => {
  const tight = CellLayout.cellLines(36, 1.0);
  const roomy = CellLayout.cellLines(128, 1.0);
  assert.equal(tight.roomy, false);
  assert.equal(roomy.roomy, true);
  assert.equal(tight.nameFontSize, 10);
  assert.equal(roomy.nameFontSize, 11);
  assert.ok(roomy.lineHeight > tight.lineHeight);
  assert.equal(CellLayout.cellLines(64, 1.0).roomy, true, '64vp 本身就是宽裕档');
});

test('格子下限：普通屏 64vp，小屏（<520vp）56vp', () => {
  assert.equal(CellLayout.minCellHeightFor(800), CellLayout.MIN_CELL_HEIGHT);
  assert.equal(CellLayout.minCellHeightFor(521), CellLayout.MIN_CELL_HEIGHT);
  assert.equal(CellLayout.minCellHeightFor(520), CellLayout.MIN_CELL_HEIGHT, '恰好 520 仍算普通屏');
  assert.equal(CellLayout.minCellHeightFor(519), CellLayout.MIN_CELL_HEIGHT_SMALL_SCREEN);
  assert.equal(CellLayout.minCellHeightFor(400), CellLayout.MIN_CELL_HEIGHT_SMALL_SCREEN);
});

test('节次列钟点小字：字体超过 1.3× 就隐藏', () => {
  assert.equal(CellLayout.showGutterTime(1.0), true);
  assert.equal(CellLayout.showGutterTime(1.3), true);
  assert.equal(CellLayout.showGutterTime(1.31), false);
  assert.equal(CellLayout.showGutterTime(2.0), false);
});

test('异常输入：fontScale 为 0/负数时按 1 处理', () => {
  assert.deepEqual(CellLayout.cellLines(64, 0), CellLayout.cellLines(64, 1));
  assert.doesNotThrow(() => CellLayout.cellLines(64, -1));
});

// ---------------------------------------------------------------- 窄格（撞车时每门只剩 ~22vp）

test('窄格：字号降一档、最多两行、不放教室（否则中文竖成一列）', () => {
  const normal = CellLayout.cellLines(64, 1);
  const narrow = CellLayout.cellLines(64, 1, 22);

  assert.equal(narrow.nameFontSize, CellLayout.NARROW_FONT_SIZE);
  assert.ok(narrow.nameFontSize < normal.nameFontSize, '窄格必须比正常格小一号');
  assert.ok(narrow.nameLines <= 2, '窄格最多两行，避免竖字');
  assert.equal(narrow.locationLines, 0, '窄格放不下教室行，宁可不放也不叠字');
  assert.equal(narrow.clipped, false, '两行一定放得下');
});

test('宽度够时不走窄格分支（回归：正常格子排版不变）', () => {
  const byDefault = CellLayout.cellLines(64, 1);
  const explicit = CellLayout.cellLines(64, 1, 60);
  assert.deepEqual(explicit, byDefault);
  // 边界：正好等于阈值时不算窄
  const atThreshold = CellLayout.cellLines(64, 1, CellLayout.NARROW_WIDTH);
  assert.deepEqual(atThreshold, byDefault);
});