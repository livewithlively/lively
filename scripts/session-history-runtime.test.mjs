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
//  R19 일지 옆 칸(기간 요약) — 하루하루 막대(빈 날 포함 · 합 = 세션 수) · 프로젝트 · 만든 지식 · 태스크 · 누르면 그 묶음으로
//  R20 [대화록 열기]는 창으로 — 주소·일지 그대로 · 박스를 아는 줄은 문이 처음부터 [세션 열기] · Esc / [닫기]
//  R21 좁은 칸(셸 액자) — 질문 목차는 서랍([목차] · Esc · 목차 누르기), 「남긴 것」은 읽기 칸 맨 위 · 넓어지면 옆 칸으로
//  R22 찾기 칸의 [지우기] — 글자가 있을 때만 · 누르면 최근 대화로
//  R25 떠난 대화록의 「남긴 것」 답이 늦게 와도 새로 선 대화록의 문을 바꾸지 않는다
//  R24 대화록의 답이 오기 전에 「정보」로 옮기면, 늦게 온 답이 함께 쓰는 머리(부르는 쪽이 세운 머리)를 건드리지 않는다
//  (디자인 개편 2026-10-05 — 원준 «프로젝트 본문 창 참고해서 그 디자인 언어로»: 구조가 바뀐 자리는 새 구조로 잰다)
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
  stdin: { contents: "export { renderSessions } from './web/sessions-app.ts'; export { refreshTranscripts } from './web/sessions.ts';", resolveDir: SRC_ROOT, loader: "ts" },
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
    { role: "tool", tool: "Grep", text: "검색 omni", ts: TS(1) },   // 도구 호출 줄에도 찾는 낱말이 있다 — 대화의 글이 아니라 칠하지 않는다
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
  let rowHang = null;        // 세션 하나의 일지 줄(「남긴 것」) 응답을 매달아 둘 약속(창의 문 장면)
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
if (P.get("session_id")) { const r = JOURNAL.find((x) => x.session_id === P.get("session_id")); const out = () => (r ? json({ row: r }) : json({ error: "세션을 찾을 수 없습니다" }, 404)); return rowHang ? rowHang.then(out) : Promise.resolve(out()); }
      if (MODE.journal === "500") return Promise.resolve(json({ error: "internal_error" }, 500));
if (MODE.journal === "empty") return Promise.resolve(json({ rows: [], truncated: false }));
      const many = MODE.journal === "many" ? [{ ...JOURNAL[0], knowledge: Array.from({ length: 8 }, (_, i) => ({ name: "kn-" + i, title: "지식 " + (i + 1) })) }, JOURNAL[1], JOURNAL[2]] : null;
      journalSignals.push(init && init.signal ? init.signal : null);
      //  조금 늦게 답한다 — 연달아 기간을 바꿨을 때 앞 요청이 아직 떠 있게.
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(json({ rows: many || JOURNAL, truncated: false })), 40);
        if (init && init.signal) init.signal.addEventListener("abort", () => { clearTimeout(t); const e = new Error("aborted"); e.name = "AbortError"; reject(e); });
      });
    }
if (u.startsWith("/api/ui/terminal/session-trash")) return Promise.resolve(json({ done: JSON.parse(init.body).ids, skipped: [] }));
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
  const listShape = (root) => [...root.children].map((n) => n.classList.contains("shx-grp") ? "# " + $(".shx-grp-l", n).textContent : n.classList.contains("shx-row") ? ($(".shx-row-t", n) ? $(".shx-row-t", n).textContent : "hit") : n.classList.contains("shx-empty") ? "empty: " + $(".shx-empty-t", n).textContent : n.tagName.toLowerCase());
  const grpText = (g) => $(".shx-grp-l", g).textContent + " · " + $(".shx-grp-n", g).textContent;   // 묶음 머리 = 이름 + 그 묶음의 수
  const byLabel = (root, re) => $$("button, a", root).find((b) => re.test(b.getAttribute("aria-label") || ""));
  const shown = (n) => !!n && getComputedStyle(n).display !== "none";   // hidden 속성이 display 규칙에 덮이지 않았나까지 본다
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
    R.recentGrpN = $$(".shx-results .shx-grp", find).map(grpText);
    R.recentCount = $(".shx-count", find).textContent;
    R.listReq = reqOf("/api/ui/v6/sessions?");
    const input = $(".shx-input", find);
    const [periodSel, projSel, roleSel] = $$(".shx-select", find);
    R.projOptions = [...projSel.options].map((o) => [o.value, o.textContent]);
    //  기간·프로젝트 거르개는 최근 대화에도 걸린다
    pick(projSel, "3870"); await sleep(60);
    R.recentProj = listShape($(".shx-results", find));
    const pickOn = [projSel.parentElement.classList.contains("on"), periodSel.parentElement.classList.contains("on")];
    pick(projSel, "0"); await sleep(60);
    R.recentNoProj = listShape($(".shx-results", find));
    pick(projSel, ""); pick(periodSel, "d7"); await sleep(60);
    R.recentD7 = listShape($(".shx-results", find));
    pick(periodSel, "all"); await sleep(60);
    R.pickOn = [...pickOn, projSel.parentElement.classList.contains("on")];

    // ── R3 · R8 ──
    reqs = [];
    type(input, "검색");
    await waitFor(() => $$(".shx-hit", find).length === 3);
    R.findReqs = reqOf("/api/ui/v6/session-search/messages");
R.hits = $$(".shx-results .shx-row", find).map((a) => ({ meta: [$(".shx-role", a).textContent, $(".shx-row-n", a).textContent, $(".shx-row-when", a).textContent, $(".shx-row-f", a).textContent].join(" | "), text: $(".shx-hit", a).textContent, marks: $$("mark", a).map((m) => m.textContent), ctx: $$(".shx-ctx", a).map((c) => $("b", c).textContent + " · " + $("span", c).textContent) }));
    R.findCount = $(".shx-count", find).textContent;
//  맞은 말·앞뒤 말 안에는 글자만 선다(줄 머리의 이름은 화면이 세운 <b> 다 — 그것은 세지 않는다).
    R.xss = { pwned: window.PWNED === 1, imgs: $$(".shx-results img, .shx-hit b, .shx-ctx span b", find).length, text: $$(".shx-hit", find)[2].textContent };
    //  찾기 칸의 [지우기] — 글자가 있을 때만 보이고, 누르면 최근 대화로 돌아간다(주소의 q 도 걷힌다)
    {
      const x = $(".shx-search-x", find);
      const was = shown(x);
      x.click(); await waitFor(() => !$(".shx-hit", find) && $(".shx-row-t", find));
      R.clear = { shown: was, hiddenAfter: !shown(x), value: input.value, recent: $$(".shx-results .shx-row-t", find).length, hash: location.hash, reqs: reqOf("/api/ui/v6/session-search/messages").length };
      reqs = []; type(input, "검색"); await waitFor(() => $$(".shx-hit", find).length === 3);
    }

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
left: $(".shx-left", pane) ? { acts: $$(".shx-act-title", pane).map((x) => x.textContent), types: $$(".shx-left .shx-type", pane).map((x) => x.textContent), chips: $$(".shx-chip", pane).map((x) => x.textContent), kinds: $$(".shx-chip", pane).map((x) => x.className.replace("shx-chip", "").trim()), inRail: !!$(".sess-side .shx-left", pane), doors: $$(".shx-left a", pane).filter((a) => /세션 열기/.test(a.textContent)).length } : null,
      sub: ($(".shx-ph-sub", pane) || {}).textContent || "", turnHead: $$(".sess-turn-n", pane).map((x) => x.textContent), headMarks: $$(".sess-turn-h mark, .sess-toolbox mark, .sess-side mark", pane).length, toolText: $$(".sess-tool span", pane).map((x) => x.textContent),
