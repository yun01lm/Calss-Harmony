import { CellLayout, CellLines, Colors, Conflicts, GridSlot, Lane, Minutes, WeekCalculator } from '../logic';
import { type WeekItem } from '../logic';
import { TimeSlot } from '../data/models';

/**
 * 周视图网格（移植自 Android `ui/home/WeekGrid.kt`）。
 *
 * 几个**刻意保留**的 Android 结论（都是实测过的，别"优化"掉）：
 *
 * 1. **一次性组合全部格子**（7 × 数十格），不做懒加载：量小，而且绝对定位的色块跨越多行，
 *    懒加载反而要处理"块只画了一半"。
 * 2. **格子高度自适应**：整周一屏看完、不滚动；只有小屏/节次多时才降级为可滚。
 *    下限 64vp（小屏 56vp）—— 低于这个高度，长课名 3 行放不下，文字会糊成一团。
 * 3. **节次列 34vp**：手机 360vp 宽时每格 ~46vp，一行能放 3 个多汉字。格子太窄是"叠字"的真正根因。
 * 4. **重叠的课并排画**（各占一半宽），而不是叠在一起：叠着画时根本看不出是两门课。
 * 5. **文字行数先算再画**：`maxLines` 允许的行数可能超过格子高度，多出来的行照样绘制，
 *    于是压在教室那一行上（"叠字"的另一个根因）。行数由 `logic/CellLayout.ts` 统一算。
 */
@Component
export struct WeekGrid {
  /**
   * 注意这里用 `@Prop` 而不是普通成员：**普通成员只在子组件创建时赋值一次**，
   * 父组件重新渲染不会更新它 —— 第一版就是这样：首帧数据库还空着，网格拿到空数组，
   * 之后数据到了、状态也变了，网格却一直空着。`@Prop` 会在父组件更新时重新下发并触发子组件重绘。
   */
  @Prop slots: TimeSlot[] = [];
  @Prop periodCount: number = 12;
  @Prop items: WeekItem[] = [];
  /** 本周 7 天的 epochDay（周一→周日） */
  @Prop weekDates: number[] = [];
  @Prop todayEpochDay: number = 0;
  @Prop fontScale: number = 1;
  onCellTap: (dayOfWeek: number, period: number) => void = () => {};
  onItemTap: (item: WeekItem) => void = () => {};

  @State bodyWidth: number = 0;
  @State bodyHeight: number = 0;

  /** 节次列宽（见文件头注释 3） */
  private readonly gutterWidth: number = 34;
  /** 表头两行：周几 + 日期 */
  private readonly headerHeight: number = 40;

  build() {
    Column() {
      this.headerRow()
      Scroll() {
        Stack({ alignContent: Alignment.TopStart }) {
          this.cellsLayer()
          this.blocksLayer()
        }
        .width('100%')
        .height(this.gridHeight())
      }
      .layoutWeight(1)
      .scrollBar(BarState.Off)
      .width('100%')
      .onAreaChange((oldValue: Area, newValue: Area) => {
        const w: number = Number(newValue.width);
        const h: number = Number(newValue.height);
        if (w > 0 && Math.abs(w - this.bodyWidth) > 0.5) {
          this.bodyWidth = w;
        }
        if (h > 0 && Math.abs(h - this.bodyHeight) > 0.5) {
          this.bodyHeight = h;
        }
      })
    }
    .width('100%')
    .height('100%')
  }

  // ---------------------------------------------------------------- 表头

  @Builder
  headerRow() {
    Row() {
      // 节次列不需要表头
      Column().width(this.gutterWidth)
      ForEach(this.dayNumbers(), (day: number) => {
        Column({ space: 1 }) {
          Text(dayNameOf(day))
            .fontSize(11)
            .fontWeight(this.isToday(day) ? FontWeight.Bold : FontWeight.Medium)
            .fontColor(this.isToday(day) ? '#E07A5F' : '#7A6E66')
          Text(this.dateText(day))
            .fontSize(9)
            .fontColor(this.isToday(day) ? '#E07A5F' : '#A89C93')
        }
        .width(this.dayWidth())
        .height('100%')
        .justifyContent(FlexAlign.Center)
      }, (day: number) => 'h' + day)
    }
    .width('100%')
    .height(this.headerHeight)
  }

