/**
 * 真实 PDF 的**回归**（本地夹具，CI 上自动跳过）。
 *
 * 为什么放夹具文件而不是内联：真实课表里有人名、学号、教师名，**不能进仓库**
 * （见 `.gitignore` 的 `/tools/fixtures/`）。所以这份用例的规则是：
 *
 * - 夹具存在 → 跑完整链路（pdf.js 回传文本 → `PdfRunText` → `GridFormatParser`
 *   → `mergeCourseItems`），断言门数/格子数与上次人工核对的结果一致；
 * - 夹具不存在（CI、别人的机器）→ **skip**，不假装通过。
 *
 * 怎么造夹具（设备上）：
 * 1. 开发者入口 → 「导入」一份真实课表 PDF；
 * 2. 应用会把 pdf.js 的原样回传写到沙箱 `filesDir/pdf-runs.txt`（`Index.dumpRunsForDebug`）；
 * 3. `hdc file recv /data/app/el2/100/base/<bundle>/haps/entry/files/pdf-runs.txt tools/fixtures/real-pdf-runs.txt`
 *
 * 这份用例的价值在于：解析器/归并规则改动之后，**真实版式的门数一变就能立刻看见**
 * —— 合成数据永远造不出真实 PDF 里那些折行、缺字段、脏尾巴。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PdfRunText } from '../entry/src/main/ets/logic/PdfRunText.ts';
import { GridFormatParser } from '../entry/src/main/ets/logic/GridFormatParser.ts';
import { mergeCourseItems } from '../entry/src/main/ets/data/CourseMerge.ts';
import type { CourseWithSchedules } from '../entry/src/main/ets/data/models.ts';
import type { ParseResult } from '../entry/src/main/ets/logic/PdfModels.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, '..', 'tools', 'fixtures', 'real-pdf-runs.txt');

/** 人工核对过的基线（见 docs/ACCEPTANCE.md 与 docs/COMPAT.md §11/§12） */
const EXPECTED_COURSES = 14;
const EXPECTED_RAW_CELLS = 22;

test('真实课表 PDF：22 条格子 → 14 门课（夹具存在时）', (t) => {
  if (!fs.existsSync(FIXTURE)) {
    t.skip('没有本地夹具 tools/fixtures/real-pdf-runs.txt（含姓名，不入库）');
    return;
  }
  const payload = fs.readFileSync(FIXTURE, 'utf8');
  const extracted = PdfRunText.parse(payload);
  assert.equal(extracted.ok, true, '夹具应当是 pdf.js 的成功回传');

  const parsed: ParseResult = GridFormatParser.parse(extracted.runs);
  assert.equal(
    parsed.courses.length,
    EXPECTED_RAW_CELLS,
    '格子数变了：解析器的"一格一条"输出被你改动了'
  );

  const items: CourseWithSchedules[] = [];
  for (const rc of parsed.courses) {
    items.push({
      course: {
        id: 0,
        timetableId: 0,
        name: rc.name,
        teacher: rc.teacher,
        location: rc.location,
        color: 0,
        category: rc.category,
        note: '',
      },
      schedules: rc.schedules.map((s) => ({
        id: 0,
        courseId: 0,
        dayOfWeek: s.dayOfWeek,
        startPeriod: s.startPeriod,
        endPeriod: s.endPeriod,
        weekMask: Number(s.weekMask),
        location: rc.location,
        classGroup: s.classGroup,
      })),
    });
  }
  const merged = mergeCourseItems(items);
  assert.equal(
    merged.items.length,
    EXPECTED_COURSES,
    '归并后的门数变了：合并键（名称+教师+教学班交集）被你改动了'
  );
  // 课名必须干净：带 `:1.0` 这类折行尾巴的课名会让"按名称归并"失效
  for (const it of merged.items) {
    assert.equal(
      /^[:：]?[\d.]+/.test(it.course.name),
      false,
      '课名被数值尾巴污染了：' + it.course.name
    );
    assert.ok(it.course.name.length > 0, '有空课名');
  }
});
