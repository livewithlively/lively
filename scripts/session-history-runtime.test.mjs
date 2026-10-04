#!/usr/bin/env node
// 「세션 이력」 앱(#4553) — **실제 화면에서** 가로탭 셋이 제 일을 하나 — 런타임 회귀 테스트.
//
// 원준 2026-10-04: «그 A,B,C안을 그거 들어간 다음에 위에 상위 가로탭으로 만들어가지고 셋 다 구현해.»
//  규칙(무엇이 어느 묶음에 서나)은 session-history.test.mjs 가, SQL 은 session-history.pg-test.mjs 가 잰다. 여기서는 화면에서만
//  보이는 것을 장면으로 잰다 — «어느 탭이 무엇을 부르나 · 거르개가 요청에 실리나 · 누른 줄이 대화록의 그 자리로 열리나 ·
//  탭을 오가도 보던 자리가 남나 · 대화 본문이 글자로만 그려지나».
//
// 엣지 표(행마다 장면 하나):
//  R1  가로탭 셋 · 처음엔 「대화 찾기」 · 안 연 탭은 그리지도 부르지도 않는다(일지·도는 세션 조회 0건)
//  R2  검색어 없음 = 최근 대화가 날짜 묶음으로 · 휴지통·빈 세션은 없다 · 목록은 서버 상한(limit=2000)까지 청한다
//  R3  검색어 → 맞은 말 단위 요청(q · limit) · 줄 = 맞은 말 · 앞뒤 말 · 낱말 색칠 · 총계와 색인 중 안내
//  R4  거르개가 요청에 실린다 — 기간(since) · 말한 쪽(role) · 프로젝트(project) · 프로젝트 없음(project=0)
//  R5  줄을 누르면 오른쪽 칸에 대화록 — 그 말의 자리가 열리고(시각으로 찾는다) · 낱말이 칠해지고 · 「이 대화에서 n곳」 · 다음/이전
//  R6  칸 안 대화록엔 「← 뒤로」가 없고 「이 세션이 남긴 것」이 붙는다 · 남의 세션(404)이면 그 칸이 없다 ·
//      그 대화를 돌리는 박스를 알게 되면 머리의 「이어 질문하기」가 [세션 열기]로 바뀐다(문은 하나)
//  R7  글자를 더 치면 앞 요청을 끊는다 · 늦게 온 앞 요청의 답이 화면을 덮지 않는다
//  R8  대화 본문의 태그는 글자로만 선다(요소가 생기지 않는다)
//  R9  「작업 일지」 — 기간(since·until)으로 청하고 · 합계 · 날짜 묶음 · 줄을 누르면 기록이 펼쳐지고 · 기록 없는 세션은 그렇다고 ·
//      프로젝트별로 다시 묶고 · [요약 복사]가 그 기간의 글을 클립보드에 · 줄의 문은 하나(박스 있으면 [세션 열기], 없으면
//      「이어 질문하기」) · 앞선 기간에만 기록이 있는 세션은 그렇다고 · 기간을 연달아 바꾸면 앞 요청을 끊는다
//  R10 「세션 목록」 — 도는 세션 + 기록을 한 줄로(남의 세션은 없다) · 실행 중/오프라인/기록만 거르개 · 이름 거르기 · 열 머리 정렬 ·
//      세션으로 가는 문은 줄마다 하나 — 박스 있는 줄은 [세션 열기](「이어 질문하기」 없음), 기록만 남은 줄은 「이어 질문하기」 · 정보 탭
//  R11 탭을 오가도 보던 자리가 남는다(검색어·결과·고른 줄) · 주소에 탭이 적힌다 · 주소의 ?tab= 으로 그 탭이 열린다
//  R12 대화록 단독 화면(#/sessions/<sid>)은 그대로 — 「← 뒤로」가 있다
//  R13 실패를 말한다 — 검색 503 · 일지 500
//  R14 감춰진 탭 칸에 대화록이 실려도(응답이 늦게 왔다) 그 칸을 다시 보면 긴 답변이 접혀 있다(10줄 캡)
//  R15 두 탭이 같은 세션의 대화록을 들고 있어도 질문 목차는 **제 칸의** 그 질문으로 간다
//  R16 [세션 열기] — 셸 밖(클래식 단독)에서는 세션 터미널 창, 셸 안에서는 그 세션 화면 주소
//  R17 글자를 치고 곧바로 다른 화면으로 가면, 늦게 도는 찾기 타이머가 그 화면의 주소를 덮지 않고 요청도 안 낸다
//  R18 「이번 주」가 비어 있으면(주가 막 바뀌었다) 그렇다고 말하고 [지난 주 보기]로 간다
//  W   모든 장면을 통틀어 페이지 오류 0 · 배선(가짜 서버가 실제로 불렸다)
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다. 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;

