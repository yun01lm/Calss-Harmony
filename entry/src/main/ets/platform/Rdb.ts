/**
 * relationalStore 适配层 —— 全应用**唯一**直接碰数据库 API 的地方。
 *
 * 分工（沿用 docs/ARCHITECTURE.md 的硬边界）：
 * - `data/schema.ts` / `data/migrations.ts` / `data/bootstrap.ts`：纯 SQL 与"该做什么"的判断，Node 上可测；
 * - 本文件：把 SQL 交给鸿蒙 RDB 执行，把 `ResultSet` 转成纯对象数组。
 *
 * ## 三个刻意的设计
 *
 * 1. **不用 `getRdbStoreSync`**：同步建库会阻塞首帧。这里全 async，且第一次访问才建
 *    （`EntryAbility.onCreate` 里什么都不做，见启动策略）。
 * 2. **同名库只开一次**：RDB 明确禁止同一进程内重复打开同名库（会影响同步/静默访问等能力），
 *    所以按库名缓存实例，`close()` 时从缓存里摘掉。
 * 3. **版本号写入后**立刻回读校验。`store.version = N` 失败时它是"悄悄没写"的，
 *    不回读的话下次启动会重复建库 —— 宁可当场抛错，也不要留一个只在重装后才暴露的坑。
 */
import { relationalStore } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { DB_NAME } from '../data/schema.ts';
import {
  bootstrapPlan,
  knownTablesOnly,
  type BootstrapPlan,
  type BootstrapInput,
} from '../data/bootstrap.ts';
import { type LegacySemester, type MigrationStep } from '../data/migrations.ts';
import {
  type SqlArg,
  type SqlRow,
  type SqlRunner,
  type SqlStatement,
} from '../data/SqlRunner.ts';

/** 一次打开库得到的结果摘要（页面/日志直接展示，便于截图取证） */
export interface RdbBootstrapOutcome {
  /** fresh / upgrade / repair / noop，见 data/bootstrap.ts */
  readonly kind: string;
  readonly fromVersion: number;
  readonly version: number;
  readonly stepCount: number;
}

/**
 * 一行查询结果。
 *
 * 为什么不直接把 `ResultSet` 传出去：`ResultSet` 必须 `close()`，一旦漏关就是内存/句柄泄漏；
 * 而页面与 store 层只需要"按列名取值"的对象。这里在 `query()` 内部转完就关，调用方看不到句柄。
 */
export class RdbRow implements SqlRow {
  private readonly names: string[];
  private readonly cells: Map<string, relationalStore.ValueType>;

  constructor(names: string[], cells: Map<string, relationalStore.ValueType>) {
    this.names = names;
    this.cells = cells;
  }

  columnNames(): string[] {
    return this.names.slice(0);
  }

  has(column: string): boolean {
    return this.cells.has(column);
  }

  isNull(column: string): boolean {
    const v = this.cells.get(column);
    return v === undefined || v === null;
  }

  value(column: string): relationalStore.ValueType {
    const v = this.cells.get(column);
    return v === undefined ? null : v;
  }

  /** 文本列；NULL 视为空串（业务上"没填"和"空字符串"在这里等价） */
  text(column: string): string {
    const v = this.cells.get(column);
    if (v === undefined || v === null) {
      return '';
    }
    if (typeof v === 'string') {
      return v;
    }
    if (typeof v === 'number') {
      return String(v);
    }
    if (typeof v === 'bigint') {
      return v.toString();
    }
    if (typeof v === 'boolean') {
      return v ? '1' : '0';
    }
    return '';
  }

  textOrNull(column: string): string | null {
    return this.isNull(column) ? null : this.text(column);
  }

