# 发布签名（上架用的那一套）

上架和应用市场自检要的是 **发布证书 + 发布 Profile**；DevEco 的「自动签名」给的是
**调试证书 + 调试 Profile**，两者不通用。这一页写清差别、材料从哪来、怎么出包。

## 1. 两种签名的实际差别（不是概念，是包里能读出来的字段）

用 SDK 自带的 `hap-sign-tool.jar verify-app` 把包拆开看 profile：

| | 自动签名（调试） | 上架（发布） |
|---|---|---|
| profile 里的 `"type"` | `debug` | `release` |
| 证书 Subject 的 CN 结尾 | `,Development` | `,Release` |
| `debug-info.device-ids` | **有**，一份 UDID 白名单 | 无 |
| 能装在哪 | 只有白名单里那台机器 | 所有 HarmonyOS 设备 |
| 应用市场「上传新版本」 | 拒收 | 收 |

所以"签名已经做过了"这句话不够 —— 要看**签的是哪一种**。一条命令就能看出来：

```bash
node tools/sign-release.mjs --verify entry/build/default/outputs/default/entry-default-signed.hap
```

调试包会直接被打回：

```
[发布签名] 失败：
  - profile type 是 "debug"，不是 "release"。
      → 这是调试证书签的包，只能装进 device-ids 白名单里的设备，应用市场不认。
```

## 2. 一次性准备

### 2.1 生成发布密钥库 + 证书请求文件（已完成）

发布证书必须由**本地生成的密钥对**去申请 —— 私钥不能出本机。本项目已经用 DevEco 自带
JBR 的 keytool 生成好了（和华为文档里的参数一致）：

```powershell
$jbr = "C:\Program Files\Huawei\DevEco Studio\jbr\bin"
& "$jbr\keytool.exe" -genkeypair -alias "calss-release" -keyalg EC -groupname secp256r1 `
  -sigalg SHA256withECDSA -dname "C=CN,O=<组织>,OU=<开发者ID>,CN=<名字>" `
  -keystore calss-release.p12 -storetype pkcs12 -validity 9125 `
  -storepass <口令> -keypass <口令>

& "$jbr\keytool.exe" -certreq -alias "calss-release" `
  -keystore calss-release.p12 -file calss-release.csr -storepass <口令> -keypass <口令>
```

产物（都在 `%USERPROFILE%\.ohos\config\`，**不在仓库里**）：

| 文件 | 用途 |
|---|---|
| `calss-release.p12` | 私钥库，签名时用。**丢了就只能重新申请证书**（发布证书有配额），务必备份 |
| `calss-release.csr` | 交给应用市场换发布证书的请求文件 |
| `calss-release.cer` | 应用市场签发回来的发布证书（下一步才产生） |
| `calss-release.p7b` | 应用市场签发回来的发布 Profile（下一步才产生） |

### 2.2 在应用市场换回 `.cer` 和 `.p7b`

AppGallery Connect → 我的项目 → 项目设置 → **证书、APP ID 和 Profile**：

1. **证书** 页签 → 新增证书 → 类型选「发布证书」→ 上传 `calss-release.csr` → 下载 `.cer`
2. **Profile** 页签 → 添加 → 类型选「发布」→ 选包名 `com.calss.jiankebiao` → 勾刚申请的发布证书 → 下载 `.p7b`

两个文件都丢进 `%USERPROFILE%\.ohos\config\`，名字保持 `calss-release.cer` / `calss-release.p7b`。

### 2.3 写本地材料配置

```powershell
Copy-Item signing\release.example.json signing\release.local.json
# 填 storePassword / keyPassword（见下），其余字段默认已指向上面那些路径
```

`signing/release.local.json` 含口令，`.gitignore` 已经挡掉，不入库。
（`.p12`/`.cer`/`.p7b` 也在 `.gitignore` 里，另有一条 `*.cer` 兜底。）

## 3. 出包

### 3.1 应用市场要的是 `.app`，不是 `.hap`

应用市场「上传新版本」那个框写的是「支持 APP 格式」——要 **App Pack（`.app`）**。
两者的关系：`.app` 是个 zip 容器，里面装着各模块的 `entry-default.hap` + `pack.info` + `pac.json`，
**签名对象是整个 `.app`**；容器里那个 HAP 是未签名的（实测 DevEco 自己产出的 `-signed.app`
里，`entry-default.hap` 也没有签名块，`verify-app` 报 `No Hap Signing Block`）。这是官方的形态，
不是我们漏签。

```powershell
# ① release 版（AOT 编译，不带调试信息）—— 产出 build/outputs/default/*-unsigned.app
hvigorw assembleApp -p buildMode=release --no-daemon

# ② 换发布材料重签 + 当场校验 —— 产出 dist/jiankebiao-0.1.2-release.app
npm run sign:release
```

只想 hdc 装到真机自测（走单 HAP）时：

```powershell
hvigorw assembleHap -p buildMode=release --no-daemon   # 产出 entry-default-unsigned.hap
npm run sign:release:hap                               # 产出 dist/jiankebiao-0.1.2-release-signed.hap
```

### 3.2 为什么不在 `build-profile.json5` 里配 release 签名

试过了，hvigor 直接拒：

```
00303116 Configuration Error
The length of the storePassword or keyPassword field in the signature configuration is less than 32.
```

它只收 DevEco 用本机密钥加密过的口令串，明文塞进去一律当"太短"。
所以要么在图形界面里填一次让它加密（见 §5），要么像脚本这样直接调官方签名工具，
两条路签出来的包在应用市场看来没有区别。

### 3.3 脚本断言什么

`tools/sign-release.mjs` 调的正是 hvigor 的 `SignHap` / `SignApp` 任务内部用的同一个
`hap-sign-tool.jar sign-app`，只是材料换成发布材料；签名完立刻回读包里的 profile 断言：

1. `profile.type === "release"`
2. profile 里的 `bundle-name` == `AppScope/app.json5` 的 `bundleName`
3. `verify-app` 的证书链与摘要校验通过（`.app` 还要确认里面确实有 `entry-default.hap` 与 `pack.info`）

任何一条不满足就**删掉产物**并退出码 1 —— 宁可没有包，也不给一个"看着像能上传"的包。

## 4. 版本号

- 上架的 `versionCode` 必须**大于线上已有版本**，改 `AppScope/app.json5`。
- 现在：`versionCode 1000002` / `versionName "0.1.2"`。
- `pack.info` 里的版本号由构建写死，签名后脚本会把它打印出来核对。

## 5. 用 DevEco 图形界面也行

不想用脚本，等价路径：`File → Project Structure → Signing Configs` → 取消勾选
「Automatically generate signature」→ 手动填 `.p12` / `.cer` / `.p7b` / 口令 → Apply。
之后 `Build → Build App(s)` 选 release，DevEco 会自己把 HAP 和 `.app` 都签好
（它会用本机密钥把口令加密写回 `build-profile.json5`，所以 GUI 这条路没有明文口令的问题）。

## 6. 常见报错

| 报错 | 原因 |
|---|---|
| `9568320 no signature file` | 装的是 unsigned HAP，见 `tools/check-signing.mjs` |
| `The bundleName ... does not match the generated SigningConfig` | 改过包名，但签名材料还是旧包名的 → 重新申请 Profile |
| 应用市场提示不是 Release 类型 | 传的是调试签名的包 → `node tools/sign-release.mjs` 重签 |
| `sign-app` 退出码非 0 | 口令错 / `.cer` 与 `.p12` 不是一对密钥 / Profile 勾错证书，脚本会打印工具原话 |