  // ---------------------------------------------------------------- 背景格

  @Builder
  cellsLayer() {
    Column() {
      ForEach(this.periodNumbers(), (period: number) => {
        Row() {
          this.gutterCell(period)
          ForEach(this.dayNumbers(), (day: number) => {
            Row()
              .width(this.dayWidth())
              .height(this.cellHeight())
              .backgroundColor(this.isCurrentWeekToday(day) ? '#FFF1EA' : Color.Transparent)
              .border({ width: 0.5, color: '#EFE3D8' })
              .onClick(() => {
                this.onCellTap(day, period);
              })
          }, (day: number) => 'c' + day + '-' + period)
        }
        .width('100%')
        .height(this.cellHeight())
      }, (period: number) => 'r' + period)
    }
    .width('100%')
  }

  @Builder
  gutterCell(period: number) {
    Column({ space: 1 }) {
      Text(`${period}`)
        .fontSize(10)
        .fontWeight(FontWeight.Bold)
        .fontColor('#7A6E66')
      if (CellLayout.showGutterTime(this.fontScale)) {
        Text(this.slotTimeText(period))
          .fontSize(7)
          .lineHeight(8)
          .textAlign(TextAlign.Center)
          .fontColor('#B3A79E')
      }
    }
    .width(this.gutterWidth)
    .height(this.cellHeight())
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }

  // ---------------------------------------------------------------- 色块

  @Builder
  blocksLayer() {
    ForEach(this.items, (item: WeekItem, index: number) => {
      this.blockView(item, index)
    }, (item: WeekItem, index: number) =>
      `${item.kind}-${item.id}-${item.dayOfWeek}-${item.startPeriod}-${item.endPeriod}-${index}`)
  }

  @Builder
  blockView(item: WeekItem, index: number) {
    Row() {
      // 左侧色条：一眼分辨课程
      Column()
        .width(this.laneCountAt(index) > 1 ? 2.5 : 3)
        .height('100%')
        .backgroundColor(item.color)
      Column({ space: 0 }) {
        Text(item.title)
          .fontSize(this.cellLinesAt(index).nameFontSize)
          .lineHeight(this.cellLinesAt(index).lineHeight)
          .fontWeight(FontWeight.Medium)
          .fontColor('#3B3430')
          .maxLines(this.cellLinesAt(index).nameLines)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
          .textAlign(TextAlign.Start)
        if (this.showSubtitleAt(index)) {
          Text((item.conflicts.length > 0 ? '⚠ ' : '') + item.subtitle)
            .fontSize(9)
            .lineHeight(11)
            .fontColor(item.conflicts.length > 0 ? '#C62828' : '#7A6E66')
            .maxLines(this.cellLinesAt(index).locationLines)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
            .textAlign(TextAlign.Start)
        } else if (item.conflicts.length > 0) {
          Text('⚠')
            .fontSize(9)
            .fontColor('#C62828')
        }
      }
      .layoutWeight(1)
      .padding({ left: 4, right: 3, top: 2, bottom: 2 })
      .alignItems(HorizontalAlign.Start)
    }
    .width(this.blockWidthAt(index))
    .height(this.blockHeightAt(index))
    .position({ x: this.blockXAt(index), y: this.blockYAt(index) })
    .backgroundColor(Colors.withAlpha(item.color, 0.16))
    .border({
      width: item.conflicts.length > 0 ? 1 : 0.5,
      color: item.conflicts.length > 0 ? '#C62828' : Colors.withAlpha(item.color, 0.45),
    })
    .borderRadius(4)
    .clip(true)
    .onClick(() => {
      this.onItemTap(item);
    })
  }

  // ---------------------------------------------------------------- 布局计算

  private dayWidth(): number {
    if (this.bodyWidth <= 0) {
      return 0;
    }
    return (this.bodyWidth - this.gutterWidth) / 7;
  }

