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

// ---------------------------------------------------------------- 上架自检「字体」红线

/**
 * 应用市场「上架自检」的 UX 项有一句硬规定：
 * 「文本字号不小于 12 fp（推荐），最小不得小于 8 fp（**必须**）」。
 *
 * 2026-11 第一次自检就栽在这里：节次列的钟点小字写的是 `fontSize(7)`，
 * 自检判「不通过」，包直接被卡住。所以把字号常量当契约钉在测试里 ——
 * 谁再为了"塞得下"往下调，`npm test` 先红。
 */
test('字号不低于上架自检的 8fp 硬下限', () => {
  assert.equal(CellLayout.MIN_FONT_SIZE, 8, 'MIN_FONT_SIZE 就是自检的"必须"档，别改');

  assert.ok(
    CellLayout.GUTTER_TIME_FONT_SIZE >= CellLayout.MIN_FONT_SIZE,
    `节次列钟点小字 ${CellLayout.GUTTER_TIME_FONT_SIZE}fp 小于 ${CellLayout.MIN_FONT_SIZE}fp（曾因 7fp 被判不通过）`,
  );
  assert.ok(
    CellLayout.NARROW_FONT_SIZE >= CellLayout.MIN_FONT_SIZE,
    `窄格字号 ${CellLayout.NARROW_FONT_SIZE}fp 小于 ${CellLayout.MIN_FONT_SIZE}fp`,
  );
  // 行距必须比字号大，否则汉字上下会切边（7fp/8 行距就是这种写法）
  assert.ok(
    CellLayout.GUTTER_TIME_LINE_HEIGHT > CellLayout.GUTTER_TIME_FONT_SIZE,
    '钟点小字的行距要大于字号',
  );
});

test('任何格子算出来的课名字号都不低于 8fp', () => {
  const heights = [36, 56, 64, 100, 128, 200];
  const widths = [0, 22, 30, 40, 46, 90];
  const scales = [0.85, 1, 1.3, 2];
  for (const h of heights) {
    for (const w of widths) {
      for (const s of scales) {
        const lines = CellLayout.cellLines(h, s, w);
        assert.ok(
          lines.nameFontSize >= CellLayout.MIN_FONT_SIZE,
          `cellLines(h=${h}, scale=${s}, w=${w}) 给出 ${lines.nameFontSize}fp`,
        );
      }
    }
  }
});
