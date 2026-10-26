/**
 * 极简 HTML 表格解析（只做"教务系统导出的课表"这一种输入）。
 *
 * ## 为什么自己写而不上 Web 组件
 *
 * 教务系统导出的 `.xls` 其实是 **UTF-8 的 HTML 表格**（`<table><tr><td>`），不是 BIFF 二进制。
 * 用 ArkWeb 去解析 DOM 也能成，但那样**只能在设备上验**；写成纯函数就能在 Node 上
 * 拿真实文件跑断言 —— 同一份逻辑，CI 与真机行为一致。
 *
 * ## 能力边界（写清楚，别指望它当通用 HTML 解析器）
 *
 * - 只认 `<table>` / `<tr>` / `<td>` / `<th>`，属性只关心 `rowspan` / `colspan`；
 * - **不支持嵌套表格**（教务导出不会嵌套）；遇到嵌套会当成普通标签跳过；
 * - `<br>` → 换行；`<p>`/`</div>` → 换行；其余标签剔除；
 * - 实体只解常见的（`&nbsp;` `&amp;` `&lt;` `&gt;` `&quot;` `&#NNN;` `&#xHH;`）；
 * - 文本里连续空白压成一个空格，行首尾去空白，空行丢弃。
 *
 * 这些"够用且可测"的取舍，比"看起来支持一切"更可靠：真实文件已经拿来跑过断言。
 */

/** 一个单元格 */
export interface HtmlCell {
  /** 起始行（0 基，表内） */
  readonly row: number;
  /** 起始列（0 基，表内） */
  readonly col: number;
  /** 竖跨行数（>= 1） */
  readonly rowSpan: number;
  /** 横跨列数（>= 1） */
  readonly colSpan: number;
  /** 单元格文本：`<br>` 已是 `\n`，实体已解码，空白已规整 */
  readonly text: string;
}

/** 一张表 */
export interface HtmlTable {
  readonly cells: HtmlCell[];
  readonly rowCount: number;
  readonly colCount: number;
  /** 每个格位上的 `cells` 下标；-1 表示该位置没有单元格 */
  readonly indexGrid: number[][];
}

export class HtmlTableParser {
  /** 一个单元格最多跨多少行 —— 防止畸形文件把内存吃光 */
  static readonly MAX_SPAN: number = 200;

  /**
   * 解析出文档里所有表格（按出现顺序）。
   *
   * 只保留**至少 2 行 2 列**的表：教务导出的页眉页脚常是 1×N 的小表，
   * 那些对课表没有意义，留着只会让调用方多写一层过滤。
   */
  static parse(html: string): HtmlTable[] {
    const out: HtmlTable[] = [];
    const tables: string[] = HtmlTableParser.sliceTopLevelTables(html);
    for (const raw of tables) {
      const table: HtmlTable = HtmlTableParser.parseOne(raw);
      if (table.rowCount >= 2 && table.colCount >= 2) {
        out.push(table);
      }
    }
    return out;
  }

  /** 取一个格位上的单元格（被 rowspan/colspan 覆盖的位置返回起始单元格） */
  static cellAt(table: HtmlTable, row: number, col: number): HtmlCell | null {
    if (row < 0 || col < 0 || row >= table.rowCount || col >= table.colCount) {
      return null;
    }
    const idx: number = table.indexGrid[row][col];
    return idx < 0 ? null : table.cells[idx];
  }

  // ---------------------------------------------------------------- 内部

