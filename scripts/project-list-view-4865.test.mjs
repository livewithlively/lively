// #4865 — 프로젝트 탭 첫 진입이 느리던 것 + 「리스트」 뷰 신설(원준 2026-10-17).
//
//  원문: «프로젝트 탭에 처음 들어갔을 때 "프로젝트를 불러오는 중"이 너무 오래 걸린다. 세션 목록은 바로 된다.»
//   «지금 리스트 뷰를 태스크 뷰로 바꾸고 체크에 동그라미 아이콘을 하나 더 넣어 [리스트] [태스크] [보드] 로.
//    리스트 뷰를 새로 신설 — 세션 목록과 같은 내용 · 형식이되 화면은 프로젝트 화면과 통일성 있게. 디폴트를 리스트뷰로.»
//  실측(2026-10-17, 매니지드 1,299건): GET /v6/projects 5.2MB 중 본문(description) 4.26MB(82%), 압축 없음 ·
//   GET /v6/projects?mine=1 1.5MB · 0.6초(서버가 tmux 목록까지 훑는다). 보드는 둘 다 기다린 뒤에야 그렸다.
//
//  V — 잣대(web/lib/board-view.ts)와 REST 어댑터(slim)를 값으로 — 사양 엣지 표 한 행 = 시나리오 하나.
//  S — 보드 · 뷰 탭이 그 잣대와 결정을 실제로 지나는지 소스로(주석 제외).
//  ⚠ 단언을 하나씩 끝까지 센다(첫 실패에서 멈추지 않는다).
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };
//  주석은 빼고 본다 — 머리말에 적힌 낱말이 단언을 통과시키면 그 시험은 아무것도 안 잡는다.
const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const cut = (src, from, to) => { const a = src.indexOf(from); if (a < 0) return ""; const b = to ? src.indexOf(to, a + 1) : -1; return src.slice(a, b > a ? b : undefined); };

