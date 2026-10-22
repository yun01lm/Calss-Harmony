/**
 * 格子内文字的排版算式。移植自 Android `ui/home/WeekGrid.kt`（含调试后的三条教训）。
 *
 * ## 为什么需要"算"而不是固定行数
 *
 * 一格约 46vp 宽；中文 11fp 一个字就 11vp。而 Text 的 `maxLines` 一旦超过格子高度，
 * **框架不会自动截断** —— 多出来的行照常绘制，于是压在下一行上（真机实测的"字叠在一起"）。
 * 所以必须"先算这个高度能放几行"，再决定课名几行、教室几行。
 *
 * ## 三条教训
 *
 * 1. **算式必须在 fp 空间做**（可用高度 ÷ 字体缩放）：系统字体放大后 fp 比 vp 大，
 *    按 vp 算会多算行数 → 文字被裁。鸿蒙里尺寸是 `vp`、字体是 `fp`，对应关系一致。
 * 2. **教室优先**：只要还剩得下一行就显示教室 —— 它是"到了楼里找哪间"的关键信息。
 * 3. **优先多显示课名**，但不能把教室挤掉。
 */
export interface CellLines {
  /** 课名可用行数（1..4） */
  readonly nameLines: number;
  /** 教室可用行数（0..2） */
  readonly locationLines: number;
  /** 实际占用高度（fp） */
  readonly used: number;
  /** 可用高度（fp） */
  readonly available: number;
  /**
   * 连一行都放不下（`used > available`）。只在**域外输入**出现：
   * 格子低于 [MIN_CELL_HEIGHT_SMALL_SCREEN] 或字体缩放超过约 3.5×。
   * 此时渲染层用 `clipToBounds` 裁切，**不会叠字**（安全），但内容显示不全 ——
   * 所以显式标出来，便于上层决定是否再缩字号。
   */
  readonly clipped: boolean;
  /** 该格子是否属于"宽裕"（跨多节） */
  readonly roomy: boolean;
  /** 课名字号（fp） */
  readonly nameFontSize: number;
  /** 行距（fp） */
  readonly lineHeight: number;
}

export class CellLayout {
  /** 格子内边距（上下合计）——与 Android 的 7dp 保持视觉一致 */
  static readonly CELL_PADDING: number = 7;

  /** 超过这个高度视为"跨多节的宽裕格子"（可用更大字号与行距） */
  static readonly ROOMY_HEIGHT: number = 40;

  /** 行距（fp）：约等于字号的 1.25 倍，贴着排会像叠字 */
  static readonly LINE_HEIGHT_ROOMY: number = 14;
  static readonly LINE_HEIGHT_TIGHT: number = 13;

  /** 教室行高（fp） */
  static readonly LOCATION_LINE_HEIGHT: number = 11;

  /** 格子高度下限：宁可滚动，也不压到看不清（小屏降到 56） */
  static readonly MIN_CELL_HEIGHT: number = 64;
  static readonly MIN_CELL_HEIGHT_SMALL_SCREEN: number = 56;

  /** 可视高度小于该值时认为"小屏" */
  static readonly SMALL_SCREEN_MAX_HEIGHT: number = 520;

  /** 字体放大超过该倍数时，隐藏节次列的钟点小字（那两行 7fp 会被挤没） */
  static readonly GUTTER_TIME_MAX_FONT_SCALE: number = 1.3;

  /**
   * 计算一个格子能显示多少行文字。
   *
   * @param cellHeightVp 格子高度（vp，含内边距）
   * @param fontScale 系统字体缩放系数（鸿蒙取 `configuration.fontSizeScale`）
   */
  static cellLines(cellHeightVp: number, fontScale: number): CellLines {
    const safeScale = fontScale > 0 ? fontScale : 1;
    const available = Math.max(0, cellHeightVp - CellLayout.CELL_PADDING) / safeScale;
    const roomy = cellHeightVp >= CellLayout.ROOMY_HEIGHT;
    const lineHeight = roomy ? CellLayout.LINE_HEIGHT_ROOMY : CellLayout.LINE_HEIGHT_TIGHT;
    const nameFontSize = roomy ? 11 : 10;
    const maxNameLines = Math.max(1, Math.floor(available / lineHeight));
    const loc = CellLayout.LOCATION_LINE_HEIGHT;

    let nameLines: number;
    if (maxNameLines >= 4 && available >= lineHeight * 4 + loc * 2) {
      nameLines = 4;
    } else if (maxNameLines >= 3 && available >= lineHeight * 3 + loc) {
      nameLines = 3;
    } else if (maxNameLines >= 2 && available >= lineHeight * 2 + loc) {
      nameLines = 2;
    } else if (available >= lineHeight + loc) {
      nameLines = 1;
    } else {
      nameLines = Math.min(maxNameLines, 2);
    }

    const left = available - lineHeight * nameLines;
    let locationLines: number;
    if (left >= loc * 2) {
      locationLines = 2;
    } else if (left >= loc) {
      locationLines = 1;
    } else {
      locationLines = 0;
    }

    const used = lineHeight * nameLines + loc * locationLines;
    const out: CellLines = {
      nameLines,
      locationLines,
      used,
      available,
      clipped: used > available + 1e-9,
      roomy,
      nameFontSize,
      lineHeight,
    };
    return out;
  }

  /** 按屏幕可用高度选择格子下限 */
  static minCellHeightFor(availableHeightVp: number): number {
    return availableHeightVp < CellLayout.SMALL_SCREEN_MAX_HEIGHT
      ? CellLayout.MIN_CELL_HEIGHT_SMALL_SCREEN
      : CellLayout.MIN_CELL_HEIGHT;
  }

  /** 是否显示节次列的起止时间 */
  static showGutterTime(fontScale: number): boolean {
    return fontScale <= CellLayout.GUTTER_TIME_MAX_FONT_SCALE;
  }
}