  /** 整数列；NULL 视为 0 */
  int(column: string): number {
    const v = this.cells.get(column);
    if (v === undefined || v === null) {
      return 0;
    }
    if (typeof v === 'number') {
      return Math.trunc(v);
    }
    if (typeof v === 'bigint') {
      return Number(v);
    }
    if (typeof v === 'string') {
      const n = Number.parseInt(v, 10);
      return Number.isNaN(n) ? 0 : n;
    }
    if (typeof v === 'boolean') {
      return v ? 1 : 0;
    }
    return 0;
  }

  intOrNull(column: string): number | null {
    return this.isNull(column) ? null : this.int(column);
  }
}

export class Rdb implements SqlRunner {
  /** 库名 → 实例。RDB 不允许同进程重复打开同名库，这里保证只开一次 */
  private static readonly opened: Map<string, Rdb> = new Map<string, Rdb>();
  /**
   * 库名 → "正在打开"的 promise。
   *
   * 只缓存**已打开**的实例是不够的：`getRdbStore` 是 await，返回之前缓存还是空的。
   * 冷启动时页面已经画出来了（首帧不等数据），此时点「课表」「作息」会各调一次 `open()`，
   * 两个都 miss、两个都去开同名库 —— 一个句柄被丢掉，第二次打开还可能直接失败。
   */
  private static readonly opening: Map<string, Promise<Rdb>> = new Map<string, Promise<Rdb>>();

  private readonly store: relationalStore.RdbStore;
  private readonly dbName: string;

  private constructor(store: relationalStore.RdbStore, dbName: string) {
    this.store = store;
    this.dbName = dbName;
  }

  /** 懒打开（缓存）；同一个库名多次调用返回同一个实例，并发调用共享同一次打开 */
  static open(context: common.Context, dbName: string = DB_NAME): Promise<Rdb> {
    const cached: Rdb | undefined = Rdb.opened.get(dbName);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    const pending: Promise<Rdb> | undefined = Rdb.opening.get(dbName);
    if (pending !== undefined) {
      return pending;
    }
    const task: Promise<Rdb> = Rdb.openShared(context, dbName);
    Rdb.opening.set(dbName, task);
    return task;
  }

  private static async openShared(context: common.Context, dbName: string): Promise<Rdb> {
    try {
      const config: relationalStore.StoreConfig = {
        name: dbName,
        // S1：只有本机、不含敏感信息（课表就是这类）。与 Android 版"无加密、无权限"一致
        securityLevel: relationalStore.SecurityLevel.S1,
      };
      const store: relationalStore.RdbStore = await relationalStore.getRdbStore(context, config);
      const db = new Rdb(store, dbName);
      Rdb.opened.set(dbName, db);
      return db;
    } finally {
      // 成功/失败都要摘掉"正在打开"的标记，否则一次失败会把这个库永久钉在失败态
      Rdb.opening.delete(dbName);
    }
  }

  /** 关掉并删除整个库文件（迁移演练 / 重置用，正常路径不该出现） */
  static async destroy(context: common.Context, dbName: string): Promise<void> {
    const cached = Rdb.opened.get(dbName);
    if (cached !== undefined) {
      await cached.close();
    }
    await relationalStore.deleteRdbStore(context, dbName);
  }

  get name(): string {
    return this.dbName;
  }

  /** 库版本号（SQLite 的 user_version，Room 也是用它） */
  get version(): number {
    return this.store.version;
  }

  set version(v: number) {
    this.store.version = v;
  }

