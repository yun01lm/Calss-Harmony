/**
 * 「教务系统导出的课表」解析（`logic/HtmlTable.ts` + `logic/JwxtTableParser.ts`）。
 *
 * 两层断言：
 * 1. **合成夹具**（`tests/fixtures/jwxt-sample.html`，姓名课程全假）—— 进仓库，CI 也跑，
 *    钉住"rowspan 跨节、一格多课、停课、单双周、网课无教室、底部作息"这些规则；
 * 2. **真实导出文件**（`tools/fixtures/jwxt-real.xls`，含学号姓名，**不入库**）——
 *    存在时跑完整数字断言，不存在时 skip。真实文件的写法比合成夹具脏得多
 *    （39 个课程块、8 处停课、各种周次写法），是最有说服力的那份证据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HtmlTableParser } from '../entry/src/main/ets/logic/HtmlTable.ts';
import { JwxtTableParser } from '../entry/src/main/ets/logic/JwxtTableParser.ts';
import { mergeCourseItems } from '../entry/src/main/ets/data/CourseMerge.ts';
import { WeekMasks } from '../entry/src/main/ets/logic/WeekMasks.ts';
import type { CourseWithSchedules } from '../entry/src/main/ets/data/models.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SYNTHETIC = path.join(here, 'fixtures', 'jwxt-sample.html');
const REAL = path.join(here, '..', 'tools', 'fixtures', 'jwxt-real.xls');

function load(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** RawCourse[] → 带时段的数据模型（与页面 toImportItems 同形） */
function toItems(courses: ReturnType<typeof JwxtTableParser.parse>['courses']): CourseWithSchedules[] {
  const out: CourseWithSchedules[] = [];
  for (const c of courses) {
    out.push({
      course: {
        id: 0,
        timetableId: 0,
        name: c.name,
        teacher: c.teacher,
        location: c.location,
        color: 0,
        category: c.category,
        note: '',
      },
      schedules: c.schedules.map((s) => ({
        id: 0,
        courseId: 0,
        dayOfWeek: s.dayOfWeek,
        startPeriod: s.startPeriod,
        endPeriod: s.endPeriod,
        weekMask: Number(s.weekMask),
        location: c.location,
        classGroup: s.classGroup,
      })),
    });
  }
  return out;
}

// ---------------------------------------------------------------- 基础件

test('HtmlTable：rowspan 被正确展开（同一门课覆盖两行）', () => {
  const tables = HtmlTableParser.parse(load(SYNTHETIC));
  const main = tables.find((t) => t.rowCount >= 4);
  assert.ok(main !== undefined, '应当解析出正文表');
  const head = HtmlTableParser.cellAt(main, 1, 0);
  assert.ok(head !== null);
  assert.equal(head.text, '第一节');
  const course = HtmlTableParser.cellAt(main, 1, 1);
  assert.ok(course !== null);
  assert.equal(course.rowSpan, 2, '第一节的课跨到第二节');
  // 第二节那一行同一个位置仍然指向同一个单元格
  const same = HtmlTableParser.cellAt(main, 2, 1);
  assert.ok(same !== null);
  assert.equal(same.row, course.row);
});

test('HtmlTable：<br> 变换行、标签剔除、空白规整', () => {
  const text = HtmlTableParser.textOf('  A<br>B   C  <font>x</font> ');
  assert.equal(text, 'A\nB C x');
});

test('HtmlTable：不配对 <table> 也能切（教务导出实测 4 开 2 闭）', () => {
  const html = '<table><tr><td>1</td><td>2</td></tr><tr><td>1b</td><td>2b</td></tr></table>' +
    '<table><tr><td>3</td><td>4</td></tr><tr><td>3b</td><td>4b</td></tr>';
  const tables = HtmlTableParser.parse(html);
  assert.equal(tables.length, 2, '第二个表没有 </table> 也要能解析出来');
  assert.equal(HtmlTableParser.cellAt(tables[1], 0, 0)?.text, '3');
});

