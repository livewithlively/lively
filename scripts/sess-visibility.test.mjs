// 세션 행의 «보임 축» (#3855 · #3857, 상민님 신고 2026-09-10) — 값과 배선으로 고정한다.
//  사양·엣지 표(S1~S10 · M1~M8 · R6)는 스크래치패드 workerA-spec.md — 아래 이름의 번호가 그 행이다.
//  서버 저장(D·R1~R5)은 실DB 가 아니면 못 보므로 src/org/store/app-instance-dismiss.pg-test.mjs 가 맡는다.
//
//  무엇이 문제였나:
//   · 어젯밤 세션이 아침에 사라졌다 — 사람이 안 닫은 사실(org_app_instance active)이 서버에 있는데 목록이
//     세션 인스턴스를 건너뛰고 «살아 있거나 오늘 것» 으로만 세웠다. 회수(idle 2시간)+자정 = 전량 컷(실측 165건).
//   · 치운 세션이 저절로 되살아났다 — × 가 «치울 때의 상태» 를 브라우저 맵에 적고 그 상태인 동안만 숨겼다.
//   · 같은 × 가 [AI 세션] 구역에선 박스를 내리는 회수였다(파괴력이 다른 두 뜻).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };
//  ⚠ «없어야 할 것» 은 **코드에서만** 센다 — 걷어낸 이름을 «왜 걷었나» 주석으로 인용하는 것은 좋은 주석이고,
//   그걸 세면 거짓 빨강이 난다(지식 change-request-deploy-set-dev-main-managed «주석 잔류는 구조다»).
//   줄 주석(//…)과 블록 주석(/* */)을 떼어 낸 본문을 쓴다. 문자열 속 '//'(URL) 뒤가 잘려도 «없음» 판정을 느슨하게 할 뿐이다.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => { const i = l.indexOf("//"); return i >= 0 ? l.slice(0, i) : l; }).join("\n");

const { sessRowVerdict, verdictStands, keptSessionRefs, planDismissMigration, withoutSessionKeys } =
  await import(join(root, "public/app/v2/sess-visibility.js"));

const DAY = 1_800_000_000_000;           // '오늘 일감' 시작(ms) — 고정
const H = 3_600_000;
const none = () => new Set();
const V = (o) => sessRowVerdict({ ids: ["box-a"], live: false, lastSeen: 0, dayStart: DAY, kept: none(), dismissed: none(), ...o });
const stands = (o) => verdictStands(V(o));

// ── S — 행 판정 ────────────────────────────────────────────────────────────────
ok(stands({ live: false, lastSeen: DAY - 20 * H, kept: new Set(["box-a"]) }),
  "S1 회수돼 멈춘 세션도 내가 목록에 뒀으면 선다 — 아침에 사라지던 그 세션");
ok(stands({ live: false, lastSeen: DAY - 2, kept: new Set(["box-a"]) }),
  "S2 어제 것이어도 목록에 뒀으면 선다(날짜 컷은 목록에 둔 세션에 안 걸린다)");
ok(!stands({ live: true, lastSeen: DAY + H, dismissed: new Set(["box-a"]) }),
  "S3 치운 세션은 그 뒤 작업 완료로 바뀌어도(도는 중) 안 선다 — 상태가 판정에 안 낀다");
ok(V({ live: true, lastSeen: DAY + H, dismissed: new Set(["box-a"]) }) === "dismissed",
  "S4 치움은 «도는 중 · 오늘» 이라는 종전 규칙보다 먼저다");
ok(stands({ ids: ["box-new", "uuid-1", "box-old"], kept: new Set(["box-old"]) }),
  "S5 목록에 둠이 옛 이름(altIds)에만 있어도 같은 세션이라 선다");
ok(V({ ids: ["box-new", "box-old"], kept: new Set(["box-new"]), dismissed: new Set(["box-old"]) }) === "kept",
  "S6 옛 id 에 치움, 새 id 에 목록에 둠(사람이 다시 열었다) — 더 나중의 결정인 목록에 둠이 이긴다");
ok(V({ live: true }) === "live",
  "S7 기록이 없는(화면에서 한 번도 안 연) 도는 세션은 종전대로 선다");
ok(V({ ids: ["box-restored"], live: true, kept: new Set(["box-old"]) }) === "live",
  "R6 복원에서 새 id 인스턴스 등록이 실패해 행이 없어도 — 도는 중이면 종전 규칙으로 선다");
ok(V({ lastSeen: DAY }) === "today",
  "S8 경계 — 오늘 시작 시각과 정확히 같은 활동은 오늘 것이다(>=)");
