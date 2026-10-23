import { common } from '@kit.AbilityKit';
import { promptAction } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import {
  GridFormatParser,
  ListFormatParser,
  PdfRunText,
  WeekCalculator,
  WeekItems,
  WeekMasks,
  WeekSelection,
} from '../logic';
import { type CourseLike, type EventLike, type ParseResult, type PdfExtractResult, type ScheduleLike, type WeekItem } from '../logic';
import { Rdb } from '../platform/Rdb';
import { MigrationProbe, ProbeLine } from '../platform/MigrationProbe';
import { SpikeLine, SpikeProbe } from '../platform/SpikeProbe';
import { PayloadSink, PdfBridge, PdfJs } from '../platform/PdfJs';
import { PdfFile, PickedPdf } from '../platform/PdfFile';
import { ScheduleStore } from '../data/ScheduleStore';
import { Course, CourseSchedule, CourseWithSchedules, maskToDb, Snapshot, TimeSlot } from '../data/models';
import { WeekGrid } from '../view/WeekGrid';

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
  private importCourses: CourseWithSchedules[] = [];
  private webController: webview.WebviewController = new webview.WebviewController();
  private pdfSink: PayloadSink | null = null;

  /** 程序化翻页中。不是 @State：它不影响渲染，只用来压住 onChange */
  private autoScrolling: boolean = false;
  private controller: SwiperController = new SwiperController();

  aboutToAppear(): void {
    // pdf.js 的回调经静态 sink 转进来（JS 调用时代理对象的 this 不可靠）
    this.pdfSink = new PayloadSink((payload: string) => {
      this.onPdfPayload(payload);
    });
    PdfBridge.setSink(this.pdfSink);
    this.load();
  }

  aboutToDisappear(): void {
    PdfBridge.setSink(null);
    this.pdfSink = null;
  }

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      Column() {
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
        if (this.showDev) {
          this.devPanel()
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

      // pdf.js 容器：1x1 且透明。它只负责解析 PDF，界面不展示（见 platform/PdfJs.ts）
      this.hiddenWeb()
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

      Button(this.importBusy ? '导入中…' : '导入')
        .fontSize(12)
        .height(30)
        .backgroundColor('#F3E6DC')
        .fontColor('#B4664C')
        .enabled(!this.importBusy)
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
        Text(this.weekRangeText())
          .fontSize(10)
          .fontColor('#7A6E66')
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Center)

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
      }
    })
  }

  // ---------------------------------------------------------------- 详情卡

  @Builder
  detailCard() {
    Column({ space: 6 }) {
      Row() {
        Text(this.detailTitle)
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .fontColor('#3B3430')
          .layoutWeight(1)
        Text('关闭')
          .fontSize(12)
          .fontColor('#E07A5F')
          .onClick(() => {
            this.detailTitle = '';
            this.detailLines = [];
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
                this.writeSamples();
              })
            Button('清空全部课程')
              .fontSize(11)
              .height(28)
              .layoutWeight(1)
              .backgroundColor('#BDB3AB')
              .onClick(() => {
                this.clearAllCourses();
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
            .enabled(!this.spiking)
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

          Button(this.pdfRunning ? 'pdf.js 解析中…' : (this.webReady ? '跑 PDF spike（pdf.js 取坐标）' : 'pdf.js 页面加载中…'))
            .fontSize(12)
            .height(32)
            .width('100%')
            .backgroundColor('#9B8AC4')
            .enabled(this.webReady && !this.pdfRunning)
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
    Web({ src: $rawfile('pdfjs/viewer.html'), controller: this.webController })
      .width(1)
      .height(1)
      .opacity(0)
      .javaScriptAccess(true)
      .domStorageAccess(true)
      .fileAccess(true)
      .onControllerAttached(() => {
        // 注册 JS 代理必须在页面加载前后各做一次并 refresh()，否则页面里的 window.pdfBridge 是空的
        this.webController.registerJavaScriptProxy(new PdfBridge(), 'pdfBridge', ['report']);
        this.webController.refresh();
      })
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
    try {
      if (!this.webReady) {
        const wait: SpikeLine = { label: 'pdf.js 页面未就绪', ok: false, detail: '等 onPageEnd 后再试' };
        this.pdfLines = [wait];
        this.pdfRunning = false;
        return;
      }
      const base64: string = await PdfJs.readRawBase64(ctx as common.UIAbilityContext, 'spike-grid.pdf');
      const info: SpikeLine = { label: 'PDF 已读入并送去 pdf.js', ok: base64.length > 0, detail: base64.length + ' 字符(base64)' };
      this.pdfLines = [info];
      this.webController.runJavaScript(PdfJs.extractCall(base64));
    } catch (e) {
      const err = e as Error;
      const line: SpikeLine = { label: 'pdf.js 调用失败', ok: false, detail: err.message };
      this.pdfLines = [line];
      this.pdfRunning = false;
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

  /** 选 PDF → 读字节 → 交给 pdf.js。用户取消不算错误 */
  private async startImport(): Promise<void> {
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
      if (!this.webReady) {
        throw new Error('解析器还没就绪（pdf.js 页面未加载完），请稍后再试');
      }
      this.importStage = '解析中…';
      this.pdfPurpose = 'import';
      this.webController.runJavaScript(PdfJs.extractCall(base64));
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

    this.importCourses = this.toImportItems(best);
    this.importFormat = best.format;
    this.importCount = this.importCourses.length;
    this.importWarnings = best.warnings;

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
        promptAction.showToast({ message: `合并完成：新增 ${r.added} 门，更新 ${r.updated} 门`, duration: 2000 });
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
      this.importOpen = false;
      this.importBusy = false;
      await this.load();
    } catch (e) {
      const err = e as Error;
      this.importBusy = false;
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

  // ---------------------------------------------------------------- 交互

  private goToWeek(week: number): void {
    const target: number = WeekSelection.clamp(week, this.totalWeeks);
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

  private onCellTap(dayOfWeek: number, period: number): void {
    const dayName: string = ['一', '二', '三', '四', '五', '六', '日'][dayOfWeek - 1];
    promptAction.showToast({
      message: `第 ${this.selectedWeek} 周 · 周${dayName} · 第 ${period} 节（新建课程在阶段 3）`,
      duration: 1500,
    });
  }

  private onItemTap(item: WeekItem): void {
    if (item.kind === WeekItems.KIND_EVENT) {
      this.detailTitle = item.title;
      this.detailLines = ['自定义安排', '备注：' + (item.subtitle.length === 0 ? '（无）' : item.subtitle)];
      return;
    }
    const snap: Snapshot | null = this.snapshot;
    let teacher: string = '';
    let location: string = '';
    if (snap !== null) {
      for (const c of snap.courses) {
        if (c.id === item.id) {
          teacher = c.teacher;
          location = c.location;
          break;
        }
      }
    }
    this.detailTitle = item.title;
    this.detailLines = [
      '周' + ['一', '二', '三', '四', '五', '六', '日'][item.dayOfWeek - 1] +
        ` 第 ${item.startPeriod}-${item.endPeriod} 节`,
      '教师：' + (teacher.length === 0 ? '（未填）' : teacher),
      '教室：' + (location.length === 0 ? '（未填）' : location),
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


