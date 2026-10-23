/**
 * 选 PDF 并读成 base64 —— 导入通道的**平台侧**（文件选择 + 读文件）。
 *
 * 与 `platform/PdfJs.ts` 的分工：那边负责"把字节交给 pdf.js"，这边负责"把用户的文件变成字节"。
 *
 * 两个坑：
 * 1. `DocumentViewPicker` 必须用 `new DocumentViewPicker(context)`（带 context 的构造），
 *    无参构造官方标注"不推荐、可能失败"；
 * 2. 选中的是 **document URI**（`file://docs/...`），不是普通路径：先 `openSync` 拿 fd，
 *    再用 `statSync(fd)` 取大小 —— 直接 `statSync(uri)` 在部分版本上会失败。
 */
import { common } from '@kit.AbilityKit';
import { fileIo, picker } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';

/** 导入上限：课表 PDF 通常几十 KB~几 MB；超过这个值多半选错文件了 */
export const MAX_PDF_BYTES: number = 20 * 1024 * 1024;

export interface PickedPdf {
  readonly uri: string;
  /** 文件名（用于给"新建课表"起名） */
  readonly name: string;
  readonly size: number;
}

export class PdfFile {
  /**
   * 弹出系统文件选择器选一个 PDF。
   * @returns 用户取消时返回 null（**不是错误**，页面不该弹失败提示）
   */
  static async pick(ctx: common.UIAbilityContext): Promise<PickedPdf | null> {
    const options: picker.DocumentSelectOptions = new picker.DocumentSelectOptions();
    options.maxSelectNumber = 1;
    options.fileSuffixFilters = ['PDF|.pdf'];
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

    const picked: PickedPdf = {
      uri: uri,
      name: PdfFile.baseNameOf(uri),
      size: size,
    };
    return picked;
  }

  /** 读出整个文件的 base64（给 ArkWeb 里的 pdf.js 用） */
  static async readBase64(uri: string, size: number): Promise<string> {
    if (size <= 0) {
      throw new Error('文件是空的');
    }
    if (size > MAX_PDF_BYTES) {
      throw new Error('文件太大（' + Math.round(size / 1024) + ' KB），课表 PDF 一般不到几 MB');
    }
    const file: fileIo.File = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
    let buffer: ArrayBuffer = new ArrayBuffer(size);
    try {
      buffer = new ArrayBuffer(size);
      fileIo.readSync(file.fd, buffer);
    } finally {
      fileIo.closeSync(file);
    }
    const helper: util.Base64Helper = new util.Base64Helper();
    return helper.encodeToStringSync(new Uint8Array(buffer));
  }

  /** uri 末段作为文件名 */
  private static baseNameOf(uri: string): string {
    const cut: number = uri.lastIndexOf('/');
    const raw: string = cut >= 0 ? uri.substring(cut + 1) : uri;
    return raw.length === 0 ? '课表' : raw;
  }
}