ok(V({ lastSeen: DAY - 1 }) === "cut",
  "S9 경계 — 1ms 전은 어제 것이라 기록 없는 멈춘 세션은 안 선다");
{
  const kept = keptSessionRefs([
    { status: "active", subject_kind: "session", subject_ref: "box-gone", subject_state: "gone" },
    { status: "active", subject_kind: "session", subject_ref: "box-live", subject_state: "known" },
    { status: "closed", subject_kind: "session", subject_ref: "box-closed", subject_state: "known" },
    { status: "active", subject_kind: "singleton", subject_ref: "inbox" },
    { status: "active", subject_kind: "session", subject_ref: null },
  ]);
  ok(!kept.has("box-gone") && V({ ids: ["box-gone"], kept }) === "cut",
    "S10 서버가 gone 이라 한 인스턴스는 «목록에 둠» 으로 치지 않는다 — 되살릴 수 없는 유령 행을 세우지 않는다");
  ok(kept.has("box-live") && !kept.has("box-closed") && !kept.has("inbox") && kept.size === 1,
    "S10′ 목록에 둠 = active 인 세션 인스턴스뿐(closed·세션 아닌 것·ref 없는 것 제외)");
}

// ── M — 옛 치움 맵 옮기기 ──────────────────────────────────────────────────────
{
  const current = new Map([["box-a", "box-a"], ["box-old", "box-new"], ["uuid-1", "box-new"]]);
  const resolve = (id) => current.get(id) ?? null;
  const map = {
    "route:home": "",
    "sess:box-a": "",
    "sess:box-old": "done",
    "sess:uuid-1": "",
    "sess:box-gone": "",
    "sess:box-x](https:": "",
    "inst:ea0934e6-0fad-4f6a-90fc-065005ef01b2": "",
    "route:raw:activate?code=CQTM-MWXK": "",
  };
  const plan = planDismissMigration(map, resolve);
  ok(plan.sessionIds.includes("box-a") && !("sess:box-a" in plan.nextMap),
    "M1 지금 세션을 가리키는 키는 옮길 목록에 들고 맵에서 빠진다");
  ok(plan.sessionIds.includes("box-new") && !plan.sessionIds.includes("box-old"),
    "M2 옛 id 는 지금 id 로 풀어 옮긴다 — 치운 사실은 세션의 것이지 옛 이름의 것이 아니다");
  ok(plan.dropped.includes("sess:box-gone") && !plan.sessionIds.includes("box-gone") && !("sess:box-gone" in plan.nextMap),
    "M3 지금 없는 세션은 옮기지 않고 버린다");
  ok(plan.dropped.includes("sess:box-x](https:") && !Object.keys(plan.nextMap).some((k) => k.includes("](")),
    "M4 깨진 키(마크다운 링크 조각)는 옮기지 않고 버린다");
  ok(plan.nextMap["route:home"] === "" && "inst:ea0934e6-0fad-4f6a-90fc-065005ef01b2" in plan.nextMap && "route:raw:activate?code=CQTM-MWXK" in plan.nextMap,
    "M5 세션 아닌 행(route:/inst:)의 치움은 그대로 남는다 — 이번 범위 밖");
  const again = planDismissMigration(plan.nextMap, resolve);
  ok(again.sessionIds.length === 0 && again.dropped.length === 0 && JSON.stringify(again.nextMap) === JSON.stringify(plan.nextMap),
    "M6 옮긴 결과로 다시 돌면 옮길 것 0 · 맵 불변(멱등)");
  ok(plan.sessionIds.filter((x) => x === "box-new").length === 1 && plan.sessionIds.length === 2,
    "M7 같은 세션을 가리키는 키 둘(옛 id · 대화 uuid)은 한 번만 옮긴다");
  const e1 = planDismissMigration({}, resolve), e2 = planDismissMigration(null, resolve), e3 = planDismissMigration(["sess:box-a"], resolve);
  ok([e1, e2, e3].every((p) => p.sessionIds.length === 0 && p.dropped.length === 0 && Object.keys(p.nextMap).length === 0),
    "M8 빈 맵·맵 아닌 값은 빈 계획");
  ok(JSON.stringify(withoutSessionKeys({ "sess:a": "", "route:b": "x" })) === JSON.stringify({ "route:b": "x" }),
    "M9 옮긴 뒤의 저장은 세션 키를 싣지 않는다(옛 페이지가 되올린 키가 다시 서버에 쌓이지 않게)");
}

