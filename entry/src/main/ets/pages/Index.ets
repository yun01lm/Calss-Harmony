import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import BuildProfile from 'BuildProfile';
import { webview } from '@kit.ArkWeb';
import {
  CourseDraft,
  GridFormatParser,
  InputNorm,
  ListFormatParser,
  Minutes,
  PdfRunText,
  WeekCalculator,
  WeekItems,
  WeekMasks,
  WeekSelection,
} from '../logic';
import {
  type CourseDraftPayload,
  type CourseLike,
  type DraftRow,
  type EventLike,
  type ParseResult,
  type PdfExtractResult,
  type ScheduleLike,
  type WeekItem,
} from '../logic';
import { Rdb } from '../platform/Rdb';
import { MigrationProbe, ProbeLine } from '../platform/MigrationProbe';
import { SpikeLine, SpikeProbe } from '../platform/SpikeProbe';
import { PdfJs } from '../platform/PdfJs';
import { PdfFile, PickedPdf } from '../platform/PdfFile';
import { ScheduleStore } from '../data/ScheduleStore';
import { mergeCourseItems, type MergeOutcome } from '../data/CourseMerge';
import {
  Course,
  CourseSchedule,
  CourseWithSchedules,
  maskFromDb,
  maskToDb,
  MAX_TOTAL_WEEKS,
  MIN_TOTAL_WEEKS,
  Snapshot,
  TimeSlot,
  Timetable,
} from '../data/models';
import { WeekGrid } from '../view/WeekGrid';
import { CourseEditor } from '../view/CourseEditor';

/**
 * 主页：周视图。
 *
 * ## 打开即当前周（这是本页最容易做错的地方）
 *
 * 规则在 `logic/WeekSelection.ts` 里，配合 `autoScrolling` 标记使用：
 * 1. **程序化翻页整段期间**不上报（不是只忽略最终页）；
 * 2. 仅当目标页与"当前显示的周"不同才上报（瞬时判据）。
 *
 * 违反任何一条的症状都很具体：前者会让箭头跳周时把页码记成中间页，
 * 后者会让"滑回刚才程序翻过的那页"被永久忽略（标题说第 6 周、网格显示第 5 周）。
 *
 * ## 启动策略
 *
 * 首帧不等数据：本页先画"第 1 周 + 空网格"，数据到达后再换成真实课表。
 * 数据库仍然是**用时才打开**（`EntryAbility.onCreate` 里什么都不做）。
 */
@Entry
@Component
struct Index {
  // ---------------- 数据
  @State loading: boolean = true;
  @State ready: boolean = false;
  @State errorLine: string = '';
  @State snapshot: Snapshot | null = null;

  // ---------------- 周视图状态
  @State weeks: WeekItem[][] = [];
  @State periodCount: number = 12;
  @State totalWeeks: number = 20;
  @State currentWeek: number = 1;
  @State selectedWeek: number = 1;
  @State followingCurrentWeek: boolean = true;
  @State semesterStart: number = 0;
  @State todayEpochDay: number = WeekCalculator.todayEpochDay();
  @State fontScale: number = 1;

  // ---------------- 详情卡
  @State detailTitle: string = '';
  @State detailLines: string[] = [];
  /** 详情卡对应的课程 id；0 = 自定义安排（没有课程可编辑） */
  @State detailCourseId: number = 0;

  // ---------------- 课程编辑面板
  @State editorOpen: boolean = false;
  @State editorTitle: string = '添加课程';
  /** 0 = 新建；> 0 = 正在编辑这门课（保存时保留它的配色/类别/备注） */
  @State editorCourseId: number = 0;
  @State editorName: string = '';
  @State editorTeacher: string = '';
  @State editorLocation: string = '';
  @State editorRows: DraftRow[] = [];

  // ---------------- 学期设置（开学日 / 总周数）
  @State semesterOpen: boolean = false;
  @State semesterStartText: string = '';
  @State semesterWeeksText: string = '';
  @State semesterError: string = '';

  // ---------------- 开发者入口（标题连点 5 次）：迁移演练
  private titleTaps: number = 0;
  @State showDev: boolean = false;
  @State probeLines: ProbeLine[] = [];
  @State probing: boolean = false;
  @State spikeLines: SpikeLine[] = [];
  @State spiking: boolean = false;

  /** pdf.js 通道（ArkWeb） */
  @State pdfLines: SpikeLine[] = [];
  @State pdfRunning: boolean = false;
  @State webReady: boolean = false;
  @State webLog: string[] = [];
  /** 是否已经需要 pdf.js（点了导入/spike 才加载页面） */
  @State webRequested: boolean = false;

  // ---------------- 导入课表（PDF）
  @State importOpen: boolean = false;
  @State importBusy: boolean = false;
  @State importStage: string = '';
  @State importFileName: string = '';
  @State importFormat: string = '';
  @State importCount: number = 0;
  @State importPreview: string[] = [];
  @State importWarnings: string[] = [];
  @State importError: string = '';
  /** pdf.js 这次回传是给"spike"还是给"导入"用的 */
  private pdfPurpose: string = 'spike';
  /** 导入正在进行（含文件选择器那一小段），用来挡住连点导致的并发解析 */
  private importStarting: boolean = false;
  private importCourses: CourseWithSchedules[] = [];

  // ---------------- 二级页面（作息 / 课表）
  /** 'home' | 'slots' | 'timetables' —— 用状态切屏而不是路由：只有两个页面，省掉一层导航栈 */
  @State screen: string = 'home';
  @State timetables: Timetable[] = [];
  @State slotsBusy: boolean = false;
  /** '' | 'create' | 'rename'：正在弹输入框 */
  @State textDialog: string = '';
  @State textValue: string = '';
  @State openPrimaryOnLaunch: boolean = false;
  private webController: webview.WebviewController = new webview.WebviewController();

  /** 程序化翻页中。不是 @State：它不影响渲染，只用来压住 onChange */
  private autoScrolling: boolean = false;
  private controller: SwiperController = new SwiperController();
  /** 当前 store / 库句柄：二级页面（作息、课表）直接用，不再重复 open */
  private store: ScheduleStore | null = null;
  private db: Rdb | null = null;

  aboutToAppear(): void {
    this.load();
  }

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      Column() {
        if (this.screen === 'slots') {
          this.slotsScreen()
        } else if (this.screen === 'timetables') {
          this.timetablesScreen()
        } else {
          this.headerBar()
          if (this.loading) {
            Column({ space: 8 }) {
              LoadingProgress().width(36).height(36).color('#E07A5F')
              Text('正在读取课表…').fontSize(12).fontColor('#7A6E66')
            }
            .layoutWeight(1)
            .width('100%')
            .justifyContent(FlexAlign.Center)
          } else if (this.errorLine.length > 0) {
            Column({ space: 8 }) {
              Text('打开课表失败').fontSize(15).fontWeight(FontWeight.Medium).fontColor('#C62828')
              Text(this.errorLine).fontSize(12).fontColor('#7A6E66').textAlign(TextAlign.Center)
              Button('重试')
                .fontSize(13)
                .backgroundColor('#E07A5F')
                .onClick(() => {
                  this.errorLine = '';
                  this.loading = true;
                  this.load();
                })
            }
            .layoutWeight(1)
            .width('100%')
            .padding(24)
            .justifyContent(FlexAlign.Center)
          } else {
            this.weekBar()
            this.pager()
          }
          if (this.showDev && BuildProfile.DEBUG) {
            this.devPanel()
          }
        }
      }
      .width('100%')
      .height('100%')
      .backgroundColor('#FFF9F4')

      if (this.detailTitle.length > 0) {
        this.detailCard()
      }

      if (this.importOpen) {
        this.importSheet()
      }

      if (this.textDialog.length > 0) {
        this.textDialogCard()
      }

      if (this.semesterOpen) {
        this.semesterCard()
      }

      if (this.editorOpen) {
        CourseEditor({
          periodCount: this.periodCount,
          editorTitle: this.editorTitle,
          initialName: this.editorName,
          initialTeacher: this.editorTeacher,
          initialLocation: this.editorLocation,
          initialRows: this.editorRows,
          canDelete: this.editorCourseId > 0,
          onSubmit: (payload: CourseDraftPayload) => {
            this.saveCoursePayload(payload);
          },
          onDelete: () => {
            this.deleteEditedCourse();
          },
          onCancel: () => {
            this.editorOpen = false;
          },
        })
      }

