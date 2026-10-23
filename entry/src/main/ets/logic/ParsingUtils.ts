/**
 * 两种 PDF 版式的公共解析工具。移植自 Android `pdf/ParsingUtils.kt`。
 *
 * 四条**用真文件回归出来**的规则：
 * 1. 课程名以类别符号 `★☆◆■〇` 结尾 —— 区分"新课程名"与"上一门课详情续行"的天然锚点；
 * 2. 详情字段个数**因学校而异**（3 段 vs 7 段）→ 取字段规则见 [parseGridDetail]；
 * 3. 列表式字段标签会被折行打断（"考核方" + "式:考试"），调用方必须**无分隔拼接**多行；
 * 4. 字段标签里长标签必须排在短标签之前，否则"教学班组成"会被"教学班"抢先匹配。
 *
 * **常量与正则都放在类里（static readonly）**：对齐 Kotlin 的 `object`。
 * 第一版写成了模块级 `export const`，结果 `ParsingUtils.LEGEND` 在运行时是 undefined
 * —— 这类"看着像对象属性、实际不是"的错只有在真跑测试时才会暴露（tests/pdf-parsers.test.ts 里有一条专门盯它）。
 */
import { WeekMasks } from './WeekMasks.ts';
import { trimChars } from './PdfModels.ts';

/** 网格式详情里"周次/地点/教师…"的字段 */
export interface GridFields {
  readonly weekMask: bigint;
  readonly location: string;
  readonly teacher: string;
  /** 教学班（详情里含「班」的那一段）；没写就是 '' */
  readonly classGroup: string;
}

/** 列表式详情里的字段 */
export interface ListFields {
  readonly weekMask: bigint;
  readonly location: string;
  readonly teacher: string;
  /** 教学班（列表式里的「教学班组成/教学班」）；没写就是 '' */
  readonly classGroup: string;
}

/** 课程类别符号：学校课表用它们标注理论/实验/上机/实践 */
const MARKERS: Map<string, string> = new Map<string, string>([
  ['★', '理论'],
  ['☆', '实验'],
  ['◆', '上机'],
  ['■', '实践'],
  ['〇', '其他'],
]);

const MARKER_CHARS = '★☆◆■〇';

/**
 * 列表式的字段标签。**顺序很重要**：长标签必须排在它的前缀之前，
 * 否则 "教学班组成" 会被 "教学班" 抢先匹配。
 */
const FIELD_LABELS: string[] = [
  '周数', '地点', '教师', '教学班组成', '教学班',
  '考核方式', '选课备注', '课程学时组成', '周学时', '总学时', '学分',
];

/** 由 FIELD_LABELS 生成的 "标签:" 正则（等价于 Kotlin 的 Regex.escape 拼接） */
const FIELD_REGEX = new RegExp('(' + FIELD_LABELS.join('|') + ')\\s*[:：]', 'g');

export class ParsingUtils {
  static readonly FORMAT_LIST = '列表式';
  static readonly FORMAT_GRID = '网格式';
  static readonly FORMAT_UNKNOWN = '未知版式';

  /** 课程名没识别出来时的占位名（保留条目而不是丢弃，避免用户漏课） */
  static readonly UNNAMED_COURSE = '未命名课程';

  /** 页脚图例行（"★: 理论 ☆: 实验 …"），必须排除，否则会被当成课程 */
  static readonly LEGEND: RegExp = /[:：]\s*(理论|实验|上机|实践|其他)/;

  /** 星期表头文字 → 星期序号（1=周一…7=周日）；不是表头返回 null */
  static dayIndexFromLabel(label: string): number | null {
    const t = label.trim();
    if (t === '星期一') return 1;
    if (t === '星期二') return 2;
    if (t === '星期三') return 3;
    if (t === '星期四') return 4;
    if (t === '星期五') return 5;
    if (t === '星期六') return 6;
    if (t === '星期日' || t === '星期天') return 7;
    return null;
  }

