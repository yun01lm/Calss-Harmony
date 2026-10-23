/**
 * PDF 两种版式的行解析断言。
 *
 * 数据是**合成的**：真实课表夹具含姓名/学号/教师名，不能进仓库（见 .gitignore 的 /tools/fixtures/）。
 * 这里按真实版式的结构造数据（表头等距、课程名带类别符号、详情 3 段/7 段、折行、多页），
 * 覆盖 Android 版 `tools/verify_pdf_grid.py` 回归出的全部规则。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GridFormatParser } from '../entry/src/main/ets/logic/GridFormatParser.ts';
import { ListFormatParser } from '../entry/src/main/ets/logic/ListFormatParser.ts';
import { ParsingUtils } from '../entry/src/main/ets/logic/ParsingUtils.ts';
import { type PdfTextRun } from '../entry/src/main/ets/logic/PdfModels.ts';
import { WeekMasks } from '../entry/src/main/ets/logic/WeekMasks.ts';

/**
 * 造一个文本块。endX 默认 **最多跨 60pt** —— 真实 PDF 里每个单元格的文字是独立的 run，
 * 宽度不会溢出到隔壁列（第一版按"每字 10pt"估算，长详情行的中心 x 被推到隔壁列，
 * 结果 5 个网格用例全挂；那不是解析器的问题，是造数据不真实）。
 */
function run(text: string, x: number, y: number, page = 1, endX?: number): PdfTextRun {
  const r: PdfTextRun = {
    text,
    x,
    y,
    endX: endX !== undefined ? endX : x + Math.min(text.length * 10, 60),
    fontSize: 10,
    page,
  };
  return r;
}

/** 七列表头（等距 100pt，中心在 100/200/…/700，y=100） */
function gridHeaders(): PdfTextRun[] {
  const names = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
  const out: PdfTextRun[] = [];
  for (let i = 0; i < names.length; i++) {
    const cx = 100 + i * 100;
    out.push(run(names[i], cx - 30, 100, 1, cx + 30));
  }
  return out;
}

// ---------------------------------------------------------------- 公共工具
test('dayIndexFromLabel：星期表头（含"星期天"），非表头返回 null', () => {
  assert.equal(ParsingUtils.dayIndexFromLabel('星期一'), 1);
  assert.equal(ParsingUtils.dayIndexFromLabel('星期日'), 7);
  assert.equal(ParsingUtils.dayIndexFromLabel(' 星期天 '), 7);
  assert.equal(ParsingUtils.dayIndexFromLabel('周一'), null);
  assert.equal(ParsingUtils.dayIndexFromLabel('时间'), null);
});

test('hasMarker / cleanName：类别符号取第一个，名字尾部的标点被去掉', () => {
  assert.equal(ParsingUtils.hasMarker('高等数学★'), true);
  assert.equal(ParsingUtils.hasMarker('高等数学'), false);

  const a = ParsingUtils.cleanName('高等数学（A）★');
  assert.deepEqual(a, ['高等数学（A）', '理论']);
  const b = ParsingUtils.cleanName('实验课☆☆');
  assert.deepEqual(b, ['实验课', '实验'], '类别取第一个符号');
  const c = ParsingUtils.cleanName('体育,◆');
  assert.deepEqual(c, ['体育', '上机'], '尾部逗号被去掉');
});

test('parseGridDetail：3 段（周次/地点/教师）', () => {
  const f = ParsingUtils.parseGridDetail('1-8周/第一实验楼-A204大学物理实验-4/李安琪');
  assert.equal(f.weekMask, WeekMasks.parse('1-8'));
  assert.equal(f.location, '第一实验楼-A204大学物理实验-4');
  assert.equal(f.teacher, '李安琪');
});

test('parseGridDetail：7 段（多出的课程代码/班级/考核/学分被忽略，不污染教师）', () => {
  const detail =
    '1-16周/计算机基础实验室-3(505-506)/徐洪学/移动互联网技术-0003/' +
    '计算机科学与技术2401;计算机科学与技术2402/考查/学分:4.0';
  const f = ParsingUtils.parseGridDetail(detail);
  assert.equal(f.weekMask, WeekMasks.parse('1-16'));
  assert.equal(f.location, '计算机基础实验室-3(505-506)');
  assert.equal(f.teacher, '徐洪学', '旧实现会把教师写成"学分:4.0"');
});

