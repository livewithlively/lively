// #4158 — [AI 세션] 구역 재구성: 사이드바 = 프로젝트 리스트 · 가운데 = 전체 세션 목록 · 줄을 누르면 홈에서 연다.
//
//  회의 #3977(2026-09-14) 결정 원문:
//   · «AI 세션 탭과 홈 사이드바는 한 로직으로 통일. X = 치운 세션(언제든 다시 열기)»
//   · «AI 세션 탭 = 전체 세션 풀스크린 조회. 중복 세션 사이드바 제거, 사이드바엔 프로젝트 리스트(클릭 → 그 안 세션 필터)»
//   · P1-4 «AI 세션 탭 재구성: 세션 사이드바 → 프로젝트 리스트 사이드바, 풀스크린 목록, 세션 클릭 시 홈으로 이동, 날짜/사람 필터»
//  2026-09-21 원준 «AI 세션 사이드바 제거는 결정했는데 매니지드에 아직 안 보인다» — 커밋이 없었다. 이 파일이 그 결정을 잠근다.
//
//  V — 거르기 잣대(web/lib/sess-all.ts)를 값으로.  S — 사이드바·가운데·셸이 실제로 그 잣대와 **홈과 같은 판정·같은 문**을 지나는지 소스로.
//  ⚠ 단언을 하나씩 끝까지 센다(첫 실패에서 멈추지 않는다) — 수정 전 코드(origin/main)에서 V·S 전부 빨간불인 것을 확인했다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };
//  주석은 빼고 본다 — 머리말에 적힌 낱말이 단언을 통과시키면 그 시험은 아무것도 안 잡는다.
const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
/** 함수 하나만 잘라 본다 — 시작을 못 찾으면 빈 문자열(그 단언이 빨간불이 된다). */
const cut = (src, from, to) => { const a = src.indexOf(from); if (a < 0) return ""; const b = to ? src.indexOf(to, a + 1) : -1; return src.slice(a, b > a ? b : undefined); };

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}`); } };
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), `${name}${JSON.stringify(got) === JSON.stringify(want) ? "" : ` — got ${JSON.stringify(got)}`}`);

// ───────────────────────── V. 거르기 잣대 (web/lib/sess-all.ts) ─────────────────────────
let lib = null;
try { lib = await import(pathToFileURL(join(root, "public/app/lib/sess-all.js")).href); } catch { /* 없으면 아래 V0 가 빨간불 */ }
ok(!!lib, "V0 잣대가 잎 모듈(lib/sess-all.ts)에 있다 — 화면 코드 안에 있으면 시험할 데가 없다");
if (lib) {
  const { inProjPick, selectAllSess, ownerCounts } = lib;
  const { inPastPeriod } = await import(pathToFileURL(join(root, "public/app/lib/past-sess.js")).href);
  const DAY = 86_400_000;
  const NOW = new Date(2026, 8, 23, 12, 0, 0).getTime();   // 낮 — 「오늘」 경계가 자정이다
  const S = (id, o = {}) => ({ id, projectId: 1, trashedAt: null, lastSeen: NOW - 60_000, owner: "me", ...o });
  const rows = [
    S("a"),                                                   // 내 것 · 프로젝트 1 · 방금
    S("b", { projectId: null, lastSeen: NOW - 2 * DAY }),     // 내 것 · 프로젝트 없음 · 이틀 전
    S("c", { owner: "u2", lastSeen: NOW - 40 * DAY }),        // 남의 것 · 프로젝트 1 · 40일 전
    S("d", { projectId: 2, owner: "u2", lastSeen: NOW - 3 * 60_000 }),
    S("e", { trashedAt: "2026-09-20T00:00:00Z" }),            // 휴지통
    S("f", { projectId: 0, owner: "u3", lastSeen: NOW - 5 * DAY }),   // 프로젝트 id 0 = 없음
  ];
  const Q = (o = {}) => ({ proj: null, period: "all", owner: "", now: NOW, ...o });
  const ids = (xs) => xs.map((x) => x.id);

  ok(inProjPick(7, null) && inProjPick(null, null), "V1 null = 전체 — 어느 프로젝트든 든다");
  ok(inProjPick(null, 0) && inProjPick(0, 0) && inProjPick(undefined, 0) && !inProjPick(3, 0),
    "V2 ★0 은 «프로젝트 없음» 묶음이다 — 빈 값이 아니다(null 만 «전체»)");
  ok(inProjPick(3, 3) && !inProjPick(4, 3) && !inProjPick(null, 3), "V3 그 밖의 값은 그 프로젝트만");

  eq(ids(selectAllSess(rows, Q())), ["a", "d", "b", "f", "c"], "V4 전체 — 휴지통만 빼고 **최근 순**(남의 것·지난 것도 싣는다)");
  eq(ids(selectAllSess(rows, Q({ proj: 1 }))), ["a", "c"], "V5 프로젝트 1 만");
  eq(ids(selectAllSess(rows, Q({ proj: 0 }))), ["b", "f"], "V6 «프로젝트 없음» — null 과 0 을 같은 묶음으로 센다");
  eq(ids(selectAllSess(rows, Q({ owner: "me" }))), ["a", "b"], "V7 사람 = 나");
  eq(ids(selectAllSess(rows, Q({ owner: "u2" }))), ["d", "c"], "V8 사람 = 그 사람");
  eq(ids(selectAllSess(rows, Q({ period: "today" }))), ["a", "d"], "V9 기간 = 오늘");
  eq(ids(selectAllSess(rows, Q({ period: "older" }))), ["c"], "V10 기간 = 30일 이전");
  ok(["today", "week", "month", "older"].every((p) => {
    const want = rows.filter((r) => !r.trashedAt && inPastPeriod(r.lastSeen, NOW, p)).map((r) => r.id).sort().join();
    return ids(selectAllSess(rows, Q({ period: p }))).sort().join() === want;
  }), "V11 ★기간의 자는 「지난 세션」과 **같은 함수**(past-sess inPastPeriod) — 두 화면이 «7일 이내» 를 다르게 세지 않는다");
  eq(ids(selectAllSess(rows, Q({ proj: 1, owner: "u2", period: "month" }))), [], "V12 세 축은 AND 다");
  eq(selectAllSess(null, Q()), [], "V13 목록이 없어도 빈 결과");

  eq(ownerCounts(rows, Q()), [{ key: "me", n: 2 }, { key: "u2", n: 2 }, { key: "u3", n: 1 }],
    "V14 사람 칸 — 나 먼저, 나머지는 많은 순(휴지통은 안 센다)");
  eq(ownerCounts(rows, Q({ proj: 2 })), [{ key: "u2", n: 1 }], "V15 사람 칸은 걸린 프로젝트 **안에서** 센다");
  eq(ownerCounts(rows, Q({ proj: 2, owner: "u3" })), [{ key: "u2", n: 1 }, { key: "u3", n: 0 }],
    "V16 ★고른 사람은 0 이어도 칸이 남는다 — 사라지면 걸린 거르개를 끌 길이 없다");
}

// ───────────────────────── S. 배선 — 사이드바 · 가운데 · 셸 ─────────────────────────
const SIDE = read("web/v2/side.ts");
const MAIN = read("web/v2/main.ts");
const BINS = read("web/v2/bins.ts");

// S1 — 사이드바는 프로젝트 리스트다(세션 줄을 한 벌 더 그리지 않는다).
const rs = code(cut(SIDE, "function renderSessions(): void {", "\n// ══ [확인할 것] 구역"));
ok(rs.length > 0 && !/sessAsInst\(/.test(rs) && !/appListKids\(/.test(rs),
  "S1 ★[AI 세션] 사이드바가 세션 줄을 그리지 않는다 — «중복 세션 사이드바 제거»");
ok(/buildRows\(data\)/.test(rs) && /'전체'/.test(rs) && /'프로젝트 없음'/.test(rs),
  "S2 줄은 「전체」 · 세션이 있는 프로젝트 · 「프로젝트 없음」 — 재료·순서는 프로젝트 트리와 같은 buildRows");
ok(/sessProj = pick;/.test(rs) && /hooks\.onSessProject\?\.\(\)/.test(rs) && /'aria-pressed': String\(on\)/.test(rs) && /\(on \? ' on' : ''\)/.test(rs),
  "S3 줄을 누르면 거르개를 바꾸고 셸에 알린다 — 고른 줄은 눈에 보이게(.on · aria-pressed)");
ok(/export function sessProjFilter\(\): SessProjPick \{ return sessProj; \}/.test(SIDE)
  && !/(saveSet|saveFlag|localStorage\.setItem)\([^)]*sessProj/.test(code(SIDE)),
  "S4 고른 프로젝트는 셸이 읽고, 기억하지 않는다(페이지 수명 — 새로 열면 늘 전체)");

// S5 — 가운데: `#/app/terminal`(레일 착지·런치패드 「AI 세션」)을 셸이 직접 그린다.
const render = code(cut(MAIN, "async function renderRoute", "\nfunction markActive"));
ok(/if \(isSessAllRoute\(tab\.route\)\) \{\s*paintSessAll\(tab\);/.test(render),
  "S5 ★[AI 세션]의 가운데가 전체 세션 목록이다 — 액자에 실은 클래식 세션 관리가 아니다");
ok(/const isSessAllRoute = \(route: string\): boolean => routeKey\(route\) === 'app:terminal';/.test(MAIN)
  && /sec === 'sess' \? '#\/app\/terminal'/.test(MAIN),
  "S6 구역 착지 주소(sectionRoute)가 바로 그 화면이다");
ok(/else if \(isSessAllRoute\(at\.route\)\) paintSessAll\(at\);/.test(cut(MAIN, "async function syncShell", "\nlet sideSoon")),
  "S7 8초 결(syncShell)이 그 화면을 같은 값으로 다시 그린다 — 상태 점·치움이 따라온다");

// S8 — 홈과 한 자: 판정 재료·판정 함수가 홈 사이드바(sideInstances ①)와 같다.
const paint = code(cut(MAIN, "function paintSessAll(", "\nfunction repaintSessAll"));
const sideI = code(cut(MAIN, "function sideInstances(): SideInstance[] {", "async function closeSideRow(key: string)"));
ok(/const facts = homeVisFacts\(Date\.now\(\)\);/.test(paint) && /homeRowVerdict\(s, facts\)/.test(paint)
  && /const facts = homeVisFacts\(now\);/.test(sideI) && /verdictStands\(homeRowVerdict\(s, facts\)\)/.test(sideI),
  "S8 ★«홈에 서 있나 · 치웠나» 는 홈과 **같은 재료(homeVisFacts)·같은 함수(homeRowVerdict)** 로 잰다 — 판정이 두 벌이 아니다");
ok(/verdict: \(s\) => \(s\.owned && !isTrashedSess\(s\) \? homeRowVerdict\(s, facts\) : null\)/.test(paint),
  "S9 남의 세션은 재지 않는다 — 홈 ① 이 세우는 것도 내 세션뿐이다");

// S10 — 줄을 누르면 홈에서 연다: 홈 사이드바 행과 같은 문(openSideRow) + 구역을 홈으로.
ok(/onOpen: \(s\) => \{ setRailSection\('home', \{ navigate: false \}\); openSideRow\('sess:' \+ s\.id, '#\/s\/' \+ encodeURIComponent\(s\.id\)\); \}/.test(paint)
  && /onActivateInstance: openSideRow,/.test(MAIN),
  "S10 ★«세션 클릭 시 홈으로 이동» — 홈 사이드바 행이 부르는 그 함수(openSideRow)로 열고, 구역을 홈으로 옮긴다");
// S11 — 치우기 = 홈의 × 와 같은 함수.
ok(/onDismiss: \(s\) => \{ const done = closeSideRow\('sess:' \+ s\.id\);/.test(paint)
  && /onCloseInstance: \(key\) => \{ void closeSideRow\(key\); \}/.test(MAIN),
  "S11 ★«X = 치운 세션» — 목록의 치우기는 홈의 × 가 부르는 그 함수(closeSideRow → 서버 정본 치움)다");
// S12 — 사이드바가 프로젝트를 고르면 가운데가 따라온다.
const show = code(cut(MAIN, "function showSessAll(", "\n/**"));
ok(/onSessProject: showSessAll,/.test(MAIN) && /paintSessAll\(hit\)/.test(show) && /location\.hash = sectionRoute\('sess'\)/.test(show)
  && /mobile\?\.closeAll\(\)/.test(show),
  "S12 프로젝트 줄 → 가운데 목록을 그 값으로 다시(없으면 그리로 · 폰이면 서랍을 닫는다)");

// S13 — 가운데 목록 자신.
const all = code(cut(BINS, "export function renderSessAll("));
ok(/selectAllSess\(items, q\)/.test(all) && /ownerCounts\(items, q\)/.test(all),
  "S13 가운데 목록은 잎 모듈의 잣대로 거른다(프로젝트 · 기간 · 사람)");
ok(/PAST_PERIODS\.map/.test(all) && /'data-pick': 'period'/.test(all) && /'data-pick': 'owner'/.test(all),
  "S14 ★날짜·사람 고르개가 있다 — 기간은 「지난 세션」과 같은 표(PAST_PERIODS)");
ok(/owner: isMineSess\(s\) \? 'me'/.test(all), "S15 «나» 의 판정은 views.ts isMineSess 한 벌이다");
ok(/v === 'dismissed' \? el\('span', \{ class: 'v2-bin-tag', text: '치움'/.test(all) && /v && verdictStands\(v\)/.test(all),
  "S16 치운 세션은 「치움」 꼬리표로 그대로 서고, 치우기는 홈에 서 있는 줄에만 — 홈 판정(verdictStands)으로 가른다");
ok(/hooks\.onOpen\(s\)/.test(all) && !/window\.open|openSessionWindow|terminalUrl/.test(all),
  "S17 줄을 누르면 셸의 문(hooks.onOpen)으로만 연다 — 새 터미널 창을 따로 열지 않는다");

console.log(`\n#4158 [AI 세션] 프로젝트 리스트 · 전체 목록: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
