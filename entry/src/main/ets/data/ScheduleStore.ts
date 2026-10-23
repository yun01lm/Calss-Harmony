/**
 * 业务语义层（唯一的数据入口）—— 对应 Android `data/ScheduleRepository.kt`。
 *
 * 只依赖 `data/SqlRunner.ts` 这个接口，不 import 任何鸿蒙 API：
 * 设备上由 `platform/Rdb.ts` 实现，CI 上由 `tests/helpers/sqliteRunner.ts`（`node:sqlite`）实现。
 * 于是"启动打开哪张表 / 导入覆盖还是合并 / 删表要不要连带清日程"这些会丢数据的判断，
 * 全部能在 Node 上断言，而不是只能上模拟器点。
 *
 * ## 与 Android 对齐的几条关键语义
 *
 * 1. **所有业务查询按 `timetableId` 隔离**：切课表=换 id，各表数据天然互不干扰。
 * 2. **开学日自动对齐到当周周一**（`WeekCalculator.mondayOfEpochDay`）：否则周次边界与星期列会错位。
 * 3. **覆盖导入**清空课程但**不动自定义安排**：安排是用户自己的，导入的是课表。
 * 4. **合并导入**按「名称+教师+地点」识别同一门课，用新版**整体替换它的时段**（而不是"同名跳过"，
 *    否则改了星期/节次/周次永远不会生效），类别只在导入值非空且不同时才改。
 * 5. 删课表时**显式删**课程/日程/作息/安排 —— 不依赖 SQLite 外键级联（见下方 deleteTimetable 注释）。
 */
import { PREF_CURRENT_TIMETABLE, PREF_OPEN_PRIMARY_ON_LAUNCH, defaultSlots, type SlotSeed } from './schema.ts';
import { seedSlotRows } from './migrations.ts';
import { pickStartupTimetable, type TimetableChoice } from './startupRule.ts';
import { courseKeyOf, mergeCourseItems } from './CourseMerge.ts';
import { WeekCalculator } from '../logic/WeekCalculator.ts';
import { type SqlArg, type SqlRow, type SqlRunner, type SqlStatement } from './SqlRunner.ts';
import {
  assertSafeMask,
  clampTotalWeeks,
  type Course,
  type CourseSchedule,
  type CourseWithSchedules,
  type CustomEvent,
  type MergeResult,
  type Snapshot,
  type TimeSlot,
  type Timetable,
} from './models.ts';

/** 首次安装/兜底课表的名字（与 Android 一致） */
const DEFAULT_TIMETABLE_NAME = '我的课表';
const DEFAULT_TOTAL_WEEKS = 20;

export class ScheduleStore {
  private readonly db: SqlRunner;
  /** 当前课表 id；0 = 还没决定（启动时由 ensureCurrentTimetable 决定） */
  private current: number = 0;

  constructor(db: SqlRunner) {
    this.db = db;
  }

  get currentId(): number {
    return this.current;
  }

  // ---------------------------------------------------------------- 当前课表

  /**
   * 启动时确定当前课表（幂等，多次调用只算一次）。
   * 规则见 `data/startupRule.ts`；一张课表都没有时现场建一张（正常不会走到，纯兜底）。
   */
  async ensureCurrentTimetable(nowMillis: number): Promise<number> {
    if (this.current > 0) {
      return this.current;
    }
    let all: Timetable[] = await this.allTimetables();
    if (all.length === 0) {
      await this.createTimetableInternal(
        DEFAULT_TIMETABLE_NAME,
        todayMonday(nowMillis),
        DEFAULT_TOTAL_WEEKS,
        null,
        nowMillis
      );
      all = await this.allTimetables();
      this.current = all.length > 0 ? all[0].id : 0;
      return this.current;
    }

    const lastRaw: string | null = await this.getPref(PREF_CURRENT_TIMETABLE);
    const parsed: number = lastRaw === null ? Number.NaN : Number.parseInt(lastRaw, 10);
    const lastId: number | null = Number.isNaN(parsed) ? null : parsed;
    const openPrimary: boolean = (await this.getPref(PREF_OPEN_PRIMARY_ON_LAUNCH)) === '1';

    const choices: TimetableChoice[] = [];
    for (const t of all) {
      const choice: TimetableChoice = { id: t.id, isPrimary: t.isPrimary, createdAt: t.createdAt };
      choices.push(choice);
    }
    const picked: number | null = pickStartupTimetable(choices, lastId, openPrimary);
    this.current = picked === null ? all[0].id : picked;
    return this.current;
  }