test('parseGridDetail：首段不含"周"时整体前移（没有周次）', () => {
  const f = ParsingUtils.parseGridDetail('思源楼-301/张老师');
  assert.equal(f.weekMask, 0n);
  assert.equal(f.location, '思源楼-301');
  assert.equal(f.teacher, '张老师');
});

test('parseListDetail：折行打断的标签（"考核方"+"式:考试"）拼接后能认', () => {
  const f = ParsingUtils.parseListDetail('周数:1-16 地点:思源楼-301 教师:张老师 考核方式:考试');
  assert.equal(f.weekMask, WeekMasks.parse('1-16'));
  assert.equal(f.location, '思源楼-301');
  assert.equal(f.teacher, '张老师');
});

test('parseListDetail：字段标签顺序（教学班组成 不被 教学班 抢先匹配）', () => {
  const f = ParsingUtils.parseListDetail('周数:1-8 地点:知行楼-C207 教师:李老师 教学班组成:软件2401');
  assert.equal(f.location, '知行楼-C207');
  assert.equal(f.teacher, '李老师');
});

test('looksLikeTail：详情续行的六种特征', () => {
  assert.equal(GridFormatParser.looksLikeTail('智慧教室/杨英法'), true, '含斜杠');
  assert.equal(GridFormatParser.looksLikeTail('计算机科学与技术2401'), true, '含班级号');
  assert.equal(GridFormatParser.looksLikeTail('软件2401;软件2402'), true, '含分号');
  assert.equal(GridFormatParser.looksLikeTail('学分:4.0'), true, '含尾部关键字');
  assert.equal(GridFormatParser.looksLikeTail('琪'), true, '极短（教师名尾字）');
  assert.equal(GridFormatParser.looksLikeTail('智慧教室'), false, '普通地点名不算续行');
});

test('looksLikeTail：被折行截断的纯数值尾巴也算续行（真实课表实测）', () => {
  // 一格的信息块最后一行是 `…/总学时:16/学分`，学分值被折到下一行变成孤立的 `:1.0`
  assert.equal(GridFormatParser.looksLikeTail(':1.0'), true);
  assert.equal(GridFormatParser.looksLikeTail('分:4.0'), true);
  assert.equal(GridFormatParser.looksLikeTail('学分:3.0'), true);
  assert.equal(GridFormatParser.looksLikeTail(':80'), true);
  // 不能误伤正常短课名
  assert.equal(GridFormatParser.looksLikeTail('体育Ⅲ-网球'), false);
  assert.equal(GridFormatParser.looksLikeTail('美育教育'), false);
  assert.equal(GridFormatParser.looksLikeTail('3D打印'), false);
});

// ---------------------------------------------------------------- 网格式
test('网格式：单列单课，节次/周次/地点/教师/类别全部正确', () => {
  const runs: PdfTextRun[] = gridHeaders();
  runs.push(run('高等数学（A）★', 150, 150));
  runs.push(run('(3-4节)1-16周/思源楼-301/张老师', 150, 170));

  const r = GridFormatParser.parse(runs);
  assert.equal(r.courses.length, 1);
  const c = r.courses[0];
  assert.equal(c.name, '高等数学（A）');
  assert.equal(c.category, '理论');
  assert.equal(c.location, '思源楼-301');
  assert.equal(c.teacher, '张老师');
  assert.equal(c.schedules.length, 1);
  assert.equal(c.schedules[0].dayOfWeek, 2, '落在"星期二"列');
  assert.equal(c.schedules[0].startPeriod, 3);
  assert.equal(c.schedules[0].endPeriod, 4);
  assert.equal(c.schedules[0].weekMask, WeekMasks.parse('1-16'));
});

test('网格式：折成两行的课程名被拼回（类别符号在最后一行）', () => {
  const runs: PdfTextRun[] = gridHeaders();
  runs.push(run('数据结构', 150, 150));
  runs.push(run('（B）★', 150, 162));
  runs.push(run('(5-6节)2-16周/知行楼-C207/李老师', 150, 178));

  const r = GridFormatParser.parse(runs);
  assert.equal(r.courses.length, 1);
  assert.equal(r.courses[0].name, '数据结构（B）');
});