      // pdf.js 容器：1x1 且透明，**用时才创建**（常驻会让冷启动多 ~0.5s）
      if (this.webRequested) {
        this.hiddenWeb()
      }
    }
    .width('100%')
    .height('100%')
  }

  // ---------------------------------------------------------------- 顶栏

  @Builder
  headerBar() {
    Row() {
      Column({ space: 2 }) {
        Text('简课表')
          .fontSize(22)
          .fontWeight(FontWeight.Bold)
          .fontColor('#3B3430')
          .onClick(() => {
            // 开发者入口：连点 5 次打开迁移演练（普通使用碰不到）
            // 开发者入口：连点 5 次打开迁移演练。
            // **只在 debug 包里存在**：release 包还带一个"清空全部课程"的一键按钮，
            // 那是数据事故的种子（模拟器上真的有 6 次点击就抹掉整张课表的路径）
            if (!BuildProfile.DEBUG) {
              return;
            }
            this.titleTaps++;
            if (this.titleTaps >= 5) {
              this.titleTaps = 0;
              this.showDev = !this.showDev;
            }
          })
        Text(this.timetableName())
          .fontSize(10)
          .fontColor('#A89C93')
      }
      .alignItems(HorizontalAlign.Start)

      Blank()

      if (this.currentWeek > this.totalWeeks) {
        Text('学期已结束')
          .fontSize(11)
          .fontColor('#A89C93')
          .margin({ right: 8 })
      }

      Button('课表')
        .fontSize(12)
        .height(30)
        .backgroundColor('#F3E6DC')
        .fontColor('#B4664C')
        .margin({ right: 6 })
        .onClick(() => {
          this.openTimetables();
        })

      Button('作息')
        .fontSize(12)
        .height(30)
        .backgroundColor('#F3E6DC')
        .fontColor('#B4664C')
        .margin({ right: 6 })
        .onClick(() => {
          this.screen = 'slots';
        })

      Button(this.importBusy ? '导入中…' : '导入')
        .fontSize(12)
        .height(30)
        .backgroundColor('#F3E6DC')
        .fontColor('#B4664C')
        .enabled(!this.importBusy && !this.pdfRunning)
        .onClick(() => {
          this.startImport();
        })
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 12, bottom: 6 })
  }

  // ---------------------------------------------------------------- 周次条

  @Builder
  weekBar() {
    Row({ space: 6 }) {
      Button('‹')
        .width(36)
        .height(36)
        .fontSize(20)
        .backgroundColor('#FFFFFF')
        .fontColor(this.selectedWeek > 1 ? '#3B3430' : '#D8CEC6')
        .enabled(this.selectedWeek > 1)
        .onClick(() => {
          this.goToWeek(this.selectedWeek - 1);
        })

      Column({ space: 1 }) {
        Text(`第 ${this.selectedWeek} 周`)
          .fontSize(18)
          .fontWeight(FontWeight.Medium)
          .fontColor('#E07A5F')
        Text(this.weekRangeText() + '  学期设置›')
          .fontSize(10)
          .fontColor('#B4664C')
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Center)
      .onClick(() => {
        this.openSemester();
      })

      Button('›')
        .width(36)
        .height(36)
        .fontSize(20)
        .backgroundColor('#FFFFFF')
        .fontColor(this.selectedWeek < this.totalWeeks ? '#3B3430' : '#D8CEC6')
        .enabled(this.selectedWeek < this.totalWeeks)
        .onClick(() => {
          this.goToWeek(this.selectedWeek + 1);
        })
    }
    .width('100%')
    .padding({ left: 12, right: 12, bottom: 4 })

    Row() {
      if (!this.followingCurrentWeek) {
        Button('回到本周（第 ' + this.currentWeek + ' 周）')
          .fontSize(11)
          .height(26)
          .backgroundColor('#F3E6DC')
          .fontColor('#B4664C')
          .onClick(() => {
            this.goToCurrentWeek();
          })
      } else {
        Text(this.isEmptyTimetable() ? '还没有课程' : '本周')
          .fontSize(10)
          .fontColor('#A89C93')
      }
      Blank()
      Text(this.gridSummary())
        .fontSize(10)
        .fontColor('#A89C93')
    }
    .width('100%')
    .padding({ left: 16, right: 16, bottom: 6 })
  }

  // ---------------------------------------------------------------- 翻页

  @Builder
  pager() {
    Swiper(this.controller) {
      ForEach(this.weekNumbers(), (week: number) => {
        WeekGrid({
          slots: this.slots(),
          periodCount: this.periodCount,
          items: WeekItems.itemsOf(this.weeks, week),
          weekDates: this.weekDates(week),
          todayEpochDay: this.todayEpochDay,
          fontScale: this.fontScale,
          onCellTap: (dayOfWeek: number, period: number) => {
            this.onCellTap(dayOfWeek, period);
          },
          onItemTap: (item: WeekItem) => {
            this.onItemTap(item);
          },
        })
      }, (week: number) => 'w' + week)
    }
    .index(WeekSelection.pageOf(this.selectedWeek))
    .loop(false)
    .indicator(false)
    .cachedCount(1)
    .duration(300)
    .layoutWeight(1)
    .width('100%')
    .onChange((index: number) => {
      const pageWeek: number = WeekSelection.weekOfPage(index);
      // 两条抑制规则：程序化翻页期间一律不听；只有与"当前显示的周"不同才算用户选周
      if (WeekSelection.shouldReport(pageWeek, this.selectedWeek, this.autoScrolling)) {
        this.selectedWeek = pageWeek;
        this.followingCurrentWeek = false;
        this.closeDetail();
      }
    })
  }

  // ---------------------------------------------------------------- 详情卡

  @Builder
  detailCard() {
    Column({ space: 6 }) {
      Row({ space: 12 }) {
        Text(this.detailTitle)
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor('#3B3430')
          .layoutWeight(1)
        if (this.detailCourseId > 0) {
          Text('编辑')
            .fontSize(12)
            .fontColor('#5B7C99')
            .onClick(() => {
              this.openCourseEditorById(this.detailCourseId);
            })
        }
        Text('关闭')
          .fontSize(12)
          .fontColor('#E07A5F')
          .onClick(() => {
            this.closeDetail();
          })
      }
      .width('100%')

      ForEach(this.detailLines, (line: string) => {
        Text(line)
          .fontSize(12)
          .fontColor('#7A6E66')
          .width('100%')
      }, (line: string, index: number) => 'd' + index)
    }
    .width('100%')
    .padding(16)
    .backgroundColor('#FFFFFF')
    .borderRadius({ topLeft: 16, topRight: 16 })
    .shadow({ radius: 12, color: '#1A000000', offsetY: -2 })
  }

  // ---------------------------------------------------------------- 作息页

  @Builder
  slotsScreen() {
    Column({ space: 8 }) {
      this.screenHeader('作息时间')

      Text('课表格子里的节次时间从这张表来。改完立即生效，课程数据不动。')
        .fontSize(10)
        .fontColor('#A89C93')
        .width('100%')
        .padding({ left: 16, right: 16 })

      List({ space: 6 }) {
        ForEach(this.slots(), (slot: TimeSlot) => {
          ListItem() {
            Row({ space: 8 }) {
              Text(`第 ${slot.periodIndex} 节`)
                .fontSize(12)
                .fontWeight(FontWeight.Medium)
                .fontColor('#3B3430')
                .width(64)

              Text(Minutes.format(slot.startMinute))
                .fontSize(14)
                .fontColor('#E07A5F')
                .width(56)
                .textAlign(TextAlign.Center)
                .onClick(() => {
                  this.pickSlotTime(slot, true);
                })

              Text('—').fontSize(12).fontColor('#B3A79E')

              Text(Minutes.format(slot.endMinute))
                .fontSize(14)
                .fontColor('#E07A5F')
                .width(56)
                .textAlign(TextAlign.Center)
                .onClick(() => {
                  this.pickSlotTime(slot, false);
                })

              Text(`${(slot.endMinute - slot.startMinute)} 分`)
                .fontSize(10)
                .fontColor('#A89C93')
                .layoutWeight(1)

              Text('删除')
                .fontSize(11)
                .fontColor('#C62828')
                .onClick(() => {
                  this.deleteSlot(slot);
                })
            }
            .width('100%')
            .padding({ left: 16, right: 16, top: 8, bottom: 8 })
            .backgroundColor('#FFFFFF')
            .borderRadius(8)
            }
          }, (slot: TimeSlot) => 'slot' + slot.id + '-' + slot.startMinute + '-' + slot.endMinute)
      }
      .layoutWeight(1)
      .width('100%')
      .padding({ left: 12, right: 12 })
      .scrollBar(BarState.Off)

      Row({ space: 8 }) {
        Button('加一节')
          .fontSize(12)
          .height(34)
          .layoutWeight(1)
          .backgroundColor('#E07A5F')
          .enabled(!this.slotsBusy)
          .onClick(() => {
            this.addSlot();
          })
        Button('恢复默认 12 节')
          .fontSize(12)
          .height(34)
          .layoutWeight(1)
          .backgroundColor('#BDB3AB')
          .enabled(!this.slotsBusy)
          .onClick(() => {
            this.resetSlots();
          })
      }
      .width('100%')
      .padding({ left: 12, right: 12, bottom: 12 })
    }
    .width('100%')
    .height('100%')
  }

  // ---------------------------------------------------------------- 课表页

  @Builder
  timetablesScreen() {
    Column({ space: 8 }) {
      this.screenHeader('课表')

      List({ space: 6 }) {
        ForEach(this.timetables, (t: Timetable) => {
          ListItem() {
            Row({ space: 8 }) {
              Column({ space: 2 }) {
                Row({ space: 6 }) {
                  Text(t.name)
                    .fontSize(14)
                    .fontWeight(FontWeight.Medium)
                    .fontColor('#3B3430')
                  if (t.isPrimary) {
                    Text('主')
                      .fontSize(9)
                      .fontColor('#FFFFFF')
                      .backgroundColor('#E07A5F')
                      .borderRadius(4)
                      .padding({ left: 4, right: 4, top: 1, bottom: 1 })
                  }
                  if (t.id === this.storeCurrentId()) {
                    Text('当前')
                      .fontSize(9)
                      .fontColor('#FFFFFF')
                      .backgroundColor('#7FA98B')
                      .borderRadius(4)
                      .padding({ left: 4, right: 4, top: 1, bottom: 1 })
                  }
                }
                Text(`${t.totalWeeks} 周 · 开学 ${WeekCalculator.isoDate(t.startDateEpochDay)}`)
                  .fontSize(10)
                  .fontColor('#A89C93')
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)

              if (t.id !== this.storeCurrentId()) {
                Text('切换')
                  .fontSize(12)
                  .fontColor('#B4664C')
                  .onClick(() => {
                    this.switchTimetable(t.id);
                  })
              }
            }
            .width('100%')
            .padding({ left: 16, right: 16, top: 10, bottom: 10 })
            .backgroundColor('#FFFFFF')
            .borderRadius(8)
            .onClick(() => {
              this.switchTimetable(t.id);
            })
            }
          }, (t: Timetable) => 'tt' + t.id + '-' + t.name + '-' + t.isPrimary)
      }
      .layoutWeight(1)
      .width('100%')
      .padding({ left: 12, right: 12 })
      .scrollBar(BarState.Off)

      Row() {
        Text('启动时总是打开主课表')
          .fontSize(12)
          .fontColor('#7A6E66')
          .layoutWeight(1)
        Toggle({ type: ToggleType.Switch, isOn: this.openPrimaryOnLaunch })
          .selectedColor('#E07A5F')
          .onChange((isOn: boolean) => {
            this.setOpenPrimary(isOn);
          })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 6, bottom: 6 })

      Row({ space: 8 }) {
        Button('新建课表')
          .fontSize(12)
          .height(34)
          .layoutWeight(1)
          .backgroundColor('#E07A5F')
          .onClick(() => {
            this.textDialog = 'create';
            this.textValue = '';
          })
        Button('重命名')
          .fontSize(12)
          .height(34)
          .layoutWeight(1)
          .backgroundColor('#7FA98B')
          .onClick(() => {
            this.textDialog = 'rename';
            this.textValue = this.currentTimetableName();
          })
        Button('设为主课表')
          .fontSize(12)
          .height(34)
          .layoutWeight(1)
          .backgroundColor('#5B7C99')
          .onClick(() => {
            this.markPrimary();
          })
      }
      .width('100%')
      .padding({ left: 12, right: 12 })

      Button('删除当前课表')
        .fontSize(12)
        .height(32)
        .width('100%')
        .backgroundColor('#F7E7E4')
        .fontColor('#C62828')
        .margin({ left: 12, right: 12, bottom: 12 })
        .onClick(() => {
          this.confirmDeleteTimetable();
        })
    }
    .width('100%')
    .height('100%')
  }

  /** 新建/重命名的输入框（用一个居中的卡片，避免再引入弹窗 API） */
  @Builder
  textDialogCard() {
    Column() {
      Column({ space: 10 }) {
        Text(this.textDialog === 'create' ? '新建课表' : '重命名课表')
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor('#3B3430')
          .width('100%')
        TextInput({ text: this.textValue, placeholder: '课表名字' })
          .fontSize(14)
          .backgroundColor('#F5EFEA')
          .onChange((value: string) => {
            this.textValue = value;
          })
        Row({ space: 8 }) {
          Button('取消')
            .fontSize(12)
            .height(32)
            .layoutWeight(1)
            .backgroundColor('#EFE6DF')
            .fontColor('#7A6E66')
            .onClick(() => {
              this.textDialog = '';
            })
          Button('确定')
            .fontSize(12)
            .height(32)
            .layoutWeight(1)
            .backgroundColor('#E07A5F')
            .onClick(() => {
              this.confirmTextDialog();
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

  /** 学期设置：开学日 + 总周数（点周视图中间那行「第 N 周 · 日期」打开） */
  @Builder
  semesterCard() {
    Column() {
      Column({ space: 8 }) {
        Text('学期设置')
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor('#3B3430')
          .width('100%')
        Text('开学日就是第 1 周的周一。改完「第几周」会立刻跟着变。')
          .fontSize(10)
          .fontColor('#A89C93')
          .width('100%')

        Text('开学日')
          .fontSize(11)
          .fontColor('#7A6E66')
          .width('100%')
        TextInput({ text: this.semesterStartText, placeholder: '2026-09-07' })
          .fontSize(14)
          .height(38)
          .backgroundColor('#F5EFEA')
          .onChange((value: string) => {
            this.semesterStartText = value;
          })

        Text('总周数（' + MIN_TOTAL_WEEKS + '-' + MAX_TOTAL_WEEKS + '）')
          .fontSize(11)
          .fontColor('#7A6E66')
          .width('100%')
        TextInput({ text: this.semesterWeeksText, placeholder: '20' })
          .fontSize(14)
          .height(38)
          .type(InputType.Number)
          .backgroundColor('#F5EFEA')
          .onChange((value: string) => {
            this.semesterWeeksText = value;
          })

        if (this.semesterError.length > 0) {
          Text(this.semesterError)
            .fontSize(11)
            .fontColor('#C62828')
            .width('100%')
        }

        Row({ space: 8 }) {
          Button('取消')
            .fontSize(12)
            .height(32)
            .layoutWeight(1)
            .backgroundColor('#EFE6DF')
            .fontColor('#7A6E66')
            .onClick(() => {
              this.semesterOpen = false;
            })
          Button('保存')
            .fontSize(12)
            .height(32)
            .layoutWeight(1)
            .backgroundColor('#E07A5F')
            .onClick(() => {
              this.applySemester();
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

  /** 二级页面的统一顶栏：返回 + 标题 */  @Builder
  screenHeader(title: string) {
    Row() {
      Text('‹ 返回')
        .fontSize(13)
        .fontColor('#B4664C')
        .onClick(() => {
          this.screen = 'home';
          this.textDialog = '';
        })
      Text(title)
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .fontColor('#3B3430')
        .layoutWeight(1)
        .textAlign(TextAlign.Center)
      Text(' ')
        .fontSize(13)
        .width(48)
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 14, bottom: 8 })
  }

  // ---------------------------------------------------------------- 导入面板

  /**
   * 导入面板：解析结果**先给人看**，再让人选落库方式。
   *
   * 为什么不做成"选完文件直接写库"：解析是有误差的（真实 OCR 会把连字符读成冒号、
   * 少读一节课的节次号）。直接覆盖等于把用户原来正确的课表换成一份可能缺课的，
   * 而且没法撤销。所以这里一定先出预览 + 警告，写入必须由用户点。
   */
  @Builder
  importSheet() {
    Column({ space: 8 }) {
      Row() {
        Text('导入课表')
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor('#3B3430')
          .layoutWeight(1)
        Text(this.importBusy ? '处理中…' : '取消')
          .fontSize(12)
          .fontColor(this.importBusy ? '#BDB3AB' : '#E07A5F')
          .onClick(() => {
            this.closeImport();
          })
      }
      .width('100%')

      Text(this.importFileName)
        .fontSize(11)
        .fontColor('#7A6E66')
        .width('100%')

      if (this.importError.length > 0) {
        Text(this.importError)
          .fontSize(12)
          .fontColor('#C62828')
          .width('100%')
      }

      if (this.importBusy) {
        Row({ space: 8 }) {
          LoadingProgress().width(18).height(18).color('#E07A5F')
          Text(this.importStage)
            .fontSize(12)
            .fontColor('#7A6E66')
        }
        .width('100%')
      } else if (this.importCount > 0) {
        Text(`${this.importFormat} · 认出 ${this.importCount} 门课`)
          .fontSize(12)
          .fontColor('#2E7D32')
          .width('100%')

        ForEach(this.importPreview, (line: string) => {
          Text(line)
            .fontSize(11)
            .fontColor('#7A6E66')
            .width('100%')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }, (line: string, index: number) => 'imp' + index)

        if (this.importWarnings.length > 0) {
          Text('注意：' + this.importWarnings.join('；'))
            .fontSize(10)
            .fontColor('#B4664C')
            .width('100%')
        }

        Row({ space: 8 }) {
          Button('覆盖当前课表')
            .fontSize(11)
            .height(32)
            .layoutWeight(1)
            .backgroundColor('#E07A5F')
            .onClick(() => {
              this.applyImport('replace');
            })
          Button('合并到当前')
            .fontSize(11)
            .height(32)
            .layoutWeight(1)
            .backgroundColor('#7FA98B')
            .onClick(() => {
              this.applyImport('merge');
            })
        }
        .width('100%')

        Button('导入为新课表（保留原课表）')
          .fontSize(11)
          .height(32)
          .width('100%')
          .backgroundColor('#5B7C99')
          .onClick(() => {
            this.applyImport('new');
          })
      }
    }
    .width('100%')
    .padding(16)
    .backgroundColor('#FFFFFF')
    .borderRadius({ topLeft: 16, topRight: 16 })
    .shadow({ radius: 12, color: '#1A000000', offsetY: -2 })
  }

  // ---------------------------------------------------------------- 开发者入口
  @Builder
  devPanel() {
    Column({ space: 6 }) {
      Row() {
        Text('开发者入口 · 标题连点 5 次开关')
          .fontSize(11)
          .fontColor('#5B7C99')
          .layoutWeight(1)
        Text('关闭')
          .fontSize(11)
          .fontColor('#E07A5F')
          .onClick(() => {
            this.showDev = false;
          })
      }
      .width('100%')

      Scroll() {
        Column({ space: 6 }) {
          Button(this.probing ? '演练进行中…' : '在 calss_probe.db 上跑 v1→v2 迁移')
            .fontSize(12)
            .height(32)
            .width('100%')
            .backgroundColor('#5B7C99')
            .enabled(!this.probing)
            .onClick(() => {
              this.runProbe();
            })

          Row({ space: 8 }) {
            Button('写入示例课（4 门）')
              .fontSize(11)
              .height(28)
              .layoutWeight(1)
              .backgroundColor('#E07A5F')
              .onClick(() => {
                this.confirmWriteSamples();
              })
            Button('清空全部课程')
              .fontSize(11)
              .height(28)
              .layoutWeight(1)
              .backgroundColor('#BDB3AB')
              .onClick(() => {
                this.confirmClearCourses();
              })
          }
          .width('100%')

          ForEach(this.probeLines, (line: ProbeLine) => {
            Row({ space: 4 }) {
              Text(line.ok ? '✓' : '✗')
                .fontSize(11)
                .fontColor(line.ok ? '#2E7D32' : '#C62828')
              Text(line.label + ' · ' + line.detail)
                .fontSize(10)
                .fontColor('#7A6E66')
                .layoutWeight(1)
            }
            .width('100%')
            .alignItems(VerticalAlign.Top)
          }, (line: ProbeLine) => line.label + '|' + line.detail)

          Divider()

          Button(this.spiking ? 'spike 进行中…' : '跑 spike：PDF 取文本 + 中文 OCR')
            .fontSize(12)
            .height(32)
            .width('100%')
            .backgroundColor('#7FA98B')
            .enabled(!this.spiking && !this.importOpen)
            .onClick(() => {
              this.runSpikes();
            })

          ForEach(this.spikeLines, (line: SpikeLine) => {
            Row({ space: 4 }) {
              Text(line.ok ? '✓' : '✗')
                .fontSize(11)
                .fontColor(line.ok ? '#2E7D32' : '#C62828')
              Text(line.label + ' · ' + line.detail)
                .fontSize(10)
                .fontColor('#7A6E66')
                .layoutWeight(1)
            }
            .width('100%')
            .alignItems(VerticalAlign.Top)
          }, (line: SpikeLine) => line.label + '|' + line.detail)

          Divider()

          Button(this.pdfRunning ? 'pdf.js 解析中…' : '跑 PDF spike（pdf.js 取坐标）')
            .fontSize(12)
            .height(32)
            .width('100%')
            .backgroundColor('#9B8AC4')
            .enabled(!this.pdfRunning && !this.importOpen)
            .onClick(() => {
              this.runPdfSpike();
            })

          ForEach(this.pdfLines, (line: SpikeLine) => {
            Row({ space: 4 }) {
              Text(line.ok ? '✓' : '✗')
                .fontSize(11)
                .fontColor(line.ok ? '#2E7D32' : '#C62828')
              Text(line.label + ' · ' + line.detail)
                .fontSize(10)
                .fontColor('#7A6E66')
                .layoutWeight(1)
            }
            .width('100%')
            .alignItems(VerticalAlign.Top)
          }, (line: SpikeLine) => line.label + '|' + line.detail)

          ForEach(this.webLog, (msg: string) => {
            Text('web: ' + msg)
              .fontSize(9)
              .fontColor('#8A7F76')
              .width('100%')
          }, (msg: string, index: number) => 'log' + index + msg.substring(0, 12))
        }
        .width('100%')
      }
      .constraintSize({ maxHeight: 320 })
      .width('100%')
      .scrollBar(BarState.Auto)
    }
    .width('100%')
    .padding(12)
    .backgroundColor('#F4F7FA')
    .borderRadius({ topLeft: 12, topRight: 12 })
  }

  // ---------------------------------------------------------------- pdf.js 通道

  @Builder
  hiddenWeb() {
    Web({ src: 'resource://rawfile/pdfjs/viewer.html', controller: this.webController })
      .width(1)
      .height(1)
      .opacity(0)
      .javaScriptAccess(true)
      .domStorageAccess(true)
      .fileAccess(true)
      .onPageEnd(() => {
        this.webReady = true;
      })
      .onConsole((event) => {
        // pdf.js 的诊断信息（例如 "Unable to load CMap at: …"）只有从这里能看到
        const msg: string = event.message.getMessage();
        const line: string = msg;
        const next: string[] = this.webLog.slice(0);
        next.push(line);
        while (next.length > 6) {
          next.shift();
        }
        this.webLog = next;
        return false;
      })
  }

  /** 用 pdf.js 抽取合成夹具 PDF 的带坐标文本，再喂给现有的两个解析器 */
  private async runPdfSpike(): Promise<void> {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return;
    }
    this.pdfRunning = true;
    this.pdfLines = [];
    // 明确目的：否则上一次导入留下的 'import' 会把 spike 的回传送进导入流程
    this.pdfPurpose = 'spike';
    try {
      const ready: boolean = await this.ensureWeb();
      if (!ready) {
        const wait: SpikeLine = { label: 'pdf.js 页面没加载出来', ok: false, detail: '稍后再试一次' };
        this.pdfLines = [wait];
        this.pdfRunning = false;
        return;
      }
      const base64: string = await PdfJs.readRawBase64(ctx as common.UIAbilityContext, 'spike-grid.pdf');
      const info: SpikeLine = { label: 'PDF 已读入并送去 pdf.js', ok: base64.length > 0, detail: base64.length + ' 字符(base64)' };
      this.pdfLines = [info];
      await this.runJs(PdfJs.CLEAR_SCRIPT);
      this.webController.runJavaScript(PdfJs.extractCall(base64));
      const payload: string = await this.pollPdfResult(60000);
      if (payload.length === 0) {
        const timeout: SpikeLine = { label: '解析超时', ok: false, detail: '60 秒内 pdf.js 没有回结果' };
        this.pdfLines = [info, timeout];
        this.pdfRunning = false;
        return;
      }
      this.onPdfPayload(payload);
    } catch (e) {
      const err = e as Error;
      const line: SpikeLine = { label: 'pdf.js 调用失败', ok: false, detail: err.message };
      this.pdfLines = [line];
      this.pdfRunning = false;
    }
  }

  /**
   * 确保 pdf.js 已就绪：把 `webRequested` 置真让 Web 组件出现，然后轮询就绪标记。
   *
   * 这里**不能**先建 Web 再调 `loadUrl()`：后置 `loadUrl` 会报
   * `The WebviewController must be associated with a Web component`；
   * 而 `src: $rawfile(...)` 在事后创建时又不触发 `OnPageEnd`。
   * 实测可用的组合只有「条件创建 + `src` 直接写 `resource://rawfile/pdfjs/viewer.html`」。
   */
  private async ensureWeb(): Promise<boolean> {
    this.webRequested = true;
    // 30 秒上限：这台模拟器加载 pdf.js（1.5MB）实测要十几秒
    for (let i = 0; i < 150; i++) {
      const raw: string | null = await this.runJs(PdfJs.READY_SCRIPT);
      const ready: string = raw === null ? '' : Index.decodeJsString(raw);
      if (ready === '1') {
        this.webReady = true;
        return true;
      }
      await Index.sleep(200);
    }
    return false;
  }

  /** 执行一段 JS 并取它的返回值（失败/无返回时给 null） */
  /** 单次 `runJavaScript` 的硬超时：回调丢了也不能让 await 永远挂着 */
  private static readonly JS_TIMEOUT_MS: number = 5000;

  private runJs(script: string): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      let finished: boolean = false;
      const finish = (value: string | null): void => {
        if (finished) {
          return;
        }
        finished = true;
        resolve(value);
      };
      // 没有这个计时器的话，Web 渲染进程一旦崩掉，回调永远不来：
      // "解析中…" 会一直转，取消按钮被禁用、返回键被吞，用户只能杀进程
      const timer: number = setTimeout(() => {
        finish(null);
      }, Index.JS_TIMEOUT_MS);
      try {
        this.webController.runJavaScript(script, (err, result) => {
          clearTimeout(timer);
          if (err !== null && err !== undefined) {
            finish(null);
            return;
          }
          finish(result === undefined ? null : result);
        });
      } catch (e) {
        clearTimeout(timer);
        finish(null);
      }
    });
  }

  /**
   * `runJavaScript` 的回传值是**带引号的字面量**：JS 里空串回来是 `""`，
   * 就绪标记 `"1"`，payload 是 `"OK\n1\t..."`（换行、制表符都是转义形式）。
   * 不还原就会踩两个坑：① 空串长度 2 被当成"有结果"；② payload 里全是 `\n` 文本。
   * 用 JSON.parse 还原（JS 的字符串字面量语法与 JSON 兼容）。
   */
  private static decodeJsString(raw: string): string {
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      try {
        const parsed = JSON.parse(raw) as string;
        return typeof parsed === 'string' ? parsed : '';
      } catch (e) {
        return '';
      }
    }
    return raw;
  }

  /**
   * 轮询取解析结果。
   *
   * 为什么轮询而不是等 JS 回调：Web 组件是"用时才加载"的，
   * `registerJavaScriptProxy` 的注册/refresh 与页面加载时序一错开，
   * JS 里的代理就是 undefined，结果会**静默丢失**。
   * `window.__pdfResult` / `__pdfError` 由 viewer.html 写入，这里只负责取并还原引号。
   */
  private async pollPdfResult(timeoutMs: number): Promise<string> {
    const started: number = Date.now();
    while (Date.now() - started < timeoutMs) {
      const rawError: string | null = await this.runJs(PdfJs.ERROR_SCRIPT);
      const errorPayload: string = rawError === null ? '' : Index.decodeJsString(rawError);
      if (errorPayload.length > 0) {
        return errorPayload;
      }
      const raw: string | null = await this.runJs(PdfJs.RESULT_SCRIPT);
      const payload: string = raw === null ? '' : Index.decodeJsString(raw);
      if (payload.length > 0) {
        return payload;
      }
      await Index.sleep(150);
    }
    return '';
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, ms);
    });
  }

  /**
   * 开发期：把 pdf.js 的回传原文写进应用沙箱（`filesDir/pdf-runs.txt`）。
   * 只用于排查真实课表的解析问题，release 包里不会调用（`BuildProfile.DEBUG`）。
   */
  private static dumpRunsForDebug(ctx: common.UIAbilityContext, payload: string): void {
    try {
      const path: string = ctx.filesDir + '/pdf-runs.txt';
      const file = fileIo.openSync(
        path,
        fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC
      );
      fileIo.writeSync(file.fd, payload);
      fileIo.closeSync(file);
      console.info('[Calss] pdf-runs dumped: ' + path + ' (' + payload.length + ' chars)');
    } catch (e) {
      console.error('[Calss] dump pdf-runs failed: ' + (e as Error).message);
    }
  }

  /** pdf.js 回传（在 UI 线程回调）。按 `pdfPurpose` 分流：spike 展示 / 导入解析 */
  private onPdfPayload(payload: string): void {
    const result = PdfRunText.parse(payload);
    if (this.pdfPurpose === 'import') {
      this.onImportPayload(result);
      return;
    }
    const lines: SpikeLine[] = [];
    const head: SpikeLine = {
      label: 'pdf.js 回传',
      ok: result.ok,
      detail: result.ok
        ? `${result.pageCount} 页 / ${result.runs.length} 个文本片段` +
          (result.malformed > 0 ? `（${result.malformed} 行格式不符被跳过）` : '')
        : result.error,
    };
    lines.push(head);

    if (result.ok && result.runs.length > 0) {
      const parts: string[] = [];
      const n: number = Math.min(5, result.runs.length);
      for (let i = 0; i < n; i++) {
        const r = result.runs[i];
        parts.push(`${r.page}(${Math.round(r.x)},${Math.round(r.y)})"${r.text}"`);
      }
      const sample: SpikeLine = { label: '片段样本（页(x,y)）', ok: true, detail: parts.join(' ') };
      lines.push(sample);

      const grid: ParseResult = GridFormatParser.parse(result.runs);
      lines.push({
        label: 'GridFormatParser（网格版式）',
        ok: grid.courses.length > 0,
        detail: `${grid.courses.length} 门` + (grid.warnings.length > 0 ? ' · ' + grid.warnings.join(' / ') : ''),
      });

      const list: ParseResult = ListFormatParser.parse(result.runs);
      lines.push({
        label: 'ListFormatParser（列表版式）',
        ok: list.courses.length > 0,
        detail: `${list.courses.length} 门` + (list.warnings.length > 0 ? ' · ' + list.warnings.join(' / ') : ''),
      });

      const best: ParseResult = grid.courses.length >= list.courses.length ? grid : list;
      if (best.courses.length > 0) {
        const c = best.courses[0];
        const s = c.schedules[0];
        lines.push({
          label: '首门课',
          ok: true,
          detail: `${c.name} · 周${s.dayOfWeek} 第 ${s.startPeriod}-${s.endPeriod} 节 · 周次 ${WeekMasks.format(s.weekMask)} · ${c.location}`,
        });
      }
    }
    this.pdfLines = lines;
    this.pdfRunning = false;
  }

  // ---------------------------------------------------------------- 导入课表

  /**
   * 选 PDF → 读字节 → 交给 pdf.js。用户取消不算错误
   *
   * 外层挡一道重入：`importBusy` 要等文件选择器返回后才置位，
   * 这期间按钮还是可点的。连点两次会跑两条解析链，而 `pdfPurpose` 与
   * `window.__pdfResult` 都是单份的 —— 两次的结果会互相串味（A 的文件解析出 B 的课）。
   */
  private async startImport(): Promise<void> {
    if (this.importStarting) {
      return;
    }
    this.importStarting = true;
    try {
      await this.startImportInner();
    } finally {
      this.importStarting = false;
    }
  }

  private async startImportInner(): Promise<void> {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return;
    }
    let picked: PickedPdf | null = null;
    try {
      picked = await PdfFile.pick(ctx as common.UIAbilityContext);
    } catch (e) {
      const err = e as Error;
      this.importOpen = true;
      this.importError = '打开文件选择器失败：' + err.message;
      return;
    }
    if (picked === null) {
      return;
    }

    this.importOpen = true;
    this.importBusy = true;
    this.importError = '';
    this.importStage = '读取文件…';
    this.importFileName = picked.name;
    this.importFormat = '';
    this.importCount = 0;
    this.importPreview = [];
    this.importWarnings = [];
    this.importCourses = [];

    try {
      const base64: string = await PdfFile.readBase64(picked.uri, picked.size);
      // 首次导入要先创建 WebView 并加载 pdf.js（这台模拟器实测十几秒），把原因说清楚
      this.importStage = this.webReady ? '解析中…' : '准备解析器（首次较慢）…';
      const ready: boolean = await this.ensureWeb();
      if (!ready) {
        throw new Error('解析器加载失败（30 秒内没就绪），请重试');
      }
      this.importStage = '解析中…';
      this.pdfPurpose = 'import';
      // 先清掉上一次的结果，否则轮询第一轮就读到旧文件的 payload（把 A 的课当成 B 的导进去）
      await this.runJs(PdfJs.CLEAR_SCRIPT);
      this.webController.runJavaScript(PdfJs.extractCall(base64));
      const payload: string = await this.pollPdfResult(60000);
      if (payload.length === 0) {
        throw new Error('解析超时（60 秒内没有结果）');
      }
      // 开发期：把 pdf.js 的原样回传存进沙箱，`hdc file recv` 拉回桌面就能离线复现
      // （真实课表版式千奇百怪，只靠"装到设备看预览前 6 行"复盘太慢）
      if (BuildProfile.DEBUG) {
        Index.dumpRunsForDebug(ctx as common.UIAbilityContext, payload);
      }
      this.onPdfPayload(payload);
    } catch (e) {
      const err = e as Error;
      this.importBusy = false;
      this.importError = err.message;
    }
  }

  /** pdf.js 回传 → 选解析器 → 生成预览（**不写库**，等用户点按钮） */
  private onImportPayload(result: PdfExtractResult): void {
    if (!result.ok) {
      this.importBusy = false;
      this.importError = '解析失败：' + result.error;
      return;
    }
    if (result.runs.length === 0) {
      this.importBusy = false;
      this.importError = '这份 PDF 里没有可读文字（可能是扫描件）。扫描件请用"图片导入"。';
      return;
    }

    // 两种版式都试，取认出的课更多的那个（与 Android 的自动判断一致）
    const grid: ParseResult = GridFormatParser.parse(result.runs);
    const list: ParseResult = ListFormatParser.parse(result.runs);
    const best: ParseResult = grid.courses.length >= list.courses.length ? grid : list;

    if (best.courses.length === 0) {
      this.importBusy = false;
      this.importError = '认不出课表结构：' + (best.warnings.length > 0 ? best.warnings.join('；') : '未匹配到任何课程');
      return;
    }

    // 解析器是"一格一条"输出：一门课上两次会产出两条 RawCourse，必须按
    // 「名称+教师+地点」归并成一门课多时段（Android 的 merge() 就是干这个）
    const merged: MergeOutcome = mergeCourseItems(this.toImportItems(best));
    this.importCourses = merged.items;
    this.importFormat = best.format;
    this.importCount = this.importCourses.length;
    const warnings: string[] = best.warnings.slice();
    if (merged.dropped.length > 0) {
      // 没有一条能画的时段（周次一个都没认出来）—— 留在库里就是"看不见的数据"
      const names: string = merged.dropped.slice(0, 3).join('、');
      warnings.push(
        '有 ' + merged.dropped.length + ' 门课没认出上课周次，已跳过：' + names +
          (merged.dropped.length > 3 ? ' 等' : '')
      );
    }
    this.importWarnings = warnings;

    const preview: string[] = [];
    const n: number = Math.min(6, this.importCourses.length);
    for (let i = 0; i < n; i++) {
      const item: CourseWithSchedules = this.importCourses[i];
      const s: CourseSchedule | null = item.schedules.length > 0 ? item.schedules[0] : null;
      let line: string = item.course.name;
      if (s !== null) {
        line += ` · 周${s.dayOfWeek} ${s.startPeriod}-${s.endPeriod} 节 · ${WeekMasks.format(BigInt(s.weekMask))}`;
      } else {
        line += ' · 无时段';
      }
      preview.push(line);
    }
    this.importPreview = preview;
    this.importBusy = false;
    this.importStage = '预览';
  }

  /** RawCourse（解析结果）→ 库模型 */
  private toImportItems(parsed: ParseResult): CourseWithSchedules[] {
    const out: CourseWithSchedules[] = [];
    for (const rc of parsed.courses) {
      const course: Course = {
        id: 0,
        timetableId: 0,
        name: rc.name,
        teacher: rc.teacher,
        location: rc.location,
        color: 0,
        category: rc.category,
        note: '',
      };
      const schedules: CourseSchedule[] = [];
      for (const rs of rc.schedules) {
        const s: CourseSchedule = {
          id: 0,
          courseId: 0,
          dayOfWeek: rs.dayOfWeek,
          startPeriod: rs.startPeriod,
          endPeriod: rs.endPeriod,
          weekMask: maskToDb(rs.weekMask),
          // 解析器给的是"这一次的教室"；课程那条也留着（旧界面/兜底显示用）
          location: rc.location,
          classGroup: rs.classGroup,
        };
        schedules.push(s);
      }
      const item: CourseWithSchedules = { course: course, schedules: schedules };
      out.push(item);
    }
    return out;
  }

  /**
   * 按用户选择落库。
   * - replace：清空当前课表的课程（**不动自定义安排**）
   * - merge：按「名称+教师+地点」更新时段，其余新增
   * - new：新建一张课表（沿用当前学期的开学日与周数、复制作息），导进去并切过去
   */
  private async applyImport(mode: string): Promise<void> {
    if (this.importBusy || this.importCourses.length === 0) {
      return;
    }
    this.importBusy = true;
    this.importStage = '写入中…';
    try {
      const store: ScheduleStore = await this.openStore();
      if (mode === 'replace') {
        await store.replaceCourses(this.importCourses);
      } else if (mode === 'merge') {
        const r = await store.mergeCourses(this.importCourses);
        this.getUIContext().getPromptAction().showToast({ message: `合并完成：新增 ${r.added} 门，更新 ${r.updated} 门`, duration: 2000 });
      } else {
        const snap: Snapshot = await store.snapshot();
        const start: number = snap.timetable === null
          ? WeekCalculator.mondayOfEpochDay(WeekCalculator.todayEpochDay())
          : snap.timetable.startDateEpochDay;
        const weeks: number = snap.timetable === null ? 20 : snap.timetable.totalWeeks;
        const fromId: number = store.currentId;
        const name: string = this.importFileName.length > 0
          ? this.importFileName.replace('.pdf', '')
          : '导入的课表';
        await store.createTimetable(name, start, weeks, fromId, Date.now());
        await store.replaceCourses(this.importCourses);
      }
      // **先刷新再关面板**：写库那一刻课程 id 全变了，而网格还是旧的 weeks。
      // 先关面板的话，用户紧接着点色块会拿到"旧 id + 新库"的组合 ——
      // 详情卡上出现"课名是 A、教师/教室是 B"的串课（实测在模拟器上真的会看到）。
      this.importStage = '刷新中…';
      this.pdfPurpose = 'spike';
      await this.load();
      this.importOpen = false;
      this.importBusy = false;
    } catch (e) {
      const err = e as Error;
      this.importBusy = false;
      this.pdfPurpose = 'spike';
      this.importError = '写入失败：' + err.message;
      this.importStage = '预览';
    }
  }

  private closeImport(): void {
    if (this.importBusy) {
      return;
    }
    this.importOpen = false;
    this.importError = '';
    this.pdfPurpose = 'spike';
  }

  // ---------------------------------------------------------------- 作息/课表：动作

  onBackPress(): boolean {
    // 从最上面那层往下关，最后才交给系统退出。
    // 顺序错了症状很具体：填了一半的课程表单，按一下返回就直接回桌面（输入全丢）
    if (this.editorOpen) {
      this.editorOpen = false;
      return true;
    }
    if (this.semesterOpen) {
      this.semesterOpen = false;
      return true;
    }
    if (this.textDialog.length > 0) {
      this.textDialog = '';
      return true;
    }
    if (this.importOpen) {
      // 正在解析/写库时把返回吞掉：面板看起来还在，但后台已经在写，
      // 这时候"关掉"最容易被理解成"取消了"
      if (!this.importBusy) {
        this.closeImport();
      }
      return true;
    }
    if (this.detailTitle.length > 0) {
      this.closeDetail();
      return true;
    }
    if (this.showDev) {
      this.showDev = false;
      return true;
    }
    if (this.screen !== 'home') {
      this.screen = 'home';
      this.textDialog = '';
      return true;
    }
    return false;
  }

  private async openTimetables(): Promise<void> {
    try {
      const store: ScheduleStore = await this.openStore();
      this.timetables = await store.allTimetables();
      this.openPrimaryOnLaunch = await this.readOpenPrimary(store);
      this.screen = 'timetables';
    } catch (e) {
      const err = e as Error;
      this.getUIContext().getPromptAction().showToast({ message: '读取课表列表失败：' + err.message, duration: 2000 });
    }
  }

  /** "启动时总是打开主课表"开关的当前值（偏好表里是 '1'/'0'） */
  private async readOpenPrimary(store: ScheduleStore): Promise<boolean> {
    const db: Rdb | null = this.db;
    if (db === null) {
      return false;
    }
    const rows = await db.query("SELECT value FROM preferences WHERE key = 'open_primary_on_launch'");
    return rows.length > 0 && rows[0].text('value') === '1';
  }

  private storeCurrentId(): number {
    const s: ScheduleStore | null = this.store;
    return s === null ? 0 : s.currentId;
  }

  private currentTimetableName(): string {
    for (const t of this.timetables) {
      if (t.id === this.storeCurrentId()) {
        return t.name;
      }
    }
    const snap: Snapshot | null = this.snapshot;
    return snap === null || snap.timetable === null ? '' : snap.timetable.name;
  }

  private async switchTimetable(id: number): Promise<void> {
    try {
      const store: ScheduleStore = await this.openStore();
      await store.switchTo(id);
      this.screen = 'home';
      await this.load();
    } catch (e) {
      const err = e as Error;
      this.getUIContext().getPromptAction().showToast({ message: '切换失败：' + err.message, duration: 2000 });
    }
  }

  private async markPrimary(): Promise<void> {
    try {
      const store: ScheduleStore = await this.openStore();
      await store.setPrimary(store.currentId);
      this.timetables = await store.allTimetables();
      this.getUIContext().getPromptAction().showToast({ message: '已设为主课表', duration: 1500 });
    } catch (e) {
      const err = e as Error;
      this.getUIContext().getPromptAction().showToast({ message: '设置失败：' + err.message, duration: 2000 });
    }
  }

  private async setOpenPrimary(isOn: boolean): Promise<void> {
    try {
      const store: ScheduleStore = await this.openStore();
      await store.setOpenPrimaryOnLaunch(isOn);
      this.openPrimaryOnLaunch = isOn;
    } catch (e) {
      const err = e as Error;
      this.getUIContext().getPromptAction().showToast({ message: '保存失败：' + err.message, duration: 2000 });
    }
  }

  private confirmDeleteTimetable(): void {
    const name: string = this.currentTimetableName();
    this.getUIContext().showAlertDialog({
      title: '删除课表',
      message: `确定删除《${name}》？它的课程、作息、自定义安排都会一起删掉，且不能撤销。`,
      primaryButton: {
        value: '取消',
        action: () => {
        },
      },
      secondaryButton: {
        value: '删除',
        fontColor: '#C62828',
        action: () => {
          this.deleteCurrentTimetable();
        },
      },
    });
  }

  private async deleteCurrentTimetable(): Promise<void> {
    try {
      const store: ScheduleStore = await this.openStore();
      const id: number = store.currentId;
      await store.deleteTimetable(id, Date.now());
      this.screen = 'home';
      await this.load();
    } catch (e) {
      const err = e as Error;
      this.getUIContext().getPromptAction().showToast({ message: '删除失败：' + err.message, duration: 2000 });
    }
  }

  private async confirmTextDialog(): Promise<void> {
    const name: string = this.textValue.trim();
    const mode: string = this.textDialog;
    if (name.length === 0) {
      this.getUIContext().getPromptAction().showToast({ message: '名字不能为空', duration: 1500 });
      return;
    }
    try {
      const store: ScheduleStore = await this.openStore();
      if (mode === 'create') {
        const snap: Snapshot = await store.snapshot();
        const start: number = snap.timetable === null
          ? WeekCalculator.mondayOfEpochDay(WeekCalculator.todayEpochDay())
          : snap.timetable.startDateEpochDay;
        const weeks: number = snap.timetable === null ? 20 : snap.timetable.totalWeeks;
        await store.createTimetable(name, start, weeks, store.currentId, Date.now());
        this.screen = 'home';
        this.textDialog = '';
        await this.load();
        return;
      }
      await store.renameTimetable(store.currentId, name);
      this.timetables = await store.allTimetables();
      this.textDialog = '';
    } catch (e) {
      const err = e as Error;
      this.getUIContext().getPromptAction().showToast({ message: '保存失败：' + err.message, duration: 2000 });
    }
  }

  /** 点时间 → 系统时间选择器 → 写回这一节 */
  private pickSlotTime(slot: TimeSlot, isStart: boolean): void {
    const current: number = isStart ? slot.startMinute : slot.endMinute;
    const now: Date = new Date();
    const selected: Date = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
      Math.floor(current / 60), current % 60, 0);
    this.getUIContext().showTimePickerDialog({
      selected: selected,
      useMilitaryTime: true,
      onAccept: (value: TimePickerResult) => {
        const minute: number = value.hour * 60 + value.minute;
        this.applySlotTime(slot, isStart ? minute : slot.startMinute, isStart ? slot.endMinute : minute);
      },
    });
  }

  private async applySlotTime(slot: TimeSlot, startMinute: number, endMinute: number): Promise<void> {
    if (endMinute <= startMinute) {
      this.getUIContext().getPromptAction().showToast({ message: '结束时间要晚于开始时间', duration: 2000 });
      return;
    }
    this.slotsBusy = true;
    try {
      const store: ScheduleStore = await this.openStore();
      await store.saveSlot({
        id: slot.id,
        timetableId: slot.timetableId,
        periodIndex: slot.periodIndex,
        label: slot.label,
        startMinute: startMinute,
        endMinute: endMinute,
      });
      await this.load();
    } catch (e) {
      const err = e as Error;
      this.getUIContext().getPromptAction().showToast({ message: '保存失败：' + err.message, duration: 2000 });
    }
    this.slotsBusy = false;
  }

  /** 加一节：接在最后一节后面（隔 5 分钟），默认 45 分钟 */
  private async addSlot(): Promise<void> {
    this.slotsBusy = true;
    try {
      const store: ScheduleStore = await this.openStore();
      const slots: TimeSlot[] = await store.readSlotsOf(store.currentId);
      let lastEnd = 8 * 60;
      let maxPeriod = 0;
      for (const s of slots) {
        if (s.endMinute > lastEnd) {
          lastEnd = s.endMinute;
        }
        if (s.periodIndex > maxPeriod) {
          maxPeriod = s.periodIndex;
        }
      }
      const start: number = Math.min(lastEnd + 5, 23 * 60);
      const end: number = Math.min(start + 45, 23 * 60 + 59);
      await store.saveSlot({
        id: 0,
        timetableId: 0,
        periodIndex: maxPeriod + 1,
        label: '',
        startMinute: start,
        endMinute: end,
      });
      await this.load();
    } catch (e) {
      const err = e as Error;
      this.getUIContext().getPromptAction().showToast({ message: '加一节失败：' + err.message, duration: 2000 });
    }
    this.slotsBusy = false;
  }

  /** 删除后**重新编号**，否则节次会出现空洞（网格按节次画行） */
  private async deleteSlot(slot: TimeSlot): Promise<void> {
    this.slotsBusy = true;
    try {
      const store: ScheduleStore = await this.openStore();
      const slots: TimeSlot[] = await store.readSlotsOf(store.currentId);
      const kept: TimeSlot[] = [];
      for (const s of slots) {
        if (s.id !== slot.id) {
          kept.push(s);
        }
      }
      const renumbered: TimeSlot[] = [];
      let index = 1;
      for (const s of kept) {
        renumbered.push({
          id: s.id,
          timetableId: s.timetableId,
          periodIndex: index,
          label: s.label,
          startMinute: s.startMinute,
          endMinute: s.endMinute,
        });
        index++;
      }
      await store.replaceSlots(renumbered);
      await this.load();
    } catch (e) {
      const err = e as Error;
      this.getUIContext().getPromptAction().showToast({ message: '删除失败：' + err.message, duration: 2000 });
    }
    this.slotsBusy = false;
  }

  private async resetSlots(): Promise<void> {
    this.slotsBusy = true;
    try {
      const store: ScheduleStore = await this.openStore();
      await store.resetSlots();
      await this.load();
    } catch (e) {
      const err = e as Error;
      this.getUIContext().getPromptAction().showToast({ message: '恢复失败：' + err.message, duration: 2000 });
    }
    this.slotsBusy = false;
  }

  // ---------------------------------------------------------------- 交互

  private goToWeek(week: number): void {
    const target: number = WeekSelection.clamp(week, this.totalWeeks);
    // 换了周，详情卡描述的就是"上一周的某门课"了：直接收起，别留一张对不上的卡
    this.closeDetail();
    if (target === this.selectedWeek) {
      return;
    }
    this.selectedWeek = target;
    this.followingCurrentWeek = false;
    this.autoScrolling = true;
    this.controller.changeIndex(WeekSelection.pageOf(target), true);
    setTimeout(() => {
      this.autoScrolling = false;
    }, WeekSelection.ANIMATION_GUARD_MS);
  }

  private goToCurrentWeek(): void {
    const target: number = WeekSelection.initialWeek(this.currentWeek, this.totalWeeks);
    this.selectedWeek = target;
    this.followingCurrentWeek = true;
    this.autoScrolling = true;
    this.controller.changeIndex(WeekSelection.pageOf(target), true);
    setTimeout(() => {
      this.autoScrolling = false;
    }, WeekSelection.ANIMATION_GUARD_MS);
  }

  // ---------------------------------------------------------------- 课程编辑

  /** 点空白格：新建课程，预填这一格的星期与节次 */
  private onCellTap(dayOfWeek: number, period: number): void {
    this.editorCourseId = 0;
    this.editorTitle = '添加课程';
    this.editorName = '';
    this.editorTeacher = '';
    this.editorLocation = '';
    this.editorRows = [CourseDraft.newRow(dayOfWeek, period, this.periodCount)];
    this.closeDetail();
    this.editorOpen = true;
  }

  /** 编辑已有课程：把它现有的每一段时段都填进表单 */
  private openCourseEditorById(courseId: number): void {
    const snap: Snapshot | null = this.snapshot;
    const course: Course | null = this.findCourse(courseId);
    if (snap === null || course === null) {
      this.getUIContext().getPromptAction().showToast({ message: '这门课已经不在课表里了', duration: 1500 });
      return;
    }
    const rows: DraftRow[] = [];
    for (const s of snap.schedules) {
      if (s.courseId !== courseId) {
        continue;
      }
      rows.push(
        CourseDraft.row(
          s.dayOfWeek,
          s.startPeriod,
          s.endPeriod,
          WeekMasks.format(maskFromDb(s.weekMask)),
          s.location,
          s.classGroup
        )
      );
    }
    if (rows.length === 0) {
      // 理论上不会有：课程没有时段就是画不出来的孤儿行。真遇到了也要能编辑
      rows.push(CourseDraft.newRow(1, 1, this.periodCount));
    }
    this.editorCourseId = courseId;
    this.editorTitle = '编辑课程';
    this.editorName = course.name;
    this.editorTeacher = course.teacher;
    this.editorLocation = course.location;
    this.editorRows = rows;
    this.closeDetail();
    this.editorOpen = true;
  }

  private async saveCoursePayload(payload: CourseDraftPayload): Promise<void> {
    const store: ScheduleStore | null = this.store;
    if (store === null) {
      this.getUIContext().getPromptAction().showToast({ message: '数据还没就绪，稍后再试', duration: 1500 });
      return;
    }
    // 编辑时保留本面板不编辑的字段（配色/类别/备注）：
    // 从 PDF 导入的课类别存在 category 里，不能因为改了一次教师就被清空
    const base: Course | null = this.findCourse(this.editorCourseId);
    const course: Course = {
      id: this.editorCourseId,
      timetableId: base === null ? this.currentTimetableId() : base.timetableId,
      name: payload.name,
      teacher: payload.teacher,
      location: payload.location,
      color: base === null ? 0 : base.color,
      category: base === null ? '' : base.category,
      note: base === null ? '' : base.note,
    };
    try {
      // maskToDb 也放进 try：越界时它会抛错，放在 try 外面就变成 unhandled rejection，
      // 界面表现是"点了保存什么都没发生"（没有 toast、表单也不动）
      const schedules: CourseSchedule[] = [];
      for (const s of payload.schedules) {
        schedules.push({
          id: 0,
          courseId: 0,
          dayOfWeek: s.dayOfWeek,
          startPeriod: s.startPeriod,
          endPeriod: s.endPeriod,
          weekMask: maskToDb(s.weekMask),
          location: s.location,
          classGroup: s.classGroup,
        });
      }
      await store.saveCourse(course, schedules);
      this.editorOpen = false;
      await this.refreshAfterEdit();
      // 当前看的这一周可能没有这门课（比如把周次改成 1-8，而你正停在第 9 周）：
      // 跳到它第一次出现的那一周，否则用户会以为"保存了但什么都没发生"
      let union: bigint = 0n;
      for (const s of payload.schedules) {
        union = union | s.weekMask;
      }
      if (!WeekMasks.contains(union, this.selectedWeek)) {
        for (let w = 1; w <= this.totalWeeks; w++) {
          if (WeekMasks.contains(union, w)) {
            this.goToWeek(w);
            break;
          }
        }
      }
      this.getUIContext().getPromptAction().showToast({
        message: this.editorCourseId > 0 ? '已更新：' + payload.name : '已添加：' + payload.name,
        duration: 1500,
      });
      this.editorCourseId = 0;
    } catch (e) {
      this.getUIContext().getPromptAction().showToast({ message: '保存失败：' + (e as Error).message, duration: 2500 });
    }
  }

  private async deleteEditedCourse(): Promise<void> {
    const store: ScheduleStore | null = this.store;
    const id: number = this.editorCourseId;
    if (store === null || id <= 0) {
      return;
    }
    try {
      await store.deleteCourse(id);
      this.editorOpen = false;
      this.editorCourseId = 0;
      await this.refreshAfterEdit();
      this.getUIContext().getPromptAction().showToast({ message: '已删除该课程', duration: 1500 });
    } catch (e) {
      this.getUIContext().getPromptAction().showToast({ message: '删除失败：' + (e as Error).message, duration: 2500 });
    }
  }

  /**
   * 这个色块"这一次"的教室：找它对应的那条时段，教室为空时退回课程地点。
   * 与 `WeekItems.locationOf` 是同一套规则（格子里显示的也是它）。
   */
  private roomOfItem(item: WeekItem, course: Course | null): string {
    const snap: Snapshot | null = this.snapshot;
    if (snap !== null) {
      for (const s of snap.schedules) {
        if (
          s.courseId === item.id && s.dayOfWeek === item.dayOfWeek &&
          s.startPeriod === item.startPeriod && s.endPeriod === item.endPeriod
        ) {
          if (s.location.trim().length > 0) {
            return s.location;
          }
          break;
        }
      }
    }
    return course === null ? '' : course.location;
  }

  private findCourse(id: number): Course | null {    const snap: Snapshot | null = this.snapshot;
    if (snap === null || id <= 0) {
      return null;
    }
    for (const c of snap.courses) {
      if (c.id === id) {
        return c;
      }
    }
    return null;
  }

  private currentTimetableId(): number {
    const snap: Snapshot | null = this.snapshot;
    return snap === null || snap.timetable === null ? 0 : snap.timetable.id;
  }

  private closeDetail(): void {
    this.detailTitle = '';
    this.detailLines = [];
    this.detailCourseId = 0;
  }

  // ---------------------------------------------------------------- 学期设置

  private openSemester(): void {
    this.semesterStartText = WeekCalculator.isoDate(this.semesterStart);
    this.semesterWeeksText = String(this.totalWeeks);
    this.semesterError = '';
    this.semesterOpen = true;
  }

  private async applySemester(): Promise<void> {
    const store: ScheduleStore | null = this.store;
    const id: number = this.currentTimetableId();
    if (store === null || id === 0) {
      this.semesterError = '课表还没打开，稍后再试';
      return;
    }
    // 宽容：2026/9/7、2026.9.7、20260907 都认
    const iso: string | null = InputNorm.date(this.semesterStartText);
    if (iso === null) {
      this.semesterError = '开学日填不对。用 2026-09-07 这种写法';
      return;
    }
    const epochDay: number | null = WeekCalculator.epochDayOfIso(iso);
    if (epochDay === null) {
      this.semesterError = '这一天不存在：' + iso;
      return;
    }
    const weeks: number | null = InputNorm.int(this.semesterWeeksText);
    if (weeks === null || weeks < MIN_TOTAL_WEEKS || weeks > MAX_TOTAL_WEEKS) {
      this.semesterError = '总周数要填 ' + MIN_TOTAL_WEEKS + ' 到 ' + MAX_TOTAL_WEEKS + ' 之间的整数';
      return;
    }
    try {
      await store.updateTimetableSemester(id, epochDay, weeks);
      this.semesterOpen = false;
      await this.refreshAfterEdit();
      // 开学日变了，"第几周"就变了：直接跳回本周，别停在原来那一页
      this.goToCurrentWeek();
      this.getUIContext().getPromptAction().showToast({ message: '学期设置已更新', duration: 1500 });
    } catch (e) {
      this.semesterError = '保存失败：' + (e as Error).message;
    }
  }

  /** 数据（课程/学期/作息）变了之后重算派生状态；不动 selectedWeek，除非它已越界 */
  private async refreshAfterEdit(): Promise<void> {
    const store: ScheduleStore | null = this.store;
    if (store === null) {
      return;
    }
    const snap: Snapshot = await store.snapshot();
    this.snapshot = snap;
    const total: number = snap.timetable === null ? 20 : Math.max(1, snap.timetable.totalWeeks);
    const start: number = snap.timetable === null ? 0 : snap.timetable.startDateEpochDay;
    this.todayEpochDay = WeekCalculator.todayEpochDay();
    this.totalWeeks = total;
    this.semesterStart = start;
    this.currentWeek = Math.min(Math.max(WeekCalculator.currentWeek(start, this.todayEpochDay), 1), total);
    if (this.selectedWeek > total) {
      this.selectedWeek = total;
    }
    this.weeks = WeekItems.build({
      courses: Index.toCourseLikes(snap.courses),
      schedules: Index.toScheduleLikes(snap),
      events: Index.toEventLikes(snap),
      totalWeeks: total,
    });
    this.periodCount = WeekItems.periodCount(snap.slots, this.weeks);
  }

  private onItemTap(item: WeekItem): void {
    this.detailCourseId = 0;
    if (item.kind === WeekItems.KIND_EVENT) {
      this.detailTitle = item.title;
      this.detailLines = ['自定义安排', '备注：' + (item.subtitle.length === 0 ? '（无）' : item.subtitle)];
      return;
    }
    this.detailCourseId = item.id;
    const found: Course | null = this.findCourse(item.id);
    // 防御：id 能找到课程、但名字对不上，说明这份 `weeks` 是旧快照（刚写完库、网格还没重建）。
    // 这种情况下宁可不显示教师/教室，也不要把另一门课的信息安在这一格上。
    const course: Course | null = found !== null && found.name === item.title ? found : null;
    // v3：教室跟着时段走，详情里要显示**这一次**的教室（同一门课两次换楼很正常）
    const room: string = this.roomOfItem(item, course);
    this.detailTitle = item.title;
    this.detailLines = [
      '周' + ['一', '二', '三', '四', '五', '六', '日'][item.dayOfWeek - 1] +
        ` 第 ${item.startPeriod}-${item.endPeriod} 节`,
      '教师：' + (course === null || course.teacher.length === 0 ? '（未填）' : course.teacher),
      '教室：' + (room.length === 0 ? '（未填）' : room),
      '周次：' + this.weekMaskTextOf(item),
    ];
    if (item.conflicts.length > 0) {
      this.detailLines.push('⚠ 与《' + item.conflicts.join('》《') + '》时间重叠');
    }
  }

  // ---------------------------------------------------------------- 加载

  private async load(): Promise<void> {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      this.loading = false;
      this.errorLine = '拿不到 Context';
      return;
    }
    try {
      const db: Rdb = await Rdb.open(ctx);
      await db.ensureUpToDate(
        Date.now(),
        WeekCalculator.mondayOfEpochDay(WeekCalculator.todayEpochDay())
      );
      const store = new ScheduleStore(db);
      this.store = store;
      this.db = db;
      await store.ensureCurrentTimetable(Date.now());
      const snap: Snapshot = await store.snapshot();
      this.snapshot = snap;

      const total: number = snap.timetable === null
        ? 20
        : Math.max(1, snap.timetable.totalWeeks);
      const start: number = snap.timetable === null ? 0 : snap.timetable.startDateEpochDay;
      const rawCurrent: number = snap.timetable === null
        ? 1
        : WeekCalculator.currentWeek(start, this.todayEpochDay);

      this.totalWeeks = total;
      this.semesterStart = start;
      this.currentWeek = Math.min(Math.max(rawCurrent, 1), total);
      this.selectedWeek = WeekSelection.initialWeek(this.currentWeek, total);
      this.followingCurrentWeek = true;

      this.weeks = WeekItems.build({
        courses: Index.toCourseLikes(snap.courses),
        schedules: Index.toScheduleLikes(snap),
        events: Index.toEventLikes(snap),
        totalWeeks: total,
      });
      this.periodCount = WeekItems.periodCount(snap.slots, this.weeks);

      // 系统字体缩放：格子里的行数要用它来算（放大了就得少画几行，否则文字互相压）
      // getHostContext() 的静态类型是基类 Context，配置在 UIAbilityContext 上
      const abilityCtx = ctx as common.UIAbilityContext;
      const scale: number | undefined = abilityCtx.config.fontSizeScale;
      this.fontScale = scale === undefined || scale <= 0 ? 1 : scale;

      this.loading = false;
      this.ready = true;

      // 首帧对齐到当前周：这段时间 Swiper 可能报出"第 1 页"，不能当成用户选周
      this.autoScrolling = true;
      setTimeout(() => {
        this.autoScrolling = false;
      }, WeekSelection.ANIMATION_GUARD_MS);
    } catch (e) {
      const err = e as Error;
      this.loading = false;
      this.errorLine = err.message;
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

  /** spike：PDF 取文本 / 中文 OCR（结论决定阶段 3 导入怎么写） */
  private async runSpikes(): Promise<void> {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return;
    }
    this.spiking = true;
    this.spikeLines = [];
    try {
      this.spikeLines = await SpikeProbe.runAll(ctx as common.UIAbilityContext);
    } catch (e) {
      const err = e as Error;
      const line: SpikeLine = { label: 'spike 中断', ok: false, detail: err.message };
      this.spikeLines = [line];
    }
    this.spiking = false;
  }

  /** 开发者入口用：拿到当前库的 store */
  private async openStore(): Promise<ScheduleStore> {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      throw new Error('拿不到 Context');
    }
    const db: Rdb = await Rdb.open(ctx);
    await db.ensureUpToDate(
      Date.now(),
      WeekCalculator.mondayOfEpochDay(WeekCalculator.todayEpochDay())
    );
    const store = new ScheduleStore(db);
    await store.ensureCurrentTimetable(Date.now());
    return store;
  }

  /**
   * 写入 4 门示例课（开发者入口，用来验证网格渲染）。
   *
   * 故意让「软件工程」和「大学英语」撞在周一 3-4 节：这样才能看到**并排双道 + 冲突标记**，
   * 否则这个分支永远没有数据能验到。
   */
  private confirmWriteSamples(): void {
    // 这两个按钮动的是**真库**：都是开发期工具，但仍要二次确认 ——
    // 一次误触就往用户的课表里塞 4 门示例课/清空整张表，没有撤销
    this.getUIContext().showAlertDialog({
      title: '写入示例课',
      message: '会往当前课表插入 4 门示例课程（不删除已有课程）。确定吗？',
      primaryButton: {
        value: '取消',
        action: () => {
        },
      },
      secondaryButton: {
        value: '写入',
        action: () => {
          this.writeSamples();
        },
      },
    });
  }

  private confirmClearCourses(): void {
    this.getUIContext().showAlertDialog({
      title: '清空全部课程',
      message: '当前课表里的课程会全部删除（作息与自定义安排不动），不能撤销。',
      primaryButton: {
        value: '取消',
        action: () => {
        },
      },
      secondaryButton: {
        value: '清空',
        fontColor: '#C62828',
        action: () => {
          this.clearAllCourses();
        },
      },
    });
  }

  private async writeSamples(): Promise<void> {
    try {
      const store: ScheduleStore = await this.openStore();
      const everyWeek: number = maskToDb((BigInt(1) << BigInt(16)) - BigInt(1));
      const oddWeeks: number = maskToDb(BigInt(21845)); // 1,3,5…15 周

      await store.saveCourse(this.sampleCourse('软件工程', '张老师', '本部-计算机基础实验室-2(503-504)'), [
        this.sampleSchedule(1, 3, 4, everyWeek),
      ]);
      await store.saveCourse(this.sampleCourse('大学英语', '刘老师', '外语楼-202'), [
        this.sampleSchedule(1, 3, 4, everyWeek),
      ]);
      await store.saveCourse(this.sampleCourse('操作系统', '李老师', '思源楼-301'), [
        this.sampleSchedule(3, 5, 6, everyWeek),
      ]);
      await store.saveCourse(this.sampleCourse('高等数学', '王老师', '1-101'), [
        this.sampleSchedule(5, 1, 2, oddWeeks),
      ]);
      await this.load();
    } catch (e) {
      const err = e as Error;
      this.errorLine = '写入示例课失败：' + err.message;
    }
  }

  private async clearAllCourses(): Promise<void> {
    try {
      const store: ScheduleStore = await this.openStore();
      const snap: Snapshot = await store.snapshot();
      for (const c of snap.courses) {
        await store.deleteCourse(c.id);
      }
      await this.load();
    } catch (e) {
      const err = e as Error;
      this.errorLine = '清空失败：' + err.message;
    }
  }

  private sampleCourse(name: string, teacher: string, location: string): Course {
    const course: Course = {
      id: 0,
      timetableId: 0,
      name: name,
      teacher: teacher,
      location: location,
      color: 0,
      category: '',
      note: '',
    };
    return course;
  }

  private sampleSchedule(
    dayOfWeek: number,
    startPeriod: number,
    endPeriod: number,
    weekMask: number
  ): CourseSchedule {
    const schedule: CourseSchedule = {
      id: 0,
      courseId: 0,
      dayOfWeek: dayOfWeek,
      startPeriod: startPeriod,
      endPeriod: endPeriod,
      weekMask: weekMask,
      // 示例课（开发者入口）只用课程地点/班级，时段上的这两个字段留空
      location: '',
      classGroup: '',
    };
    return schedule;
  }

  // ---------------------------------------------------------------- 视图小工具

  private timetableName(): string {
    const snap: Snapshot | null = this.snapshot;
    if (snap === null || snap.timetable === null) {
      return '';
    }
    return snap.timetable.name + ' · ' + snap.timetable.totalWeeks + ' 周';
  }

  private slots(): TimeSlot[] {
    const snap: Snapshot | null = this.snapshot;
    return snap === null ? [] : snap.slots;
  }

  private weekNumbers(): number[] {
    const out: number[] = [];
    for (let w = 1; w <= this.totalWeeks; w++) {
      out.push(w);
    }
    return out;
  }

  /** 本周 7 天的 epochDay（周一→周日）；没有学期设置时返回空数组，表头只显示"周几" */
  private weekDates(week: number): number[] {
    if (this.semesterStart === 0) {
      return [];
    }
    const out: number[] = [];
    for (let i = 0; i < 7; i++) {
      out.push(this.semesterStart + (week - 1) * 7 + i);
    }
    return out;
  }

  private weekRangeText(): string {
    if (this.semesterStart === 0) {
      return '未设置开学日期';
    }
    const monday: number = this.semesterStart + (this.selectedWeek - 1) * 7;
    const sunday: number = monday + 6;
    const a = WeekCalculator.dateOf(monday);
    const b = WeekCalculator.dateOf(sunday);
    let text: string = `${a.month}/${a.day} – ${b.month}/${b.day}`;
    if (this.followingCurrentWeek) {
      text = text + ' · 本周';
    }
    return text;
  }

  private gridSummary(): string {
    return `${this.periodCount} 节`;
  }

  private isEmptyTimetable(): boolean {
    const snap: Snapshot | null = this.snapshot;
    return snap === null || (snap.courses.length === 0 && snap.events.length === 0);
  }

  private weekMaskTextOf(item: WeekItem): string {
    const snap: Snapshot | null = this.snapshot;
    if (snap === null) {
      return '';
    }
    for (const s of snap.schedules) {
      if (s.courseId === item.id && s.dayOfWeek === item.dayOfWeek &&
        s.startPeriod === item.startPeriod && s.endPeriod === item.endPeriod) {
        return WeekMasks.format(BigInt(s.weekMask));
      }
    }
    return '本周';
  }

  // ---------------------------------------------------------------- 模型转换

  /**
   * `data/models` 的对象换成 `logic` 需要的最小接口。
   * 显式逐字段翻译（不用展开运算符）：字段改名时编译期就会报，而不是运行期悄悄变成 undefined。
   */
  private static toCourseLikes(courses: Course[]): CourseLike[] {
    const out: CourseLike[] = [];
    for (const c of courses) {
      const like: CourseLike = {
        id: c.id,
        name: c.name,
        location: c.location,
        color: c.color,
      };
      out.push(like);
    }
    return out;
  }

  private static toScheduleLikes(snap: Snapshot): ScheduleLike[] {
    const out: ScheduleLike[] = [];
    for (const s of snap.schedules) {
      const like: ScheduleLike = {
        courseId: s.courseId,
        dayOfWeek: s.dayOfWeek,
        startPeriod: s.startPeriod,
        endPeriod: s.endPeriod,
        weekMask: s.weekMask,
        location: s.location,
      };
      out.push(like);
    }
    return out;
  }

  private static toEventLikes(snap: Snapshot): EventLike[] {
    const out: EventLike[] = [];
    for (const e of snap.events) {
      const like: EventLike = {
        id: e.id,
        title: e.title,
        dayOfWeek: e.dayOfWeek,
        startPeriod: e.startPeriod,
        endPeriod: e.endPeriod,
        weekMask: e.weekMask,
        color: e.color,
        note: e.note,
      };
      out.push(like);
    }
    return out;
  }
}










