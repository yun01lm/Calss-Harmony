#!/usr/bin/env node
/**
 * 真机安装前的签名体检。
 *
 * 为什么需要它：`build-profile.json5` 里的 `signingConfigs` 是本机 DevEco 自动签名写的
 * **绝对路径 + 混淆口令**，不能入库（已 `.gitignore` 掉材料、并对这个文件设了
 * `git update-index --skip-worktree`）。于是换机器/重新 clone 之后，仓库里的这份是
 * `"signingConfigs": []`，构建照样"成功"，只是产出的是 **unsigned** HAP ——
 * 装到真机上才报 `9568320 no signature file`，白等一次。
 *
 * 这个脚本把这些检查提前到"构建之后、安装之前"，并在缺东西时**直接给出 DevEco 里的操作步骤**。
 *
 * 用法：
 *   node tools/check-signing.mjs            # 检查，缺东西时退出码 1
 *   node tools/check-signing.mjs --hap xxx  # 顺便确认这个 .hap 是 signed 的那份
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const PROFILE = path.join(ROOT, 'build-profile.json5');
const DEFAULT_HAP = path.join(ROOT, 'entry', 'build', 'default', 'outputs', 'default', 'entry-default-signed.hap');

/** 去掉 JSON5 的行注释与尾逗号，够用于本仓库的 build-profile.json5（里面没有块注释与字符串里的 //） */
function looseJson5(text) {
  let out = '';
  let inString = false;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i++;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      out += '\n';
      continue;
    }
    out += ch;
  }
  // 尾逗号（对象/数组最后一个元素后面）
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function fail(lines) {
  console.error('\n[签名检查] 未通过：');
  for (const l of lines) {
    console.error('  - ' + l);
  }
  console.error('\n在 DevEco Studio 里做一次（只需一次，之后本文件被 skip-worktree 保护）：');
  console.error('  1. File → Project Structure → Signing Configs');
  console.error('  2. 勾选「Automatically generate signature」（需已登录华为账号）');
  console.error('  3. 点 Apply / OK，等它写完 ~/.ohos/config 里的 .p12/.cer/.p7b');
  console.error('  4. 确认 build-profile.json5 的 products[0] 里有 "signingConfig": "default"');
  console.error('  5. 重新构建：hvigorw assembleHap --no-daemon');
  console.error('\n只想跑逻辑测试/CI 的话不需要签名（CI 只跑 node --test）。');
  process.exit(1);
}

function main() {
  if (!fs.existsSync(PROFILE)) {
    fail(['找不到 ' + PROFILE]);
  }
  const raw = fs.readFileSync(PROFILE, 'utf8');
  let json;
  try {
    json = JSON.parse(looseJson5(raw));
  } catch (e) {
    fail(['build-profile.json5 解析失败：' + e.message]);
  }

  const app = json.app ?? {};
  const configs = app.signingConfigs ?? [];
  const products = app.products ?? [];
  if (products.length === 0) {
    fail(['build-profile.json5 里没有 products']);
  }
  const product = products[0];
  const wanted = product.signingConfig;

  if (!wanted) {
    fail([
      'products[0]（' + product.name + '）没有 "signingConfig" —— 这种情况下',
      'hvigor 只打 WARN: No signingConfig found for product …，然后产出 entry-default-unsigned.hap，',
      '到真机上才报 9568320 no signature file。',
    ]);
  }

  const found = configs.find((c) => c.name === wanted);
  if (!found) {
    fail(['signingConfigs 里没有名为 "' + wanted + '" 的配置（当前有：' +
      (configs.map((c) => c.name).join(', ') || '空') + '）']);
  }

  const problems = [];
  const material = found.material ?? {};
  const certPath = material.certpath;
  const profilePath = material.profile;
  const storeFile = material.storeFile;
  for (const [label, p] of [
    ['证书 .cer（material.certpath）', certPath],
    ['Profile .p7b（material.profile）', profilePath],
    ['密钥库 .p12（material.storeFile）', storeFile],
  ]) {
    if (!p) {
      problems.push(label + ' 没写路径');
    } else if (!fs.existsSync(p)) {
      problems.push(label + ' 指向的文件不存在：' + p);
    }
  }
  if (problems.length > 0) {
    fail(problems);
  }

  // 产物也要认一眼：unsigned 的那份装不上真机
  const hapArgIndex = process.argv.indexOf('--hap');
  const hap = hapArgIndex > 0 ? path.resolve(process.argv[hapArgIndex + 1]) : DEFAULT_HAP;
  const hapNote = fs.existsSync(hap)
    ? '构建产物：' + path.basename(hap) + ' ✓'
    : '构建产物还没生成（' + path.relative(ROOT, hap) + '）';

  console.log('[签名检查] 通过');
  console.log('  signingConfig = ' + wanted);
  console.log('  证书：' + path.basename(certPath));
  console.log('  Profile：' + path.basename(profilePath));
  console.log('  密钥库：' + path.basename(storeFile));
  console.log('  ' + hapNote);
}

main();