  /** 是否含课程类别符号 */
  static hasMarker(text: string): boolean {
    for (let i = 0; i < MARKER_CHARS.length; i++) {
      if (text.indexOf(MARKER_CHARS.charAt(i)) >= 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * 去掉类别符号 → (纯课程名, 类别)。
   * 类别取**第一个**出现的符号（一门课一般只有一个），其余符号直接剔除。
   *
   * 另外剥掉一种"串行"残留：上一格的学分字段折行后（`:1.0`、`分:4.0`、`学分:3.0`）
   * 会被当成课名首行拼到这里。只剥"可选的学分/学时字样 + 冒号 + 数字"这种明确形态，
   * 正常课名（`体育Ⅲ-网球`、`3D打印`）没有冒号，不会被误伤。
   */
  static cleanName(raw: string): [string, string] {
    let category = '';
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      const ch = raw.charAt(i);
      const mapped = MARKERS.get(ch);
      if (mapped === undefined) {
        out += ch;
      } else if (category.length === 0) {
        category = mapped;
      }
    }
    let name = trimChars(out.trim(), ',，;；·-');
    const meta = /^(?:学分|学时|周学时|总学时|理论|实验|分|时)?[:：]\s*[\d.]+\s*/.exec(name);
    // `meta[0].length < name.length`：别把整串都剥光（万一课名真的就叫 ":1.0"）
    if (meta !== null && meta[0].length < name.length) {
      name = name.substring(meta[0].length);
    }
    return [name, category];
  }

  /**
   * 网格式单元格里的详情。**字段个数因学校而异**：
   *
   * - 3 段：`1-8周/第一实验楼-A204大学物理实验-4/李安琪`
   * - 7 段：`1-16周/计算机基础实验室-3(505-506)/徐洪学/课程代码/班级;班级/考查/学分:4.0`
   *
   * 规则：**第 1 段含"周"时是周次，第 2 段是地点，第 3 段是教师，其余忽略。**
   * 首段不含"周"说明这门课没写周次，那首段其实是地点，整体前移一位。
   *
   * 旧实现是"中间全部当地点、最后一段当教师"，照着 3 段样本写死 ——
   * 遇到 7 段那份文件时地点会把课程代码/班级/考核全吞进去、教师被写成 `学分:4.0`
   * （实测就是用户报的"教师地点串行"）。新规则对 3 段样本取值不变（已回归 20/20）。
   */
  static parseGridDetail(detail: string): GridFields {
    const parts: string[] = [];
    for (const p of detail.split('/')) {
      const t = p.trim();
      if (t.length > 0) {
        parts.push(t);
      }
    }
    if (parts.length === 0) {
      const empty: GridFields = { weekMask: 0n, location: '', teacher: '', classGroup: '' };
      return empty;
    }

    const hasWeeks = parts[0].indexOf('周') >= 0;
    const weekMask = hasWeeks ? WeekMasks.parse(parts[0]) : 0n;
    const rest = hasWeeks ? parts.slice(1) : parts;

    const fields: GridFields = {
      weekMask,
      location: rest.length > 0 ? rest[0] : '',
      teacher: rest.length > 1 ? rest[1] : '',
      classGroup: ParsingUtils.classGroupIn(rest, 2),
    };
    return fields;
  }

  /**
   * 从详情各段里找出"教学班"那一段。
   *
   * **不能用固定段号**：实测有两种版式
   * - `1-8周/第一实验楼-A204/李安琪`（3 段，没有班级）
   * - `1-16周/思源楼-230/史梦蝶/概率论与数理统计-0066/计科2510班;计科2511班/未安排/…`
   *   —— 第 4 段是「课程名-课程代码」，**第 5 段才是班级**
   *
   * 判定用"形状"而不是位置：切成 `;；、,` 之后**每一段都以「班」结尾**，才认。
   * 这样 `班主任实务`、`计科2509班（实验）` 这类都不会被误认 —— 宁可认不出（退回
   * "按名称+教师"合并），也不要把课名/备注当成班级。
   */
  private static classGroupIn(parts: string[], from: number): string {
    for (let i = from; i < parts.length; i++) {
      const candidate: string = parts[i];
      if (candidate.indexOf('班') < 0) {
        continue;
      }
      let ok = true;
      let count = 0;
      for (const token of candidate.split(/[;；、,，]/)) {
        const t = token.trim();
        if (t.length === 0) {
          continue;
        }
        count++;
        if (!t.endsWith('班')) {
          ok = false;
          break;
        }
      }
      if (ok && count > 0) {
        return candidate;
      }
    }
    return '';
  }

  /**
   * 从拼接好的列表式详情里取字段。
   * 折行会打断标签（"考核方" + "式:考试"），调用方必须先把同一详情块的多行**无分隔拼接**。
   */
  static parseListDetail(text: string): ListFields {
    const labels: string[] = [];
    const starts: number[] = [];
    const ends: number[] = [];
    const re = new RegExp(FIELD_REGEX.source, 'g');
    let m: RegExpExecArray | null = re.exec(text);
    while (m !== null) {
      labels.push(m[1]);
      starts.push(m.index);
      ends.push(m.index + m[0].length);
      if (re.lastIndex === m.index) {
        re.lastIndex++;
      }
      m = re.exec(text);
    }
    if (labels.length === 0) {
      const empty: ListFields = { weekMask: 0n, location: '', teacher: '', classGroup: '' };
      return empty;
    }

    const valueOf = (label: string): string => {
      let idx = -1;
      for (let i = 0; i < labels.length; i++) {
        if (labels[i] === label) {
          idx = i;
          break;
        }
      }
      if (idx < 0) {
        return '';
      }
      const start = ends[idx];
      const end = idx + 1 < starts.length ? starts[idx + 1] : text.length;
      if (start >= text.length) {
        return '';
      }
      return trimChars(text.substring(start, Math.min(end, text.length)).trim(), ';；,，');
    };

    const fields: ListFields = {
      weekMask: WeekMasks.parse(valueOf('周数')),
      location: valueOf('地点'),
      teacher: valueOf('教师'),
      // 「教学班组成」比「教学班」更具体，优先取它
      classGroup: valueOf('教学班组成').length > 0 ? valueOf('教学班组成') : valueOf('教学班'),
    };
    return fields;
  }
}