rowSel: $$(".shx-results .shx-row", find).map((a) => a.classList.contains("sel")), rowCur: $$(".shx-results .shx-row", find).map((a) => a.getAttribute("aria-current")),
      wide: { narrow: $(".sess-wrap", pane).classList.contains("narrow"), btn: shown($(".sess-rail-btn", pane)), side: shown($(".sess-side", pane)) },
      door: { resume: $$(".sess-resume", pane).length, open: $$("a.sess-door", pane).map((a) => [a.textContent, a.getAttribute("href")]) },
      clamp: { clamped: $$(".sess-body.clamp", pane).length, more: $$(".sess-more", pane).length },
    };
    //  도구 호출 줄 — 접혀 있다가 누르면 펼쳐진다
    {
      const tb = $(".sess-tools", pane), td = $(".sess-tools-d", pane);
      const before = [shown(td), tb.getAttribute("aria-expanded")];
      tb.click();
      R.toolFold = { before, after: [shown(td), tb.getAttribute("aria-expanded")], label: tb.textContent };
      tb.click();
    }
    const nextBtn = byLabel($(".sess-find", pane), /다음/);
    nextBtn.click(); await sleep(80);
    R.afterNext = $(".sess-find-n", pane).textContent;
    const prevBtn = byLabel($(".sess-find", pane), /이전/);
    prevBtn.click(); prevBtn.click(); await sleep(80);
    R.afterPrev2 = $(".sess-find-n", pane).textContent;
    //  남의 세션(초대받아 보는 대화록) — 일지가 404 라 「남긴 것」 칸이 없다 · 주인이 아니라 [휴지통으로]도 없다
    $$(".shx-results .shx-row", find)[2].click();
    await waitFor(() => $(".sess-turn", pane) && !$(".shx-left", pane) && /남의 세션/.test(($(".sess-title", pane) || {}).textContent || ""), 4000);
