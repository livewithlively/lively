#!/usr/bin/env node
// 통합검색(⌘K) — 대화 결과 · 최신순 · 기간이 **실제 화면에서** 도나 — 런타임 회귀 테스트 (#4517, 원준 2026-09-30)
//
// 신고: «cmd+K 검색 안에 세션의 대화내용으로도 세션을 검색하고 싶어. 지금 완전 관련도 순으로만 나오는데 이러니까 최신순이
//  아예 안 되더라. 슬랙 참고해서 고쳐 줘. 필터가 필요한 건지 뭔지 아무튼 구현 고고»
//
// 엣지 표(스크래치패드 spec.md F — 행마다 장면 하나):
//  F1  기본 검색(칩 없음) → 대화 채널을 부른다(sort=relevance · since 없음) · 「대화」 묶음이 선다
//  F2  대화 줄 = 세션 이름 + 누구의 말(지시/AI) + 발췌문(일치 색칠) + 시각 + 「대화」 배지
//  F3  셸이 아는 세션 → #/s/<id> · 모르는 세션 → #/sessions/<uuid>?node=<node>
//  F4  이름으로 이미 뜬 세션과 같은 세션의 대화 결과 → 한 줄만
//  F5  최신순 → 맨 위 «가장 맞는 결과»(≤3, 이름·번호·제목이 맞은 것) · 그 아래 날짜 묶음 · 시각 역순
//  F6  최신순에서 의미검색만으로 온 것(제목에 낱말이 없다)은 목록에 없다
//  F7  최신순에선 본문에서 맞은 지식도 선다 / 관련도순에선 안 선다(종전 규칙) · 최신순은 의미검색(semantic)을 부르지 않는다
//  F8  정렬은 다시 열어도 유지된다(저장)
//  F9  기간 «오늘» → 오늘 밖의 줄이 빠진다 · 대화 요청에 since · 기간은 저장하지 않는다
//  F10 기간 메뉴가 떠 있을 때 Esc → 메뉴만 닫히고 검색 창은 그대로
//  F11 대화 색인이 밀려 있으면 안내 줄이 그 사실을 말한다
//  F12 결과가 없고 기간을 골랐으면 «기간 안의 결과만 보여 준다» 를 말한다
//  F13 대화 채널이 실패하면(503 시간 초과) «결과 없음» 이 아니라 «가져오지 못했다» 를 말한다(격리 리뷰)
//  F14 200자 넘는 검색어 — 대화 채널을 부르지 않고(서버가 400) 그 이유를 말한다
//  F15 접근성 — 기간 단추는 메뉴가 떠 있는 동안 aria-expanded=true · 정렬·기간 단추는 «종류 필터» 묶음 밖(자기 묶음)
//  F16 밀린 색인 수를 서버가 못 셌으면(pending null) 그 사실을 말한다(재검토)
//  F17 서버 오류(500 internal_error)는 읽을 수 있는 말로 — 코드값이 안내 줄에 그대로 서지 않는다(재검토)
//  F18 창을 닫으면 진행 중인 대화 요청을 끊는다(재검토 — 닫아도 낡은 검색이 서버 연결을 쥐던 것)
//  F19 최신순 맨 위 «가장 맞는 결과» 도 글자로 맞은 것에서만 — 제목 적중이 셋이 안 되면 코사인만 넘은 무관한 문서가 서던 것
//      (매니지드 실측 2026-10-01: «세션의 대화내용으로도» 에 무관한 프로젝트 둘 · 지식 하나)
//  W   모든 장면을 통틀어 페이지 오류 0 · 배선(가짜 서버가 실제로 불렸다)
//
// 왜 런타임인가: 결함이 «어느 채널을 부르나 · 어떤 줄이 어느 묶음에 어떤 순서로 서나 · 누르면 어디로 가나 · Esc 가 누구 것인가»
//  라 소스 문자열로는 안 보인다. 프로덕션 소스(web/v2/omni.ts 와 그 의존)를 esbuild 로 묶어 헤드리스 크롬에 세우고, 가짜 서버가
//  받은 **요청 URL** 과 **그려진 줄**로 판정한다.
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(변경 전 = `git archive HEAD web public/styles`).
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;