const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 세션 이력 런타임 검증 미실행");
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
  const R = {};
  const pageErrors = [];
  window.addEventListener("error", (e) => pageErrors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => pageErrors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const waitFor = async (fn, ms = 6000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(15); } return false; };
  localStorage.setItem("lively_ui_token", "t");
  localStorage.removeItem("lively.sessions.tab");
  let copied = null;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { copied = String(t); } } });

  // ── 가짜 서버 데이터 — «오늘» 것은 오늘 0시와 지금의 한가운데(자정 경계에서 흔들리지 않게) ──
  const NOW = Date.now(), D = 86_400_000;
  const T0 = new Date(NOW); T0.setHours(0, 0, 0, 0);
  const TODAY = Math.round((T0.getTime() + NOW) / 2);
  //  «오늘, 그보다 조금 전» — 고정된 분(分)을 빼지 않는다. 자정 직후엔 «TODAY - 1분» 이 어제로 넘어가 묶음·순서가 흔들린다
  //   (변이 점검이 자정을 넘기며 실제로 밟았다).
  const EARLIER = Math.round((T0.getTime() + TODAY) / 2);
  const iso = (ms) => new Date(ms).toISOString();
  const logRow = (sid, name, last, o = {}) => ({ node_id: "", session_id: sid, harness: "claude", title: "첫 지시 " + name, name, owner: "me", owner_name: "원준", first_seen: iso(last - 3_600_000), last_seen: iso(last), bytes: o.bytes ?? 5000, project_id: o.pid ?? null, project_name: o.pname ?? null, ...(o.trashed ? { trashed_at: iso(NOW) } : {}) });
  const LOGS = [
    logRow("c1", "검색 고치기", TODAY, { pid: 3870, pname: "통합검색" }),
    logRow("c2", "위젯 기획", EARLIER, { pid: 4135, pname: "UI 수정" }),
    logRow("c3", "덱 재시안", NOW - 3 * D),
    logRow("c4", "휴지통 세션", TODAY, { trashed: true }),
    logRow("c5", "빈 세션", TODAY, { bytes: 0 }),
    logRow("c6", "옛 조사", NOW - 40 * D, { pid: 3870, pname: "통합검색" }),
  ];
  const sec = (ms) => Math.floor(ms / 1000);
  const LIVE = [
    { id: "box-1", label: "검색 고치기", harness: "claude", owned: true, created: sec(TODAY - 3_600_000), lastActive: sec(TODAY), attached: true, agentState: "busy", working: true, claudeSessionId: "c1", projectId: 3870 },
    { id: "box-3", label: "덱 재시안", harness: "claude", owned: true, created: sec(NOW - 4 * D), lastActive: sec(NOW - 3 * D), attached: false, agentState: "offline", restorable: true, claudeSessionId: "c3" },
    { id: "box-7", label: "오프라인 세션", harness: "claude", owned: true, created: sec(NOW - 3 * D), lastActive: sec(NOW - 2 * D), attached: false, agentState: "offline" },   // 박스는 있지만 아무도 안 보고 있다
    { id: "box-x", label: "남의 세션 박스", harness: "claude", owned: false, created: sec(NOW), lastActive: sec(NOW), attached: true, agentState: "idle", lastViewed: sec(NOW) + 1 },
    { id: "box-9", label: "기록 없는 새 세션", harness: "claude", owned: true, created: sec(NOW), lastActive: sec(NOW), attached: true, agentState: "idle", lastViewed: sec(NOW) + 1 },
  ];
  const TS = (n) => iso(NOW - 3 * D + n * 1000);   // 대화 속 말들의 시각 — 묶음과 무관한 고정된 과거
  const ITEMS = [
    { role: "user", text: "검색을 고쳐 줘", ts: TS(0) },
    { role: "tool", tool: "Grep", text: "omni", ts: TS(1) },
    { role: "assistant", text: "먼저 살펴보겠습니다", ts: TS(1) },
    { role: "assistant", text: "색인을 새로 쌓겠습니다. **검색**이 빨라집니다.", ts: TS(2) },
    { role: "assistant", text: Array.from({ length: 40 }, (_, i) => "긴 답변의 " + (i + 1) + "번째 문단입니다.").join("\n\n"), ts: TS(3) },   // 10줄 캡을 넘는 답
    { role: "user", text: "배포까지 해 줘", ts: TS(5) },
    { role: "assistant", text: "검색 배포를 마쳤습니다", ts: TS(6) },
  ];
  const HITS = [
    { node_id: "", session_id: "c1", name: "검색 고치기", project: "통합검색", project_id: 3870, role: "assistant", ts: TS(6), text: "검색 배포를 마쳤습니다", terms: 1, before: { role: "user", ts: TS(5), text: "배포까지 해 줘" }, after: null },
    { node_id: "", session_id: "c1", name: "검색 고치기", project: "통합검색", project_id: 3870, role: "user", ts: TS(0), text: "검색을 고쳐 줘", terms: 1, before: null, after: { role: "assistant", ts: TS(1), text: "먼저 살펴보겠습니다" } },
    { node_id: "", session_id: "c7", name: "남의 세션", project: null, project_id: null, role: "user", ts: iso(NOW - 2 * D), text: "<img src=x onerror=window.PWNED=1> 검색 <b>굵게</b>", terms: 1, before: null, after: null },
  ];
  const act = (id, type, title, o = {}) => ({ id, type, title, summary: o.summary ?? null, at: iso(TODAY), commit: !!o.commit, knowledge: o.kn ?? [] });
  const K1 = { name: "omni-asbuilt", title: "통합검색 as-built" };
  const jrow = (l, o = {}) => ({ node_id: "", session_id: l.session_id, name: l.name, title: l.title, harness: "claude", first_seen: l.first_seen, last_seen: l.last_seen, bytes: l.bytes, project_id: l.project_id, project_name: l.project_name, box_id: o.box ?? null, asks: o.asks ?? 2, edits: o.edits ?? 0, activities: o.acts ?? [], activities_before: o.before ?? 0, knowledge: o.kn ?? [], tasks: o.tasks ?? [] });
  const JOURNAL = [
    jrow(LOGS[0], { box: "box-1", edits: 4, acts: [act(1, "feature", "대화 검색 추가", { commit: true, kn: [K1] }), act(2, "docs", "배포 기록", { summary: "매니지드까지" })], kn: [K1], tasks: [{ id: 4517, name: "대화 검색", status: "done", project_id: 3870 }] }),
    jrow(LOGS[1]),
    jrow(LOGS[2], { before: 2 }),
  ];
  let reqs = [];
  const MODE = { search: "ok", journal: "ok" };
  let hang = null;           // 검색을 매달아 둘 약속(끊기 장면)
  let aborted = 0;
  let logHang = null;        // 대화록 응답을 매달아 둘 약속(감춰진 칸 장면)
  const journalSignals = []; // 일지 목록 요청의 끊기 신호
  const OPENED = [];         // window.open 이 받은 [주소, 창 이름]
  window.open = (u, n) => { OPENED.push([String(u), String(n)]); return null; };
  const SCROLLED = [];       // scrollIntoView 가 불린 요소가 든 탭 칸
  Element.prototype.scrollIntoView = function () { const p = this.closest("[role=tabpanel]"); SCROLLED.push(p ? p.id : "(칸 밖)"); };
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  window.fetch = (url, init) => {
    const u = String(url).replace(/^.*?(\/api\/)/, "$1");
    reqs.push((init && init.method ? init.method + " " : "") + u);
    const P = new URL(u, "http://x").searchParams;
    if (u.startsWith("/api/ui/v6/session-search/messages")) {
      if (MODE.search === "503") return Promise.resolve(json({ error: "대화 검색이 시간 안에 끝나지 않았습니다 — 기간을 좁히거나 잠시 뒤 다시 찾아 주세요" }, 503));
      const out = () => json({ hits: P.get("q") === "없는말" ? [] : HITS.filter((h) => !P.get("role") || h.role === P.get("role")), total: P.get("q") === "없는말" ? 0 : 7, sessions: 2, capped: false, cap: 400, words: [P.get("q") === "느린" ? "느린" : "검색"], pending: 3 });
      if (P.get("q") === "느린" && hang) {
        return new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () => { aborted++; const e = new Error("aborted"); e.name = "AbortError"; reject(e); });
          hang.then(() => resolve(out()));
        });
      }
      return Promise.resolve(out());
    }
    if (u.startsWith("/api/ui/v6/session-journal")) {
      if (P.get("session_id")) { const r = JOURNAL.find((x) => x.session_id === P.get("session_id")); return Promise.resolve(r ? json({ row: r }) : json({ error: "세션을 찾을 수 없습니다" }, 404)); }
      if (MODE.journal === "500") return Promise.resolve(json({ error: "internal_error" }, 500));
      if (MODE.journal === "empty") return Promise.resolve(json({ rows: [], truncated: false }));
      journalSignals.push(init && init.signal ? init.signal : null);
      //  조금 늦게 답한다 — 연달아 기간을 바꿨을 때 앞 요청이 아직 떠 있게.
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(json({ rows: JOURNAL, truncated: false })), 40);
        if (init && init.signal) init.signal.addEventListener("abort", () => { clearTimeout(t); const e = new Error("aborted"); e.name = "AbortError"; reject(e); });
      });
    }
    if (u.startsWith("/api/ui/terminal/sessions")) return Promise.resolve(json({ sessions: LIVE }));
    if (/^\/api\/ui\/v6\/sessions\/[^/]+\/log/.test(u)) {
      const out = () => json({ from: 0, bytes: 100, isOwner: !u.includes("/c7/"), items: ITEMS });
      return logHang ? logHang.then(out) : Promise.resolve(out());
    }
    if (/^\/api\/ui\/v6\/sessions\/[^/]+\/subagents/.test(u)) return Promise.resolve(json({ subagents: [] }));
    if (u.startsWith("/api/ui/v6/sessions")) return Promise.resolve(json({ sessions: LOGS, truncated: false }));
    return Promise.resolve(json({ error: "없는 경로 " + u }, 404));
  };
  (0, eval)(document.getElementById("appsrc").textContent);   // 가짜 서버를 세운 뒤에 앱을 싣는다

  const view = document.getElementById("view");
  const $ = (s, r = view) => r.querySelector(s);
  const $$ = (s, r = view) => [...r.querySelectorAll(s)];
  const panel = (k) => document.getElementById("shx-panel-" + k);
  const tabBtn = (k) => document.getElementById("shx-tab-" + k);
  const open = async (hash) => { location.hash = hash; await APP.renderSessions(view); await sleep(30); };
  const reqOf = (p) => reqs.filter((u) => u.startsWith(p));
  const jList = () => reqOf("/api/ui/v6/session-journal").filter((u) => !/session_id=/.test(u));
  //  셸에 보내는 부탁(postMessage) — 이 시험 문서는 file:// 이라 실제로는 배달되지 않는다. 보내는 자리에서 잡는다.
  const MSGS = [];
  window.postMessage = (data) => { if (data && data.type === "lively:open-route") MSGS.push(data.href); };
  const listShape = (root) => [...root.children].map((n) => n.classList.contains("shx-grp") ? "# " + n.textContent : n.classList.contains("shx-row") ? ($(".shx-row-t", n) ? $(".shx-row-t", n).textContent : "hit") : n.tagName === "P" ? "p: " + n.textContent : n.tagName.toLowerCase());
  const type = (input, v) => { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); };
  const pick = (sel, v) => { sel.value = v; sel.dispatchEvent(new Event("change", { bubbles: true })); };

  try {
    // ── R1 · R2 ──
    await open("#/sessions");
    const find = panel("find");
    await waitFor(() => $(".shx-results .shx-row", find));
    R.tabs = $$("[role=tab]").map((b) => [b.textContent, b.getAttribute("aria-selected")]);
    R.panelsHidden = ["find", "journal", "list"].map((k) => panel(k).hidden);
    R.lazy = { journal: reqOf("/api/ui/v6/session-journal").length, live: reqOf("/api/ui/terminal/sessions").length, journalKids: panel("journal").childElementCount, listKids: panel("list").childElementCount };
    R.recent = listShape($(".shx-results", find));
    R.recentCount = $(".shx-count", find).textContent;
    R.listReq = reqOf("/api/ui/v6/sessions?");
    const input = $(".shx-input", find);
    const [periodSel, projSel, roleSel] = $$(".shx-select", find);
    R.projOptions = [...projSel.options].map((o) => [o.value, o.textContent]);
    //  기간·프로젝트 거르개는 최근 대화에도 걸린다
    pick(projSel, "3870"); await sleep(60);
    R.recentProj = listShape($(".shx-results", find));
    pick(projSel, "0"); await sleep(60);
    R.recentNoProj = listShape($(".shx-results", find));
    pick(projSel, ""); pick(periodSel, "d7"); await sleep(60);
    R.recentD7 = listShape($(".shx-results", find));
    pick(periodSel, "all"); await sleep(60);

    // ── R3 · R8 ──
    reqs = [];
    type(input, "검색");
    await waitFor(() => $$(".shx-hit", find).length === 3);
    R.findReqs = reqOf("/api/ui/v6/session-search/messages");
    R.hits = $$(".shx-results .shx-row", find).map((a) => ({ meta: $(".shx-row-m", a).textContent, text: $(".shx-hit", a).textContent, marks: $$("mark", a).map((m) => m.textContent), ctx: $$(".shx-ctx", a).map((c) => c.textContent) }));
    R.findCount = $(".shx-count", find).textContent;
    R.xss = { pwned: window.PWNED === 1, imgs: $$(".shx-results img, .shx-results b", find).length, text: $$(".shx-hit", find)[2].textContent };

    // ── R4 ──
    reqs = []; pick(roleSel, "user"); await waitFor(() => reqOf("/api/ui/v6/session-search/messages").length >= 1);
    await waitFor(() => $$(".shx-hit", find).length === 2);
    R.roleReq = reqOf("/api/ui/v6/session-search/messages").slice(-1)[0];
    R.roleRows = $$(".shx-hit", find).length;
    reqs = []; pick(roleSel, ""); pick(periodSel, "d7"); await waitFor(() => reqOf("/api/ui/v6/session-search/messages").some((u) => /since=/.test(u)));
    R.sinceReq = reqOf("/api/ui/v6/session-search/messages").slice(-1)[0];
    reqs = []; pick(periodSel, "all"); pick(projSel, "3870"); await waitFor(() => reqOf("/api/ui/v6/session-search/messages").some((u) => /project=3870/.test(u)));
    R.projReq = reqOf("/api/ui/v6/session-search/messages").slice(-1)[0];
    reqs = []; pick(projSel, "0"); await waitFor(() => reqOf("/api/ui/v6/session-search/messages").some((u) => /project=0/.test(u)));
    R.noProjReq = reqOf("/api/ui/v6/session-search/messages").slice(-1)[0];
    reqs = []; pick(projSel, ""); await waitFor(() => reqOf("/api/ui/v6/session-search/messages").length >= 1);
    R.allReq = reqOf("/api/ui/v6/session-search/messages").slice(-1)[0];
    await waitFor(() => $$(".shx-hit", find).length === 3);

    // ── R5 · R6 ──
    reqs = [];
    const pane = $(".shx-pane", find);
    $$(".shx-results .shx-row", find)[0].click();          // AI 말 「검색 배포를 마쳤습니다」(TS 6)
    await waitFor(() => $(".sess-flash", pane), 4000);
    const flashed = $(".sess-flash", pane);
    await waitFor(() => $(".shx-left .shx-act", pane), 3000);
    R.pane = {
      logReq: reqOf("/api/ui/v6/sessions/c1/log"),
      title: $(".sess-title", pane) ? $(".sess-title", pane).textContent : null,
      //  줄에는 «이 지점 링크 복사» 단추가 함께 들어 있다 — 그 글자는 빼고 읽는다.
      flashedId: flashed ? flashed.id : null, flashedText: flashed ? [...flashed.childNodes].filter((n) => !(n.classList && n.classList.contains("sess-line-copy"))).map((n) => n.textContent).join("") : null,
      marks: $$(".sess-main mark.sess-hl", pane).map((m) => m.textContent),
      findBar: $(".sess-find", pane).hidden ? null : $(".sess-find-n", pane).textContent,
      back: $$("a", pane).some((a) => /뒤로/.test(a.textContent)),
      embed: !!$(".sess-embed", pane),
      left: $(".shx-left", pane) ? { acts: $$(".shx-act-title", pane).map((x) => x.textContent), chips: $$(".shx-chip", pane).map((x) => x.textContent), open: ($(".shx-left-open", pane) || {}).textContent || null } : null,
      rowSel: $$(".shx-results .shx-row", find).map((a) => a.classList.contains("sel")),
      door: { resume: $$(".sess-resume", pane).length, open: $$("a.sess-door", pane).map((a) => [a.textContent, a.getAttribute("href")]) },
      clamp: { clamped: $$(".sess-body.clamp", pane).length, more: $$(".sess-more", pane).length },
    };
    const nextBtn = $$(".sess-find button", pane).find((b) => /다음/.test(b.textContent));
    nextBtn.click(); await sleep(80);
    R.afterNext = $(".sess-find-n", pane).textContent;
    const prevBtn = $$(".sess-find button", pane).find((b) => /이전/.test(b.textContent));
    prevBtn.click(); prevBtn.click(); await sleep(80);
    R.afterPrev2 = $(".sess-find-n", pane).textContent;
    //  남의 세션(초대받아 보는 대화록) — 일지가 404 라 「남긴 것」 칸이 없다 · 주인이 아니라 [휴지통으로]도 없다
    $$(".shx-results .shx-row", find)[2].click();
    await waitFor(() => $(".sess-turn", pane) && !$(".shx-left", pane) && /남의 세션/.test(($(".sess-title", pane) || {}).textContent || ""), 4000);
    R.otherPane = { left: !!$(".shx-left", pane), trash: $$("button", pane).some((b) => /휴지통/.test(b.textContent)), title: ($(".sess-title", pane) || {}).textContent, resume: $$(".sess-resume", pane).length };
    $$(".shx-results .shx-row", find)[0].click();
    await waitFor(() => /검색 고치기/.test(($(".sess-title", pane) || {}).textContent || ""), 4000);

    // ── R14 — 줄을 누르고 대화록이 오기 전에 다른 탭으로 갔다가 돌아온다 ──
    {
      let release; logHang = new Promise((z) => { release = z; });
      reqs = [];
      $$(".shx-results .shx-row", find)[1].click();          // 사람 말 「검색을 고쳐 줘」
      tabBtn("journal").click();                             // 대화록 응답이 오기 전에 탭을 옮긴다(일지 탭은 여기서 처음 열린다)
      await sleep(30);
      R.jHash = location.hash;
      R.jStore = localStorage.getItem("lively.sessions.tab");
      release(); logHang = null;
      await waitFor(() => $(".sess-turn", pane), 4000);
      await sleep(400);                                      // 접기 확정(afterPaint)이 돌 시간
      const whileHidden = { hidden: panel("find").hidden, ready: $$(".sess-body", pane).filter((b) => b.dataset.capReady).length };
      R.jReq = jList();                                      // 일지 탭을 처음 열 때의 목록 요청(세션 하나짜리 「남긴 것」 요청은 뺀다)
      tabBtn("find").click(); await sleep(60);
      R.hiddenMount = { whileHidden, clamped: $$(".sess-body.clamp", pane).length, more: $$(".sess-more", pane).length, ready: $$(".sess-body", pane).filter((b) => b.dataset.capReady).length > 0 };
      $$(".shx-results .shx-row", find)[0].click();
      await waitFor(() => $(".sess-flash", pane), 4000);
    }

    // ── R7 ──
    {
      let release; hang = new Promise((z) => { release = z; });
      reqs = []; const before = aborted;
      type(input, "느린"); await sleep(400);                 // 디바운스(250ms)를 지나 요청이 떠난다
      const started = reqOf("/api/ui/v6/session-search/messages").length;
      type(input, "검색"); await waitFor(() => $$(".shx-hit", find).length === 3 && reqOf("/api/ui/v6/session-search/messages").length >= 2);
      const abortedNow = aborted - before;
      release(); await sleep(120);
      R.abort = { started, aborted: abortedNow, rowsAfterLate: $$(".shx-hit", find).length, marks: $$(".shx-results mark", find).map((m) => m.textContent).slice(0, 1) };
      hang = null;
    }
    // ── R13(검색) ──
    MODE.search = "503"; type(input, "검색어"); await waitFor(() => $(".shx-results .install-token-err", find));
    R.search503 = ($(".shx-results .install-token-err", find) || {}).textContent || null;
    MODE.search = "ok"; type(input, "없는말"); await waitFor(() => /맞은 말이 없습니다/.test($(".shx-results", find).textContent));
    R.noHit = { text: $(".shx-results", find).textContent, count: $(".shx-count", find).textContent };
    type(input, "검색"); await waitFor(() => $$(".shx-hit", find).length === 3);

    // ── R9 · R11 ──
    reqs = [];
    tabBtn("journal").click();
    const jr = panel("journal");
    await waitFor(() => $(".shx-jrow", jr));
    R.jReentry = jList().length;                             // 이미 연 탭 — 다시 청하지 않는다
    R.jStats = $$(".shx-stat", jr).map((t) => [$("b", t).textContent, $("span", t).textContent]);
    R.jGroups = $$(".shx-grp", jr).map((g) => g.textContent);
    R.jRows = $$(".shx-jrow", jr).map((r) => ({ t: $(".shx-row-t", r).firstChild.textContent, sum: $(".shx-jsum", r).textContent, none: $(".shx-jsum", r).classList.contains("none"), chips: $$(".shx-chip", r).map((c) => c.textContent), more: !$(".shx-jmore", r).hidden }));
    $(".shx-jhead", jr).click(); await sleep(40);
    {
      const r0 = $(".shx-jrow", jr);
      R.jOpen = { expanded: $(".shx-jhead", r0).getAttribute("aria-expanded"), acts: $$(".shx-jmore .shx-act-title", r0).map((x) => x.textContent), first: ($(".shx-first", r0) || {}).textContent || null, btns: $$(".shx-jacts a, .shx-jacts button", r0).map((b) => b.textContent), nullText: /null|undefined/.test($(".shx-jmore", r0).textContent) };
      //  박스를 모르는 줄(기록만 남은 세션) — 문은 「이어 질문하기」 하나
      const r1 = $$(".shx-jrow", jr)[1];
      $(".shx-jhead", r1).click(); await sleep(40);
      R.jOpenNoBox = $$(".shx-jacts a, .shx-jacts button", r1).map((b) => b.textContent);
      R.jHeadTags = $$(".shx-jhead > *", r0).map((n) => n.tagName);
    }
    $$(".shx-seg-b", jr).find((b) => b.textContent === "프로젝트별").click(); await sleep(40);
    R.jByProj = $$(".shx-grp", jr).map((g) => g.textContent);
    R.jStillOpen = { open: !$(".shx-jmore", $(".shx-jrow", jr)).hidden, acts: $$(".shx-jmore .shx-act-title", $(".shx-jrow", jr)).length };
    $$("button", jr).find((b) => b.textContent === "요약 복사").click(); await sleep(60);
    R.copied = copied;
    //  기간을 연달아 바꾼다 — 「지난 주」(요청이 떠 있다) 답이 오기 전에 「최근 30일」: 앞 요청은 끊기고 뒤 것만 그려진다
    {
      reqs = [];
      const n0 = journalSignals.length;
      $$(".shx-seg-b", jr).find((b) => b.textContent === "지난 주").click();
      await sleep(5);
      $$(".shx-seg-b", jr).find((b) => b.textContent === "최근 30일").click();
      await waitFor(() => jList().length >= 2);
      await sleep(150);
      const [lastWeek, d30] = jList();
      R.jLastWeekReq = lastWeek; R.jD30Req = d30;
      R.jAbort = { made: journalSignals.length - n0, firstAborted: !!(journalSignals[n0] && journalSignals[n0].aborted), secondAborted: !!(journalSignals[n0 + 1] && journalSignals[n0 + 1].aborted), rows: $$(".shx-jrow", jr).length, range: ($(".shx-range", jr) || {}).textContent || "" };
    }
    //  끊긴 「지난 주」는 캐시에 없다 — 다시 누르면 청한다(이번엔 서버가 500)
    MODE.journal = "500";
    $$(".shx-seg-b", jr).find((b) => b.textContent === "지난 주").click(); await waitFor(() => $(".install-token-err", jr));
    R.j500 = { text: ($(".install-token-err", jr) || {}).textContent || null };
    MODE.journal = "ok";
    //  탭을 오가도 보던 자리가 남는다
    tabBtn("find").click(); await sleep(40);
    R.back = { hash: location.hash, q: input.value, hits: $$(".shx-hit", find).length, paneTitle: ($(".sess-title", pane) || {}).textContent, hidden: ["find", "journal", "list"].map((k) => panel(k).hidden) };

    // ── R10 ──
    reqs = [];
    tabBtn("list").click();
    const ls = panel("list");
    await waitFor(() => $(".shx-tr", ls));
    const rowsOf = () => $$(".shx-tr", ls).map((tr) => [...tr.children].map((td) => td.textContent));
    R.lReqs = { live: reqOf("/api/ui/terminal/sessions"), logs: reqOf("/api/ui/v6/sessions?").length };
    R.lRows = rowsOf().map((r) => [r[0], r[1], r[2]]);
    R.lCount = $(".shx-count", ls).textContent;
    const seg = (t) => $$(".shx-bar .shx-seg-b", ls).find((b) => b.textContent === t);
    seg("실행 중").click(); await sleep(30); R.lLive = rowsOf().map((r) => r[0]);
    seg("오프라인").click(); await sleep(30); R.lOff = rowsOf().map((r) => r[0]);
    seg("기록만").click(); await sleep(30); R.lRec = rowsOf().map((r) => r[0]);
    seg("전체").click(); await sleep(30);
    type($(".shx-input", ls), "ㄷ 재시안"); await sleep(30); R.lFind = rowsOf().map((r) => r[0]);
    type($(".shx-input", ls), ""); await sleep(30);
    $$(".shx-th", ls).find((b) => b.textContent.startsWith("세션")).click(); await sleep(30);
    R.lSortAsc = rowsOf().map((r) => r[0]);
    R.lAriaSort = $$("th", ls).map((t) => t.getAttribute("aria-sort"));
    $$(".shx-th", ls).find((b) => b.textContent.startsWith("세션")).click(); await sleep(30);
    R.lSortDesc = rowsOf().map((r) => r[0]);
    $$(".shx-th", ls).find((b) => b.textContent.startsWith("마지막")).click(); await sleep(30);
    const lpane = $(".shx-pane", ls);
    $$(".shx-tr", ls).find((tr) => /검색 고치기/.test(tr.textContent)).click();
    await waitFor(() => $(".sess-turn", lpane), 4000);
    R.lBox = { resume: $$("button", lpane).some((b) => /이어 질문하기/.test(b.textContent)), open: $$("a", lpane).filter((a) => a.textContent === "세션 열기").map((a) => a.getAttribute("href")), turns: $$(".sess-turn", lpane).length };
    $$(".shx-seg-b", lpane).find((b) => b.textContent === "정보").click();
    await waitFor(() => $(".shx-info", lpane) && $(".shx-left .shx-act", lpane), 3000);
    R.lInfo = { rows: $$(".shx-info tr", lpane).map((tr) => [...tr.children].map((c) => c.textContent)), left: !!$(".shx-left", lpane) };
    //  기록만 남은 세션 — 「이어 질문하기」가 있고 [세션 열기]는 없다
    $$(".shx-seg-b", lpane).find((b) => b.textContent === "기록 보기").click();
    $$(".shx-tr", ls).find((tr) => /옛 조사/.test(tr.textContent)).click();
    await waitFor(() => $(".sess-turn", $(".shx-pane", ls)) && /옛 조사/.test(($(".sess-title", $(".shx-pane", ls)) || {}).textContent || ""), 4000);
    R.lRecOnly = { resume: $$("button", $(".shx-pane", ls)).filter((b) => /이어 질문하기/.test(b.textContent)).length, open: $$("a", $(".shx-pane", ls)).filter((a) => a.textContent === "세션 열기").length };
    //  기록이 아직 없는 도는 세션
    $$(".shx-tr", ls).find((tr) => /기록 없는 새 세션/.test(tr.textContent)).click(); await sleep(60);
    R.lNoRec = $(".shx-detail-body", ls).textContent;
    // ── R15 — 찾기 칸이 같은 세션(c1)의 대화록을 들고 있는 채로, 목록 칸의 질문 목차를 누른다 ──
    $$(".shx-tr", ls).find((tr) => /검색 고치기/.test(tr.textContent)).click();
    await waitFor(() => $$(".sess-side-item", $(".shx-pane", ls)).length === 2, 4000);
    R.sameIds = { find: !!$("#turn-1", panel("find")), list: !!$("#turn-1", panel("list")) };
    SCROLLED.length = 0;
    $$(".sess-side-item", $(".shx-pane", ls))[1].click(); await sleep(30);
    R.tocScrolled = SCROLLED.slice();
    // ── R16 — [세션 열기]: 셸 밖(이 시험의 기본)에서는 세션 터미널 창 ──
    OPENED.length = 0;
    const hashBefore = location.hash;
    $$("a", $(".shx-pane", ls)).find((a) => a.textContent === "세션 열기").click(); await sleep(30);
    R.openOutside = { opened: OPENED.map((o) => [/box-1/.test(o[0]), o[1]]), hashSame: location.hash === hashBefore };
    //  셸 안 — 셸 문서(#v2-root)가 있으면 그 세션 화면 주소를 셸에 부탁한다
    const shellRoot = document.createElement("div"); shellRoot.id = "v2-root"; document.body.append(shellRoot);
    OPENED.length = 0;
    $$("a", $(".shx-pane", ls)).find((a) => a.textContent === "세션 열기").click(); await sleep(30);
    R.openInShell = { asked: MSGS.slice(), hash: location.hash, opened: OPENED.length };
    shellRoot.remove();

    // ── R11(주소로 열기) · R12 ──
    reqs = [];
    await open("#/sessions?tab=journal");
    await waitFor(() => $(".shx-jrow", panel("journal")));
    R.deep = { selected: $$("[role=tab]").filter((b) => b.getAttribute("aria-selected") === "true").map((b) => b.textContent), findKids: panel("find").childElementCount, findReqs: reqOf("/api/ui/v6/sessions?").length };
    await open("#/sessions?tab=find&q=" + encodeURIComponent("검색"));
    await waitFor(() => $$(".shx-hit", panel("find")).length === 3);
    R.deepQ = { q: $(".shx-input", panel("find")).value, hits: $$(".shx-hit", panel("find")).length };
    // ── R18 — 일지 캐시(30초)가 지난 뒤, 「이번 주」가 비어 있는 서버 ──
    await sleep(31_000);
    await open("#/sessions?tab=journal");                   // 앞 장면이 고른 기간(지난 주)으로 다시 열린다 — 줄이 선다
    await waitFor(() => $(".shx-jrow", panel("journal")));
    {
      const jr2 = panel("journal");
      MODE.journal = "empty";                                // 「이번 주」만 비어 있다
      $$(".shx-seg-b", jr2).find((b) => b.textContent === "이번 주").click();
      await waitFor(() => /아직 없습니다/.test($(".shx-journal", jr2).textContent));
      R.emptyWeek = { text: $(".shx-journal .admin-hint", jr2).textContent, btn: $$(".shx-journal button", jr2).map((b) => b.textContent) };
      MODE.journal = "ok";
      $$(".shx-journal button", jr2).find((b) => b.textContent === "지난 주 보기").click();
      await waitFor(() => $(".shx-jrow", panel("journal")));
      const jr3 = panel("journal");
      R.afterLastWeek = { rows: $$(".shx-jrow", jr3).length, on: $$(".shx-bar .shx-seg-b.on", jr3).map((b) => b.textContent) };
    }
    await open("#/sessions?tab=find");

    // ── R17 ──
    reqs = [];
    type($(".shx-input", panel("find")), "늦은말");          // 디바운스(250ms)가 걸린 채로
    await open("#/sessions/c1?node=");                       // 대화록 단독 화면으로 간다
    await waitFor(() => $(".sess-turn"));
    await sleep(400);
    R.lateTimer = { hash: location.hash, reqs: reqOf("/api/ui/v6/session-search/messages").filter((u) => /%EB%8A%A6%EC%9D%80%EB%A7%90/.test(u)).length };
    R.page = { back: $$("a").filter((a) => /뒤로/.test(a.textContent)).map((a) => a.getAttribute("href")), tabs: $$("[role=tab]").length, card: !!$(".card .sess-layout"), embed: !!$(".sess-embed"), resume: $$("button").some((b) => /이어 질문하기/.test(b.textContent)) };
  } catch (e) { R.err = String(e && e.stack || e); }

  R.pageErrors = pageErrors;
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const PAGE = `<!doctype html><html data-theme="light" lang="ko"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><body data-route="sessions"><div id="toasts"></div><main id="view"></main><pre id="out">PENDING</pre>
<script type="text/plain" id="appsrc">${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;

if (process.env.DUMP_PAGE) { const fs = await import("node:fs"); fs.writeFileSync(process.env.DUMP_PAGE, PAGE); for (const f of CSS) fs.copyFileSync(f, path.join(path.dirname(process.env.DUMP_PAGE), path.basename(f))); }
const dom = await dumpDom(chrome, { html: PAGE, copy: CSS, prefix: "session-history-", virtualTimeBudget: 90000, args: ["--window-size=1400,900"] });
const m = /<pre id="out">([\s\S]*?)ENDRESULT/.exec(dom);
if (!m) { console.error("FAIL  결과 표지를 못 받았다\n" + dom.slice(0, 1500)); process.exit(1); }
const txt = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const R = JSON.parse(txt);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why) => (cond ? ok(n) : bad(n, why));
const same = (got, want, n) => { const a = JSON.stringify(got), b = JSON.stringify(want); return a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };
for (const k of ["fatal", "err"]) if (R[k]) bad(`장면 오류 ${k}`, String(R[k]).slice(0, 900));
const param = (u, k) => new URL(u || "/", "http://x").searchParams.get(k);

// R1
same(R.tabs, [["대화 찾기", "true"], ["작업 일지", "false"], ["세션 목록", "false"]], "R1 가로탭 셋 · 처음엔 「대화 찾기」");
same(R.panelsHidden, [false, true, true], "R1 켜진 탭의 칸만 보인다");
same(R.lazy, { journal: 0, live: 0, journalKids: 0, listKids: 0 }, "R1 안 연 탭은 그리지도 부르지도 않는다");
// R2
same(R.recent, ["# 오늘", "검색 고치기", "위젯 기획", "# 최근 7일", "덱 재시안", "# 그 이전", "옛 조사"], "R2 최근 대화 — 날짜 묶음 · 휴지통·빈 세션은 없다");
check(/최근 대화 4개/.test(R.recentCount || ""), "R2 수를 말한다", R.recentCount);
check((R.listReq || []).length === 1 && /limit=2000/.test(R.listReq[0]), "R2 목록은 서버 상한까지 한 번 청한다", JSON.stringify(R.listReq));
same(R.projOptions, [["", "모든 프로젝트"], ["3870", "통합검색"], ["4135", "UI 수정"], ["0", "프로젝트 없음"]], "R2 프로젝트 고르개 = 내 세션이 붙은 프로젝트(겹치지 않게) + 프로젝트 없음");
same(R.recentProj, ["# 오늘", "검색 고치기", "# 그 이전", "옛 조사"], "R2 프로젝트로 좁힌 최근 대화");
same(R.recentNoProj, ["# 최근 7일", "덱 재시안"], "R2 「프로젝트 없음」으로 좁힌 최근 대화");
same(R.recentD7, ["# 오늘", "검색 고치기", "위젯 기획", "# 최근 7일", "덱 재시안"], "R2 기간으로 좁힌 최근 대화");
// R3
check((R.findReqs || []).length === 1 && param(R.findReqs[0], "q") === "검색" && param(R.findReqs[0], "limit") === "30" && !/since=|role=|project=/.test(R.findReqs[0]), "R3 검색어 → 맞은 말 단위 요청 한 번(q · limit, 거르개 없음)", JSON.stringify(R.findReqs));
same((R.hits || []).map((h) => h.text), ["검색 배포를 마쳤습니다", "검색을 고쳐 줘", "<img src=x onerror=window.PWNED=1> 검색 <b>굵게</b>"], "R3 줄 = 맞은 말");
same((R.hits || [])[0] && [R.hits[0].marks, R.hits[0].ctx], [["검색"], ["나 · 배포까지 해 줘"]], "R3 낱말 색칠 · 앞 말(뒤 말이 없으면 없다)");
same((R.hits || [])[1] && R.hits[1].ctx, ["AI · 먼저 살펴보겠습니다"], "R3 첫 말은 뒤 말만");
check(/검색 고치기/.test(R.hits?.[0]?.meta || "") && /통합검색/.test(R.hits[0].meta) && /AI 답/.test(R.hits[0].meta) && /내 지시/.test(R.hits[1].meta) && /프로젝트 없음/.test(R.hits[2].meta), "R3 줄 머리 = 세션 · 프로젝트 · 시각 · 말한 쪽", JSON.stringify((R.hits || []).map((h) => h.meta)));
check(/맞은 말 7곳/.test(R.findCount || "") && /세션 2개/.test(R.findCount) && /색인을 만드는 중/.test(R.findCount) && /3개/.test(R.findCount), "R3 총계와 색인 중 안내", R.findCount);
// R8
same(R.xss, { pwned: false, imgs: 0, text: "<img src=x onerror=window.PWNED=1> 검색 <b>굵게</b>" }, "R8 대화 본문의 태그는 글자로만 선다");
// R4
check(param(R.roleReq, "role") === "user" && R.roleRows === 2, "R4 말한 쪽이 요청에 실린다", JSON.stringify({ req: R.roleReq, rows: R.roleRows }));
check(Number.isFinite(Date.parse(param(R.sinceReq, "since") || "")) && !param(R.sinceReq, "role"), "R4 기간이 since(ISO)로 실린다 · 푼 거르개는 빠진다", R.sinceReq);
check(param(R.projReq, "project") === "3870" && !param(R.projReq, "since"), "R4 프로젝트가 요청에 실린다", R.projReq);
check(param(R.noProjReq, "project") === "0", "R4 「프로젝트 없음」은 project=0", R.noProjReq);
check(param(R.allReq, "project") === null, "R4 「모든 프로젝트」는 project 를 싣지 않는다", R.allReq);
// R5
check((R.pane?.logReq || []).length === 1 && /view=render/.test(R.pane.logReq[0]), "R5 줄을 누르면 그 세션의 대화록을 청한다", JSON.stringify(R.pane?.logReq));
same(R.pane && [R.pane.flashedId, R.pane.flashedText], ["ln-1-a0-0", "검색 배포를 마쳤습니다"], "R5 고른 말의 자리가 열린다(시각으로 찾은 블록)");
same(R.pane?.marks, ["검색", "검색", "검색"], "R5 대화록에서 낱말이 칠해진다(도구 호출 줄은 칠하지 않는다)");
check(/이 대화에서 3곳/.test(R.pane?.findBar || "") && /3번째/.test(R.pane.findBar), "R5 「이 대화에서 n곳」 — 고른 말이 몇 번째인지부터", R.pane?.findBar);
check(/1번째/.test(R.afterNext || ""), "R5 [다음] — 끝에서 처음으로 돈다", R.afterNext);
check(/2번째/.test(R.afterPrev2 || ""), "R5 [이전] 두 번 — 처음에서 끝으로 돌아 2번째", R.afterPrev2);
same(R.pane?.rowSel, [true, false, false], "R5 고른 줄만 표시된다");
same(R.pane?.title, "검색 고치기", "R5 대화록 머리 = 목록이 아는 세션 이름");
// R6
same(R.pane && [R.pane.back, R.pane.embed], [false, true], "R6 칸 안 대화록엔 「← 뒤로」가 없다");
same(R.pane?.left, { acts: ["대화 검색 추가", "배포 기록"], chips: ["지식 · 통합검색 as-built", "태스크 · #4517 대화 검색 · 완료", "커밋 1", "고친 파일 4"], open: "세션 열기 →" }, "R6 「이 세션이 남긴 것」 — 작업 기록 · 지식 · 태스크 · 커밋 · 고친 파일 · 세션으로 가는 문");
same(R.otherPane, { left: false, trash: false, title: "남의 세션", resume: 1 }, "R6 남의 세션(일지 404)은 그 칸도 [휴지통으로]도 없다");
same(R.pane?.door, { resume: 0, open: [["세션 열기", "#/s/box-1"]] }, "R6 박스를 알게 되면 대화록 머리의 문이 [세션 열기] 하나로 바뀐다");
same(R.pane?.clamp, { clamped: 1, more: 1 }, "R5 긴 답변은 접혀 있다(10줄 캡 · 더보기)");
same(R.hiddenMount, { whileHidden: { hidden: true, ready: 0 }, clamped: 1, more: 1, ready: true }, "R14 감춰진 칸에 실린 대화록 — 감춰진 동안엔 접기를 확정하지 않고, 다시 보면 긴 답변이 접혀 있다");
// R7
check(R.abort && R.abort.started === 1 && R.abort.aborted === 1, "R7 글자를 더 치면 앞 요청을 끊는다", JSON.stringify(R.abort));
same(R.abort && [R.abort.rowsAfterLate, R.abort.marks], [3, ["검색"]], "R7 늦게 온 앞 요청의 답이 화면을 덮지 않는다");
// R13
check(/시간 안에 끝나지 않았습니다/.test(R.search503 || ""), "R13 검색 503 — 서버가 말한 이유를 그대로", R.search503);
check(/맞은 말이 없습니다/.test(R.noHit?.text || "") && !/맞은 말 0곳/.test(R.noHit.count || ""), "R13 결과 없음 — 0곳이라고 세지 않고 넓혀 보라고 말한다", JSON.stringify(R.noHit));
// R9
same(R.jHash, "#/sessions?tab=journal", "R11 주소에 탭이 적힌다");
same(R.jStore, "journal", "R11 마지막 탭을 기억한다");
same(R.jReentry, 0, "R11 이미 연 탭으로 돌아오면 다시 청하지 않는다");
check((R.jReq || []).length === 1 && Number.isFinite(Date.parse(param(R.jReq[0], "since") || "")) && Number.isFinite(Date.parse(param(R.jReq[0], "until") || "")) && Date.parse(param(R.jReq[0], "until")) - Date.parse(param(R.jReq[0], "since")) >= 6.9 * 86_400_000, "R9 이번 주 = since·until 로 한 번 청한다", JSON.stringify(R.jReq));
same(R.jStats, [["3", "세션"], ["2", "프로젝트"], ["2", "한 일(기록)"], ["1", "만든 지식"], ["1", "태스크"]], "R9 합계");
check((R.jGroups || []).length === 2 && /^오늘 · /.test(R.jGroups[0]) && / · 2$/.test(R.jGroups[0]) && / · 1$/.test(R.jGroups[1]), "R9 날짜 묶음(오늘 2 · 그 전 1)", JSON.stringify(R.jGroups));
same(R.jRows?.[0], { t: "검색 고치기", sum: "배포 기록 외 1건", none: false, chips: ["지식 · 통합검색 as-built", "태스크 · #4517 대화 검색 · 완료", "커밋 1", "고친 파일 4"], more: false }, "R9 줄 — 가장 늦은 기록의 제목 + 남긴 것 · 처음엔 접혀 있다");
same(R.jRows?.[1] && [R.jRows[1].sum, R.jRows[1].none], ["기록된 작업 없음 · 첫 지시: 첫 지시 위젯 기획", true], "R9 기록 없는 세션은 그렇다고 말하고 첫 지시를 보인다");
same(R.jOpen, { expanded: "true", acts: ["대화 검색 추가", "배포 기록"], first: "첫 지시첫 지시 검색 고치기", btns: ["세션 열기", "대화록 열기"], nullText: false }, "R9 줄을 누르면 기록·첫 지시·단추가 펼쳐진다(«null» 글자 없음) · 박스가 있으면 문은 [세션 열기] 하나");
same(R.jOpenNoBox, ["이어 질문하기", "대화록 열기"], "R9 박스를 모르는 줄의 문은 「이어 질문하기」 하나");
same(R.jHeadTags, ["SPAN", "SPAN"], "R9 줄 머리 단추 안에는 span 만(단추 안에 div 를 두지 않는다)");
same(R.jRows?.[2] && [R.jRows[2].sum, R.jRows[2].none], ["이 기간에 적은 기록 없음 · 이전 기록 2건", true], "R9 앞선 기간에만 기록이 있는 세션은 그렇다고 말한다(«기록된 작업 없음» 이 아니다)");
same(R.jAbort && [R.jAbort.made, R.jAbort.firstAborted, R.jAbort.secondAborted, R.jAbort.rows], [2, true, false, 3], "R9 기간을 연달아 바꾸면 앞 요청을 끊고 뒤 것만 그린다");
check((R.jByProj || []).length === 3 && /^통합검색/.test(R.jByProj[0]) && /^UI 수정/.test(R.jByProj[1]) && /^프로젝트 없음/.test(R.jByProj[2]), "R9 프로젝트별 — 「프로젝트 없음」이 맨 아래", JSON.stringify(R.jByProj));
same(R.jStillOpen, { open: true, acts: 2 }, "R9 다시 묶어도 펼친 줄은 펼쳐져 있고 내용도 그대로다");
check(/^작업 일지 · /.test(R.copied || "") && /세션 3 · 프로젝트 2 · 한 일 2 · 지식 1 · 태스크 1/.test(R.copied) && /\[통합검색\]\n- 대화 검색 추가 \(지식: 통합검색 as-built\)\n- 배포 기록/.test(R.copied) && /- 위젯 기획 \(기록 없음\)/.test(R.copied), "R9 [요약 복사] — 그 기간의 글이 클립보드에", JSON.stringify(R.copied));
check(Date.parse(param(R.jLastWeekReq, "until") || "") <= Date.parse(param(R.jReq?.[0], "since") || "") + 1000, "R9 지난 주 = 이번 주 시작 전까지", JSON.stringify([R.jLastWeekReq, R.jReq]));
check(/서버|불러오지 못했|internal_error/.test(R.j500?.text || ""), "R13 일지 500 — 실패를 말한다(빈 일지로 보이지 않는다)", JSON.stringify(R.j500));
check(!!R.jD30Req && param(R.jD30Req, "until") === null && Number.isFinite(Date.parse(param(R.jD30Req, "since") || "")), "R9 최근 30일은 until 없이 청한다", JSON.stringify(R.jD30Req));
same(R.back, { hash: "#/sessions?tab=find&q=%EA%B2%80%EC%83%89", q: "검색", hits: 3, paneTitle: "검색 고치기", hidden: [false, true, true] }, "R11 탭을 오가도 검색어·결과·고른 대화록이 그대로다 · 주소에 검색어");
// R10
check((R.lReqs?.live || []).length === 1 && /includeProjects=1/.test(R.lReqs.live[0]) && R.lReqs.logs === 0, "R10 세션 목록 탭 — 도는 세션을 한 번 청하고 기록은 이미 받은 것을 쓴다", JSON.stringify(R.lReqs));
same(R.lRows, [["기록 없는 새 세션", "", "대기 중"], ["검색 고치기", "통합검색", "작업 중"], ["위젯 기획", "UI 수정", "기록만"], ["오프라인 세션", "", "오프라인"], ["덱 재시안", "", "중단됨"], ["옛 조사", "통합검색", "기록만"]], "R10 도는 세션과 기록이 한 줄씩 — 마지막 활동이 늦은 것부터 · 휴지통·빈 세션·남의 세션 없음");
check(/세션 6개/.test(R.lCount || "") && /실행 중 2/.test(R.lCount) && /오프라인 1/.test(R.lCount) && /기록만 3/.test(R.lCount), "R10 수 — 전체 · 실행 중 · 오프라인 · 기록만", R.lCount);
same(R.lLive, ["기록 없는 새 세션", "검색 고치기"], "R10 「실행 중」 = 지금 쓰이는 것(오프라인은 아니다)");
same(R.lOff, ["오프라인 세션"], "R10 「오프라인」 = 박스는 있지만 지금 쓰이지 않는 것");
same(R.lRec, ["위젯 기획", "덱 재시안", "옛 조사"], "R10 「기록만」 = 박스가 없고 읽을 기록이 있는 것");
same(R.lFind, ["덱 재시안"], "R10 이름으로 거르기(초성 · 낱말 둘)");
same(R.lSortAsc, ["검색 고치기", "기록 없는 새 세션", "덱 재시안", "옛 조사", "오프라인 세션", "위젯 기획"], "R10 열 머리 — 세션 이름 오름차순");
same(R.lAriaSort, ["ascending", "none", "none", "none"], "R10 정렬 열이 aria-sort 로 실린다");
same(R.lSortDesc, ["위젯 기획", "오프라인 세션", "옛 조사", "덱 재시안", "기록 없는 새 세션", "검색 고치기"], "R10 같은 열을 다시 누르면 내림차순");
same(R.lBox, { resume: false, open: ["#/s/box-1"], turns: 2 }, "R10 박스 있는 줄 — 대화록에 「이어 질문하기」가 없고 [세션 열기]가 그 세션으로");
check((R.lInfo?.rows || []).some((r) => r[0] === "상태" && r[1] === "작업 중") && R.lInfo.rows.some((r) => r[0] === "프로젝트" && r[1] === "통합검색") && R.lInfo.rows.some((r) => r[0] === "첫 지시") && R.lInfo.left === true, "R10 정보 탭 — 상태·프로젝트·첫 지시 + 남긴 것", JSON.stringify(R.lInfo));
same(R.lRecOnly, { resume: 1, open: 0 }, "R10 기록만 남은 줄 — 「이어 질문하기」가 하나 있고 [세션 열기]는 없다");
check(/아직 중앙에 올라온 대화 기록이 없습니다/.test(R.lNoRec || ""), "R10 기록이 아직 없는 도는 세션은 그렇다고 말한다", R.lNoRec);
same(R.sameIds, { find: true, list: true }, "R15 배선 — 두 칸이 같은 번호의 턴을 들고 있다");
same(R.tocScrolled, ["shx-panel-list"], "R15 질문 목차는 제 칸의 그 질문으로 간다(문서 전체에서 찾지 않는다)");
same(R.openOutside, { opened: [[true, "lively-term-box-1"]], hashSame: true }, "R16 셸 밖 — [세션 열기]는 세션 터미널 창을 연다(#/s/ 주소로 가지 않는다)");
same(R.openInShell && [R.openInShell.asked, R.openInShell.opened], [["#/s/box-1"], 0], "R16 셸 안 — [세션 열기]는 터미널 창이 아니라 그 세션 화면 주소를 셸에 부탁한다");
// R11 · R12
same(R.deep, { selected: ["작업 일지"], findKids: 0, findReqs: 0 }, "R11 주소의 ?tab= 으로 그 탭이 열린다 — 다른 탭은 그리지 않는다");
same(R.deepQ, { q: "검색", hits: 3 }, "R11 주소의 q 로 찾던 말이 되살아난다");
same(R.emptyWeek, { text: "이번 주에 한 세션이 아직 없습니다.", btn: ["지난 주 보기"] }, "R18 빈 「이번 주」 — 그렇다고 말하고 지난 주로 가는 문을 둔다");
same(R.afterLastWeek, { rows: 3, on: ["지난 주", "프로젝트별"] }, "R18 [지난 주 보기] → 지난 주가 켜지고 그 줄이 선다(묶는 기준은 고른 그대로)");
same(R.lateTimer, { hash: "#/sessions/c1?node=", reqs: 0 }, "R17 떠난 화면의 찾기 타이머는 주소를 덮지 않고 요청도 내지 않는다");
check(!!R.page && R.page.back.length === 1 && /^#\/sessions/.test(R.page.back[0]) && R.page.tabs === 0 && R.page.card === true && R.page.embed === false && R.page.resume === true, "R12 대화록 단독 화면은 그대로 — 「← 뒤로」 · 탭 없음", JSON.stringify(R.page));
// W
check(Array.isArray(R.pageErrors) && R.pageErrors.length === 0, "W 페이지 오류 0", JSON.stringify(R.pageErrors));

console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
