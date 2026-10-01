#!/usr/bin/env node
// 통합검색(⌘K) — **실제 화면에서** 순서·흔들림·Enter·선택·초점·줄 정보가 맞나 — 런타임 회귀 테스트(#4517 → #4530)
//
// 신고(#4530, 원준 2026-10-01): «관련도가 적당히 있는 걸 시간순으로 보여 줘야지 … 슬랙도 참고하고» · «대화 내용의 일부나 그 세션에서
//  고쳤던 대상을 어렴풋하게 쳐서 그 세션을 찾는데 퀄리티가 형편없다» · «폰에서는 보이는 화면이 별로 없을걸». 점검 46건(지식
//  omni-search-audit-defects-4530) 중 화면에서만 보이는 것을 장면으로 잰다.
//
// 엣지 표(행마다 장면 하나):
//  G1  기본(아무것도 저장 안 됨) = 최신순 · 요청 = 대화 sort=recent · 지식/프로젝트 글자 검색 plain=1 · 뜻 비슷(similar) ·
//      의미검색(semantic)·프로젝트 뜻 채널(similar·semantic)은 안 부름
//  G2  배치 = «가장 맞는 결과»(≤3) → 날짜 묶음(오늘 → 옛날) → «바로 가기» → «뜻이 비슷한 지식»(맨 끝) · 날짜 묶음 안팎으로 시각 역순
//  G3  본문에서만 맞은 지식도 시간 줄에 선다 · 뜻으로만 온 지식은 시간 줄에 없고 맨 끝 묶음에만
//  G4  대화 줄 = 이름 · 누구의 말(지시/AI) · 발췌문 색칠 · «고친 파일 v2/omni.ts» · 맞은 곳 수 · 시각
//  G5  이름으로도 대화로도 맞은 세션은 한 줄 — 그 줄이 대화 발췌문(왜 맞았나)을 보인다
//  G6  휴지통 세션은 안 보인다 · 팀원 세션은 «…의 세션» 으로 보인다
//  G7  프로젝트 줄 — 태스크는 «상위 이름 ›» · 완료는 «완료» · 이름이 같은 다른 프로젝트 둘은 둘 다 보인다
//  G8  지식 제목의 머리말(as-built(#…):)은 따로 작게 · 둘째 줄에 마크다운 기호·자동 안내문이 없다
//  G9  치는 동안 — 앞 결과를 비우지 않고 흐리게 둔다(stale) · 자리 잡으면 새 결과로 한 번에
//  G10 결과가 오기 전에 Enter → 바로 열지 않고, 자리 잡은 뒤 그 첫 줄을 연다
//  G11 화살표로 고른 줄은 늦게 온 채널이 끼어들어도 그대로다(열쇠로 기억)
//  G12 칩을 누르면 입력칸에 초점이 남고 그 종류의 채널만 부른다 · 안내 문구가 좁힌 사실을 말한다
//  G13 닫으면 연 순간 초점이 있던 칸으로 돌아간다 · 주소가 바뀌면 닫힌다 · Tab 은 창 안에서만 돈다
//  G14 결과를 열고 10분 안에 다시 열면 그 검색어가 그대로 · 빈 칸엔 최근 검색 · 최근 연 것 · 내 최근 세션(휴지통·팀원 제외)
//  G15 관련도순 = «가장 맞는 결과» 다음 종류별 묶음 · 정렬은 저장된다(lively.omni.sort.v2)
//  G16 기간 «오늘» — 오늘 밖의 줄이 빠진다 · 대화 요청에 since · 기간은 저장하지 않는다 · 기간 메뉴의 Esc 는 메뉴만 닫는다
//  G17 안내 줄 — 색인 중(수) · 밀린 수 모름(null) · 대화 채널 503 · 500 internal_error · 200자 넘는 검색어 · 결과 없음 + 기간
//  G18 창을 닫으면 진행 중인 요청을 끊는다
//  G21 대화가 1.5초 늦게 와도(색인을 다시 쓰는 동안의 실측 1.4초) 기다렸다가 맨 위 셋에 세운다 — 1.2초 상한 때는 맨 위가 빈 채 굳었다
//  G22 뜻 비슷 채널은 자리 잡기를 막지 않는다(맨 아래 묶음 전용) — 늦게 와도 글자 결과는 바로 선다
//  G23 지식 채널이 실패하면 «결과가 없습니다» 대신 실패를 말한다(전엔 말없이 빈 결과)
//  G24 칩 하나만 켜도 서버가 꽉 채워 보내면 «결과 더 보기» 가 뜨고, 누르면 더 많이 청한다(전엔 줄 40개 넘을 때만)
//  G25 Alt+Enter 는 새 화면으로 연다(가이드 표기 · 고치기 전 동작)
//  W   모든 장면을 통틀어 페이지 오류 0 · 배선(가짜 서버가 실제로 불렸다)
//
// 왜 런타임인가: 결함이 «어느 채널을 부르나 · 어떤 줄이 어느 묶음에 어떤 순서로 서나 · 언제 무엇이 열리나 · 초점이 어디 있나»
//  라 소스 문자열로는 안 보인다. 프로덕션 소스(web/v2/omni.ts 와 그 의존)를 esbuild 로 묶어 헤드리스 크롬에 세우고, 가짜 서버가
//  받은 **요청 URL** 과 **그려진 줄**로 판정한다.
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(변경 전 = `git archive HEAD web public/styles`).
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

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
  stdin: { contents: "export { omniOpen, omniClose, omniIsOpen, setOmniHooks, bindOmniKey } from './web/v2/omni.ts';", resolveDir: SRC_ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "OM", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;

async function PAGE_MAIN() {
  const R = {};
  const pageErrors = [];
  window.addEventListener("error", (e) => pageErrors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => pageErrors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const waitFor = async (fn, ms = 6000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(15); } return false; };
  localStorage.setItem("lively_ui_token", "t");
  for (const k of ["lively.omni.sort", "lively.omni.sort.v2", "lively.omni.opened", "lively.omni.queries"]) localStorage.removeItem(k);

  // ── 시각 — 자정 경계에서 흔들리지 않게 «오늘» 것은 오늘 0시와 지금의 한가운데에 둔다 ──
  const NOW = Date.now(), D = 86_400_000, H = 3_600_000;
  const T0 = new Date(NOW); T0.setHours(0, 0, 0, 0);
  const TODAY = Math.round((T0.getTime() + NOW) / 2);
  const iso = (ms) => new Date(ms).toISOString();
  const AT = {};   // 그려진 제목 → 시각(ms)
  const put = (title, ms) => { AT[title] = ms; return iso(ms); };
  const putMs = (title, ms) => { AT[title] = ms; return ms; };

  // ── 가짜 서버 데이터 ──
  const GREP = [
    { name: "k-design", title: "as-built(#4135, 2026-09-28): 슬랙 검색 설계", snippet: "L3: # 슬랙 **검색** 설계 `omni`", updated_at: put("슬랙 검색 설계", NOW - 3 * D) },
    { name: "k-minutes", title: "회의록 정리", snippet: "L3: 슬랙 이야기를 했다", updated_at: put("회의록 정리", TODAY - 60_000) },   // 본문에서만 맞음
    { name: "k-weekly", title: "주간 보고", snippet: "L9: 슬랙 알림 정리", updated_at: put("주간 보고", NOW - 5 * D) },
  ];
  const SIM = [
    { name: "k-design", title: "as-built(#4135, 2026-09-28): 슬랙 검색 설계", similarity: 0.7, updated_at: iso(AT["슬랙 검색 설계"]) },   // 글자로도 이미 옴 — 맨 끝 묶음에 또 서지 않는다
    { name: "k-memo", title: "검색 개선 메모", similarity: 0.66, updated_at: put("검색 개선 메모", TODAY) },   // 뜻으로만 왔다
  ];
  const PROJ = [
    { id: 11, level: "project", name: "슬랙 연동", status_category: "done", description: "> ⚙ 세션의 첫 지시에서 **자동 생성**된 프로젝트입니다 — 보강됩니다.\n\n## 첫 지시(원문)\n\n슬랙 연동 붙여 줘", updated_at: put("슬랙 연동", T0.getTime() - 12 * H) },
    { id: 12, level: "task", parent_id: 11, parent_name: "슬랙 연동", name: "슬랙 토큰 갱신", status_category: "started", updated_at: put("슬랙 토큰 갱신", NOW - 2 * D) },
    { id: 13, level: "project", name: "새 작업", status_category: "started", description: "슬랙 하나", updated_at: put("새 작업", NOW - 6 * D) },
    { id: 14, level: "project", name: "새 작업", status_category: "started", description: "슬랙 둘", updated_at: NOW - 6 * D - 1000 },
  ];
  const CONV = [
    //  셸 목록의 box-a 가 지금 돌리는 대화 — 이름으로도 맞는다(G5)
    { node_id: "", session_id: "conv-a", name: "서버가 준 이름 A", title: null, at: iso(TODAY + 2000), hits: 2, top: true, best: { role: "user", ts: iso(TODAY + 2000), text: "슬랙처럼 검색 고쳐 줘" }, edit: "v2/omni.ts", fields: ["user", "edit"] },
    //  셸이 아는 지난 세션
    { node_id: "", session_id: "conv-b", name: "서버 이름 B", title: null, at: put("지난 대화 B", NOW - 3 * D - H), hits: 1, top: false, best: { role: "assistant", ts: iso(NOW - 3 * D - H), text: "관련도순과 최신순을 나누고 슬랙처럼 맨 위에 셋" }, edit: null },
    //  셸이 모르는 세션 — 대화록 화면으로
    { node_id: "n1", session_id: "conv-c", name: "모르는 세션", title: null, at: put("모르는 세션", NOW - 40 * D), hits: 5, top: false, best: { role: "user", ts: iso(NOW - 40 * D), text: "예전에 **슬랙** 얘기를 했다" }, edit: null },
  ];
  let PENDING = 3;
  let CONV_FAIL = false;            // true = 503(사람 말) · "500" = internal_error
  let CONV_HANG = false;
  let HANGING = 0, HANG_ABORTED = false;
  const DELAY = {};                 // 채널별 지연(ms) — 흔들림·Enter·선택 장면
  const log = [];
  const J = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  const later = async (k) => { if (DELAY[k]) await sleep(DELAY[k]); };
  window.fetch = async (url, opts) => {
    const u = new URL(String(url), "http://x/");
    log.push(decodeURIComponent(u.pathname + u.search));
    const q = u.searchParams.get("q") || u.searchParams.get("text") || "";
    const hit = q.includes("슬랙");
    const p = u.pathname;
    if (p.endsWith("/api/ui/categories")) return J({ categories: [{ id: 77, key: "slack-cat", name: "슬랙 분류", should: "슬랙에서 온 것" }] });
    if (p.endsWith("/api/ui/knowledge/similar")) { await later("sim"); return J({ entries: hit ? SIM : [] }); }
    if (p.endsWith("/api/ui/knowledge/semantic")) return J({ entries: [] });
    if (p.endsWith("/api/ui/knowledge/search") && q.includes("고장")) return new Response(JSON.stringify({ error: "internal_error" }), { status: 500, headers: { "content-type": "application/json" } });
    if (p.endsWith("/api/ui/knowledge/search") && q.includes("꽉")) { const n = Number(u.searchParams.get("limit")) || 20; return J({ entries: Array.from({ length: n }, (_, i) => ({ name: "k-full-" + i, title: "꽉 찬 문서 " + i, snippet: "", updated_at: iso(TODAY - i * 1000) })) }); }
    if (p.endsWith("/api/ui/knowledge/search")) { await later("know"); return J({ entries: hit ? GREP : q.includes("다른말") ? [{ name: "k-other", title: "다른말 문서", snippet: "", updated_at: iso(TODAY) }] : [] }); }
    if (/\/api\/ui\/v6\/projects\/(similar|semantic)$/.test(p)) return J({ projects: [] });
    if (p.endsWith("/api/ui/v6/projects/search")) { await later("proj"); return J({ projects: hit ? PROJ : [] }); }
    if (p.endsWith("/api/ui/sources")) return J({ entries: [] });
    if (p.endsWith("/api/ui/v6/session-search")) {
      await later("conv");
      if (q.includes("어렴풋")) return J({ results: [{ node_id: "n1", session_id: "conv-v", name: "어렴풋한 대화", title: null, at: iso(TODAY), hits: 1, top: true, best: { role: "user", ts: iso(TODAY), text: "지난주에 이야기했던 것들 중에서 어렴풋 기억나는 그 얘기" }, edit: null, fields: ["user"] }], pending: 0, capped: false });
      if (CONV_FAIL === "500") return new Response(JSON.stringify({ error: "internal_error" }), { status: 500, headers: { "content-type": "application/json" } });
      if (CONV_FAIL) return new Response(JSON.stringify({ error: "대화 검색이 시간 안에 끝나지 않았습니다 — 낱말을 더 넣어 좁혀 주세요" }), { status: 503, headers: { "content-type": "application/json" } });
      if (CONV_HANG) {
        HANGING++;
        return new Promise((_, rej) => { const sig = opts && opts.signal; if (sig) sig.addEventListener("abort", () => { HANG_ABORTED = true; rej(new DOMException("aborted", "AbortError")); }); });
      }
      const since = u.searchParams.get("since");
      let rows = hit ? CONV.filter((c) => !since || Date.parse(c.at) >= Date.parse(since)) : [];
      if (u.searchParams.get("sort") === "recent") rows = [...rows].sort((a, b) => Number(b.top) - Number(a.top) || Date.parse(b.at) - Date.parse(a.at));
      return J({ results: rows, pending: PENDING, capped: false });
    }
    return J({});
  };

  const SRC = document.getElementById("omsrc").textContent;
  const OM = (new Function(SRC + "\n;return OM;"))();
  const OPENED = [];
  const DATA = { projects: [], loadedAt: NOW, lists: [], folders: [], sessions: [
    { id: "box-a", label: "슬랙 검색 고치기", projectId: null, node: null, live: true, alive: true, owned: true, stateKey: "idle", stateLabel: "대기",
      lastSeen: putMs("슬랙 검색 고치기", TODAY + 1000), raw: { claudeSessionId: "conv-a", harness: "claude" } },
    { id: "conv-b", label: "지난 대화 B", projectId: null, node: null, live: false, alive: false, owned: true, stateKey: "log", stateLabel: "기록",
      lastSeen: NOW - 3 * D - H, raw: {} },
    { id: "box-t", label: "슬랙 휴지통 세션", projectId: null, node: null, live: false, alive: false, owned: true, stateKey: "log", stateLabel: "기록",
      lastSeen: NOW - 60_000, raw: {}, trashedAt: iso(NOW - 1000) },
    { id: "box-o", label: "슬랙 팀원 세션", projectId: null, node: null, live: true, alive: true, owned: false, stateKey: "idle", stateLabel: "대기",
      lastSeen: putMs("슬랙 팀원 세션", TODAY - 1000), raw: { owner: "sangmin", owner_name: "상민" } },
  ] };
  OM.setOmniHooks({ data: () => DATA, open: (href, newTab, title) => OPENED.push({ href, newTab, title }) });
  OM.bindOmniKey();   // 프레임·앱 화면 신호(message)를 받는 자리 — G20

  const $ = (s) => document.querySelector(s);
  const isSettled = () => !!$(".v2-omni") && !$(".v2-omni-bar.on");
  async function type(q) {
    if (!OM.omniIsOpen()) OM.omniOpen();
    const input = $(".v2-omni-in");
    input.value = q;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  async function search(q) {
    await type(q);
    await sleep(240);                      // 입력 기다림(160ms) 뒤에 run 이 돈다
    await waitFor(isSettled);
    await sleep(40);
  }
  function shape() {
    const out = [];
    for (const n of $(".v2-omni-list").children) {
      if (n.classList.contains("v2-omni-gh")) out.push({ h: n.textContent, rows: [] });
      else if (n.classList.contains("v2-omni-row")) {
        const g = out[out.length - 1] || (out.push({ h: "", rows: [] }), out[out.length - 1]);
        g.rows.push({
          t: n.querySelector(".v2-omni-t")?.textContent || "",
          head: n.querySelector(".v2-omni-head")?.textContent || "",
          st: n.querySelector(".v2-omni-st")?.textContent || "",
          badge: n.querySelector(".v2-omni-badge")?.textContent || "",
          role: n.querySelector(".v2-omni-role")?.textContent || "",
          ctx: n.querySelector(".v2-omni-ctx")?.textContent || "",
          when: n.querySelector(".v2-omni-when")?.textContent || "",
          marks: [...n.querySelectorAll("mark.v2-omni-hl")].map((m) => m.textContent),
          sub: n.querySelector(".v2-omni-s")?.textContent || "",
          sel: n.getAttribute("aria-selected") === "true",
        });
      }
    }
    return out;
  }
  const rowEl = (title) => [...document.querySelectorAll(".v2-omni-row")].find((r) => r.querySelector(".v2-omni-t")?.textContent === title);
  const since = (n0) => log.slice(n0);
  const key = (k, extra = {}) => $(".v2-omni-in").dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));

  try {
    // ── G1~G8 기본 검색(최신순) ──
    let n0 = log.length;
    await search("슬랙");
    R.defReqs = since(n0);
    R.def = shape();
    R.defNote = $(".v2-omni-note")?.hidden ? "" : ($(".v2-omni-note")?.textContent || "");
    R.AT = AT;
    //  분류 줄을 누르면 분류 화면(숫자 id)으로 — 격리 리뷰: key 를 넣어 «이 분류를 찾지 못했어요» 가 떴다.
    const nOpen = OPENED.length;
    rowEl("슬랙 분류")?.click();
    R.catOpen = OPENED.length > nOpen ? OPENED[OPENED.length - 1] : null;
    await search("슬랙");

    // ── G15 관련도순 + 저장 ──
    [...document.querySelectorAll(".v2-omni-segb")].find((b) => /관련도순/.test(b.textContent))?.click();
    await sleep(60); await waitFor(isSettled); await sleep(40);
    R.rel = shape();
    R.sortStored = localStorage.getItem("lively.omni.sort.v2");
    [...document.querySelectorAll(".v2-omni-segb")].find((b) => /최신순/.test(b.textContent))?.click();
    await sleep(60); await waitFor(isSettled);

    // ── G12 칩: 초점·좁힌 채널·안내 문구 ──
    n0 = log.length;
    [...document.querySelectorAll(".v2-omni-chip")].find((b) => b.dataset.kind === "know")?.click();
    R.chipFocus = document.activeElement === $(".v2-omni-in");
    await sleep(60); await waitFor(isSettled);
    R.chipReqs = since(n0);
    R.chipPlaceholder = $(".v2-omni-in").placeholder;
    [...document.querySelectorAll(".v2-omni-chip")].find((b) => b.dataset.kind === "know")?.click();
    await sleep(60); await waitFor(isSettled);

    // ── G9 치는 동안 비우지 않는다 · G10 Enter 기다림 ──
    DELAY.know = 500; DELAY.conv = 300;
    const rowsBefore = document.querySelectorAll(".v2-omni-row").length;
    await type("다른말");
    await sleep(200);
    R.midStale = $(".v2-omni-list").classList.contains("stale");
    R.midRows = document.querySelectorAll(".v2-omni-row").length;
    R.rowsBefore = rowsBefore;
    const openedBefore = OPENED.length;
    key("Enter");
    await sleep(30);
    R.openedEarly = OPENED.length - openedBefore;
    await waitFor(() => OPENED.length > openedBefore, 4000);
    R.enterOpened = OPENED[OPENED.length - 1] || null;
    R.enterAfter = OPENED.length - openedBefore;
    DELAY.know = 0; DELAY.conv = 0;

    // ── G14 다시 열면 검색어 그대로 · 빈 칸 화면 ──
    OM.omniOpen();
    R.reopenValue = $(".v2-omni-in").value;
    await waitFor(isSettled); await sleep(40);
    const inp = $(".v2-omni-in");
    inp.value = ""; inp.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(60);
    R.empty = shape();

    // ── G11 고른 줄은 늦게 온 채널이 끼어들어도 그대로 ──
    DELAY.sim = 1600;                     // 자리 잡기 상한(1.2초)을 넘겨 늦게 온다
    await type("슬랙");
    await sleep(240); await waitFor(isSettled); await sleep(40);
    key("ArrowDown"); key("ArrowDown");
    const selBefore = shape().flatMap((g) => g.rows).find((r) => r.sel)?.t || "";
    await sleep(1700);
    const selAfter = shape().flatMap((g) => g.rows).find((r) => r.sel)?.t || "";
    R.selKeep = { before: selBefore, after: selAfter, simArrived: shape().some((g) => g.h === "뜻이 비슷한 지식") };
    // ── G22 뜻 비슷이 늦어도 글자 결과는 기다리지 않는다 ──
    await type("슬랙 설계");
    const tSim = performance.now();
    await sleep(240); await waitFor(isSettled, 4000);   // 입력 기다림(160ms) 뒤에 run — 그 전엔 앞 장면이 이미 자리 잡혀 있다
    R.simWaitMs = Math.round(performance.now() - tSim);
    R.simLate = shape();
    DELAY.sim = 0;
    await sleep(1700);

    // ── G21 늦게 온 대화도 맨 위 셋에 ──
    DELAY.conv = 1500;
    await type("어렴풋");
    await sleep(240); await waitFor(isSettled, 5000); await sleep(40);
    R.lateConv = shape();
    DELAY.conv = 0;

    // ── G13 초점 돌려주기 · 주소 바뀜 · Tab ──
    OM.omniClose();
    const outside = document.createElement("input"); outside.id = "outside"; document.body.append(outside); outside.focus();
    OM.omniOpen();
    await sleep(30);
    for (let i = 0; i < 25; i++) $(".v2-omni")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    R.tabInside = !!document.activeElement && !!$(".v2-omni") && $(".v2-omni").contains(document.activeElement);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await sleep(30);
    R.focusBack = document.activeElement === outside && !OM.omniIsOpen();
    OM.omniOpen();
    await sleep(20);
    location.hash = "#/elsewhere-" + Date.now();
    await sleep(80);
    R.closedOnHash = !OM.omniIsOpen();

    // ── G16 기간 «오늘» · 메뉴 Esc ──
    await search("슬랙");
    $(".v2-omni-period")?.click();
    await waitFor(() => !!$(".pn-ctx"));
    R.expandedOpen = $(".v2-omni-period")?.getAttribute("aria-expanded");
    await sleep(120);
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await sleep(80);
    R.afterEsc = { menu: !!$(".pn-ctx"), omni: OM.omniIsOpen(), expanded: $(".v2-omni-period")?.getAttribute("aria-expanded") };
    $(".v2-omni-period")?.click();
    await waitFor(() => !!$(".pn-ctx"));
    await sleep(120);
    n0 = log.length;
    [...document.querySelectorAll(".pn-ctx .pn-ctx-i")].find((b) => b.textContent.includes("오늘"))?.click();
    await sleep(240); await waitFor(isSettled); await sleep(40);
    R.todayReqs = since(n0);
    R.today = shape();
    R.storedKeys = Object.keys(localStorage);

    // ── G17 안내 줄 ──
    PENDING = 0;
    await search("없는말");
    R.emptyNote = $(".v2-omni-note")?.textContent || "";
    R.emptyRows = [...document.querySelectorAll(".v2-omni-row .v2-omni-badge")].filter((b) => b.textContent !== "명령").length;
    CONV_FAIL = true; await search("슬랙"); R.failNote = $(".v2-omni-note")?.textContent || ""; R.failRows = document.querySelectorAll(".v2-omni-row").length; CONV_FAIL = false;
    n0 = log.length; await search("슬랙 " + "가".repeat(205)); R.longReqs = since(n0); R.longNote = $(".v2-omni-note")?.textContent || "";
    PENDING = null; await search("슬랙 다시"); R.unknownNote = $(".v2-omni-note")?.textContent || ""; PENDING = 0;
    CONV_FAIL = "500"; await search("슬랙 또"); R.err500Note = $(".v2-omni-note")?.textContent || ""; CONV_FAIL = false;

    // ── G23 지식 채널 실패 ──
    await search("고장");
    R.knowFailNote = $(".v2-omni-note")?.hidden ? "" : ($(".v2-omni-note")?.textContent || "");
    // ── G24 칩 하나 + 꽉 찬 채널 → 더 보기(앞 장면의 기간 «오늘» 이 남아 있어 시각은 오늘 안에 둔다) ──
    [...document.querySelectorAll(".v2-omni-chip")].find((b) => b.dataset.kind === "know")?.click();
    await sleep(60); await waitFor(isSettled);
    await search("꽉");
    R.moreShown = !$(".v2-omni-more").hidden;
    R.moreRows0 = document.querySelectorAll(".v2-omni-row").length;
    n0 = log.length;
    $(".v2-omni-more").click();
    await sleep(60); await waitFor(isSettled); await sleep(40);
    R.moreReq = since(n0).find((x) => x.includes("/api/ui/knowledge/search")) || "";
    R.moreRows1 = document.querySelectorAll(".v2-omni-row").length;
    [...document.querySelectorAll(".v2-omni-chip")].find((b) => b.dataset.kind === "know")?.click();   // 칩을 푼다
    await sleep(60); await waitFor(isSettled);
    // ── G25 Alt+Enter = 새 화면 ──
    await search("슬랙");
    const nAlt = OPENED.length;
    key("Enter", { altKey: true });
    await waitFor(() => OPENED.length > nAlt, 2000);
    R.altEnter = OPENED.length > nAlt ? OPENED[OPENED.length - 1] : null;

    // ── G19 최근 연 것은 워크스페이스별 열쇠(wsKey) — 다른 워크스페이스에선 «@슬러그» 열쇠에만 ──
    localStorage.setItem("lively.workspace", "ws2");
    const baseBefore = localStorage.getItem("lively.omni.opened") || "";
    await search("슬랙");
    rowEl("회의록 정리")?.click();
    R.wsOpened = { ws2: localStorage.getItem("lively.omni.opened@ws2") || "", baseSame: (localStorage.getItem("lively.omni.opened") || "") === baseBefore };
    localStorage.removeItem("lively.workspace");

    // ── G20 «여는» 신호(open:true — 앱 화면 다리)는 열린 창을 닫지 않고 · 키 신호는 열고 닫기를 오간다 ──
    OM.omniOpen();
    await sleep(30);
    //  file:// 로 뜬 시험 페이지는 실제 postMessage 의 출처가 셸 출처와 다르게 찍힌다 — 셸과 같은 출처의 메시지 이벤트를 직접 보낸다.
    const send = (data) => window.dispatchEvent(new MessageEvent("message", { data, origin: location.origin, source: window }));
    send({ type: "lively-omni-open", open: true });
    await sleep(60);
    R.openSignalKeeps = OM.omniIsOpen();
    send({ type: "lively-omni-open" });
    await sleep(60);
    R.keySignalCloses = !OM.omniIsOpen();

    // ── G18 닫으면 끊는다 ──
    CONV_HANG = true;
    await type("슬랙 끊기");
    await waitFor(() => HANGING > 0, 3000);
    R.hangStarted = HANGING;
    OM.omniClose();
    await sleep(80);
    R.hangAborted = HANG_ABORTED;
    CONV_HANG = false;
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
const dom = await dumpDom(chrome, { html: PAGE, copy: CSS, prefix: "omni-search-", virtualTimeBudget: 90000 });
const res = readOut(dom);
if (res.text === null) { console.error(`FAIL  결과 표지를 못 받았다(out=${JSON.stringify(res.out)})\n` + dom.slice(0, 1500)); process.exit(1); }
const R = JSON.parse(res.text);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why) => (cond ? ok(n) : bad(n, why));
for (const k of ["fatal", "err"]) if (R[k]) bad(`장면 오류 ${k}`, String(R[k]).slice(0, 600));

const group = (sh, h) => (sh || []).find((g) => g.h === h);
const allRows = (sh) => (sh || []).flatMap((g) => g.rows);
const titles = (sh) => allRows(sh).map((r) => r.t);
const reqOf = (reqs, p) => (reqs || []).filter((l) => l.startsWith(p));
const row = (sh, t) => allRows(sh).find((r) => r.t === t);

// W 배선
check(allRows(R.def).length >= 6 && reqOf(R.defReqs, "/api/ui/v6/session-search?").length >= 1, "W 배선 — 가짜 서버가 불렸고 줄이 섰다", JSON.stringify({ reqs: R.defReqs, rows: titles(R.def) }));

// G1 요청
{
  const conv = reqOf(R.defReqs, "/api/ui/v6/session-search?");
  check(conv.length >= 1 && conv.every((l) => /sort=recent/.test(l)), "G1 기본 = 최신순 — 대화 요청 sort=recent", JSON.stringify(conv));
  check(reqOf(R.defReqs, "/api/ui/knowledge/search?").some((l) => /plain=1/.test(l)) && reqOf(R.defReqs, "/api/ui/v6/projects/search?").some((l) => /plain=1/.test(l)),
    "G1 지식·프로젝트 글자 검색은 plain=1", JSON.stringify(R.defReqs));
  check(!(R.defReqs || []).some((l) => /\/semantic\?/.test(l) || /\/v6\/projects\/similar\?/.test(l)) && reqOf(R.defReqs, "/api/ui/knowledge/similar?").length >= 1,
    "G1 의미검색·프로젝트 뜻 채널은 안 부르고 지식 뜻 비슷은 부른다", JSON.stringify(R.defReqs));
}
// G2 배치
{
  const heads = (R.def || []).map((g) => g.h);
  const BUCKETS = ["오늘", "어제", "최근 7일", "최근 30일", "그 이전", "시각 모름"];
  const top = group(R.def, "가장 맞는 결과");
  check(heads[0] === "가장 맞는 결과" && top.rows.length >= 1 && top.rows.length <= 3, "G2 맨 위 = «가장 맞는 결과» 최대 셋", JSON.stringify(heads));
  check(!top.rows.some((r) => r.badge === "명령"), "G2 명령 줄(«…로 새 지식 쓰기»)은 맨 위 셋에 서지 않는다", JSON.stringify(top.rows));
  const mids = heads.slice(1).filter((h) => BUCKETS.includes(h)).map((h) => BUCKETS.indexOf(h));
  check(mids.length >= 2 && mids.every((v, i) => i === 0 || v > mids[i - 1]), "G2 그 아래 날짜 묶음이 오늘 → 옛날 순", JSON.stringify(heads));
  check(heads[heads.length - 1] === "뜻이 비슷한 지식" && heads.indexOf("바로 가기") === heads.length - 2, "G2 «바로 가기» 다음 맨 끝 «뜻이 비슷한 지식»", JSON.stringify(heads));
  const tl = (R.def || []).filter((g) => BUCKETS.includes(g.h)).flatMap((g) => g.rows).map((r) => r.t);
  const times = tl.map((t) => R.AT[t]).filter((v) => typeof v === "number");
  check(times.length >= 4 && times.every((v, i) => i === 0 || v <= times[i - 1]), "G2 날짜 묶음 안팎으로 시각 역순", JSON.stringify(tl));
}
// G3
{
  const BUCKETS = ["오늘", "어제", "최근 7일", "최근 30일", "그 이전", "시각 모름"];
  const tl = (R.def || []).filter((g) => BUCKETS.includes(g.h) || g.h === "가장 맞는 결과").flatMap((g) => g.rows).map((r) => r.t);
  check(tl.includes("회의록 정리"), "G3 본문에서만 맞은 지식도 시간 줄에 선다", JSON.stringify(tl));
  const simG = group(R.def, "뜻이 비슷한 지식");
  check(!tl.includes("검색 개선 메모") && !!simG && simG.rows.map((r) => r.t).join() === "검색 개선 메모", "G3 뜻으로만 온 지식은 맨 끝 묶음에만 · 글자로 이미 뜬 문서는 거기 또 서지 않는다", JSON.stringify(simG));
  //  #1211(#4517 후속)이 잠근 것 — 맨 위 «가장 맞는 결과» 도 글자로 맞은 것에서만 고른다(뜻 점수만 넘은 무관한 문서가 서던 것).
  check(!(group(R.def, "가장 맞는 결과")?.rows || []).some((r) => r.t === "검색 개선 메모"), "G3 뜻으로만 온 지식은 맨 위 셋에도 서지 않는다", JSON.stringify(group(R.def, "가장 맞는 결과")));
}
// G4·G5
{
  const a = row(R.def, "슬랙 검색 고치기");
  check(titles(R.def).filter((t) => t === "슬랙 검색 고치기").length === 1 && !titles(R.def).includes("서버가 준 이름 A"), "G5 이름·대화 둘 다 맞은 세션은 한 줄", JSON.stringify(titles(R.def)));
  check(!!a && a.role === "지시" && /슬랙처럼 검색 고쳐 줘/.test(a.sub) && /고친 파일 v2\/omni\.ts/.test(a.sub) && /맞은 곳 2/.test(a.sub), "G5 그 줄이 대화 발췌문 · 고친 파일 · 맞은 곳 수를 보인다", JSON.stringify(a));
  const b = row(R.def, "지난 대화 B");
  check(!!b && b.role === "AI" && b.marks.includes("슬랙") && b.when !== "", "G4 대화 줄 = AI 표 · 발췌문 색칠 · 시각", JSON.stringify(b));
  const c = row(R.def, "모르는 세션");
  check(!!c && !/\*\*/.test(c.sub), "G4 발췌문에 마크다운 기호가 없다", JSON.stringify(c));
}
// G6
check(!titles(R.def).includes("슬랙 휴지통 세션"), "G6 휴지통 세션은 안 보인다", JSON.stringify(titles(R.def)));
check(!!R.catOpen && R.catOpen.href === "#/taxonomy/77", "G6 분류 줄은 분류 화면(숫자 id)으로 연다", JSON.stringify(R.catOpen));
check(/상민의 세션/.test(row(R.def, "슬랙 팀원 세션")?.ctx || ""), "G6 팀원 세션은 주인을 말한다", JSON.stringify(row(R.def, "슬랙 팀원 세션")));
// G7
{
  const task = row(R.def, "슬랙 토큰 갱신");
  check(!!task && task.badge === "태스크" && /슬랙 연동 ›/.test(task.ctx), "G7 태스크 줄 = 태스크 배지 · 상위 이름 ›", JSON.stringify(task));
  check(row(R.def, "슬랙 연동")?.st === "완료", "G7 완료 프로젝트는 «완료» 표시", JSON.stringify(row(R.def, "슬랙 연동")));
  check(titles(R.def).filter((t) => t === "새 작업").length === 2, "G7 이름이 같은 다른 프로젝트 둘은 둘 다 보인다", JSON.stringify(titles(R.def)));
  check(!/자동 생성|첫 지시|>|##/.test(row(R.def, "슬랙 연동")?.sub || "") && /슬랙 연동 붙여 줘/.test(row(R.def, "슬랙 연동")?.sub || ""), "G7 자동 생성 안내문 대신 첫 지시 글", JSON.stringify(row(R.def, "슬랙 연동")));
}
// G8
{
  const k = row(R.def, "슬랙 검색 설계");
  check(!!k && k.head === "as-built · #4135", "G8 지식 제목 머리말은 따로 작게", JSON.stringify(k));
  check(!!k && !/[#*`]|L3:/.test(k.sub), "G8 둘째 줄에 마크다운 기호·줄 번호가 없다", JSON.stringify(k));
}
// G15
{
  const heads = (R.rel || []).map((g) => g.h);
  check(heads[0] === "가장 맞는 결과" && ["세션", "프로젝트", "지식"].every((h) => heads.includes(h)) && heads[heads.length - 1] === "뜻이 비슷한 지식", "G15 관련도순 = 맨 위 셋 다음 종류별 묶음", JSON.stringify(heads));
  check(R.sortStored === "rel", "G15 정렬은 저장된다(lively.omni.sort.v2)", JSON.stringify(R.sortStored));
}
// G12
check(R.chipFocus === true, "G12 칩을 눌러도 입력칸에 초점이 남는다", JSON.stringify(R.chipFocus));
check((R.chipReqs || []).length >= 1 && (R.chipReqs || []).every((l) => l.startsWith("/api/ui/knowledge/")), "G12 «지식» 칩 = 지식 채널만 부른다", JSON.stringify(R.chipReqs));
check(/지식에서 찾습니다/.test(R.chipPlaceholder || ""), "G12 안내 문구가 좁힌 사실을 말한다", JSON.stringify(R.chipPlaceholder));
// G9·G10
check(R.midStale === true && R.midRows === R.rowsBefore && R.rowsBefore > 0, "G9 치는 동안 앞 결과를 비우지 않고 흐리게 둔다", JSON.stringify({ stale: R.midStale, mid: R.midRows, before: R.rowsBefore }));
check(R.openedEarly === 0 && R.enterAfter === 1 && R.enterOpened && R.enterOpened.href === "#/k/k-other", "G10 결과가 오기 전 Enter → 자리 잡은 뒤 새 결과의 첫 줄을 연다", JSON.stringify({ early: R.openedEarly, after: R.enterAfter, o: R.enterOpened }));
// G14
check(R.reopenValue === "다른말", "G14 결과를 열고 다시 열면 그 검색어가 그대로", JSON.stringify(R.reopenValue));
{
  const heads = (R.empty || []).map((g) => g.h);
  check(heads.includes("최근 검색") && group(R.empty, "최근 검색").rows.some((r) => r.t === "다른말"), "G14 빈 칸 — 최근 검색", JSON.stringify(R.empty));
  check(heads.includes("최근 연 것") && group(R.empty, "최근 연 것").rows.some((r) => r.t === "다른말 문서"), "G14 빈 칸 — 최근 연 것", JSON.stringify(R.empty));
  const mine = group(R.empty, "내 최근 세션");
  check(!!mine && !mine.rows.some((r) => /휴지통|팀원/.test(r.t)), "G14 빈 칸 — 내 최근 세션(휴지통·팀원 제외)", JSON.stringify(mine));
}
// G11
check(!!R.selKeep && R.selKeep.before && R.selKeep.before === R.selKeep.after && R.selKeep.simArrived, "G11 고른 줄은 늦게 온 채널이 끼어들어도 그대로", JSON.stringify(R.selKeep));
// G23·G24·G25
check(/지식 결과를 가져오지 못했습니다/.test(R.knowFailNote || "") && !/결과가 없습니다/.test(R.knowFailNote || ""), "G23 지식 채널이 실패하면 실패를 말한다(«결과가 없습니다» 아님)", JSON.stringify(R.knowFailNote));
check(R.moreShown === true && /limit=40/.test(R.moreReq || "") && R.moreRows1 > R.moreRows0, "G24 칩 하나 + 꽉 찬 채널 → «더 보기» → 더 많이 청한다", JSON.stringify({ shown: R.moreShown, req: R.moreReq, rows: [R.moreRows0, R.moreRows1] }));
check(!!R.altEnter && R.altEnter.newTab === true, "G25 Alt+Enter 는 새 화면", JSON.stringify(R.altEnter));
// G21·G22
check((group(R.lateConv, "가장 맞는 결과")?.rows || []).some((r) => r.t === "어렴풋한 대화"), "G21 늦게 온 대화(1.5초)도 맨 위 셋에 선다", JSON.stringify(R.lateConv));
{
  //  둘째 줄은 첫 맞은 낱말 조금 앞에서 시작한다(폰에서 맞은 낱말이 줄임표 뒤로 밀리던 것 — 배포 뒤 실화면)
  const r = allRows(R.lateConv).find((x) => x.t === "어렴풋한 대화");
  check(!!r && /^…/.test(r.sub.replace(/^(지시|AI)\s*/, "")) && r.marks.includes("어렴풋") && !/지난주에/.test(r.sub), "G21 둘째 줄은 맞은 낱말 앞에서 시작", JSON.stringify(r));
}
check(R.simWaitMs < 1000 && allRows(R.simLate).some((r) => r.t === "슬랙 검색 설계") && !R.simLate.some((g) => g.h === "뜻이 비슷한 지식"), "G22 뜻 비슷이 늦어도 글자 결과는 바로 선다", JSON.stringify({ ms: R.simWaitMs, heads: (R.simLate || []).map((g) => g.h) }));
// G13
check(R.tabInside === true, "G13 Tab 은 창 안에서만 돈다", JSON.stringify(R.tabInside));
check(R.focusBack === true, "G13 닫으면 연 순간의 칸으로 초점이 돌아간다", JSON.stringify(R.focusBack));
check(R.closedOnHash === true, "G13 주소가 바뀌면 닫힌다", JSON.stringify(R.closedOnHash));
// G16
check(R.expandedOpen === "true" && R.afterEsc && R.afterEsc.menu === false && R.afterEsc.omni === true && R.afterEsc.expanded === "false", "G16 기간 메뉴의 Esc 는 메뉴만 닫는다 · aria-expanded", JSON.stringify({ o: R.expandedOpen, a: R.afterEsc }));
{
  const t = titles(R.today);
  check(t.includes("회의록 정리") && t.includes("슬랙 검색 고치기") && !t.includes("지난 대화 B") && !t.includes("모르는 세션") && !t.includes("주간 보고"), "G16 오늘 밖의 줄이 빠진다", JSON.stringify(t));
  check(reqOf(R.todayReqs, "/api/ui/v6/session-search?").every((l) => /since=/.test(l)) && reqOf(R.todayReqs, "/api/ui/v6/session-search?").length >= 1, "G16 대화 요청에 since", JSON.stringify(R.todayReqs));
  check(!(R.storedKeys || []).some((k) => /period|기간/i.test(k)), "G16 기간은 저장하지 않는다", JSON.stringify(R.storedKeys));
}
// G17
check(/대화 색인을 만드는 중입니다/.test(R.defNote || "") && /3개/.test(R.defNote || ""), "G17 색인이 밀려 있으면 수를 말한다", JSON.stringify(R.defNote));
check(R.emptyRows === 0 && /결과가 없습니다/.test(R.emptyNote || "") && /오늘 안의 결과만 봤습니다/.test(R.emptyNote || ""), "G17 결과 없음 + 기간 → 기간 이유", JSON.stringify({ n: R.emptyRows, note: R.emptyNote }));
check(/대화 결과를 가져오지 못했습니다/.test(R.failNote || "") && /시간 안에 끝나지 않았습니다/.test(R.failNote || "") && R.failRows > 0, "G17 대화 채널 503 — 다른 결과는 두고 «가져오지 못했다»", JSON.stringify({ note: R.failNote, rows: R.failRows }));
check(!reqOf(R.longReqs, "/api/ui/v6/session-search").length && /검색어가 길어/.test(R.longNote || ""), "G17 200자 넘는 검색어는 대화 채널을 부르지 않고 이유를 말한다", JSON.stringify({ reqs: R.longReqs, note: R.longNote }));
check(/확인하지 못했습니다/.test(R.unknownNote || "") && !/색인을 만드는 중/.test(R.unknownNote || ""), "G17 밀린 수를 모르면 그렇다고 말한다", JSON.stringify(R.unknownNote));
check(/서버에 오류가 났습니다/.test(R.err500Note || "") && !/internal_error/.test(R.err500Note || ""), "G17 500 internal_error 는 읽을 수 있는 말로", JSON.stringify(R.err500Note));
// G19·G20
check(/k-minutes/.test(R.wsOpened?.ws2 || "") && R.wsOpened?.baseSame === true, "G19 최근 연 것은 워크스페이스별 열쇠에 — 기본 열쇠는 그대로", JSON.stringify(R.wsOpened));
check(R.openSignalKeeps === true && R.keySignalCloses === true, "G20 «여는» 신호는 열린 창을 닫지 않고 · 키 신호는 닫는다", JSON.stringify({ keep: R.openSignalKeeps, close: R.keySignalCloses }));
// G18
check(R.hangStarted >= 1 && R.hangAborted === true, "G18 창을 닫으면 진행 중인 요청을 끊는다", JSON.stringify({ s: R.hangStarted, a: R.hangAborted }));
// W
check(Array.isArray(R.pageErrors) && R.pageErrors.length === 0, "W 페이지 오류 0", JSON.stringify(R.pageErrors));

console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