  /**
   * 保证库结构是当前版本（建库 / 迁移 / 补版本号），返回做了什么。
   * 反复调用是安全的。
   */
  async ensureUpToDate(nowMillis: number, defaultStartEpochDay: number): Promise<RdbBootstrapOutcome> {
    const current: number = this.store.version;
    const existing: string[] = await this.existingTables();
    // 只有 v1 才需要读旧学期；读的时候 semesters 还在（迁移步骤里才会 DROP）
    const legacy: LegacySemester | null = current === 1 ? await this.readLegacySemester() : null;
    // 现有列：迁移里的 ALTER 要按它决定加不加（迁移必须可以重跑，见 data/migrations.ts）
    const columns: string[] = current === 0 ? [] : await this.existingColumns();

    const input: BootstrapInput = {
      currentVersion: current,
      existingTables: existing,
      existingColumns: columns,
      legacy: legacy,
      nowMillis: nowMillis,
      defaultStartEpochDay: defaultStartEpochDay,
    };
    const plan: BootstrapPlan = bootstrapPlan(input);

    await this.runSteps(planToStatements(plan.steps));

    // 建库/迁移的事务已经提交；版本号单独写（PRAGMA），写完必须回读确认
    if (this.store.version !== plan.targetVersion) {
      this.store.version = plan.targetVersion;
    }
    const after: number = this.store.version;
    if (after !== plan.targetVersion) {
      throw new Error(
        '数据库版本号写入失败：期望 ' + plan.targetVersion + '，实际读回 ' + after
      );
    }

    const outcome: RdbBootstrapOutcome = {
      kind: plan.kind,
      fromVersion: plan.fromVersion,
      version: after,
      stepCount: plan.steps.length,
    };
    return outcome;
  }

  /**
   * 在一个事务里依次执行步骤。任一步失败整批回滚 —— 迁移不允许"做了一半"。
   */
  async runSteps(steps: SqlStatement[]): Promise<void> {
    if (steps.length === 0) {
      return;
    }
    const tx: relationalStore.Transaction = await this.store.createTransaction();
    try {
      for (const step of steps) {
        const args: Array<relationalStore.ValueType> = [];
        if (step.params !== undefined) {
          for (const p of step.params) {
            args.push(p);
          }
        }
        await tx.execute(step.sql, args);
      }
      await tx.commit();
    } catch (e) {
      const err = e as Error;
      try {
        await tx.rollback();
      } catch (e2) {
        // 回滚也失败时保留原始错误：先解决"为什么迁移失败"才有意义
        const err2 = e2 as BusinessError;
        console.error('[Rdb] 回滚同样失败：' + err2.code + ' ' + err2.message);
      }
      throw new Error('事务失败，已回滚：' + err.message);
    }
  }

  /** 单条写语句 */
  async exec(sql: string, args: SqlArg[] = []): Promise<void> {
    await this.store.executeSql(sql, toValues(args));
  }

  /**
   * 插入一行并返回自增主键。
   *
   * 必须和 `SELECT last_insert_rowid()` 落在**同一个事务**里：RDB 内部有连接池，
   * 两条独立的 executeSql/querySql 不保证同一条连接，那样取到的可能是别的插入的 id。
   */
  async insertAndGetId(sql: string, args: SqlArg[] = []): Promise<number> {
    const tx: relationalStore.Transaction = await this.store.createTransaction();
    try {
      await tx.execute(sql, toValues(args));
      const rs: relationalStore.ResultSet = await tx.querySql('SELECT last_insert_rowid() AS id');
      let id = 0;
      try {
        if (rs.goToNextRow()) {
          id = rs.getLong(0);
        }
      } finally {
        rs.close();
      }
      await tx.commit();
      return id;
    } catch (e) {
      const err = e as Error;
      try {
        await tx.rollback();
      } catch (e2) {
        const err2 = e2 as BusinessError;
        console.error('[Rdb] 回滚同样失败：' + err2.code + ' ' + err2.message);
      }
      throw new Error('插入失败，已回滚：' + err.message);
    }
  }

  /** 查询并立刻把 ResultSet 转成对象数组（句柄不外泄） */
  async query(sql: string, args: SqlArg[] = []): Promise<RdbRow[]> {
    const rs: relationalStore.ResultSet = await this.store.querySql(sql, toValues(args));
    const names: string[] = rs.getColumnNames();
    const out: RdbRow[] = [];
    try {
      while (rs.goToNextRow()) {
        const cells: Map<string, relationalStore.ValueType> =
          new Map<string, relationalStore.ValueType>();
        for (let i = 0; i < names.length; i++) {
          cells.set(names[i], rs.isColumnNull(i) ? null : rs.getValue(i));
        }
        out.push(new RdbRow(names, cells));
      }
    } finally {
      rs.close();
    }
    return out;
  }