test('chineseNumber：一…十一 → 1..11', () => {
  assert.equal(JwxtTableParser.chineseNumber('一'), 1);
  assert.equal(JwxtTableParser.chineseNumber('十'), 10);
  assert.equal(JwxtTableParser.chineseNumber('十一'), 11);
  assert.equal(JwxtTableParser.chineseNumber('二十'), 20);
  assert.equal(JwxtTableParser.chineseNumber('三十'), 30);
  assert.equal(JwxtTableParser.periodIndexOf(' 第三节'), 3);
  assert.equal(JwxtTableParser.periodIndexOf('第四节（下午）'), 4);
  assert.equal(JwxtTableParser.periodIndexOf('课间'), null);
});

test('splitWeeks：各种周次写法', () => {
  const a = JwxtTableParser.splitWeeks('[1-4]  A14-0615(本部)');
  assert.equal(a.isWeeks, true);
  assert.equal(a.room, 'A14-0615');
  assert.equal(Number(a.mask), Number(WeekMasks.range(1, 4)));

  const odd = JwxtTableParser.splitWeeks('[1-15]单  A04-0505(本部)');
  assert.equal(odd.isWeeks, true);
  assert.equal(WeekMasks.contains(odd.mask, 1), true);
  assert.equal(WeekMasks.contains(odd.mask, 2), false);

  const even = JwxtTableParser.splitWeeks('[6-16]双  A01-0202(本部)');
  assert.equal(WeekMasks.contains(even.mask, 6), true);
  assert.equal(WeekMasks.contains(even.mask, 7), false);

  const multi = JwxtTableParser.splitWeeks('[1-2],[5-17],19  A02-0303(本部)');
  assert.equal(WeekMasks.contains(multi.mask, 3), false);
  assert.equal(WeekMasks.contains(multi.mask, 5), true);
  assert.equal(WeekMasks.contains(multi.mask, 19), true);
  assert.equal(multi.room, 'A02-0303');

  // 网课：没有教室
  const online = JwxtTableParser.splitWeeks('[1-3],[5-16]  ');
  assert.equal(online.isWeeks, true);
  assert.equal(online.room, '');

  // 停课：**不能**产出周次（这是最容易写错的一条）
  const cancel = JwxtTableParser.splitWeeks('4  停课(本部)');
  assert.equal(cancel.isWeeks, true);
  assert.equal(Number(cancel.mask), 0, '停课行不能算成"第 4 周有课"');
  assert.equal(cancel.cancelled, 1);
  assert.equal(WeekMasks.contains(cancel.cancelMask, 4), true);

  // 教师行不是周次行
  const teacher = JwxtTableParser.splitWeeks('甲老师,乙老师');
  assert.equal(teacher.isWeeks, false);
});

// ---------------------------------------------------------------- 合成夹具

