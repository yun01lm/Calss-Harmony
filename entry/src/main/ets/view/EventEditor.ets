import { CourseDraft, EventDraft } from '../logic';
import { type EventDraftInput, type EventDraftResult } from '../logic';

/**
 * 自定义安排编辑面板（新建 / 编辑共用）。
 *
 * 与 `CourseEditor` 同一套骨架（顶栏放保存、草稿在面板关掉时一起消失），
 * 但只有**一段**时间、没有教师/教室 —— 那些是课程字段（见 `logic/EventDraft.ts` 文件头）。
 *
 * 规则全在 `logic/EventDraft.ts`（Node 侧有断言）；这里只做：
 * 收集输入 → 调 `EventDraft.check` → 成功就 `onSubmit(result)`，
 * 失败就把纠正后的值回填进输入框、把出错的那一格描红。
 */
@Component
export struct EventEditor {
  @Prop periodCount: number = 12;
  @Prop heading: string = '添加安排';
  @Prop initialTitle: string = '';
  @Prop initialNote: string = '';
  @Prop initialDay: number = 1;
  @Prop initialStart: number = 1;
  @Prop initialEnd: number = 2;
  @Prop initialWeeks: string = '1-16';
  /** 编辑已有安排时才有"删除该安排" */
  @Prop canDelete: boolean = false;

  onSubmit: (result: EventDraftResult) => void = () => {};
  onDelete: () => void = () => {};
  onCancel: () => void = () => {};

  // 不能用 `title` / `note` 当成员名：容易和 ArkUI 的属性名看混，读代码时误以为是组件属性
  @State titleText: string = '';
  @State noteText: string = '';
  @State day: number = 1;
  @State start: number = 1;
  @State end: number = 2;
  @State weeksText: string = '';
  @State error: string = '';
  /** `EventDraft.BAD_TITLE` / `BAD_WEEKS` / `''`（标红哪一格） */
  @State badField: string = '';
  /** 删除要按两次：第一次变成"再按一次删除"，避免误触把一条安排删掉 */
  @State deleteArmed: boolean = false;

  aboutToAppear(): void {
    this.titleText = this.initialTitle;
    this.noteText = this.initialNote;
    this.day = this.initialDay;
    this.start = this.initialStart;
    this.end = this.initialEnd;
    this.weeksText = this.initialWeeks;
  }

  build() {
    Column() {
      this.headerRow()

      Scroll() {
        Column({ space: 10 }) {
          TextInput({ text: this.titleText, placeholder: '标题（如：健身 / 自习）' })
            .fontSize(15)
            .height(42)
            .width('100%')
            .backgroundColor('#F6EFE8')
            .borderWidth(this.badField === EventDraft.BAD_TITLE ? 1 : 0)
            .borderColor('#C62828')
            .onChange((v: string) => {
              this.titleText = v;
            })

          TextInput({ text: this.noteText, placeholder: '备注（可不填）' })
            .fontSize(13)
            .height(38)
            .width('100%')
            .backgroundColor('#F6EFE8')
            .onChange((v: string) => {
              this.noteText = v;
            })

          this.timeRow()

          TextInput({ text: this.weeksText, placeholder: '周次，如 1-20 或 1-15单' })
            .fontSize(12)
            .height(36)
            .width('100%')
            .backgroundColor('#F6EFE8')
            .borderWidth(this.badField === EventDraft.BAD_WEEKS ? 1 : 0)
            .borderColor('#C62828')
            .onChange((v: string) => {
              this.weeksText = v;
            })

          Text('周次默认是整学期。' + EventDraft.WEEK_HINT)
            .fontSize(10)
            .fontColor('#B3A79E')
            .width('100%')

          if (this.error.length > 0) {
            Text(this.error)
              .fontSize(11)
              .fontColor('#C62828')
              .width('100%')
          }

          if (this.canDelete) {
            Text(this.deleteArmed ? '再按一次删除这条安排' : '删除该安排')
              .fontSize(12)
              .fontColor(this.deleteArmed ? '#FFFFFF' : '#C62828')
              .backgroundColor(this.deleteArmed ? '#C62828' : '#FFFFFF')
              .borderRadius(8)
              .borderWidth(1)
              .borderColor('#F0C4C4')
              .textAlign(TextAlign.Center)
              .width('100%')
              .height(36)
              .padding({ top: 9 })
              .onClick(() => {
                if (!this.deleteArmed) {
                  this.deleteArmed = true;
                  return;
                }
                this.onDelete();
              })
          }
        }
        .width('100%')
        .padding({ bottom: 8 })
        .alignItems(HorizontalAlign.Start)
      }
      .layoutWeight(1)
      .width('100%')
      .scrollBar(BarState.Off)
      .align(Alignment.Top)
    }
    .width('100%')
    .height('58%')
    .padding(16)
    .backgroundColor('#FFFFFF')
    .borderRadius({ topLeft: 16, topRight: 16 })
    .shadow({ radius: 12, color: '#1A000000', offsetY: -2 })
  }