  /** 切到某张课表，并记住它（下次启动默认打开） */
  async switchTo(id: number): Promise<void> {
    this.current = id;
    await this.setPref(PREF_CURRENT_TIMETABLE, String(id));
  }

  async setOpenPrimaryOnLaunch(enabled: boolean): Promise<void> {
    await this.setPref(PREF_OPEN_PRIMARY_ON_LAUNCH, enabled ? '1' : '0');
  }

  async allTimetables(): Promise<Timetable[]> {
    const rows: SqlRow[] = await this.db.query(
      'SELECT id, name, startDateEpochDay, totalWeeks, isPrimary, createdAt FROM timetables ' +
        'ORDER BY isPrimary DESC, createdAt ASC, id ASC'
    );
    const out: Timetable[] = [];
    for (const row of rows) {
      out.push(toTimetable(row));
    }
    return out;
  }

  async timetableById(id: number): Promise<Timetable | null> {
    const rows: SqlRow[] = await this.db.query(
      'SELECT id, name, startDateEpochDay, totalWeeks, isPrimary, createdAt FROM timetables WHERE id = ?',
      [id]
    );
    return rows.length === 0 ? null : toTimetable(rows[0]);
  }

  // ---------------------------------------------------------------- 快照

  /** 一次读齐当前课表（切表时整体换掉，UI 只订阅这一个结果） */
  async snapshot(): Promise<Snapshot> {
    const id: number = await this.requireCurrent();
    const timetable: Timetable | null = await this.timetableById(id);
    const slots: TimeSlot[] = await this.readSlotsOf(id);
    const courses: Course[] = await this.readCoursesOf(id);
    const schedules: CourseSchedule[] = await this.readSchedulesOf(id);
    const events: CustomEvent[] = await this.readEventsOf(id);
    const snap: Snapshot = {
      timetable: timetable,
      slots: slots,
      courses: courses,
      schedules: schedules,
      events: events,
    };
    return snap;
  }

  async readSlotsOf(timetableId: number): Promise<TimeSlot[]> {
    const rows: SqlRow[] = await this.db.query(
      'SELECT id, timetableId, periodIndex, label, startMinute, endMinute FROM time_slots ' +
        'WHERE timetableId = ? ORDER BY periodIndex',
      [timetableId]
    );
    const out: TimeSlot[] = [];
    for (const row of rows) {
      out.push(toSlot(row));
    }
    return out;
  }

  async readCoursesOf(timetableId: number): Promise<Course[]> {
    const rows: SqlRow[] = await this.db.query(
      'SELECT id, timetableId, name, teacher, location, color, category, note FROM courses ' +
        'WHERE timetableId = ? ORDER BY id',
      [timetableId]
    );
    const out: Course[] = [];
    for (const row of rows) {
      out.push(toCourse(row));
    }
    return out;
  }

  async readSchedulesOf(timetableId: number): Promise<CourseSchedule[]> {
    const rows: SqlRow[] = await this.db.query(
      'SELECT id, courseId, dayOfWeek, startPeriod, endPeriod, weekMask FROM course_schedules ' +
        'WHERE courseId IN (SELECT id FROM courses WHERE timetableId = ?) ORDER BY courseId, dayOfWeek, startPeriod',
      [timetableId]
    );
    const out: CourseSchedule[] = [];
    for (const row of rows) {
      out.push(toSchedule(row));
    }
    return out;
  }