  /**
   * 切出表格片段。
   *
   * **不能靠深度计数**：教务系统导出的 HTML 里 `<table>` 与 `</table>` **不配对**
   * （实测这份文件 4 个 `<table` 只有 2 个 `</table>`，浏览器会自动补全）。
   * 按深度算的话，第二个表里遇到一个没有闭合的内层 `<table`，深度就永远回不到 0，
   * 后面的表全部丢掉 —— 表现是"只解析出 1 个小表"，很容易误判成解析器没写对。
   *
   * 所以按"下一个边界"切：一段从 `<table` 开始，到**最近的** `</table>` 或下一个 `<table` 结束。
   */
  private static sliceTopLevelTables(html: string): string[] {
    const out: string[] = [];
    const lower: string = html.toLowerCase();
    const opens: number[] = [];
    let probe: number = 0;
    while (true) {
      const at: number = lower.indexOf('<table', probe);
      if (at < 0) {
        break;
      }
      opens.push(at);
      probe = at + 6;
    }
    for (let i = 0; i < opens.length; i++) {
      const start: number = opens[i];
      const nextOpen: number = i + 1 < opens.length ? opens[i + 1] : lower.length;
      const close: number = lower.indexOf('</table', start);
      let end: number = nextOpen;
      if (close >= 0 && close < nextOpen) {
        const closeEnd: number = lower.indexOf('>', close);
        end = closeEnd < 0 ? nextOpen : closeEnd + 1;
      }
      if (end > start) {
        out.push(html.substring(start, end));
      }
    }
    return out;
  }

  private static parseOne(raw: string): HtmlTable {
    const cells: HtmlCell[] = [];
    const indexGrid: number[][] = [];
    const rows: string[] = HtmlTableParser.sliceRows(raw);
    let rowCount: number = 0;

    for (let r = 0; r < rows.length; r++) {
      const rowHtml: string = rows[r];
      if (indexGrid.length <= r) {
        indexGrid.push([]);
      }
      const tds: string[] = HtmlTableParser.sliceCells(rowHtml);
      let col: number = 0;
      for (const td of tds) {
        // 找下一个还没被占用的格位
        while (HtmlTableParser.hasAt(indexGrid, r, col)) {
          col++;
        }
        const attrs: string = HtmlTableParser.tagAttrs(td);
        const rowSpan: number = HtmlTableParser.spanOf(attrs, 'rowspan');
        const colSpan: number = HtmlTableParser.spanOf(attrs, 'colspan');
        const text: string = HtmlTableParser.textOf(HtmlTableParser.innerOf(td));
        const idx: number = cells.length;
        cells.push({ row: r, col: col, rowSpan: rowSpan, colSpan: colSpan, text: text });
        for (let dr = 0; dr < rowSpan; dr++) {
          const rr: number = r + dr;
          while (indexGrid.length <= rr) {
            indexGrid.push([]);
          }
          for (let dc = 0; dc < colSpan; dc++) {
            indexGrid[rr][col + dc] = idx;
          }
        }
        col += colSpan;
      }
      if (r + 1 > rowCount) {
        rowCount = r + 1;
      }
    }

    let colCount: number = 0;
    for (const line of indexGrid) {
      // 稀疏数组：用"最后被占用的列 + 1"作为宽度
      let width: number = 0;
      for (let c = 0; c < line.length; c++) {
        if (line[c] !== undefined) {
          width = c + 1;
        }
      }
      if (width > colCount) {
        colCount = width;
      }
    }
    // 补齐成矩形（缺失格位填 -1）
    for (let r = 0; r < rowCount; r++) {
      while (indexGrid[r].length < colCount) {
        indexGrid[r].push(-1);
      }
    }

    const out: HtmlTable = {
      cells: cells,
      rowCount: rowCount,
      colCount: colCount,
      indexGrid: indexGrid,
    };
    return out;
  }

  private static hasAt(grid: number[][], row: number, col: number): boolean {
    return grid.length > row && grid[row].length > col && grid[row][col] !== undefined && grid[row][col] >= 0;
  }