test('网格式：详情折行续行不被误当课程名（关键回归）', () => {
  const runs: PdfTextRun[] = gridHeaders();
  // 第一门课：详情里的**长地点名**折成两行。真实文件就是这样断的
  // （"第一实验楼-A204" + "大学物理实验-4/李安琪"），折行点落在字段边界上 ——
  // 续行是**无分隔拼接**的（与 Android 一致），所以折行点落在字段中间会把相邻字段粘在一起，
  // 真实样本里断点恰好都在 '/' 上，因此不构成问题。
  runs.push(run('大学物理★', 150, 150));
  runs.push(run('(1-2节)1-8周/第一实验楼-A204', 150, 166));
  runs.push(run('大学物理实验-4/李安琪', 150, 178));
  // 第二门课：紧跟其后
  runs.push(run('数据结构（B）★', 150, 194));
  runs.push(run('(3-4节)1-16周/思源楼-301/张老师', 150, 210));

  const r = GridFormatParser.parse(runs);
  assert.equal(r.courses.length, 2);
  assert.equal(r.courses[0].name, '大学物理', '续行不该污染第一门课的名字');
  assert.equal(r.courses[1].name, '数据结构（B）', '第二门课名不含续行内容');
  assert.equal(r.courses[0].location, '第一实验楼-A204大学物理实验-4', '地点取第 2 段');
  assert.equal(r.courses[0].teacher, '李安琪', '教师取第 3 段');
});

test('网格式：表头以上、图例、打印时间都被排除', () => {
  const runs: PdfTextRun[] = gridHeaders();
  runs.push(run('某某大学课程表', 150, 60)); // 表头以上
  runs.push(run('学号 2026001', 150, 80));
  runs.push(run('高等数学（A）★', 150, 150));
  runs.push(run('(3-4节)1-16周/思源楼-301/张老师', 150, 170));
  runs.push(run('★: 理论 ☆: 实验 ◆: 上机', 400, 900)); // 图例
  runs.push(run('打印时间: 2026-09-02 17:23', 400, 950));

  const r = GridFormatParser.parse(runs);
  assert.equal(r.courses.length, 1, '标题/学号/图例/打印时间都不是课');
  assert.equal(r.courses[0].name, '高等数学（A）');
});

test('网格式：多页时按 (页, y) 缝回被分页切断的单元格', () => {
  const runs: PdfTextRun[] = gridHeaders();
  runs.push(run('高等数学（A）★', 150, 900, 1)); // 第 1 页底部（名字）
  runs.push(run('(3-4节)1-16周/思源楼-301/张老师', 150, 110, 2)); // 第 2 页顶部（详情）

  const r = GridFormatParser.parse(runs);
  assert.equal(r.courses.length, 1);
  assert.equal(r.courses[0].name, '高等数学（A）');
  assert.equal(r.courses[0].teacher, '张老师');
});

test('网格式：表头不足 3 列时明确报错（而不是瞎解析）', () => {
  const runs: PdfTextRun[] = [run('星期一', 70, 100), run('星期二', 170, 100)];
  const r = GridFormatParser.parse(runs);
  assert.equal(r.courses.length, 0);
  assert.deepEqual(r.warnings, ['未找到星期表头']);
});

// ---------------------------------------------------------------- 列表式
function listFixture(): PdfTextRun[] {
  const runs: PdfTextRun[] = [];
  // 星期标签（竖跨合并单元格，y 取单元格中心）
  runs.push(run('星期四', 30, 400));
  runs.push(run('星期五', 30, 470));
  // 节次标签（居中于合并单元格）
  runs.push(run('5-6', 80, 405));
  runs.push(run('7-8', 80, 440));
  // 课程名（x 在节次列与详情列之间）
  runs.push(run('软件工程★', 150, 405));
  runs.push(run('操作系统★', 150, 445));
  // 详情（含周数/地点/教师）
  runs.push(run('周数:1-16 地点:思源楼-301 教师:张老师', 300, 405));
  runs.push(run('周数:1-8 地点:知行楼-C207 教师:李老师', 300, 447));
  return runs;
}