  async readEventsOf(timetableId: number): Promise<CustomEvent[]> {
    const rows: SqlRow[] = await this.db.query(
      'SELECT id, timetableId, title, dayOfWeek, startPeriod, endPeriod, startMinute, endMinute, ' +
        'weekMask, color, note FROM custom_events WHERE timetableId = ? ORDER BY id, dayOfWeek',
      [timetableId]
    );
    const out: CustomEvent[] = [];
    for (const row of rows) {
      out.push(toEvent(row));
    }
    return out;
  }

  /** 当前课表的课程（PDF 导入去重用） */
  async currentCourses(): Promise<Course[]> {
    return this.readCoursesOf(await this.requireCurrent());
  }

  async slotCount(): Promise<number> {
    return this.db.scalarInt('SELECT COUNT(*) FROM time_slots WHERE timetableId = ?', [
      await this.requireCurrent(),
    ]);
  }

  async courseCount(): Promise<number> {
    return this.db.scalarInt('SELECT COUNT(*) FROM courses WHERE timetableId = ?', [
      await this.requireCurrent(),
    ]);
  }

  // ---------------------------------------------------------------- 课表增删改

  /** 新建课表并切过去（"刚建完当然要看它"）；copySlotsFrom 为 null 时套用内置默认作息 */
  async createTimetable(
    name: string,
    startEpochDay: number,
    totalWeeks: number,
    copySlotsFrom: number | null,
    nowMillis: number
  ): Promise<number> {
    const id: number = await this.createTimetableInternal(
      name,
      WeekCalculator.mondayOfEpochDay(startEpochDay),
      clampTotalWeeks(totalWeeks),
      copySlotsFrom,
      nowMillis
    );
    await this.switchTo(id);
    return id;
  }

  async renameTimetable(id: number, name: string): Promise<void> {
    const t: Timetable | null = await this.timetableById(id);
    if (t === null) {
      return;
    }
    const finalName: string = name.trim().length === 0 ? t.name : name;
    await this.db.exec('UPDATE timetables SET name = ? WHERE id = ?', [finalName, id]);
  }

  /** 改某张课表的开学日与总周数（开学日仍自动对齐到当周周一） */
  async updateTimetableSemester(id: number, startEpochDay: number, totalWeeks: number): Promise<void> {
    const t: Timetable | null = await this.timetableById(id);
    if (t === null) {
      return;
    }
    await this.db.exec('UPDATE timetables SET startDateEpochDay = ?, totalWeeks = ? WHERE id = ?', [
      WeekCalculator.mondayOfEpochDay(startEpochDay),
      clampTotalWeeks(totalWeeks),
      id,
    ]);
  }

  /** 主课表同时只能有一张：先全清再标记（同一事务） */
  async setPrimary(id: number): Promise<void> {
    await this.db.runSteps([
      { sql: 'UPDATE timetables SET isPrimary = 0' },
      { sql: 'UPDATE timetables SET isPrimary = 1 WHERE id = ?', params: [id] },
    ]);
  }

