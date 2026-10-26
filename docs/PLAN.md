# 修复计划（19 项 · 2026-10-26 起）

来源：真机 Pura 70 实测后逐条盘点的问题清单。每阶段独立提交，**全绿才进下一阶段**。

阶段 | 内容 | 状态
---|---|---
P1 | 数据可靠性：建表事务、存在性校验、快照读事务、写库边界校验 | 已完成（a56ebdc）
P2 | 合并键：教学班"有交集即同一门课" | 已完成（7be6db8）
P3 | 解析健壮性：静默丢弃改成明说 + 夹具回归 | 已完成（e24bd51）
P4 | 课表**截图**导入（新功能） | 代码完成 + 单测（9f6740d），**真机待验**（等真实截图）
P5 | Web/pdf.js：异常路径释放 + CSP | 已完成（76955a3）；4.x 迁移按计划不做
P6 | 代码卫生：资源释放、去重实现、删死代码 | 已完成（76955a3）
P7 | UI 细节：校对页留白、窄列竖排、学期设置箭头 | 已完成（76955a3），**窄格排版待真机看**
P8 | 工程收尾：签名可复现、兼容级别下探 | 已完成（本轮提交）

## 每阶段收尾必跑

```powershell
node --test "tests/*.test.ts"          # 逻辑/数据断言（当前 295 条）
node tools/check-architecture.mjs      # 依赖方向 + .ts 扩展名
# 构建（debug + release，需本机签名）
& hvigorw assembleHap --no-daemon
# 真机回归受影响链路
```

## 取舍记录（边做边补）

- **P5.2 pdf.js 4.x**：默认不做。3.11.174 是最后一个 UMD 版本，4.x 只发 ESM，
  viewer 要改 `<script type="module">` + 模块 worker + 换 `InlineCMapReaderFactory` 签名，
  整条导入链要重验。先把"异常路径释放 + CSP"做完，4.x 单独立项。
- **P8.2 兼容级别**：以编译器为准逐档下探；只承诺"编译期保证 API 存在"，
  老设备无法实测（手上只有 API 26 的 Pura 70）。

## P8 的实际结论（兼容级别下探）

用编译器试过降级：把 `compatibleSdkVersion` 写成 `"5.0.0(12)"` **能编译通过** ——
但编译器**并不做 API 版本检查**（它连 `UIContext.getPromptAction()`（@since 18）都没报）。
所以下限只能靠人工逐个核对平台接口的 `@since`：

| 接口 | @since | 用在哪 |
|---|---|---|
| `RdbStore.createTransaction` | **14** | `platform/Rdb.ts` 的 runSteps / insertAndGetId / transaction |
| `UIContext.getPromptAction` | **18** | 原来的 30 处 toast —— **已改用 `promptAction.showToast`（@since 9）** |
| `UIContext.getHostContext` | 12 | 页面里取 UIAbilityContext |
| `Configuration.fontSizeScale` | 12 | 字体缩放（CellLayout 的输入） |
| `PhotoViewPicker` | 10 | 选图（作息/课表截图导入） |
| `CoreVisionKit` / `textRecognition` | 11 / 4 | OCR |
| `PixelMap.rotate` | 9 | EXIF 方向纠正 |
| `beginTransaction` / `getDefaultDisplaySync` / `getMainWindowSync` / `fileIo.openSync` / `Web` | 9 | 各处 |
| `util.TextDecoder` | 7 | pdf.js 结果解码 |
| `ImageSource.getImageProperty` | 6 | EXIF 读取 |

下限因此是 **14**（`5.0.2(14)`）。想降到 12 只有一条路：把 RDB 的三处事务从
`createTransaction()` 改成 `beginTransaction()/commit()/rollBack()`（@since 9）。
那等于用"连接池下 `last_insert_rowid()` 是否可靠"这个**未经真机验证**的假设，
去换"多支持一个早期版本" —— 按"不留隐患"的原则，不换。