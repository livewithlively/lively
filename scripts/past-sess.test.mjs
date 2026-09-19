// 「지난 세션」 화면의 잣대(web/lib/past-sess.ts) — 값으로 지킨다 (#3778, 원준 2026-09-19).
//
//  사양(엣지 표 E1~E21)은 스크래치패드 spec.md 가 아니라 여기 주석과 단언 문구로 남는다.
//  화면이 지켜야 하는 약속 셋:
//   ① × 로 치운 세션은 **도는 중이어도** 여기 있다 — "x 를 누르면 아카이브로 보내지 말고 지난 세션으로 보내".
//   ② 박스가 없는 세션은 치웠든 안 치웠든 여기 있다(홈의 흐린 톤과 같은 술어).
//   ③ 휴지통 것은 여기 없다(제 화면이 있다, #1851).
//  그 위에 «필터가 실제로 거르나»(기간·칩·검색·프로젝트 묶기)를 값으로 덧댄다.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, what) => { assert.ok(cond, what); pass++; };
const eq = (got, want, what) => { assert.deepEqual(got, want, what); pass++; };

const {
  standsInPast, isDismissedSess, isStoppedSess, pastNames,
  inPastPeriod, selectPast, groupPastByProject, PAST_PERIODS, dayStartOf,
} = await import(join(root, "public/app/lib/past-sess.js"));

const DAY = 86_400_000;
//  2026-09-19 12:00 (그 지역) — 「오늘」 경계가 자정이라 낮 시각을 기준으로 잡는다.
const NOW = new Date(2026, 8, 19, 12, 0, 0).getTime();
const none = new Set();
const live = (id, over = {}) => ({ id, live: true, alive: true, lastSeen: NOW - 60_000, projectId: 1, ...over });
const dead = (id, over = {}) => ({ id, live: false, alive: false, lastSeen: NOW - 60_000, projectId: 1, ...over });

// ── 설 자격 (E1~E6) ──────────────────────────────────────────────────────────
ok(standsInPast(dead("a"), none), "E1 박스가 없는 세션은 「지난 세션」에 선다");
ok(!standsInPast(live("b"), none), "E2 도는 세션은 안 선다 — 홈에 있다");
ok(standsInPast(live("c"), new Set(["c"])), "E3 ★치운 세션은 도는 중이어도 선다 — × 의 도착지가 여기다");
ok(!standsInPast(dead("d", { trashedAt: "2026-09-18T00:00:00Z" }), none), "E4 휴지통 것은 안 선다");
ok(!standsInPast(live("e", { trashedAt: "2026-09-18T00:00:00Z" }), new Set(["e"])),
  "E5 휴지통이 치움보다 먼저 — 도는 중이고 치웠어도 안 선다");
ok(isStoppedSess({ live: true, alive: false }) && isStoppedSess({ live: false, alive: true }) && !isStoppedSess({ live: true, alive: true }),
  "E6 '박스 없음' 은 live·alive 둘 다 참일 때만 거짓 — 한 칸만 참이면 멈춘 것이다");

// ── 한 세션의 여러 이름 (E7·E8) ──────────────────────────────────────────────
const manyNamed = dead("box-new", { logId: "uuid-1", altIds: ["box-old"] });
eq(pastNames(manyNamed), ["box-new", "uuid-1", "box-old"], "E7 이름 셋을 다 내놓는다(빈 값은 뺀다)");
ok(isDismissedSess(manyNamed, new Set(["uuid-1"])), "E7′ 대화 uuid 로 치웠어도 그 세션은 치운 것이다");
ok(isDismissedSess(manyNamed, new Set(["box-old"])), "E7″ 되살리기 전 옛 박스 id 로 치웠어도 같다");
ok(!isDismissedSess(manyNamed, new Set(["box-other"])), "E8 남의 이름엔 안 걸린다");

// ── 기간 (E9~E12·E21) ────────────────────────────────────────────────────────
ok(PAST_PERIODS[0].key === "all", "E21 기간 고르개의 첫 칸은 「기간 전체」 — 기본이 안 거르는 쪽이다");
ok(inPastPeriod(NOW - 60_000, NOW, "today") && !inPastPeriod(dayStartOf(NOW) - 1, NOW, "today"),
  "E9 「오늘」은 그 지역 자정부터 — 자정 직전은 오늘이 아니다");
ok(inPastPeriod(NOW - 3 * DAY, NOW, "week") && !inPastPeriod(NOW - 8 * DAY, NOW, "week"),
  "E10 「7일 이내」는 7일까지만");
ok(inPastPeriod(NOW - 60_000, NOW, "week") && inPastPeriod(NOW - 60_000, NOW, "month"),
  "E10′ 기간은 누적이다 — 오늘 것은 7일·30일 안에도 든다");
ok(inPastPeriod(NOW - 40 * DAY, NOW, "older") && !inPastPeriod(NOW - 40 * DAY, NOW, "month"),
  "E11 「30일 이전」은 배타 — 최근 것이 섞이면 오래된 것을 찾을 수 없다");
ok(inPastPeriod(0, NOW, "older") && !inPastPeriod(0, NOW, "today") && inPastPeriod(0, NOW, "all"),
  "E12 시각을 모르는 줄(0)은 「30일 이전」으로 — 어느 칸에도 없는 줄을 만들지 않는다");