const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 통합검색 런타임 검증 미실행");
  process.exit(0);
}
const STYLES = path.join(SRC_ROOT, "public/styles");
const CSS = ["01-base.css", "43-v2-topbar-search.css", "49-v2-ctx.css"].map((f) => path.join(STYLES, f));
for (const f of CSS) if (!existsSync(f)) { console.error(`FAIL  스타일시트 없음: ${f}`); process.exit(1); }

const bundle = buildSync({
  stdin: { contents: "export { omniOpen, omniClose, omniIsOpen, setOmniHooks } from './web/v2/omni.ts';", resolveDir: SRC_ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "OM", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;

async function PAGE_MAIN() {
  const R = {};
  const pageErrors = [];
  window.addEventListener("error", (e) => pageErrors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => pageErrors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const waitFor = async (fn, ms = 5000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(20); } return false; };
  localStorage.setItem("lively_ui_token", "t");
  localStorage.removeItem("lively.omni.sort");

  // ── 시각 — 자정 경계에서 흔들리지 않게 «오늘» 것은 오늘 0시와 지금의 한가운데에 둔다 ──
  const NOW = Date.now(), D = 86_400_000, H = 3_600_000;
  const T0 = new Date(NOW); T0.setHours(0, 0, 0, 0);
  const TODAY = Math.round((T0.getTime() + NOW) / 2);
  const iso = (ms) => new Date(ms).toISOString();
  const AT = {};   // 제목 → 시각(ms) — 최신순 판정용
  const put = (title, ms) => { AT[title] = ms; return iso(ms); };     // 서버 행은 ISO 글자로 온다
  const putMs = (title, ms) => { AT[title] = ms; return ms; };        // 셸 목록(Sess.lastSeen)은 ms 숫자다

  // ── 가짜 서버 데이터 ──
  const SIM = [
    { name: "k-design", title: "슬랙 검색 설계", similarity: 0.70, updated_at: put("슬랙 검색 설계", NOW - 3 * D) },
    { name: "k-link", title: "슬랙 연동", similarity: 0.66, updated_at: put("슬랙 연동", T0.getTime() - 12 * H) },
    { name: "k-memo", title: "검색 개선 메모", similarity: 0.65, updated_at: put("검색 개선 메모", TODAY) },   // 의미로만 왔다(제목에 «슬랙» 없음)
    { name: "k-alarm", title: "슬랙 알림", similarity: 0.62, updated_at: put("슬랙 알림", NOW - 10 * D) },
  ];
  //  코사인만 높은 무관한 문서 셋(0.78~0.80) — F19(«메모» 가 든 질의)에서만 온다. 셋 다 «글자로 맞은 문서»(0.70)보다 위라
  //   «앞 셋을 자른 뒤 거르기» 로 고치면 맨 위가 비어 드러난다(재검토 지적: 거르는 순서를 시험이 못 가렸다).
  const SIM_NOISE = [
    { name: "k-onb", title: "온보딩 플로우 직무 분류", similarity: 0.80, updated_at: iso(NOW - 2 * D) },
    { name: "k-ds", title: "디자인 시스템 토큰 정리", similarity: 0.79, updated_at: iso(NOW - 4 * D) },
    { name: "k-dock", title: "도커를 완전히 걷어 낸 기록", similarity: 0.78, updated_at: iso(NOW - 6 * D) },
  ];
  const GREP = [
    { name: "k-minutes", title: "회의록 정리", snippet: "L3: 슬랙 이야기를 했다", updated_at: put("회의록 정리", TODAY - 60_000) },   // 본문에서만 맞음
    { name: "k-link", title: "슬랙 연동", snippet: "L1: 슬랙", updated_at: iso(AT["슬랙 연동"]) },
    //  의미로도(SIM 0.70) 글자로도 맞는 문서 — F19 에서 «가장 맞는 결과» 에 남아야 하는 쪽(제목엔 «메모» 가 없다)
    { name: "k-design", title: "슬랙 검색 설계", snippet: "L2: 슬랙 메모 정리", updated_at: iso(AT["슬랙 검색 설계"]) },
    //  ⚠ 채널이 오는 순서가 시각 순이 아니게 둔다 — 이 오래된 것이 뒤의 대화 채널(오늘 것)보다 먼저 온다. 정렬이 빠지면 드러난다.
    { name: "k-weekly", title: "주간 보고", snippet: "L9: 슬랙 알림 정리", updated_at: put("주간 보고", NOW - 5 * D) },
  ];
  const CONV = [
    //  셸 목록의 box-a 가 지금 돌리는 대화 — 이름으로 이미 뜬 세션과 같은 곳이다(F4)
    { node_id: "", session_id: "conv-a", name: "서버가 준 이름 A", title: null, at: iso(TODAY), hits: 2, score: 50, best: { role: "user", ts: iso(TODAY), text: "슬랙처럼 검색 고쳐 줘" } },
    //  셸이 아는 지난 세션(기록만 남은 줄, id = 대화 uuid)
    { node_id: "", session_id: "conv-b", name: "서버 이름 B", title: null, at: put("지난 대화 B", NOW - 3 * D - H), hits: 1, score: 40, best: { role: "assistant", ts: iso(NOW - 3 * D - H), text: "관련도순과 최신순을 나누고 슬랙처럼 맨 위에 셋" } },
    //  셸이 모르는 오늘 대화 — 글자 검색 채널의 옛 줄(주간 보고)보다 늦다
    { node_id: "", session_id: "conv-d", name: "새 대화 D", title: null, at: put("새 대화 D", TODAY + 500), hits: 1, score: 20, best: { role: "user", ts: iso(TODAY + 500), text: "슬랙 연결 다시" } },
    //  셸이 모르는 세션(초대받은 세션의 옛 대화 등) — 대화록 화면으로
    { node_id: "n1", session_id: "conv-c", name: "모르는 세션", title: null, at: put("모르는 세션", NOW - 40 * D), hits: 5, score: 30, best: { role: "user", ts: iso(NOW - 40 * D), text: "예전에 슬랙 얘기를 했다" } },
  ];
  let PENDING = 3;
  let CONV_FAIL = false;            // true = 503(사람 말) · "500" = internal_error
  let CONV_HANG = false;            // 대화 요청이 끝나지 않는다 — 끊기는지 본다(F18)
  let HANGING = 0, HANG_ABORTED = false;
  const log = [];
  const J = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  window.fetch = async (url, opts) => {
    const u = new URL(String(url), "http://x/");
    log.push(decodeURIComponent(u.pathname + u.search));
    const q = u.searchParams.get("q") || u.searchParams.get("text") || "";
    const hit = q.includes("슬랙");
    const p = u.pathname;
    if (p.endsWith("/api/ui/knowledge/similar")) return J({ entries: hit ? (q.includes("메모") ? [...SIM, ...SIM_NOISE] : SIM) : [] });
    if (p.endsWith("/api/ui/knowledge/semantic")) return J({ entries: [] });
    if (p.endsWith("/api/ui/knowledge/search")) return J({ entries: hit ? GREP : [] });
    if (/\/api\/ui\/v6\/projects\/(similar|semantic|search)$/.test(p)) return J({ projects: [] });
    if (p.endsWith("/api/ui/sources")) return J({ entries: [] });
    if (p.endsWith("/api/ui/v6/session-search")) {
      if (CONV_FAIL === "500") return new Response(JSON.stringify({ error: "internal_error" }), { status: 500, headers: { "content-type": "application/json" } });
      if (CONV_FAIL) return new Response(JSON.stringify({ error: "대화 검색이 시간 안에 끝나지 않았습니다 — 낱말을 더 넣어 좁혀 주세요" }), { status: 503, headers: { "content-type": "application/json" } });
      if (CONV_HANG) {
        HANGING++;
        return new Promise((_, rej) => {
          const sig = opts && opts.signal;
          if (sig) sig.addEventListener("abort", () => { HANG_ABORTED = true; rej(new DOMException("aborted", "AbortError")); });
        });
      }
      const since = u.searchParams.get("since");
      let rows = hit ? CONV.filter((c) => !since || Date.parse(c.at) >= Date.parse(since)) : [];
      if (u.searchParams.get("sort") === "recent") rows = [...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      return J({ results: rows, pending: PENDING, capped: false });
    }
    return J({});
  };

  const SRC = document.getElementById("omsrc").textContent;
  const OM = (new Function(SRC + "\n;return OM;"))();
  const OPENED = [];
  const DATA = { projects: [], loadedAt: NOW, sessions: [
    { id: "box-a", label: "슬랙 검색 고치기", projectId: null, node: null, live: true, alive: true, owned: true, stateKey: "idle", stateLabel: "대기",
      lastSeen: putMs("슬랙 검색 고치기", TODAY + 1000), raw: { claudeSessionId: "conv-a", harness: "claude" } },
    { id: "conv-b", label: "지난 대화 B", projectId: null, node: null, live: false, alive: false, owned: true, stateKey: "log", stateLabel: "기록",
      lastSeen: NOW - 3 * D - H, raw: {} },
  ] };
  OM.setOmniHooks({ data: () => DATA, open: (href, newTab, title) => OPENED.push({ href, newTab, title }) });

  const $ = (s) => document.querySelector(s);
  const settled = () => { const n = $(".v2-omni-note"); return !!n && (n.hidden || !/찾는 중/.test(n.textContent)); };
  async function search(q) {
    if (!OM.omniIsOpen()) OM.omniOpen();
    const input = $(".v2-omni-in");
    input.value = q;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(320);                      // 입력 디바운스(200ms) 뒤에 run 이 돈다
    await waitFor(settled);
    await sleep(60);
  }
  //  그려진 목록 → [{h, rows:[{t, badge, role, when, marks, sub}]}]
  function shape() {
    const out = [];
    for (const n of $(".v2-omni-list").children) {
      if (n.classList.contains("v2-omni-gh")) out.push({ h: n.textContent, rows: [] });
      else if (n.classList.contains("v2-omni-row")) {
        const g = out[out.length - 1] || (out.push({ h: "", rows: [] }), out[out.length - 1]);
        g.rows.push({
          t: n.querySelector(".v2-omni-t")?.textContent || "",
          badge: n.querySelector(".v2-omni-badge")?.textContent || "",
          role: n.querySelector(".v2-omni-role")?.textContent || "",
          when: n.querySelector(".v2-omni-when")?.textContent || "",
          marks: [...n.querySelectorAll("mark.v2-omni-hl")].map((m) => m.textContent),
          sub: n.querySelector(".v2-omni-s")?.textContent || "",
        });
      }
    }
    return out;
  }
  const rowEl = (title) => [...document.querySelectorAll(".v2-omni-row")].find((r) => r.querySelector(".v2-omni-t")?.textContent === title);
  const since = (n0) => log.slice(n0);

  try {
    // ── F1·F2·F4·F7(관련도순)·F11 ──
    let n0 = log.length;
    await search("슬랙");
    R.relReqs = since(n0);
    R.rel = shape();
    R.relNote = $(".v2-omni-note")?.hidden ? "" : ($(".v2-omni-note")?.textContent || "");

    // ── F3 누르면 어디로 가나 ──
    rowEl("모르는 세션")?.click();
    R.openC = OPENED[OPENED.length - 1] || null;
    R.closedAfterClick = !OM.omniIsOpen();
    await search("슬랙");
    rowEl("지난 대화 B")?.click();
    R.openB = OPENED[OPENED.length - 1] || null;

    // ── F5·F6·F7(최신순) ──
    await search("슬랙");
    n0 = log.length;
    [...document.querySelectorAll(".v2-omni-segb")].find((b) => /최신순/.test(b.textContent))?.click();
    await sleep(60);
    await waitFor(settled);
    await sleep(60);
    R.recReqs = since(n0);
    R.rec = shape();
    R.AT = AT;

    // ── F8 정렬 저장 ──
    OM.omniClose();
    OM.omniOpen();
    R.sortPressed = [...document.querySelectorAll(".v2-omni-segb")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent);
    R.sortStored = localStorage.getItem("lively.omni.sort");

    // ── F10 기간 메뉴 + Esc ──
    await search("슬랙");
    $(".v2-omni-period")?.click();
    await waitFor(() => !!$(".pn-ctx"));
    R.menuOpened = !!$(".pn-ctx");
    R.expandedOpen = $(".v2-omni-period")?.getAttribute("aria-expanded");
    R.groups = { kindsHasSort: !!document.querySelector('[aria-label="종류 필터"] .v2-omni-segb'), kindsHasPeriod: !!document.querySelector('[aria-label="종류 필터"] .v2-omni-period'),
      toolsGroup: !!document.querySelector('[role="group"][aria-label="정렬과 기간"] .v2-omni-segb') && !!document.querySelector('[role="group"][aria-label="정렬과 기간"] .v2-omni-period') };
    await sleep(120);   // 메뉴는 연 박자가 지난 뒤에 키를 듣는다(ctx-menu 가 여는 클릭에 스스로 닫히지 않게) — 사람의 손도 그보다 느리다
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await sleep(80);
    R.afterEsc = { menu: !!$(".pn-ctx"), omni: OM.omniIsOpen() };
    R.expandedClosed = $(".v2-omni-period")?.getAttribute("aria-expanded");

    // ── F9 기간 «오늘» ──
    $(".v2-omni-period")?.click();
    await waitFor(() => !!$(".pn-ctx"));
    n0 = log.length;
    [...document.querySelectorAll(".pn-ctx .pn-ctx-i")].find((b) => b.textContent.includes("오늘"))?.click();
    await sleep(320);
    await waitFor(settled);
    await sleep(60);
    R.todayReqs = since(n0);
    R.today = shape();
    R.periodBtn = $(".v2-omni-period")?.textContent || "";
    R.storedKeys = Object.keys(localStorage);

    // ── F12 결과 없음 + 기간 ──
    PENDING = 0;
    await search("없는말");
    R.emptyNote = $(".v2-omni-note")?.textContent || "";
    R.emptyRows = document.querySelectorAll(".v2-omni-row").length;

    // ── F13 대화 채널 실패 ──
    CONV_FAIL = true;
    await search("슬랙");
    R.failNote = $(".v2-omni-note")?.textContent || "";
    R.failRows = [...document.querySelectorAll(".v2-omni-row .v2-omni-badge")].map((b) => b.textContent);
    CONV_FAIL = false;

    // ── F14 200자 넘는 검색어 ──
    n0 = log.length;
    await search("슬랙 " + "가".repeat(205));
    R.longReqs = since(n0);
    R.longNote = $(".v2-omni-note")?.textContent || "";

    // ── F16 밀린 수를 모른다(null) ──
    PENDING = null;
    await search("슬랙");
    R.unknownNote = $(".v2-omni-note")?.textContent || "";
    PENDING = 0;

    // ── F17 서버 오류 500 internal_error ──
    CONV_FAIL = "500";
    await search("슬랙");
    R.err500Note = $(".v2-omni-note")?.textContent || "";
    CONV_FAIL = false;

    // ── F18 창을 닫으면 진행 중인 대화 요청을 끊는다 ──
    CONV_HANG = true;
    if (!OM.omniIsOpen()) OM.omniOpen();
    const hin = $(".v2-omni-in");
    hin.value = "슬랙 끊기";
    hin.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => HANGING > 0, 3000);
    R.hangStarted = HANGING;
    OM.omniClose();
    await sleep(80);
    R.hangAborted = HANG_ABORTED;
    CONV_HANG = false;

    // ── F19 최신순 · 전체 기간 · 제목 적중 없는 질의(«슬랙 메모» — 두 낱말이 다 든 제목은 없다) ──
    if (!OM.omniIsOpen()) OM.omniOpen();
    $(".v2-omni-period")?.click();
    await waitFor(() => !!$(".pn-ctx"));
    [...document.querySelectorAll(".pn-ctx .pn-ctx-i")].find((b) => b.textContent.includes("전체 기간"))?.click();
    await sleep(120);
    R.f19Period = $(".v2-omni-period")?.textContent || "";
    R.f19Sort = [...document.querySelectorAll(".v2-omni-segb.on")].map((b) => b.textContent);
    await search("슬랙 메모");
    R.f19 = shape();
  } catch (e) { R.err = String(e && e.stack || e); }

  R.pageErrors = pageErrors;
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const PAGE = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out">PENDING</pre>
<script type="text/plain" id="omsrc">${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;

if (process.env.DUMP_PAGE) { const fs = await import("node:fs"); fs.writeFileSync(process.env.DUMP_PAGE, PAGE); for (const f of CSS) fs.copyFileSync(f, path.join(path.dirname(process.env.DUMP_PAGE), path.basename(f))); }
const dom = await dumpDom(chrome, { html: PAGE, copy: CSS, prefix: "omni-search-", virtualTimeBudget: 60000 });
const m = /<pre id="out">([\s\S]*?)ENDRESULT/.exec(dom);
if (!m) { console.error("FAIL  결과 표지를 못 받았다\n" + dom.slice(0, 1500)); process.exit(1); }
const txt = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const R = JSON.parse(txt);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why) => (cond ? ok(n) : bad(n, why));
for (const k of ["fatal", "err"]) if (R[k]) bad(`장면 오류 ${k}`, String(R[k]).slice(0, 600));

const group = (sh, h) => (sh || []).find((g) => g.h === h);
const allRows = (sh) => (sh || []).flatMap((g) => g.rows);
const titles = (sh) => allRows(sh).map((r) => r.t);
const convReq = (reqs) => (reqs || []).filter((l) => l.startsWith("/api/ui/v6/session-search?"));

// 배선 — 가짜 서버가 실제로 불렸고 줄이 섰다. 안 섰으면 아래 «없다» 단언이 공짜로 초록이 된다.
check(Array.isArray(R.relReqs) && R.relReqs.some((l) => l.startsWith("/api/ui/knowledge/similar")) && allRows(R.rel).length >= 3,
  "W 배선 — 가짜 서버가 불렸고 관련도순 줄이 섰다", JSON.stringify({ reqs: R.relReqs, rows: titles(R.rel) }));

// F1
check(convReq(R.relReqs).length === 1 && /sort=relevance/.test(convReq(R.relReqs)[0]) && !/since=/.test(convReq(R.relReqs)[0]),
  "F1 기본 검색이 대화 채널을 부른다(관련도순 · 기간 없음)", JSON.stringify(convReq(R.relReqs)));
check(!!group(R.rel, "대화"), "F1 「대화」 묶음이 선다", JSON.stringify((R.rel || []).map((g) => g.h)));
// F2
{
  const b = allRows(R.rel).find((r) => r.t === "지난 대화 B");
  const c = allRows(R.rel).find((r) => r.t === "모르는 세션");
  check(!!b && b.badge === "대화" && b.role === "AI" && b.when !== "" && b.marks.includes("슬랙"),
    "F2 대화 줄 = 이름 · AI 표 · 발췌문 색칠 · 시각 · 「대화」 배지", JSON.stringify(b));
  check(!!c && c.role === "지시" && /맞은 말 5개/.test(c.sub), "F2 사람 말이면 «지시» · 맞은 말 수", JSON.stringify(c));
}
// F3
check(R.openC && R.openC.href === "#/sessions/conv-c?node=n1" && R.closedAfterClick, "F3 셸이 모르는 세션 → 대화록 화면(노드 좌표 포함)", JSON.stringify(R.openC));
check(R.openB && R.openB.href === "#/s/conv-b", "F3 셸이 아는 지난 세션 → #/s/<그 id>", JSON.stringify(R.openB));
// F4
check(titles(R.rel).filter((t) => t === "슬랙 검색 고치기").length === 1 && !titles(R.rel).includes("서버가 준 이름 A"),
  "F4 이름으로 뜬 세션과 같은 세션의 대화 결과는 한 줄만", JSON.stringify(titles(R.rel)));
// F7(관련도순 쪽)
check(!titles(R.rel).includes("회의록 정리"), "F7 관련도순에선 본문에서만 맞은 지식이 서지 않는다(종전 규칙)", JSON.stringify(titles(R.rel)));
// F11
check(/대화 색인을 만드는 중입니다/.test(R.relNote || "") && /3개/.test(R.relNote || ""), "F11 색인이 밀려 있으면 안내 줄이 말한다", JSON.stringify(R.relNote));

// F5
{
  const sh = R.rec || [];
  const top = sh[0];
  check(!!top && top.h === "가장 맞는 결과" && top.rows.length >= 1 && top.rows.length <= 3 && top.rows.every((r) => r.t.includes("슬랙")),
    "F5 최신순 맨 위 = «가장 맞는 결과» 최대 셋(제목이 맞은 것)", JSON.stringify(top));
  const BUCKETS = ["오늘", "어제", "최근 7일", "최근 30일", "그 이전", "시각 모름"];
  const rest = sh.slice(1).filter((g) => g.h !== "화면");
  const idx = rest.map((g) => BUCKETS.indexOf(g.h));
  check(rest.length >= 2 && idx.every((i) => i >= 0) && idx.every((v, i) => i === 0 || v > idx[i - 1]),
    "F5 그 아래는 날짜 묶음이 오늘 → 옛날 순으로", JSON.stringify(rest.map((g) => g.h)));
  const tl = rest.flatMap((g) => g.rows).map((r) => r.t);
  const times = tl.map((t) => R.AT[t]);
  check(times.every((v) => typeof v === "number") && times.every((v, i) => i === 0 || v <= times[i - 1]),
    "F5 날짜 묶음 안팎으로 시각 역순", JSON.stringify(tl.map((t, i) => `${t}@${new Date(times[i] || 0).toISOString()}`)));
  // F6
  check(!titles(sh).includes("검색 개선 메모"), "F6 최신순에 의미검색만으로 온 것은 없다", JSON.stringify(titles(sh)));
  // F7(최신순 쪽)
  check(tl.includes("회의록 정리"), "F7 최신순에선 본문에서 맞은 지식도 선다", JSON.stringify(tl));
  check(convReq(R.recReqs).some((l) => /sort=recent/.test(l)) && !(R.recReqs || []).some((l) => /\/semantic\?/.test(l))
    && (R.recReqs || []).some((l) => /^\/api\/ui\/knowledge\/search\?limit=20&/.test(l)),
    "F7 최신순 요청: 대화 sort=recent · 의미검색(semantic) 안 부름 · 글자 검색 20개", JSON.stringify(R.recReqs));
  check(tl.includes("지난 대화 B") && tl.includes("모르는 세션"), "F5 대화 결과도 시각 축에 함께 선다", JSON.stringify(tl));
}
// F8
check(JSON.stringify(R.sortPressed) === '["최신순"]' && R.sortStored === "recent", "F8 정렬은 다시 열어도 최신순(저장)", JSON.stringify({ p: R.sortPressed, s: R.sortStored }));
// F10
check(R.menuOpened && R.afterEsc && R.afterEsc.menu === false && R.afterEsc.omni === true, "F10 기간 메뉴에서 Esc → 메뉴만 닫힌다", JSON.stringify({ o: R.menuOpened, a: R.afterEsc }));
// F9
{
  const t = titles(R.today);
  const conv = convReq(R.todayReqs);
  check(t.length >= 1 && !t.includes("슬랙 알림") && !t.includes("모르는 세션") && !t.includes("지난 대화 B") && !t.includes("슬랙 검색 설계") && !t.includes("주간 보고"),
    "F9 오늘 밖의 줄이 빠진다", JSON.stringify(t));
  check(t.includes("회의록 정리") && t.includes("슬랙 검색 고치기") && t.includes("새 대화 D"), "F9 오늘 것은 남는다", JSON.stringify(t));
  check(conv.length >= 1 && conv.every((l) => /since=/.test(l)), "F9 대화 요청에 since 를 싣는다", JSON.stringify(conv));
  check(/오늘/.test(R.periodBtn || ""), "F9 기간 단추가 고른 기간을 말한다", JSON.stringify(R.periodBtn));
  check(!(R.storedKeys || []).some((k) => /period|기간/i.test(k)), "F9 기간은 저장하지 않는다", JSON.stringify(R.storedKeys));
}
// F12
check(R.emptyRows === 0 && /오늘 안의 결과만 보여 줍니다/.test(R.emptyNote || "") && /더 나올 수 있습니다/.test(R.emptyNote || ""),
  "F12 결과 없음 + 기간 → 기간 이유를 말한다(빠짐없이 봤다고 하지 않는다)", JSON.stringify({ n: R.emptyRows, note: R.emptyNote }));
// F13
check(/대화 결과를 가져오지 못했습니다/.test(R.failNote || "") && /시간 안에 끝나지 않았습니다/.test(R.failNote || "") && (R.failRows || []).length > 0,
  "F13 대화 채널이 실패하면 다른 결과는 그대로 두고 «가져오지 못했다» 를 말한다", JSON.stringify({ note: R.failNote, rows: R.failRows }));
// F14
check(!(R.longReqs || []).some((l) => l.startsWith("/api/ui/v6/session-search")) && /검색어가 길어/.test(R.longNote || ""),
  "F14 200자 넘는 검색어는 대화 채널을 부르지 않고 그 이유를 말한다", JSON.stringify({ reqs: R.longReqs, note: R.longNote }));
// F15
check(R.expandedOpen === "true" && R.expandedClosed === "false", "F15 기간 단추 aria-expanded — 열면 true · 닫으면 false", JSON.stringify({ o: R.expandedOpen, c: R.expandedClosed }));
check(R.groups && !R.groups.kindsHasSort && !R.groups.kindsHasPeriod && R.groups.toolsGroup, "F15 정렬·기간 단추는 «종류 필터» 묶음 밖 자기 묶음에 있다", JSON.stringify(R.groups));
// F16
check(/확인하지 못했습니다/.test(R.unknownNote || "") && !/색인을 만드는 중/.test(R.unknownNote || ""),
  "F16 밀린 수를 서버가 못 셌으면 «확인하지 못했다» 를 말한다(조용히 넘기지 않는다)", JSON.stringify(R.unknownNote));
// F17
check(/서버에 오류가 났습니다/.test(R.err500Note || "") && !/internal_error/.test(R.err500Note || ""),
  "F17 500 internal_error 는 읽을 수 있는 말로 — 코드값이 안내 줄에 서지 않는다", JSON.stringify(R.err500Note));
// F18
check(R.hangStarted >= 1 && R.hangAborted === true, "F18 창을 닫으면 진행 중인 대화 요청을 끊는다", JSON.stringify({ s: R.hangStarted, a: R.hangAborted }));
// F19
{
  const sh = R.f19 || [];
  const top = (sh[0] && sh[0].h === "가장 맞는 결과") ? sh[0].rows.map((r) => r.t) : [];
  const all = titles(sh);
  check((R.f19Period || "").trim() === "기간" && JSON.stringify(R.f19Sort) === '["최신순"]' && all.length >= 2,
    "F19 배선 — 최신순 · 전체 기간에서 줄이 섰다", JSON.stringify({ p: R.f19Period, s: R.f19Sort, all }));
  check(!all.includes("검색 개선 메모") && !all.includes("슬랙 알림") && !all.some((t) => /온보딩 플로우|디자인 시스템|도커를/.test(t)),
    "F19 최신순 어디에도(맨 위 셋 포함) 코사인만으로 온 문서가 서지 않는다", JSON.stringify({ top, all }));
  check(top.includes("슬랙 검색 설계"), "F19 글자로도 맞은 문서(코사인 + 본문 적중)는 맨 위 셋에 남는다", JSON.stringify(top));
}
// W
check(Array.isArray(R.pageErrors) && R.pageErrors.length === 0, "W 페이지 오류 0", JSON.stringify(R.pageErrors));

console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