R.otherPane = { left: !!$(".shx-left", pane), trash: !!byLabel(pane, /휴지통/), title: ($(".sess-title", pane) || {}).textContent, resume: $$(".sess-resume", pane).length };
    $$(".shx-results .shx-row", find)[0].click();
    await waitFor(() => /검색 고치기/.test(($(".sess-title", pane) || {}).textContent || "") && byLabel(pane, /휴지통/), 4000);
    R.ownTrash = !!byLabel(pane, /휴지통/);
    // ── R21 — 좁은 칸(셸 액자 안의 폭): 질문 목차는 서랍([목차]로 여닫고 · 목차를 누르거나 Esc 로 닫는다), 「남긴 것」은 서랍에
    //   감추지 않고 읽기 칸 맨 위에 선다. 다시 넓어지면(폭을 다시 잰다) 둘 다 옆 칸으로 돌아간다. ──
    {
      const split = $(".shx-split", find);
      split.style.gridTemplateColumns = "360px 600px";                              // 대화록 칸을 600px 로
      $$(".shx-results .shx-row", find)[1].click();
      await waitFor(() => $(".sess-turn", pane) && $(".shx-left .shx-act", pane), 4000);
      const wrap = $(".sess-wrap", pane), rb = $(".sess-rail-btn", pane), side = $(".sess-side", pane);
      const at = { narrow: wrap.classList.contains("narrow"), btn: shown(rb), btnText: rb.textContent, expanded: rb.getAttribute("aria-expanded"), controls: rb.getAttribute("aria-controls") === side.id && !!side.id, side: shown(side),
        leftIn: $(".shx-left", pane).parentElement.className, leftFirst: $(".sess-main", pane).firstElementChild.classList.contains("shx-left"), leftMarks: $$(".shx-left mark", pane).length };
      rb.click(); await sleep(10);
      const opened = { side: shown(side), expanded: rb.getAttribute("aria-expanded"), focusInToc: !!document.activeElement && document.activeElement.classList.contains("sess-side-item") };
      const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      document.activeElement.dispatchEvent(esc); await sleep(10);
      const afterEsc = { side: shown(side), expanded: rb.getAttribute("aria-expanded"), used: esc.defaultPrevented, focusBack: document.activeElement === rb };
      rb.click(); await sleep(10);
      $(".sess-side-item", pane).click(); await sleep(20);
      const afterToc = { side: shown(side), expanded: rb.getAttribute("aria-expanded") };
      split.style.gridTemplateColumns = "";                                          // 다시 넓게 — 폭을 다시 잰다(탭을 다시 볼 때 도는 그 일)
      APP.refreshTranscripts(find); await sleep(10);
      R.drawer = { at, opened, afterEsc, afterToc, wideAgain: { narrow: wrap.classList.contains("narrow"), btn: shown(rb), side: shown(side), leftIn: $(".shx-left", pane).parentElement.className } };
      $$(".shx-results .shx-row", find)[0].click();
      await waitFor(() => $(".sess-flash", pane), 4000);
    }

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
    MODE.search = "503"; type(input, "검색어"); await waitFor(() => $(".shx-results .shx-err", find));
    R.search503 = ($(".shx-results .shx-err", find) || {}).textContent || null;
    MODE.search = "ok"; type(input, "없는말"); await waitFor(() => /맞은 말이 없습니다/.test($(".shx-results", find).textContent));
    R.noHit = { text: $(".shx-results", find).textContent, count: $(".shx-count", find).textContent };
    type(input, "검색"); await waitFor(() => $$(".shx-hit", find).length === 3);

    // ── R9 · R11 ──
    reqs = [];
    tabBtn("journal").click();
    const jr = panel("journal");
    await waitFor(() => $(".shx-jrow", jr));
    R.jReentry = jList().length;                             // 이미 연 탭 — 다시 청하지 않는다
    R.jStats = $$(".shx-stat", jr).map((t) => [$(".shx-stat-n", t).textContent, $(".shx-stat-k", t).textContent]);
    R.jGroups = $$(".shx-journal .shx-grp", jr).map(grpText);
    // ── R19 — 옆 칸(기간 요약): 하루하루 막대 · 프로젝트 · 만든 지식 · 태스크 ──
    {
      const rail = $(".shx-jrail", jr);
      const days = $$(".shx-day", rail);
      R.rail = {
days: days.length, weekdays: days.map((d) => $(".shx-day-l", d).textContent).join(""), counted: days.reduce((n, d) => n + (Number($(".shx-day-n", d).textContent) || 0), 0),
        //  가짜 서버는 기간과 무관하게 세 줄을 준다 — 그 가운데 이번 주(월요일 0시부터)에 든 줄 수만 막대에 선다. 요일에 따라 2 또는 3 이다
        //   (3일 전 줄이 월~수에는 지난 주다). 기대값을 요일에 묶지 않게 여기서 같이 센다.
        inWeek: (() => { const m = new Date(NOW); m.setHours(0, 0, 0, 0); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return JOURNAL.filter((r) => Date.parse(r.last_seen) >= m.getTime()).length; })(),
        todayN: Number($(".shx-day-n", days.find((d) => d.classList.contains("today"))).textContent) || 0,
        today: days.filter((d) => d.classList.contains("today")).length, zeroDisabled: days.filter((d) => d.classList.contains("zero")).every((d) => d.disabled) && days.filter((d) => !d.classList.contains("zero")).every((d) => !d.disabled),
        heads: $$(".shx-rail-h", rail).map((h) => h.textContent), track: !$(".shx-jwrap", jr).classList.contains("norail") && shown(rail),
        projs: $$(".shx-rail-r.proj", rail).map((r) => [$(".shx-rail-tn", r).textContent, $("b", r).textContent]),
        links: $$("a.shx-rail-r", rail).map((a) => [$(".shx-rail-tn", a).textContent, a.getAttribute("href"), a.classList.contains("done")]),
      };
    }
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
      R.jLine = { type: ($(".shx-jline .shx-type", r0) || {}).textContent || null, noneType: $$(".shx-jline .shx-type", r1).length, time: /^\d\d:\d\d$/.test($(".shx-jtime", r0).textContent), openCls: [r0.classList.contains("open"), $$(".shx-jrow", jr)[2].classList.contains("open")] };
      // ── R20 — [대화록 열기]는 창으로 연다: 화면(주소)을 옮기지 않고 · 박스를 아는 줄은 문이 처음부터 [세션 열기] · Esc 로 닫는다 ──
      const hash0 = location.hash;
      reqs = [];
      let releaseRow; rowHang = new Promise((z) => { releaseRow = z; });       // 「남긴 것」 답을 매달아 둔다 — 문은 그 답을 기다리지 않는다
      $$(".shx-jacts a", r0).find((a) => /대화록 열기/.test(a.textContent)).click();
      await waitFor(() => $(".shx-win .sess-turn", document.body), 4000);
      const early = { door: $$(".shx-win a.sess-door", document.body).map((a) => a.getAttribute("href")), resume: $$(".shx-win .sess-resume", document.body).length, sub: ($(".shx-win .shx-ph-sub", document.body) || {}).textContent || "" };
      releaseRow(); rowHang = null;
      await waitFor(() => $(".shx-win .shx-left .shx-act", document.body), 3000);
      R.winEarly = early;
      const win = $(".shx-win", document.body);
      R.win = { open: !!win, dialog: win && win.getAttribute("role") === "dialog" && win.getAttribute("aria-modal") === "true", hashSame: location.hash === hash0, title: ($(".sess-title", win) || {}).textContent,
        logReq: reqOf("/api/ui/v6/sessions/c1/log").length, door: $$("a.sess-door", win).map((a) => a.getAttribute("href")), resume: $$(".sess-resume", win).length, back: $$("a", win).some((a) => /뒤로/.test(a.textContent)), close: !!byLabel(win, /닫기/), journalStill: $$(".shx-jrow", jr).length };
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(20);
      R.winClosed = { gone: !$(".shx-win", document.body), hashSame: location.hash === hash0 };
      //  박스를 모르는 줄(기록만 남은 세션)의 창 — 문은 「이어 질문하기」, [닫기] 단추로도 닫힌다
      $$(".shx-jacts a", r1).find((a) => /대화록 열기/.test(a.textContent)).click();
      await waitFor(() => $(".shx-win .sess-turn", document.body), 4000);
      R.winNoBox = { resume: $$(".shx-win .sess-resume", document.body).length, door: $$(".shx-win a.sess-door", document.body).length };
      //  창 안을 눌러서는 안 닫힌다 · [닫기] 단추로 닫힌다
      $(".shx-win", document.body).dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); await sleep(10);
      R.winNoBox.inside = !!$(".shx-win", document.body);
      byLabel($(".shx-win", document.body), /닫기/).click(); await sleep(20);
      R.winNoBox.gone = !$(".shx-win", document.body);
      //  창 바깥(어두운 바탕)을 누르면 닫힌다
      $$(".shx-jacts a", r1).find((a) => /대화록 열기/.test(a.textContent)).click();
      await waitFor(() => $(".shx-win .sess-turn", document.body), 4000);
      $(".shx-mback", document.body).dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); await sleep(20);
      R.winNoBox.backdrop = !$(".shx-win", document.body);
      //  창 위에 확인창이 떴을 때의 Esc 는 확인창의 것이다 — 확인창만 닫히고 대화록 창은 남는다(격리 리뷰: 종전엔 창이 닫히고 확인창이 남았다).
      //   Esc 는 초점이 있는 요소(확인창의 [취소])에서 올라온다 — 문서에 바로 쏘면 캡처·버블의 차이가 안 보인다.
      $$(".shx-jacts a", r0).find((a) => /대화록 열기/.test(a.textContent)).click();
      await waitFor(() => $(".shx-win .sess-turn", document.body) && byLabel($(".shx-win", document.body), /휴지통/), 4000);
      const w2 = $(".shx-win", document.body);
      //  초점은 창 안에서 돈다 — 끝 단추에서 Tab 이면 첫 단추로, 첫 단추에서 Shift+Tab 이면 끝으로
      {
        const f = $$("a[href], button:not([disabled])", w2).filter((n) => n.getClientRects().length > 0);
        f[f.length - 1].focus();
        const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
        f[f.length - 1].dispatchEvent(tab);
        const fwd = [tab.defaultPrevented, document.activeElement === f[0]];
        const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
        f[0].dispatchEvent(back);
        R.winTrap = { fwd, back: [back.defaultPrevented, document.activeElement === f[f.length - 1]], n: f.length >= 4 };
      }
      byLabel(w2, /휴지통/).click();
      await waitFor(() => $(".ov-confirm", document.body));
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await sleep(30);
      R.winConfirmEsc = { focusWasCancel: true, confirmGone: !$(".ov-confirm", document.body), winStays: !!$(".shx-win", document.body), posts: reqs.filter((u) => /^POST /.test(u)).length };
      //  주소가 바뀌면 창이 걷힌다(다른 화면 위에 남지 않는다)
      const hashNow = location.hash;
      location.hash = hashNow + "&x=1"; await sleep(40);
      R.winHash = { gone: !$(".shx-win", document.body) };
      history.replaceState(null, "", location.pathname + location.search + hashNow);
      //  창에서 휴지통으로 — 확인하면 창이 닫히고 일지를 다시 받는다
      $$(".shx-jacts a", r0).find((a) => /대화록 열기/.test(a.textContent)).click();
      await waitFor(() => $(".shx-win .sess-turn", document.body) && byLabel($(".shx-win", document.body), /휴지통/), 4000);
      reqs = [];
      byLabel($(".shx-win", document.body), /휴지통/).click();
      await waitFor(() => $(".ov-confirm", document.body));
      $$(".ov-confirm-acts button", document.body).find((b) => b.textContent === "휴지통으로").click();
      await waitFor(() => !$(".shx-win", document.body) && jList().length >= 1, 4000);
      await waitFor(() => $(".shx-jrow", jr));
      R.winTrash = { post: reqs.filter((u) => /^POST \/api\/ui\/terminal\/session-trash/.test(u)).length, gone: !$(".shx-win", document.body), reloaded: jList().length, rows: $$(".shx-jrow", jr).length, stillOpen: !$(".shx-jmore", $(".shx-jrow", jr)).hidden };
    }
    $$(".shx-seg-b", jr).find((b) => b.textContent === "프로젝트별").click(); await sleep(40);
    R.jByProj = $$(".shx-journal .shx-grp", jr).map(grpText);
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
    //  옆 칸의 막대(그날) · 프로젝트 줄을 누르면 그 묶음으로 간다 — 지금 기준과 다르면 기준이 바뀐다(세그도 따라 바뀐다).
    //   「최근 30일」에서 잰다: 서른 칸 가운데 3일 전 칸과 오늘 칸에 세션이 있다(요일과 무관하다). 3일 전 칸은 첫 칸이 아니다.
    {
      const d3 = new Date(NOW - 3 * D);
      const want = `${d3.getMonth() + 1}월 ${d3.getDate()}일 (${"일월화수목금토"[d3.getDay()]})`;
      const bars = $$(".shx-jrail .shx-day", jr);
      const live = bars.filter((d) => !d.disabled);
      const dayKey = live[0].dataset.key;
      live[0].click(); await sleep(30);                    // 3일 전 칸(지금 기준은 「프로젝트별」이다)
      const afterDay = { focus: [document.activeElement.classList.contains("shx-day"), document.activeElement.dataset.key === dayKey, document.activeElement.isConnected], bars: bars.length, enabled: live.length, firstIsLive: bars[0] === live[0], on: $$(".shx-bar .shx-seg-b.on", jr).map((b) => b.textContent), flashed: $$(".shx-jgroup.flash", jr).map((g) => $(".shx-grp-l", g).textContent), want };
      $$(".shx-jrail .shx-rail-r.proj", jr)[1].click(); await sleep(30);
      R.railGo = { afterDay, afterProj: { on: $$(".shx-bar .shx-seg-b.on", jr).map((b) => b.textContent), flashed: $$(".shx-jgroup.flash", jr).map((g) => grpText($(".shx-grp", g))) } };
    }
    //  끊긴 「지난 주」는 캐시에 없다 — 다시 누르면 청한다(이번엔 서버가 500)
    MODE.journal = "500";
    $$(".shx-seg-b", jr).find((b) => b.textContent === "지난 주").click(); await waitFor(() => $(".shx-err", jr));