// ── 고르기 (E13~E18) ─────────────────────────────────────────────────────────
const all = [
  dead("s1", { lastSeen: NOW - 2 * 3600_000, projectId: 7 }),          // 오늘
  dead("s2", { lastSeen: NOW - 3 * DAY, projectId: 7 }),               // 이번 주 · 치움
  dead("s3", { lastSeen: NOW - 40 * DAY, projectId: 0 }),              // 30일 이전 · 프로젝트 없음
  live("s4", { lastSeen: NOW - 5 * 60_000, projectId: 7 }),            // 도는 중 — 안 선다
  live("s5", { lastSeen: NOW - 10 * 60_000, projectId: 9 }),           // 도는데 치움 — 선다
  dead("s6", { lastSeen: NOW - DAY, projectId: 9, trashedAt: "2026-09-18T00:00:00Z" }),  // 휴지통
];
const dism = new Set(["s5", "s2"]);
const base = { dismissed: dism, scope: "all", period: "all", now: NOW, newestFirst: true };

eq(selectPast(all, base).map((s) => s.id), ["s5", "s1", "s2", "s3"], "E1~E5 종합 + 최근 순 정렬");
eq(selectPast(all, { ...base, newestFirst: false }).map((s) => s.id), ["s3", "s2", "s1", "s5"],
  "E15 오래된 순은 정확히 뒤집는다");
eq(selectPast(all, { ...base, scope: "dismissed" }).map((s) => s.id), ["s5", "s2"],
  "E13 「치운 것」 칩은 치운 것만 — 도는 중인 것도 포함");
eq(selectPast(all, { ...base, period: "today" }).map((s) => s.id), ["s5", "s1"], "E9′ 기간 칸이 실제로 거른다");
eq(selectPast(all, { ...base, period: "older" }).map((s) => s.id), ["s3"], "E11′ 「30일 이전」");
eq(selectPast(all, { ...base, projectId: 7 }).map((s) => s.id), ["s1", "s2"], "E14′ 프로젝트로 좁히기");
eq(selectPast(all, { ...base, projectId: 0 }).map((s) => s.id), ["s3"],
  "E14 ★프로젝트 0 은 「프로젝트 없음」 묶음이다 — 빈 값이 아니다");
eq(selectPast(all, { ...base, match: (s) => s.id === "s2" }).map((s) => s.id), ["s2"], "E16 검색 술어");
const before = all.map((s) => s.id).join(",");
selectPast(all, base);
ok(all.map((s) => s.id).join(",") === before, "E17 입력 배열을 건드리지 않는다(정렬이 원본을 뒤집지 않는다)");
ok(selectPast(null, base).length === 0 && selectPast(undefined, base).length === 0, "E18 재료가 아직 없으면 빈 목록");

// ── 프로젝트로 묶기 (E19·E20) ────────────────────────────────────────────────
eq(groupPastByProject(selectPast(all, base)).map((g) => [g.id, g.rows.map((r) => r.id)]),
  [[9, ["s5"]], [7, ["s1", "s2"]], [0, ["s3"]]],
  "E19 묶음은 «가장 최근 줄» 순 · 묶음 안 순서는 받은 그대로 · 프로젝트 없음도 한 묶음");
ok(groupPastByProject([]).length === 0, "E20 줄이 없으면 묶음도 없다");

// ── 배선 — 화면이 이 잣대를 실제로 쓰는가 (W1~W8) ────────────────────────────
const BINS = read("web/v2/bins.ts");
const SIDE = read("web/v2/side.ts");
const MAIN = read("web/v2/main.ts");
ok(/export function renderPast\(/.test(BINS) && /standsInPast\(s, dism\)/.test(BINS)
  && /selectPast\(items, \{/.test(BINS) && /groupPastByProject\(vis\)/.test(BINS),
  "W1 화면이 잣대를 그대로 쓴다(제 판정을 따로 짓지 않는다)");
ok(/text: '지난 세션'/.test(BINS) && !/text: '아카이브'/.test(BINS),
  "W2 화면 제목이 「지난 세션」 — 「아카이브」라는 자리는 없앴다");
ok(/chip\(ui\.mode === 'proj', '보관한 프로젝트'/.test(BINS) && /function archivedProjects\(/.test(BINS)
  && /text: '보관 해제'/.test(BINS),
  "W3 보관한 프로젝트는 같은 화면의 칩으로 남는다 — 해제할 길이 사라지면 안 된다");
ok(/dock\('archive', '지난 세션'/.test(SIDE) && /row\('archive', '지난 세션'/.test(SIDE),
  "W4 사이드바 두 입구(도크·트리 발치)가 같은 이름을 쓴다");
ok(!/아카이브 ▸ 치운 세션/.test(SIDE) && /\[지난 세션\] 화면에서 다시 열거나 되돌릴 수 있어요/.test(SIDE),
  "W5 ★× 툴팁이 가리키는 곳이 「지난 세션」이다 — 이 신고의 본문");
ok(/if \(p === 'archive'\) return \{ title: '지난 세션'/.test(MAIN) && /renderPast\(/.test(MAIN)
  && !/renderArchive/.test(MAIN),
  "W6 주소(#/archive)는 그대로 두고 이름·내용만 바꾼다 — 열어 둔 탭이 빈 화면이 되지 않게");
ok(/'홈 목록으로'/.test(BINS) && /restoreDismissedSessions\(ids\)/.test(BINS),
  "W7 치운 세션을 홈 목록으로 되돌리는 길이 이 화면에 있다(#3857 이 만든 그 길)");
ok(/ui\.group \? \[\] : \[el\('td', \{ class: 'c-in' \}/.test(BINS),
  "W8 프로젝트로 묶으면 프로젝트 열이 사라지고 묶음 머리줄이 그 몫을 한다");

console.log(`past-sess: ${pass} ok`);
