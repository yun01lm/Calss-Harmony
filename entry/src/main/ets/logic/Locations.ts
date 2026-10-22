/**
 * 教室短形式：把长教室名压成「楼名简写 + 房号」，**只用于周视图小格子**
 * （详情卡与数据库里始终是完整值）。移植自 Android `ui/common/Locations.kt`。
 *
 * 为什么需要：一格只有约 46vp 宽，中文 11fp 一个字就要 11vp，
 * 而实测最长教室名 18 个字（`本部计算机基础实验室-3(505-506)`）—— 原样显示永远看不全。
 *
 * 三条原则：
 * 1. **房号一定保留**（定位关键），括号里的优先；
 * 2. **楼名要挑对片段**：先剥掉"本部/东区"这类校区前缀，再取带 `楼|馆|区|实验室|机房` 的片段
 *    —— 不能简单取第一段（那样 `本部-思源楼-301` 会变成"本部301"，实测就是这么错的）；
 * 3. 楼名取最短且还认得出的形式（见 [buildingShort]）；拼出来超过 12 字就只留房号。
 */
export class Locations {
  /** 小格子大约放得下这么多字（`实验楼B503-504` 是 11 个字） */
  static readonly MAX_SHORT: number = 12;

  /** 校区前缀：不定位到具体楼，详情卡里一直有完整值 */
  private static readonly CAMPUS_PREFIX: RegExp =
    /^(本部|东区|西区|南区|北区|东校区|西校区|南校区|北校区|新校区|老校区|主校区)[-—~·\s]*/;

  /** 楼名后缀。注意**不含"教室/中心"**：`智慧教室` 是房间类型，不是楼名 */
  private static readonly BUILDING_SUFFIX: RegExp = /(楼|馆|区|实验室|机房|食堂|体育馆)$/;

  private static readonly SEPARATORS: RegExp = /[-—~· ()（）]+/;

  private static readonly ROOM: RegExp = /[A-Za-z]?\d{1,4}(?:[-~]\d{1,4})?/g;
  private static readonly PAREN: RegExp = /[(（]([^)）]*\d[^)）]*)[)）]/g;
  private static readonly CJK: RegExp = /[\u4E00-\u9FFF]/;

  /** 通用楼名：去掉"楼"就认不出来了，必须原样保留 */
  private static readonly GENERIC_BUILDINGS: Set<string> = new Set<string>([
    '实验楼', '教学楼', '综合楼', '办公楼', '图书馆', '宿舍楼', '体育馆', '食堂', '机房', '实验室',
  ]);

  static shortLocation(raw: string): string {
    const t = raw.trim();
    if (t.length === 0) {
      return '';
    }
    const room = Locations.roomOf(t);
    if (room === null) {
      return t;
    }
    const joined = Locations.buildingShort(Locations.buildingPhrase(t, room)) + room;
    return joined.length <= Locations.MAX_SHORT ? joined : room;
  }

  /** 从整串里提取房号；找不到返回 null（调用方原样返回） */
  static roomOf(text: string): string | null {
    const parens = [...text.matchAll(Locations.PAREN)];
    if (parens.length > 0) {
      return parens[parens.length - 1][1].trim();
    }
    const candidates: string[] = [];
    for (const m of text.matchAll(Locations.ROOM)) {
      const v = m[0];
      const digits = v.match(/\d/g);
      if (/[A-Za-z]/.test(v) || (digits !== null && digits.length >= 2)) {
        candidates.push(v);
      }
    }
    return candidates.length > 0 ? candidates[candidates.length - 1] : null;
  }

  /**
   * 挑出"楼名片段"：
   * 1. 去掉校区前缀；
   * 2. 按分隔符切段，剥掉粘在段里的房号（`思源楼239` → `思源楼`），只留含中文的段；
   * 3. 优先带 `楼|馆|区|实验室|机房` 后缀的段（取最靠前的那个）；
   * 4. 都没有就取最后一个中文段兜底。
   */
  static buildingPhrase(text: string, room: string): string {
    const cleaned = text.replace(Locations.CAMPUS_PREFIX, '');
    const tokens: string[] = [];
    for (const rawToken of cleaned.split(Locations.SEPARATORS)) {
      let tok = rawToken.trim();
      if (tok.length === 0) {
        continue;
      }
      const i = tok.indexOf(room);
      if (i > 0) {
        tok = tok.slice(0, i).trim();
      }
      if (tok.length > 0 && tok !== room && Locations.CJK.test(tok)) {
        tokens.push(tok);
      }
    }
    if (tokens.length === 0) {
      return '';
    }
    for (const tok of tokens) {
      if (Locations.BUILDING_SUFFIX.test(tok)) {
        return tok;
      }
    }
    return tokens[tokens.length - 1];
  }

  /**
   * 楼名简写：
   * - **通用名原样保留**（实验楼/教学楼/图书馆…）；
   * - ≤4 字的专名去掉尾部"楼/馆/区"（思源楼 → 思源）；
   * - >4 字保留有信息量的尾词（计算机基础实验室 → 实验室；第一实验楼 → 实验楼；
   *   第一实验楼机房 → 实验楼，比"机房"更能定位）。
   */
  static buildingShort(token: string): string {
    if (token.length === 0) {
      return '';
    }
    if (Locations.GENERIC_BUILDINGS.has(token)) {
      return token;
    }
    if (token.length > 4) {
      if (token.endsWith('实验室')) {
        return '实验室';
      }
      if (token.endsWith('机房')) {
        const head = token.slice(0, token.length - 2);
        return head.endsWith('楼') && head.length >= 3 ? head.slice(head.length - 3) : '机房';
      }
      return token.slice(token.length - 3);
    }
    let b = token;
    while (b.length > 2 && (b.endsWith('楼') || b.endsWith('馆') || b.endsWith('区'))) {
      b = b.slice(0, b.length - 1);
    }
    return b;
  }
}
