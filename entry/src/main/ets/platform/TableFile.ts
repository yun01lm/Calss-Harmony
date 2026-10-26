/**
 * 选「教务系统导出的课表文件」（`.xls` / `.html` / `.htm`）并读出文本。
 *
 * ## 为什么单独一个文件
 *
 * 教务系统导出的 `.xls` **不是 Excel 二进制**，而是 HTML 表格（UTF-8 或 GBK）。
 * 所以这里不需要 pdf.js、也不需要 OCR：选文件 → 读字节 → 按编码转文本 → 交给
 * `logic/JwxtTableParser`。整条链路里**没有 Web 组件**，出错时也不用猜时序。
 *
 * ## 编码：先 UTF-8，出现替换字符再退回 GB18030
 *
 * 实测这份是 UTF-8；但同类系统（尤其老版）常发 GBK。判断依据是"解出来有 U+FFFD"，
 * 这比看 `Content-Type` 可靠（文件里根本没有头）。GB18030 是 GBK 的超集，能解 GBK 文本。
 *
 * ## 与 `PdfFile` 的两个共同坑（已踩过）
 *
 * 1. `DocumentViewPicker` 必须用带 context 的构造；
 * 2. 选中的是 document URI，先 `openSync` 拿 fd 再 `statSync(fd)`，别直接 stat uri。
 */
import { common } from '@kit.AbilityKit';
import { fileIo, picker } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';

/** 导入上限：课表表格一般几十 KB；超过 20MB 基本是选错文件 */
export const MAX_TABLE_BYTES: number = 20 * 1024 * 1024;

/** 一次"选文件 + 读文本"的结果 */
export interface PickedTable {
  readonly uri: string;
  readonly name: string;
  /** 文件原文（已按编码解码） */
  readonly html: string;
  /** 实际用的编码名（utf-8 / gb18030），导入提示里会带上 */
  readonly encoding: string;
}

export class TableFile {
  /** 弹出文件选择器选一个表格文件；用户取消返回 null */
  static async pick(ctx: common.UIAbilityContext): Promise<PickedTable | null> {
    const options: picker.DocumentSelectOptions = new picker.DocumentSelectOptions();
    options.maxSelectNumber = 1;
    // 教务系统导出的常见后缀：.xls（其实是 HTML）、.html/.htm、以及部分学校给 .xlsx
    options.fileSuffixFilters = ['课表文件|.xls,.xlsx,.html,.htm'];
    const viewPicker: picker.DocumentViewPicker = new picker.DocumentViewPicker(ctx);
    const uris: string[] = await viewPicker.select(options);
    if (uris.length === 0) {
      return null;
    }
    const uri: string = uris[0];
    const file: fileIo.File = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    let size = 0;
    try {
      const stat: fileIo.Stat = fileIo.statSync(file.fd);
      size = stat.size;
    } finally {
      fileIo.closeSync(file);
    }
    if (size <= 0) {
      throw new Error('文件是空的');
    }
    if (size > MAX_TABLE_BYTES) {
      throw new Error('文件太大（' + Math.round(size / 1024) + ' KB），课表表格一般不到几百 KB');
    }
    const bytes: Uint8Array = TableFile.readAll(uri, size);
    const decoded: DecodedText = TableFile.decode(bytes);
    const picked: PickedTable = {
      uri: uri,
      name: TableFile.baseNameOf(uri),
      html: decoded.text,
      encoding: decoded.encoding,
    };
    return picked;
  }

  /** 从 uri 读全部字节 */
  static readAll(uri: string, size: number): Uint8Array {
    const file: fileIo.File = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    try {
      const buffer: ArrayBuffer = new ArrayBuffer(size);
      const read: number = fileIo.readSync(file.fd, buffer);
      const out: Uint8Array = new Uint8Array(buffer);
      return read === size ? out : out.subarray(0, read);
    } finally {
      fileIo.closeSync(file);
    }
  }

  /**
   * 字节 → 文本。
   *
   * UTF-8 优先；出现替换字符（U+FFFD）时用 GB18030 重解 —— 老教务系统发 GBK 很常见。
   * 两种都不行就返回 UTF-8 的结果（界面会显示乱码，但不会炸）。
   */
  static decode(bytes: Uint8Array): DecodedText {
    const utf8: string = TableFile.decodeWith(bytes, 'utf-8');
    if (utf8.indexOf('\uFFFD') < 0) {
      return { text: utf8, encoding: 'utf-8' };
    }
    for (const enc of ['gb18030', 'gbk']) {
      const alt: string = TableFile.decodeWith(bytes, enc);
      if (alt.length > 0 && alt.indexOf('\uFFFD') < 0) {
        return { text: alt, encoding: enc };
      }
    }
    return { text: utf8, encoding: 'utf-8' };
  }

  private static decodeWith(bytes: Uint8Array, encoding: string): string {
    try {
      const decoder: util.TextDecoder = util.TextDecoder.create(encoding, { ignoreBOM: true });
      return decoder.decodeToString(bytes);
    } catch (e) {
      return '';
    }
  }

  /**
   * 判断这段文本像不像"教务系统导出的课表"。
   *
   * 用在"用户选了 .xlsx（真 Excel 二进制）"这种场景：那种文件里全是二进制，
   * 这里会明确告诉用户"这不是网页表格"，而不是让他看到一堆乱码。
   */
  static looksLikeHtml(text: string): boolean {
    const head: string = text.substring(0, 4096).toLowerCase();
    return head.indexOf('<table') >= 0 || head.indexOf('<html') >= 0 || head.indexOf('<tr') >= 0;
  }

  /** uri 末段解码（与 PdfFile 同一套中文百分号编码处理） */
  private static baseNameOf(uri: string): string {
    const cut: number = uri.lastIndexOf('/');
    const raw: string = cut >= 0 ? uri.substring(cut + 1) : uri;
    if (raw.length === 0) {
      return '课表表格';
    }
    const query: number = raw.indexOf('?');
    const clean: string = query >= 0 ? raw.substring(0, query) : raw;
    try {
      return decodeURIComponent(clean);
    } catch (e) {
      return clean;
    }
  }
}

/** 解码结果 */
export interface DecodedText {
  readonly text: string;
  readonly encoding: string;
}
