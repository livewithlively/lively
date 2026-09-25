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
//  #4233 2안 — 사이드바는 거르개 자리 그대로(회의 #3977)이고, 줄은 기준의 묶음 카드 × 프로젝트다(재료 · 순서는 lib 의 sideCards · projectLines).
ok(/const cards = sideCards\(items, sc\.by, now, rankOf\);/.test(rs) && /const lines = projectLines\(items\);/.test(rs) && /text: '전체'/.test(rs),
  "S2 줄은 「전체」 · 기준의 묶음 카드 · 카드 안 프로젝트 — 재료 · 순서는 lib(sideCards · projectLines) 한 벌");
ok(/const pick = \(next: SessScope, keepDrawer = false\): void => \{ setSessScope\(next\); redraw\(\); hooks\.onSessProject\?\.\(\{ keepDrawer \}\); \};/.test(rs)
  && /'aria-pressed': String\(on\)/.test(rs) && /\(on \? ' on' : ''\)/.test(rs) && /'aria-pressed': String\(headOn\)/.test(rs),
  "S3 줄 · 카드 머리를 누르면 거르개를 바꾸고 셸에 알린다 — 고른 줄 · 카드는 눈에 보이게(.on · aria-pressed)");
const SCOPE = read("web/v2/sess-scope.ts");
ok(/export function sessScope\(\): SessScope \{ return cur; \}/.test(SCOPE) && /let cur: SessScope = \{ \.\.\.SESS_SCOPE0 \};/.test(SCOPE)
  && !/(localStorage|shellPrefStore|deviceStore|saveSet)/.test(code(SCOPE)),
  "S4 고른 것(기준 · 카드 · 줄)은 sess-scope 한 자리이고 기억하지 않는다(페이지 수명 — 새로 열면 늘 시간별 · 전체)");

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