  /**
   * 删除课表：连同它的课程/时段/安排/作息一起删。
   *
   * **不依赖外键级联**：SQLite 的 `PRAGMA foreign_keys` 默认是 OFF，Room 会替我们打开，
   * 但 `relationalStore` 没有这个保证 —— 靠级联的话，万一 pragma 没开，`course_schedules`
   * 就会留下一堆孤儿行（下次新建课程可能撞上同一个 id 借尸还魂）。显式删干净，两边都对。
   *
   * 删的是当前课表就自动切到主课表（或第一张）；全删光了补一张默认的。
   */
  async deleteTimetable(id: number, nowMillis: number): Promise<void> {
    const wasCurrent: boolean = this.current === id;
    await this.db.runSteps([
      { sql: 'DELETE FROM course_schedules WHERE courseId IN (SELECT id FROM courses WHERE timetableId = ?)', params: [id] },
      { sql: 'DELETE FROM courses WHERE timetableId = ?', params: [id] },
      { sql: 'DELETE FROM custom_events WHERE timetableId = ?', params: [id] },
      { sql: 'DELETE FROM time_slots WHERE timetableId = ?', params: [id] },
      { sql: 'DELETE FROM timetables WHERE id = ?', params: [id] },
    ]);

    let remaining: Timetable[] = await this.allTimetables();
    if (remaining.length === 0) {
      await this.createTimetableInternal(
        DEFAULT_TIMETABLE_NAME,
        todayMonday(nowMillis),
        DEFAULT_TOTAL_WEEKS,
        null,
        nowMillis
      );
      remaining = await this.allTimetables();
    } else if (!hasPrimary(remaining)) {
      // 删掉的正好是主课表 → 顺位顶上，别让"主课表"悬空
      await this.setPrimary(remaining[0].id);
      remaining = await this.allTimetables();
    }

    if (wasCurrent) {
      const next: Timetable = primaryOrFirst(remaining);
      await this.switchTo(next.id);
    }
  }

  /** 把 from 课表的作息整表复制到 to 课表 */
  async copySlots(from: number, to: number): Promise<void> {
    const source: TimeSlot[] = await this.readSlotsOf(from);
    if (source.length === 0) {
      return;
    }
    await this.replaceSlotsOf(to, source);
  }

  // ---------------------------------------------------------------- 课程

  /**
   * 保存课程及其全部上课时段（**整体替换**时段，简单可靠）；自动挂到当前课表。
   *
   * 三条顺序上的硬要求（都是"数据会丢"或"存进去看不见"级别的）：
   *
   * 1. **先把所有掩码校验完，再动库**。第一版是先 `DELETE` 旧时段、再循环 `assertSafeMask`：
   *    周次一不合法就抛错，而旧时段已经被删掉了 —— 一门课凭空变成"没有时间"，界面上直接消失。
   * 2. **更新路径的 UPDATE / DELETE / INSERT 放进同一个 `runSteps` 事务**：分成两次提交，
   *    中间任何失败（锁、IO、约束）都会留下"没有时段的课"。
   * 3. 新建路径的事务里拿不到自增 id，所以失败时用**补偿删除**把课程行撤掉，
   *    否则会留一门画不出来的孤儿课，下次再点保存又插一条。
   *
   * @returns 课程 id（新建时是自增 id）
   */
  async saveCourse(course: Course, schedules: CourseSchedule[]): Promise<number> {
    const timetableId: number = await this.requireCurrent();

    // 1. 校验（不碰库）
    for (const s of schedules) {
      assertSafeMask(s.weekMask);
    }

    if (course.id === 0) {
      const newId: number = await this.db.insertAndGetId(
        'INSERT INTO courses (timetableId, name, teacher, location, color, category, note) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          timetableId,
          course.name,
          course.teacher,
          course.location,
          course.color,
          course.category,
          course.note,
        ]
      );
      const insertSteps: SqlStatement[] = [];
      appendScheduleInserts(insertSteps, newId, schedules);
      try {
        await this.db.runSteps(insertSteps);
      } catch (e) {
        // 补偿：课程行已提交、时段没写进去 → 撤掉课程行，别留孤儿
        try {
          await this.db.exec('DELETE FROM courses WHERE id = ?', [newId]);
        } catch (e2) {
          // 补偿也失败：至少把原始错误抛出去，用户看到的是"保存失败"而不是"保存成功"
        }
        throw e;
      }
      return newId;
    }

