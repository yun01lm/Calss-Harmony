import { common } from '@kit.AbilityKit';
import {
  CellLayout,
  Conflicts,
  GridSlot,
  ListFormatParser,
  Locations,
  PdfTextRun,
  TimetableTextParser,
  WeekCalculator,
  WeekMasks,
} from '../logic';
import { defaultSlots } from '../data/schema';
import { pickStartupTimetable, TimetableChoice } from '../data/startupRule';
import { Rdb } from '../platform/Rdb';
import { MigrationProbe, ProbeLine } from '../platform/MigrationProbe';

/**
 * 主页占位（阶段 1）。
 *
 * 它现在同时是**三层的联调面板**：
 * 1. 逻辑层：每段文字都调用 `logic/` 里的真实模块（避免模块没被引用、坏了没人发现）；
 * 2. 数据层：`data/` 的 schema / 迁移 / 启动规则；
 * 3. 平台层：真的打开 `relationalStore`、真的写库、真的关掉重开。
 *
 * 阶段 2 会整页替换为周视图（WeekGrid + Swiper），届时本页与 `platform/MigrationProbe.ts` 一起删除。
 */
@Entry
@Component
struct Index {
  /**
   * 唯一基准：本学期的"第 1 周周一"。
   * 周次、每周的周一、日期范围**全部从它推导** —— 避免多个独立基准互相矛盾
   * （第一版出过"第 5 周的周一早于开学日"这种自相矛盾的显示）。
   */
  private readonly semesterStart: number = WeekCalculator.startDateForWeek(
    1,
    WeekCalculator.todayEpochDay()
  );

  /** 打开即当前周：由学期起始日 + 今天算出，不硬编码 */
  @State weekNo: number = WeekCalculator.currentWeek(
    WeekCalculator.startDateForWeek(1, WeekCalculator.todayEpochDay()),
    WeekCalculator.todayEpochDay()
  );

  /** 平台层实况（真的从库里查出来的数字，不是常量） */
  @State dbLine: string = '数据库：打开中…';

  @State probeLines: ProbeLine[] = [];
  @State probing: boolean = false;

  aboutToAppear(): void {
    this.refreshDb();
  }

  build() {
    Scroll() {
      Column({ space: 8 }) {
        Text('简课表')
          .fontSize(30)
          .fontWeight(FontWeight.Bold)
          .fontColor('#3B3430')

        Text('鸿蒙版 · 数据层已接 relationalStore')
          .fontSize(14)
          .fontColor('#7A6E66')

        Text(`第 ${this.weekNo} 周`)
          .fontSize(22)
          .fontWeight(FontWeight.Medium)
          .fontColor('#E07A5F')
          .margin({ top: 20 })

        Text(this.weekRangeText())
          .fontSize(12)
          .fontColor('#7A6E66')

        Text(this.maskText())
          .fontSize(12)
          .fontColor('#7A6E66')

        Text(this.locationText())
          .fontSize(12)
          .fontColor('#7A6E66')

        Text(this.conflictText())
          .fontSize(12)
          .fontColor('#7A6E66')

        Text(this.cellText())
          .fontSize(12)
          .fontColor('#7A6E66')

        Text(this.timetableText())
          .fontSize(12)
          .fontColor('#7A6E66')

        Text(this.pdfText())
          .fontSize(12)
          .fontColor('#7A6E66')

        Text(this.dataText())
          .fontSize(12)
          .fontColor('#7A6E66')

        Divider().margin({ top: 10, bottom: 6 })

        Text(this.dbLine)
          .fontSize(12)
          .fontColor('#2E7D32')
          .width('100%')

        Button('写入 1 门测试课（验证真持久化）')
          .fontSize(13)
          .width('100%')
          .margin({ top: 6 })
          .backgroundColor('#E07A5F')
          .onClick(() => {
            this.writeSampleCourse();
          })

        Button('清空测试课')
          .fontSize(13)
          .width('100%')
          .backgroundColor('#BDB3AB')
          .onClick(() => {
            this.clearSampleCourse();
          })

        Button(this.probing ? '迁移演练进行中…' : '数据层自检（迁移演练）')
          .fontSize(13)
          .width('100%')
          .margin({ top: 6 })
          .backgroundColor('#5B7C99')
          .enabled(!this.probing)
          .onClick(() => {
            this.runProbe();
          })

        if (this.probeLines.length > 0) {
          Column({ space: 6 }) {
            ForEach(this.probeLines, (line: ProbeLine) => {
              Row({ space: 6 }) {
                Text(line.ok ? '✓' : '✗')
                  .fontSize(14)
                  .fontColor(line.ok ? '#2E7D32' : '#C62828')
                Column({ space: 2 }) {
                  Text(line.label)
                    .fontSize(12)
                    .fontColor('#3B3430')
                  Text(line.detail)
                    .fontSize(10)
                    .fontColor('#9A8F87')
                }
                .alignItems(HorizontalAlign.Start)
                .layoutWeight(1)
              }
              .width('100%')
              .alignItems(VerticalAlign.Top)
            }, (line: ProbeLine) => line.label + '|' + line.detail)
          }
          .width('100%')
          .padding(8)
          .backgroundColor('#FFFFFF')
          .borderRadius(8)
        }

        Button('测试交互：+1 周')
          .margin({ top: 14 })
          .backgroundColor('#E07A5F')
          .onClick(() => {
            this.weekNo = this.weekNo + 1;
          })

        Text('下一步：ScheduleStore（业务语义层）→ 周视图 → 导入流程')
          .fontSize(12)
          .fontColor('#7A6E66')
          .margin({ top: 26, bottom: 24 })
      }
      .width('100%')
      .padding(16)
    }
    .width('100%')
    .height('100%')
    .align(Alignment.Top)
    .backgroundColor('#FFF9F4')
  }

