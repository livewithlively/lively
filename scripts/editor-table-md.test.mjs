// 마크다운 표 ↔ 셀 모델 왕복 골든 (#1685 표 즉시 편집)
//  위키 에디터는 표를 raw 블록(마크다운 원문)으로 보존하면서 화면에서는 셀을 바로 고치게 한다 —
//  셀 한 칸을 고칠 때마다 표 **전체**가 다시 직렬화되므로, 이 변환이 어긋나면 이렇게 된다:
//   🔴 셀에 '|' 를 한 글자 넣었더니 열이 하나 늘어난다(이스케이프 유실).
//   🔴 정렬(:---:)이 한 번 편집할 때마다 날아간다.
//   🔴 헤더 없는 노션 표(#551)가 편집 한 번에 헤더 있는 표로 바뀐다.
//   🔴 행마다 열 수가 다른 채로 남아 (행,열) 좌표 편집이 엉뚱한 셀에 쓰인다.
//  DOM 무의존 순수 모듈이라 컴파일 산출물을 그대로 import 한다(block-editor-roundtrip.test.mjs 동형).
//  셀 DOM 편집(포커스 이동·행/열 추가)은 DOM 의존이라 이 테스트의 범위 밖이다.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { parseTableMd, tableToMd, isTableMd, mdTableSplitRow, isMdTableSep } =
  await import(join(root, "public/app/lib/table-md.js"));

let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const round = (md) => tableToMd(parseTableMd(md));
// 모든 행의 열 수가 같아야 셀 편집이 (행,열) 좌표로 성립한다 — 모델을 받는 검사마다 같이 건다.
const assertRect = (t, name) => {
  assert.equal(t.align.length, t.head.length, `${name}: align 이 헤더와 다른 길이`);
  for (const r of t.rows) assert.equal(r.length, t.head.length, `${name}: 행 길이가 헤더와 다름`);
};

// ════════ 엣지 #1·2·3·4·6 — 정규형은 파스→직렬화가 완전 동일(고정점) ════════
const FIXED_POINT = {
  "기본 표(#1)": "| 이름 | 값 |\n| --- | --- |\n| 가 | 1 |\n| 나 | 2 |",
  "정렬 보존(#2)": "| a | b | c | d |\n| --- | :---: | ---: | :--- |\n| 1 | 2 | 3 | 4 |",
  "빈 셀(#3)": "| a | b |\n| --- | --- |\n|   | 2 |",
  "헤더 없는 표(#4 · #551)": "|   |   |\n| --- | --- |\n| 1 | 2 |",
  "인라인 서식 셀(#6)": "| **굵게** | [링크](https://x.dev) |\n| --- | --- |\n| `코드` | *기울임* |",
  "열 1개(#16)": "| 헤더 |\n| --- |\n| 값 |",
  "본문 0행(#17)": "| a | b |\n| --- | --- |",
};
for (const [name, md] of Object.entries(FIXED_POINT)) {
  const got = round(md);
  assert.equal(got, md, `고정점 깨짐: ${name}\n기대:\n${md}\n실제:\n${got}`);
  assertRect(parseTableMd(md), name);
  ok(`고정점 — ${name}`);
}

// 헤더 없는 표는 '헤더가 빈 상태'로 남아야 한다 — 편집 한 번에 헤더가 생기면 무손실이 깨진다(#4).
{
  const t = parseTableMd("|   |   |\n| --- | --- |\n| 1 | 2 |");
  assert.deepEqual(t.head, ["", ""], "빈 헤더가 채워졌다");
  assert.deepEqual(t.rows, [["1", "2"]], "본문 행이 헤더로 승격되면 안 된다");
  ok("헤더 없는 표 — 빈 헤더 유지(#4)");
}

// 셀 마크다운은 파서가 건드리지 않는다(#6) — 렌더는 소비자의 몫.
{
  const t = parseTableMd("| **굵게** | [링크](https://x.dev) |\n| --- | --- |\n| `코드` | *기울임* |");
  assert.deepEqual(t.head, ["**굵게**", "[링크](https://x.dev)"]);
  assert.deepEqual(t.rows[0], ["`코드`", "*기울임*"]);
  ok("인라인 서식 — 셀 원문 보존(#6)");
}

// ════════ 엣지 #5 — 셀 안 리터럴 파이프는 열을 늘리지 않는다 ════════
{
  const t = parseTableMd("| a | b |\n| --- | --- |\n| 1 \\| 2 | 3 |");
  assert.equal(t.rows[0][0], "1 | 2", "이스케이프 파이프가 셀 안 리터럴로 복원돼야 한다");
  assert.equal(t.rows[0].length, 2, "이스케이프 파이프로 열이 늘면 안 된다");
  const md = tableToMd(t);
  assert.ok(md.includes("1 \\| 2"), "직렬화가 다시 이스케이프해야 한다: " + md);
  assert.deepEqual(parseTableMd(md).rows, t.rows, "이스케이프 왕복이 안정적이어야 한다");
  ok("셀 안 '|' — \\| 왕복 안정(#5)");
}

