/**
 * SQL 执行接口（纯接口，零平台依赖）。
 *
 * ## 为什么要有这一层
 *
 * `data/ScheduleStore.ts` 里装的是**业务语义**：启动打开哪张表、导入是覆盖还是合并、
 * 删课表要不要连带清日程、课时段整体替换还是增量更新…… 这些判断错了，用户就会丢数据。
 *
 * 而它们的正确性**不应该只能在模拟器上验证**。所以 store 只依赖这个接口：
 *
 * ```
 *            ┌──────────────────────────────┐
 *            │  data/ScheduleStore.ts       │  业务语义（Node 上真 SQLite 断言）
 *            └──────────────┬───────────────┘
 *                           │ 依赖
 *            ┌──────────────▼───────────────┐
 *            │  data/SqlRunner.ts（接口）   │  只有 5 个方法
 *            └──────┬────────────────┬──────┘
 *                   │                │
 *      平台实现 ────▼───┐      测试实现 ▼──────────────┐
 *      platform/Rdb.ts │      tests/helpers/…        │
 *      （relationalStore）    （node:sqlite）          │
 * ```
 *
 * 于是同一份 store 代码，设备上跑真库、CI 上跑内存库，**不接受"只在设备上验过"**。
 */

/**
 * 绑定参数。
 * 有意只放开这四种：课表数据没有二进制、没有大整数（周次掩码见 `models.maskToDb` 的安全位检查）。
 */
export type SqlArg = string | number | boolean | null;

/** 一行结果。实现方负责把 ResultSet 转成这个形状并关句柄 */
export interface SqlRow {
  columnNames(): string[];
  has(column: string): boolean;
  isNull(column: string): boolean;
  /** 文本列，NULL → '' */
  text(column: string): string;
  textOrNull(column: string): string | null;
  /** 整数列，NULL → 0 */
  int(column: string): number;
  intOrNull(column: string): number | null;
}

/** 一条待执行语句（与 data/migrations.ts 的 MigrationStep 同形，可直接复用） */
export interface SqlStatement {
  readonly sql: string;
  readonly params?: SqlArg[];
}

/**
 * store 需要的全部数据库能力。
 *
 * 刻意只有 5 个方法 —— 能力越小，两个实现（真库/内存库）越不容易行为不一致；
 * 一旦某个操作在两边语义不同，测试就失去意义。
 */
export interface SqlRunner {
  /** 查询并转成对象数组 */
  query(sql: string, args?: SqlArg[]): Promise<SqlRow[]>;

  /** 单条写语句（不带事务） */
  exec(sql: string, args?: SqlArg[]): Promise<void>;

  /** 一批语句在**同一个事务**里依次执行，任一步失败整批回滚 */
  runSteps(steps: SqlStatement[]): Promise<void>;

  /** 取一行一列（COUNT 之类），无结果返回 0 */
  scalarInt(sql: string, args?: SqlArg[]): Promise<number>;

  /**
   * 插入一行并返回自增主键。
   *
   * 为什么不写成"INSERT 之后再 SELECT last_insert_rowid()"：
   * 那两条语句必须落在**同一条连接**上才成立，而 RDB 内部有连接池。
   * 这里的实现约定是"插入 + 取 id 在同一个事务里完成"，两边都成立。
   */
  insertAndGetId(sql: string, args?: SqlArg[]): Promise<number>;
}