test('列表式：课程名/详情/星期/节次四者正确配对', () => {
  const r = ListFormatParser.parse(listFixture());
  assert.equal(r.courses.length, 2);
  const a = r.courses[0];
  assert.equal(a.name, '软件工程');
  assert.equal(a.category, '理论');
  assert.equal(a.location, '思源楼-301');
  assert.equal(a.teacher, '张老师');
  assert.equal(a.schedules[0].dayOfWeek, 4);
  assert.equal(a.schedules[0].startPeriod, 5);
  assert.equal(a.schedules[0].endPeriod, 6);
  assert.equal(a.schedules[0].weekMask, WeekMasks.parse('1-16'));

  const b = r.courses[1];
  assert.equal(b.name, '操作系统');
  assert.equal(b.schedules[0].startPeriod, 7);
  assert.equal(b.schedules[0].endPeriod, 8);
});

test('列表式：详情折行被无分隔拼接（标签被折断也能认）', () => {
  const runs: PdfTextRun[] = [];
  runs.push(run('星期四', 30, 400));
  runs.push(run('5-6', 80, 405));
  runs.push(run('软件工程★', 150, 405));
  runs.push(run('周数:1-16 地点:思源楼-301 教师:张老师 考核方', 300, 400));
  runs.push(run('式:考试', 300, 414)); // 折行打断了"考核方式"

  const r = ListFormatParser.parse(runs);
  assert.equal(r.courses.length, 1);
  assert.equal(r.courses[0].teacher, '张老师');
  assert.equal(r.courses[0].location, '思源楼-301');
});

test('列表式：没有"周数"行时明确报错', () => {
  const runs: PdfTextRun[] = [run('星期四', 30, 400), run('软件工程★', 150, 405)];
  const r = ListFormatParser.parse(runs);
  assert.equal(r.courses.length, 0);
  assert.deepEqual(r.warnings, ['未找到课程详情行（周数）']);
});

test('列表式：详情多于课程名时，未配对的详情被丢弃并给出警告', () => {
  const runs = listFixture();
  // 删掉第二个课程名
  const idx = runs.findIndex((r) => r.text === '操作系统★');
  runs.splice(idx, 1);

  const r = ListFormatParser.parse(runs);
  // 配对方向是"课程名 → 详情"，所以没有名字的详情块会被丢掉（Android 版行为一致），
  // 但必须留一条警告让用户知道少了一条 —— 静默丢课是不可接受的。
  assert.equal(r.courses.length, 1);
  assert.ok(r.warnings.some((w) => w.indexOf('没有匹配到课程名') >= 0), `${r.warnings}`);
});

// ---------------------------------------------------------------- 最小偏差连续分组
test('assignGroups：输出长度与输入一致，且分组连续（非递减）', () => {
  const centers = [100, 104, 108, 150, 200, 204];
  const labels = [102, 152, 202];
  const g = ListFormatParser.assignGroups(centers, labels);
  assert.equal(g.length, centers.length);
  for (let i = 0; i + 1 < g.length; i++) {
    assert.ok(g[i + 1] >= g[i], `必须连续分组：${g}`);
  }
  // 目标函数是"各组均值与标签的偏差之和最小"，所以结果可能"不均匀"：
  //   [0,0 | 1,1,1 | 2] → 均值 102 / 152.67 / 204 → 偏差 0 + 0.67 + 2 = 2.67
  //   [0,0,0 | 1 | 2,2] → 均值 104 / 150   / 202 → 偏差 2 + 2   + 0 = 4
  // 前者更优（DP 选它），这是**正确**行为，不是错分。
  assert.deepEqual(g, [0, 0, 1, 1, 1, 2]);
});

test('assignGroups：条目少于标签时退回"就近"', () => {
  const g = ListFormatParser.assignGroups([110], [100, 200, 300]);
  assert.deepEqual(g, [0]);
  const g2 = ListFormatParser.assignGroups([260], [100, 200, 300]);
  assert.deepEqual(g2, [2]);
});

test('assignGroups：空输入安全', () => {
  assert.deepEqual(ListFormatParser.assignGroups([], [1, 2]), []);
  assert.deepEqual(ListFormatParser.assignGroups([1, 2], []), [0, 0]);
});

test('assignGroups：合并单元格叠多门课时按连续分组，不会整组错分', () => {
  // 实测难点：周四 5-6 节叠 3 门课，其中心距周五标签更近（就近会错分）
  const centers = [400, 415, 430, 520];
  const labels = [412, 525];
  const g = ListFormatParser.assignGroups(centers, labels);
  assert.deepEqual(g, [0, 0, 0, 1], '前三门必须都归周四，即使第一门离周五更远/更近');
});

