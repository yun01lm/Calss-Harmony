import { CourseDraft } from '../logic';
import { type CourseDraftPayload, type DraftRow, type DraftResult } from '../logic';

/**
 * 课程编辑面板（新建 / 编辑共用）。
 *
 * 分成独立 `@Component` 而不是塞进 `Index.ets`：页面已经 2000 行，
 * 而这块的**草稿状态**（课程名、若干行时段、报错文案）本来就该自成一格 ——
 * 父组件只关心"保存了什么 / 取消了"两件事，草稿在面板关掉时一起消失。
 *
 * 规则全在 `logic/CourseDraft.ts`（Node 侧有断言）；这里只做：
 * 收集输入 → 调 `CourseDraft.check` → 成功就 `onSubmit(payload)`，
 * 失败就把纠正后的行回填进输入框并显示那一句错误。
 */
@Component
export struct CourseEditor {
  @Prop periodCount: number = 12;
  @Prop editorTitle: string = '添加课程';
  @Prop initialName: string = '';
  @Prop initialTeacher: string = '';
  @Prop initialLocation: string = '';
  @Prop initialRows: DraftRow[] = [];
  /** 编辑已有课程时才有"删除该课程" */
  @Prop canDelete: boolean = false;

  onSubmit: (payload: CourseDraftPayload) => void = () => {};
  onDelete: () => void = () => {};
  onCancel: () => void = () => {};

  @State name: string = '';
  @State teacher: string = '';
  @State location: string = '';
  @State rows: DraftRow[] = [];
  @State error: string = '';
  /** 删除要按两次：第一次变成"再按一次删除"，避免误触把一门课删掉 */
  @State deleteArmed: boolean = false;

  aboutToAppear(): void {
    this.name = this.initialName;
    this.teacher = this.initialTeacher;
    this.location = this.initialLocation;
    this.rows = this.initialRows.length > 0 ? this.initialRows.slice() : [];
  }