R.j500 = { text: ($(".shx-err", jr) || {}).textContent || null, railHidden: !shown($(".shx-jrail", jr)) && $(".shx-jwrap", jr).classList.contains("norail"), stats: $$(".shx-stat", jr).length };
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
    R.lCount = { text: $(".shx-count", ls).textContent, chips: $$(".shx-fchip", ls).map((b) => [b.dataset.key, $(".shx-fchip-l", b).textContent, $(".shx-fchip-n", b).textContent, b.getAttribute("aria-pressed")]) };
    R.lStates = $$(".shx-tr", ls).map((tr) => [$(".shx-dot", tr).className.replace("shx-dot", "").trim(), $(".shx-state", tr).className.replace("shx-state", "").trim()]);
    const seg = (t) => $$(".shx-fchip", ls).find((b) => $(".shx-fchip-l", b).textContent === t);
    seg("실행 중").click(); await sleep(30); R.lLive = rowsOf().map((r) => r[0]);
    seg("오프라인").click(); await sleep(30); R.lOff = rowsOf().map((r) => r[0]);
    seg("기록만").click(); await sleep(30); R.lRec = rowsOf().map((r) => r[0]);
    seg("전체").click(); await sleep(30);
    type($(".shx-input", ls), "없는이름zz"); await sleep(30);
    R.lEmpty = { text: ($(".shx-tbody .shx-empty-t", ls) || {}).textContent || null, inRowCell: !!$(".shx-tbody > [role=row] > [role=cell] > .shx-empty", ls), strays: [...$(".shx-tbody", ls).children].filter((n) => n.getAttribute("role") !== "row").length, count: $(".shx-count", ls).textContent };
    type($(".shx-input", ls), "ㄷ 재시안"); await sleep(30); R.lFind = rowsOf().map((r) => r[0]);
    type($(".shx-input", ls), ""); await sleep(30);
    $$(".shx-th", ls).find((b) => b.textContent.startsWith("세션")).click(); await sleep(30);
    R.lSortAsc = rowsOf().map((r) => r[0]);
    R.lAriaSort = $$("[role=columnheader]", ls).map((t) => t.getAttribute("aria-sort"));
    $$(".shx-th", ls).find((b) => b.textContent.startsWith("세션")).click(); await sleep(30);
    R.lSortDesc = rowsOf().map((r) => r[0]);
    $$(".shx-th", ls).find((b) => b.textContent.startsWith("마지막")).click(); await sleep(30);
    const lpane = $(".shx-pane", ls);
    $$(".shx-tr", ls).find((tr) => /검색 고치기/.test(tr.textContent)).click();
    await waitFor(() => $(".sess-turn", lpane), 4000);
await waitFor(() => byLabel(lpane, /휴지통/), 3000);
    R.lCur = $$(".shx-tr", ls).filter((tr) => tr.getAttribute("aria-current") === "true").map((tr) => $(".shx-tname", tr).textContent);
    R.lBox = { resume: $$("button", lpane).some((b) => /이어 질문하기/.test(b.textContent)), open: $$("a", lpane).filter((a) => a.textContent === "세션 열기").map((a) => a.getAttribute("href")), turns: $$(".sess-turn", lpane).length };
    //  머리는 하나 — 이름은 한 번만 서고, 대화록의 단추(목차 · 링크 복사 · 휴지통)는 그 머리의 도구 자리에 든다
    R.lFindBar = shown($(".sess-find", lpane));   // 찾는 낱말이 없는 대화록에는 「이 대화에서 n곳」 줄이 없다
    R.lHead = { titles: $$(".sess-title", lpane).length, heads: $$(".shx-ph", lpane).length, tools: $$(".shx-ph-tools button", lpane).map((b) => b.getAttribute("aria-label") || b.textContent), sub: $(".shx-ph-sub", lpane).textContent, rail: !!$(".sess-side .shx-left", lpane) };
    $$(".shx-seg-b", lpane).find((b) => b.textContent === "정보").click();
    await waitFor(() => $(".shx-info", lpane) && $(".shx-left .shx-act", lpane), 3000);
    R.lInfo = { rows: $$(".shx-info .shx-kv", lpane).map((tr) => [...tr.children].map((c) => c.textContent)), left: !!$(".shx-left", lpane), tools: $$(".shx-ph-tools button", lpane).length };
    //  기록만 남은 세션 — 「이어 질문하기」가 있고 [세션 열기]는 없다
    $$(".shx-seg-b", lpane).find((b) => b.textContent === "기록 보기").click();
    $$(".shx-tr", ls).find((tr) => /옛 조사/.test(tr.textContent)).click();
    await waitFor(() => $(".sess-turn", $(".shx-pane", ls)) && /옛 조사/.test(($(".sess-title", $(".shx-pane", ls)) || {}).textContent || ""), 4000);
    R.lRecOnly = { resume: $$("button", $(".shx-pane", ls)).filter((b) => /이어 질문하기/.test(b.textContent)).length, open: $$("a", $(".shx-pane", ls)).filter((a) => a.textContent === "세션 열기").length };
    //  기록이 아직 없는 도는 세션
    $$(".shx-tr", ls).find((tr) => /기록 없는 새 세션/.test(tr.textContent)).click(); await sleep(60);
    R.lNoRec = $(".shx-detail-body", ls).textContent;
    // ── R24 — 대화록의 답이 오기 전에 「정보」로 옮긴다: 그 줄의 머리는 두 보기가 함께 쓴다. 늦게 온 답이 머리의 도구 자리에
    //   대화록 단추를 달면 안 된다(「정보」에는 대화록 단추가 없다). 다시 「기록 보기」로 오면 단추는 한 벌만 선다.
    {
      let release; logHang = new Promise((z) => { release = z; });
      $$(".shx-tr", ls).find((tr) => /위젯 기획/.test(tr.textContent)).click();        // 대화록 답이 매달린다
      await sleep(20);
      const lp = $(".shx-pane", ls);
      $$(".shx-seg-b", lp).find((b) => b.textContent === "정보").click();
      await waitFor(() => $(".shx-info", lp));
      logHang = null; release(); await sleep(150);                                   // 늦은 답이 이제 온다
      const onInfo = { tools: $$(".shx-ph-tools button", lp).length, turns: $$(".sess-turn", lp).length, title: $(".sess-title", lp).textContent };
      $$(".shx-seg-b", lp).find((b) => b.textContent === "기록 보기").click();
      await waitFor(() => $(".sess-turn", lp) && byLabel(lp, /휴지통/), 4000);
      await sleep(60);
      R.lateLog = { onInfo, tools: $$(".shx-ph-tools button", lp).map((b) => b.getAttribute("aria-label") || b.textContent), wraps: $$(".sess-wrap", lp).length };
    }
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
      R.emptyWeek = { text: $(".shx-journal .shx-empty-t", jr2).textContent, btn: $$(".shx-journal button", jr2).map((b) => b.textContent), rail: !shown($(".shx-jrail", jr2)) && $(".shx-jwrap", jr2).classList.contains("norail") };
      MODE.journal = "ok";
      $$(".shx-journal button", jr2).find((b) => b.textContent === "지난 주 보기").click();
      await waitFor(() => $(".shx-jrow", panel("journal")));
      const jr3 = panel("journal");
      R.afterLastWeek = { rows: $$(".shx-jrow", jr3).length, on: $$(".shx-bar .shx-seg-b.on", jr3).map((b) => b.textContent) };
      //  받는 중에 묶는 기준을 누른다 — 앞 기간의 줄을 새 기간 아래 그리지 않는다(받는 자리 그대로). 답이 오면 고른 기준으로 선다.
      //   그 기간의 지식은 여덟 — 옆 칸은 여섯까지 보이고 [2개 더]로 나머지를 편다.
      MODE.journal = "many";
      $$(".shx-seg-b", jr3).find((b) => b.textContent === "최근 30일").click();      // 캐시가 지났다 — 새로 받는다(40ms)
      await sleep(5);
      $$(".shx-seg-b", jr3).find((b) => b.textContent === "날짜별").click();
      const mid = { rows: $$(".shx-jrow", jr3).length, skel: !!$(".shx-journal .shx-skel", jr3), range: $(".shx-range", jr3).textContent !== "" };
      await waitFor(() => $(".shx-jrow", jr3));
      const kn = () => $$(".shx-jrail .shx-rail-sec", jr3).find((x) => /^만든 지식/.test($(".shx-rail-h", x).textContent));
      const before = { head: $(".shx-rail-h", kn()).textContent, links: $$("a.shx-rail-r", kn()).length, more: ($(".shx-rail-more", kn()) || {}).textContent || null };
      $(".shx-rail-more", kn()).click();
      R.midLoad = { mid, on: $$(".shx-bar .shx-seg-b.on", jr3).map((b) => b.textContent), bars: $$(".shx-jrail .shx-day", jr3).length };
      R.railMore = { before, after: { links: $$("a.shx-rail-r", kn()).length, more: !!$(".shx-rail-more", kn()) } };
      MODE.journal = "ok";
    }
    await open("#/sessions?tab=find");

    // ── R17 ──
    reqs = [];
    type($(".shx-input", panel("find")), "늦은말");          // 디바운스(250ms)가 걸린 채로
    await open("#/sessions/c1?node=");                       // 대화록 단독 화면으로 간다
    await waitFor(() => $(".sess-turn") && $("a.sess-door"));
    await sleep(400);
    R.lateTimer = { hash: location.hash, reqs: reqOf("/api/ui/v6/session-search/messages").filter((u) => /%EB%8A%A6%EC%9D%80%EB%A7%90/.test(u)).length };
