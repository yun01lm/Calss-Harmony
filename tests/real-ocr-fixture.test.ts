/**
 * **真实截图 + 真实 OCR** 的回归测试（`tests/fixtures/timetable-ocr-windows.tsv`）。
 *
 * 夹具来源：一张真实的《全校作息时间调整方案》截图（12 节 + 3 个课间 + 3 个大课间），
 * 用 Windows 自带 OCR（`zh-Hans-CN`）识别出来的原始结果 —— **没有任何人工修饰**，
 * 保留了它全部的错读：连字符被读成冒号/间隔号、两位数被拆成"3 孓"、个别行被截断。
 *
 * 为什么值得进仓库：
 * 1. 之前的解析测试用的是**合成**的 21 行样本，样样都干净，测不出"OCR 有多脏"；
 * 2. 这张真实截图第一次跑就暴露了真问题 —— 分隔符只认破折号，而真实 OCR 把
 *    `8: 00-8: 45` 读成 `8 ： 00 ： 45`，于是**12 节一节都认不出来**（0/12）。
 *    把 `:：·・` 也算成区间分隔符之后是 8/12，剩下的 4 节恰好是 OCR 本身缺字的行；
 * 3. 这条断言同时钉住"缺字时不瞎猜"：第 1、10 节该报"没认出来"，而不是补一个错的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OcrLine, TimetableTextParser } from '../entry/src/main/ets/logic/TimetableTextParser.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 读 ocr_image.ps1 的输出（首行 OK，每行 `文本\tleft\ttop\tright\tbottom`，末行 END） */
function loadOcrFixture(name: string): OcrLine[] {
  const text = fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');
  const rows = text.split(/\r?\n/);
  assert.equal(rows[0], 'OK', '夹具首行应为 OK');
  const out: OcrLine[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row === 'END' || row.length === 0) {
      continue;
    }
    const parts = row.split('\t');
    if (parts.length < 5) {
      continue;
    }
    out.push(new OcrLine(parts[0], Number(parts[1]), Number(parts[2]), Number(parts[3]), Number(parts[4])));
  }
  return out;
}

test('真实 OCR 夹具：12 节里认出 8 节，且时间与分组都对', () => {
  const lines = loadOcrFixture('timetable-ocr-windows.tsv');
  assert.ok(lines.length > 50, `应该读到几十行，实际 ${lines.length}`);

  const parsed = TimetableTextParser.parse(lines);
  assert.equal(parsed.periods.length, 8, '第一个修复版本认 8 节');

  const byIndex = new Map<number, { start: number; end: number; group: string }>();
  for (const p of parsed.periods) {
    byIndex.set(p.periodIndex, { start: p.startMinute, end: p.endMinute, group: p.group });
  }

  // 这些都能从错读的 `8 ： 50 · 9 ： 35` 之类恢复出来
  assert.deepEqual(byIndex.get(2), { start: 8 * 60 + 50, end: 9 * 60 + 35, group: '上午' });
  assert.deepEqual(byIndex.get(3), { start: 10 * 60, end: 10 * 60 + 45, group: '上午' });
  assert.deepEqual(byIndex.get(5), { start: 13 * 60 + 30, end: 14 * 60 + 15, group: '下午' });
  assert.deepEqual(byIndex.get(9), { start: 18 * 60, end: 18 * 60 + 45, group: '晚上' });
});

test('真实 OCR 夹具：认不出的节次如实报出来，不瞎补', () => {
  const lines = loadOcrFixture('timetable-ocr-windows.tsv');
  const parsed = TimetableTextParser.parse(lines);

  // 第 1 节被读成 `8 ： 00 ： 45`（少了一个 8），10/11 节的节次号整个丢了 —— 这些都不该猜
  const joined = parsed.warnings.join(' | ');
  assert.match(joined, /第 1、10 节没认出来/);
  // 休息行被识别为课间并跳过，而不是当成节次
  assert.match(joined, /课间\/大课间/);
});

test('真实 OCR 夹具：分组标签（上午/下午/晚上）来自同一行的"时间"列', () => {
  const lines = loadOcrFixture('timetable-ocr-windows.tsv');
  const parsed = TimetableTextParser.parse(lines);
  const groups = new Map<number, string>();
  for (const p of parsed.periods) {
    groups.set(p.periodIndex, p.group);
  }
  // 上午：2-4；下午：5-8；晚上：9（OCR 把 上午/下午/晚上 各识别成一行独立文本）
  assert.equal(groups.get(4), '上午');
  assert.equal(groups.get(8), '下午');
});