  private static sliceRows(tableHtml: string): string[] {
    const out: string[] = [];
    const lower: string = tableHtml.toLowerCase();
    let from: number = 0;
    while (true) {
      const open: number = lower.indexOf('<tr', from);
      if (open < 0) {
        break;
      }
      const close: number = lower.indexOf('</tr', open);
      if (close < 0) {
        break;
      }
      const after: number = lower.indexOf('>', close);
      out.push(tableHtml.substring(open, after < 0 ? lower.length : after + 1));
      from = after < 0 ? lower.length : after + 1;
    }
    return out;
  }

  /** 一行里的 `<td>` / `<th>` 片段（含开标签，便于取属性） */
  private static sliceCells(rowHtml: string): string[] {
    const out: string[] = [];
    const lower: string = rowHtml.toLowerCase();
    let i: number = 0;
    while (i < lower.length) {
      const td: number = lower.indexOf('<td', i);
      const th: number = lower.indexOf('<th', i);
      let start: number = -1;
      let isTd: boolean = true;
      if (td >= 0 && (th < 0 || td < th)) {
        start = td;
        isTd = true;
      } else if (th >= 0) {
        start = th;
        isTd = false;
      }
      if (start < 0) {
        break;
      }
      const closeTag: string = isTd ? '</td' : '</th';
      const close: number = lower.indexOf(closeTag, start);
      const openEnd: number = lower.indexOf('>', start);
      if (openEnd < 0) {
        break;
      }
      if (close < 0) {
        out.push(rowHtml.substring(start));
        break;
      }
      out.push(rowHtml.substring(start, close));
      i = close + closeTag.length;
    }
    return out;
  }

  private static tagAttrs(tdHtml: string): string {
    const openEnd: number = tdHtml.indexOf('>');
    return openEnd < 0 ? '' : tdHtml.substring(0, openEnd);
  }

  private static innerOf(tdHtml: string): string {
    const openEnd: number = tdHtml.indexOf('>');
    if (openEnd < 0) {
      return '';
    }
    let body: string = tdHtml.substring(openEnd + 1);
    const lower: string = body.toLowerCase();
    const close: number = lower.lastIndexOf('</t');
    if (close >= 0) {
      body = body.substring(0, close);
    }
    return body;
  }

  private static spanOf(attrs: string, name: string): number {
    const m = new RegExp(name + '\\s*=\\s*["\']?\\s*(\\d+)', 'i').exec(attrs);
    if (m === null) {
      return 1;
    }
    const n: number = Number.parseInt(m[1], 10);
    if (!Number.isFinite(n) || n < 1) {
      return 1;
    }
    return n > HtmlTableParser.MAX_SPAN ? HtmlTableParser.MAX_SPAN : n;
  }

  /** HTML 片段 → 纯文本（`<br>` 变换行，实体解码，空白规整） */
  static textOf(fragment: string): string {
    let s: string = fragment;
    // 先去掉脚本与样式（里面可能含 `<` 之类干扰标签识别）
    s = s.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
    s = s.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    // 换行语义的标签
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n');
    // 其余标签剔除
    s = s.replace(/<[^>]*>/g, ' ');
    s = HtmlTableParser.decodeEntities(s);
    const lines: string[] = [];
    for (const raw of s.split('\n')) {
      const line: string = raw.replace(/[\s\u00a0]+/g, ' ').trim();
      if (line.length > 0) {
        lines.push(line);
      }
    }
    return lines.join('\n');
  }

  private static decodeEntities(s: string): string {
    let out: string = s.replace(/&nbsp;/gi, ' ');
    out = out.replace(/&amp;/gi, '&');
    out = out.replace(/&lt;/gi, '<');
    out = out.replace(/&gt;/gi, '>');
    out = out.replace(/&quot;/gi, '"');
    out = out.replace(/&apos;/gi, "'");
    out = out.replace(/&#x([0-9a-f]+);/gi, (whole: string, hex: string): string => {
      const code: number = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : whole;
    });
    out = out.replace(/&#(\d+);/g, (whole: string, dec: string): string => {
      const code: number = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : whole;
    });
    return out;
  }
}