R.page = { back: $$("a").filter((a) => /뒤로/.test(a.textContent)).map((a) => a.getAttribute("href")), tabs: $$("[role=tab]").length, card: !!$(".sess-page .sess-layout"), embed: !!$(".sess-embed"), resume: $$("button").some((b) => /이어 질문하기/.test(b.textContent)), door: $$("a.sess-door").map((a) => a.getAttribute("href")), left: !!$(".sess-side .shx-left"), fit: /px$/.test($(".sess-page").style.getPropertyValue("--shx-h")) };
    //  앱 틀 — 창 바닥까지 채운다(높이를 CSS 변수로 준다) · 탭마다 그림이 선다
    await open("#/sessions?tab=find");
R.frame = { fit: /px$/.test($(".shx").style.getPropertyValue("--shx-h")), applied: $(".shx").offsetHeight + "px" === $(".shx").style.getPropertyValue("--shx-h") && $(".shx").offsetHeight >= 420 && $(".shx").offsetHeight <= innerHeight, tabIcons: $$("[role=tab] svg").length, brand: ($(".shx-brand h2") || {}).textContent };
    {
      await waitFor(() => $$(".shx-select", panel("find"))[1].options.length >= 4);
      pick($$(".shx-select", panel("find"))[1], "3870"); await sleep(40);
      await open("#/sessions?tab=find");
      await waitFor(() => $$(".shx-select", panel("find"))[1].options.length >= 4);
      const ps = $$(".shx-select", panel("find"))[1];
      R.pickKeep = { value: ps.value, on: ps.parentElement.classList.contains("on") };
      pick(ps, ""); await sleep(40);
    }
    //  남의 세션(공유 링크로 연 대화록)의 단독 화면 — 일지가 404 라 「남긴 것」이 없고, 문은 「이어 질문하기」, [휴지통으로]는 없다.
    //   R25 — 그 화면으로 가기 직전에 보던 내 대화록(c1)의 「남긴 것」 답이 늦게 온다: 떠난 화면의 답이 새 화면의 문을 바꾸지 않는다.
    let releaseLate; rowHang = new Promise((z) => { releaseLate = z; });
    await open("#/sessions/c1?node=");
    await waitFor(() => $(".sess-turn") && reqOf("/api/ui/v6/session-journal").some((u) => /session_id=c1/.test(u)));
    rowHang = null;
    await open("#/sessions/c7?node=");
    await waitFor(() => $(".sess-turn") && !$(".shx-left") && /검색을 고쳐 줘/.test(($(".sess-title") || {}).textContent || ""));
    releaseLate(); await sleep(80);
    R.pageOther = { left: !!$(".shx-left"), resume: $$(".sess-resume").length, door: $$("a.sess-door").length, trash: !!byLabel(view, /휴지통/), toc: $$(".sess-side-item").length };
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
same(R.recentGrpN, ["오늘 · 2", "최근 7일 · 1", "그 이전 · 1"], "R2 묶음 머리에 그 묶음의 수가 선다");
check((R.listReq || []).length === 1 && /limit=2000/.test(R.listReq[0]), "R2 목록은 서버 상한까지 한 번 청한다", JSON.stringify(R.listReq));
same(R.projOptions, [["", "모든 프로젝트"], ["3870", "통합검색"], ["4135", "UI 수정"], ["0", "기타 (미분류)"]], "R2 프로젝트 고르개 = 내 세션이 붙은 프로젝트(겹치지 않게) + 프로젝트 없음");
same(R.recentProj, ["# 오늘", "검색 고치기", "# 그 이전", "옛 조사"], "R2 프로젝트로 좁힌 최근 대화");
same(R.recentNoProj, ["# 최근 7일", "덱 재시안"], "R2 「프로젝트 없음」으로 좁힌 최근 대화");
same(R.recentD7, ["# 오늘", "검색 고치기", "위젯 기획", "# 최근 7일", "덱 재시안"], "R2 기간으로 좁힌 최근 대화");
same(R.pickOn, [true, false, false], "R2 알약 고르개 — «전부» 가 아닌 값을 고른 것만 켜진 색, 풀면 꺼진다");
// R3
check((R.findReqs || []).length === 1 && param(R.findReqs[0], "q") === "검색" && param(R.findReqs[0], "limit") === "30" && !/since=|role=|project=/.test(R.findReqs[0]), "R3 검색어 → 맞은 말 단위 요청 한 번(q · limit, 거르개 없음)", JSON.stringify(R.findReqs));
same((R.hits || []).map((h) => h.text), ["검색 배포를 마쳤습니다", "검색을 고쳐 줘", "<img src=x onerror=window.PWNED=1> 검색 <b>굵게</b>"], "R3 줄 = 맞은 말");
same((R.hits || [])[0] && [R.hits[0].marks, R.hits[0].ctx], [["검색"], ["나 · 배포까지 해 줘"]], "R3 낱말 색칠 · 앞 말(말한 쪽 + 글 · 뒤 말이 없으면 없다)");
same((R.hits || [])[1] && R.hits[1].ctx, ["AI · 먼저 살펴보겠습니다"], "R3 첫 말은 뒤 말만");
check(/검색 고치기/.test(R.hits?.[0]?.meta || "") && /통합검색/.test(R.hits[0].meta) && /AI 답/.test(R.hits[0].meta) && /내 지시/.test(R.hits[1].meta) && /기타 \(미분류\)/.test(R.hits[2].meta), "R3 줄 머리 = 세션 · 프로젝트 · 시각 · 말한 쪽", JSON.stringify((R.hits || []).map((h) => h.meta)));
check(/맞은 말 7곳/.test(R.findCount || "") && /세션 2개/.test(R.findCount) && /색인을 만드는 중/.test(R.findCount) && /3개/.test(R.findCount), "R3 총계와 색인 중 안내", R.findCount);
// R8
same(R.xss, { pwned: false, imgs: 0, text: "<img src=x onerror=window.PWNED=1> 검색 <b>굵게</b>" }, "R8 대화 본문의 태그는 글자로만 선다");
same(R.clear, { shown: true, hiddenAfter: true, value: "", recent: 4, hash: "#/sessions?tab=find", reqs: 1 }, "R22 [지우기] — 글자가 있을 때만 보이고, 누르면 최근 대화로 돌아가며 주소의 q 도 걷힌다(검색 요청은 더 내지 않는다)");
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
same(R.pane && [R.pane.rowSel, R.pane.rowCur], [[true, false, false], ["true", null, null]], "R5 고른 줄만 표시된다(모양과 이름표 둘 다)");
same(R.pane?.wide, { narrow: false, btn: false, side: true }, "R21 넓은 칸 — 옆 칸이 늘 서 있고 [목차] 단추는 없다");
same(R.pane?.title, "검색 고치기", "R5 대화록 머리 = 목록이 아는 세션 이름");
// R6
same(R.pane && [R.pane.back, R.pane.embed], [false, true], "R6 칸 안 대화록엔 「← 뒤로」가 없다");
same(R.pane?.left, { acts: ["대화 검색 추가", "배포 기록"], types: ["기능", "문서"], chips: ["통합검색 as-built", "#4517 대화 검색", "커밋 1", "고친 파일 4"], kinds: ["k", "t done", "", ""], inRail: true, doors: 0 }, "R6 「이 세션이 남긴 것」 — 옆 칸에 작업 기록(종류) · 지식 · 태스크(끝난 것 표시) · 커밋 · 고친 파일 · 문은 여기 없다(머리에 하나)");
check(/통합검색/.test(R.pane?.sub || "") && /질문 2개/.test(R.pane.sub), "R5 대화록 머리의 부제 = 프로젝트 · 언제 · 질문 수", R.pane?.sub);
same(R.pane && [R.pane.turnHead, R.pane.headMarks, R.pane.toolText], [["질문 1", "질문 2"], 0, ["검색 omni"]], "R5 질문마다 번호가 서고, 번호·도구 줄(찾는 낱말이 있어도)·옆 칸은 대화의 글이 아니라 칠하지 않는다");
same(R.ownTrash, true, "R6 내 세션의 대화록 머리에는 [휴지통으로]가 있다(이름표로 읽힌다)");
same(R.toolFold, { before: [false, "false"], after: [true, "true"], label: "도구 1개Grep" }, "R5 도구 호출 줄 — 접혀 있다가(화면에 없다) 누르면 펼쳐진다 · 줄에 수와 도구 이름");
same(R.drawer?.at, { narrow: true, btn: true, btnText: "목차", expanded: "false", controls: true, side: false, leftIn: "sess-main", leftFirst: true, leftMarks: 0 }, "R21 좁은 칸 — 옆 칸이 걷히고 [목차]가 선다 · 「남긴 것」은 읽기 칸 맨 위에(서랍에 감추지 않는다 · 낱말 색칠 대상이 아니다)");
same(R.drawer && [R.drawer.opened, R.drawer.afterEsc, R.drawer.afterToc], [{ side: true, expanded: "true", focusInToc: true }, { side: false, expanded: "false", used: true, focusBack: true }, { side: false, expanded: "false" }], "R21 서랍 — [목차]로 열면 초점이 목차로 · Esc 로 닫히고(그 Esc 는 서랍이 쓴다) 초점이 단추로 · 목차를 눌러도 닫힌다");
same(R.drawer?.wideAgain, { narrow: false, btn: false, side: true, leftIn: "sess-side" }, "R21 다시 넓어지면 폭을 다시 재서 옆 칸이 서고 「남긴 것」도 옆 칸으로 돌아간다");
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
same(R.jRows?.[0], { t: "검색 고치기", sum: "배포 기록 외 1건", none: false, chips: ["통합검색 as-built", "#4517 대화 검색", "커밋 1", "고친 파일 4"], more: false }, "R9 줄 — 가장 늦은 기록의 제목 + 남긴 것 · 처음엔 접혀 있다");
same(R.jRows?.[1] && [R.jRows[1].sum, R.jRows[1].none], ["기록된 작업 없음 · 첫 지시: 첫 지시 위젯 기획", true], "R9 기록 없는 세션은 그렇다고 말하고 첫 지시를 보인다");
same(R.jOpen, { expanded: "true", acts: ["대화 검색 추가", "배포 기록"], first: "첫 지시첫 지시 검색 고치기", btns: ["세션 열기", "대화록 열기"], nullText: false }, "R9 줄을 누르면 기록·첫 지시·단추가 펼쳐진다(«null» 글자 없음) · 박스가 있으면 문은 [세션 열기] 하나");
same(R.jOpenNoBox, ["이어 질문하기", "대화록 열기"], "R9 박스를 모르는 줄의 문은 「이어 질문하기」 하나");
same(R.jHeadTags, ["SPAN", "SPAN", "SPAN"], "R9 줄 머리 단추 안에는 span 만(단추 안에 div 를 두지 않는다)");
same(R.jLine, { type: "문서", noneType: 0, time: true, openCls: [true, false] }, "R9 «한 일» 앞에 그 기록의 종류 · 기록 없는 줄엔 종류가 없다 · 날짜별 묶음의 때는 시각(HH:MM) · 펼친 줄만 열린 모양");
check(!!R.rail && R.rail.days === 7 && R.rail.weekdays === "월화수목금토일" && R.rail.today === 1 && R.rail.todayN === 2 && R.rail.inWeek >= 2 && R.rail.counted === R.rail.inWeek && R.rail.zeroDisabled === true && R.rail.track === true, "R19 옆 칸 — 한 주의 하루하루: 일곱 칸(빈 날 포함) · 오늘 칸에 오늘의 두 세션 · 합 = 이번 주에 든 세션 수 · 빈 날은 못 누른다", JSON.stringify(R.rail));
same(R.rail && { heads: R.rail.heads, projs: R.rail.projs, links: R.rail.links }, { heads: ["하루하루", "프로젝트 3", "만든 지식 1", "태스크 1"],
  projs: [["통합검색", "1"], ["UI 수정", "1"], ["기타 (미분류)", "1"]], links: [["통합검색 as-built", "#/k/omni-asbuilt", false], ["#4517 대화 검색", "#/projects2/t/4517", true]] }, "R19 옆 칸 — 프로젝트(「프로젝트 없음」이 맨 아래) · 만든 지식 · 태스크(끝난 것 표시)");