    const courseId: number = course.id;
    // 目标行必须存在：外键在设备上是关着的，UPDATE 0 行不会报错，
    // 接下来插的时段就成了永久孤儿（还占着 id）
    const exists: SqlRow[] = await this.db.query('SELECT id FROM courses WHERE id = ?', [courseId]);
    if (exists.length === 0) {
      throw new Error('要保存的课程已经不存在了（可能刚被删除），请重新打开课表');
    }

    const steps: SqlStatement[] = [
      {
        sql:
          'UPDATE courses SET timetableId = ?, name = ?, teacher = ?, location = ?, color = ?, ' +
          'category = ?, note = ? WHERE id = ?',
        params: [
          timetableId,
          course.name,
          course.teacher,
          course.location,
          course.color,
          course.category,
          course.note,
          courseId,
        ],
      },
      { sql: 'DELETE FROM course_schedules WHERE courseId = ?', params: [courseId] },
    ];
    appendScheduleInserts(steps, courseId, schedules);
    await this.db.runSteps(steps);
    return courseId;
  }

  /** 删课（时段由外键级联 + 显式删除双保险） */
  async deleteCourse(id: number): Promise<void> {
    await this.db.runSteps([
      { sql: 'DELETE FROM course_schedules WHERE courseId = ?', params: [id] },
      { sql: 'DELETE FROM courses WHERE id = ?', params: [id] },
    ]);
  }

  /**
   * **覆盖导入**：清空当前课表的课程后整体写入（自定义安排不动）。
   *
   * 用在"重新导入一份新课表"：否则旧课程的时段还挂在原来的格子上，
   * 新旧两份会重叠显示在同一格（Android 用户实测报过的问题）。
   */
  async replaceCourses(items: CourseWithSchedules[]): Promise<void> {
    const timetableId: number = await this.requireCurrent();
    // 同 mergeCourses：解析器"一格一条"，这里不归并就会把一门课上两次的课插成两条课程行
    const coalesced: CourseWithSchedules[] = mergeCourseItems(items).items;
    const steps: SqlStatement[] = [
      {
        sql: 'DELETE FROM course_schedules WHERE courseId IN (SELECT id FROM courses WHERE timetableId = ?)',
        params: [timetableId],
      },
      { sql: 'DELETE FROM courses WHERE timetableId = ?', params: [timetableId] },
    ];
    for (const item of coalesced) {
      appendInsertCourse(steps, timetableId, item);
    }
    await this.db.runSteps(steps);
  }

  /**
   * **合并导入**：同名课程（名称+教师+地点）用新版**更新**其上课时段，其余新增。
   *
   * 比"同名直接跳过"正确：那样子课程换了星期/节次/周次也不会被更新，
   * 相当于永远留着第一次导入的旧信息。
   */
  async mergeCourses(items: CourseWithSchedules[]): Promise<MergeResult> {
    const timetableId: number = await this.requireCurrent();
    // 先按「名称+教师+地点」归并：解析器是"一格一条"输出，一门课上两次就是两条，
    // 不归并的话本次批次自己就会插出两条同名课（键索引只在开头建一次，第二条查不到）
    const coalesced: CourseWithSchedules[] = mergeCourseItems(items).items;
    const existing: Course[] = await this.readCoursesOf(timetableId);
    const byKey: Map<string, Course> = new Map<string, Course>();
    for (const c of existing) {
      byKey.set(courseKeyOf(c), c);
    }

    let added = 0;
    let updated = 0;
    const steps: SqlStatement[] = [];
    for (const item of coalesced) {
      const key: string = courseKeyOf(item.course);
      const old: Course | undefined = byKey.get(key);
      if (old === undefined) {
        appendInsertCourse(steps, timetableId, item);
        added++;
      } else {
        // 换掉它的全部上课时段（星期/节次/周次都可能变），保留颜色与备注
        steps.push({ sql: 'DELETE FROM course_schedules WHERE courseId = ?', params: [old.id] });
        for (const s of item.schedules) {
          assertSafeMask(s.weekMask);
          steps.push({
            sql:
              'INSERT INTO course_schedules (courseId, dayOfWeek, startPeriod, endPeriod, weekMask) ' +
              'VALUES (?, ?, ?, ?, ?)',
            params: [old.id, s.dayOfWeek, s.startPeriod, s.endPeriod, s.weekMask],
          });
        }
        if (item.course.category.length > 0 && item.course.category !== old.category) {
          steps.push({
            sql: 'UPDATE courses SET category = ? WHERE id = ?',
            params: [item.course.category, old.id],
          });
        }
        updated++;
      }
    }
    await this.db.runSteps(steps);
    const result: MergeResult = { added: added, updated: updated };
    return result;
  }

  // ---------------------------------------------------------------- 自定义安排

  async saveEvent(event: CustomEvent): Promise<number> {
    const timetableId: number = await this.requireCurrent();
    if (event.id === 0) {
      const newId: number = await this.db.insertAndGetId(
        'INSERT INTO custom_events (timetableId, title, dayOfWeek, startPeriod, endPeriod, ' +
          'startMinute, endMinute, weekMask, color, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          timetableId,
          event.title,
          event.dayOfWeek,
          event.startPeriod,
          event.endPeriod,
          event.startMinute,
          event.endMinute,
          assertSafeMask(event.weekMask),
          event.color,
          event.note,
        ]
      );
      return newId;
    }
    await this.db.exec(
      'UPDATE custom_events SET timetableId = ?, title = ?, dayOfWeek = ?, startPeriod = ?, ' +
        'endPeriod = ?, startMinute = ?, endMinute = ?, weekMask = ?, color = ?, note = ? WHERE id = ?',
      [
        timetableId,
        event.title,
        event.dayOfWeek,
        event.startPeriod,
        event.endPeriod,
        event.startMinute,
        event.endMinute,
        assertSafeMask(event.weekMask),
        event.color,
        event.note,
        event.id,
      ]
    );
    return event.id;
  }

  async deleteEvent(id: number): Promise<void> {
    await this.db.exec('DELETE FROM custom_events WHERE id = ?', [id]);
  }

  // ---------------------------------------------------------------- 作息

  /** 整表替换当前课表的作息（作息导入通道用）：先清空再写入，避免节次序号重复 */
  async replaceSlots(slots: TimeSlot[]): Promise<void> {
    await this.replaceSlotsOf(await this.requireCurrent(), slots);
  }

  /** 当前课表恢复内置 12 节作息 */
  async resetSlots(): Promise<void> {
    const seeds: SlotSeed[] = defaultSlots();
    const slots: TimeSlot[] = [];
    for (const s of seeds) {
      const slot: TimeSlot = {
        id: 0,
        timetableId: 0,
        periodIndex: s.periodIndex,
        label: s.label,
        startMinute: s.startMinute,
        endMinute: s.endMinute,
      };
      slots.push(slot);
    }
    await this.replaceSlots(slots);
  }

  async saveSlot(slot: TimeSlot): Promise<number> {
    const timetableId: number = await this.requireCurrent();
    if (slot.id === 0) {
      return this.db.insertAndGetId(
        'INSERT INTO time_slots (timetableId, periodIndex, label, startMinute, endMinute) ' +
          'VALUES (?, ?, ?, ?, ?)',
        [timetableId, slot.periodIndex, slot.label, slot.startMinute, slot.endMinute]
      );
    }
    await this.db.exec(
      'UPDATE time_slots SET timetableId = ?, periodIndex = ?, label = ?, startMinute = ?, ' +
        'endMinute = ? WHERE id = ?',
      [timetableId, slot.periodIndex, slot.label, slot.startMinute, slot.endMinute, slot.id]
    );
    return slot.id;
  }

  async deleteSlot(id: number): Promise<void> {
    await this.db.exec('DELETE FROM time_slots WHERE id = ?', [id]);
  }

  // ---------------------------------------------------------------- 内部

  private async replaceSlotsOf(timetableId: number, slots: TimeSlot[]): Promise<void> {
    const steps: SqlStatement[] = [
      { sql: 'DELETE FROM time_slots WHERE timetableId = ?', params: [timetableId] },
    ];
    for (const s of slots) {
      steps.push({
        sql:
          'INSERT INTO time_slots (timetableId, periodIndex, label, startMinute, endMinute) ' +
          'VALUES (?, ?, ?, ?, ?)',
        params: [timetableId, s.periodIndex, s.label, s.startMinute, s.endMinute],
      });
    }
    await this.db.runSteps(steps);
  }

  private async createTimetableInternal(
    name: string,
    startEpochDay: number,
    totalWeeks: number,
    copySlotsFrom: number | null,
    nowMillis: number
  ): Promise<number> {
    // 第一张课表自动成为主课表，避免"主课表"悬空
    const count: number = await this.db.scalarInt('SELECT COUNT(*) FROM timetables');
    const id: number = await this.db.insertAndGetId(
      'INSERT INTO timetables (name, startDateEpochDay, totalWeeks, isPrimary, createdAt) ' +
        'VALUES (?, ?, ?, ?, ?)',
      [name, startEpochDay, totalWeeks, count === 0 ? 1 : 0, nowMillis]
    );

    const steps: SqlStatement[] = [];
    if (copySlotsFrom !== null) {
      const source: TimeSlot[] = await this.readSlotsOf(copySlotsFrom);
      steps.push({ sql: 'DELETE FROM time_slots WHERE timetableId = ?', params: [id] });
      for (const s of source) {
        steps.push({
          sql:
            'INSERT INTO time_slots (timetableId, periodIndex, label, startMinute, endMinute) ' +
            'VALUES (?, ?, ?, ?, ?)',
          params: [id, s.periodIndex, s.label, s.startMinute, s.endMinute],
        });
      }
    } else {
      for (const step of seedSlotRows(id)) {
        const params: SqlArg[] = [];
        if (step.params !== undefined) {
          for (const p of step.params) {
            params.push(p);
          }
        }
        steps.push({ sql: step.sql, params: params });
      }
    }
    await this.db.runSteps(steps);
    return id;
  }

  private async requireCurrent(): Promise<number> {
    if (this.current <= 0) {
      await this.ensureCurrentTimetable(Date.now());
    }
    if (this.current <= 0) {
      throw new Error('课表尚未就绪');
    }
    return this.current;
  }

  private async getPref(key: string): Promise<string | null> {
    const rows: SqlRow[] = await this.db.query('SELECT value FROM preferences WHERE key = ?', [key]);
    return rows.length === 0 ? null : rows[0].text('value');
  }

  private async setPref(key: string, value: string): Promise<void> {
    await this.db.exec('INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)', [key, value]);
  }
}

