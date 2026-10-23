# 自查记录（2026-10-23）

功能做到与 Android 版对齐之后，把整个工程过了一遍。这份文档记录**查了什么、改了什么、什么没改和为什么**，
方便以后翻旧账：下次改到这里，先看看这里有没有已经踩过的坑。

## 怎么查的

| 手段 | 范围 |
|---|---|
| 我自己通读 | `pages/Index.ets`（2400 行）、`view/*.ets`、`.gitignore`、CI、`package.json` |
| 脚本扫 | 空 `catch`、`TODO/FIXME/console.*`、`@State` 的引用数（找死状态）、ArkTS 编译警告清单 |
| 子代理审计 A | `data/**` + `logic/**`（23 个文件），可以写探针脚本证明问题 |
| 子代理审计 B | `platform/**` + `entryability` + 构建配置 + `viewer.html` + 文档一致性 |
| 机器验证 | Node 断言、debug 与 release 构建、**release 装到模拟器**、全新安装（空库）首启、返回键、迁移演练 |

审计报告不是"读一遍就算数"：每条都在代码里核过，能写测试的都先写测试再改。

## 已修（11 项）

| # | 级别 | 问题 | 修法 | 验证 |
|---|---|---|---|---|
| H-1 | 高 | **保存课程不是原子操作**：先 `exec(DELETE)` 删旧时段、再循环 `assertSafeMask`。周次一不合法就抛错，而旧时段已经删了 —— 一门课凭空变成"没有时间"，界面上直接消失 | 先校验全部掩码；UPDATE + DELETE + INSERT 放进同一个 `runSteps` 事务；新建路径失败时补偿删除课程行；更新前确认目标行存在 | `store.test.ts` 三条新用例（掩码非法时旧时段还在 / 目标已删则报错不留孤儿 / 归并后只有一条课程行） |
| H-2 | 高 | **导入把"一门课上两次"写成两条课程行**：两个解析器都按格子/段落输出，Android 在解析后有 `merge()`，本版没有。后果是改一门只改一半、删一门只删一半、合并导入永远更新不到另一条 | 新增 `data/CourseMerge.ts`（按「名称+教师+地点」归并、时段去重、掩码为 0 的课丢掉并报名字）；`mergeCourses` / `replaceCourses` 内部再兜一次；`ScheduleStore.courseKey` 改为复用 `courseKeyOf`（不再两份实现） | 新 `tests/course-merge.test.ts` 10 条 + `store.test.ts` 3 条归并用例 |
| H-3 | 高 | **升级可能把库永久卡死**：`PRAGMA user_version` 在迁移事务之外，存在"事务提交了、版本号没写进去"的窗口。而 v1→v2 的步骤不可重跑（`INSERT timetables id=1` + 三条 `ALTER`），重跑必撞约束 —— 之后每次启动都抛错，用户永远打不开 | 整套迁移改成可重跑（`WHERE NOT EXISTS` / `INSERT OR IGNORE` / 按 `pragma_table_info` 决定 ALTER）；回填只碰 `timetableId = 0`（否则重跑会把第 2、3 张课表的课搬回第 1 张）；`bootstrapPlan` 增加 `current=1 且表已是 v2 → repair` 分支 | 4 条新用例（v1 上跑两遍、重跑不搬课、repair 分支）；**设备上真跑了迁移演练**（`docs/evidence/36-migration-drill.jpeg`）：kind=upgrade / version=2 / 3 个索引 / 旧数据归到第 1 张 |
| H-4 | 高 | **release 包带一个"清空全部课程"的一键按钮**：开发者入口 5 次连点就能进来，点一下真的清空，无确认 | 入口与面板用 `BuildProfile.DEBUG` 挡住（release 里 5 次连点没反应）；两个动真库的按钮都加系统确认框 | 设备验证：debug 能开、且弹"不能撤销"的确认框；release 点 5 次无反应 |
| M-1 | 中 | **周次 54..64 能过表单但存不进库**：`WeekMasks` 到 64 周，库是 JS number（2^53 = 第 53 周）。`maskToDb` 在 try 外面抛，变成 unhandled rejection，界面像"点了没反应" | `CourseDraft.MAX_STORABLE_WEEK = 53`，超出直接标红说"最多第 53 周"；`maskToDb` 挪进 try | `course-draft.test.ts` 两条 |
| M-2 | 中 | **`runJavaScript` 没有硬超时**：回调丢了（渲染进程崩）就永远挂着，"解析中…"一直转、取消禁用、返回键被吞 | 每次调用 `Promise.race` 一个 5 秒计时器，超时返回 null | 编译 + 代码审阅（注入丢失回调需要改渲染进程，没法在模拟器上制造） |
| M-3 | 中 | **可能把上一份 PDF 的结果当成这一份**：`window.__pdfResult` 只有下一次抽取才会被覆盖。若新文件的抽取失败/推迟，第一轮轮询就读到旧值，"覆盖当前课表"会写进上一个文件的课 | 抽取前先跑 `PdfJs.CLEAR_SCRIPT` 清空两个全局变量 | 编译 + 代码审阅（同上） |
| M-4 | 中 | **`pdfPurpose` 没有复位**：导入成功后不重置，之后跑"PDF spike"的回送会被当成导入结果，spike 列表永远不更新、`pdfRunning` 卡在 true | 每处提取前显式设定 purpose，导入结束（成功/失败）都复位；导入与 spike 的按钮互相禁用 | 编译 + 代码审阅 |
| M-5 | 中 | **测试里"关掉外键"其实没关**：`node:sqlite` 默认 `enableForeignKeyConstraints = true`，helper 只在需要时开、从没显式关。于是"外键关着也不留孤儿"的三条用例一直是在开着外键的库上跑的 —— 永远绿、也证明不了什么 | helper 里显式 `PRAGMA foreign_keys = OFF`，并加 `foreignKeysEnabled()` 断言"确实是 0" | `store.test.ts` 断言 FK=0 后仍全绿（说明显式删除本来就正确） |
| M-6 | 中 | **`Rdb.open` 首次打开有竞态**：缓存要等 `await getRdbStore` 之后才填。冷启动首帧就能点「课表」「作息」，两次并发都 miss、都去开同名库（RDB 明确禁止），一个句柄被丢掉 | 缓存"正在打开"的 promise，并发调用共享同一次打开；失败也清掉标记 | 编译 + 代码审阅 |
| L-1 | 低 | **CI 守卫形同虚设**：grep 只看单行，而本仓库大量用多行 import、`export * from './X'`、`../` 跨层 —— 三类全都漏 | 换成 `tools/check-architecture.mjs`：真解析 import、检查零平台依赖 + `.ts` 扩展名 + 依赖方向 | **守卫自己也验证过**：故意放违规文件，四类违规全部报错并 exit 1 |

