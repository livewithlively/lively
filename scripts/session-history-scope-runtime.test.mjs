#!/usr/bin/env node
// 「세션 이력」 앱(#4553 안 A) — 셸의 사이드바에서 고른 범위가 **실제 화면에서** 세 탭에 걸리나 — 런타임 회귀 테스트.
//
// 원준 2026-10-05 «A안으로 고고»(시안 `세션이력-사이드바-3안.html` 의 A): 사이드바는 셸 문서에, 앱은 액자 문서에 있다.
//  앱이 줄을 셸에 보내고(lively:hist-rows), 셸이 고른 범위를 돌려보낸다(lively:hist-scope). 규칙(어느 묶음 · 범위 안인가)은
//  hist-scope.test.mjs 가, 가로탭 셋의 종전 동작은 session-history-runtime.test.mjs 가 잰다. 여기서는 그 다리 위에서만 보이는 것을 잰다 —
//  «셸에 무엇을 보내나 · 범위가 탭마다 어떻게 걸리나 · 찾기 요청에 세션 id 가 실리나 · 안 보는 탭을 미리 조회하지 않나 · 셸 밖에서는 종전 그대로인가».
//
// 엣지 표(스크래치패드 spec-side.md R):
//  S1  셸 액자 안에서 열림 — 인사(줄 없는 신호)가 먼저 · 줄은 기록이 있는 것만(휴지통 · 빈 기록 · 박스만 있는 세션 · 남의 것 없음) ·
//      줄의 프로젝트는 기록의 것(박스에만 붙은 프로젝트는 «없음») · 빵부스러기 «세션 이력 N개»
//  S2  범위: 시간 묶음 — 「대화 찾기」가 그 묶음의 대화만 · 기간 고르개가 걷힌다 · 빵부스러기 «세션 이력 / 시간별 / 어제 N개»
//  S3  범위: 묶음 × 프로젝트 — 「세션 목록」이 그 줄만 · 칩의 수도 범위 안 · 빵부스러기에 프로젝트 이름 · 프로젝트 고르개가 걷힌다
//  S5  검색어 + 범위 — POST · 본문의 sessions = 범위 안 대화 id · 걷힌 고르개의 값은 안 실린다
//  S6  검색어 + 전체 — 종전 GET(sessions 없음)
//  S7  범위 안에 기록이 하나도 없다 + 검색어 — 요청을 내지 않고 까닭을 말한다
//  S8  「작업 일지」 + 시간 묶음 — 기간 고르개가 걷히고 · 그 묶음의 기록 시각을 덮는 구간으로 청하고 · 범위 안 세션만 · 범위 글 «어제 · M월 D일»
//  S9  「작업 일지」 + 시간이 아닌 범위(상태) — 기간 고르개는 남고 · 범위 안 세션만 · 비면 까닭을 말한다
//  S10 감춰 둔 탭 — 범위가 바뀌어도 조회하지 않는다(일지 · 검색어가 든 대화 찾기) · 볼 때 다시 그린다
//  S11 「전체」로 풀기 — 줄이 돌아오고 걷혔던 고르개가 다시 선다
//  S12 남긴 것별 — 범위 신호를 받으면 일지를 받아 줄을 다시 보낸다(kind 가 찬다) · «지식을 남긴 세션» = 그 세션만
//  S13 찾기 신호 — 「대화 찾기」 탭으로 가고 찾기 칸에 초점
//  S14 고른 줄이 범위 밖으로 — 오른쪽 칸이 비워진다
//  S16 남이 보낸 신호(오리진 · 창이 다름) · 모양이 틀린 범위 — 무시
//  S17 대화록 단독 화면(#/sessions/<sid>) — 사람이 사이드바에서 고르면 앱으로 돌아온다(그 화면에는 범위를 보일 자리가 없다) · 찾기 단추는 「대화 찾기」로
//  S18 그 화면에서 셸이 맞춰 주는 신호(사람이 누른 것이 아니다) — 범위만 맞추고 화면은 옮기지 않는다(막 연 대화록이 앱으로 튕기지 않는다)
//  S20 줄을 못 받는다(도는 세션 · 기록 둘 다 500) + 범위 — «범위에 아무것도 없다» 가 아니라 «못 받았다» 고 말하고 요청을 내지 않는다 · 셸에도 그렇게 알린다
//  S21 보이는 동안 1분마다 줄을 다시 받아 셸에 보낸다 · 화면이 가려져 있으면 받지 않는다 · 「세션 목록」도 새 줄로 맞춘다
//  S23 연달아 받을 때 늦게 끝난 옛 판이 새 판을 덮지 않는다
//  S22 한 축만 받은 판(도는 세션 실패) — 셸에 그렇다고 알린다(사이드바가 고른 것을 풀지 않게)
//  S19 «남긴 것» 묶음을 골랐는데 일지가 아직 없다 — 본문은 «없다» 가 아니라 «세는 중» 이라 말하고 수를 적지 않는다 · 일지를 못 받으면(500)
//      그렇다고 말하고 셸에 알리고 · 셸의 답에는 다시 청하지 않고 · 사람이 다시 고르면 다시 청한다
//  S15 셸 밖(단독 탭) — 빵부스러기 없음 · 줄을 안 보낸다 · 범위 신호를 받아도 그대로 · 「대화 찾기」는 도는 세션을 조회하지 않는다 · 검색은 GET ·
//      대화록 단독 화면에서도 다리가 없다(신호를 받아도 주소가 그대로)
//  W   통틀어 페이지 오류 0 · 배선(가짜 서버가 실제로 불렸고, 셸로 가는 신호가 실제로 잡혔다)
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(다리가 없던 origin/main 에서 S1~S14 가 빨갛다).
//  크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;

const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 세션 이력 범위 런타임 검증 미실행");
  process.exit(0);
}
const STYLES = path.join(SRC_ROOT, "public/styles");
const CSS = ["01-base.css", "03-components.css", "05-admin.css", "53-session-history.css"].map((f) => path.join(STYLES, f));
for (const f of CSS) if (!existsSync(f)) { console.error(`FAIL  스타일시트 없음: ${f}`); process.exit(1); }