test('合成夹具：课程、跨节、单双周、停课剔除、网课无教室、作息', () => {
  const r = JwxtTableParser.parse(load(SYNTHETIC));
  assert.equal(r.dayCount, 7);
  assert.equal(r.slots.length, 4, '底部作息应有 4 节');
  assert.equal(r.slots[0].startMinute, 8 * 60);
  assert.equal(r.slots[0].endMinute, 8 * 60 + 45);

  const merged = mergeCourseItems(toItems(r.courses));
  const names = merged.items.map((i) => i.course.name).sort();
  assert.deepEqual(names, ['示例单双周课', '示例实验课', '示例数据结构', '示例程序设计', '示例网课']);

  const prog = merged.items.find((i) => i.course.name === '示例程序设计');
  assert.ok(prog !== undefined);
  // 第一节那格跨两行 → 每段都是 1-2 节；两段周次/教室不同（[1-4] 与 [6-16]双），
  // 各自成为一条时段（**不能**把教室和合并不一样的周次硬凑成一条）
  assert.equal(prog.schedules.length, 2, '两段周次各自一条时段');
  for (const s of prog.schedules) {
    assert.equal(s.startPeriod, 1);
    assert.equal(s.endPeriod, 2);
  }
  const progWeeks = prog.schedules.map((s) => WeekMasks.format(BigInt(s.weekMask)));
  assert.ok(progWeeks.indexOf('1-4') >= 0, progWeeks.join(' | '));
  assert.ok(progWeeks.some((w) => w.indexOf('双') >= 0), progWeeks.join(' | '));

  const net = merged.items.find((i) => i.course.name === '示例网课');
  assert.ok(net !== undefined);
  assert.equal(net.course.location, '', '网课没有教室');
  helperAssert停课剔除(net.schedules[0].weekMask);

  const odd = merged.items.find((i) => i.course.name === '示例单双周课');
  assert.ok(odd !== undefined);
  assert.equal(WeekMasks.contains(BigInt(odd.schedules[0].weekMask), 3), true);
  assert.equal(WeekMasks.contains(BigInt(odd.schedules[0].weekMask), 4), false);

  // 教师多个：用顿号连起来
  const ds = merged.items.find((i) => i.course.name === '示例数据结构');
  assert.ok(ds !== undefined);
  assert.equal(ds.course.teacher, '乙老师、丙老师');
});

function helperAssert停课剔除(mask: number): void {
  assert.equal(WeekMasks.contains(BigInt(mask), 4), false, '停课的第 4 周不能出现在周次里');
  assert.equal(WeekMasks.contains(BigInt(mask), 1), true);
}

// ---------------------------------------------------------------- 真实文件（本地夹具）

test('真实导出文件：39 个课程块 → 去重 12 门课、11 节作息、8 处停课剔除', (t) => {
  if (!fs.existsSync(REAL)) {
    t.skip('没有本地夹具 tools/fixtures/jwxt-real.xls（含学号姓名，不入库）');
    return;
  }
  const r = JwxtTableParser.parse(load(REAL));
  assert.equal(r.dayCount, 7);
  assert.equal(r.courses.length, 31, '39 个块里 8 个是"停课"，不该产出课程');
  assert.equal(r.slots.length, 11, '作息 11 节');
  assert.ok(r.warnings.some((w) => w.indexOf('停课') >= 0), JSON.stringify(r.warnings));

  const merged = mergeCourseItems(toItems(r.courses));
  assert.equal(merged.items.length, 12, '按 名称+教师 去重后 12 门');

  const net = merged.items.find((i) => i.course.name === '计算机网络');
  assert.ok(net !== undefined);
  // 3 段：周1 1-2 [1-4]、周1 1-2 [13-16]、周1 3-4 [1-4],[6-16]
  assert.equal(net.schedules.length, 3);
  const weeks = net.schedules.map((s) => WeekMasks.format(BigInt(s.weekMask)));
  assert.ok(weeks.indexOf('1-4') >= 0, weeks.join(' | '));
  assert.ok(weeks.indexOf('13-16') >= 0, weeks.join(' | '));

  // 单双周：高等数学有 [6-16]双 与 [9-17]单 两段
  const math = merged.items.find((i) => i.course.name === '高等数学E1');
  assert.ok(math !== undefined);
  const mathWeeks = math.schedules.map((s) => WeekMasks.format(BigInt(s.weekMask)));
  assert.ok(mathWeeks.some((w) => w.indexOf('单') >= 0), mathWeeks.join(' | '));
  assert.ok(mathWeeks.some((w) => w.indexOf('双') >= 0), mathWeeks.join(' | '));

  // 网课：教室为空
  const online = merged.items.find((i) => i.course.name.indexOf('心理健康') >= 0);
  assert.ok(online !== undefined);
  assert.equal(online.course.location, '');
  assert.equal(WeekMasks.contains(BigInt(online.schedules[0].weekMask), 19), true);
});