顺带修的（小）：`@State pageUrl` 无人使用；`ensureWeb` 上"用 loadUrl"的过时注释；
`node:sqlite` 相关 `engines` 从 `>=22.6` 提到 `>=24`（22.x 跑不了 `npm test`）；
`.gitignore` 补 `hvigorw` / `hvigor-wrapper.js` / `*.app` / `entry/.preview/`；
CI 触发从"只 main"改成所有 push/PR，并加 `permissions: contents: read`；
文档里过期的数字与"已完成/未完成"标记（`ACCEPTANCE.md` 原来还写着"新建课程只弹提示"）。

## 记录但没改（都写了理由）

| # | 问题 | 为什么先不改 |
|---|---|---|
| 1 | **pdf.js 的 Web 组件用过之后常驻**（约 1.5 MB + worker，下次启动慢 ~0.4s） | 释放要在导入结束后 `webRequested = false`，并确认不在轮询中途销毁。这条要改就得连"再次导入"的时序一起重验，属于下一轮单独做的事 |
| 2 | `SpikeProbe` 泄漏 ImageSource / PixelMap / OCR 服务（只在开发者入口跑） | 只影响开发期反复跑 spike；真要修就得给三段资源都套 try/finally，改完还得在真机上跑 OCR 才有意义（模拟器没后端） |
| 3 | `viewer.html` 出错时不 `doc.destroy()`；没有 CSP；pdf.js 3.11.174 偏旧 | 前两条一起做（try/finally + CSP），第三条要重新验证导入链；CVE-2024-4367 的缓解开关 `isEvalSupported:false` 已经开着 |
| 4 | `saveEvent` / `saveSlot` / `switchTo` 不校验目标是否存在（外键关着，UPDATE 0 行不报错） | `saveCourse` 已加校验（唯一会被"用户看不到的门"触发的一条）。其余需要各自的决定：是抛错还是返回 false |
| 5 | `createTimetable` 先提交课表行、再写作息，两步不是同一事务 | 要"事务内拿自增 id"，得给 `SqlRunner` 加能力；当前失败窗口极小且只影响新建课表 |
| 6 | `snapshot()` 是 5 条独立查询，不是一次读事务 | 单进程应用，读写不会并发到需要快照隔离；改成事务会让 `SqlRunner` 变复杂 |
| 7 | 死代码：`copySlots`、`saveEvent/deleteEvent`（自定义安排的 UI 还没做）、`WeekMasks.range`、`Minutes.parse`、`CourseDraft.rowSummary` 等 13 项 | 大多是为"自定义安排 UI"预留的；删掉以后再写一遍更亏。已在清单里，做那个界面时一并清理 |
| 8 | 重复实现：`Minutes.parse` vs `InputNorm.time`、`InputNorm.date` vs `WeekCalculator.epochDayOfIso`、节次分组阈值两处 | 都有测试覆盖，行为一致；合并要动两个模块的调用方，收益低于风险 |
| 9 | `GridFormatParser` 对"只有课名、没有详情行"的格子静默丢弃 / 粘到下一门课名上 | 真实课表里没出现过；改动它要重新验证解析，风险比收益大 |
| 10 | `dayOfWeek` / 节次范围没有在写库边界校验（`WeekItems` 也不校验） | 目前所有入口（表单、导入）都已夹过范围；再加一道属于防御性编程，等真有第二个写入口时加 |

## 现在还剩什么

1. **截图 OCR 导入** —— 模拟器没有 OCR 后端，只能真机验（`[1001400001]`）。
2. **自定义安排界面** —— 数据层与读路径都就绪，只差 UI。
3. **真机冷启动** —— 只在 x86 模拟器上量过（698 ms），真机未测。
4. **上面"记录但没改"的 10 项** —— 见各自的理由。