// ---------------------------------------------------------------- 真实课表的"学分折行"

test('cleanName：剥掉串进来的学分尾巴（真实课表 22 门里 7 门被污染过）', () => {
  assert.equal(ParsingUtils.cleanName(':1.0算法分析与设计')[0], '算法分析与设计');
  assert.equal(ParsingUtils.cleanName('分:4.0数字电子技术基础')[0], '数字电子技术基础');
  assert.equal(ParsingUtils.cleanName('学分:3.0大学物理Ⅱ（B）')[0], '大学物理Ⅱ（B）');
  // 正常课名不能被误伤：冒号后面不是数字的，一个字都不动
  assert.equal(ParsingUtils.cleanName('英语:听力')[0], '英语:听力');
  assert.equal(ParsingUtils.cleanName('体育Ⅲ-网球')[0], '体育Ⅲ-网球');
  assert.equal(ParsingUtils.cleanName('3D打印')[0], '3D打印');
  assert.equal(ParsingUtils.cleanName('C语言程序设计')[0], 'C语言程序设计');
});

test('网格式：学分值折到下一行（孤立 :1.0）不会变成下一门课的课名前缀', () => {
  const runs: PdfTextRun[] = gridHeaders();
  // 第一门课：详情块以 `…/学分` 结尾，学分值 `:1.0` 折到下一行
  runs.push(run('数字电子技术基础实验☆', 150, 150));
  runs.push(run('(1-2节)7-14周/第一实验楼-', 150, 164));
  runs.push(run('A302-303数字电子技术实验室-1/孙红霞', 150, 178));
  runs.push(run(';计科2510班/考查/无/实验:16/周学时:2/总学时:16/学分', 150, 192));
  runs.push(run(':1.0', 150, 206));
  // 第二门课
  runs.push(run('算法分析与设计★', 150, 220));
  runs.push(run('(3-4节)1-16周/思源楼-404/魏树森', 150, 234));

  const r = GridFormatParser.parse(runs);
  assert.equal(r.courses.length, 2, '不能因为一个 :1.0 就多出一门"课"');
  assert.equal(r.courses[0].name, '数字电子技术基础实验');
  assert.equal(r.courses[1].name, '算法分析与设计', '课名前不能带 :1.0');
  assert.equal(r.courses[1].schedules[0].startPeriod, 3);
  assert.equal(r.courses[1].schedules[0].endPeriod, 4);
});

test('网格式详情：第 4 段含「班」时当作教学班', () => {
  const f = ParsingUtils.parseGridDetail(
    '(1-2节)1-12周/思源楼-301/孙红霞/概率论与数理统计-0066/计科2509班;计科2510班/考试/无/理论:32'
  );
  assert.equal(f.location, '思源楼-301');
  assert.equal(f.teacher, '孙红霞');
  assert.equal(f.classGroup, '计科2509班;计科2510班');
});

test('网格式详情：3 段（没有班级）时 classGroup 为空', () => {
  const f = ParsingUtils.parseGridDetail('1-8周/第一实验楼-A204/李安琪');
  assert.equal(f.classGroup, '');
});

test('网格式详情：课程名那段不算教学班（第 4 段是「课名-课程代码」）', () => {
  const f = ParsingUtils.parseGridDetail('1-16周/教三-101/张老师/班主任工作实务-0101/考试');
  assert.equal(f.classGroup, '', '「班主任工作实务」以「务」结尾，不是班级');
  assert.equal(f.teacher, '张老师');
});

test('网格式详情：班级带括号等后缀时宁可不认（不猜）', () => {
  const f = ParsingUtils.parseGridDetail('1-16周/教三-101/张老师/计科2509班（实验）/考试');
  assert.equal(f.classGroup, '');
});

test('列表式详情：优先取「教学班组成」，其次「教学班」', () => {
  const a = ParsingUtils.parseListDetail('周数:1-16地点:教三-101教师:张老师教学班组成:计科2501班');
  assert.equal(a.classGroup, '计科2501班');
  const b = ParsingUtils.parseListDetail('周数:1-16地点:教三-101教师:张老师教学班:软件2502班');
  assert.equal(b.classGroup, '软件2502班');
});