  /** 格子高度：够就整周一屏看完，不够则用下限并允许滚动 */
  private cellHeight(): number {
    const minCell: number = this.bodyHeight > 0 && this.bodyHeight < CellLayout.SMALL_SCREEN_MAX_HEIGHT
      ? CellLayout.MIN_CELL_HEIGHT_SMALL_SCREEN
      : CellLayout.MIN_CELL_HEIGHT;
    const fit: number = this.bodyHeight > 0 ? this.bodyHeight / this.periodCount : 0;
    return Math.max(minCell, fit);
  }

  private gridHeight(): number {
    return this.cellHeight() * this.periodCount;
  }

  private lanes(): Lane[] {
    return Conflicts.lanesFor(this.gridSlots());
  }

  private gridSlots(): GridSlot[] {
    const out: GridSlot[] = [];
    for (const item of this.items) {
      const slot: GridSlot = {
        dayOfWeek: item.dayOfWeek,
        startPeriod: item.startPeriod,
        endPeriod: item.endPeriod,
        title: item.title,
      };
      out.push(slot);
    }
    return out;
  }

  private laneAt(index: number): Lane {
    const lanes: Lane[] = this.lanes();
    return index >= 0 && index < lanes.length ? lanes[index] : { lane: 0, laneCount: 1 };
  }

  private laneCountAt(index: number): number {
    return this.laneAt(index).laneCount;
  }

  private blockWidthAt(index: number): number {
    const count: number = this.laneCountAt(index);
    const laneW: number = count > 1 ? (this.dayWidth() - 3) / count : this.dayWidth() - 3;
    return count > 1 ? laneW - 0.5 : laneW;
  }

  private blockXAt(index: number): number {
    const item: WeekItem = this.items[index];
    const count: number = this.laneCountAt(index);
    const lane: number = this.laneAt(index).lane;
    const laneW: number = count > 1 ? (this.dayWidth() - 3) / count : this.dayWidth() - 3;
    return this.gutterWidth + this.dayWidth() * (item.dayOfWeek - 1) + laneW * lane + 1.5;
  }

  private blockYAt(index: number): number {
    const item: WeekItem = this.items[index];
    return this.cellHeight() * (item.startPeriod - 1) + 1.5;
  }

  private blockHeightAt(index: number): number {
    const item: WeekItem = this.items[index];
    return this.cellHeight() * (item.endPeriod - item.startPeriod + 1) - 3;
  }

  private cellLinesAt(index: number): CellLines {
    return CellLayout.cellLines(this.blockHeightAt(index), this.fontScale);
  }

  private showSubtitleAt(index: number): boolean {
    const item: WeekItem = this.items[index];
    return item.subtitle.length > 0 && this.cellLinesAt(index).locationLines > 0;
  }

  // ---------------------------------------------------------------- 小工具

  private periodNumbers(): number[] {
    const out: number[] = [];
    for (let p = 1; p <= this.periodCount; p++) {
      out.push(p);
    }
    return out;
  }

  private dayNumbers(): number[] {
    return [1, 2, 3, 4, 5, 6, 7];
  }

  private dateOf(day: number): number {
    return day - 1 < this.weekDates.length ? this.weekDates[day - 1] : 0;
  }

  private dateText(day: number): string {
    const epochDay: number = this.dateOf(day);
    if (epochDay === 0) {
      return '';
    }
    const ymd = WeekCalculator.dateOf(epochDay);
    return `${ymd.month}/${ymd.day}`;
  }

  private isToday(day: number): boolean {
    const epochDay: number = this.dateOf(day);
    return epochDay !== 0 && epochDay === this.todayEpochDay;
  }

  /** 只有"今天"所在的那一周才高亮：翻看其他周时不该亮 */
  private isCurrentWeekToday(day: number): boolean {
    return this.isToday(day);
  }

  private slotTimeText(period: number): string {
    for (const s of this.slots) {
      if (s.periodIndex === period) {
        return `${Minutes.format(s.startMinute)}\n${Minutes.format(s.endMinute)}`;
      }
    }
    return '';
  }
}

/** 1 = 周一 … 7 = 周日（与 Android `dayName` 一致） */
function dayNameOf(dayOfWeek: number): string {
  const names: string[] = ['一', '二', '三', '四', '五', '六', '日'];
  if (dayOfWeek < 1 || dayOfWeek > 7) {
    return '周?';
  }
  return '周' + names[dayOfWeek - 1];
}
