/**
 * 架构守卫（不需要鸿蒙 SDK，CI 与本机都能跑）。
 *
 * 替换掉原来那三条 `grep`：grep 只看单行，于是下面这些**真实写法**全都漏过去了 ——
 *   - 多行 import（`import {\n  A,\n} from './X'`，`pages/Index.ets` 就是这种风格）
 *   - `export * from './X'`（`logic/index.ts` 全是这种）
 *   - `../` 跨层引用（`from '../view/Index'`）
 * 漏掉的后果不是"代码难看"，而是逻辑层悄悄依赖了 ArkUI，Node 再也跑不了测试
 * —— 那时候"测试全绿"就变成了一句空话。
 *
 * 规则（与 docs/ARCHITECTURE.md 一致）：
 *  1. `logic/**`、`data/**` 不得 import 任何 `@kit.*` / `@ohos.*`
 *  2. `logic/**`、`data/**` 内部的相对 import 必须带 `.ts` 扩展名（Node ESM 硬要求）
 *  3. `logic/**` 只能 import `logic/` 里的东西（不许摸 data/platform/view/pages）
 *  4. `data/**` 只能 import `data/` 与 `logic/`
 *
 * 用法：node tools/check-architecture.mjs [根目录]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

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
    } else if (name.endsWith('.ts') || name.endsWith('.ets')) {
      out.push(full);
    }
  }
  return out;
}

/** 抓出所有 import/export ... from '...'，包括多行写法 */
function importSpecs(source) {
  const out = [];
  const re = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g;
  let m = re.exec(source);
  while (m !== null) {
    out.push(m[1]);
    m = re.exec(source);
  }
  // 纯副作用 import：import './x.ts'
  const side = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  let s = side.exec(source);
  while (s !== null) {
    out.push(s[1]);
    s = side.exec(source);
  }
  return out;
}

const problems = [];
const files = walk(etsRoot);

for (const file of files) {
  const rel = relative(etsRoot, file).split(sep).join('/');
  const layer = rel.split('/')[0];
  if (layer !== 'logic' && layer !== 'data') {
    continue;
  }
  const source = readFileSync(file, 'utf8');
  for (const spec of importSpecs(source)) {
    if (spec.startsWith('@kit.') || spec.startsWith('@ohos.')) {
      problems.push(`${rel}: 依赖了鸿蒙 API '${spec}'（${layer}/ 必须零平台依赖）`);
      continue;
    }
    if (!spec.startsWith('.') && !spec.startsWith('@kit.') && !spec.startsWith('@ohos.')) {
      continue; // node: 内置或未知裸模块，交给别处管
    }
    if (spec.startsWith('.')) {
      if (!spec.endsWith('.ts')) {
        problems.push(`${rel}: 相对 import '${spec}' 少了 .ts 扩展名（Node ESM 会 ERR_MODULE_NOT_FOUND）`);
      }
      // 跨层检查：把 ./ 或 ../ 解析成 entry/src/main/ets 下的路径
      const resolved = join(file, '..', spec).split(sep).join('/');
      const idx = resolved.indexOf('/ets/');
      const target = idx >= 0 ? resolved.slice(idx + '/ets/'.length) : resolved;
      const targetLayer = target.split('/')[0];
      if (layer === 'logic' && targetLayer !== 'logic') {
        problems.push(`${rel}: logic/ 只能依赖 logic/，但引用了 '${spec}'（落在 ${targetLayer}/）`);
      }
      if (layer === 'data' && targetLayer !== 'data' && targetLayer !== 'logic') {
        problems.push(`${rel}: data/ 只能依赖 data/ 与 logic/，但引用了 '${spec}'（落在 ${targetLayer}/）`);
      }
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) {
    console.error('::error::' + p);
  }
  console.error(`\n架构守卫失败：${problems.length} 处`);
  process.exit(1);
}
console.log(`架构守卫通过：扫描 ${files.length} 个文件，logic/ 与 data/ 均零平台依赖、import 均带 .ts`);
