#!/usr/bin/env node
/**
 * 用「发布证书 + 发布 Profile」给上架包签名，并当场校验。
 *
 * 为什么需要它：DevEco 的「自动签名」只会生成 **调试证书**（profile 里 "type":"debug"，
 * 还带一份 device-ids 白名单）。这样的包只能装进白名单里那一台机器，应用市场
 * 「上传新版本 / 上架自检」不收。要上架就必须用应用市场签发的
 * **发布证书**（.cer）+ **发布 Profile**（.p7b）重新签一次。
 *
 * 另外 hvigor 不收明文口令（`The length of the storePassword or keyPassword field
 * in the signature configuration is less than 32` —— 它期望 DevEco 加密过的串），
 * 所以 build-profile.json5 里塞不进我们自己生成的发布材料；要么在 DevEco 图形界面
 * 里填一次让它加密，要么像这里一样直接调官方 signing 工具。两条路签出来的包一样。
 *
 * 本脚本调的就是 hvigor 的 SignHap / SignApp 任务内部用的那个
 * `hap-sign-tool.jar sign-app`，然后立刻 `verify-app` 回读包里真正生效的 profile，
 * 断言三件事：
 *
 *   1. profile type == "release"（不是 debug）
 *   2. profile 里的 bundle-name == AppScope/app.json5 的 bundleName
 *   3. 摘要校验通过（verify-app 自己做的）
 *
 * 任何一条不满足就删掉产物并退出码 1 —— 宁可没有包，也不给一个"看着像能上传"的包。
 *
 * 用法：
 *   node tools/sign-release.mjs                  # 签 .app（应用市场要的就是这个格式）
 *   node tools/sign-release.mjs --hap            # 签单个 .hap（hdc 安装/真机自测用）
 *   node tools/sign-release.mjs --verify <file>  # 只校验已有的 .app / .hap
 *
 * .app 说明：hvigor 打进 .app 里的 HAP 是**未签名**的，整个 .app 才是签名对象
 * （官方就是如此，DevEco 自己产出的 app 包里那个 entry-default.hap 也没有签名块）。
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
const DEFAULT_UNSIGNED_HAP = path.join(ROOT, 'entry', 'build', 'default', 'outputs', 'default', 'entry-default-unsigned.hap');
const DEFAULT_UNSIGNED_APP = path.join(ROOT, 'build', 'outputs', 'default', 'Calss-Harmony-default-unsigned.app');

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

const _tmp = [];
function tmpDir() {
  if (_tmp.length === 0) _tmp.push(fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'sign-release-')));
  return _tmp[0];
}

function cleanup() {
  for (const d of _tmp) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
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
  const logPath = path.join(tmpDir(), 'run-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.log');
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
function verifyPackage({ java, jar, file, expectBundle }) {
  const isApp = file.toLowerCase().endsWith('.app');
  const outProfile = path.join(tmpDir(), 'profile-' + Date.now() + '.p7b');
  const outChain = path.join(tmpDir(), 'chain-' + Date.now() + '.cer');
  const args = ['verify-app', '-inFile', file, '-outCertChain', outChain, '-outProfile', outProfile];
  if (isApp) args.push('-inForm', 'zip');
  const r = runJava(java, jar, args);
  if (r.error) die('调用 java 失败：' + r.error.message);
  if (r.status !== 0) die(['verify-app 校验不通过（退出码 ' + r.status + '）：' + file, tail(r.log)]);

  const profile = readProfileJson(outProfile);
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
  // .app 里应该整整齐齐躺着一个 entry-default.hap（zip 的本地头里有文件名）
  if (isApp) {
    const raw = fs.readFileSync(file).toString('latin1');
    if (raw.indexOf('entry-default.hap') < 0) problems.push('.app 里没有 entry-default.hap，包不完整');
    if (raw.indexOf('pack.info') < 0) problems.push('.app 里没有 pack.info，应用市场会拒');
  }
  if (problems.length > 0) die(problems);
  return { profile, isApp };
}

function loadConfig() {
  if (!fs.existsSync(CONFIG)) {
    die([
      '缺少 ' + path.relative(ROOT, CONFIG) + '（这个文件含口令，已 .gitignore）。',
      '照 signing/release.example.json 抄一份，把字段填成自己的材料路径与口令；',
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
  if (gone.length > 0) die(gone.map((k) => k + ' 指向的文件不存在：' + cfg[k]));
  return cfg;
}

function printVerified(label, file, profile, appVer, packVer) {
  console.log('[发布签名] ' + label + '校验通过');
  console.log('  文件：' + file);
  console.log('  大小：' + (fs.statSync(file).size / 1024 / 1024).toFixed(2) + ' MB');
  console.log('  sha256：' + sha256(file));
  console.log('  profile type：' + profile.type);
  console.log('  bundle-name：' + profile['bundle-info']?.['bundle-name']);
  console.log('  app-distribution-type：' + (profile['app-distribution-type'] ?? '（无）'));
  console.log('  应用版本（app.json5）：' + appVer.name + ' / ' + appVer.code);
  if (packVer.code != null) console.log('  应用版本（pack.info）：' + packVer.name + ' / ' + packVer.code);
  console.log('  Profile 有效期至：' + new Date(profile.validity['not-after'] * 1000).toISOString().slice(0, 10));
}

function main() {
  const argv = process.argv.slice(2);
  const java = findJava();
  const jar = findSignTool();
  const bundle = readAppBundleName();

  // 只校验模式：--verify <file>
  const vi = argv.indexOf('--verify');
  if (vi >= 0) {
    const file = path.resolve(argv[vi + 1] || '');
    if (!file || !fs.existsSync(file)) die('--verify 需要给一个存在的 .app / .hap 路径');
    const { profile } = verifyPackage({ java, jar, file, expectBundle: bundle });
    printVerified('', file, profile, readAppVersion(), readPackVersion());
    cleanup();
    return;
  }

  const wantHap = argv.includes('--hap');
  const cfg = loadConfig();
  const unsigned = wantHap
    ? path.resolve(ROOT, cfg.unsignedHap || DEFAULT_UNSIGNED_HAP)
    : path.resolve(ROOT, cfg.unsignedApp || DEFAULT_UNSIGNED_APP);
  if (!fs.existsSync(unsigned)) {
    die([
      '找不到未签名的 ' + (wantHap ? 'HAP' : 'APP 包') + '：' + path.relative(ROOT, unsigned),
      wantHap
        ? '先构建：hvigorw assembleHap -p buildMode=release --no-daemon'
        : '先构建：hvigorw assembleApp -p buildMode=release --no-daemon',
    ]);
  }

  const appVer = readAppVersion();
  const version = appVer.name || '0.0.0';
  const outDir = path.resolve(ROOT, cfg.outDir || 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, cfg[wantHap ? 'outNameHap' : 'outNameApp'] ||
    (wantHap ? `jiankebiao-${version}-release-signed.hap` : `jiankebiao-${version}-release.app`));

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
  if (!wantHap) signArgs.push('-inForm', 'zip');   // .app 就是 zip 容器
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

  const { profile } = verifyPackage({ java, jar, file: out, expectBundle: bundle });
  printVerified('完成并', out, profile, appVer, readPackVersion());
  console.log(wantHap
    ? '\n下一步：hdc install 到真机自测。'
    : '\n下一步：把这个 .app 传进应用市场「上传新版本」（该处只收 .app，不收 .hap）。');
  cleanup();
}

main();