// ───────────────────────── #4233 안 A — 묶기 · 상태 거르개 · 「지금 볼 것」 카드 · 이름 없는 세션 · 배선 ─────────────────────────
//  사양: 원준 2026-09-25 «안 A 좋아 · 매니지드까지» + «날짜 말고 사람으로 묶거나 다른 옵션들로도». 엣지 표 G1–G9 · F1–F3 · C1–C3 · U1–U2 · W1 한 행에 단언 하나 이상.
if (lib) {
  const { groupAllSess, pickNowCards, dayBucket, selectAllSess, ownerCounts } = lib;
  ok(typeof groupAllSess === "function" && typeof pickNowCards === "function" && typeof dayBucket === "function", "A0 묶기 · 카드 잣대가 잎 모듈에 있다");
  if (typeof groupAllSess === "function" && typeof pickNowCards === "function" && typeof dayBucket === "function") {
    const NOW = new Date(2026, 8, 25, 15, 0, 0).getTime();
    const at = (d, h = 12, m = 0, sec = 0) => new Date(2026, 8, 25 - d, h, m, sec).getTime();
    const R = (id, o = {}) => ({ id, projectId: 1, trashedAt: null, lastSeen: at(0), owner: "me", stateKey: "idle", ...o });
    const RANK = { waiting: 0, done: 1, busy: 2, idle: 3, offline: 4 };
    const rank = (k) => (k in RANK ? RANK[k] : 99);
    const keys = (gs) => gs.map((g) => g.key);
    const flat = (gs) => gs.flatMap((g) => g.rows.map((r) => r.id)).sort().join();

    const days = [R("now", { lastSeen: NOW - 60_000 }), R("y", { lastSeen: at(1, 23, 59) }), R("two", { lastSeen: at(2) }), R("old", { lastSeen: at(40) })];
    eq(keys(groupAllSess(days, "day", NOW, rank)), ["오늘", "어제", "이번 주", "이전"], "G1 날짜 묶기 — 오늘 → 어제 → 이번 주 → 이전");
    eq([dayBucket(at(0, 0, 0, 0), NOW), dayBucket(at(1, 23, 59, 59), NOW)], ["오늘", "어제"], "G2 경계 — 오늘 00:00 정각은 오늘, 어제 23:59:59 는 어제");
    eq([dayBucket(at(6), NOW), dayBucket(at(7), NOW)], ["이번 주", "이전"], "G3 경계 — 6일 전은 이번 주, 7일 전은 이전");

    const projs = [R("p2", { projectId: 2, lastSeen: at(0, 14) }), R("n0", { projectId: 0, lastSeen: at(0, 14, 30) }), R("p1", { projectId: 1, lastSeen: at(0, 13) }),
      R("nn", { projectId: null, lastSeen: at(0, 12) }), R("p1b", { projectId: 1, lastSeen: at(0, 11) })];
    const pg = groupAllSess(projs, "project", NOW, rank);
    eq(keys(pg), ["2", "1", "0"], "G4 프로젝트 묶기 — 최근 순, null 과 0 은 한 묶음이고 가장 최근이어도 맨 끝");
    eq(pg[2].rows.map((r) => r.id), ["n0", "nn"], "G4b «프로젝트 없음» 묶음에 null · 0 이 함께 든다");

    const own = [R("u3a", { owner: "u3" }), R("u2a", { owner: "u2" }), R("me1", { owner: "me" }), R("u3b", { owner: "u3" }), R("u2b", { owner: "u2" })];
    eq(keys(groupAllSess(own, "owner", NOW, rank)), ["me", "u2", "u3"], "G5 사람 묶기 — 나 맨 앞, 같은 수면 id 순");

    const sts = [R("i", { stateKey: "idle" }), R("x", { stateKey: "mystery" }), R("b", { stateKey: "busy" }), R("w", { stateKey: "waiting" })];
    eq(keys(groupAllSess(sts, "state", NOW, rank)), ["waiting", "busy", "idle", "mystery"], "G6 상태 묶기 — 순위 순, 모르는 상태는 맨 끝");

    const mix = [...days, ...projs, ...own, ...sts];
    const want = mix.map((r) => r.id).sort().join();
    ok(["day", "project", "owner", "state"].every((by) => flat(groupAllSess(mix, by, NOW, rank)) === want), "G7 ★묶기를 바꿔도 행 집합은 같다(묶기는 거르지 않는다)");
    ok(["day", "project", "owner", "state"].every((by) => groupAllSess([], by, NOW, rank).length === 0 && groupAllSess(null, by, NOW, rank).length === 0), "G8 행이 없거나 null 이면 빈 배열");
    const none = groupAllSess(mix, "none", NOW, rank);
    eq([none.length, none[0] && none[0].key, none[0] && none[0].rows.map((r) => r.id).join()], [1, "", mix.map((r) => r.id).join()],
      "G10 ★묶지 않음 — 묶음 하나에 전부, 들어온 순서(최근 순) 그대로");
    ok(groupAllSess([], "none", NOW, rank).length === 0 && groupAllSess(null, "none", NOW, rank).length === 0, "G11 묶지 않음 + 행 없음 — 묶음도 없다(빈 머리가 서지 않는다)");
    eq(groupAllSess([R("a", { lastSeen: at(0, 14) }), R("b", { lastSeen: at(0, 13) }), R("c", { lastSeen: at(0, 12) })], "project", NOW, rank)[0].rows.map((r) => r.id),
      ["a", "b", "c"], "G9 묶음 안 순서는 들어온 순서(최근 순) 그대로");

    const Q = (o = {}) => ({ proj: null, period: "all", owner: "", now: NOW, ...o });
    const fr = [R("mw", { stateKey: "waiting" }), R("ow", { owner: "u2", stateKey: "waiting" }), R("mb", { stateKey: "busy", lastSeen: at(0, 11) })];
    eq(selectAllSess(fr, Q({ state: "" })).map((r) => r.id).sort(), ["mb", "mw", "ow"], "F1 상태 거르개 '' 는 거르지 않는다");
    eq(selectAllSess(fr, Q({ state: "waiting", owner: "me" })).map((r) => r.id), ["mw"], "F2 상태 거르개와 사람 거르개는 AND");
    eq(ownerCounts(fr, Q({ state: "waiting" })), [{ key: "me", n: 1 }, { key: "u2", n: 1 }], "F3 사람 칸 숫자는 상태 거르개가 걸린 채로 센다(고른 뒤 줄 수와 같다)");

    const c1 = [R("theirs", { owner: "u2", stateKey: "waiting" }), R("past", { stateKey: "restorable" }), R("trash", { stateKey: "waiting", trashedAt: "2026-09-24T00:00:00Z" })];
    eq(pickNowCards(c1, rank, 4, NOW), [], "C1 카드에 남의 세션 · 지난 세션 · 휴지통 세션은 없다");
    const c2 = [R("i1", { stateKey: "idle", lastSeen: at(0, 14) }), R("b1", { stateKey: "busy", lastSeen: at(0, 10) }), R("w1", { stateKey: "waiting", lastSeen: at(0, 9) }),
      R("b2", { stateKey: "busy", lastSeen: at(0, 13) }), R("d1", { stateKey: "done", lastSeen: at(0, 8) }), R("i2", { stateKey: "idle", lastSeen: at(0, 12) })];
    eq(pickNowCards(c2, rank, 4, NOW).map((r) => r.id), ["w1", "d1", "b2", "b1"], "C2 ★내 세션 넷 — 확인 필요 → 작업 완료 → 작업 중(최근 순), 최대 4장");
    ok(pickNowCards([], rank, 4, NOW).length === 0 && pickNowCards(null, rank, 4, NOW).length === 0, "C3 행이 없으면 카드도 없다");
    //  ── #4233 2안 — 리스트 묶기 · 카드 거르기 · 사이드바 카드 · 본문 기준 · 고른 것 풀기(엣지 표 L · K · F · C · M · S) ──
    const { sessGroupKey, sideCards, projectLines, mainGroupBy, withGroupBy, settleScope } = lib;
    ok([sessGroupKey, sideCards, projectLines, mainGroupBy, withGroupBy, settleScope].every((f) => typeof f === "function"), "B0 2안 잣대가 잎 모듈에 있다");
    if ([sessGroupKey, sideCards, projectLines, mainGroupBy, withGroupBy, settleScope].every((f) => typeof f === "function")) {
      const lst = [R("l2", { listId: 2, lastSeen: at(0, 13) }), R("l0", { listId: 0, lastSeen: at(0, 14, 30) }), R("l3", { listId: 3, lastSeen: at(0, 14) }), R("l2b", { listId: 2, lastSeen: at(0, 9) })];
      eq(keys(groupAllSess(lst, "list", NOW, rank)), ["3", "2", "0"], "L1 리스트별 — 최근 순, «리스트 없음»(0) 은 가장 최근이어도 맨 끝");
      eq([R("a", { listId: null }), R("b", {}), R("c", { listId: 0 })].map((x) => sessGroupKey(x, "list", NOW)), ["0", "0", "0"], "L2 listId 가 null · 없음 · 0 이면 셋 다 «리스트 없음»");
      const one = R("k", { lastSeen: at(1, 10), listId: 5, projectId: 7, owner: "u2", stateKey: "busy" });
      eq(["day", "list", "project", "owner", "state", "none"].map((b) => sessGroupKey(one, b, NOW)), ["어제", "5", "7", "u2", "busy", ""], "K1 sessGroupKey 기준마다");
      const Q2 = (o = {}) => ({ proj: null, period: "all", owner: "", now: NOW, ...o });
      const pool = [R("t1", { lastSeen: at(0, 10), listId: 2, projectId: 7 }), R("t2", { lastSeen: at(0, 9), listId: 2, projectId: 8 }),
        R("y1", { lastSeen: at(1, 10), listId: 2, projectId: 7, owner: "u2" }), R("o1", { lastSeen: at(3, 10), listId: 3, projectId: 9 })];
      eq(selectAllSess(pool, Q2({ group: { by: "day", key: "오늘" } })).map((x) => x.id), ["t1", "t2"], "F1 카드(시간별 · 오늘)를 고르면 오늘 세션만");
      eq(selectAllSess(pool, Q2({ group: { by: "list", key: "2" }, proj: 7 })).map((x) => x.id), ["t1", "y1"], "F2 카드(리스트 2) + 줄(프로젝트 7)");
      ok(selectAllSess(pool, Q2({ group: null })).length === 4 && selectAllSess(pool, Q2({})).length === 4, "F3 카드를 안 골랐으면(null · 없음) 거르지 않는다");
      eq(selectAllSess(pool, Q2({ group: { by: "list", key: "2" }, owner: "u2" })).map((x) => x.id), ["y1"], "F4 카드 거르기와 사람 거르개는 AND");
      const sc1 = [R("m1", { owner: "me", projectId: 7, lastSeen: at(0, 9) }), R("m2", { owner: "me", projectId: 0, lastSeen: at(0, 8) }), R("m3", { owner: "me", projectId: 8, lastSeen: at(0, 10), stateKey: "waiting" }),
        R("u1", { owner: "u2", projectId: 7, lastSeen: at(0, 11) }), R("u2", { owner: "u2", projectId: 7, lastSeen: at(0, 7) }), R("tr", { owner: "me", projectId: 7, trashedAt: "2026-09-24T00:00:00Z" })];
      const cards = sideCards(sc1, "owner", NOW, rank);
      eq(cards.map((c) => [c.key, c.n, c.projects.map((l) => `${l.pid}:${l.n}${l.wait ? "!" : ""}`).join(",")]),
        [["u2", 2, "7:2"], ["me", 3, "0:1,8:1!,7:1"]], "C5 ★사이드바 카드(사람별) — 카드는 최근 활동 순(u2 11시 > 나 10시), 줄은 프로젝트 없음 맨 앞 · 최근 순 · 수 · 확인 필요 표식");
      ok(sideCards([], "day", NOW, rank).length === 0 && sideCards(null, "day", NOW, rank).length === 0, "C6 행이 없거나 null 이면 카드도 없다");
      ok(sideCards(sc1, "none", NOW, rank).length === 0, "C7 묶지 않음이면 카드가 없다");
      ok(!cards.some((c) => c.projects.some((l) => l.pid === 7 && c.key === "me" && l.n > 1)) && projectLines(sc1).find((l) => l.pid === 7).n === 3,
        "C8 휴지통 세션은 세지 않는다(카드 · 줄 모두)");
      eq([mainGroupBy({ by: "owner", group: null, proj: null }), mainGroupBy({ by: "owner", group: "me", proj: null }),
        mainGroupBy({ by: "owner", group: "me", proj: 7 }), mainGroupBy({ by: "none", group: null, proj: 7 })], ["owner", "project", "day", "none"],
        "M1 ★본문 기준 — 카드 없음은 그 기준 · 카드는 프로젝트별 · 카드+줄은 시간별 · 묶지 않음은 늘 묶지 않음");
      eq(withGroupBy({ by: "day", group: "오늘", proj: 7 }, "owner"), { by: "owner", group: null, proj: null }, "S5 다른 기준을 고르면 카드 · 줄이 풀린다");
      const same = { by: "day", group: "오늘", proj: 7 };
      ok(withGroupBy(same, "day") === same, "S6 같은 기준을 다시 고르면 그대로");
      eq(settleScope({ by: "owner", group: "gone", proj: 7 }, cards), { by: "owner", group: null, proj: null }, "S7 고른 카드가 사라지면 전체로");
      eq(settleScope({ by: "owner", group: "u2", proj: 8 }, cards), { by: "owner", group: "u2", proj: null }, "S8 고른 줄이 그 카드에 없으면 줄만 푼다");
      const keep = { by: "owner", group: "me", proj: 0 };
      ok(settleScope(keep, cards) === keep, "S9 경계 — 줄 0(프로젝트 없음)은 값이다. 카드에 있으면 그대로");
      eq(settleScope({ by: "none", group: null, proj: 99 }, [], projectLines(sc1)), { by: "none", group: null, proj: null }, "S10 묶지 않음 — 고른 프로젝트 줄이 없으면 푼다");
      //  ── 첫 화면 맞춤(원준 2026-09-25 «첫 화면은 스크롤 없이») — 카드 순서 O · 접기 P · 글 H ──
      const { planSideCards, hiddenCardsLabel } = lib;
      ok(typeof planSideCards === "function" && typeof hiddenCardsLabel === "function", "P0 접기 잣대가 잎 모듈에 있다");
      const st = [R("w", { stateKey: "waiting", lastSeen: at(2) }), R("b", { stateKey: "busy", lastSeen: at(0, 14) }), R("i", { stateKey: "idle", lastSeen: at(0, 9) })];
      eq(sideCards(st, "state", NOW, rank).map((c) => c.key), ["busy", "idle", "waiting"], "O1 ★상태별 카드도 최근 활동 순(순위 순이 아니다)");
      eq(sideCards(days, "day", NOW, rank).map((c) => c.key), ["오늘", "어제", "이번 주", "이전"], "O2 시간별은 최근 순이 곧 오늘 → 이전");
      const tie = [R("b1", { listId: 4, lastSeen: at(0, 10) }), R("a1", { listId: 5, lastSeen: at(0, 10) }), R("a2", { listId: 5, lastSeen: at(0, 9) })];
      eq(sideCards(tie, "list", NOW, rank).map((c) => c.key), ["5", "4"], "O3 경계 — 최근 활동이 같으면 세션 많은 카드 먼저(그다음 key 순)");
      if (typeof planSideCards === "function") {
        const K = ["a", "b", "c", "d", "e"];
        eq(planSideCards(K, 3, null, false), { shown: ["a", "b", "c"], hidden: 2 }, "P1 들어가는 만큼(3장)만, 나머지 2장은 접는다");
        eq(planSideCards(K, 3, "e", false), { shown: ["a", "b", "e"], hidden: 2 }, "P2 ★고른 카드가 접힐 자리면 마지막 자리를 내준다(순서 유지)");
        eq(planSideCards(K, 3, "b", false), { shown: ["a", "b", "c"], hidden: 2 }, "P3 고른 카드가 이미 보이면 그대로");
        eq(planSideCards(K, 3, null, true), { shown: K, hidden: 0 }, "P4 펼쳤으면 전부");
        eq(planSideCards(K, 5, null, false), { shown: K, hidden: 0 }, "P5 경계 — 다 들어가면(fit = 장수) 접는 줄이 없다");
        eq(planSideCards(K, 9, null, false), { shown: K, hidden: 0 }, "P5b fit 이 장수보다 커도 전부");
        eq([planSideCards([], 3, null, false), planSideCards(null, 3, null, false)], [{ shown: [], hidden: 0 }, { shown: [], hidden: 0 }], "P6 카드가 없으면 빈 계획");
        eq([planSideCards(K, 0, null, false), planSideCards(K, 0, "d", false)], [{ shown: ["a"], hidden: 4 }, { shown: ["d"], hidden: 4 }], "P7 경계 — fit 0 이어도 한 장(고른 카드가 있으면 그 카드)");
        eq(planSideCards(K, 1, "zzz", false), { shown: ["a"], hidden: 4 }, "P8 고른 카드 key 가 목록에 없으면 무시");
        eq([hiddenCardsLabel("list", 9), hiddenCardsLabel("owner", 2), hiddenCardsLabel("state", 3), hiddenCardsLabel("day", 1)],
          ["리스트 9개 더", "사람 2명 더", "상태 3개 더", "날짜 1개 더"], "H1 접는 줄 글 — 사람은 «명», 그 밖은 «개»");
      }
    }
    eq(pickNowCards([R("oldIdle", { stateKey: "idle", lastSeen: NOW - 24 * 3600_000 }), R("newIdle", { stateKey: "idle", lastSeen: NOW - 24 * 3600_000 + 60_000 }),
      R("oldWait", { stateKey: "waiting", lastSeen: at(10) })], rank, 4, NOW).map((r) => r.id), ["oldWait", "newIdle"],
      "C4 경계 — 대기 중은 24시간 안 활동만(정확히 24시간 전은 빠진다), 확인 필요는 오래돼도 선다");
  }
}
{
  //  U — 이름 없는 세션 판정은 sessText 한 자리다(목록이 접는 줄 · 카드 · 피크가 같은 값을 쓴다).
  const st = code(cut(SIDE, "export function sessText(", "\n}"));
  ok(/return \{ main: last \|\| String\(\(s\.raw && s\.raw\.harness\) \|\| ''\) \|\| '이름 없는 세션', sub: '', named: !!last, untitled: !last \};/.test(st),
    "U1 이름 · 작업 제목 · 대화 제목이 다 없어 하네스 이름 · «이름 없는 세션»으로 떨어지면 untitled");
  ok(/if \(name && job\) return \{[^}]*untitled: false \};/.test(st) && /if \(name \|\| job\) return \{[^}]*untitled: false \};/.test(st),
    "U2 이름이나 작업 · 대화 제목이 있으면 untitled 가 아니다");
}
{
  //  W1 — 배선: 목록 · 피크 · 셸.
  const all2 = code(cut(BINS, "export function renderSessAll("));
  ok(/const sc = sessScope\(\);/.test(all2) && /const mby = mainGroupBy\(sc\);/.test(all2) && /groupAllSess\(vis, mby, now, stateRank\)/.test(all2)
    && /group: sc\.group !== null \? \{ by: sc\.by, key: sc\.group \} : null/.test(all2),
    "W1a ★본문은 사이드바가 고른 기준 · 카드로 거르고 묶는다(mainGroupBy)");
  ok(/chip\('waiting', '확인 필요'/.test(all2) && /chip\('busy', '작업 중'/.test(all2) && /state: ui\.state/.test(all2), "W1b 상태 칩이 상태 거르개를 건다");
  ok(/pickNowCards\(inProj, stateRank, 4, now\)/.test(all2) && /'지금 볼 것'/.test(all2), "W1c 「지금 볼 것」 카드 줄");
  ok(/const unnamed = g\.rows\.filter\(\(it\) => it\.untitled\)/.test(all2) && /이름 없는 세션 \$\{unnamed\.length\}개/.test(all2), "W1d 이름 없는 세션은 묶음마다 한 줄로 접힌다");
  ok(/row\.addEventListener\('click'[^\n]*openPeek\(s\.id\)/.test(all2) && /row\.addEventListener\('dblclick'[^\n]*open\(s\)/.test(all2),
    "W1e ★행 클릭은 사이드 피크, 두 번 클릭은 홈에서 열기(hooks.onOpen)");
  ok(/\/api\/ui\/terminal\/sessions\/\$\{encodeURIComponent\(s\.id\)\}\/prompt/.test(all2) && /if \(!live\) \{ rememberUnsentDraft\(s\.id, text\);[^\n]*hooks\.onOpen\(s\); return; \}/.test(all2),
    "W1f 피크 보내기 — 도는 세션은 세션 화면과 같은 /prompt, 끝난 세션은 글을 세션 화면 입력칸으로 넘기고 연다");
  ok(/fetchTurns\(s, PEEK_TAIL\)/.test(all2) && /onclick: \(\) => hooks\.onOpen\(s\) \}, svgI\(IC_OPEN\), el\('span', \{ text: '세션 열기' \}\)/.test(all2),
    "W1g 피크는 대화 꼬리(sess-tail)를 읽고, [세션 열기]는 홈의 문(hooks.onOpen)으로 간다");
  const paint2 = code(cut(MAIN, "function paintSessAll(", "\nfunction repaintSessAll"));
  ok(/onNew: \(\) => \{ tabsApi\?\.add\('#\/'\); \}/.test(paint2) && /onNewTask: \(\) => \{ tabsApi\?\.add\('#\/'\); \}/.test(MAIN),
    "W1h [＋ 새 세션]은 사이드바 ＋ 와 같은 동작(홈 새 탭)");
  //  W2 — 격리 리뷰 지적(막음 2건): 두 번 보내기 · 목록에 없는 세션에서 ↑ ↓.
  const sendFn = cut(all2, "const send = async", "\n  };");
  const beforeAwait = sendFn.split("await api(")[0] || "";
  ok(/if \(!text \|\| !canSend \|\| peekSending\.has\(s\.id\)\) return;/.test(sendFn) && /peekSending\.add\(s\.id\)/.test(beforeAwait)
    && /ta\.value = '';/.test(beforeAwait) && /sendBtn\.disabled = true;/.test(beforeAwait) && /finally \{\s*peekSending\.delete\(s\.id\);/.test(sendFn),
    "W2a ★보내는 중에는 다시 보내지 않는다 — 칸을 비우고 버튼을 끈 뒤에 보내고, 끝나면 푼다");
  ok(/ui\.drafts\.set\(s\.id, text\);\s*toast\(`보내지 못했어요/.test(sendFn), "W2b 보내기에 실패하면 쓴 글을 돌려준다");
  const stepFn = cut(all2, "const step = (d: number): void => {", "\n  };");
  const keysFn = cut(all2, "function bindPeekKeys(): void {");
  ok(/const i = order\.indexOf\(s\.id\);\s*if \(i < 0\) return;/.test(stepFn) && /const i = nav\.order\.indexOf\(allUi\.peek\);\s*if \(i < 0\) return;/.test(keysFn),
    "W2c ★피크한 세션이 목록에 없으면(접힌 묶음 · 카드) ↑ ↓ 는 아무 데로도 가지 않는다 — 첫 행으로 건너뛰지 않는다");
  //  W3 — 묶지 않음(원준 2026-09-25 «안묶은 완전 raw 한 전체보기도 · 드롭다운으로 오른쪽에서»).
  ok(/SESS_GROUP_BYS\.filter\(\(b\) => b\.key !== 'none'\)\.map\(row\),\s*\{ label: '', sep: true \},\s*\.\.\.SESS_GROUP_BYS\.filter\(\(b\) => b\.key === 'none'\)\.map\(row\)/.test(rs)
    && /run: \(\) => pick\(withGroupBy\(sessScope\(\), b\.key\), true\)/.test(rs),
    "W3a ★묶기 드롭다운은 사이드바 머리에 있다(시간별 · 리스트별 · 사람별 · 상태별, 구분선 아래 묶지 않음)");
  ok(!/SESS_GROUP_BYS\.filter/.test(all2) && !/'data-pick': 'by'/.test(all2) && !/showCtxMenu\([^\n]*title: '묶기'/.test(all2),
    "W3c ★본문 도구줄에는 묶기 단추가 없다(2안 — 기준은 사이드바 한 곳)");
  const flat = cut(all2, "if (mby === 'none' && vis.length) {", "\n  for (const g of");
  ok(flat.includes("for (const it of vis) { if (budget-- <= 0) break; list.append(rowOf(it)); }") && !/untitled|v2-sa-fold/.test(flat)
    && /for \(const g of mby === 'none' \? \[\] : groupAllSess\(vis, mby, now, stateRank\)\)/.test(all2),
    "W3b ★묶지 않음이면 묶음 머리 없이 전부 최근 순, 이름 없는 세션도 접지 않는다");
  ok(/el\('span', \{ class: 'crumb k', 'data-by': sc\.by, text: byLabel \}\)/.test(all2) && /crumbs\.length \? crumbs\[crumbs\.length - 1\] : '전체'/.test(all2),
    "W4a 빵부스러기는 «AI 세션 / 기준 / 고른 것», 안 골랐으면 «전체»");
  ok(/secHead\('AI 세션', total \|\| null, byBtn,/.test(rs) && /fitSessCards\(listEl, plans\.length,/.test(rs)
    && /class: 'v2-ksp v2-pcard v2-scard open'/.test(rs) && /v2-pg-past/.test(rs),
    "W4b 사이드바는 위키 사이드바 3판 부품(.v2-ksp 카드 · 「N개 더」 · 줄 나누기 fitWikiList), 드롭다운은 머리의 ＋ 앞");
  ok(/fitSessCards\(listEl, plans\.length, \(fit\) => \{/.test(rs) && /const planFor = \(fit: number\) => planSideCards\(plans\.map\(\(x\) => x\.key\), fit, sc\.by === 'none' \? null : sc\.group,/.test(rs)
    && /foldRow\(hidden\)/.test(rs) && /hiddenCardsLabel\(sc\.by, hidden\)/.test(rs) && /sessCardsOpen\.has\(sc\.by\)/.test(rs),
    "W5a ★카드는 들어가는 만큼(fitSessCards · planSideCards), 나머지는 «리스트 N개 더» 한 줄 · 누르면 펼침/접기");
  ok(/run: \(\) => pick\(withGroupBy\(sessScope\(\), b\.key\), true\) \}\);/.test(rs) && /hooks\.onSessProject\?\.\(\{ keepDrawer \}\)/.test(rs)
    && /if \(!opts\?\.keepDrawer\) mobile\?\.closeAll\(\);/.test(MAIN),
    "W5c 폰: 묶기 기준을 바꾸면 서랍을 열어 둔다(카드 · 줄을 고를 때만 닫는다)");
  const fitFn = cut(SIDE, "function fitSessCards(", "\n}\n");
  ok(/if \(listNaturalHeight\(listEl\) <= H\) break;/.test(fitFn) && /budget: 0/.test(fitFn) && /fitWikiList\(listEl, p\.order, p\.sizes, p\.forced, p\.build\)/.test(fitFn),
    "W5b 장수는 최소 줄 수로 그려 넘치지 않는 가장 큰 값, 그 뒤 줄 나누기는 위키와 같은 fitWikiList");
  const ICONS_SRC = read("web/v2/icons.ts");
  const usedIc = [...(rs.match(/sc\.by === 'day' \? '([a-z]+)' : sc\.by === 'owner' \? '([a-z]+)' : '([a-z]+)'/) || []).slice(1)];
  ok(usedIc.length === 3 && usedIc.every((n) => new RegExp("\\n  " + n + ": '").test(ICONS_SRC)),
    "W4c 카드 머리 아이콘(시간 · 사람 · 그 밖)이 전부 ICONS 에 있다 — 없는 이름은 격자 아이콘으로 조용히 떨어진다(리뷰 지적)");
  const CSS = read("public/styles/47-v2-rail.css");
  ok(/\.v2-sa-peek \{[^}]*position: absolute;[^}]*width: min\(640px, 100%\)/.test(CSS) && /\.v2-sa-row \{ height: 46px;/.test(CSS),
    "W1i 사이드 피크 640px · 행 46px(위키 2판과 같은 치수)");
}
console.log(`\n#4158 [AI 세션] 프로젝트 리스트 · 전체 목록: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