  /** 取一行一列（COUNT(*) 这类）；没有结果时返回 0 */
  async scalarInt(sql: string, args: SqlArg[] = []): Promise<number> {
    const rows: RdbRow[] = await this.query(sql, args);
    if (rows.length === 0) {
      return 0;
    }
    const names: string[] = rows[0].columnNames();
    if (names.length === 0) {
      return 0;
    }
    return rows[0].int(names[0]);
  }

  async close(): Promise<void> {
    try {
      await this.store.close();
    } finally {
      Rdb.opened.delete(this.dbName);
    }
  }

  /**
   * 在**一个事务**里跑一组读写，回调拿到的是"绑在这个事务上的 runner"。
   *
   * 关键点：不能用 `BEGIN` / `COMMIT` 两条独立语句 —— RDB 内部有连接池，
   * 那样 begin 和 commit 可能落在不同连接上（`runSteps` 的注释里也写了同一件事）。
   * 这里用 `store.createTransaction()` 拿到一个**绑定连接**的事务对象，
   * 再把它包成 SqlRunner 交给回调，事务内所有 query/exec 都走它。
   *
   * 不支持嵌套：回调里再调 `transaction()` 会直接报错（当前没有这种调用）。
   */
  async transaction(run: (tx: SqlRunner) => Promise<void>): Promise<void> {
    const tx: relationalStore.Transaction = await this.store.createTransaction();
    const runner: RdbTxRunner = new RdbTxRunner(tx);
    try {
      await run(runner);
      await tx.commit();
    } catch (e) {
      const err = e as Error;
      try {
        await tx.rollback();
      } catch (e2) {
        const err2 = e2 as BusinessError;
        console.error('[Rdb] 回滚同样失败：' + err2.code + ' ' + err2.message);
      }
      throw new Error('事务失败，已回滚：' + err.message);
    }
  }

  /** `sqlite_master` 里属于本应用的现有表 */
  private async existingTables(): Promise<string[]> {
    const rows: RdbRow[] = await this.query("SELECT name FROM sqlite_master WHERE type = 'table'");
    const names: string[] = [];
    for (const row of rows) {
      names.push(row.text('name'));
    }
    return knownTablesOnly(names);
  }

  /**
   * 三张业务表现有的列，形如 `courses.timetableId`。
   *
   * 用途只有一个：让 v1→v2 的 `ALTER TABLE ADD COLUMN` **可以重跑**。
   * SQLite 没有 `ADD COLUMN IF NOT EXISTS`，只能先问 `pragma_table_info`；
   * 不问的话，"迁移提交了但版本号没写进去"的重跑会一直撞 `duplicate column name`。
   */
  private async existingColumns(): Promise<string[]> {
    const out: string[] = [];
    for (const table of ['courses', 'course_schedules', 'custom_events', 'time_slots']) {
      let rows: RdbRow[] = [];
      try {
        rows = await this.query("SELECT name FROM pragma_table_info('" + table + "')");
      } catch (e) {
        // 表还不存在时 pragma 可能报错：当作"没有列"，让迁移去建
        rows = [];
      }
      for (const row of rows) {
        out.push(table + '.' + row.text('name'));
      }
    }
    return out;
  }

