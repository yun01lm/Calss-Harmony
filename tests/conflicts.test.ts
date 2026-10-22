/** Conflicts 断言（移植自 verify_grid_layout.py 第 6 节 6 条 + 并排车道边界） */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Conflicts, type GridSlot } from '../entry/src/main/ets/logic/Conflicts.ts';

function slot(dayOfWeek: number, startPeriod: number, endPeriod: number, title: string): GridSlot {
  const s: GridSlot = { dayOfWeek, startPeriod, endPeriod, title };
  return s;
}

function conflictCounts(items: GridSlot[]): number[] {
  return Conflicts.markConflicts(items).map((m) => m.conflicts.length);
}

function lanePairs(items: GridSlot[]): Array<[number, number]> {
  return Conflicts.lanesFor(items).map((l) => [l.lane, l.laneCount]);
}

test('同一格完全重叠：互相标记冲突，并排各占一道', () => {
  const items = [slot(1, 3, 4, '软件工程'), slot(1, 3, 4, '操作系统')];
  assert.deepEqual(conflictCounts(items), [1, 1]);
  assert.deepEqual(Conflicts.markConflicts(items)[0].conflicts, ['操作系统']);
  assert.deepEqual(lanePairs(items), [[1, 2], [0, 2]]);
});

test('相邻但不重叠（3-4 与 5-6）：不判冲突，各占整格', () => {
  const items = [slot(1, 3, 4, '甲'), slot(1, 5, 6, '乙')];
  assert.deepEqual(conflictCounts(items), [0, 0]);
  assert.deepEqual(lanePairs(items), [[0, 1], [0, 1]]);
});

test('共占一格（3-5 与 5-6）：判冲突，并排', () => {
  const items = [slot(2, 3, 5, '甲'), slot(2, 5, 6, '乙')];
  assert.deepEqual(conflictCounts(items), [1, 1]);
  assert.deepEqual(lanePairs(items), [[0, 2], [1, 2]]);
});

test('三门连排：前两门冲突并排，第三门独立占满', () => {
  const items = [slot(3, 3, 4, '甲'), slot(3, 4, 5, '乙'), slot(3, 6, 7, '丙')];
  assert.deepEqual(conflictCounts(items), [1, 1, 0]);
  assert.deepEqual(lanePairs(items), [[0, 2], [1, 2], [0, 1]]);
});

test('不同天不会互相判冲突', () => {
  const items = [slot(1, 3, 4, '甲'), slot(4, 3, 4, '乙')];
  assert.deepEqual(conflictCounts(items), [0, 0]);
  assert.deepEqual(lanePairs(items), [[0, 1], [0, 1]]);
});

test('重复导入留下的同名两门课：必须提示', () => {
  const items = [slot(5, 9, 10, 'Web程序设计'), slot(5, 9, 10, 'Web程序设计')];
  assert.deepEqual(conflictCounts(items), [1, 1]);
  assert.deepEqual(lanePairs(items), [[0, 2], [1, 2]]);
  assert.deepEqual(Conflicts.markConflicts(items)[0].conflicts, ['Web程序设计'], '同名去重');
});

test('三门同一时刻重叠：三条道', () => {
  const items = [slot(2, 1, 2, 'A'), slot(2, 1, 2, 'B'), slot(2, 1, 2, 'C')];
  assert.deepEqual(conflictCounts(items), [2, 2, 2]);
  const lanes = lanePairs(items);
  assert.deepEqual(lanes.map((p) => p[1]), [3, 3, 3]);
  assert.deepEqual(lanes.map((p) => p[0]).slice().sort(), [0, 1, 2]);
});

test('单条 / 空数组安全', () => {
  assert.deepEqual(conflictCounts([]), []);
  assert.deepEqual(lanePairs([]), []);
  assert.deepEqual(conflictCounts([slot(1, 1, 2, 'X')]), [0]);
  assert.deepEqual(lanePairs([slot(1, 1, 2, 'X')]), [[0, 1]]);
  assert.equal(Conflicts.hasConflict({ conflicts: [] }), false);
  assert.equal(Conflicts.hasConflict({ conflicts: ['X'] }), true);
});

test('车道分配与输入顺序无关（稳定可复现）', () => {
  const a = [slot(1, 3, 4, '甲'), slot(1, 3, 4, '乙')];
  const b = [slot(1, 3, 4, '乙'), slot(1, 3, 4, '甲')];
  const la = Conflicts.lanesFor(a);
  const lb = Conflicts.lanesFor(b);
  assert.deepEqual(la[1], lb[0], '乙的道应一致');
  assert.deepEqual(la[0], lb[1], '甲的道应一致');
});