// ---------------------------------------------------------------- 行 → 模型

function toTimetable(row: SqlRow): Timetable {
  const t: Timetable = {
    id: row.int('id'),
    name: row.text('name'),
    startDateEpochDay: row.int('startDateEpochDay'),
    totalWeeks: row.int('totalWeeks'),
    isPrimary: row.int('isPrimary') === 1,
    createdAt: row.int('createdAt'),
  };
  return t;
}

function toSlot(row: SqlRow): TimeSlot {
  const s: TimeSlot = {
    id: row.int('id'),
    timetableId: row.int('timetableId'),
    periodIndex: row.int('periodIndex'),
    label: row.text('label'),
    startMinute: row.int('startMinute'),
    endMinute: row.int('endMinute'),
  };
  return s;
}

function toCourse(row: SqlRow): Course {
  const c: Course = {
    id: row.int('id'),
    timetableId: row.int('timetableId'),
    name: row.text('name'),
    teacher: row.text('teacher'),
    location: row.text('location'),
    color: row.int('color'),
    category: row.text('category'),
    note: row.text('note'),
  };
  return c;
}

function toSchedule(row: SqlRow): CourseSchedule {
  const s: CourseSchedule = {
    id: row.int('id'),
    courseId: row.int('courseId'),
    dayOfWeek: row.int('dayOfWeek'),
    startPeriod: row.int('startPeriod'),
    endPeriod: row.int('endPeriod'),
    weekMask: row.int('weekMask'),
  };
  return s;
}