  /**
   * 读 v1 的学期行。
   *
   * 只有"表不存在"才当没有旧学期（版本号说是 v1 但表没了，说明历史库不完整）；
   * 其它错误一律抛出 —— 读失败却当成"没有旧学期"，会拿默认值覆盖掉用户的学期设置，
   * 那种静默丢数据比打不开更糟。
   */
  private async readLegacySemester(): Promise<LegacySemester | null> {
    try {
      const rows: RdbRow[] = await this.query(
        'SELECT name, startDateEpochDay, totalWeeks FROM semesters LIMIT 1'
      );
      if (rows.length === 0) {
        return null;
      }
      const row: RdbRow = rows[0];
      const legacy: LegacySemester = {
        name: row.text('name'),
        startDateEpochDay: row.int('startDateEpochDay'),
        totalWeeks: row.int('totalWeeks'),
      };
      return legacy;
    } catch (e) {
      const err = e as BusinessError;
      if (err.message !== undefined && err.message.indexOf('no such table') >= 0) {
        return null;
      }
      throw new Error('读取旧学期失败（' + err.code + ' ' + err.message + '），已停止迁移');
    }
  }
}

/**
 * 绑定在某个事务上的 SqlRunner（`Rdb.transaction` 内部用）。
 *
 * 只实现事务内真正需要的四个方法：`query` / `exec` / `scalarInt` / `insertAndGetId`。
 * `transaction()` 自己再调会直接抛错 —— 嵌套事务在这套 API 里没有语义，
 * 与其猜"用保存点还是并入外层"，不如明确拒绝。
 */
class RdbTxRunner implements SqlRunner {
  private readonly tx: relationalStore.Transaction;

  constructor(tx: relationalStore.Transaction) {
    this.tx = tx;
  }

  async query(sql: string, args: SqlArg[] = []): Promise<SqlRow[]> {
    const rs: relationalStore.ResultSet = await this.tx.querySql(sql, toValues(args));
    const names: string[] = rs.getColumnNames();
    const out: RdbRow[] = [];
    try {
      while (rs.goToNextRow()) {
        const cells: Map<string, relationalStore.ValueType> =
          new Map<string, relationalStore.ValueType>();
        for (let i = 0; i < names.length; i++) {
          cells.set(names[i], rs.isColumnNull(i) ? null : rs.getValue(i));
        }
        out.push(new RdbRow(names, cells));
      }
    } finally {
      rs.close();
    }
    return out;
  }

  async exec(sql: string, args: SqlArg[] = []): Promise<void> {
    await this.tx.execute(sql, toValues(args));
  }

  async scalarInt(sql: string, args: SqlArg[] = []): Promise<number> {
    const rows: SqlRow[] = await this.query(sql, args);
    if (rows.length === 0) {
      return 0;
    }
    const names: string[] = rows[0].columnNames();
    if (names.length === 0) {
      return 0;
    }
    return rows[0].int(names[0]);
  }

  async insertAndGetId(sql: string, args: SqlArg[] = []): Promise<number> {
    await this.tx.execute(sql, toValues(args));
    const rows: SqlRow[] = await this.query('SELECT last_insert_rowid() AS id');
    return rows.length === 0 ? 0 : rows[0].int('id');
  }

  async runSteps(steps: SqlStatement[]): Promise<void> {
    for (const step of steps) {
      await this.exec(step.sql, step.params === undefined ? [] : step.params);
    }
  }

  async transaction(run: (tx: SqlRunner) => Promise<void>): Promise<void> {
    throw new Error('不支持嵌套事务：请在同一个 transaction() 回调里完成全部读写');
  }
}

/** SqlArg → relationalStore 的绑定参数（SqlArg 是它的子集，这里显式转一次避免类型歧义） */
function toValues(args: SqlArg[]): Array<relationalStore.ValueType> {  const out: Array<relationalStore.ValueType> = [];
  for (const a of args) {
    out.push(a);
  }
  return out;
}

/** 迁移/建库的步骤 → 通用的语句结构（两者字段相同，显式复制一遍免得依赖结构兼容） */
function planToStatements(steps: MigrationStep[]): SqlStatement[] {
  const out: SqlStatement[] = [];
  for (const step of steps) {
    const params: SqlArg[] = [];
    if (step.params !== undefined) {
      for (const p of step.params) {
        params.push(p);
      }
    }
    out.push({ sql: step.sql, params: params });
  }
  return out;
}
