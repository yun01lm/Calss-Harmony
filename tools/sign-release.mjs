#!/usr/bin/env node
/**
 * 用「发布证书 + 发布 Profile」给 release 版 HAP 签名，并当场校验。
 *
 * 为什么需要它：DevEco 的「自动签名」只会生成 **调试证书**（profile 里 "type":"debug"，
 * 还带一份 device-ids 白名单）。这样的包只能装进白名单里那一台机器，应用市场
 * 「上传新版本 / 上架自检」不收。要上架就必须用应用市场签发的
 * **发布证书**（.cer）+ **发布 Profile**（.p7b）重新签一次。
 *
 * 本脚本做的事和 hvigor 的 SignHap 任务完全相同 —— 都是调 SDK 里那个官方
 * hap-sign-tool.jar 的 sign-app，只是材料换成发布材料。签完立刻用 verify-app
 * 回读包里真正生效的 profile，断言三件事：
 *
 *   1. profile type == "release"（不是 debug）
 *   2. profile 里的 bundle-name == AppScope/app.json5 的 bundleName
 *   3. profile 里的 version-code == 版本号（防止签了个过期的包）
 *
 * 任何一条不满足就删掉产物并退出码 1 —— 宁可没有包，也不给一个"看着像能上传"的包。
 *
 * 用法：
 *   node tools/sign-release.mjs                 # 签名 + 校验，产物在 dist/
 *   node tools/sign-release.mjs --verify <hap>  # 只校验某个已有 HAP 的签名类型
 *
 * 材料配置：signing/release.local.json（.gitignore 掉，不入库）。
 * 模板见 signing/release.example.json，获取发布证书的步骤见 docs/SIGNING.md。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const CONFIG = path.join(ROOT, 'signing', 'release.local.json');
const APP_JSON5 = path.join(ROOT, 'AppScope', 'app.json5');
const PACK_INFO = path.join(ROOT, 'entry', 'build', 'default', 'outputs', 'default', 'pack.info');

const IDE_CANDIDATES = [
  process.env.DEVECO_HOME,
  'C:\\Program Files\\Huawei\\DevEco Studio',
  'C:\\Program Files\\Huawei\\DevEco\\DevEco Studio',
].filter(Boolean);

function die(lines) {
  console.error('\n[发布签名] 失败：');
  for (const l of [].concat(lines)) console.error('  - ' + l);
  process.exit(1);
}

function findJava() {
  const explicit = process.env.DEVECO_JAVA_HOME || process.env.JAVA_HOME;
  const tries = [];
  if (explicit) tries.push(path.join(explicit, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  for (const ide of IDE_CANDIDATES) {
    tries.push(path.join(ide, 'jbr', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  }
  for (const t of tries) {
    if (fs.existsSync(t)) return t;
  }
  // 最后一招：PATH 上的 java
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

function findSignTool() {
  const sdks = [];
  if (process.env.DEVECO_SDK_HOME) sdks.push(process.env.DEVECO_SDK_HOME);
  for (const ide of IDE_CANDIDATES) sdks.push(path.join(ide, 'sdk'));
  for (const sdk of sdks) {
    const jar = path.join(sdk, 'default', 'openharmony', 'toolchains', 'lib', 'hap-sign-tool.jar');
    if (fs.existsSync(jar)) return jar;
  }
  die([
    '找不到 hap-sign-tool.jar。设置 DEVECO_SDK_HOME 指向 DevEco 的 sdk 目录，例如：',
    '  $env:DEVECO_SDK_HOME = "C:\\Program Files\\Huawei\\DevEco Studio\\sdk"',
  ]);
}

/**
 * 从 .p7b 里把那段 profile JSON 抠出来。
 * p7b 是 PKCS#7 SignedData，profile 明文 JSON 就躺在 encapContentInfo 里，
 * 前后都是 DER 二进制，所以按「{"version-name" 开头 + 括号配对」截取。
 */
function readProfileJson(p7bPath) {
  const text = fs.readFileSync(p7bPath).toString('latin1');
  const start = text.indexOf('{"version-name"');
  if (start < 0) throw new Error('在 ' + path.basename(p7bPath) + ' 里找不到 profile JSON');
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('profile JSON 不完整（' + path.basename(p7bPath) + '）');
}

function readAppBundleName() {
  const raw = fs.readFileSync(APP_JSON5, 'utf8');
  const m = raw.match(/"bundleName"\s*:\s*"([^"]+)"/);
  if (!m) die('AppScope/app.json5 里读不到 bundleName');
  return m[1];
}