  build() {
    Column() {
      this.headerRow()

      Scroll() {
        Column({ space: 10 }) {
          this.nameField()

          Row({ space: 8 }) {
            TextInput({ text: this.teacher, placeholder: '教师（可不填）' })
              .fontSize(13)
              .height(38)
              .layoutWeight(1)
              .backgroundColor('#F6EFE8')
              .onChange((v: string) => {
                this.teacher = v;
              })
            TextInput({ text: this.location, placeholder: '地点（可不填）' })
              .fontSize(13)
              .height(38)
              .layoutWeight(1)
              .backgroundColor('#F6EFE8')
              .onChange((v: string) => {
                this.location = v;
              })
          }
          .width('100%')

          Row() {
            Text('上课时间')
              .fontSize(12)
              .fontWeight(FontWeight.Medium)
              .fontColor('#3B3430')
              .layoutWeight(1)
            Text('例：1-16、2,4,6-8、1-15单')
              .fontSize(10)
              .fontColor('#B3A79E')
          }
          .width('100%')

          ForEach(this.rows, (row: DraftRow, index: number) => {
            this.rowEditor(row, index)
          }, (row: DraftRow, index: number) => 'row' + index)

          Text('+ 添加一个上课时段')
            .fontSize(12)
            .fontColor('#5B7C99')
            .width('100%')
            .onClick(() => {
              this.addRow();
            })

          if (this.error.length > 0) {
            Text(this.error)
              .fontSize(11)
              .fontColor('#C62828')
              .width('100%')
          }

          if (this.canDelete) {
            Text(this.deleteArmed ? '再按一次删除这门课' : '删除该课程')
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
    .height('76%')
    .padding(16)
    .backgroundColor('#FFFFFF')
    .borderRadius({ topLeft: 16, topRight: 16 })
    .shadow({ radius: 12, color: '#1A000000', offsetY: -2 })
  }

  @Builder
  headerRow() {
    Row() {
      Text(this.editorTitle)
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
      // 保存放在顶栏（而不是底部大按钮）：软键盘弹出会盖住底部，
      // 那一刻正是"输完课程名想立刻保存"的时候 —— 实测模拟器上差点点不到
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

  @Builder
  nameField() {
    TextInput({ text: this.name, placeholder: '课程名（必填）' })
      .fontSize(15)
      .height(42)
      .width('100%')
      .backgroundColor('#F6EFE8')
      .borderWidth(this.error.length > 0 && this.name.trim().length === 0 ? 1 : 0)
      .borderColor('#C62828')
      .onChange((v: string) => {
        this.name = v;
      })
  }

  /** 一行时段：星期 / 起节 ~ 止节 / 删除 / 周次 */
  @Builder
  rowEditor(row: DraftRow, index: number) {
    Column({ space: 6 }) {
      Row({ space: 4 }) {
        Select(this.dayOptions())
          .selected(row.day - 1)
          .value(CourseDraft.dayName(row.day))
          .font({ size: 12 })
          .height(30)
          .onSelect((i: number) => {
            this.replaceRow(index, CourseDraft.row(i + 1, row.start, row.end, row.weeks, row.location, row.classGroup));
          })
        Select(this.periodOptions())
          .selected(row.start - 1)
          .value('第 ' + row.start + ' 节')
          .font({ size: 12 })
          .height(30)
          .onSelect((i: number) => {
            this.replaceRow(index, CourseDraft.row(row.day, i + 1, row.end, row.weeks, row.location, row.classGroup));
          })
        Text('~')
          .fontSize(12)
          .fontColor('#7A6E66')
        Select(this.periodOptions())
          .selected(row.end - 1)
          .value('第 ' + row.end + ' 节')
          .font({ size: 12 })
          .height(30)
          .onSelect((i: number) => {
            this.replaceRow(index, CourseDraft.row(row.day, row.start, i + 1, row.weeks, row.location, row.classGroup));
          })
        Blank()
        if (this.rows.length > 1) {
          Text('×')
            .fontSize(16)
            .fontColor('#B3A79E')
            .width(24)
            .textAlign(TextAlign.Center)
            .onClick(() => {
              this.removeRow(index);
            })
        }
      }
      .width('100%')

      TextInput({ text: row.weeks, placeholder: '周次，如 1-16,18 或 1-15单' })
        .fontSize(12)
        .height(34)
        .width('100%')
        .backgroundColor('#F6EFE8')
        .borderWidth(this.error.length > 0 && row.weeks.trim().length === 0 ? 1 : 0)
        .borderColor('#C62828')
        .onChange((v: string) => {
          this.replaceRow(index, CourseDraft.row(row.day, row.start, row.end, v, row.location, row.classGroup));
        })

      // v3：教室跟着这一段时间走。留空就用上面"地点"那一格（同一门课两次换楼很常见）
      TextInput({ text: row.location, placeholder: '这一段在哪上（留空=用上面的地点）' })
        .fontSize(12)
        .height(34)
        .width('100%')
        .backgroundColor('#F6EFE8')
        .onChange((v: string) => {
          this.replaceRow(index, CourseDraft.row(row.day, row.start, row.end, row.weeks, v, row.classGroup));
        })

      // v4：教学班只显示、不可编辑 —— 它是"同一个名字是不是同一门课"的判据，
      // 改了会让下次导入把课拆开/并错，比不改更糟
      if (row.classGroup.length > 0) {
        Text('教学班：' + row.classGroup)
          .fontSize(10)
          .fontColor('#A89C93')
          .width('100%')
      }
    }
    .width('100%')
    .padding({ top: 6, bottom: 6 })
    .border({ width: { bottom: 1 }, color: '#F0E7DF' })
    .alignItems(HorizontalAlign.Start)
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

  /** 整数组替换：ArkUI 只有拿到新数组才会重绘（就地改 `this.rows[i]` 不会） */
  private replaceRow(index: number, row: DraftRow): void {
    const next: DraftRow[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      next.push(i === index ? row : this.rows[i]);
    }
    this.rows = next;
  }

  private addRow(): void {
    const base: DraftRow = this.rows.length === 0
      ? CourseDraft.newRow(1, 1, this.periodCount)
      : this.rows[this.rows.length - 1];
    const next: DraftRow[] = this.rows.slice();
    next.push(CourseDraft.row(base.day, base.start, base.end, base.weeks, base.location, base.classGroup));
    this.rows = next;
  }

  private removeRow(index: number): void {
    if (this.rows.length <= 1) {
      return;
    }
    const next: DraftRow[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      if (i !== index) {
        next.push(this.rows[i]);
      }
    }
    this.rows = next;
  }

  private submit(): void {
    const result: DraftResult = CourseDraft.check(
      this.name, this.teacher, this.location, this.rows, this.periodCount
    );
    // 无论成败都回填：用户能直接看见"1~8周"被改成了"1-8"
    this.rows = result.rows.length > 0 ? result.rows : this.rows;
    this.name = result.name;
    this.teacher = result.teacher;
    this.location = result.location;
    if (result.error.length > 0) {
      this.error = result.error;
      return;
    }
    this.error = '';
    const payload: CourseDraftPayload | null = CourseDraft.payloadOf(result);
    if (payload === null) {
      this.error = '保存失败：表单没有通过校验';
      return;
    }
    this.onSubmit(payload);
  }
}