function toEvent(row: SqlRow): CustomEvent {
  const e: CustomEvent = {
    id: row.int('id'),
    timetableId: row.int('timetableId'),
    title: row.text('title'),
    dayOfWeek: row.int('dayOfWeek'),
    startPeriod: row.intOrNull('startPeriod'),
    endPeriod: row.intOrNull('endPeriod'),
    startMinute: row.intOrNull('startMinute'),
    endMinute: row.intOrNull('endMinute'),
    weekMask: row.int('weekMask'),
    color: row.int('color'),
    note: row.text('note'),
  };
  return e;
}

// ---------------------------------------------------------------- 小工具

/** 合并导入识别"同一门课"的键在 `CourseMerge.courseKeyOf`（唯一实现，别在这里再写一份） */

/**
 * 追加"插入一门课 + 它的全部时段"。
 *
 * 时段的 courseId 用 `(SELECT MAX(id) FROM courses WHERE timetableId = ?)` 取，
 * 而不是先插入再查 id：这些语句在**同一个事务**里按顺序执行，紧接着刚插入的课就是 MAX(id)，
 * 既不用 `last_insert_rowid()`（连接池下不可靠），也不用给自增主键硬塞值（会踩 AUTOINCREMENT 序列）。
 */
function appendInsertCourse(steps: SqlStatement[], timetableId: number, item: CourseWithSchedules): void {
  steps.push({
    sql:
      'INSERT INTO courses (timetableId, name, teacher, location, color, category, note) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
    params: [
      timetableId,
      item.course.name,
      item.course.teacher,
      item.course.location,
      item.course.color,
      item.course.category,
      item.course.note,
    ],
  });
  for (const s of item.schedules) {
    assertSafeMask(s.weekMask);
    steps.push({
      sql:
        'INSERT INTO course_schedules (courseId, dayOfWeek, startPeriod, endPeriod, weekMask) ' +
        'SELECT (SELECT MAX(id) FROM courses WHERE timetableId = ?), ?, ?, ?, ?',
      params: [timetableId, s.dayOfWeek, s.startPeriod, s.endPeriod, s.weekMask],
    });
  }
}

