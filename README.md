# 简课表 · 鸿蒙版（Calss-Harmony）

纯本地课程表应用的 **HarmonyOS（ArkTS / ArkUI）** 版本，由 Android 版
[Calss-Android](https://github.com/yun01lm/Calss-Android) 迁移而来。

> 设计目标与 Android 版一致：**纯本地 · 零权限 · 零后台 · 打开即当前周**。

## 当前进度

| 阶段 | 内容 | 状态 |
|------|------|------|
| 0A | 仓库 / 工程骨架 / 本地可编译 | ✅ |
| 0B | 纯逻辑层移植：**9/9 模块完成（102 条断言）** | ✅ |
| 0C | DevEco 环境 + 模拟器跑通（Mate 90 Pro / HarmonyOS 7.0.0） | ✅ |
| 0D | 三个 spike（ArkUI 周视图 / PDF 取文本 / OCR） | ✅ 结论见 `docs/SPIKES.md`（PDF Kit 不可用→改 pdf.js；模拟器无 OCR 后端） |
| 1 | 数据层：schema / 迁移 / 建库决策 / `SqlRunner` / `ScheduleStore` + `platform/Rdb.ts`（**161 断言 + 实机建库·迁移·持久化**） | ✅ |
| 2 | 周视图：网格 + 翻周 + 详情卡（**188 断言 + 实机**） | ✅ |
| 3 | 导入（PDF：选文件→预览→覆盖/合并/新建，**真实课表 24 门**）+ 作息编辑 + 多课表 | ✅ |
| 3b | 课程编辑：点空白格新建 / 点色块编辑·删除；学期设置（开学日 / 总周数）—— **253 断言 + 实机建·改·删** | ✅ |
| 3c | 自定义安排：点空白格选「自定义安排」新建 / 点色块编辑·删除（标题、备注、星期、起止节、周次）—— **270 断言 + 实机建·改·删·重启留存** | ✅ |
| 3d | 作息：编辑（节次号/分组/起止）、加一节、从其他课表复制；**导入作息**三条通道（图片 OCR / 粘贴文本 / PDF）→ 校对页 → 整表替换 —— **295 断言 + 实机（OCR 识别待真机）** | ✅ |
| 4 | 验收：冷启动 / 体积 / 零权限（见 `docs/ACCEPTANCE.md`）；**真机 Pura 70 / HarmonyOS 7.0 实测**：冷启动 381 ms（release）、图片 OCR 跑通 | ✅ |

## 环境

- DevEco Studio 26.0.0（本机已装：`C:\Program Files\Huawei\DevEco Studio`）
- HarmonyOS SDK **API 26（platform 26.0.0）**：`targetSdkVersion 26.0.0`
- **最低支持 API 14（HarmonyOS NEXT 5.0.2）**：`compatibleSdkVersion "5.0.2(14)"`。
  这个下限不是拍的，是逐个核对用到的平台接口 `@since` 得到的 —— 卡在 14 的只有一条：
  `relationalStore.createTransaction()`（@since 14，事务绑定连接，`last_insert_rowid()` 才可靠）。
  12 需要重写整个 RDB 事务层，换来的只是多支持一个早期版本，不值得。
- 模拟器：Mate 90 Pro / Mate X7 / MatePad Pro 13 / MateBook Pro（均已部署）

## 构建

**方式一：DevEco Studio（推荐）**

`File → Open` 打开本目录 → 等 Sync 完成 → 选设备 → Run。
首次 Run 需要登录华为账号做**自动签名**（`File → Project Structure → Signing Configs → Automatically generate signature`）。

**方式二：命令行（用 IDE 自带的 hvigor，已在本机验证通过）**

```powershell
$ide = 'C:\Program Files\Huawei\DevEco Studio'
$env:DEVECO_SDK_HOME = "$ide\sdk"
$env:PATH = "$ide\tools\node;$env:PATH"
& "$ide\tools\node\node.exe" "$ide\tools\hvigor\bin\hvigorw.js" assembleHap --no-daemon
```

产物：`entry/build/default/outputs/default/entry-default-unsigned.hap`

> 真机安装需要签名：DevEco Studio → `File → Project Structure → Signing Configs` → 勾「自动生成签名」。该操作会把签名材料（`.p12/.cer/.p7b`，在 `%USERPROFILE%\.ohos\config`）的路径写进 `build-profile.json5` —— **属于个人材料，不进仓库**，换机器时重新勾一次即可。
>
> 仓库里的 `build-profile.json5` 是 `"signingConfigs": []` 的干净版本；本机那份因为写了签名路径，
> 被 `git update-index --skip-worktree build-profile.json5` 保护着（改它不会被提交）。
> **安装前先跑一次体检**，它会在缺签名时提前给出操作步骤，而不是等 `hdc install` 报
> `9568320 no signature file`：
>
> ```powershell
> npm run check:sign      # 只体检
> npm run verify:device   # 体检 + 构建
> ```
>
> 注：工程里**不提交** `hvigorw` / `hvigorw.bat` / `hvigor/hvigor-wrapper.js`
> —— 它们由 DevEco 在首次 Sync 时按你的 IDE 版本生成；手工拷贝 IDE 内部的 launcher 会因缺少 `hvigorw.js` 而失败。

## 导入通道（三条）

| 通道 | 输入 | 特点 |
|---|---|---|
| PDF 文件 | 学校导出的课表 PDF | pdf.js 取文字+坐标；有周次/教学班，"截图式 PDF"会兜底到网格还原 |
| 课表截图 | 相册里的课表图片 | OCR → 网格还原；**截图没有周次**，按整学期导入并提示 |
| 教务系统表格 | `.xls`（其实是 HTML）/`.html` | **不靠 OCR、不靠 Web**，纯函数解析；文件和底部作息一起读 |

第三条是给"教务系统导出的是网页表格"的学校用的：里面同时有课表与作息时间表，
作息不会自动写，预览里点「一并导入作息」才写（整表替换属于破坏性操作）。

## 已验证

| 项 | 结果 |
|---|---|
| ArkTS 编译 | ✅ `BUILD SUCCESSFUL`（33 tasks，约 8~13 s） |
| HAP 打包 | ✅ release 2.39 MB（未签名）/ 2.43 MB（debug 签名 HAP），其中 pdf.js 1.51 MB |
| 编译确实在检查类型 | ✅ 故意把 `number` 赋成 `'x'` → `ArkTS Compiler Error` |
| 关键配置坑 | `modelVersion` 必须 **6.0.0**；SDK 版本串必须是 **"26.0.0"**（不是 `"26.0.0(26)"`） |

## 设计约束（改代码前请遵守）

1. `entry/src/main/ets/logic/**` **禁止** import 任何 `@kit.*` / `@ohos.*` / 页面组件 ——
   保证逻辑层可以在 Node 上直接跑测试。
2. 行为以 Android 版为准，差异记录在 `docs/COMPAT.md`。
3. 不引入网络权限，不使用云能力，不加后台任务。
4. 不提交含个人信息的课表文件（见 `.gitignore`）。

## 文档

- `docs/ARCHITECTURE.md` —— 分层与模块职责
- `docs/MIGRATION.md` —— 与 Android 版的模块对照表
- `docs/COMPAT.md` —— 与 Android 版的行为差异（每条都写了理由）
- `docs/REVIEW.md` —— **自查记录**：修了什么、什么没修和为什么
- `docs/ACCEPTANCE.md` / `docs/SPIKES.md` —— 验收数据与 spike 结论

## 校验

```powershell
npm test                        # 295 条断言，不需要鸿蒙 SDK
node tools/check-architecture.mjs   # logic/ 与 data/ 的依赖方向 + .ts 扩展名
```
