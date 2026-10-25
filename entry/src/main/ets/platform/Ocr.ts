/**
 * 图片 → OCR 文字行（**平台侧**，作息表导入的"识别图片"通道）。
 *
 * ## 与 Android 的对应关系
 *
 * Android 用 ML Kit 的 **bundled 中文识别器**（模型随 APK，离线可用，约 +5MB）。
 * 鸿蒙这边用系统自带的 **Core Vision Kit**（`@kit.CoreVisionKit` 的 `textRecognition`）：
 * 模型在系统里，**不占应用体积、也完全离线**，这是比 Android 更省的地方。
 *
 * ## 为什么"识别失败"必须说清楚
 *
 * 这台模拟器的镜像里没有 OCR 后端，调用直接抛 `1001400001`。
 * 如果只弹一句"识别失败"，用户会以为是图片的问题；所以 `friendlyError` 把错误码
 * 翻译成"能据此行动"的话（去用「粘贴文本」或「从 PDF 文件」），并把原始错误码附在末尾
 * —— 真机上反馈问题时那一行就是证据。
 *
 * ## 三个实现细节
 *
 * 1. **只解到 2000px 以内**：手机照片动辄 4000×3000，OCR 前先缩，
 *    否则解码就吃掉上百 MB（模拟器上直接 OOM），识别也更慢。
 * 2. **按 EXIF 方向摆正**：相机竖拍的图，像素是横躺的。OCR 自己能做方向检测，
 *    但**行与行、字与字的坐标**会跟着歪，而作息解析靠的就是"谁在谁左边/下面"。
 * 3. **用完即释放**：PixelMap、ImageSource、OCR 服务都释放，符合"零后台"约定。
 */
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo } from '@kit.CoreFileKit';
import { image } from '@kit.ImageKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { textRecognition } from '@kit.CoreVisionKit';
import { ExifOrientation } from '../logic/ExifOrientation.ts';
import { OcrLine } from '../logic/TimetableTextParser.ts';

/** 解码后的最长边上限：再大对识别没有帮助，只会更慢更吃内存 */
const MAX_SIDE: number = 2000;

/** 一次识别的诊断信息（失败时也带出来，真机上能据此定位） */
export interface OcrDebug {
  readonly width: number;
  readonly height: number;
  /** EXIF 方向的原始字符串（`Top-left` / `Right-top` …），空串表示读不到 */
  readonly orientation: string;
  readonly lineCount: number;
}

export interface OcrOutcome {
  readonly lines: OcrLine[];
  readonly debug: OcrDebug;
}

export class Ocr {
  /**
   * 打开系统相册选一张图。
   * @returns 用户取消时返回 null（**不是错误**，页面不该弹失败提示）
   */
  static async pickImage(): Promise<string | null> {
    const options: photoAccessHelper.PhotoSelectOptions = new photoAccessHelper.PhotoSelectOptions();
    options.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
    options.maxSelectNumber = 1;
    const viewPicker: photoAccessHelper.PhotoViewPicker = new photoAccessHelper.PhotoViewPicker();
    const picked: photoAccessHelper.PhotoSelectResult = await viewPicker.select(options);
    const uris: string[] = picked.photoUris;
    if (uris === undefined || uris.length === 0) {
      return null;
    }
    return uris[0];
  }

  /**
   * 识别一张图里的文字行。
   *
   * 失败时抛出的 `Error.message` 已经是**给用户看的**文案（`friendlyError` 翻译过），
   * 调用方直接显示即可；原始错误码在文案末尾。
   */
  static async readLines(ctx: common.UIAbilityContext, uri: string): Promise<OcrOutcome> {
    let file: fileIo.File | null = null;
    let source: image.ImageSource | null = null;
    let pixelMap: image.PixelMap | null = null;
    try {
      file = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
      source = image.createImageSource(file.fd);
      const info: image.ImageInfo = await source.getImageInfo();
      // 方向只在 EXIF 里，`ImageInfo` 没有这个字段（实测：读它会编译不过）
      const orientation: string = await Ocr.orientationOf(source);
      const size: image.Size = Ocr.fitWithin(info.size.width, info.size.height, MAX_SIDE);
      pixelMap = await source.createPixelMap({
        desiredPixelFormat: image.PixelMapFormat.RGBA_8888,
        desiredSize: size,
      });
      await Ocr.applyOrientation(pixelMap, orientation);

      const result: textRecognition.TextRecognitionResult = await textRecognition.recognizeText(
        { pixelMap: pixelMap },
        { isDirectionDetectionSupported: true }
      );
      const lines: OcrLine[] = [];
      for (const block of result.blocks) {
        for (const line of block.lines) {
          const box: number[] = Ocr.boundsOf(line.cornerPoints);
          lines.push(new OcrLine(line.value, box[0], box[1], box[2], box[3]));
        }
      }
      const outcome: OcrOutcome = {
        lines: lines,
        debug: {
          width: size.width,
          height: size.height,
          orientation: orientation,
          lineCount: lines.length,
        },
      };
      return outcome;
    } catch (e) {
      throw new Error(Ocr.friendlyError(e));
    } finally {
      if (pixelMap !== null) {
        try {
          pixelMap.release();
        } catch (e) {
          // 释放失败不影响结果，吞掉：真正要紧的是别把上面的异常覆盖掉
        }
      }
      if (source !== null) {
        try {
          await source.release();
        } catch (e) {
          // 同上
        }
      }
      if (file !== null) {
        try {
          fileIo.closeSync(file);
        } catch (e) {
          // 同上
        }
      }
      try {
        // 模型不驻留：识别完就释放（零后台约定）
        await textRecognition.release();
      } catch (e) {
        // release 失败无副作用，忽略
      }
    }
  }