check(!!R.railGo && R.railGo.afterDay.bars === 30 && R.railGo.afterDay.enabled === 2 && R.railGo.afterDay.firstIsLive === false && R.railGo.afterDay.on.join() === "최근 30일,날짜별" && R.railGo.afterDay.flashed.length === 1 && R.railGo.afterDay.flashed[0] === R.railGo.afterDay.want && R.railGo.afterDay.focus.join() === "true,true,true", "R19 막대를 누르면 날짜별로 바뀌고 그날(3일 전) 묶음으로 간다 — 「최근 30일」은 서른 칸 · 다시 선 옆 칸의 같은 막대로 초점이 돌아온다", JSON.stringify(R.railGo?.afterDay));
same(R.railGo?.afterProj, { on: ["최근 30일", "프로젝트별"], flashed: ["UI 수정 · 1"] }, "R19 프로젝트 줄을 누르면 프로젝트별로 바뀌고 그 프로젝트 묶음으로 간다");
same(R.win, { open: true, dialog: true, hashSame: true, title: "검색 고치기", logReq: 1, door: ["#/s/box-1"], resume: 0, back: false, close: true, journalStill: 3 }, "R20 [대화록 열기] — 창으로 열린다(주소 그대로 · 일지 그대로) · 박스를 아는 줄은 문이 처음부터 [세션 열기]");
check(!!R.winEarly && JSON.stringify(R.winEarly.door) === '["#/s/box-1"]' && R.winEarly.resume === 0 && /통합검색/.test(R.winEarly.sub), "R20 박스를 아는 줄의 창은 「남긴 것」 답을 기다리지 않고 처음부터 [세션 열기]다(「이어 질문하기」가 잠깐도 서지 않는다) · 부제에 프로젝트", JSON.stringify(R.winEarly));
same(R.winClosed, { gone: true, hashSame: true }, "R20 Esc 로 닫힌다");
same(R.winTrap, { fwd: [true, true], back: [true, true], n: true }, "R20 초점은 창 안에서 돈다 — 끝에서 Tab 은 처음으로, 처음에서 Shift+Tab 은 끝으로");
same(R.winConfirmEsc, { focusWasCancel: true, confirmGone: true, winStays: true, posts: 0 }, "R20 창 위에 뜬 확인창의 Esc 는 확인창만 닫는다 — 대화록 창은 남고 아무것도 보내지 않는다");
same(R.winHash, { gone: true }, "R20 주소가 바뀌면 창이 걷힌다");
same(R.winTrash, { post: 1, gone: true, reloaded: 1, rows: 3, stillOpen: true }, "R20 창에서 휴지통으로 — 확인하면 한 번 보내고 창이 닫히며 일지를 다시 받는다(펼친 줄은 그대로)");
same(R.winNoBox, { resume: 1, door: 0, inside: true, gone: true, backdrop: true }, "R20 박스를 모르는 줄의 창 — 문은 「이어 질문하기」 · 창 안을 눌러서는 안 닫히고 [닫기] 단추·바깥 누르기로 닫힌다");
same(R.jRows?.[2] && [R.jRows[2].sum, R.jRows[2].none], ["이 기간에 적은 기록 없음 · 이전 기록 2건", true], "R9 앞선 기간에만 기록이 있는 세션은 그렇다고 말한다(«기록된 작업 없음» 이 아니다)");
same(R.jAbort && [R.jAbort.made, R.jAbort.firstAborted, R.jAbort.secondAborted, R.jAbort.rows], [2, true, false, 3], "R9 기간을 연달아 바꾸면 앞 요청을 끊고 뒤 것만 그린다");
check((R.jByProj || []).length === 3 && /^통합검색/.test(R.jByProj[0]) && /^UI 수정/.test(R.jByProj[1]) && /^기타 \(미분류\)/.test(R.jByProj[2]), "R9 프로젝트별 — 「프로젝트 없음」이 맨 아래", JSON.stringify(R.jByProj));
same(R.jStillOpen, { open: true, acts: 2 }, "R9 다시 묶어도 펼친 줄은 펼쳐져 있고 내용도 그대로다");
check(/^작업 일지 · /.test(R.copied || "") && /세션 3 · 프로젝트 2 · 한 일 2 · 지식 1 · 태스크 1/.test(R.copied) && /\[통합검색\]\n- 대화 검색 추가 \(지식: 통합검색 as-built\)\n- 배포 기록/.test(R.copied) && /- 위젯 기획 \(기록 없음\)/.test(R.copied), "R9 [요약 복사] — 그 기간의 글이 클립보드에", JSON.stringify(R.copied));
check(Date.parse(param(R.jLastWeekReq, "until") || "") <= Date.parse(param(R.jReq?.[0], "since") || "") + 1000, "R9 지난 주 = 이번 주 시작 전까지", JSON.stringify([R.jLastWeekReq, R.jReq]));
check(/서버|불러오지 못했|internal_error/.test(R.j500?.text || "") && R.j500.railHidden === true && R.j500.stats === 0, "R13 일지 500 — 실패를 말한다(빈 일지로 보이지 않는다 · 앞 기간의 합계·요약이 남지 않고 옆 칸 자리도 비워 두지 않는다)", JSON.stringify(R.j500));
check(!!R.jD30Req && param(R.jD30Req, "until") === null && Number.isFinite(Date.parse(param(R.jD30Req, "since") || "")), "R9 최근 30일은 until 없이 청한다", JSON.stringify(R.jD30Req));
same(R.back, { hash: "#/sessions?tab=find&q=%EA%B2%80%EC%83%89", q: "검색", hits: 3, paneTitle: "검색 고치기", hidden: [false, true, true] }, "R11 탭을 오가도 검색어·결과·고른 대화록이 그대로다 · 주소에 검색어");
// R10
check((R.lReqs?.live || []).length === 1 && /includeProjects=1/.test(R.lReqs.live[0]) && R.lReqs.logs === 0, "R10 세션 목록 탭 — 도는 세션을 한 번 청하고 기록은 이미 받은 것을 쓴다", JSON.stringify(R.lReqs));
same(R.lRows, [["기록 없는 새 세션", "", "대기 중"], ["검색 고치기", "통합검색", "작업 중"], ["위젯 기획", "UI 수정", "기록만"], ["오프라인 세션", "", "오프라인"], ["덱 재시안", "", "중단됨"], ["옛 조사", "통합검색", "기록만"]], "R10 도는 세션과 기록이 한 줄씩 — 마지막 활동이 늦은 것부터 · 휴지통·빈 세션·남의 세션 없음");
same(R.lCount, { text: "세션 6개", chips: [["all", "전체", "6", "true"], ["live", "실행 중", "2", "false"], ["off", "오프라인", "1", "false"], ["rec", "기록만", "3", "false"]] }, "R10 수 — 거르개 칩마다 그 묶음의 수(전체 · 실행 중 · 오프라인 · 기록만)");
same(R.lStates, [["", "idle"], ["busy", "busy"], ["log", "log"], ["quiet", "off"], ["quiet", "off"], ["log", "log"]], "R10 상태의 점과 알약 — 도는 것(파랑) · 열려 있는 것(채운 점) · 꺼진 것(빈 고리) · 기록만");
same(R.lLive, ["기록 없는 새 세션", "검색 고치기"], "R10 「실행 중」 = 지금 쓰이는 것(오프라인은 아니다)");
same(R.lOff, ["오프라인 세션"], "R10 「오프라인」 = 박스는 있지만 지금 쓰이지 않는 것");
same(R.lRec, ["위젯 기획", "덱 재시안", "옛 조사"], "R10 「기록만」 = 박스가 없고 읽을 기록이 있는 것");
same(R.lFind, ["덱 재시안"], "R10 이름으로 거르기(초성 · 낱말 둘)");
check(!!R.lEmpty && /조건에 맞는 세션이 없습니다/.test(R.lEmpty.text || "") && R.lEmpty.inRowCell === true && R.lEmpty.strays === 0 && /세션 0개/.test(R.lEmpty.count) && /전체 6개/.test(R.lEmpty.count), "R10 맞는 세션이 없으면 그렇다고 말한다 — 표 안에서는 그 말도 줄·칸에 담긴다 · 수는 «0개 · 전체 6개 가운데»", JSON.stringify(R.lEmpty));
same(R.lSortAsc, ["검색 고치기", "기록 없는 새 세션", "덱 재시안", "옛 조사", "오프라인 세션", "위젯 기획"], "R10 열 머리 — 세션 이름 오름차순");
same(R.lAriaSort, ["ascending", "none", "none", "none"], "R10 정렬 열이 aria-sort 로 실린다");
same(R.lSortDesc, ["위젯 기획", "오프라인 세션", "옛 조사", "덱 재시안", "기록 없는 새 세션", "검색 고치기"], "R10 같은 열을 다시 누르면 내림차순");
same(R.lBox, { resume: false, open: ["#/s/box-1"], turns: 2 }, "R10 박스 있는 줄 — 대화록에 「이어 질문하기」가 없고 [세션 열기]가 그 세션으로");
same(R.lCur, ["검색 고치기"], "R10 고른 줄은 이름표(aria-current)로도 실린다");
same(R.lFindBar, false, "R10 찾는 낱말 없이 연 대화록에는 「이 대화에서 n곳」 줄이 서지 않는다");
check(!!R.lHead && R.lHead.titles === 1 && R.lHead.heads === 1 && R.lHead.tools.length === 3 && R.lHead.tools[0] === "목차" && /링크 복사/.test(R.lHead.tools[1]) && /휴지통/.test(R.lHead.tools[2]) && /작업 중/.test(R.lHead.sub) && /통합검색/.test(R.lHead.sub) && R.lHead.rail === true, "R10 상세의 머리는 하나 — 이름 한 번 · 부제(상태 · 프로젝트) · 대화록의 단추는 그 머리의 도구 자리에 · 옆 칸에 남긴 것", JSON.stringify(R.lHead));
check((R.lInfo?.rows || []).some((r) => r[0] === "상태" && r[1] === "작업 중") && R.lInfo.rows.some((r) => r[0] === "프로젝트" && r[1] === "통합검색") && R.lInfo.rows.some((r) => r[0] === "첫 지시") && R.lInfo.left === true && R.lInfo.tools === 0, "R10 정보 탭 — 상태·프로젝트·첫 지시 + 남긴 것 · 대화록의 단추는 걷힌다", JSON.stringify(R.lInfo));
same(R.lateLog, { onInfo: { tools: 0, turns: 0, title: "위젯 기획" }, tools: ["목차", "링크 복사", "휴지통으로"], wraps: 1 }, "R24 「정보」로 옮긴 뒤 늦게 온 대화록의 답은 함께 쓰는 머리를 건드리지 않는다 · 돌아오면 단추는 한 벌");
same(R.lRecOnly, { resume: 1, open: 0 }, "R10 기록만 남은 줄 — 「이어 질문하기」가 하나 있고 [세션 열기]는 없다");
check(/아직 중앙에 올라온 대화 기록이 없습니다/.test(R.lNoRec || ""), "R10 기록이 아직 없는 도는 세션은 그렇다고 말한다", R.lNoRec);
same(R.sameIds, { find: true, list: true }, "R15 배선 — 두 칸이 같은 번호의 턴을 들고 있다");
same(R.tocScrolled, ["shx-panel-list"], "R15 질문 목차는 제 칸의 그 질문으로 간다(문서 전체에서 찾지 않는다)");
same(R.openOutside, { opened: [[true, "lively-term-box-1"]], hashSame: true }, "R16 셸 밖 — [세션 열기]는 세션 터미널 창을 연다(#/s/ 주소로 가지 않는다)");
same(R.openInShell && [R.openInShell.asked, R.openInShell.opened], [["#/s/box-1"], 0], "R16 셸 안 — [세션 열기]는 터미널 창이 아니라 그 세션 화면 주소를 셸에 부탁한다");
// R11 · R12
same(R.deep, { selected: ["작업 일지"], findKids: 0, findReqs: 0 }, "R11 주소의 ?tab= 으로 그 탭이 열린다 — 다른 탭은 그리지 않는다");
same(R.deepQ, { q: "검색", hits: 3 }, "R11 주소의 q 로 찾던 말이 되살아난다");
same(R.emptyWeek, { text: "이번 주에 한 세션이 아직 없습니다.", btn: ["지난 주 보기"], rail: true }, "R18 빈 「이번 주」 — 그렇다고 말하고 지난 주로 가는 문을 둔다(옆 칸은 걷는다)");
same(R.midLoad, { mid: { rows: 0, skel: true, range: true }, on: ["최근 30일", "날짜별"], bars: 30 }, "R9 받는 중에 묶는 기준을 눌러도 앞 기간의 줄을 새 기간 아래 그리지 않는다 — 답이 오면 고른 기준으로 선다");
same(R.railMore, { before: { head: "만든 지식 8", links: 6, more: "2개 더" }, after: { links: 8, more: false } }, "R19 옆 칸의 목록은 여섯까지 — [n개 더]로 나머지를 편다");
same(R.afterLastWeek, { rows: 3, on: ["지난 주", "프로젝트별"] }, "R18 [지난 주 보기] → 지난 주가 켜지고 그 줄이 선다(묶는 기준은 고른 그대로)");
same(R.lateTimer, { hash: "#/sessions/c1?node=", reqs: 0 }, "R17 떠난 화면의 찾기 타이머는 주소를 덮지 않고 요청도 내지 않는다");
check(!!R.page && R.page.back.length === 1 && /^#\/sessions/.test(R.page.back[0]) && R.page.tabs === 0 && R.page.card === true && R.page.embed === false && R.page.fit === true, "R12 대화록 단독 화면 — 「뒤로」 · 탭 없음 · 창 바닥까지 채운다", JSON.stringify(R.page));
same(R.page && [R.page.resume, R.page.door, R.page.left], [false, ["#/s/box-1"], true], "R12 단독 화면도 문은 하나 — 내 세션이면 옆 칸에 남긴 것이 서고, 박스를 알게 되면 [세션 열기]로 바뀐다");
same(R.pickKeep, { value: "3870", on: true }, "R11 고른 프로젝트는 화면이 다시 그려져도 남는다 — 목록이 늦게 채워진 뒤에도 그 값과 켜진 색");
same(R.pageOther, { left: false, resume: 1, door: 0, trash: false, toc: 2 }, "R12·R25 남의 세션의 단독 화면 — 「남긴 것」도 [휴지통으로]도 없고 문은 「이어 질문하기」 하나(떠난 화면의 늦은 답이 이 화면의 문을 [세션 열기]로 바꾸지 않는다) · 질문 목차는 선다");
same(R.frame, { fit: true, applied: true, tabIcons: 3, brand: "세션 이력" }, "R1 앱 틀 — 창 바닥까지 채우고(그 높이가 실제로 먹는다 · 창보다 크지 않다) 탭마다 그림이 선다");
// W
check(Array.isArray(R.pageErrors) && R.pageErrors.length === 0, "W 페이지 오류 0", JSON.stringify(R.pageErrors));

console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
