import { SlotDraft } from '../logic';
import { type SlotCheckResult, type SlotForm, type SlotRow } from '../logic';

/**
 * 节次编辑弹窗（**手动编辑作息**与**导入校对页**共用同一个，与 Android 的
 * `SlotEditDialog` 一致）。
 *
 * 为什么必须共用：两边各写一个编辑器，早晚出现"手动改能存、导入校对改就存不了"。
 * 规则全在 `logic/SlotDraft.ts`（Node 上有断言）；这里只负责收集输入、标红出错的框。
 *
 * 与 Android 的一处实现差异：Android 用 `AlertDialog`（系统负责抬到键盘上方），
 * 这里自绘居中卡片 —— ArkUI 没有等价的自动避让，所以卡片只占屏幕上半部分，
 * 键盘弹出时仍然看得见（实测模拟器上 4 个输入框 + 键盘可以同时显示）。
 */
@Component
export struct SlotEditor {
  @Prop heading: string = '编辑节次';
  @Prop initialPeriod: string = '1';
  @Prop initialLabel: string = '';
  @Prop initialStart: string = '8:00';
  @Prop initialEnd: string = '8:45';
  /** 校对页里这一行的节次号是不是推断出来的（编辑后仍保留这个标记） */
  @Prop inferred: boolean = false;
  @Prop canDelete: boolean = false;

  onSubmit: (row: SlotRow) => void = () => {};
  onDelete: () => void = () => {};
  onCancel: () => void = () => {};

  @State periodText: string = '';
  @State labelText: string = '';
  @State startText: string = '';
  @State endText: string = '';
  @State error: string = '';
  @State badField: string = '';
  /** 删除要按两次：作息一整行删掉会影响所有格子的行高，误触的代价比课程更大 */
  @State deleteArmed: boolean = false;

  aboutToAppear(): void {
    this.periodText = this.initialPeriod;
    this.labelText = this.initialLabel;
    this.startText = this.initialStart;
    this.endText = this.initialEnd;
  }

  build() {
    Column() {
      Column({ space: 10 }) {
        Text(this.heading)
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor('#3B3430')
          .width('100%')

        Row({ space: 8 }) {
          TextInput({ text: this.periodText, placeholder: '第几节' })
            .fontSize(13)
            .height(38)
            .layoutWeight(1)
            .backgroundColor('#F6EFE8')
            .borderWidth(this.badField === SlotDraft.BAD_PERIOD ? 1 : 0)
            .borderColor('#C62828')
            .onChange((v: string) => {
              this.periodText = v;
            })
          TextInput({ text: this.labelText, placeholder: '分组（上午/下午…）' })
            .fontSize(13)
            .height(38)
            .layoutWeight(2)
            .backgroundColor('#F6EFE8')
            .onChange((v: string) => {
              this.labelText = v;
            })
        }
        .width('100%')

        Row({ space: 8 }) {
          TextInput({ text: this.startText, placeholder: '开始 8:00' })
            .fontSize(13)
            .height(38)
            .layoutWeight(1)
            .backgroundColor('#F6EFE8')
            .borderWidth(this.badField === SlotDraft.BAD_START ? 1 : 0)
            .borderColor('#C62828')
            .onChange((v: string) => {
              this.startText = v;
            })
          TextInput({ text: this.endText, placeholder: '结束 8:45' })
            .fontSize(13)
            .height(38)
            .layoutWeight(1)
            .backgroundColor('#F6EFE8')
            .borderWidth(this.badField === SlotDraft.BAD_END ? 1 : 0)
            .borderColor('#C62828')
            .onChange((v: string) => {
              this.endText = v;
            })
        }
        .width('100%')

        Text(SlotDraft.TIME_HINT)
          .fontSize(10)
          .fontColor('#B3A79E')
          .width('100%')

        if (this.error.length > 0) {
          Text(this.error)
            .fontSize(11)
            .fontColor('#C62828')
            .width('100%')
        }

        Row({ space: 8 }) {
          if (this.canDelete) {
            Text(this.deleteArmed ? '再按一次删除' : '删除')
              .fontSize(12)
              .fontColor(this.deleteArmed ? '#FFFFFF' : '#C62828')
              .backgroundColor(this.deleteArmed ? '#C62828' : '#FFFFFF')
              .borderRadius(8)
              .borderWidth(1)
              .borderColor('#F0C4C4')
              .textAlign(TextAlign.Center)
              .height(34)
              .padding({ left: 12, right: 12, top: 8 })
              .onClick(() => {
                if (!this.deleteArmed) {
                  this.deleteArmed = true;
                  return;
                }
                this.onDelete();
              })
          }
          Blank()
          Text('取消')
            .fontSize(13)
            .fontColor('#7A6E66')
            .height(34)
            .padding({ top: 8 })
            .onClick(() => {
              this.onCancel();
            })
          Text('保存')
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor('#E07A5F')
            .height(34)
            .padding({ top: 8 })
            .onClick(() => {
              this.submit();
            })
        }
        .width('100%')
      }
      .width('86%')
      .padding(16)
      .backgroundColor('#FFFFFF')
      .borderRadius(16)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor('#33000000')
  }

  private submit(): void {
    const form: SlotForm = SlotDraft.form(this.periodText, this.labelText, this.startText, this.endText);
    const result: SlotCheckResult = SlotDraft.check(form, this.inferred);
    // 无论成败都回填：用户能看见「8:5」被改成了「8:05」
    this.periodText = result.form.periodText;
    this.labelText = result.form.label;
    this.startText = result.form.startText;
    this.endText = result.form.endText;
    if (result.error.length > 0) {
      this.error = result.error;
      this.badField = result.badField;
      return;
    }
    this.error = '';
    this.badField = SlotDraft.BAD_NONE;
    this.onSubmit(result.row);
  }
}