  /** 把 OCR 的原始异常翻译成用户能看懂、且**能据此行动**的话 */
  static friendlyError(e: Object): string {
    const code: number = Ocr.errorCodeOf(e);
    const raw: string = (e as Error).message === undefined ? '' : (e as Error).message;
    if (code === 1001400001 || code === 1001400002) {
      return '这台设备的系统 OCR 服务不可用（错误码 ' + code + '）。\n' +
        '改用「粘贴文本」或「从 PDF 文件」都能导入作息；也可以直接在作息页手动改。';
    }
    if (code === 200) {
      return '识别超时（错误码 200）：换成小一点的图，或再试一次。';
    }
    if (code === 401) {
      return '这张图片读不出来（错误码 401）：换一张 JPG/PNG 试试。';
    }
    if (code === 13900001 || code === 13900002) {
      return '打不开这张图片（错误码 ' + code + '）：系统相册授权可能已失效，重新选一次。';
    }
    if (raw.length > 0) {
      return '识别失败：' + raw + (code > 0 ? '（错误码 ' + code + '）' : '');
    }
    return '识别失败：' + (code > 0 ? '错误码 ' + code : '未知错误') +
      '\n改用「粘贴文本」或「从 PDF 文件」都能导入作息。';
  }

  // ---------------------------------------------------------------- 内部

  private static errorCodeOf(e: Object): number {
    const err: BusinessError = e as BusinessError;
    if (err !== null && err !== undefined && typeof err.code === 'number') {
      return err.code;
    }
    return 0;
  }

  /** 等比缩到最长边不超过 maxSide；本来就不大时用原尺寸 */
  private static fitWithin(width: number, height: number, maxSide: number): image.Size {
    const w: number = width < 1 ? 1 : Math.trunc(width);
    const h: number = height < 1 ? 1 : Math.trunc(height);
    const longest: number = Math.max(w, h);
    if (longest <= maxSide) {
      const same: image.Size = { width: w, height: h };
      return same;
    }
    const scale: number = maxSide / longest;
    const size: image.Size = {
      width: Math.max(1, Math.trunc(w * scale)),
      height: Math.max(1, Math.trunc(h * scale)),
    };
    return size;
  }

  /**
   * 按 EXIF 方向把像素摆正。
   *
   * `getImageProperty` 在部分图片上会抛错（png 没有 EXIF），这时按"不旋转"处理 ——
   * 这不是错误，PNG 截图本来就是正的。
   */
  private static async applyOrientation(pixelMap: image.PixelMap, orientation: string): Promise<void> {
    const degrees: number = ExifOrientation.degreesOf(orientation);
    if (degrees === 0) {
      return;
    }
    await pixelMap.rotate(degrees);
  }

  /** 读 EXIF 方向字符串；读不到时返回空串（不当成错误） */
  private static async orientationOf(source: image.ImageSource): Promise<string> {
    try {
      const value: string = await source.getImageProperty(image.PropertyKey.ORIENTATION);
      return value === undefined || value === null ? '' : value;
    } catch (e) {
      return '';
    }
  }

  /** 四个角点 → [left, top, right, bottom] */
  private static boundsOf(points: textRecognition.PixelPoint[]): number[] {
    let left = 0;
    let top = 0;
    let right = 0;
    let bottom = 0;
    let first = true;
    for (const p of points) {
      if (first) {
        left = p.x;
        right = p.x;
        top = p.y;
        bottom = p.y;
        first = false;
        continue;
      }
      left = Math.min(left, p.x);
      right = Math.max(right, p.x);
      top = Math.min(top, p.y);
      bottom = Math.max(bottom, p.y);
    }
    return [Math.trunc(left), Math.trunc(top), Math.trunc(right), Math.trunc(bottom)];
  }
}
