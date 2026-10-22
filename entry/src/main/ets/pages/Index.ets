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

/**
 * 主页占位（阶段 0 骨架）。
 *
 * 它现在同时是**逻辑层的编译守卫**：每段文字都调用 `logic/` 里的真实模块，
 * 因此每次构建都会真正编译这些模块（而不是让它们当"没被引用的死代码"）。
 * 后续替换为周视图（WeekGrid + Swiper 翻周），见 docs/ARCHITECTURE.md。
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

  build() {
    Column({ space: 8 }) {
      Text('简课表')
        .fontSize(30)
        .fontWeight(FontWeight.Bold)
        .fontColor('#3B3430')

      Text('鸿蒙版 · 逻辑层已就位')
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

      Button('测试交互：+1 周')
        .margin({ top: 14 })
        .backgroundColor('#E07A5F')
        .onClick(() => {
          this.weekNo = this.weekNo + 1;
        })

      Text('下一步：数据层（relationalStore）→ 周视图 → 导入流程')
        .fontSize(12)
        .fontColor('#7A6E66')
        .margin({ top: 26 })
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor('#FFF9F4')
  }

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

  /** 数据层：默认作息条数 + 启动选表规则（真实 SQL 在 tests/sql.test.ts 里用 SQLite 验过） */
  private dataText(): string {
    const options: TimetableChoice[] = [
      { id: 1, isPrimary: true, createdAt: 100 },
      { id: 2, isPrimary: false, createdAt: 200 },
    ];
    const picked = pickStartupTimetable(options, 2, false);
    return `数据层 ${defaultSlots().length} 节默认作息 · 启动打开第 ${picked} 张（上次用的那张）`;
  }
}
