import {
  CellLayout,
  Conflicts,
  GridSlot,
  Locations,
  TimetableTextParser,
  WeekCalculator,
  WeekMasks,
} from '../logic';

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
   * （第一版就出过"第 5 周的周一早于开学日"这种自相矛盾的显示）。
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
        .margin({ top: 24 })

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

      Button('测试交互：+1 周')
        .margin({ top: 14 })
        .backgroundColor('#E07A5F')
        .onClick(() => {
          this.weekNo = this.weekNo + 1;
        })

      Text('下一步：周视图网格 → 作息/课表解析 → 数据层')
        .fontSize(12)
        .fontColor('#7A6E66')
        .margin({ top: 28 })
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
    return `第 ${this.weekNo} 周的周一 ${WeekCalculator.isoDate(monday)} · 开学（第 1 周周一）${start}`;
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

  /** 作息表文本解析：用三行"粘贴文本"形态的样例现场跑一遍（真实样本的断言在 tests/ 里） */
  private timetableText(): string {
    const sample = '上午 1 8: 00-8: 45\n课间 8: 45-8: 50\n上午 2 8: 50-9: 35';
    const parsed = TimetableTextParser.parse(TimetableTextParser.linesFromText(sample));
    const first = parsed.periods[0];
    return `作息解析 ${parsed.periods.length} 节 · 第 1 节 ${first.startMinute / 60} 点起`;
  }
}