/** 应用版本号（上架看的是这个，不是 profile 文档版本） */
function readAppVersion() {
  const raw = fs.readFileSync(APP_JSON5, 'utf8');
  const code = raw.match(/"versionCode"\s*:\s*(\d+)/);
  const name = raw.match(/"versionName"\s*:\s*"([^"]+)"/);
  return { code: code ? Number(code[1]) : null, name: name ? name[1] : null };
}

/** 包里实际打进去的版本号（pack.info 由 hvigor 生成，比 app.json5 更接近真相） */
function readPackVersion() {
  if (!fs.existsSync(PACK_INFO)) return { code: null, name: null };
  try {
    const v = JSON.parse(fs.readFileSync(PACK_INFO, 'utf8')).summary?.app?.version ?? {};
    return { code: v.code ?? null, name: v.name ?? null };
  } catch {
    return { code: null, name: null };
  }
}

function runJava(java, jar, args) {
  // 用文件描述符接输出，而不是 pipe：某些受限环境下子进程开不了命名管道，
  // 直接重定向到文件最稳；同时出错时还能把工具原话打出来。
  const logPath = path.join(require_tmp(), 'run-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.log');
  const fd = fs.openSync(logPath, 'w');
  let res;
  try {
    res = spawnSync(java, ['-jar', jar, ...args], { stdio: ['ignore', fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  return { status: res.status, error: res.error, log };
}

function tail(text, n = 12) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  return lines.slice(-n).join('\n');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 校验：用 verify-app 回读包里真正生效的签名信息 */
function verifyHap({ java, jar, hap, expectBundle }) {
  const tmpProfile = path.join(require_tmp(), 'profile-' + Date.now() + '.p7b');
  const tmpChain = path.join(require_tmp(), 'chain-' + Date.now() + '.cer');
  const r = runJava(java, jar, [
    'verify-app',
    '-inFile', hap,
    '-outCertChain', tmpChain,
    '-outProfile', tmpProfile,
  ]);
  if (r.error) die('调用 java 失败：' + r.error.message);
  if (r.status !== 0) die(['verify-app 校验不通过（退出码 ' + r.status + '）：' + hap, tail(r.log)]);

  const profile = readProfileJson(tmpProfile);
  const problems = [];
  if (profile.type !== 'release') {
    problems.push(
      'profile type 是 "' + profile.type + '"，不是 "release"。' +
      (profile.type === 'debug'
        ? '\n      → 这是调试证书签的包，只能装进 device-ids 白名单里的设备，应用市场不认。' +
          '\n      → 需要先在应用市场申请「发布证书」+「发布 Profile」，见 docs/SIGNING.md。'
        : '')
    );
  }
  if (expectBundle && profile['bundle-info']?.['bundle-name'] !== expectBundle) {
    problems.push(
      'profile 里的 bundle-name 是 "' + profile['bundle-info']?.['bundle-name'] +
      '"，但项目是 "' + expectBundle + '"（包名不一致，装不上）'
    );
  }
  // 注意：profile 顶层的 "version-name"/"version-code" 是 **Profile 文档版本**（固定 2.0.0/2），
  // 不是应用版本号，所以这里不拿它跟 pack.info 比 —— 比了只会误报。
  // 应用版本号以 AppScope/app.json5 为准，由构建写进 pack.info，下面打印出来人工核对。
  if (problems.length > 0) {
    fs.rmSync(tmpProfile, { force: true });
    fs.rmSync(tmpChain, { force: true });
    die(problems);
  }
  return { profile, chain: tmpChain };
}

const _tmp = [];
function require_tmp() {
  if (_tmp.length === 0) _tmp.push(fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'sign-release-')));
  return _tmp[0];
}

function cleanup() {
  for (const d of _tmp) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG)) {
    die([
      '缺少 ' + path.relative(ROOT, CONFIG) + '（这个文件含口令，已 .gitignore）。',
      '照 signing/release.example.json 抄一份，把六个字段填成自己的材料路径与口令；',
      '材料怎么来见 docs/SIGNING.md。',
    ]);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch (e) {
    die('signing/release.local.json 解析失败：' + e.message);
  }
  const missing = ['storeFile', 'keyAlias', 'storePassword', 'keyPassword', 'certpath', 'profile']
    .filter((k) => !cfg[k]);
  if (missing.length > 0) die('配置缺字段：' + missing.join(', '));
  const gone = ['storeFile', 'certpath', 'profile'].filter((k) => !fs.existsSync(cfg[k]));
  if (gone.length > 0) {
    die(gone.map((k) => k + ' 指向的文件不存在：' + cfg[k]));
  }
  return cfg;
}

function main() {
  const argv = process.argv.slice(2);
  const java = findJava();
  const jar = findSignTool();
  const bundle = readAppBundleName();

  // 只校验模式：node tools/sign-release.mjs --verify <hap>
  const vi = argv.indexOf('--verify');
  if (vi >= 0) {
    const hap = path.resolve(argv[vi + 1] || '');
    if (!hap || !fs.existsSync(hap)) die('--verify 需要给一个存在的 .hap 路径');
    const { profile } = verifyHap({ java, jar, hap, expectBundle: bundle });
    const appVer = readAppVersion();
    const packVer = readPackVersion();
    console.log('[发布签名] 校验通过');
    console.log('  文件：' + hap);
    console.log('  大小：' + (fs.statSync(hap).size / 1024 / 1024).toFixed(2) + ' MB');
    console.log('  sha256：' + sha256(hap));
    console.log('  profile type：' + profile.type);
    console.log('  bundle-name：' + profile['bundle-info']?.['bundle-name']);
    console.log('  应用版本（app.json5）：' + appVer.name + ' / ' + appVer.code);
    if (packVer.code != null) console.log('  应用版本（pack.info）：' + packVer.name + ' / ' + packVer.code);
    console.log('  Profile 有效期至：' + new Date(profile.validity['not-after'] * 1000).toISOString().slice(0, 10));
    cleanup();
    return;
  }

  const cfg = loadConfig();
  const unsigned = path.resolve(ROOT, cfg.unsignedHap || 'entry/build/default/outputs/default/entry-default-unsigned.hap');
  if (!fs.existsSync(unsigned)) {
    die([
      '找不到未签名的 HAP：' + path.relative(ROOT, unsigned),
      '先构建 release 版：hvigorw assembleHap -p buildMode=release --no-daemon',
    ]);
  }
  const outDir = path.resolve(ROOT, cfg.outDir || 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, cfg.outName || 'jiankebiao-release-signed.hap');

  const signArgs = [
    'sign-app',
    '-mode', 'localSign',
    '-signAlg', 'SHA256withECDSA',
    '-keyAlias', cfg.keyAlias,
    '-keystoreFile', cfg.storeFile,
    '-keystorePwd', cfg.storePassword,
    '-keyPwd', cfg.keyPassword,
    '-appCertFile', cfg.certpath,
    '-profileFile', cfg.profile,
    '-inFile', unsigned,
    '-outFile', out,
  ];
  console.log('[发布签名] 签名中…（' + path.basename(unsigned) + ' → ' + path.relative(ROOT, out) + '）');
  const r = runJava(java, jar, signArgs);
  if (r.error) die('调用 java 失败：' + r.error.message);
  if (r.status !== 0 || !fs.existsSync(out)) {
    fs.rmSync(out, { force: true });
    die([
      'sign-app 失败（退出码 ' + r.status + '）。常见原因：',
      '  · 口令不对（.p12 的 storePassword / keyAlias 的 keyPassword）',
      '  · .cer 与 .p12 不是同一对密钥（发布证书必须用这个 .p12 生成的 CSR 去申请）',
      '  · Profile 勾的证书不是这张 .cer，或 Profile 里的包名不是 ' + bundle,
      'hap-sign-tool 原话：',
      tail(r.log),
    ]);
  }

  const { profile, chain } = verifyHap({ java, jar, hap: out, expectBundle: bundle });
  const packVer = readPackVersion();

  console.log('[发布签名] 完成并通过校验');
  console.log('  产物：' + out);
  console.log('  大小：' + (fs.statSync(out).size / 1024 / 1024).toFixed(2) + ' MB');
  console.log('  sha256：' + sha256(out));
  console.log('  profile type：' + profile.type);
  console.log('  bundle-name：' + profile['bundle-info']?.['bundle-name']);
  if (packVer.code != null) console.log('  应用版本：' + packVer.name + ' / ' + packVer.code);
  console.log('  Profile 有效期至：' + new Date(profile.validity['not-after'] * 1000).toISOString().slice(0, 10));
  console.log('\n下一步：把这个 .hap 传进应用市场「上传新版本」。');
  cleanup();
}

main();
