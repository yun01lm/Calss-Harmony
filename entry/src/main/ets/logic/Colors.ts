/**
 * 配色（移植自 Android `HomeViewModel.colorFor` + `PALETTE`）。
 *
 * 为什么单独一层并且要有断言：课程颜色是**按课程名稳定散列**出来的，
 * 同名课程永远同色、换设备不变。要做到"和 Android 版一模一样"，散列函数必须是
 * Kotlin/JVM 的 `String.hashCode()`（31 进制、32 位环绕），不能用 JS 的随便一个哈希 ——
 * 否则同一份课表在两版上颜色完全不同，用户会以为数据错了。
 */

export class Colors {
  /** 柔和暖色系：既能区分课程，又不会像纯饱和色那样刺眼（顺序也照抄 Android） */
  static readonly PALETTE: string[] = [
    '#E07A5F',
    '#E9B44C',
    '#7FA98B',
    '#6C8EBF',
    '#CE8AA8',
    '#9B8AC4',
    '#5FA8A0',
    '#D98E73',
    '#8FA85C',
    '#B58AA5',
  ];

  /** 自定义安排的默认色（与 Android EVENT_COLOR 一致） */
  static readonly EVENT_COLOR: string = '#9A8C82';

  static readonly HEX: string = '0123456789ABCDEF';

  /**
   * Kotlin/JVM `String.hashCode()`：`h = 31*h + c`，32 位有符号环绕。
   * 用 `(h << 5) - h` 代替 `31*h`，避免依赖 `Math.imul`。
   */
  static kotlinHashCode(text: string): number {
    let h: number = 0;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) - h + text.charCodeAt(i)) | 0;
    }
    return h;
  }

  /** 未指定颜色时按课程名稳定散列配色，同名课程永远同色 */
  static colorFor(name: string, explicit: number): string {
    if (explicit !== 0) {
      return Colors.fromDb(explicit);
    }
    const size: number = Colors.PALETTE.length;
    const idx: number = ((Colors.kotlinHashCode(name) % size) + size) % size;
    return Colors.PALETTE[idx];
  }

  /**
   * 库里的颜色（ARGB 整数）→ `#RRGGBB`。
   *
   * 注意：Android 用 `Int` 存，同一个 0xFFE07A5F 在 Kotlin 里是**负数**；
   * 读出来可能是负数，所以先还原成无符号 32 位。用除法而不是位运算 ——
   * JS 的位运算会把值截成 32 位有符号，负数会算错。
   */
  static fromDb(raw: number): string {
    let v: number = Math.trunc(raw);
    if (v < 0) {
      v = v + 4294967296;
    }
    const r: number = Math.floor(v / 65536) % 256;
    const g: number = Math.floor(v / 256) % 256;
    const b: number = v % 256;
    return '#' + Colors.hex2(r) + Colors.hex2(g) + Colors.hex2(b);
  }

  /** 给 `#RRGGBB` 加透明度，返回 ArkUI 支持的 `#AARRGGBB` */
  static withAlpha(hex: string, alpha: number): string {
    const a: number = Math.max(0, Math.min(255, Math.round(alpha * 255)));
    return '#' + Colors.hex2(a) + (hex.length === 7 ? hex.substring(1) : hex);
  }

  private static hex2(value: number): string {
    const hi: number = Math.floor(value / 16) % 16;
    const lo: number = value % 16;
    return Colors.HEX.charAt(hi) + Colors.HEX.charAt(lo);
  }
}
