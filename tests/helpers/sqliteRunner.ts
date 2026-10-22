/**
 * `SqlRunner` 的**测试实现**（`node:sqlite`，内存库）。
 *
 * 它只在 CI/本机测试里用，不进 HAP。存在的意义：让 `data/ScheduleStore.ts` 的
 * 业务语义在 Node 上被真 SQL 验证一遍，而不是"上模拟器点两下看着对"。
 *
 * 与 `platform/Rdb.ts` 的约定必须一致：
 * - `runSteps` 在**一个事务**里执行，失败整批回滚；
 * - `insertAndGetId` 在同一个事务里取 id（不依赖连接池行为）。
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  SqlArg,
  SqlRow,
  SqlRunner,
  SqlStatement,
} from '../../entry/src/main/ets/data/SqlRunner.ts';

/** node:sqlite 只接受 null / number / bigint / string / Uint8Array，boolean 要先转 */
function bind(args: SqlArg[]): Array<string | number | bigint | null> {
  const out: Array<string | number | bigint | null> = [];
  for (const a of args) {
    if (typeof a === 'boolean') {
      out.push(a ? 1 : 0);
    } else {
      out.push(a);
    }
  }
  return out;
}

class Row implements SqlRow {
  private readonly data: Record<string, unknown>;
  private readonly names: string[];

  constructor(data: Record<string, unknown>) {
    this.data = data;
    this.names = Object.keys(data);
  }

  columnNames(): string[] {
    return this.names.slice(0);
  }

  has(column: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data, column);
  }

  isNull(column: string): boolean {
    const v = this.data[column];
    return v === null || v === undefined;
  }

  text(column: string): string {
    const v = this.data[column];
    if (v === null || v === undefined) {
      return '';
    }
    return String(v);
  }

  textOrNull(column: string): string | null {
    return this.isNull(column) ? null : this.text(column);
  }

  int(column: string): number {
    const v = this.data[column];
    if (v === null || v === undefined) {
      return 0;
    }
    return Number(v);
  }

  intOrNull(column: string): number | null {
    return this.isNull(column) ? null : this.int(column);
  }
}

export interface SqliteRunnerOptions {
  /**
   * 是否打开 `PRAGMA foreign_keys`。
   * 默认 **false** —— 模拟 relationalStore 的默认状态（SQLite 本身默认就是 OFF）。
   * 想验证"外键级联确实会替我们兜底"的用例才显式打开。
   */
  readonly foreignKeys?: boolean;
}

export class SqliteRunner implements SqlRunner {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(options: SqliteRunnerOptions = {}): SqliteRunner {
    const db = new DatabaseSync(':memory:');
    if (options.foreignKeys === true) {
      db.exec('PRAGMA foreign_keys = ON');
    }
    return new SqliteRunner(db);
  }

  async query(sql: string, args: SqlArg[] = []): Promise<SqlRow[]> {
    const stmt = this.db.prepare(sql);
    const raw = (args.length === 0 ? stmt.all() : stmt.all(...bind(args))) as Array<Record<string, unknown>>;
    const out: SqlRow[] = [];
    for (const r of raw) {
      out.push(new Row(r));
    }
    return out;
  }

  async exec(sql: string, args: SqlArg[] = []): Promise<void> {
    if (args.length === 0) {
      this.db.exec(sql);
      return;
    }
    this.db.prepare(sql).run(...bind(args));
  }

  async runSteps(steps: SqlStatement[]): Promise<void> {
    if (steps.length === 0) {
      return;
    }
    this.db.exec('BEGIN');
    try {
      for (const step of steps) {
        const params = step.params === undefined ? [] : step.params;
        if (params.length === 0) {
          this.db.exec(step.sql);
        } else {
          this.db.prepare(step.sql).run(...bind(params));
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async scalarInt(sql: string, args: SqlArg[] = []): Promise<number> {
    const stmt = this.db.prepare(sql);
    const raw = (args.length === 0 ? stmt.get() : stmt.get(...bind(args))) as
      | Record<string, unknown>
      | undefined;
    if (raw === undefined) {
      return 0;
    }
    const keys = Object.keys(raw);
    if (keys.length === 0) {
      return 0;
    }
    const v = raw[keys[0]];
    return v === null || v === undefined ? 0 : Number(v);
  }

  async insertAndGetId(sql: string, args: SqlArg[] = []): Promise<number> {
    this.db.exec('BEGIN');
    try {
      const info = this.db.prepare(sql).run(...bind(args));
      this.db.exec('COMMIT');
      return Number(info.lastInsertRowid);
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