let pass = 0; const fails = [];
const ok = (cond, name) => { if (cond) pass++; else fails.push(name); };
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), `${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── V: 잣대 ────────────────────────────────────────────────────────────────
let lib = null;
try { lib = await import(pathToFileURL(join(root, "public/app/lib/board-view.js")).href); } catch { /* 없으면 V0 가 빨간불 */ }
ok(!!lib, "V0 public/app/lib/board-view.js 가 있다(npm run build 뒤에 돌린다)");
if (lib) {
  const { viewOpensSessions: open, isMyProject: mine, countMyLiveSessions: count, migrateStoredView: migrate } = lib;
  // 기억된 뷰 → 리스트(세션)로 여나
  eq(open(null), true, "V1 기억 없음 → 리스트");
  eq(open(undefined), true, "V1b 기억 undefined → 리스트");
  eq(open({ sessions: true }), true, "V2 새 형식 리스트");
  eq(open({ sessions: false, byStatus: true }), false, "V3 새 형식 태스크를 고름 → 태스크 그대로");
  eq(open({ byStatus: true, kanban: false, table: false, timeline: false, overview: false, savedViewId: null }), true, "V4 옛 리스트 → 새 리스트");
  eq(open({ byStatus: true }), true, "V4b 옛 리스트(키 일부만) → 새 리스트");
  eq(open({ kanban: true }), false, "V5 옛 칸반 → 그대로");
  eq(open({ table: true }), false, "V6 옛 테이블 → 그대로");
  eq(open({ timeline: true }), false, "V7 옛 타임라인 → 그대로");
  eq(open({ overview: true }), false, "V8 옛 개요 → 그대로");
  eq(open({ savedViewId: 7 }), false, "V9 옛 저장된 뷰 → 그대로");
  eq(open({ savedViewId: 0 }), false, "V9b 저장된 뷰 id 0 도 저장된 뷰");
  eq(open({ sessions: false }), false, "V10 새 형식 false 는 다른 플래그 없어도 태스크");
  eq(open({ sessions: true, kanban: true }), true, "V11 새 형식 값이 옛 플래그를 이긴다");
  // 저장소에서 읽을 때만 옮긴다 — 옛 기억은 sessions 를 채우고, 새 형식은 그대로, 없던 기억은 null
  eq(migrate(null), null, "V11b 없던 기억 → null(기본 뷰는 부르는 쪽이 정한다)");
  eq(migrate({ byStatus: true }).sessions, true, "V11c 옛 리스트 기억 → sessions:true");
  eq(migrate({ kanban: true }).sessions, false, "V11d 옛 칸반 기억 → sessions:false");
  eq(migrate({ sessions: false, kanban: false }).sessions, false, "V11e 새 형식은 그대로");
  eq(migrate({ kanban: true, savedViewId: 3 }).savedViewId, 3, "V11f 다른 값은 보존");
  // 내 할당
  eq(mine({ created_by: "wonjoon", members: [] }, "wonjoon"), true, "V12 내가 만듦");
  eq(mine({ created_by: "yoon", members: [{ member_id: "wonjoon" }] }, "wonjoon"), true, "V13 팀원(객체)");
  eq(mine({ created_by: "yoon", members: ["wonjoon"] }, "wonjoon"), true, "V14 팀원(문자열)");
  eq(mine({ created_by: "yoon", members: [{ member_id: "kim" }] }, "wonjoon"), false, "V15 남의 것");
  eq(mine({ created_by: "", members: [""] }, ""), false, "V16 내 id 를 모르면 아무것도 내 것이 아니다");
  eq(mine({ created_by: "wonjoon" }, "wonjoon"), true, "V17 members 없음 — 생성자 판정만");
  eq(mine({ created_by: "yoon" }, "wonjoon"), false, "V17b members 없음 · 남의 것");
  eq(mine(null, "wonjoon"), false, "V17c 프로젝트 없음");
  // 내 세션 수
  const S = (o) => ({ live: true, alive: true, owned: true, projectId: 5, ...o });
  eq([...count([S({})])], [[5, 1]], "V18 살아 있는 내 세션 하나");
  eq([...count([S({ owned: false })])], [], "V19 남의 세션은 안 센다");
  eq([...count([S({ live: false, alive: false })])], [], "V20 기록만 남은 세션은 안 센다");
  eq([...count([S({ alive: false })])], [], "V21 박스가 죽은 세션은 안 센다");
  eq([...count([S({ projectId: null }), S({ projectId: 0 })])], [], "V22 프로젝트 없는 세션은 안 센다");
  eq([...count([S({}), S({}), S({ projectId: 9 })])].sort(), [[5, 2], [9, 1]], "V23 프로젝트별로 센다");
  eq([...count([])], [], "V24 빈 목록");
  eq([...count(null)], [], "V24b null");
}

// ── V: REST 어댑터 slim ─────────────────────────────────────────────────────
const dist = join(root, "dist/capabilities/index.js");
if (existsSync(dist)) {
  const { restMounts } = await import(pathToFileURL(dist).href);
  const m = restMounts().find((x) => x.cap.name === "project_list_v6");
  ok(!!m, "V25 project_list_v6 REST 마운트가 있다");
  if (m) {
    eq(m.mount.parse({ query: { slim: "1" } }).slim, true, "V26 slim=1");
    eq(m.mount.parse({ query: { slim: "true" } }).slim, true, "V27 slim=true");
    eq(m.mount.parse({ query: {} }).slim, false, "V28 slim 없음 → 본문까지(기존 호출자 그대로)");
    eq(m.mount.parse({ query: { slim: "0" } }).slim, false, "V29 slim=0");
  }
} else fails.push("V25 dist/capabilities/index.js 없음 — npm run build 뒤에 돌린다");

// ── S: 서버 핸들러 · 보드 · 탭 · 상태가 위 잣대와 결정을 지난다 ─────────────────────
const listCap = cut(code(read("src/capabilities/projects-v6.ts")), "const projectListV6: Capability", "const SEARCH_LEVELS");
ok(/if \(input\.slim\)[^\n]*delete p\.description/.test(listCap), "S1 slim 이면 서버가 본문을 뺀다");
const entry = cut(code(read("web/projects/board.ts")), "async function renderProjectV2Board", "function pjvProjectListBoard");
ok(entry.includes("'/api/ui/v6/projects?slim=1'"), "S2 보드는 본문 없이(slim=1) 받는다");
ok(!/projects\?mine=1/.test(entry), "S3 보드는 mine=1 을 따로 받지 않는다");
ok(/isMyProject\(p, meId\)/.test(entry) && /pjvMySessionCounts\(\)/.test(entry), "S4 내 할당 · 내 세션 수는 잣대로 잰다");
ok(/const boardP = api\('\/api\/ui\/v6\/board-fields'\)/.test(entry) && !/await api\('\/api\/ui\/v6\/board-fields'\)/.test(entry), "S5 보드 컬럼은 묶음과 함께 출발한다");
const tabs = cut(code(read("web/projects/filters.ts")), "const PJV_VIEW_TABS", "];");
eq([...tabs.matchAll(/key: '(\w+)', label: '([^']+)'/g)].map((x) => x[1] + ":" + x[2]),
  ["list:리스트", "tasks:태스크", "board:보드", "table:테이블", "timeline:타임라인"], "S6 탭 순서");
const stateSrc = code(read("web/projects/state.ts"));
ok(/function pjvLoadScopeView[^\n]*migrateStoredView\(/.test(stateSrc), "S7 저장소에서 읽는 자리에서만 옛 기억을 옮긴다");
//  격리 리뷰 지적 ① — 코드가 직접 만든 뷰(저장된 뷰 메뉴 «리스트 묶음» = {overview:false,byStatus:false,kanban:false})가 세션 뷰로 새지 않는다.
ok(/pjvBoardView\.sessions = !v \? true : !!v\.sessions;/.test(cut(stateSrc, "function pjvApplyView", "pjvSavedView.id =")), "S7b pjvApplyView 는 받은 값 그대로(옛 기억 추정 없음)");
//  격리 리뷰 지적 ② — 사이드바를 닫은 채 «리스트로 나누기»: 기본 뷰로 되돌린 뒤 세션 뷰를 다시 끈다.
ok(/pjvExitAreaMode\(\);[^\n]*pjvBoardView\.sessions = false;/.test(cut(code(read("web/projects/filters.ts")), "function pjvBoardSettingsPopover", "mkMode('status'")), "S7c 리스트로 나누기는 기본 뷰 되돌림 뒤 세션 뷰를 끈다");
ok(/kind === 'tasks'/.test(cut(code(read("web/projects/icons.ts")), "function pjvTabIcon", "PJV_FIELD_ICON_PATHS")), "S8 태스크 탭 아이콘이 있다");

// ── S: 2판(2026-10-19 원준 «세션목록 앱 참고해서 제대로») — 표는 [세션 목록] 앱과 같은 함수 하나 ──
const slSrc = code(read("web/projects/session-list.ts"));
const binsSrc = code(read("web/v2/bins.ts"));
ok(/from '\.\.\/v2\/sess-table\.js'/.test(slSrc) && /sessTable\(\{/.test(slSrc), "S9 리스트 뷰는 v2/sess-table.ts 의 sessTable 로 그린다");
ok(/from '\.\/sess-table\.js'/.test(binsSrc) && /sessTable\(\{/.test(binsSrc), "S10 [세션 목록] 앱도 같은 sessTable 로 그린다");
ok(!/pjvProjStatusDot|statusDot/.test(slSrc) && !/pjv-tgroup-head/.test(slSrc), "S11 리스트 뷰 묶음 머리에 프로젝트 상태 동그라미가 없다");
ok(/sessFilterPicks\(/.test(slSrc) && /sessFilterPicks\(/.test(binsSrc), "S12 거르개 줄(기간 · 사람 · 상태)도 한 벌");
ok(/return 'day';/.test(cut(slSrc, "function loadGroupBy", "\n}")), "S13 리스트 뷰 기본 묶기 = 세션 목록과 같은 «시간»");

// ── S: 첫 진입 «불러오는 중» 줄이기(2026-10-19) — 지난 판 먼저, 새 판은 뒤에서 · 다시 받기는 보관함을 건너뛴다 · 로그아웃이 비운다 ──
const entry2 = code(cut(read("web/projects/board.ts"), "async function renderProjectV2Board", "function pjvProjectListBoard"));
const iCacheGet = entry2.indexOf("cacheGet<PjvBoardData>(cacheKey)"), iFetch = entry2.indexOf("api('/api/ui/v6/projects?slim=1')");
ok(iCacheGet > 0 && iFetch > iCacheGet && /paint\(c\.v\);/.test(entry2), "S14 보관함의 지난 판을 서버보다 먼저 그린다");
ok(/if \(keepY == null && !fresh && cacheKey\)/.test(entry2) && /const reload = \(\) => renderProjectV2Board\(view, undefined, true\);/.test(entry2), "S15 다시 받기 · 스크롤 지키는 재렌더는 보관함을 건너뛴다");
ok(/void cacheSet\(cacheKey, fresh_\)/.test(entry2) && /pjvSameBoardData\(shown, fresh_\)\) return;/.test(entry2), "S16 새 판을 보관하고, 지난 판과 같으면 다시 그리지 않는다");
ok(/if \(shown\) return;/.test(entry2), "S17 새 판을 못 받아도 서 있는 지난 판을 오류로 덮지 않는다");
ok(/await cacheClear\(\);/.test(cut(code(read("web/core.ts")), "async function logout", "export {")), "S18 로그아웃이 보관함을 비운다");
ok(/'projects-board:v1:' \+ \(currentWorkspace\(\) \|\| '-'\) \+ ':' \+ meId/.test(entry2 + code(read("web/projects/board.ts"))), "S19 보관함 열쇠는 사람 · 워크스페이스로 가른다");

console.log(`project-list-view-4865: ${pass} pass, ${fails.length} fail`);
if (fails.length) { for (const f of fails) console.error("  ✗ " + f); process.exit(1); }