// ════════ 엣지 #7·8·9·18 — 비정규형은 1패스에서 정규형으로, 그 뒤로는 불변 ════════
const NORMALIZE = {
  "양끝 파이프 없음(#7)": ["a | b\n--- | ---\n1 | 2", "| a | b |\n| --- | --- |\n| 1 | 2 |"],
  "여분 공백(#8)": ["|  a  |  b  |\n|---|---|\n|  1  |  2  |", "| a | b |\n| --- | --- |\n| 1 | 2 |"],
  "구분행 대시 길이(#8)": ["| a | b |\n| ----- | ----- |\n| 1 | 2 |", "| a | b |\n| --- | --- |\n| 1 | 2 |"],
  "짧은 행은 빈 셀로(#9)": ["| a | b | c |\n| --- | --- | --- |\n| 1 |", "| a | b | c |\n| --- | --- | --- |\n| 1 |   |   |"],
  "공백뿐인 셀(#18)": ["| a | b |\n| --- | --- |\n|    | 2 |", "| a | b |\n| --- | --- |\n|   | 2 |"],
  "앞뒤 빈 줄(#14)": ["\n| a | b |\n| --- | --- |\n| 1 | 2 |\n", "| a | b |\n| --- | --- |\n| 1 | 2 |"],
};
for (const [name, [input, want]] of Object.entries(NORMALIZE)) {
  assert.equal(round(input), want, `정규화 어긋남: ${name}`);
  assert.equal(round(want), want, `정규화 후 불안정: ${name}`);
  assertRect(parseTableMd(input), name);
  ok(`정규화 — ${name}`);
}

// ════════ 엣지 #10 — 본문이 헤더보다 넓으면 헤더·정렬도 함께 늘어난다 ════════
{
  const t = parseTableMd("| a | b |\n| --- | :---: |\n| 1 | 2 | 3 |");
  assert.equal(t.head.length, 3, "본문이 더 넓으면 헤더도 그만큼 늘어야 한다");
  assert.deepEqual(t.head, ["a", "b", ""], "늘어난 헤더 칸은 비어 있어야 한다");
  assert.deepEqual(t.align, ["", "c", ""], "기존 정렬은 그대로, 늘어난 칸만 기본 정렬");
  assertRect(t, "넓은 본문");
  ok("열 확장 — 가장 넓은 행 기준 사각형(#10)");
}

// ════════ 엣지 #15 — 구분행이 헤더보다 짧아도 열 수는 헤더 기준으로 지킨다 ════════
{
  const t = parseTableMd("| a | b | c |\n| --- | :---: |\n| 1 | 2 | 3 |");
  assert.equal(t.head.length, 3, "구분행이 짧다고 열이 줄면 안 된다");
  assert.deepEqual(t.align, ["", "c", ""], "부족한 정렬 칸은 기본 정렬로 채운다");
  assertRect(t, "짧은 구분행");
  assert.equal(round(round("| a | b | c |\n| --- | :---: |\n| 1 | 2 | 3 |")),
    round("| a | b | c |\n| --- | :---: |\n| 1 | 2 | 3 |"), "정규화 후 불안정");
  ok("짧은 구분행 — align 부족분 채움(#15)");
}

// ════════ 엣지 #17 — 본문 0행이어도 모델이 성립한다(행 추가 버튼이 여기서 출발한다) ════════
{
  const t = parseTableMd("| a | b |\n| --- | --- |");
  assert.deepEqual(t.rows, [], "본문 없는 표는 rows 가 빈 배열");
  assert.equal(t.head.length, 2);
  ok("본문 0행 — 빈 rows 로 성립(#17)");
}

// ════════ 엣지 #19 — 셀 값의 개행은 표 구조를 깨지 않는다(공백으로 접음) ════════
{
  const md = tableToMd({ head: ["a", "b"], align: ["", ""], rows: [["여러\n줄", "x"]] });
  assert.equal(md.split("\n").length, 3, "셀 개행이 행을 쪼개면 안 된다: " + JSON.stringify(md));
  assert.deepEqual(parseTableMd(md).rows, [["여러 줄", "x"]]);
  ok("셀 개행 — 공백으로 접힘(#19)");
}

// ════════ 엣지 #11·12·13 — 표가 아닌 것은 건드리지 않는다(원문 편집으로 폴백) ════════
const NOT_TABLE = {
  "구분행 없음(#11)": "| a | b |\n| 1 | 2 |",
  "표 뒤 산문(#12)": "| a |\n| --- |\n| 1 |\n\n표 아래 설명 문단",
  "수식 raw(#12)": "$$\nx = 1\n$$",
  "빈 문자열(#13)": "",
  "한 줄뿐(#13)": "| a | b |",
};
for (const [name, md] of Object.entries(NOT_TABLE)) {
  assert.equal(parseTableMd(md), null, `표가 아닌데 표로 봤다: ${name}`);
  assert.equal(isTableMd(md), false);
  ok(`비-표 폴백 — ${name}`);
}

// ════════ 원시 규칙 — 렌더러(lib/markdown.ts)와 공유하는 셀 분리·구분행 판정 ════════
assert.deepEqual(mdTableSplitRow("| a | b |"), ["a", "b"]);
assert.deepEqual(mdTableSplitRow("a|b"), ["a", "b"]);
assert.deepEqual(mdTableSplitRow("|  x  |"), ["x"]);
assert.deepEqual(mdTableSplitRow("| 1 \\| 2 |"), ["1 | 2"]);
assert.equal(isMdTableSep("| --- | :---: |"), true);
assert.equal(isMdTableSep("| a | b |"), false);
ok("원시 규칙 — mdTableSplitRow · isMdTableSep");

console.log(`\n✓ 표 마크다운 왕복 — ${pass} 검사 통과`);
