/**
 * EXIF 方向 → 需要顺时针旋转的角度（纯逻辑，Node 可测）。
 *
 * 为什么单独成模块：相机竖拍的照片，像素是**横躺**的，方向记在 EXIF 里。
 * 鸿蒙 `image` 解码**不会**自动按 EXIF 摆正（`ImageInfo` 里没有 orientation 字段，
 * 只能 `getImageProperty(PropertyKey.ORIENTATION)` 拿到字符串），所以必须自己转。
 *
 * 为什么读字符串而不是数字：`getImageProperty` 返回 `"Top-left"` / `"Right-top"` 这类
 * 字符串（Android 侧 EXIF 是 1..8 的数字，两边对不上）。映射一旦写错，症状是
 * "识别出来的字全歪"或"整行顺序颠倒"，而模拟器上没有 OCR 后端根本测不出来 ——
 * 所以把映射做成纯函数并断言。
 */
export class ExifOrientation {
  /**
   * 需要顺时针旋转多少度。
   *
   * EXIF 的 8 种取值里，**只有不镜像的 3 种**需要转：
   * - `Right-top`（EXIF 6）：相机顺时针转了 90°，要再转 90° 才正；
   * - `Bottom-right`（EXIF 3）：倒着，转 180°；
   * - `Left-bottom`（EXIF 8）：转了 270°。
   *
   * 另外 4 种是**镜像**（Top-right / Bottom-left / Left-top / Right-bottom）。
   * 镜像要重采样（`PixelMap.flip`），这里不处理：镜像照片极少，而且文字本身仍然
   * 认得出来（OCR 开了方向检测）。宁可少转，也不要转错方向。
   */
  static degreesOf(raw: string): number {
    const t: string = raw.trim().toLowerCase();
    if (t === 'right-top') {
      return 90;
    }
    if (t === 'bottom-right') {
      return 180;
    }
    if (t === 'left-bottom') {
      return 270;
    }
    return 0;
  }

  /** 给提示文案用的简短描述：`Right-top` → `90°` */
  static describe(raw: string): string {
    const degrees: number = ExifOrientation.degreesOf(raw);
    const name: string = raw.trim().length === 0 ? '未知' : raw.trim();
    return name + (degrees === 0 ? '' : '→转 ' + degrees + '°');
  }
}