  @Builder
  headerRow() {
    Row() {
      Text(this.heading)
        .fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor('#3B3430')
        .layoutWeight(1)
      Text('取消')
        .fontSize(13)
        .fontColor('#7A6E66')
        .onClick(() => {
          this.onCancel();
        })
      // 保存放在顶栏（与课程面板一致）：软键盘弹出会盖住底部，
      // 而"输完标题想立刻保存"正是那一刻
      Text('保存')
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor('#E07A5F')
        .margin({ left: 16 })
        .onClick(() => {
          this.submit();
        })
    }
    .width('100%')
    .height(28)
  }

  /** 星期 / 起节 ~ 止节 */
  @Builder
  timeRow() {
    Row({ space: 4 }) {
      Select(this.dayOptions())
        .selected(this.day - 1)
        .value(CourseDraft.dayName(this.day))
        .font({ size: 12 })
        .height(30)
        .onSelect((i: number) => {
          this.day = i + 1;
        })
      Select(this.periodOptions())
        .selected(this.start - 1)
        .value('第 ' + this.start + ' 节')
        .font({ size: 12 })
        .height(30)
        .onSelect((i: number) => {
          this.start = i + 1;
        })
      Text('~')
        .fontSize(12)
        .fontColor('#7A6E66')
      Select(this.periodOptions())
        .selected(this.end - 1)
        .value('第 ' + this.end + ' 节')
        .font({ size: 12 })
        .height(30)
        .onSelect((i: number) => {
          this.end = i + 1;
        })
      Blank()
    }
    .width('100%')
  }

  // ---------------------------------------------------------------- 状态

  private dayOptions(): SelectOption[] {
    const out: SelectOption[] = [];
    for (let d = 1; d <= CourseDraft.MAX_DAY; d++) {
      out.push({ value: CourseDraft.dayName(d) });
    }
    return out;
  }

  private periodOptions(): SelectOption[] {
    const count: number = this.periodCount < 1 ? 1 : this.periodCount;
    const out: SelectOption[] = [];
    for (let p = 1; p <= count; p++) {
      out.push({ value: '第 ' + p + ' 节' });
    }
    return out;
  }

  private submit(): void {
    const input: EventDraftInput = EventDraft.input(
      this.titleText, this.noteText, this.day, this.start, this.end, this.weeksText
    );
    const result: EventDraftResult = EventDraft.check(input, this.periodCount);
    // 无论成败都回填：用户能直接看见「1~8周」被改成了「1-8」
    this.titleText = result.title;
    this.noteText = result.note;
    this.day = result.day;
    this.start = result.start;
    this.end = result.end;
    this.weeksText = result.weeks;
    if (result.error.length > 0) {
      this.error = result.error;
      this.badField = result.badField;
      return;
    }
    this.error = '';
    this.badField = EventDraft.BAD_NONE;
    this.onSubmit(result);
  }
}