/** 一批"把时段挂到已知课程 id 上"的 INSERT（与 UPDATE/DELETE 同处一个事务时用） */
function appendScheduleInserts(
  steps: SqlStatement[],
  courseId: number,
  schedules: CourseSchedule[]
): void {
  for (const s of schedules) {
    steps.push({
      sql:
        'INSERT INTO course_schedules (courseId, dayOfWeek, startPeriod, endPeriod, weekMask) ' +
        'VALUES (?, ?, ?, ?, ?)',
      params: [courseId, s.dayOfWeek, s.startPeriod, s.endPeriod, s.weekMask],
    });
  }
}

/** 当周周一（epochDay）：新建课表的默认开学日 */
function todayMonday(nowMillis: number): number {
  return WeekCalculator.mondayOfEpochDay(WeekCalculator.todayEpochDay(new Date(nowMillis)));
}

function hasPrimary(list: Timetable[]): boolean {
  for (const t of list) {
    if (t.isPrimary) {
      return true;
    }
  }
  return false;
}

/** 主课表优先，其次第一张（列表已按「主课表优先、创建时间」排序） */
function primaryOrFirst(list: Timetable[]): Timetable {
  for (const t of list) {
    if (t.isPrimary) {
      return t;
    }
  }
  return list[0];
}