  // ---------------------------------------------------------------- 平台层

  /** 打开真实数据库并查回真实数字（含建库/迁移结果） */
  private async refreshDb(): Promise<void> {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      this.dbLine = '数据库：拿不到 Context';
      return;
    }
    try {
      const db: Rdb = await Rdb.open(ctx);
      const before: number = db.version;
      const outcome = await db.ensureUpToDate(
        Date.now(),
        WeekCalculator.mondayOfEpochDay(WeekCalculator.todayEpochDay())
      );
      const timetables: number = await db.scalarInt('SELECT COUNT(*) FROM timetables');
      const slots: number = await db.scalarInt('SELECT COUNT(*) FROM time_slots WHERE timetableId = 1');
      const courses: number = await db.scalarInt('SELECT COUNT(*) FROM courses');
      this.dbLine = `数据库 v${outcome.version} · ${outcome.kind}（打开时 v${before}，执行 ${outcome.stepCount} 步）` +
        ` · ${timetables} 张课表 · ${slots} 节作息 · ${courses} 门课`;
    } catch (e) {
      const err = e as Error;
      this.dbLine = '数据库失败：' + err.message;
    }
  }

  /** 往**正式的** calss.db 里写一门课，用来验证"杀进程重启后数据还在" */
  private async writeSampleCourse(): Promise<void> {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return;
    }
    try {
      const db: Rdb = await Rdb.open(ctx);
      await db.ensureUpToDate(
        Date.now(),
        WeekCalculator.mondayOfEpochDay(WeekCalculator.todayEpochDay())
      );
      await db.exec(
        'INSERT INTO courses (timetableId, name, teacher, location, color, category, note) ' +
          'VALUES (1, ?, ?, ?, 0, ?, ?)',
        ['持久化测试', '自检', '思源楼-101', '', '']
      );
      // 用自然键取回 id：不依赖 last_insert_rowid() 一定落在同一条连接上
      const rows = await db.query(
        "SELECT id FROM courses WHERE name = ? ORDER BY id DESC LIMIT 1",
        ['持久化测试']
      );
      if (rows.length === 1) {
        await db.exec(
          'INSERT INTO course_schedules (courseId, dayOfWeek, startPeriod, endPeriod, weekMask) ' +
            'VALUES (?, 3, 5, 6, ?)',
          [rows[0].int('id'), 65535]
        );
      }
      await this.refreshDb();
    } catch (e) {
      const err = e as Error;
      this.dbLine = '写入失败：' + err.message;
    }
  }

  private async clearSampleCourse(): Promise<void> {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return;
    }
    try {
      const db: Rdb = await Rdb.open(ctx);
      await db.exec(
        'DELETE FROM course_schedules WHERE courseId IN ' +
          '(SELECT id FROM courses WHERE name = ?)',
        ['持久化测试']
      );
      await db.exec('DELETE FROM courses WHERE name = ?', ['持久化测试']);
      await this.refreshDb();
    } catch (e) {
      const err = e as Error;
      this.dbLine = '清空失败：' + err.message;
    }
  }

  private async runProbe(): Promise<void> {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return;
    }
    this.probing = true;
    this.probeLines = [];
    try {
      this.probeLines = await MigrationProbe.run(ctx);
    } catch (e) {
      const err = e as Error;
      const line: ProbeLine = { label: '演练中断', ok: false, detail: err.message };
      this.probeLines = [line];
    }
    this.probing = false;
  }

  // ---------------------------------------------------------------- 逻辑层

  private weekRangeText(): string {
    // 第 N 周的周一 = 开学日 + (N-1) 周 —— 与 Android 版 WeekGrid 的算法完全一致
    const monday = this.semesterStart + (this.weekNo - 1) * WeekCalculator.DAYS_PER_WEEK;
    const start = WeekCalculator.isoDate(this.semesterStart);
    return `第 ${this.weekNo} 周的周一 ${WeekCalculator.isoDate(monday)} · 开学 ${start}`;
  }

  private maskText(): string {
    const mask = WeekMasks.parse('1-15周(单)');
    return `单双周 "1-15周(单)" → ${WeekMasks.format(mask)}`;
  }

  private locationText(): string {
    return `教室 ${Locations.shortLocation('本部-计算机基础实验室-2(503-504)')}`;
  }

  private conflictText(): string {
    const items: GridSlot[] = [
      { dayOfWeek: 1, startPeriod: 3, endPeriod: 4, title: '软件工程' },
      { dayOfWeek: 1, startPeriod: 3, endPeriod: 4, title: '操作系统' },
    ];
    const marks = Conflicts.markConflicts(items);
    const lanes = Conflicts.lanesFor(items);
    return `重叠两门 → 冲突《${marks[0].conflicts[0]}》· 并排 ${lanes[0].laneCount} 道`;
  }

  private cellText(): string {
    const r = CellLayout.cellLines(64, 1.0);
    return `64vp/1.0× 格子 → 课名 ${r.nameLines} 行 + 教室 ${r.locationLines} 行`;
  }

  /** 作息表文本解析：用"粘贴文本"形态的样例现场跑一遍（真实样本断言在 tests/ 里） */
  private timetableText(): string {
    const sample = '上午 1 8: 00-8: 45\n课间 8: 45-8: 50\n上午 2 8: 50-9: 35';
    const parsed = TimetableTextParser.parse(TimetableTextParser.linesFromText(sample));
    if (parsed.periods.length === 0) {
      return '作息解析：未识别';
    }
    const first = parsed.periods[0];
    return `作息解析 ${parsed.periods.length} 节 · 第 1 节 ${first.startMinute / 60} 点起`;
  }

  /** PDF 行解析：用一段**合成**的列表式数据现场跑一遍（真实夹具含姓名，不进仓库） */
  private pdfText(): string {
    const runs: PdfTextRun[] = [
      { text: '星期四', x: 30, y: 400, endX: 60, fontSize: 10, page: 1 },
      { text: '5-6', x: 80, y: 405, endX: 110, fontSize: 10, page: 1 },
      { text: '软件工程★', x: 150, y: 405, endX: 210, fontSize: 10, page: 1 },
      {
        text: '周数:1-16 地点:思源楼-301 教师:张老师',
        x: 300,
        y: 405,
        endX: 360,
        fontSize: 10,
        page: 1,
      },
    ];
    const parsed = ListFormatParser.parse(runs);
    if (parsed.courses.length === 0) {
      return 'PDF 解析：未识别';
    }
    const course = parsed.courses[0];
    const slot = course.schedules[0];
    return `PDF 解析 ${parsed.courses.length} 门 · ${course.name} 周${slot.dayOfWeek} ${slot.startPeriod}-${slot.endPeriod} 节`;
  }

  /** 数据层：默认作息条数 + 启动选表规则（真实 SQL 在 tests/ 里用 SQLite 验过） */
  private dataText(): string {
    const options: TimetableChoice[] = [
      { id: 1, isPrimary: true, createdAt: 100 },
      { id: 2, isPrimary: false, createdAt: 200 },
    ];
    const picked = pickStartupTimetable(options, 2, false);
    return `数据层 ${defaultSlots().length} 节默认作息 · 启动打开第 ${picked} 张（上次用的那张）`;
  }
}
