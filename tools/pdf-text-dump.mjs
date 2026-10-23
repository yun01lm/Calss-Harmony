/**
 * 从 PDF 里直接把文本连坐标抠出来（**只用于本地排查真实课表**，不进 HAP）。
 *
 * 为什么不用 pdf.js：这件事要的是"最快看到 PDF 里到底写了什么"，
 * 而不是跟浏览器环境较劲。PDF 的文本流就是 `BT ... Td (字) Tj ... ET`，
 * 字体是 UniGB-UCS2-H 时字节就是 UTF-16BE —— 解出来即可。
 *
 * 用法：node tools/pdf-text-dump.mjs "C:\\path\\to\\课表.pdf"
 * 输出：每行 `页  x  y  "文本"`，按 y 从大到小（PDF 坐标向上，视觉上从上到下）。
 *
 * 注意：输出里会有真实姓名/学号，**不要提交**（.gitignore 里已有 /tools/fixtures/，
 * 需要留档就放那里）。
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const path = process.argv[2];
if (path === undefined) {
  console.error('用法: node tools/pdf-text-dump.mjs <pdf>');
  process.exit(1);
}

const buf = readFileSync(path);
const latin1 = buf.toString('latin1');

/** 收集所有 FlateDecode 流并解压 */
function streams() {
  const out = [];
  const re = /stream\r?\n/g;
  let m = re.exec(latin1);
  while (m !== null) {
    const start = m.index + m[0].length;
    const end = latin1.indexOf('endstream', start);
    if (end < 0) {
      break;
    }
    const raw = buf.subarray(start, end);
    try {
      out.push(inflateSync(raw).toString('latin1'));
    } catch (e) {
      // 不是 Flate 或不是文本流：跳过
    }
    re.lastIndex = end;
    m = re.exec(latin1);
  }
  return out;
}

/**
 * 字面量串 `(...)` → 文本。
 *
 * 这份 PDF 的字体是 UniGB-UCS2-H，所以括号里是**裸 UCS-2 大端字节**
 * （`学` = 0x5B66，ASCII `2` = 0x0032 → 字节 00 32）。
 * 我们是从 latin1 视图里取的字符串，所以每个 char 就是一个字节，两两配对还原。
 */
function decodeLiteral(raw, ucs2) {
  const bytes = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw.charAt(i + 1);
      if (next === 'n') {
        bytes.push(0x0a);
        i++;
        continue;
      }
      if (next === 'r') {
        bytes.push(0x0d);
        i++;
        continue;
      }
      if (next === 't') {
        bytes.push(0x09);
        i++;
        continue;
      }
      if (next === '(' || next === ')' || next === '\\') {
        bytes.push(next.charCodeAt(0));
        i++;
        continue;
      }
      // \ooo 八进制
      const oct = /^[0-7]{1,3}/.exec(raw.slice(i + 1));
      if (oct !== null) {
        bytes.push(Number.parseInt(oct[0], 8) & 0xff);
        i += oct[0].length;
        continue;
      }
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
  }
  if (!ucs2) {
    return Buffer.from(bytes).toString('latin1');
  }
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  }
  return s;
}

const ucs2 = /UniGB-UCS2-H|UniGB-UTF16-H/.test(latin1);
const rows = [];

for (const content of streams()) {
  let x = 0;
  let y = 0;
  let fontSize = 10;
  let page = 1;
  const tokens = content.match(/BT[\s\S]*?ET/g) ?? [];
  for (const block of tokens) {
    for (const line of block.split('\n')) {
      const tf = /\/[A-Za-z0-9]+\s+([\d.]+)\s+Tf/.exec(line);
      if (tf !== null) {
        fontSize = Number.parseFloat(tf[1]);
        continue;
      }
      const tm = /([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm/.exec(line);
      if (tm !== null) {
        x = Number.parseFloat(tm[5]);
        y = Number.parseFloat(tm[6]);
        continue;
      }
      const td = /([-\d.]+)\s+([-\d.]+)\s+T[dD]/.exec(line);
      if (td !== null) {
        x += Number.parseFloat(td[1]);
        y += Number.parseFloat(td[2]);
        continue;
      }
      const hex = /<([0-9A-Fa-f]+)>\s*Tj/.exec(line);
      if (hex !== null) {
        const text = decodeHex(hex[1], ucs2);
        rows.push({ page, x, y, fontSize, text });
        continue;
      }
      const lit = /\((.*)\)\s*Tj/.exec(line);
      if (lit !== null) {
        rows.push({ page, x, y, fontSize, text: decodeLiteral(lit[1], ucs2) });
      }
    }
  }
}

rows.sort((a, b) => (a.page - b.page) || (b.y - a.y) || (a.x - b.x));
if (process.argv[3] === '--runs') {
  // 直接输出 pdf.js 回传的制表符载荷（6 字段：page x y endX fontSize text）
  console.log('OK');
  for (const r of rows) {
    const endX = r.x + r.text.length * r.fontSize;
    console.log([r.page, r.x.toFixed(1), r.y.toFixed(1), endX.toFixed(1), r.fontSize, r.text].join('\t'));
  }
} else {
  for (const r of rows) {
    console.log(`${r.page}\t${Math.round(r.x)}\t${Math.round(r.y)}\t${JSON.stringify(r.text)}`);
  }
}
console.error(`共 ${rows.length} 段文本；ucs2=${ucs2}`);
