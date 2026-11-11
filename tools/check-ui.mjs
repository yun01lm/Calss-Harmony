/**
 * UI 规范守卫（不需要鸿蒙 SDK，CI 与本机都能跑）。
 *
 * ## 起因
 *
 * 2026-11 把包传进应用市场「上架自检」，UX 的「字体」一项被直接判为**不通过**：
 *
 * > 应用的文字大小需满足最小字号要求：文本字号不小于 12 fp（推荐），最小不得小于 8 fp（必须）。
 *
 * 一查，`view/WeekGrid.ets` 里节次列的钟点小字是 `fontSize(7)`（行距 8）——
 * 从 Android 版照搬过来的"塞得下就行"写法。这类问题**只有上传自检才会暴露**，
 * 本地跑测试、装模拟器都不会报错，所以必须有一条能在本地跑的红线。
 *
 * ## 规则
 *
 * 1. 任何 `.fontSize(数字)`、`.font({ size: 数字 })`、`.fontSize('7fp')` 形式的字号
 *    不得小于 `CellLayout.MIN_FONT_SIZE`（8 fp）。数字来自常量（如
 *    `CellLayout.NARROW_FONT_SIZE`）的写法扫不到，由 `tests/cell-layout.test.ts`
 *    的数量断言兜住。
 *
 * 用法：node tools/check-ui.mjs [根目录]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const MIN_FONT_SIZE = 8;
/** 推荐值，只提示不失败：12fp */
const RECOMMENDED_FONT_SIZE = 12;
/** 允许小于推荐值的例外（周视图格子内部，物理空间只有 22~46vp） */
const BELOW_RECOMMENDED_OK = new Set(['view/WeekGrid.ets']);

const root = process.argv[2] ?? process.cwd();
const etsRoot = join(root, 'entry', 'src', 'main', 'ets');

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (name.endsWith('.ets')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 抓出所有字号字面量。
 *
 * 三种写法都要覆盖：属性 `.fontSize(7)`、样式对象 `.font({ size: 7 })`、
 * 以及带单位的字符串 `.fontSize('7fp')`（Android 版移植时最容易照抄成 px/fp）。
 */
const PATTERNS = [
  { re: /\.fontSize\(\s*(\d+(?:\.\d+)?)\s*\)/g, kind: 'fontSize' },
  { re: /\.fontSize\(\s*['"](\d+(?:\.\d+)?)(?:fp|vp|px)['"]\s*\)/g, kind: 'fontSize(单位串)' },
  { re: /\.font\(\s*\{[^}]*?\bsize\s*:\s*(\d+(?:\.\d+)?)/g, kind: 'font({size})' },
];

const problems = [];
const notes = [];
const files = walk(etsRoot);

for (const file of files) {
  const rel = relative(etsRoot, file).split(sep).join('/');
  const source = readFileSync(file, 'utf8');
  const lines = source.split(/\r?\n/);
  for (const { re, kind } of PATTERNS) {
    re.lastIndex = 0;
    let m = re.exec(source);
    while (m !== null) {
      const size = Number(m[1]);
      const line = source.slice(0, m.index).split(/\r?\n/).length;
      const text = lines[line - 1]?.trim() ?? '';
      if (size < MIN_FONT_SIZE) {
        problems.push(
          `${rel}:${line} ${kind} = ${size}fp，小于上架自检的硬下限 ${MIN_FONT_SIZE}fp（${text}）`,
        );
      } else if (size < RECOMMENDED_FONT_SIZE && !BELOW_RECOMMENDED_OK.has(rel)) {
        notes.push(`${rel}:${line} ${kind} = ${size}fp（推荐 ≥${RECOMMENDED_FONT_SIZE}fp，自检不判失败）`);
      }
      m = re.exec(source);
    }
  }
}

if (notes.length > 0) {
  console.log(`提示：${notes.length} 处字号低于推荐值 ${RECOMMENDED_FONT_SIZE}fp（不失败）：`);
  for (const n of notes) {
    console.log('  · ' + n);
  }
}

if (problems.length > 0) {
  for (const p of problems) {
    console.error('::error::' + p);
  }
  console.error(`\nUI 规范守卫失败：${problems.length} 处字号小于 ${MIN_FONT_SIZE}fp`);
  process.exit(1);
}

console.log(
  `UI 规范守卫通过：扫描 ${files.length} 个 .ets，无小于 ${MIN_FONT_SIZE}fp 的字号` +
    `（推荐 ${RECOMMENDED_FONT_SIZE}fp，低于推荐值的 ${notes.length} 处仅提示）`,
);