const bundle = buildSync({
  stdin: { contents: "export { renderSessions } from './web/sessions-app.ts';", resolveDir: SRC_ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "APP", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;

async function PAGE_MAIN() {
  const IN_SHELL = window.__IN_SHELL__ === true;
  const R = { inShell: IN_SHELL };
  const pageErrors = [];
  window.addEventListener("error", (e) => pageErrors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => pageErrors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const waitFor = async (fn, ms = 6000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(15); } return false; };
  localStorage.setItem("lively_ui_token", "t");
  localStorage.removeItem("lively.sessions.tab");
  //  셸이 앱을 액자로 실을 때 붙이는 표(v2/apps.ts embedUrl) — 앱은 이 표로 «셸 액자 안» 을 안다. 모듈이 실리기 전에 붙여 둔다.
  if (IN_SHELL) history.replaceState(null, "", location.pathname + "?embed=1&shell=classic");

  // ── 가짜 서버 데이터 — «오늘» 것은 오늘 0시와 지금의 한가운데, «어제» 것은 어제 낮(자정 경계에서 흔들리지 않게) ──
  const NOW = Date.now(), D = 86_400_000;
  const T0 = new Date(NOW); T0.setHours(0, 0, 0, 0);
  const TODAY = Math.round((T0.getTime() + NOW) / 2);
  const EARLIER = Math.round((T0.getTime() + TODAY) / 2);
  const YD = new Date(T0); YD.setDate(YD.getDate() - 1); YD.setHours(12, 0, 0, 0);
  const YDAY = YD.getTime(), YDAY2 = YDAY - 3_600_000, OLD = NOW - 40 * D;
  const iso = (ms) => new Date(ms).toISOString();
  const logRow = (sid, name, last, o = {}) => ({ node_id: "", session_id: sid, harness: "claude", title: "첫 지시 " + name, name, owner: "me", owner_name: "원준", first_seen: iso(last - 3_600_000), last_seen: iso(last), bytes: o.bytes ?? 5000, project_id: o.pid ?? null, project_name: o.pname ?? null, trashed_at: o.trashed ? iso(NOW) : null });
  const LOGS = [
    logRow("c1", "검색 고치기", TODAY, { pid: 3870, pname: "통합검색" }),
    logRow("c2", "위젯 기획", EARLIER, { pid: 4135, pname: "UI 수정" }),
    logRow("c3", "덱 재시안", YDAY),                                           // 기록에는 프로젝트가 없다(박스에는 9001 이 붙어 있다)
    logRow("c4", "어제 검색 정리", YDAY2, { pid: 3870, pname: "통합검색" }),
    logRow("c5", "옛 조사", OLD, { pid: 3870, pname: "통합검색" }),
    logRow("c6", "휴지통 세션", TODAY, { trashed: true }),
    logRow("c7", "빈 세션", TODAY, { bytes: 0 }),
  ];
  const sec = (ms) => Math.floor(ms / 1000);
  const LIVE = [
    { id: "box-1", label: "검색 고치기", harness: "claude", owned: true, created: sec(TODAY - 3_600_000), lastActive: sec(TODAY), attached: true, agentState: "busy", working: true, claudeSessionId: "c1", projectId: 3870 },
    { id: "box-3", label: "덱 재시안", harness: "claude", owned: true, created: sec(YDAY - 3_600_000), lastActive: sec(YDAY), attached: false, agentState: "offline", restorable: true, claudeSessionId: "c3", projectId: 9001 },
    { id: "box-4", label: "어제 검색 정리", harness: "claude", owned: true, created: sec(YDAY2 - 3_600_000), lastActive: sec(YDAY2), attached: false, agentState: "offline", claudeSessionId: "c4", projectId: 3870 },
    { id: "box-5", label: "옛 조사", harness: "claude", owned: true, created: sec(OLD - 3_600_000), lastActive: sec(TODAY), lastViewed: sec(TODAY) + 1, attached: false, agentState: "offline", claudeSessionId: "c5", projectId: 3870 },   // 옛 대화를 오늘 열어 보기만 했다 — 기록은 40일 전 그대로
    { id: "box-9", label: "기록 없는 새 세션", harness: "claude", owned: true, created: sec(NOW), lastActive: sec(NOW), attached: true, agentState: "idle", lastViewed: sec(NOW) + 1 },
    { id: "box-x", label: "남의 세션 박스", harness: "claude", owned: false, created: sec(NOW), lastActive: sec(NOW), attached: true, agentState: "idle", lastViewed: sec(NOW) + 1, claudeSessionId: "cx" },
  ];
  const ITEMS = [{ role: "user", text: "검색을 고쳐 줘", ts: iso(OLD) }, { role: "assistant", text: "검색 배포를 마쳤습니다", ts: iso(OLD + 1000) }];
  const hit = (sid, name, ts, pname) => ({ node_id: "", session_id: sid, name, project: pname || null, project_id: pname ? 3870 : null, role: "user", ts: iso(ts), text: "검색을 고쳐 줘", terms: 1, before: null, after: null });
  const HITS = [hit("c1", "검색 고치기", TODAY, "통합검색"), hit("c3", "덱 재시안", YDAY, null), hit("c4", "어제 검색 정리", YDAY2, "통합검색"), hit("c5", "옛 조사", OLD, "통합검색")];
  const K1 = { name: "omni-asbuilt", title: "통합검색 as-built" };
  const act = (id, type, title) => ({ id, type, title, summary: null, at: iso(TODAY), commit: false, knowledge: [] });
  const jrow = (l, o = {}) => ({ node_id: "", session_id: l.session_id, name: l.name, title: l.title, harness: "claude", first_seen: l.first_seen, last_seen: l.last_seen, bytes: l.bytes, project_id: l.project_id, project_name: l.project_name, box_id: o.box || null, asks: 2, edits: 0, activities: o.acts || [], knowledge: o.kn || [], tasks: [], activities_before: 0 });
  const JOURNAL = [
    jrow(LOGS[0], { box: "box-1", acts: [act(1, "feature", "대화 검색 추가")], kn: [K1] }),   // 지식을 남겼다
    jrow(LOGS[1], { acts: [act(2, "docs", "위젯 기획안")] }),                                  // 작업 기록만
    jrow(LOGS[2], { box: "box-3" }),                                                          // 남긴 것 없음
    jrow(LOGS[3], { box: "box-4" }),
    jrow(LOGS[4], { acts: [act(3, "research", "옛 조사 정리")] }),
  ];
  let reqs = [];
  //  kinds: "hang" = 전 기간 일지(남긴 것을 세는 조회)를 붙들어 둔다(releaseKinds 로 500 을 낸다) · "500" = 곧바로 실패
  //  rows: "500" = 줄의 두 축(도는 세션 · 기록)이 다 실패 · "live500" = 도는 세션 축만 실패
  const MODE = { kinds: "ok", rows: "ok" };
  let releaseKinds = null;
  let liveHang = null;       // 도는 세션 조회 한 번을 붙들어 둘 약속(늦게 끝나는 옛 판 장면)
  //  1분 타이머는 잡아 두고 손으로 돌린다(가상 시간에 저절로 돌면 장면이 흔들린다). 화면이 보이나도 손으로 정한다.
  const TICKS = [];
  const realSetInterval = window.setInterval.bind(window);
  window.setInterval = (fn, ms, ...rest) => (ms === 60000 ? (TICKS.push(fn), -1) : realSetInterval(fn, ms, ...rest));
  let VISIBLE = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => VISIBLE });
  const bodies = [];         // POST 로 온 본문(읽은 것)
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  window.fetch = (url, init) => {
    const u = String(url).replace(/^.*?(\/api\/)/, "$1");
    const method = init && init.method ? String(init.method).toUpperCase() : "GET";
    reqs.push((method === "GET" ? "" : method + " ") + u);
    const P = new URL(u, "http://x").searchParams;
    if (u.startsWith("/api/ui/v6/session-search/messages")) {
      let only = null, q = P.get("q");
      if (method === "POST") { const b = JSON.parse(init.body); bodies.push(b); only = Array.isArray(b.sessions) ? b.sessions : null; q = b.q; }
      const hits = HITS.filter((h) => !only || only.includes(h.session_id));
      return Promise.resolve(json({ hits, total: hits.length, sessions: new Set(hits.map((h) => h.session_id)).size, capped: false, cap: 400, words: [q || ""], pending: 0 }));
    }
    if (u.startsWith("/api/ui/v6/session-journal")) {
      if (P.get("session_id")) { const r = JOURNAL.find((x) => x.session_id === P.get("session_id")); return Promise.resolve(r ? json({ row: r }) : json({ error: "세션을 찾을 수 없습니다" }, 404)); }
      if (!P.get("since") && MODE.kinds !== "ok") {
        const fail = () => json({ error: "internal_error" }, 500);
        return MODE.kinds === "hang" ? new Promise((z) => { releaseKinds = () => z(fail()); }) : Promise.resolve(fail());
      }
      const since = P.get("since") ? Date.parse(P.get("since")) : -Infinity, until = P.get("until") ? Date.parse(P.get("until")) : Infinity;
      return Promise.resolve(json({ rows: JOURNAL.filter((r) => { const t = Date.parse(r.last_seen); return t >= since && t < until; }), truncated: false }));
    }
    if (u.startsWith("/api/ui/terminal/sessions")) {
      if (liveHang) { const wait = liveHang; liveHang = null; return wait.then(() => json({ sessions: LIVE })); }
      return Promise.resolve(MODE.rows !== "ok" ? json({ error: "internal_error" }, 500) : json({ sessions: LIVE }));
    }
    if (/^\/api\/ui\/v6\/sessions\/[^/]+\/log/.test(u)) return Promise.resolve(json({ from: 0, bytes: 100, isOwner: true, items: ITEMS }));
    if (/^\/api\/ui\/v6\/sessions\/[^/]+\/subagents/.test(u)) return Promise.resolve(json({ subagents: [] }));
    if (u.startsWith("/api/ui/v6/sessions")) return Promise.resolve(MODE.rows === "500" ? json({ error: "internal_error" }, 500) : json({ sessions: LOGS, truncated: false }));
    return Promise.resolve(json({ error: "없는 경로 " + u }, 404));
  };
  //  셸로 가는 신호 — 이 시험 문서에는 부모가 없어(window.parent === window) 제 창에 보낸다. 보내는 자리에서 잡는다.
  const POSTS = [];
  window.postMessage = (data) => { POSTS.push(JSON.parse(JSON.stringify(data))); };
  //  셸이 보내는 신호를 흉내 낸다 — 진짜 MessageEvent 로(오리진 · 보낸 창까지). 기본은 «같은 오리진 · 부모 창».
  const send = (data, o = {}) => window.dispatchEvent(new MessageEvent("message", { data, origin: o.origin === undefined ? location.origin : o.origin, source: o.source === undefined ? window : o.source }));
  //  pick = 사람이 사이드바에서 방금 눌렀다. 없으면 셸이 맞춰 주는 신호(액자가 줄을 보냈을 때의 답)다.
  const scope = (by, group = null, proj = null, o = {}) => send({ type: "lively:hist-scope", scope: { by, group, proj }, ...(o.pick ? { pick: true } : {}) });
  (0, eval)(document.getElementById("appsrc").textContent);   // 가짜 서버 · 주소의 표를 세운 뒤에 앱을 싣는다

  const view = document.getElementById("view");
  const $ = (s, r = view) => r.querySelector(s);
  const $$ = (s, r = view) => [...r.querySelectorAll(s)];
  const panel = (k) => document.getElementById("shx-panel-" + k);
  const tabBtn = (k) => document.getElementById("shx-tab-" + k);
  const reqOf = (p) => reqs.filter((u) => u.startsWith(p));
  const jList = () => reqOf("/api/ui/v6/session-journal").filter((u) => !/session_id=/.test(u));
  const jAll = () => jList().filter((u) => !/since=/.test(u)).length;   // 전 기간 일지 = «남긴 것» 을 세려고 받는 것
  const shown = (n) => !!n && getComputedStyle(n).display !== "none";
  const type = (input, v) => { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); };
  const crumb = () => { const c = $(".shx-crumb"); return c ? { trail: $$(".crumb", c).map((n) => n.textContent), now: ($(".now", c) || {}).textContent, desc: ($(".desc", c) || {}).textContent || null } : null; };
  const findNames = () => $$("#shx-panel-find .shx-results .shx-row").map((a) => ($(".shx-row-t", a) || $(".shx-row-n", a)).textContent);
  const findPicks = () => $$("#shx-panel-find .shx-pick").map((p) => shown(p));
  const listNames = () => $$("#shx-panel-list .shx-tr").map((tr) => $(".shx-tname", tr).textContent);
  const listChips = () => $$("#shx-panel-list .shx-fchip").map((c) => c.textContent);
  const jNames = () => $$("#shx-panel-journal .shx-jname").map((n) => n.textContent);
  const rowsMsgs = () => POSTS.filter((m) => m && m.type === "lively:hist-rows");
  const searchN = () => reqs.filter((u) => /session-search\/messages/.test(u)).length;
  const listProj = (name) => { const tr = $$("#shx-panel-list .shx-tr").find((x) => $(".shx-tname", x).textContent === name); return tr ? $(".shx-td-proj", tr).textContent : null; };

  try {
    //  셸 안 장면은 「작업 일지」 탭에서 연다 — 줄을 스스로 받지 않는 탭에서 열어도 사이드바가 그릴 줄이 가야 한다.
    location.hash = IN_SHELL ? "#/sessions?tab=journal" : "#/sessions";
    await APP.renderSessions(view);
    await waitFor(() => (IN_SHELL ? $("#shx-panel-journal .shx-jrow") || $("#shx-panel-journal .shx-empty") : $("#shx-panel-find .shx-results .shx-row")));
    await sleep(60);

    if (!IN_SHELL) {
      // ── S15 셸 밖 ──
      R.s15 = { crumb: !!$(".shx-crumb"), posts: POSTS.length, live: reqOf("/api/ui/terminal/sessions").length, names: findNames(), picks: findPicks() };
      scope("day", "d1"); send({ type: "lively:hist-find" });
      await sleep(80);
      R.s15b = { names: findNames(), picks: findPicks(), crumb: !!$(".shx-crumb"), tab: $$("[role=tab]").map((b) => b.getAttribute("aria-selected")) };
      type($("#shx-panel-find .shx-input"), "검색");
      await waitFor(() => $("#shx-panel-find .shx-hit"));
      R.s15c = { search: reqOf("/api/ui/v6/session-search/messages").length, post: reqs.filter((u) => u.startsWith("POST ")).length, hits: findNames().length };
      //  「세션 목록」의 프로젝트 칸 — 셸 밖은 종전 그대로 박스의 프로젝트를 적는다(c3 의 박스에는 9001 이 붙어 있다).
      tabBtn("list").click();
      await waitFor(() => listNames().length >= 5);
      R.s15list = { c3: listProj("덱 재시안"), c1: listProj("검색 고치기"), count: $("#shx-panel-list .shx-count").textContent };
      //  대화록 단독 화면 — 여기서도 다리가 없다.
      location.hash = "#/sessions/c1?node=";
      await APP.renderSessions(view);
      await waitFor(() => $(".sess-turn"));
      scope("day", "d0");
      await sleep(80);
      R.s15d = { hash: location.hash, posts: POSTS.length };
    } else {
      // ── S1 ──
      await waitFor(() => rowsMsgs().some((m) => Array.isArray(m.rows)));
      const first = rowsMsgs()[0], withRows = rowsMsgs().find((m) => Array.isArray(m.rows));
      R.s1 = {
        helloFirst: !!first && first.rows === undefined,
        rows: withRows.rows.map((r) => [r.key, r.conv, r.pid, r.pname, r.state, r.kind]),
        oldLast: (withRows.rows.find((r) => r.conv === "c5") || {}).last === OLD,
        kinds: withRows.kinds, crumb: crumb(), live: reqOf("/api/ui/terminal/sessions").length, journal: jAll(), findMounted: $("#shx-panel-find").childElementCount > 0,
      };

      // ── S2 · S10 — 시간 묶음. 「작업 일지」 · 「세션 목록」은 한 번 열어 두고(감춰 둔 탭) 「대화 찾기」에서 범위를 건다 ──
      $('#shx-panel-journal .shx-seg-b[data-key="d30"]').click();
      await waitFor(() => jNames().length === 5);
      tabBtn("list").click();
      await waitFor(() => listNames().length >= 5);
      R.listAll = { names: listNames().slice().sort(), chips: listChips(), count: $("#shx-panel-list .shx-count").textContent, c3: listProj("덱 재시안"), c1: listProj("검색 고치기"), ticks: TICKS.length };
      tabBtn("find").click();
      await waitFor(() => findNames().length === 5);
      const jBefore = jList().length;
      scope("day", "d1");
      await waitFor(() => findNames().length === 2);
      await sleep(60);
      R.s2 = { names: findNames().slice().sort(), picks: findPicks(), crumb: crumb(), count: $("#shx-panel-find .shx-count").textContent };
      R.s10 = { journalWhileHidden: jList().length - jBefore, listStale: listNames().length };

      // ── S8 — 「작업 일지」를 다시 보면 그때 범위에 맞춰 받는다 ──
      tabBtn("journal").click();
      await waitFor(() => jNames().length === 2);
      const jq = new URL(jList()[jList().length - 1], "http://x").searchParams;
      R.s8 = { names: jNames().slice().sort(), seg: shown($("#shx-panel-journal .shx-bar .shx-seg")), range: $("#shx-panel-journal .shx-range").textContent,
        fetched: jList().length - jBefore, since: Date.parse(jq.get("since")) === YDAY2, until: Date.parse(jq.get("until")) === YDAY + 1,
        wantRange: `어제 · ${YD.getMonth() + 1}월 ${YD.getDate()}일`, stats: $$("#shx-panel-journal .shx-stat-n").map((n) => n.textContent)[0] };

      // ── S3 — 묶음 × 프로젝트 → 「세션 목록」 ──
      tabBtn("list").click();
      await waitFor(() => listNames().length === 2);
      R.s3a = { names: listNames().slice().sort(), chips: listChips(), count: $("#shx-panel-list .shx-count").textContent };
      scope("day", "d1", 3870);
      await waitFor(() => listNames().length === 1);
      R.s3 = { names: listNames(), chips: listChips(), crumb: crumb() };
      scope("day", "d1", 0);   // 프로젝트에 안 붙은 것(기타) — 박스에는 프로젝트(9001)가 붙어 있지만 기록에는 없다
      await waitFor(() => listNames()[0] === "덱 재시안");
      R.s3none = { names: listNames(), proj: $$("#shx-panel-list .shx-td-proj").map((n) => n.textContent), crumb: crumb() };

      // ── S14 — 고른 줄이 범위 밖으로 ──
      $("#shx-panel-list .shx-tr").click();
      await waitFor(() => $("#shx-panel-list .shx-pane .sess-title"));
      const openedTitle = $("#shx-panel-list .shx-pane .sess-title").textContent;
      scope("day", "d0");
      await waitFor(() => !$("#shx-panel-list .shx-pane .sess-title"));
      R.s14 = { opened: openedTitle, pane: ($("#shx-panel-list .shx-pane .shx-empty-t") || {}).textContent || null, names: listNames().slice().sort() };

      // ── S4 · S5 — 「대화 찾기」: 걷힌 고르개 · 범위 안에서 찾기(POST) ──
      scope("day", "d1", 3870);
      tabBtn("find").click();
      await waitFor(() => findNames().length === 1);
      R.s4 = { names: findNames(), picks: findPicks() };
      scope("day", "d1");
      await waitFor(() => findNames().length === 2);
      type($("#shx-panel-find .shx-input"), "검색");
      await waitFor(() => $$("#shx-panel-find .shx-hit").length === 2);
      const b = bodies[bodies.length - 1] || {};
      R.s5 = { posts: reqs.filter((u) => u.startsWith("POST /api/ui/v6/session-search/messages")).length, sessions: (b.sessions || []).slice().sort(), q: b.q, since: b.since === undefined, project: b.project === undefined,
        hits: findNames().slice().sort(), count: $("#shx-panel-find .shx-count").textContent };

      // ── S10(검색) — 검색어가 든 「대화 찾기」를 감춰 두고 범위를 바꾼다: 그동안은 찾지 않고, 다시 볼 때 한 번 찾는다 ──
      tabBtn("list").click();
      await sleep(40);
      const sHidden0 = searchN();
      scope("day", "d0");
      await sleep(100);
      const sHidden1 = searchN();
      tabBtn("find").click();
      await waitFor(() => searchN() > sHidden1 && $$("#shx-panel-find .shx-hit").length === 1);
      R.s10b = { whileHidden: sHidden1 - sHidden0, onShow: searchN() - sHidden1, hits: findNames(), sessions: ((bodies[bodies.length - 1] || {}).sessions || []).slice().sort() };

      // ── S7 — 범위 안에 기록이 없다 ──
      const sN = reqOf("/api/ui/v6/session-search/messages").length + reqs.filter((u) => u.startsWith("POST ")).length;
      scope("day", "m:2019-01");
      await waitFor(() => /찾을 대화가 없습니다/.test(($("#shx-panel-find .shx-empty-t") || {}).textContent || ""));
      R.s7 = { empty: ($("#shx-panel-find .shx-empty-t") || {}).textContent || null, asked: reqOf("/api/ui/v6/session-search/messages").length + reqs.filter((u) => u.startsWith("POST ")).length - sN, crumb: crumb() };

      // ── S6 · S11 — 「전체」로 풀기 ──
      scope("day");
      await waitFor(() => $$("#shx-panel-find .shx-hit").length === 4);
      const lastSearch = reqs.filter((u) => /session-search\/messages/.test(u)).pop();
      R.s6 = { get: !lastSearch.startsWith("POST "), hits: findNames().length, picks: findPicks(), crumb: crumb() };
      type($("#shx-panel-find .shx-input"), "");
      await waitFor(() => findNames().length === 5);
      R.s11 = { names: findNames().length };

      // ── S9 — 시간이 아닌 범위(상태) + 「작업 일지」 ──
      tabBtn("journal").click();
      await waitFor(() => jNames().length === 5);
      scope("state", "off");
      await waitFor(() => jNames().length === 1);
      R.s9 = { names: jNames(), seg: shown($("#shx-panel-journal .shx-bar .shx-seg")), crumb: crumb() };
      $('#shx-panel-journal .shx-seg-b[data-key="week"]').click();   // 어제가 지난 주면 비고, 이번 주면 한 줄이다 — 어느 쪽이든 범위 밖 세션은 없다
      await waitFor(() => $("#shx-panel-journal .shx-empty") || jNames().length === 1);
      R.s9b = { names: jNames(), empty: ($("#shx-panel-journal .shx-empty-t") || {}).textContent || null };
      $('#shx-panel-journal .shx-seg-b[data-key="d30"]').click();
      await waitFor(() => jNames().length === 1);

      // ── S19 — «남긴 것» 묶음을 골랐는데 일지가 아직 없다 → 세는 중 → 못 받았다 ──
      tabBtn("list").click();
      await waitFor(() => listNames().length === 1);   // 아직 「오프라인」 범위
      MODE.kinds = "hang";
      const failBefore = jAll();
      scope("kind", "k", null, { pick: true });
      await waitFor(() => /세는 중/.test($("#shx-panel-list .shx-table").textContent));
      R.s19wait = { list: /남긴 것을 세는 중입니다/.test($("#shx-panel-list .shx-table").textContent), names: listNames(), crumb: crumb(), none: /이 범위에 세션이 없습니다/.test($("#shx-panel-list .shx-table").textContent) };
      releaseKinds();
      await waitFor(() => rowsMsgs().some((m) => m.kindsFailed === true) && /불러오지 못했습니다/.test($("#shx-panel-list .shx-table").textContent));
      const failAsked = jAll() - failBefore;
      scope("kind", "k");   // 셸이 그 줄에 답한다(맞춰 주는 신호) — 여기에 또 청하면 끝없이 돈다
      await sleep(80);
      { const m = rowsMsgs()[rowsMsgs().length - 1]; R.s19 = { asked: failAsked, again: jAll() - failBefore - failAsked, last: [m.kinds, m.kindsFailed === true], names: listNames(),
        list: /남긴 것을 불러오지 못했습니다/.test($("#shx-panel-list .shx-table").textContent), crumb: crumb() }; }
      const pendS = searchN(), pendJ = jList().length;
      tabBtn("find").click();
      await sleep(80);
      R.s19find = { text: /남긴 것을 불러오지 못했습니다/.test($("#shx-panel-find .shx-results").textContent), asked: searchN() - pendS };
      tabBtn("journal").click();
      await sleep(80);
      R.s19journal = { text: /남긴 것을 불러오지 못했습니다/.test($("#shx-panel-journal .shx-journal").textContent), asked: jList().length - pendJ, rows: jNames().length };
      MODE.kinds = "ok";

      // ── S12 — 남긴 것별. 일지를 받기 **전에** 그 묶음을 골라 둔 채다 — 사람이 다시 고르면 다시 청하고, 일지가 오면 줄을 다시 보내고 화면도 다시 그려야 한다 ──
      tabBtn("list").click();
      await sleep(40);
      const kindBefore = rowsMsgs().length, jAllBefore = jAll();
      scope("kind", "k", null, { pick: true });
      await waitFor(() => rowsMsgs().length > kindBefore && rowsMsgs()[rowsMsgs().length - 1].kinds === true);
      const km = rowsMsgs()[rowsMsgs().length - 1];
      R.s12 = { asked: jAll() - jAllBefore, kinds: (km.rows || []).map((r) => r.conv + ":" + r.kind).sort() };
      await waitFor(() => listNames()[0] === "검색 고치기");
      R.s12b = { names: listNames(), crumb: crumb() };
      scope("kind", "n");
      await waitFor(() => listNames().length === 2);
      R.s12c = { names: listNames().slice().sort(), asked: jAll() - jAllBefore };

      // ── S13 — 찾기 신호 ──
      send({ type: "lively:hist-find" });
      await sleep(60);
      R.s13 = { tab: $$("[role=tab]").map((x) => x.getAttribute("aria-selected")), focus: document.activeElement === $("#shx-panel-find .shx-input") };

      // ── S16 — 남이 보낸 신호 · 틀린 범위 ──
      scope("day");
      await waitFor(() => findNames().length === 5);
      const before = JSON.stringify(crumb());
      send({ type: "lively:hist-scope", scope: { by: "day", group: "d1", proj: null } }, { origin: "https://evil.example" });
      send({ type: "lively:hist-scope", scope: { by: "day", group: "d1", proj: null } }, { source: null });
      send({ type: "lively:hist-scope", scope: { by: "owner", group: "me", proj: null } });
      send({ type: "lively:hist-scope" });
      send("lively:hist-scope");
      await sleep(80);
      R.s16 = { same: JSON.stringify(crumb()) === before, names: findNames().length };

      // ── S21 — 보이는 동안 1분마다 줄을 다시 받는다 ──
      tabBtn("list").click();
      await waitFor(() => listNames().length >= 5);
      const live0 = reqOf("/api/ui/terminal/sessions").length, msg0 = rowsMsgs().length;
      VISIBLE = "hidden";
      TICKS[0]();
      await sleep(80);
      const liveHidden = reqOf("/api/ui/terminal/sessions").length - live0;
      VISIBLE = "visible";
      LOGS.push(logRow("c9", "방금 올라온 대화", NOW - 1000, { pid: 4135, pname: "UI 수정" }));
      TICKS[0]();
      await waitFor(() => listNames().includes("방금 올라온 대화"));
      R.s21 = { ticks: TICKS.length, hidden: liveHidden, shown: reqOf("/api/ui/terminal/sessions").length - live0, msgs: rowsMsgs().length - msg0, rows: (rowsMsgs()[rowsMsgs().length - 1].rows || []).length, crumb: crumb() };

      // ── S23 — 늦게 끝난 옛 판 ──
      let releaseOld; liveHang = new Promise((z) => { releaseOld = z; });
      TICKS[0]();                                  // 첫째 — 기록은 곧 받고(6줄), 도는 세션 조회가 붙들린다
      await sleep(40);
      LOGS.push(logRow("c10", "더 새로 올라온 대화", NOW - 500, { pid: 4135, pname: "UI 수정" }));
      TICKS[0]();                                  // 둘째 — 곧바로 끝난다(7줄)
      await waitFor(() => (rowsMsgs()[rowsMsgs().length - 1].rows || []).length === 7);
      const before23 = rowsMsgs().length;
      releaseOld();                                // 첫째가 이제야 끝난다(6줄짜리 옛 판)
      await sleep(100);
      R.s23 = { last: (rowsMsgs()[rowsMsgs().length - 1].rows || []).length, extra: rowsMsgs().length - before23, list: listNames().includes("더 새로 올라온 대화"), crumb: crumb() };

      // ── S22 — 한 축만 받은 판 ──
      MODE.rows = "live500";
      TICKS[0]();
      await waitFor(() => rowsMsgs()[rowsMsgs().length - 1].partial === true);
      { const m = rowsMsgs()[rowsMsgs().length - 1]; R.s22 = { partial: m.partial === true, rows: (m.rows || []).length, states: [...new Set((m.rows || []).map((r) => r.state))] }; }
      MODE.rows = "ok";
      TICKS[0]();
      await waitFor(() => rowsMsgs()[rowsMsgs().length - 1].partial !== true);
      R.s22b = { partial: rowsMsgs()[rowsMsgs().length - 1].partial === true };

      // ── S20 — 줄을 못 받는다 + 범위 ──
      MODE.rows = "500";
      $$("#shx-panel-list .shx-ibtn").find((b) => /새로 고침/.test(b.getAttribute("aria-label") || b.title || "")).click();   // 다시 받는다 — 둘 다 실패
      await waitFor(() => /불러오지 못했습니다/.test($("#shx-panel-list .shx-table").textContent));
      scope("day", "d1");
      tabBtn("find").click();
      type($("#shx-panel-find .shx-input"), "검색");
      const askedBefore = reqs.filter((u) => /session-search\/messages/.test(u)).length;
      await waitFor(() => /범위를 정할/.test($("#shx-panel-find .shx-results").textContent));
      R.s20 = { find: $("#shx-panel-find .shx-results").textContent.trim(), asked: reqs.filter((u) => /session-search\/messages/.test(u)).length - askedBefore };
      tabBtn("journal").click();
      await waitFor(() => /범위를 정할/.test($("#shx-panel-journal .shx-journal").textContent));   // 앞 장면(S19)의 글이 남아 있을 수 있다 — 이 장면의 글을 기다린다
      R.s20.journal = $("#shx-panel-journal .shx-journal").textContent.trim();
      R.s20.jrows = jNames().length;
      R.s20.told = rowsMsgs().some((m) => m.failed === true && m.rows === undefined);
      MODE.rows = "ok";

      // ── S17 · S18 — 대화록 단독 화면 ──
      location.hash = "#/sessions/c1?node=";
      await APP.renderSessions(view);
      await waitFor(() => $(".sess-turn"));
      R.s17a = { hash: location.hash, tabs: $$("[role=tab]").length };
      scope("day", "d0");                       // 셸이 맞춰 주는 신호 — 범위가 바뀌어도(어제 → 오늘) 화면은 그대로다
      await sleep(80);
      R.s18 = { hash: location.hash };
      scope("day", "d0", null, { pick: true });  // 같은 범위라도 사람이 누른 것이면 앱으로
      await sleep(80);
      R.s17 = { hash: location.hash };
      location.hash = "#/sessions/c1?node=";
      await APP.renderSessions(view);
      await waitFor(() => $(".sess-turn"));
      send({ type: "lively:hist-find" });
      await sleep(80);
      R.s17find = { hash: location.hash };
    }
  } catch (e) { R.err = String(e && e.stack || e); }

  R.pageErrors = pageErrors;
  R.reqN = reqs.length;
  R.postN = POSTS.length;
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const pageOf = (inShell) => `<!doctype html><html data-theme="light" lang="ko"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><body data-route="sessions"><div id="toasts"></div><main id="view"></main><pre id="out">PENDING</pre>
<script>window.__IN_SHELL__ = ${inShell ? "true" : "false"};</script>
<script type="text/plain" id="appsrc">${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;

async function run(inShell) {
  const dom = await dumpDom(chrome, { html: pageOf(inShell), copy: CSS, prefix: "session-history-scope-", virtualTimeBudget: 90000, args: ["--window-size=1400,900"] });
  const m = /<pre id="out">([\s\S]*?)ENDRESULT/.exec(dom);
  if (!m) { console.error("FAIL  결과 표지를 못 받았다\n" + dom.slice(0, 1500)); process.exit(1); }
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
}
const A = await run(true);    // 셸 액자 안
const B = await run(false);   // 셸 밖
if (process.env.DEBUG) console.log(JSON.stringify({ A, B }, null, 1));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "") => (cond ? ok(n) : bad(n, why));
const same = (got, want, n) => { const a = JSON.stringify(got), b = JSON.stringify(want); return a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };
for (const [name, R] of [["셸 안", A], ["셸 밖", B]]) for (const k of ["fatal", "err"]) if (R[k]) bad(`장면 오류(${name}) ${k}`, String(R[k]).slice(0, 900));

const C = (trail, now, desc) => ({ trail, now, desc });

// ── S1 ──
check(!!A.s1 && A.s1.helloFirst === true, "S1 인사(줄 없는 신호)가 줄보다 먼저 간다 — 셸이 고른 것을 먼저 알려 준다", JSON.stringify(A.s1 && A.s1.helloFirst));
same(A.s1 && A.s1.rows.slice().sort((a, b) => String(a[1]).localeCompare(String(b[1]))), [
  ["box-1", "c1", 3870, "통합검색", "live", null], ["c2", "c2", 4135, "UI 수정", "rec", null], ["box-3", "c3", 0, "", "rec", null],
  ["box-4", "c4", 3870, "통합검색", "off", null], ["box-5", "c5", 3870, "통합검색", "off", null],
], "S1 셸에 가는 줄 = 기록이 있는 다섯(휴지통 · 빈 기록 · 박스만 있는 세션 · 남의 것 없음) · 프로젝트는 기록의 것(c3 은 박스에 9001 이 붙어 있어도 «없음») · 남긴 것은 아직 모름");
same(A.s1 && A.s1.oldLast, true, "S1 줄의 시각은 기록의 마지막 시각 — 오늘 열어 보기만 한 옛 대화(c5)는 40일 전 그대로다");
same(A.s1 && [A.s1.kinds, A.s1.journal], [false, 0], "S1 남긴 것은 묻기 전에 받지 않는다(전 기간 일지 조회 0건)");
same(A.s1 && A.s1.findMounted, false, "S1 「작업 일지」 탭에서 열어도 줄이 간다 — 「대화 찾기」는 아직 그리지도 않았다");
same(A.s1 && A.s1.crumb, C([], "세션 이력", "5개"), "S1 빵부스러기 «세션 이력 5개» — 사이드바 「전체」와 같은 수");
check(!!A.s1 && A.s1.live >= 1, "S1 사이드바가 그릴 줄을 어느 탭에서 열든 받는다(도는 세션 조회)", JSON.stringify(A.s1 && A.s1.live));
same(A.listAll && A.listAll.names, ["검색 고치기", "기록 없는 새 세션", "덱 재시안", "어제 검색 정리", "옛 조사", "위젯 기획"], "S1 고른 것이 없으면 「세션 목록」은 종전 그대로 — 박스만 있는 세션도 선다");
check(!!A.listAll && /세션 6개 · 기록이 있는 세션 5개/.test(A.listAll.count), "S1 그 차이를 한마디로 적는다(세션 6개 · 기록이 있는 세션 5개)", JSON.stringify(A.listAll && A.listAll.count));
same(A.listAll && [A.listAll.c3, A.listAll.c1], ["", "통합검색"], "S1 셸 안의 「세션 목록」 프로젝트 칸은 줄의 프로젝트(기록의 것) — c3 은 비어 있다(사이드바가 «기타» 로 센다)");

// ── S2 · S10 ──
same(A.s2 && A.s2.names, ["덱 재시안", "어제 검색 정리"], "S2 시간 묶음(어제) — 「대화 찾기」가 그 묶음의 대화만");
same(A.s2 && A.s2.picks, [false, true, true], "S2 기간 고르개가 걷힌다(사이드바가 기간을 쥐었다) · 프로젝트 · 말한 쪽은 그대로");
same(A.s2 && A.s2.crumb, C(["세션 이력", "시간별"], "어제", "2개"), "S2 빵부스러기 «세션 이력 / 시간별 / 어제 2개»");
check(!!A.s2 && /최근 대화 2개/.test(A.s2.count), "S2 수도 범위 안", JSON.stringify(A.s2 && A.s2.count));
same(A.s10 && A.s10.journalWhileHidden, 0, "S10 감춰 둔 「작업 일지」는 범위가 바뀌어도 조회하지 않는다");
same(A.s10b && [A.s10b.whileHidden, A.s10b.onShow], [0, 1], "S10 검색어가 든 「대화 찾기」도 감춰 둔 동안은 찾지 않는다 — 다시 볼 때 한 번 찾는다");
same(A.s10b && [A.s10b.hits, A.s10b.sessions], [["검색 고치기"], ["c1", "c2"]], "S10 그때 찾는 범위는 새 범위(오늘)다");
same(A.s10 && A.s10.listStale, 6, "S10 감춰 둔 「세션 목록」은 그대로 둔다(볼 때 다시 그린다)");

// ── S8 ──
same(A.s8 && A.s8.names, ["덱 재시안", "어제 검색 정리"], "S8 「작업 일지」 + 시간 묶음 — 범위 안 세션만");
same(A.s8 && [A.s8.seg, A.s8.fetched], [false, 1], "S8 기간 고르개가 걷히고 · 다시 볼 때 한 번 받는다");
same(A.s8 && [A.s8.since, A.s8.until], [true, true], "S8 청하는 구간 = 범위 안 줄의 기록 시각을 덮는 구간(가장 이른 것 ~ 가장 늦은 것 + 1ms)");
check(!!A.s8 && A.s8.range === A.s8.wantRange, "S8 범위 글 «어제 · M월 D일»", JSON.stringify(A.s8 && [A.s8.range, A.s8.wantRange]));
same(A.s8 && A.s8.stats, "2", "S8 합계도 범위 안(세션 2)");

// ── S3 ──
same(A.s3a && A.s3a.names, ["덱 재시안", "어제 검색 정리"], "S3 「세션 목록」을 다시 보면 범위에 맞춰 선다(어제 2줄)");
check(!!A.s3a && /^전체\s*2/.test(A.s3a.chips[0]) && /기록만\s*1/.test(A.s3a.chips[3]) && /오프라인\s*1/.test(A.s3a.chips[2]), "S3 칩의 수도 범위 안(전체 2 · 오프라인 1 · 기록만 1)", JSON.stringify(A.s3a && A.s3a.chips));
same(A.s3 && A.s3.names, ["어제 검색 정리"], "S3 묶음 × 프로젝트 — 그 줄만");
same(A.s3 && A.s3.crumb, C(["세션 이력", "시간별", "어제"], "통합검색", "1개"), "S3 빵부스러기에 프로젝트 이름");
same(A.s3none && A.s3none.names, ["덱 재시안"], "S3 「기타 (미분류)」(0) — 기록에 프로젝트가 없는 세션(박스에는 붙어 있어도)");
same(A.s3none && A.s3none.proj, [""], "S3 그 줄의 프로젝트 칸도 기록의 것(비어 있다) — 「기타 (미분류)」를 골랐는데 프로젝트 번호가 서지 않는다");
same(A.s3none && A.s3none.crumb, C(["세션 이력", "시간별", "어제"], "기타 (미분류)", "1개"), "S3 빵부스러기 «… / 어제 / 기타 (미분류)»");

// ── S14 ──
same(A.s14 && [A.s14.opened, !!A.s14.pane], ["덱 재시안", true], "S14 고른 줄이 범위 밖으로 나가면 오른쪽 칸이 비워진다");
same(A.s14 && A.s14.names, ["검색 고치기", "위젯 기획"], "S14 줄은 새 범위(오늘)의 것 — 오늘 열어 보기만 한 옛 대화는 «오늘» 이 아니다(일지 · 대화 찾기와 같은 날짜)");

// ── S4 · S5 ──
same(A.s4 && [A.s4.names, A.s4.picks], [["어제 검색 정리"], [false, false, true]], "S4 프로젝트 줄을 고르면 프로젝트 고르개도 걷힌다");
same(A.s5 && [A.s5.posts >= 1, A.s5.sessions, A.s5.q], [true, ["c3", "c4"], "검색"], "S5 범위 + 검색어 — POST · 본문의 sessions = 범위 안 대화 id");
same(A.s5 && [A.s5.since, A.s5.project], [true, true], "S5 걷힌 고르개(기간)의 값은 안 실린다 · 안 고른 프로젝트도 없다");
same(A.s5 && A.s5.hits, ["덱 재시안", "어제 검색 정리"], "S5 맞은 말도 범위 안 세션의 것만");

// ── S7 ──
check(!!A.s7 && /찾을 대화가 없습니다/.test(A.s7.empty || "") && A.s7.asked === 0, "S7 범위 안에 기록이 없으면 요청을 내지 않고 까닭을 말한다", JSON.stringify(A.s7));
same(A.s7 && A.s7.crumb, C(["세션 이력", "시간별"], "2019년 1월", "0개"), "S7 빵부스러기 «… / 2019년 1월 0개»(다른 해의 달은 해까지)");

// ── S6 · S11 ──
same(A.s6 && [A.s6.get, A.s6.hits, A.s6.picks], [true, 4, [true, true, true]], "S6 · S11 「전체」로 풀면 종전 GET · 맞은 말 전부 · 걷혔던 고르개가 다시 선다");
same(A.s6 && A.s6.crumb, C([], "세션 이력", "5개"), "S11 빵부스러기도 «세션 이력 5개» 로");
same(A.s11 && A.s11.names, 5, "S11 최근 대화도 전부 돌아온다");

// ── S9 ──
same(A.s9 && [A.s9.names, A.s9.seg], [["어제 검색 정리"], true], "S9 시간이 아닌 범위(상태: 오프라인) — 기간 고르개는 남고 · 범위 안 세션만");
same(A.s9 && A.s9.crumb, C(["세션 이력", "상태별"], "오프라인", "2개"), "S9 빵부스러기 «세션 이력 / 상태별 / 오프라인 2개»(일지에는 그 기간의 하나만 선다)");
check(!!A.s9b && (A.s9b.names.length === 1 ? A.s9b.names[0] === "어제 검색 정리" : /이 범위에는 이 기간에 한 세션이 없습니다/.test(A.s9b.empty || "")),
  "S9 기간을 좁혀 비면 까닭을 말한다(범위 탓) — 범위 밖 세션이 끼지 않는다", JSON.stringify(A.s9b));

// ── S19 ──
same(A.s19wait && [A.s19wait.list, A.s19wait.names, A.s19wait.none], [true, [], false], "S19 일지가 오기 전 — «세는 중» 이라 말한다(«이 범위에 세션이 없습니다» 가 아니다)");
same(A.s19wait && A.s19wait.crumb, C(["세션 이력", "남긴 것별"], "지식을 남긴 세션", null), "S19 그동안 빵부스러기는 수를 적지 않는다(«0개» 라 하지 않는다)");
same(A.s19 && [A.s19.asked, A.s19.again, A.s19.last], [1, 0, [false, true]], "S19 일지를 못 받으면 그렇다고 셸에 알리고 · 셸의 답(맞춰 주는 신호)에는 다시 청하지 않는다");
same(A.s19 && [A.s19.list, A.s19.names, A.s19.crumb && A.s19.crumb.desc], [true, [], null], "S19 본문도 «못 받았다» 고 말한다 — 줄도 수도 없다");
same(A.s19find && [A.s19find.text, A.s19find.asked], [true, 0], "S19 「대화 찾기」도 같다 — 찾는 요청을 내지 않는다");
same(A.s19journal && [A.s19journal.text, A.s19journal.asked, A.s19journal.rows], [true, 0, 0], "S19 「작업 일지」도 같다 — 일지를 청하지 않는다");

// ── S12 ──
same(A.s12 && [A.s12.asked, A.s12.kinds], [1, ["c1:k", "c2:a", "c3:n", "c4:n", "c5:a"]], "S12 사람이 다시 고르면 다시 청한다 — 일지를 한 번 받아 줄을 다시 보낸다(지식 · 작업 기록만 · 없음)");
same(A.s12b && A.s12b.names, ["검색 고치기"], "S12 «지식을 남긴 세션» = 그 세션만");
same(A.s12b && A.s12b.crumb, C(["세션 이력", "남긴 것별"], "지식을 남긴 세션", "1개"), "S12 빵부스러기 «세션 이력 / 남긴 것별 / 지식을 남긴 세션 1개»");
same(A.s12c && A.s12c.names, ["덱 재시안", "어제 검색 정리"], "S12 «남긴 기록이 없는 세션» = 일지에 남긴 것이 없는 둘");
same(A.s12c && A.s12c.asked, 1, "S12 받아 둔 일지는 다시 받지 않는다(묶음을 옮겨도 한 번)");

// ── S13 ──
same(A.s13 && [A.s13.tab, A.s13.focus], [["true", "false", "false"], true], "S13 찾기 신호 — 「대화 찾기」 탭으로 가고 찾기 칸에 초점");

// ── S16 ──
same(A.s16 && [A.s16.same, A.s16.names], [true, 5], "S16 남의 오리진 · 다른 창이 보낸 것 · 없는 기준 · 범위 없는 신호는 무시한다");

// ── S21 · S22 ──
same(A.s21 && [A.s21.ticks, A.s21.hidden, A.s21.shown, A.s21.msgs >= 1, A.s21.rows], [1, 0, 1, true, 6], "S21 1분 타이머 하나 — 가려져 있으면 받지 않고, 보이면 다시 받아 셸에 보낸다(새 기록까지 6줄)");
same(A.s21 && A.s21.crumb, C([], "세션 이력", "6개"), "S21 「세션 목록」과 빵부스러기도 새 줄로 맞춘다");
same(A.s23 && [A.s23.last, A.s23.extra, A.s23.list], [7, 0, true], "S23 늦게 끝난 옛 판은 버린다 — 셸에 다시 보내지 않고 표도 새 판 그대로다");
same(A.s22 && [A.s22.partial, A.s22.rows, A.s22.states], [true, 7, ["rec"]], "S22 도는 세션을 못 받은 판 — 줄은 전부 «기록만» 으로 가되 «한 축만 받았다» 고 알린다");
same(A.s22b && A.s22b.partial, false, "S22 다시 다 받으면 그 표가 걷힌다");

// ── S20 ──
same(A.s20 && [A.s20.find, A.s20.asked], ["범위를 정할 세션 목록을 불러오지 못했습니다.", 0], "S20 줄을 못 받았는데 범위가 걸려 있으면 「대화 찾기」는 못 받았다고 말한다 — 찾는 요청을 내지 않는다(범위가 비었다고 하지 않는다)");
same(A.s20 && [A.s20.journal, A.s20.jrows], ["범위를 정할 세션 목록을 불러오지 못했습니다.", 0], "S20 「작업 일지」도 같다");
same(A.s20 && A.s20.told, true, "S20 셸에도 못 받았다고 알린다(줄 없이) — 사이드바가 «받는 중» 으로 영영 서 있지 않게");

// ── S17 ──
same(A.s17a && [A.s17a.hash, A.s17a.tabs], ["#/sessions/c1?node=", 0], "S17 대조: 대화록 단독 화면이 섰다(탭 없음)");
same(A.s18 && A.s18.hash, "#/sessions/c1?node=", "S18 셸이 맞춰 주는 신호에는 화면을 옮기지 않는다 — 막 연 대화록이 앱으로 튕기지 않는다");
same(A.s17 && A.s17.hash, "#/sessions", "S17 사람이 사이드바에서 고르면 앱으로 돌아온다(범위가 이미 그것이어도)");
same(A.s17find && A.s17find.hash, "#/sessions?tab=find", "S17 그 화면에서 찾기 단추 → 앱의 「대화 찾기」로");

// ── S15 셸 밖 ──
same(B.s15 && [B.s15.crumb, B.s15.posts, B.s15.live], [false, 0, 0], "S15 셸 밖 — 빵부스러기 없음 · 줄을 안 보낸다 · 「대화 찾기」는 도는 세션을 조회하지 않는다");
same(B.s15 && [B.s15.names.length, B.s15.picks], [5, [true, true, true]], "S15 최근 대화 전부 · 고르개 셋 그대로");
same(B.s15b && [B.s15b.names.length, B.s15b.picks, B.s15b.crumb, B.s15b.tab], [5, [true, true, true], false, ["true", "false", "false"]], "S15 범위 · 찾기 신호를 받아도 그대로다(다리가 없다)");
same(B.s15c && [B.s15c.search >= 1, B.s15c.post, B.s15c.hits], [true, 0, 4], "S15 검색은 종전 GET — 전부에서 찾는다");

same(B.s15list && [B.s15list.c3, B.s15list.c1], ["#9001", "통합검색"], "S15 셸 밖의 「세션 목록」 프로젝트 칸은 종전 그대로 박스의 프로젝트(c3 → #9001)");
check(!!B.s15list && !/기록이 있는 세션/.test(B.s15list.count), "S15 셸 밖에는 «기록이 있는 세션 N개» 를 덧붙이지 않는다(사이드바가 없다)", JSON.stringify(B.s15list && B.s15list.count));
same(B.s15d && [B.s15d.hash, B.s15d.posts], ["#/sessions/c1?node=", 0], "S15 대화록 단독 화면에서도 다리가 없다 — 신호를 받아도 주소가 그대로 · 셸에 보낸 것 0");

// ── W ──
same(A.pageErrors, [], "W 페이지 오류 0(셸 안)");
same(B.pageErrors, [], "W 페이지 오류 0(셸 밖)");
check(A.reqN > 8 && A.postN > 2 && B.reqN > 1, "W 배선 — 가짜 서버가 실제로 불렸고, 셸로 가는 신호가 실제로 잡혔다", JSON.stringify([A.reqN, A.postN, B.reqN]));

console.log(`\n#4553 세션 이력 사이드바 범위(런타임): ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
