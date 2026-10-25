import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import BuildProfile from 'BuildProfile';
import { webview } from '@kit.ArkWeb';
import {
  CourseDraft,
  EventDraft,
  ExifOrientation,
  GridFormatParser,
  InputNorm,
  ListFormatParser,
  Minutes,
  PdfRunText,
  SlotDraft,
  TimetableTextParser,
  WeekCalculator,
  WeekItems,
  WeekMasks,
  WeekSelection,
} from '../logic';
import {
  type CourseDraftPayload,
  type CourseLike,
  type DraftRow,
  type EventDraftResult,
  type EventLike,
  type OcrLine,
  type ParseResult,
  type PdfExtractResult,
  type RecognizedPeriod,
  type ScheduleLike,
  type SlotRow,
  type TimetableParseResult,
  type WeekItem,
} from '../logic';
import { Rdb } from '../platform/Rdb';
import { MigrationProbe, ProbeLine } from '../platform/MigrationProbe';
import { SpikeLine, SpikeProbe } from '../platform/SpikeProbe';
import { PdfJs } from '../platform/PdfJs';
import { PdfFile, PickedPdf } from '../platform/PdfFile';
import { Ocr, type OcrOutcome } from '../platform/Ocr';
import { ScheduleStore } from '../data/ScheduleStore';
import { mergeCourseItems, type MergeOutcome } from '../data/CourseMerge';
import {
  Course,
  CourseSchedule,
  CourseWithSchedules,
  CustomEvent,
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
import { EventEditor } from '../view/EventEditor';
import { SlotEditor } from '../view/SlotEditor';

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
  /** 详情卡对应的课程 id；0 = 当前这张卡不是课程（自定义安排或只有标题） */
  @State detailCourseId: number = 0;
  /** > 0 表示详情卡当前描述的是一条自定义安排（课程与安排不会同时成立） */
  @State detailEventId: number = 0;

  // ---------------- 点空白格：先问"课程还是自定义安排"
  @State addChoiceOpen: boolean = false;
  @State addChoiceDay: number = 1;
  @State addChoicePeriod: number = 1;

  // ---------------- 自定义安排编辑面板
  @State eventEditorOpen: boolean = false;
  @State eventEditorId: number = 0;
  @State eventHeading: string = '添加安排';
  @State eventTitle: string = '';
  @State eventNote: string = '';
  @State eventDay: number = 1;
  @State eventStart: number = 1;
  @State eventEnd: number = 2;
  @State eventWeeks: string = '1-16';
  /**
   * 编辑已有安排时**透传**的字段：颜色与自由钟点（startMinute/endMinute）。
   * 本版界面不编辑它们，但"编辑一次就被清空"是不行的 —— Android 侧同样用
   * `loaded.copy(...)` 保留。不是 `@State`：它们不参与任何渲染。
   */
  private eventColor: number = 0;
  private eventStartMinute: number | null = null;
  private eventEndMinute: number | null = null;

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
  /** 'home' | 'slots' | 'slotsimport' | 'timetables' —— 用状态切屏而不是路由：页面少，省掉一层导航栈 */
  @State screen: string = 'home';
  @State timetables: Timetable[] = [];
  @State slotsBusy: boolean = false;

  // ---------------- 节次编辑弹窗（作息页与导入校对页共用）
  @State slotEditorOpen: boolean = false;
  @State slotEditorHeading: string = '编辑节次';
  /** 'slot' = 改库里的作息；'review' = 改导入校对页里的行 */
  @State slotEditorTarget: string = 'slot';
  @State slotEditorSlotId: number = 0;
  @State slotEditorReviewIndex: number = -1;
  @State slotEditorPeriod: string = '1';
  @State slotEditorLabel: string = '';
  @State slotEditorStart: string = '8:00';
  @State slotEditorEnd: string = '8:45';
  @State slotEditorInferred: boolean = false;

  // ---------------- 从其他课表复制作息
  @State copySlotsOpen: boolean = false;

  // ---------------- 导入作息（三条通道 → 同一个校对页）
  /** 'idle' | 'parsing' | 'review' | 'error' | 'done' */
  @State slotImportPhase: string = 'idle';
  @State slotImportRows: SlotRow[] = [];
  @State slotImportWarnings: string[] = [];
  @State slotImportError: string = '';
  @State slotImportRaw: string[] = [];
  @State slotImportRawOpen: boolean = false;
  @State slotImportPasteOpen: boolean = false;
  @State slotImportPasteText: string = '';
  @State slotImportStage: string = '';
  /** 这次是从哪条通道进来的（出问题时知道该找谁） */
  @State slotImportSource: string = '';
  private slotImportStarting: boolean = false;

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
        } else if (this.screen === 'slotsimport') {
          this.slotsImportScreen()
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

      if (this.addChoiceOpen) {
        this.addChoiceCard()
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

      if (this.eventEditorOpen) {
        EventEditor({
          periodCount: this.periodCount,
          heading: this.eventHeading,
          initialTitle: this.eventTitle,
          initialNote: this.eventNote,
          initialDay: this.eventDay,
          initialStart: this.eventStart,
          initialEnd: this.eventEnd,
          initialWeeks: this.eventWeeks,
          canDelete: this.eventEditorId > 0,
          onSubmit: (result: EventDraftResult) => {
            this.saveEventPayload(result);
          },
          onDelete: () => {
            this.deleteEditedEvent();
          },
          onCancel: () => {
            this.eventEditorOpen = false;
          },
        })
      }

      if (this.slotEditorOpen) {
        SlotEditor({
          heading: this.slotEditorHeading,
          initialPeriod: this.slotEditorPeriod,
          initialLabel: this.slotEditorLabel,
          initialStart: this.slotEditorStart,
          initialEnd: this.slotEditorEnd,
          inferred: this.slotEditorInferred,
          canDelete: this.slotEditorTarget === 'slot' && this.slotEditorSlotId > 0,
          onSubmit: (row: SlotRow) => {
            this.submitSlotEditor(row);
          },
          onDelete: () => {
            this.deleteSlotFromEditor();
          },
          onCancel: () => {
            this.slotEditorOpen = false;
          },
        })
      }

      if (this.slotImportPasteOpen) {
        this.pasteSlotsCard()
      }

      if (this.slotImportRawOpen) {
        this.slotImportRawCard()
      }

      if (this.copySlotsOpen) {
        this.copySlotsCard()
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
          // 走 openSlots 而不是直接改 screen：顺带把课表列表读出来（"从其他课表复制"要用）
          this.openSlots();
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
        Text(this.isEmptyTimetable() ? '还没有课程或安排' : '本周')
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
        } else if (this.detailEventId > 0) {
          Text('编辑')
            .fontSize(12)
            .fontColor('#5B7C99')
            .onClick(() => {
              this.openEventEditorById(this.detailEventId);
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

  // ---------------------------------------------------------------- 点空白格：选类型

  /**
   * 点空格不直接开课程表单，先问一句"课程还是自定义安排"（与 Android 一致）。
   *
   * 为什么不直接开课程表单：课程和安排是两种完全不同的东西，而"点空格"是最常用的入口。
   * 默认进课程表单的话，想记一条"每周三健身"的人要先关掉课程表单再想办法。
   */
  @Builder
  addChoiceCard() {
    Column({ space: 10 }) {
      Row() {
        Text(CourseDraft.dayName(this.addChoiceDay) + ' · 第 ' + this.addChoicePeriod + ' 节')
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor('#3B3430')
          .layoutWeight(1)
        Text('取消')
          .fontSize(12)
          .fontColor('#E07A5F')
          .onClick(() => {
            this.addChoiceOpen = false;
          })
      }
      .width('100%')

      Text('在这个时间段添加什么？')
        .fontSize(12)
        .fontColor('#7A6E66')
        .width('100%')

      Row({ space: 8 }) {
        Button('课程')
          .fontSize(14)
          .height(40)
          .layoutWeight(1)
          .backgroundColor('#E07A5F')
          .onClick(() => {
            this.addChoiceOpen = false;
            this.openCourseEditorAt(this.addChoiceDay, this.addChoicePeriod);
          })
        Button('自定义安排')
          .fontSize(14)
          .height(40)
          .layoutWeight(1)
          .backgroundColor('#9A8C82')
          .onClick(() => {
            this.addChoiceOpen = false;
            this.openEventEditorAt(this.addChoiceDay, this.addChoicePeriod);
          })
      }
      .width('100%')
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

      Text('课表格子里的节次时间从这张表来。改完立即生效，课程数据不动。点任意一行可以改节次号、分组与起止时间。')
        .fontSize(10)
        .fontColor('#A89C93')
        .width('100%')
        .padding({ left: 16, right: 16 })

      List({ space: 6 }) {
        ForEach(this.slots(), (slot: TimeSlot) => {
          ListItem() {
            Row({ space: 8 }) {
              Column({ space: 2 }) {
                Row({ space: 6 }) {
                  Text('第 ' + slot.periodIndex + ' 节')
                    .fontSize(12)
                    .fontWeight(FontWeight.Medium)
                    .fontColor('#3B3430')
                  if (slot.label.trim().length > 0) {
                    Text(slot.label)
                      .fontSize(9)
                      .fontColor('#8A7A6E')
                      .backgroundColor('#F3E6DC')
                      .borderRadius(4)
                      .padding({ left: 4, right: 4, top: 1, bottom: 1 })
                  }
                }
                Text(Minutes.format(slot.startMinute) + ' - ' + Minutes.format(slot.endMinute) +
                  ' · ' + (slot.endMinute - slot.startMinute) + ' 分')
                  .fontSize(11)
                  .fontColor('#7A6E66')
              }
              .alignItems(HorizontalAlign.Start)
              .layoutWeight(1)

              Text('改')
                .fontSize(11)
                .fontColor('#5B7C99')
                .padding({ left: 6, right: 6 })
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
            .onClick(() => {
              this.openSlotEditorForSlot(slot);
            })
          }
        }, (slot: TimeSlot) => 'slot' + slot.id + '-' + slot.periodIndex + '-' + slot.startMinute + '-' + slot.endMinute)
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
            this.openSlotEditorForNew();
          })
        Button('导入作息')
          .fontSize(12)
          .height(34)
          .layoutWeight(1)
          .backgroundColor('#5B7C99')
          .enabled(!this.slotsBusy)
          .onClick(() => {
            this.openSlotsImport();
          })
      }
      .width('100%')
      .padding({ left: 12, right: 12 })

      Row({ space: 8 }) {
        if (this.timetables.length > 1) {
          Button('从其他课表复制')
            .fontSize(12)
            .height(34)
            .layoutWeight(1)
            .backgroundColor('#BDB3AB')
            .enabled(!this.slotsBusy)
            .onClick(() => {
              this.copySlotsOpen = true;
            })
        }
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

  // ---------------------------------------------------------------- 导入作息

  /**
   * 导入作息表：**三条通道 → 同一个校对页 → 整表替换**（与 Android 一致）。
   *
   * | 通道 | 依赖 | 这台模拟器上 |
   * |---|---|---|
   * | 识别图片 | 系统 Core Vision Kit（离线、不增体积） | 镜像里没有 OCR 后端，会给出可诊断的错误 |
   * | 粘贴文本 | 无 | 完整可用（实测通道） |
   * | 从 PDF 文件 | 包内 pdf.js（课程导入已经在用） | 完整可用 |
   *
   * 为什么必须先过校对页：识别不可能 100% 准。直接写库的话，用户看到的是一张
   * "时间微妙地错了"的课表，而且要一条条手改才能发现 —— 校对页把错误摆在他眼前。
   */
  @Builder
  slotsImportScreen() {
    Column({ space: 8 }) {
      this.screenHeader('导入作息表')

      if (this.slotImportPhase === 'idle') {
        this.slotImportIdle()
      } else if (this.slotImportPhase === 'parsing') {
        Column({ space: 10 }) {
          LoadingProgress().width(32).height(32).color('#E07A5F')
          Text(this.slotImportStage.length === 0 ? '处理中…' : this.slotImportStage)
            .fontSize(12)
            .fontColor('#7A6E66')
            .textAlign(TextAlign.Center)
        }
        .layoutWeight(1)
        .width('100%')
        .padding(24)
        .justifyContent(FlexAlign.Center)
      } else if (this.slotImportPhase === 'error') {
        Column({ space: 10 }) {
          Text('没能导入')
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .fontColor('#C62828')
          Text(this.slotImportError)
            .fontSize(12)
            .fontColor('#7A6E66')
            .textAlign(TextAlign.Center)
          if (this.slotImportRaw.length > 0) {
            Text('查看识别原文（' + this.slotImportRaw.length + ' 行）')
              .fontSize(12)
              .fontColor('#5B7C99')
              .onClick(() => {
                this.slotImportRawOpen = true;
              })
          }
          Row({ space: 8 }) {
            Button('再来一次')
              .fontSize(12)
              .height(34)
              .backgroundColor('#E07A5F')
              .onClick(() => {
                this.slotImportPhase = 'idle';
                this.slotImportError = '';
              })
            Button('手动改作息')
              .fontSize(12)
              .height(34)
              .backgroundColor('#BDB3AB')
              .onClick(() => {
                this.screen = 'slots';
              })
          }
        }
        .layoutWeight(1)
        .width('100%')
        .padding(24)
        .justifyContent(FlexAlign.Center)
      } else {
        this.slotImportReview()
      }
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  slotImportIdle() {
    Column({ space: 12 }) {
      Text('三条通道都先过校对页，核对无误再写入。应用时会整表替换当前课表的作息，课程数据不动。')
        .fontSize(11)
        .fontColor('#7A6E66')
        .textAlign(TextAlign.Center)

      Button('识别图片（相册）')
        .fontSize(14)
        .height(44)
        .width('100%')
        .backgroundColor('#E07A5F')
        .onClick(() => {
          this.startSlotImportImage();
        })
      Button('粘贴文本')
        .fontSize(14)
        .height(44)
        .width('100%')
        .backgroundColor('#5B7C99')
        .onClick(() => {
          this.slotImportPasteText = '';
          this.slotImportPasteOpen = true;
        })
      Button('从 PDF 文件')
        .fontSize(14)
        .height(44)
        .width('100%')
        .backgroundColor('#9A8C82')
        .onClick(() => {
          this.startSlotImportPdf();
        })

      Text('「粘贴文本」最稳：从网页、微信、或相册自带的文字识别里复制作息行即可，每行要同时包含节次号和起止时间，例如「1  8:00-8:45」。')
        .fontSize(10)
        .fontColor('#A89C93')
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .padding({ left: 24, right: 24, top: 24 })
  }

  @Builder
  slotImportReview() {
    Column({ space: 6 }) {
      Text('认出 ' + this.slotImportRows.length + ' 节（' + this.slotImportSource +
        '）。点任意一行可以改；确认无误再应用。')
        .fontSize(11)
        .fontColor('#7A6E66')
        .width('100%')
        .padding({ left: 16, right: 16 })

      ForEach(this.slotImportWarnings, (w: string) => {
        Text('注意：' + w)
          .fontSize(10)
          .fontColor('#C77B2B')
          .width('100%')
          .padding({ left: 16, right: 16 })
      }, (w: string, index: number) => 'warn' + index)

      // 与"当前作息有几节"的对比**现算**：补一节/删一行之后数字要跟着变，
      // 存进 warnings 里就会停在识别那一刻（实测校对页上补完一节还写着旧的数）
      if (this.slotImportMissingHint().length > 0) {
        Text('注意：' + this.slotImportMissingHint())
          .fontSize(10)
          .fontColor('#C77B2B')
          .width('100%')
          .padding({ left: 16, right: 16 })
      }

      List({ space: 4 }) {
        ForEach(this.slotImportRows, (row: SlotRow, index: number) => {
          ListItem() {
            Row({ space: 6 }) {
              Text(SlotDraft.describe(row))
                .fontSize(12)
                .fontColor('#3B3430')
                .layoutWeight(1)
              if (row.inferred) {
                Text('推断')
                  .fontSize(9)
                  .fontColor('#FFFFFF')
                  .backgroundColor('#C77B2B')
                  .borderRadius(4)
                  .padding({ left: 4, right: 4, top: 1, bottom: 1 })
              }
              Text('改')
                .fontSize(11)
                .fontColor('#5B7C99')
            }
            .width('100%')
            .padding({ left: 16, right: 16, top: 8, bottom: 8 })
            .backgroundColor('#FFFFFF')
            .borderRadius(8)
            .onClick(() => {
              this.openSlotEditorForReview(index);
            })
          }
        }, (row: SlotRow, index: number) =>
          'sir' + index + '-' + row.periodIndex + '-' + row.startMinute + '-' + row.endMinute + '-' + (row.inferred ? '1' : '0'))
      }
      .layoutWeight(1)
      .width('100%')
      .padding({ left: 12, right: 12 })
      .scrollBar(BarState.Off)

      Row({ space: 8 }) {
        Button('补一节')
          .fontSize(12)
          .height(34)
          .layoutWeight(1)
          .backgroundColor('#BDB3AB')
          .onClick(() => {
            this.addReviewSlotRow();
          })
        Button('取消')
          .fontSize(12)
          .height(34)
          .layoutWeight(1)
          .backgroundColor('#F3E6DC')
          .fontColor('#B4664C')
          .onClick(() => {
            this.screen = 'slots';
          })
        Button('应用到课表')
          .fontSize(12)
          .height(34)
          .layoutWeight(1)
          .backgroundColor('#E07A5F')
          .enabled(!this.slotsBusy)
          .onClick(() => {
            this.applySlotImport();
          })
      }
      .width('100%')
      .padding({ left: 12, right: 12, bottom: 12 })
    }
    .width('100%')
    .layoutWeight(1)
  }

  /** 识别原文：出问题时这是唯一能定位的线索（与 Android 的"查看识别原文"一致） */
  @Builder
  slotImportRawCard() {
    Column() {
      Column({ space: 8 }) {
        Row() {
          Text('识别原文')
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .fontColor('#3B3430')
            .layoutWeight(1)
          Text('关闭')
            .fontSize(12)
            .fontColor('#E07A5F')
            .onClick(() => {
              this.slotImportRawOpen = false;
            })
        }
        .width('100%')

        List({ space: 2 }) {
          ForEach(this.slotImportRaw, (line: string, index: number) => {
            ListItem() {
              Text(line)
                .fontSize(11)
                .fontColor('#5A4F48')
                .width('100%')
            }
          }, (line: string, index: number) => 'raw' + index)
        }
        .layoutWeight(1)
        .width('100%')
        .scrollBar(BarState.Auto)
      }
      .width('88%')
      .height('70%')
      .padding(16)
      .backgroundColor('#FFFFFF')
      .borderRadius(16)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor('#33000000')
  }

  /** 粘贴文本通道：多行输入框（ArkUI 的 TextArea），解析前不写库 */
  @Builder
  pasteSlotsCard() {
    Column() {
      Column({ space: 10 }) {
        Text('粘贴作息文本')
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor('#3B3430')
          .width('100%')

        Text('一行一节课，要同时有节次号和起止时间。')
          .fontSize(10)
          .fontColor('#A89C93')
          .width('100%')

        TextArea({ text: this.slotImportPasteText, placeholder: '1  8:00-8:45\n2  8:50-9:35\n3  9:55-10:40' })
          .fontSize(13)
          .height(150)
          .width('100%')
          .backgroundColor('#F6EFE8')
          .onChange((v: string) => {
            this.slotImportPasteText = v;
          })

        Row({ space: 8 }) {
          Blank()
          Text('取消')
            .fontSize(13)
            .fontColor('#7A6E66')
            .padding({ top: 8 })
            .onClick(() => {
              this.slotImportPasteOpen = false;
            })
          Text('解析')
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor('#E07A5F')
            .padding({ top: 8 })
            .onClick(() => {
              this.startSlotImportText();
            })
        }
        .width('100%')
      }
      .width('88%')
      .padding(16)
      .backgroundColor('#FFFFFF')
      .borderRadius(16)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor('#33000000')
  }

  /** 从其他课表复制作息（与 Android 的「从其他课表复制作息」一致） */
  @Builder
  copySlotsCard() {
    Column() {
      Column({ space: 8 }) {
        Row() {
          Text('从哪张课表复制')
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .fontColor('#3B3430')
            .layoutWeight(1)
          Text('取消')
            .fontSize(12)
            .fontColor('#E07A5F')
            .onClick(() => {
              this.copySlotsOpen = false;
            })
        }
        .width('100%')

        Text('会把当前课表的作息整表替换成所选课表的作息。')
          .fontSize(10)
          .fontColor('#A89C93')
          .width('100%')

        List({ space: 6 }) {
          ForEach(this.copyableTimetables(), (t: Timetable) => {
            ListItem() {
              // 课表可能重名（导入时按文件名起名，同名文件会造出两张）：把「主」标出来，
              // 至少能靠主课表区分一下
              Text(t.name + ' · ' + t.totalWeeks + ' 周' + (t.isPrimary ? ' · 主' : ''))
                .fontSize(13)
                .fontColor('#3B3430')
                .width('100%')
                .padding(10)
                .backgroundColor('#F6EFE8')
                .borderRadius(8)
                .onClick(() => {
                  this.copySlotsFrom(t);
                })
            }
          }, (t: Timetable) => 'copy' + t.id)
        }
        .width('100%')
        .constraintSize({ maxHeight: 260 })
        .scrollBar(BarState.Auto)
      }
      .width('88%')
      .padding(16)
      .backgroundColor('#FFFFFF')
      .borderRadius(16)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .backgroundColor('#33000000')
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
          // 导入页的上一级是作息页；其余二级页都回主页
          this.screen = this.screen === 'slotsimport' ? 'slots' : 'home';
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

  /**
   * 用完 pdf.js 就把它释放掉。
   *
   * 为什么值得做：只要 Web 组件在组件树里，进程就要为 ArkWeb 付 ~0.4s 的启动时间
   * （数字见 `docs/ACCEPTANCE.md` §1），并且常驻约 1.5 MB 的 pdf.js 与一个 worker。
   * 导入结束后没有任何理由留着它 —— 用户可能一整周都不再导入。
   *
   * 三个动作必须一起做，少一个就会出现"下一次导入卡住"：
   * 1. `webRequested = false`：组件真正从树上移除；
   * 2. `webReady = false`：否则下一次会以为解析器还活着；
   * 3. 换一个**新的** `WebviewController`：旧 controller 绑定的是已销毁的组件，
   *    对着它调 `runJavaScript` 只会丢回调（`ensureWeb` 会干等 30 秒）。
   *
   * 调用时机：所有 `pollPdfResult` 都已经返回之后（轮询中途销毁 = 结果丢失）。
   */
  private releaseWeb(): void {
    if (!this.webRequested) {
      return;
    }
    this.webRequested = false;
    this.webReady = false;
    this.webController = new webview.WebviewController();
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
    } finally {
      // spike 只跑一次，跑完就把 Web 放掉（与导入同样的理由）
      this.releaseWeb();
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
      // 回传的分流靠 pdfPurpose：这里一定是"导入课表"
      this.pdfPurpose = 'import';
      const payload: string = await this.extractPdfPayload(base64, (stage: string) => {
        this.importStage = stage;
      });
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

  /**
   * 抽出 pdf.js 的回传文本（**课表导入与作息导入共用**）。
   *
   * 为什么必须共用：这一段包含"首次创建 WebView → 等就绪 → 清旧结果 → 发起 → 轮询"
   * 五个时序步骤。任何一步顺序不对，症状都是"结果串了上一个文件"或"永远卡在解析中"；
   * 两处各写一份，早晚有一份漏掉 `CLEAR_SCRIPT`。
   *
   * @param onStage 阶段性文案回调（首次加载 pdf.js 要十几秒，得让用户知道在等什么）
   * @throws 解析器没就绪、或 60 秒没结果
   */
  private async extractPdfPayload(base64: string, onStage: (stage: string) => void): Promise<string> {
    // 首次导入要先创建 WebView 并加载 pdf.js（这台模拟器实测十几秒），把原因说清楚
    onStage(this.webReady ? '解析中…' : '准备解析器（首次较慢）…');
    try {
      const ready: boolean = await this.ensureWeb();
      if (!ready) {
        throw new Error('解析器加载失败（30 秒内没就绪），请重试');
      }
      onStage('解析中…');
      // 先清掉上一次的结果，否则轮询第一轮就读到旧文件的 payload（把 A 的课当成 B 的导进去）
      await this.runJs(PdfJs.CLEAR_SCRIPT);
      this.webController.runJavaScript(PdfJs.extractCall(base64));
      const payload: string = await this.pollPdfResult(60000);
      if (payload.length === 0) {
        throw new Error('解析超时（60 秒内没有结果）');
      }
      return payload;
    } finally {
      // 放在 finally 里而不是调用方：轮询已经结束（成功/超时/抛错都一样），
      // 这时销毁 Web 不会丢结果；调用方就算忘了释放也不会把 Web 留到下次启动。
      this.releaseWeb();
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
    if (this.eventEditorOpen) {
      this.eventEditorOpen = false;
      return true;
    }
    if (this.addChoiceOpen) {
      this.addChoiceOpen = false;
      return true;
    }
    if (this.slotEditorOpen) {
      this.slotEditorOpen = false;
      return true;
    }
    if (this.slotImportPasteOpen) {
      this.slotImportPasteOpen = false;
      return true;
    }
    if (this.slotImportRawOpen) {
      this.slotImportRawOpen = false;
      return true;
    }
    if (this.copySlotsOpen) {
      this.copySlotsOpen = false;
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
      // 导入页返回上一级是"作息页"，而不是直接回主页（否则校对到一半按返回会跳过作息页）
      this.screen = this.screen === 'slotsimport' ? 'slots' : 'home';
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

  // ---------------------------------------------------------------- 作息：编辑

  /** 进作息页时顺带把课表列表读出来（"从其他课表复制"要用它；只有一张时不显示按钮） */
  private openSlots(): void {
    this.screen = 'slots';
    this.loadTimetablesForCopy();
  }

  private async loadTimetablesForCopy(): Promise<void> {
    try {
      const store: ScheduleStore = await this.openStore();
      this.timetables = await store.allTimetables();
    } catch (e) {
      // 复制功能拿不到列表就不显示那个按钮 —— 不值得为它弹一个错误打断用户
      console.warn('[Calss] 读取课表列表失败：' + (e as Error).message);
    }
  }

  /** 库里的作息 → 逻辑层的最小行模型（加一节、复制都用它算） */
  private slotRows(): SlotRow[] {
    const out: SlotRow[] = [];
    for (const s of this.slots()) {
      out.push(SlotDraft.row(s.periodIndex, s.label, s.startMinute, s.endMinute));
    }
    return out;
  }

  private copyableTimetables(): Timetable[] {
    const out: Timetable[] = [];
    // 以 **store 的 currentId** 为准：它是"当前课表"的唯一事实来源（课表页的「当前」徽标也用它）。
    // `snapshot.timetable.id` 在快照还没就绪时是 0 —— 那时会把当前课表自己也列进来。
    const storeId: number = this.storeCurrentId();
    const current: number = storeId > 0 ? storeId : this.currentTimetableId();
    for (const t of this.timetables) {
      if (t.id !== current) {
        out.push(t);
      }
    }
    return out;
  }

  /** 改一节已有的作息 */
  private openSlotEditorForSlot(slot: TimeSlot): void {
    this.slotEditorTarget = 'slot';
    this.slotEditorSlotId = slot.id;
    this.slotEditorHeading = '编辑第 ' + slot.periodIndex + ' 节';
    this.slotEditorPeriod = String(slot.periodIndex);
    this.slotEditorLabel = slot.label;
    this.slotEditorStart = Minutes.format(slot.startMinute);
    this.slotEditorEnd = Minutes.format(slot.endMinute);
    this.slotEditorInferred = false;
    this.slotEditorOpen = true;
  }

  /** 加一节：默认值由 `SlotDraft.nextRow` 算（接在最后一节后面、时长沿用） */
  private openSlotEditorForNew(): void {
    const next: SlotRow = SlotDraft.nextRow(this.slotRows());
    this.slotEditorTarget = 'slot';
    this.slotEditorSlotId = 0;
    this.slotEditorHeading = '添加节次';
    this.slotEditorPeriod = String(next.periodIndex);
    this.slotEditorLabel = next.label;
    this.slotEditorStart = Minutes.format(next.startMinute);
    this.slotEditorEnd = Minutes.format(next.endMinute);
    this.slotEditorInferred = false;
    this.slotEditorOpen = true;
  }

  /** 校对页里改一行（只改内存，应用时才写库） */
  private openSlotEditorForReview(index: number): void {
    if (index < 0 || index >= this.slotImportRows.length) {
      return;
    }
    const row: SlotRow = this.slotImportRows[index];
    this.slotEditorTarget = 'review';
    this.slotEditorSlotId = 0;
    this.slotEditorReviewIndex = index;
    this.slotEditorHeading = '第 ' + row.periodIndex + ' 节';
    this.slotEditorPeriod = String(row.periodIndex);
    this.slotEditorLabel = row.label;
    this.slotEditorStart = Minutes.format(row.startMinute);
    this.slotEditorEnd = Minutes.format(row.endMinute);
    this.slotEditorInferred = row.inferred;
    this.slotEditorOpen = true;
  }

  /** 弹窗保存：按 target 分流到"写库"或"改校对页内存" */
  private async submitSlotEditor(row: SlotRow): Promise<void> {
    if (this.slotEditorTarget === 'review') {
      const next: SlotRow[] = this.slotImportRows.slice();
      if (this.slotEditorReviewIndex >= 0 && this.slotEditorReviewIndex < next.length) {
        next[this.slotEditorReviewIndex] = row;
      }
      this.slotImportRows = next.slice().sort((a: SlotRow, b: SlotRow) => a.periodIndex - b.periodIndex);
      this.slotEditorOpen = false;
      return;
    }
    this.slotsBusy = true;
    try {
      const store: ScheduleStore = await this.openStore();
      // 节次号是网格的行号：写库前先确认没被别人占了（否则第 3 节会有两条时间）
      const current: TimeSlot[] = await store.readSlotsOf(store.currentId);
      for (const s of current) {
        if (s.id !== this.slotEditorSlotId && s.periodIndex === row.periodIndex) {
          this.getUIContext().getPromptAction().showToast({
            message: '第 ' + row.periodIndex + ' 节已经存在了，换个节次号',
            duration: 2000,
          });
          this.slotsBusy = false;
          return;
        }
      }
      let timetableId = 0;
      for (const s of current) {
        if (s.id === this.slotEditorSlotId) {
          timetableId = s.timetableId;
        }
      }
      await store.saveSlot({
        id: this.slotEditorSlotId,
        timetableId: timetableId,
        periodIndex: row.periodIndex,
        label: row.label,
        startMinute: row.startMinute,
        endMinute: row.endMinute,
      });
      this.slotEditorOpen = false;
      await this.load();
    } catch (e) {
      this.getUIContext().getPromptAction().showToast({
        message: '保存失败：' + (e as Error).message,
        duration: 2500,
      });
    }
    this.slotsBusy = false;
  }

  /** 弹窗里的删除：改库的走原来的"删完重新编号"；校对页的只从内存里去掉一行 */
  private async deleteSlotFromEditor(): Promise<void> {
    if (this.slotEditorTarget === 'review') {
      const next: SlotRow[] = [];
      for (let i = 0; i < this.slotImportRows.length; i++) {
        if (i !== this.slotEditorReviewIndex) {
          next.push(this.slotImportRows[i]);
        }
      }
      this.slotImportRows = next;
      this.slotEditorOpen = false;
      return;
    }
    const id: number = this.slotEditorSlotId;
    this.slotEditorOpen = false;
    for (const s of this.slots()) {
      if (s.id === id) {
        await this.deleteSlot(s);
        return;
      }
    }
  }

  // ---------------------------------------------------------------- 导入作息

  private openSlotsImport(): void {
    this.slotImportPhase = 'idle';
    this.slotImportRows = [];
    this.slotImportWarnings = [];
    this.slotImportError = '';
    this.slotImportRaw = [];
    this.slotImportRawOpen = false;
    this.slotImportPasteOpen = false;
    this.slotImportPasteText = '';
    this.slotImportStage = '';
    this.slotImportSource = '';
    this.screen = 'slotsimport';
    this.loadTimetablesForCopy();
  }

  /** 通道一：图片 → OCR（系统 Core Vision Kit）。识别不出时给出可诊断的错误 */
  private async startSlotImportImage(): Promise<void> {
    if (this.slotImportStarting) {
      return;
    }
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      this.slotImportPhase = 'error';
      this.slotImportError = '拿不到 Context，稍后重试';
      return;
    }
    this.slotImportStarting = true;
    this.slotImportPhase = 'parsing';
    this.slotImportStage = '打开相册…';
    this.slotImportSource = '图片';
    try {
      const uri: string | null = await Ocr.pickImage();
      if (uri === null) {
        // 用户取消：回到入口，不算错误
        this.slotImportPhase = 'idle';
        this.slotImportStage = '';
        return;
      }
      this.slotImportStage = '识别中…（首次可能要几秒）';
      const outcome: OcrOutcome = await Ocr.readLines(ctx as common.UIAbilityContext, uri);
      this.finishSlotParse(
        outcome.lines,
        '图片 ' + outcome.debug.width + '×' + outcome.debug.height +
          '、方向 ' + ExifOrientation.describe(outcome.debug.orientation)
      );
    } catch (e) {
      this.slotImportPhase = 'error';
      this.slotImportError = (e as Error).message;
    } finally {
      this.slotImportStarting = false;
    }
  }

  /** 通道二：粘贴文本（完全离线，永远可用） */
  private startSlotImportText(): void {
    const text: string = this.slotImportPasteText;
    this.slotImportPasteOpen = false;
    this.slotImportPhase = 'parsing';
    this.slotImportStage = '解析中…';
    this.slotImportSource = '粘贴文本';
    this.finishSlotParse(TimetableTextParser.linesFromText(text), '粘贴文本');
  }

  /** 通道三：PDF 文字层（复用课程导入那套 pdf.js） */
  private async startSlotImportPdf(): Promise<void> {
    if (this.slotImportStarting || this.importStarting) {
      return;
    }
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      this.slotImportPhase = 'error';
      this.slotImportError = '拿不到 Context，稍后重试';
      return;
    }
    this.slotImportStarting = true;
    this.slotImportPhase = 'parsing';
    this.slotImportStage = '打开文件选择器…';
    this.slotImportSource = 'PDF';
    try {
      const picked: PickedPdf | null = await PdfFile.pick(ctx as common.UIAbilityContext);
      if (picked === null) {
        this.slotImportPhase = 'idle';
        this.slotImportStage = '';
        return;
      }
      this.slotImportStage = '读取文件…';
      const base64: string = await PdfFile.readBase64(picked.uri, picked.size);
      const payload: string = await this.extractPdfPayload(base64, (stage: string) => {
        this.slotImportStage = stage;
      });
      const result: PdfExtractResult = PdfRunText.parse(payload);
      if (!result.ok) {
        throw new Error('解析失败：' + result.error);
      }
      if (result.runs.length === 0) {
        throw new Error('这份 PDF 里没有可读文字（可能是扫描件）。扫描件请用「识别图片」。');
      }
      // 碎片 → 视觉行（`PdfRunText.toLines`），再交给作息解析器
      const textLines: string[] = PdfRunText.toLines(result.runs);
      this.finishSlotParse(
        TimetableTextParser.linesFromText(textLines.join('\n')),
        'PDF（' + picked.name + '）'
      );
    } catch (e) {
      this.slotImportPhase = 'error';
      this.slotImportError = (e as Error).message;
    } finally {
      this.slotImportStarting = false;
    }
  }

  /** 三条通道的共用出口：解析 → 校对页（**永不跳过校对、永不直接写库**） */
  private finishSlotParse(lines: OcrLine[], source: string): void {
    this.slotImportSource = source;
    if (lines.length === 0) {
      this.slotImportPhase = 'error';
      this.slotImportError = '没能认出任何文字行。换一张更清楚的图，或改用「粘贴文本」。';
      return;
    }
    const parsed: TimetableParseResult = TimetableTextParser.parse(lines);
    this.slotImportRaw = parsed.rawLines;
    if (parsed.periods.length === 0) {
      this.slotImportPhase = 'error';
      // 解析器的兜底文案（"没能从图片里认出作息时间，可以在下面手动添加节次"）在别的通道里
      // 既指错了主语、也指错了界面；这里换成按通道的说法，只把**具体**原因留在括号里
      // （如"有 3 处时间不合法"）。解析器的兜底句固定是 warnings 的最后一条。
      const reasons: string[] = [];
      for (const w of parsed.warnings) {
        if (!w.startsWith('没能从图片里')) {
          reasons.push(w);
        }
      }
      const detail: string = reasons.length > 0 ? '（' + reasons.join('；') + '）' : '';
      this.slotImportError = '没能在' + this.slotImportSourceName() + '里认出作息时间' + detail +
        '。每行要同时包含节次号和起止时间，例如「1 8:00-8:45」；也可以改用「粘贴文本」把文字贴进来。';
      return;
    }
    const rows: SlotRow[] = [];
    for (const p of parsed.periods) {
      rows.push(SlotDraft.row(p.periodIndex, p.group, p.startMinute, p.endMinute, p.inferred));
    }
    this.slotImportRows = rows;
    // 只留解析器自己的警告。"比现有作息少几节"那条是**会变的**（补一节之后就不准了），
    // 放在界面里现算（见 `slotImportReview` 的 missingHint）
    this.slotImportWarnings = parsed.warnings.slice();
    this.slotImportStage = '';
    this.slotImportPhase = 'review';
  }

  /** 校对页上"比现有作息少几节"的提示（随行数变化现算） */
  private slotImportMissingHint(): string {
    return SlotDraft.missingHint(this.slots().length, this.slotImportRows.length);
  }

  /** 通道名 → 「这张图片」/「这份 PDF」/「粘贴的文本」，用在报错文案里 */
  private slotImportSourceName(): string {
    const s: string = this.slotImportSource;
    if (s.startsWith('PDF')) {
      return '这份 PDF';
    }
    if (s.startsWith('图片')) {
      return '这张图片';
    }
    if (s.startsWith('粘贴')) {
      return '粘贴的文本';
    }
    return '这份内容';
  }

  /** 校对页「补一节」：接在最后一节之后，节次号顺延 */
  private addReviewSlotRow(): void {
    const next: SlotRow = SlotDraft.nextRow(this.slotImportRows);
    this.slotImportRows = this.slotImportRows.concat([next]).sort(
      (a: SlotRow, b: SlotRow) => a.periodIndex - b.periodIndex
    );
  }

  /** 应用：排序去重后整表替换当前课表的作息（课程/安排都不动） */
  private async applySlotImport(): Promise<void> {
    if (this.slotsBusy || this.slotImportRows.length === 0) {
      return;
    }
    this.slotsBusy = true;
    try {
      const store: ScheduleStore = await this.openStore();
      const rows: SlotRow[] = SlotDraft.sortedUnique(this.slotImportRows);
      const slots: TimeSlot[] = [];
      for (const r of rows) {
        slots.push({
          id: 0,
          timetableId: 0,
          periodIndex: r.periodIndex,
          label: r.label,
          startMinute: r.startMinute,
          endMinute: r.endMinute,
        });
      }
      await store.replaceSlots(slots);
      await this.load();
      this.slotImportPhase = 'idle';
      this.screen = 'slots';
      this.getUIContext().getPromptAction().showToast({
        message: '已导入 ' + slots.length + ' 节作息',
        duration: 2000,
      });
    } catch (e) {
      this.slotImportPhase = 'error';
      this.slotImportError = '写入失败：' + (e as Error).message;
    }
    this.slotsBusy = false;
  }

  private async copySlotsFrom(source: Timetable): Promise<void> {
    this.copySlotsOpen = false;
    this.slotsBusy = true;
    try {
      const store: ScheduleStore = await this.openStore();
      const sourceSlots: TimeSlot[] = await store.readSlotsOf(source.id);
      if (sourceSlots.length === 0) {
        this.getUIContext().getPromptAction().showToast({
          message: '「' + source.name + '」还没有作息可复制',
          duration: 2000,
        });
        this.slotsBusy = false;
        return;
      }
      const copied: TimeSlot[] = [];
      for (const s of sourceSlots) {
        copied.push({
          id: 0,
          timetableId: 0,
          periodIndex: s.periodIndex,
          label: s.label,
          startMinute: s.startMinute,
          endMinute: s.endMinute,
        });
      }
      await store.replaceSlots(copied);
      await this.load();
      this.getUIContext().getPromptAction().showToast({
        message: '已复制 ' + copied.length + ' 节',
        duration: 2000,
      });
    } catch (e) {
      this.getUIContext().getPromptAction().showToast({
        message: '复制失败：' + (e as Error).message,
        duration: 2500,
      });
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

  /** 点空白格：先问"课程还是自定义安排"，预填这一格的星期与节次 */
  private onCellTap(dayOfWeek: number, period: number): void {
    this.closeDetail();
    this.addChoiceDay = CourseDraft.clampDay(dayOfWeek);
    this.addChoicePeriod = CourseDraft.clampPeriod(period, this.periodCount);
    this.addChoiceOpen = true;
  }

  /** 新建课程，预填这一格的星期与节次 */
  private openCourseEditorAt(dayOfWeek: number, period: number): void {
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

  // ---------------------------------------------------------------- 自定义安排编辑

  /** 新建安排：预填这一格的星期/节次，周次默认整学期（见 `EventDraft.defaultWeeks`） */
  private openEventEditorAt(dayOfWeek: number, period: number): void {
    const base = EventDraft.newInput(dayOfWeek, period, this.periodCount, this.totalWeeks);
    this.eventEditorId = 0;
    this.eventHeading = '添加安排';
    this.eventTitle = base.title;
    this.eventNote = base.note;
    this.eventDay = base.day;
    this.eventStart = base.start;
    this.eventEnd = base.end;
    this.eventWeeks = base.weeks;
    // 新建时没有"原值"可保留：颜色交给默认安排色（WeekItems 里 color === 0 时用 EVENT_COLOR）
    this.eventColor = 0;
    this.eventStartMinute = null;
    this.eventEndMinute = null;
    this.closeDetail();
    this.eventEditorOpen = true;
  }

  private openEventEditorById(eventId: number): void {
    const event: CustomEvent | null = this.findEvent(eventId);
    if (event === null) {
      this.getUIContext().getPromptAction().showToast({ message: '这条安排已经不在课表里了', duration: 1500 });
      return;
    }
    // 只有钟点、没有节次的安排（老数据）也照常能编辑：节次从 1 起，保存时按选中的节次定位。
    // 与 Android 一致 —— 本版网格的纵轴是节次，没有节次就画不出来，让它落进网格更合理。
    const start: number = event.startPeriod === null ? 1 : event.startPeriod;
    this.eventEditorId = event.id;
    this.eventHeading = '编辑安排';
    this.eventTitle = event.title;
    this.eventNote = event.note;
    this.eventDay = event.dayOfWeek;
    this.eventStart = start;
    this.eventEnd = event.endPeriod === null ? start : event.endPeriod;
    this.eventWeeks = WeekMasks.format(maskFromDb(event.weekMask));
    this.eventColor = event.color;
    this.eventStartMinute = event.startMinute;
    this.eventEndMinute = event.endMinute;
    this.closeDetail();
    this.eventEditorOpen = true;
  }

  private async saveEventPayload(result: EventDraftResult): Promise<void> {
    const store: ScheduleStore | null = this.store;
    if (store === null) {
      this.getUIContext().getPromptAction().showToast({ message: '数据还没就绪，稍后再试', duration: 1500 });
      return;
    }
    try {
      // maskToDb 也放进 try：越界时它会抛错，放在 try 外面就变成 unhandled rejection，
      // 界面表现是"点了保存什么都没发生"（课程表单踩过同一个坑）
      const event: CustomEvent = {
        id: this.eventEditorId,
        timetableId: this.currentTimetableId(),
        title: result.title,
        dayOfWeek: result.day,
        startPeriod: result.start,
        endPeriod: result.end,
        // 透传：本表单不编辑这两项，但编辑一次就清空是不行的
        startMinute: this.eventStartMinute,
        endMinute: this.eventEndMinute,
        weekMask: maskToDb(result.weekMask),
        color: this.eventColor,
        note: result.note,
      };
      await store.saveEvent(event);
      this.eventEditorOpen = false;
      await this.refreshAfterEdit();
      // 与课程一样：保存后当前这一周可能看不到它（比如只安排了 1-8 周，而你停在第 9 周），
      // 跳到它第一次出现的那一周，否则用户会以为"保存了但什么都没发生"
      if (!WeekMasks.contains(result.weekMask, this.selectedWeek)) {
        this.goToFirstWeekOf(result.weekMask);
      }
      this.getUIContext().getPromptAction().showToast({
        message: this.eventEditorId > 0 ? '已更新：' + result.title : '已添加：' + result.title,
        duration: 1500,
      });
      this.eventEditorId = 0;
    } catch (e) {
      this.getUIContext().getPromptAction().showToast({ message: '保存失败：' + (e as Error).message, duration: 2500 });
    }
  }

  private async deleteEditedEvent(): Promise<void> {
    const store: ScheduleStore | null = this.store;
    const id: number = this.eventEditorId;
    if (store === null || id <= 0) {
      return;
    }
    try {
      await store.deleteEvent(id);
      this.eventEditorOpen = false;
      this.eventEditorId = 0;
      await this.refreshAfterEdit();
      this.getUIContext().getPromptAction().showToast({ message: '已删除该安排', duration: 1500 });
    } catch (e) {
      this.getUIContext().getPromptAction().showToast({ message: '删除失败：' + (e as Error).message, duration: 2500 });
    }
  }

  /** 跳到掩码里第一次出现的那一周（掩码非空；调用方已确认当前周不在里面） */
  private goToFirstWeekOf(mask: bigint): void {
    for (let w = 1; w <= this.totalWeeks; w++) {
      if (WeekMasks.contains(mask, w)) {
        this.goToWeek(w);
        return;
      }
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

  private findCourse(id: number): Course | null {
    const snap: Snapshot | null = this.snapshot;
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

  private findEvent(id: number): CustomEvent | null {
    const snap: Snapshot | null = this.snapshot;
    if (snap === null || id <= 0) {
      return null;
    }
    for (const e of snap.events) {
      if (e.id === id) {
        return e;
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
    this.detailEventId = 0;
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
    this.detailEventId = 0;
    if (item.kind === WeekItems.KIND_EVENT) {
      const event: CustomEvent | null = this.findEvent(item.id);
      // 库里找不到这条安排（刚被删 / 旧快照）时不给"编辑"，否则点进去是一张空表单
      this.detailEventId = event === null ? 0 : event.id;
      this.detailTitle = item.title;
      this.detailLines = this.eventDetailLines(item, event);
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

  /**
   * 周次文案：课程走 `weekMaskTextOf`（按时段匹配），安排走库里的 `weekMask`。
   *
   * 为什么安排不能复用上面那个：它按 (courseId, day, start, end) 匹配，
   * 而安排根本没有 courseId —— 直接复用会一路落到 `'本周'`，详情卡上永远是"本周"。
   */
  private weekMaskTextOfItem(item: WeekItem): string {
    if (item.kind !== WeekItems.KIND_EVENT) {
      return this.weekMaskTextOf(item);
    }
    const event: CustomEvent | null = this.findEvent(item.id);
    return event === null ? '' : WeekMasks.format(maskFromDb(event.weekMask));
  }

  private slotOf(period: number): TimeSlot | null {
    for (const s of this.slots()) {
      if (s.periodIndex === period) {
        return s;
      }
    }
    return null;
  }

  /** 自定义安排的详情几行：时间（含钟点）、周次、备注、冲突 */
  private eventDetailLines(item: WeekItem, event: CustomEvent | null): string[] {
    const lines: string[] = ['自定义安排'];
    if (event === null) {
      // 只剩网格里那份数据：照实显示，不编造备注/周次
      lines.push('时间：' + EventDraft.periodText(item.dayOfWeek, item.startPeriod, item.endPeriod));
      if (item.subtitle.length > 0) {
        lines.push('备注：' + item.subtitle);
      }
    } else {
      lines.push('时间：' + this.eventTimeText(event));
      const weeks: string = this.weekMaskTextOfItem(item);
      lines.push('周次：' + (weeks.length === 0 ? '（未设置）' : weeks + ' 周'));
      lines.push('备注：' + (event.note.length === 0 ? '（无）' : event.note));
    }
    if (item.conflicts.length > 0) {
      lines.push('⚠ 与《' + item.conflicts.join('》《') + '》时间重叠');
    }
    return lines;
  }

  /** 「周三 第 3-4 节  10:00-11:35」；作息里查不到这一节就只显示节次 */
  private eventTimeText(event: CustomEvent): string {
    const start: number = event.startPeriod === null ? 1 : event.startPeriod;
    const end: number = event.endPeriod === null ? start : event.endPeriod;
    let text: string = EventDraft.periodText(event.dayOfWeek, start, end);
    const slotStart: TimeSlot | null = this.slotOf(start);
    const slotEnd: TimeSlot | null = this.slotOf(end);
    if (slotStart !== null && slotEnd !== null) {
      text = text + '  ' + Minutes.format(slotStart.startMinute) + '-' + Minutes.format(slotEnd.endMinute);
    }
    return text;
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