// ── W — 화면·서버가 실제로 이 규칙을 지난다 ────────────────────────────────────
{
  const MAIN = read("web/v2/main.ts");
  const SIDE = read("web/v2/side.ts");
  const BINS = read("web/v2/bins.ts");
  const ROUTES = read("src/terminal/routes.ts");
  const INST = read("web/v2/app-instance.ts");
  const side = MAIN.slice(MAIN.indexOf("function sideInstances(): SideInstance[] {"), MAIN.indexOf("async function closeSideRow(key: string)"));
  ok(/verdictStands\(sessRowVerdict\(\{ ids: \[s\.id, s\.logId \|\| '', \.\.\.\(s\.altIds \|\| \[\]\)\]/.test(side)
    && !/if \(!liveNow && \(s\.lastSeen \|\| 0\) < workDayStart\(now\)\) continue;/.test(side),
    "W1 ① 이 날짜 컷 대신 보임 축 판정을 쓴다 — 세션의 모든 이름으로");
  ok(/!key\.startsWith\('sess:'\) && dismissed\[key\] !== undefined && dismissed\[key\] === basis/.test(side),
    "W2 세션 행은 «치울 때 상태» 맵을 안 본다 — 그 맵이 치운 세션을 되살리던 뿌리");
  const close = MAIN.slice(MAIN.indexOf("async function closeSideRow(key: string)"), MAIN.indexOf("function refreshSideNow(): void {"));
  ok(/if \(key\.startsWith\('sess:'\)\) \{ await dismissSessionRow\(key\); return; \}/.test(close) && /await dismissSessions\(ids\)/.test(close),
    "W3 세션 행의 × 는 서버 정본(치움)으로 간다 — 맵에 적지 않는다");
  //  W4 는 **세션 × 의 자리들**만 본다 — 프로젝트 아카이브·정리 모드는 확인창이 «도는 세션을 멈춘다» 고 말하는
  //   별개의 명시적 동작이라 이 규칙(× = 치움)의 범위가 아니다(그 둘을 어떻게 할지는 사람 결정으로 남겼다).
  const asInst = SIDE.slice(SIDE.indexOf("function sessAsInst("), SIDE.indexOf("function renderSessions("));
  const ctxRows = SIDE.slice(SIDE.indexOf("export function sessionCtxRows("), SIDE.indexOf("export function projectCtxRows("));
  ok(asInst.length > 0 && ctxRows.length > 0
    && !/doArchive|reclaim=1/.test(code(asInst)) && /hooks\.onCloseInstance\?\.\('sess:' \+ s\.id\)/.test(asInst)
    && !/doArchive|reclaim=1/.test(code(ctxRows)) && /label: '목록에서 치우기'/.test(ctxRows)
    && /isMine\(s\) \? dismissBtn\(s\)/.test(SIDE) && !/function (doArchive|archiveBtn)\(/.test(code(SIDE)),
    "W4 세션 × 의 자리([AI 세션] 행·프로젝트 트리 행·우클릭)는 전부 치움 — 사람이 누르는 × 가 박스를 내리지 않는다");
  const reg = ROUTES.indexOf("await registerSessionInstance(session.id, st.owner");
  const carry = ROUTES.indexOf("await carrySessionDismissals(id, session.id)");
  const shut = ROUTES.indexOf('await closeSessionAppInstances(id, "restore")');
  ok(reg > 0 && carry > reg && shut > carry,
    "W5 되살리기: 새 id 등록 → 치움 승계 → 옛 id 닫기 순서(승계가 옛 행을 판정 재료로 읽는다)");
  const calls = [...read("src/terminal/routes.ts").matchAll(/closeSessionAppInstances\(([^)]*)\)/g),
    ...read("src/sessions/session-trash-ops.ts").matchAll(/closeSessionAppInstances\(([^)]*)\)/g),
    ...read("src/apps/instance-janitor.ts").matchAll(/closeSessionAppInstances\(([^)]*)\)/g)].map((m) => m[1]);
  ok(calls.length >= 5 && calls.every((a) => /,\s*"(restore|kill|purge|janitor|system)"/.test(a)),
    "W6 시스템이 세션 인스턴스를 닫는 자리는 전부 사유를 적는다(user 가 아닌 것으로)");
  ok(/if \(sessDismissMigrated \|\| !sessTruthSeen\) return;/.test(MAIN),
    "W7 옛 맵 옮기기는 세션 목록을 받은 뒤에만 — 목록 없이 돌면 전부 «없는 세션» 으로 버려진다");
  ok(/if \(sessDismissMigrated\) dismissed = withoutSessionKeys\(dismissed\);/.test(MAIN),
    "W8 옮긴 뒤의 저장만 세션 키를 걸러낸다 — 옮기기 전에 걸러내면 옮길 것을 잃는다");
  ok(/if \(Array\.isArray\(out\?\.dismissed_sessions\)\) dismissedRefs =/.test(INST),
    "W9 치운 세션 id 는 성공한 판에서만 갈아 끼운다 — 실패 판에 빈 집합으로 덮으면 한 틱에 전부 되살아난다");
  ok(/dismissedSection\(data, hooks\)/.test(BINS),
    "W10 아카이브 화면에 「치운 세션」이 선다 — 치운 것을 보고 되돌릴 자리");

  //  W11 — 치움과 #3856 자물쇠(hold-rules.ts)의 맞물림. 「지금 볼 것」에 붙들린 세션을 치우면 그 행은 목록을 떠나고,
  //   목록 이탈은 곧 해제다(pruneHolds). 치운 행이 자물쇠를 들고 남으면 되돌렸을 때 옛 자리로 튀어 오른다.
  const { pruneHolds } = await import(join(root, "public/app/v2/hold-rules.js"));
  const holds = new Map([["sess:box-a", { group: "지금 볼 것", rank: 1 }], ["sess:box-b", { group: "지금 볼 것", rank: 2 }]]);
  const kept = new Set(["box-b"]), gone = new Set(["box-a"]);
  const present = new Set(["box-a", "box-b"]
    .filter((id) => verdictStands(sessRowVerdict({ ids: [id], live: true, lastSeen: DAY + H, dayStart: DAY, kept, dismissed: gone })))
    .map((id) => "sess:" + id));
  pruneHolds(holds, present);
  ok(!holds.has("sess:box-a") && holds.has("sess:box-b"),
    "W11 붙들려 있던 세션을 치우면 목록 이탈로 자물쇠가 풀린다 · 목록에 둔 세션의 자물쇠는 그대로");
  const cut = side.indexOf("if (!verdictStands(sessRowVerdict(");
  const prune = side.indexOf("pruneHolds(holds, rows);");
  ok(cut > 0 && prune > cut,
    "W11′ 배선 — 치운 세션을 거르는 줄이 자물쇠 정리(pruneHolds(holds, rows)) 앞에 있다(행에 안 들어가야 풀린다)");

  //  W12 — «치운 세션을 사람이 직접 열면 목록에 둠(active)» 은 **화면이 여는 경로가 서버 멱등 생성을 부른다**는 전제다
  //   (코디네이터 검토 보강 ②). 이게 비면 «열어서 쓰다가 탭을 닫으면 다시 사라지는» 회귀가 된다 — 탭이 열려 있는 동안엔
  //   ③(열린 창) 줄기가 행을 세워 줘서 **눈에 안 띄다가** 탭을 닫는 순간 드러난다. 세 입구가 모두 같은 자리를 지나야 한다.
  const route = MAIN.slice(MAIN.indexOf("} else if (page === 's' && segs[1]) {"), MAIN.indexOf("if (SOLO) {", MAIN.indexOf("} else if (page === 's' && segs[1]) {")));
  const ensureAt = route.indexOf("const instance = await ensureSessionAppInstance(appId, s?.id || id,");
  const guardZone = ensureAt > 0 ? route.slice(Math.max(0, ensureAt - 900), ensureAt) : "";
  ok(ensureAt > 0 && !/if \([^)]*(restorable|\.live|alive|observed)/.test(code(guardZone)),
    "W12 세션 화면 진입(#/s/…)은 조건 없이 서버 멱등 생성을 부른다 — 치운 세션도 열면 목록에 둠이 된다");
  const resumed = MAIN.slice(MAIN.indexOf("function resumedInTab(tab: ShellTab, sid: string)"), MAIN.indexOf("async function mountProjectShell("));
  ok(/tab\.route = href;/.test(resumed) && /void renderRoute\(tab\);/.test(resumed) && /onResumed: \(nid\) => resumedInTab\(tab, nid\)/.test(MAIN),
    "W12′ [이어서 대화하기]·자동 되살리기는 새 id 로 **라우트를 다시 돌린다**(resumedInTab → renderRoute) — 같은 생성 경로를 새 id 로 지난다");
  const PANES = read("web/v2/panes-parts.ts");
  const paneRestore = PANES.slice(PANES.indexOf("async function restore(s: Sess)"), PANES.indexOf("async function purge(s: Sess"));
  ok(/location\.hash = '#\/s\/' \+ encodeURIComponent\(String\(ns\.id\)\)/.test(paneRestore),
    "W12″ 프로젝트 셸 [되살리기]도 새 id 주소로 옮겨 가 같은 라우트(생성 경로)를 지난다");
}

console.log(`\n${pass} passed`);
