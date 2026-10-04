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
//  G4  대화로 맞은 세션 줄 = 이름 · «세션» · 시각 · 둘째 줄은 «어디에 있는 것인가»(프로젝트가 없으면 고친 파일·발췌)
//  G5  이름으로도 대화로도 맞은 세션은 한 줄(셸의 이름을 쓴다)
//  G6  휴지통 세션은 안 보인다 · 팀원 세션은 «…의 세션» 으로 보인다
//  G7  프로젝트 줄 — 태스크는 «상위 이름 ›» · 완료는 «완료» · 이름이 같은 다른 프로젝트 둘은 둘 다 보인다
//  G8  지식 제목의 머리말(as-built(#…):)은 따로 작게 · 둘째 줄에 마크다운 기호·자동 안내문이 없다
//  G9  치는 동안 — 앞 결과를 비우지 않고 흐리게 둔다(stale) · 자리 잡으면 새 결과로 한 번에
//  G10 결과가 오기 전에 Enter → 바로 열지 않고, 자리 잡은 뒤 그 첫 줄을 연다
//  G11 화살표로 고른 줄은 늦게 온 채널이 끼어들어도 그대로다(열쇠로 기억)
//  G12 탭을 누르면 입력칸에 초점이 남고 그 종류의 줄만 선다 · 다시 묻지 않는다(받아 둔 결과) · 안내 문구가 좁힌 사실을 말한다
//  G13 닫으면 연 순간 초점이 있던 칸으로 돌아간다 · 주소가 바뀌면 닫힌다 · Tab 은 창 안에서만 돈다
//  G14 결과를 열고 10분 안에 다시 열면 그 검색어가 그대로 · 빈 칸엔 최근 검색 · 최근 연 것 · 내 최근 세션(휴지통·팀원 제외)
//  G15 관련도순 = «가장 맞는 결과» 다음 종류별 묶음 · 정렬은 저장된다(lively.omni.sort.v2)
//  G16 기간 «오늘» — 오늘 밖의 줄이 빠진다 · 대화 요청에 since · 기간은 저장하지 않는다 · 기간 메뉴의 Esc 는 메뉴만 닫는다
//  G17 안내 줄 — 색인 중(수) · 밀린 수 모름(null) · 대화 채널 503 · 500 internal_error · 200자 넘는 검색어 · 결과 없음 + 기간
//  G18 창을 닫으면 진행 중인 요청을 끊는다
//  G21 대화가 1.5초 늦게 와도(색인을 다시 쓰는 동안의 실측 1.4초) 기다렸다가 맨 위 셋에 세운다 — 1.2초 상한 때는 맨 위가 빈 채 굳었다
//  G22 뜻 비슷 채널은 자리 잡기를 막지 않는다(맨 아래 묶음 전용) — 늦게 와도 글자 결과는 바로 선다
//  G23 지식 채널이 실패하면 «결과가 없습니다» 대신 실패를 말한다(전엔 말없이 빈 결과)
//  G24 탭 하나만 봐도 서버가 꽉 채워 보내면 «결과 더 보기» 가 뜨고, 누르면 더 많이 청한다(전엔 줄 40개 넘을 때만)
//  G25 Alt+Enter 는 새 화면으로 연다(가이드 표기 · 고치기 전 동작)
//  G26 대화는 세션의 일부다 — «대화» 탭·배지·묶음이 없다 · 대화로 걸린 세션도 «세션» 배지 · 세션 탭에 대화로 걸린 세션이 선다
//      (원준 2026-10-04 «대화도 세션 안의 대화인데 굳이 나눌 필요가 있나»)
//  G27 최근 검색 줄은 시계 그림(표의 clock) — 종류(바로 가기)의 창 그림이 아니다(원준 2026-10-04 «최근 검색 아이콘이 왜 저거인지»)
//
// 안 A «목록 + 미리보기»(원준 2026-10-04 «A안으로 가자. 기능까지 다 구현» · «뭐든 내부 안까지 … 다 구현해»):
//  A1  세션 줄을 고르면 미리보기에 맞은 말과 앞뒤 말(누구의 말) · 고친 파일 · 처음 시킨 말 · 말 수가 선다 · 요청에 그 세션과 검색어가 실린다
//  A2  Shift+↓ 로 다음 맞은 말(1/2 → 2/2) — 고른 줄은 그대로
//  A3  다른 줄을 봤다 돌아와도 다시 묻지 않는다(이 창이 떠 있는 동안 기억)
//  A4  미리보기의 [새 탭] = 새 탭으로 연다 · [열기] = 그 자리
//  A5  지식 줄 = 머리말 · 분류 · 맞은 줄과 그 줄이 속한 절 · 목차
//  A6  프로젝트 줄 = 상태 · 태스크 진행(끝남/전체) · 태스크 줄 / 태스크 줄 = 상위 프로젝트 · 본문
//  A7  낱말이 말에 없는 세션(이름으로만 맞음) = 처음 시킨 말 · 마지막 말 / 볼 수 없는 세션(404) = 그 사실을 말한다
//  A8  Tab = 다음 탭 · Shift+Tab = 앞 탭 — 다시 묻지 않고 그 종류만 세운다 · 탭마다 숫자 · 자료 탭은 그때 묻는다
//  A9  «전체» 의 맨 위 셋에는 세션이 하나는 선다(이름에 낱말이 든 지식·프로젝트가 셋을 다 차지하지 않는다)
//  A10 명령·최근 검색 줄 = 무엇을 하는지 한두 줄 + [실행] 단추
//  A11 같은 줄이 고른 채로 검색어만 바뀌면 미리보기의 색칠·맞은 곳이 새 낱말로 바뀐다(다시 묻지 않는다) — 격리 리뷰: 옛 검색어로 굳었다
//  A12 본문을 받다 끊긴 요청은 답으로 기억하지 않는다 — 그 줄로 돌아오면 다시 묻고 내용이 선다(격리 리뷰: 빈 칸으로 굳었다)
//  A13 키보드만으로 — 맨 위 줄에서 ↑ = 탭 줄 · ←→ 로 탭·기간·정렬 · Tab 으로 미리보기 단추·닫기까지 · 글자를 치면 입력칸 · 맨 아래 줄에서 ↓ = 더 보기
//  A14 자료 탭 — 자료만 묻는다(다른 채널은 다시 묻지 않는다) · 오는 동안은 «찾는 중» 이지 «결과가 없습니다» 가 아니다 · 오면 줄이 선다
//  A15 탭 숫자 = 서버가 센 전체 개수(받은 줄 수가 아니다) · 기간으로 좁혔을 때는 프로젝트·지식 개수를 묻지 않는다
//  A16 이 탭이 비었고 다른 종류에 있으면 «전체에서 N개 보기» 단추로 건넌다
//  A17 세션 기록이 서버에 없으면(404) «아직 올라오지 않았다» 고 말하고 기억하지 않는다(다시 고르면 다시 묻는다) · 다른 종류의 404 는 «볼 수 없는 항목»
//  A19 자료가 오는 동안 누른 Enter 는 버려지지 않는다 — 다 오면 첫 줄을 연다 / «결과 더 보기» 뒤에도 고른 줄은 그대로 · 개수는 다시 묻지 않는다
//      / ‹ › 는 Tab 길에 없다(누르면 사라져 초점이 샌다 — 키보드는 Shift+↑↓) / 한글 입력기의 첫 키(Process)도 입력칸으로
//  A18 태블릿(넓고 손가락) — 첫 누름은 고르기(미리보기), 고른 줄을 다시 누르면 연다 / 폰 — 줄을 누르면 판이 올라오고 Esc 는 판만 내린다
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
  //  폰 폭 · 손가락 화면 흉내 — omni.ts 의 isNarrow · noHover 가 읽는 두 질의만 가로챈다(A18).
  const MQ = { narrow: false, noHover: false };
  const realMM = window.matchMedia.bind(window);
  window.matchMedia = (q) => (/max-width: 640px/.test(q) ? { matches: MQ.narrow } : /hover: none/.test(q) ? { matches: MQ.noHover } : realMM(q));
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
  let SLOW_BODY = false;
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
    //  A15 — 종류마다 모두 몇 개인가(줄은 20개씩만 온다)
    if (p.endsWith("/api/ui/knowledge/search") && u.searchParams.get("mode") === "count") return J({ mode: "count", total: hit ? 254 : 0 });
    if (p.endsWith("/api/ui/v6/projects/search") && u.searchParams.get("mode") === "count") return J({ mode: "count", total: hit ? 12 : 0 });
    //  A9 — 이름에 낱말이 든 지식 셋 + 대화로만 맞은 세션 하나(서버가 top 으로 표시)
    if (p.endsWith("/api/ui/knowledge/search") && q.includes("보장")) return J({ entries: [1, 2, 3].map((i) => ({ name: "k-g" + i, title: "보장 문서 " + i, snippet: "", updated_at: iso(NOW - i * D) })) });
    if (p.endsWith("/api/ui/knowledge/search") && q.includes("고장")) return new Response(JSON.stringify({ error: "internal_error" }), { status: 500, headers: { "content-type": "application/json" } });
    if (p.endsWith("/api/ui/knowledge/search") && q.includes("꽉")) { const n = Number(u.searchParams.get("limit")) || 20; return J({ entries: Array.from({ length: n }, (_, i) => ({ name: "k-full-" + i, title: "꽉 찬 문서 " + i, snippet: "", updated_at: iso(TODAY - i * 1000) })) }); }
    if (p.endsWith("/api/ui/knowledge/search")) { await later("know"); return J({ entries: hit ? GREP : q.includes("다른말") ? [{ name: "k-other", title: "다른말 문서", snippet: "", updated_at: iso(TODAY) }] : [] }); }
    if (/\/api\/ui\/v6\/projects\/(similar|semantic)$/.test(p)) return J({ projects: [] });
    if (p.endsWith("/api/ui/v6/projects/search")) { await later("proj"); return J({ projects: hit ? PROJ : [] }); }
    if (p.endsWith("/api/ui/sources")) { await later("src"); return J({ entries: hit ? [
      { id: 501, title: "슬랙 수집 원문", external_system: "slack", fields: { container_name: "general" }, occurred_at: iso(NOW - 2 * D) },
      { id: 502, title: "슬랙 연동 메모.md", kind: "local_file", updated_at: iso(NOW - 4 * D) }] : [], total: hit ? 2 : 0 }); }
    if (p.endsWith("/api/ui/v6/session-search/hits")) {
      const sid = u.searchParams.get("session_id");
      if (sid === "conv-b") return new Response(JSON.stringify({ error: "세션을 찾을 수 없습니다" }), { status: 404, headers: { "content-type": "application/json" } });
      if (sid === "conv-a") return J({ mine: true, msgs: 5, total: 2, hits: [
        { role: "user", ts: iso(TODAY + 2000), text: "슬랙처럼 검색 고쳐 줘", terms: 1, before: { role: "assistant", ts: null, text: "무엇을 도와드릴까요" }, after: { role: "assistant", ts: null, text: "네 순서를 고치겠습니다" } },
        { role: "assistant", ts: iso(TODAY + 3000), text: "슬랙 방식으로 바꿨습니다", terms: 1, before: null, after: null }],
        edits: [{ path: "v2/omni.ts", hit: false }], first: { role: "user", ts: null, text: "검색 순서가 이상해" }, last: { role: "assistant", ts: null, text: "끝났습니다" } });
      return J({ mine: false, msgs: 3, total: 0, hits: [], edits: [], first: { role: "user", ts: null, text: "예전에 처음 시킨 말" }, last: { role: "assistant", ts: null, text: "예전의 마지막 말" } });
    }
    //  A12 — 머리는 왔는데 본문을 받다가 끊긴다(api() 는 이때 실패가 아니라 null 로 풀린다)
    if (p.endsWith("/api/ui/knowledge/k-minutes")) {
      if (SLOW_BODY) { const sig = opts && opts.signal; return { ok: true, status: 200, headers: new Headers(), json: () => new Promise((_, rej) => { if (sig) sig.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))); }) }; }
      return J({ knowledge: { name: "k-minutes", title: "회의록 정리", body_md: "## 회의\n슬랙 이야기를 했다.", categories: [], links: { outgoing: [], incoming: [] }, sources: [], children_total: 0 }, body_range: { has_more: false } });
    }
    if (p.endsWith("/api/ui/knowledge/k-weekly")) return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
    if (p.endsWith("/api/ui/knowledge/k-design")) return J({ knowledge: { name: "k-design", title: "as-built(#4135, 2026-09-28): 슬랙 검색 설계",
      body_md: "# 설계\n\n## 순서\n앞 줄입니다.\n슬랙처럼 최근 것부터 보인다.\n뒤 줄입니다.\n\n## 화면\n칩을 탭으로 바꾼다.", categories: [{ name: "웹 UI" }],
      updated_at: iso(NOW - 3 * D), updated_by: "wonjoon", version: 3, links: { outgoing: [], incoming: [] }, sources: [], children_total: 0 }, body_range: { has_more: false } });
    if (p.endsWith("/api/ui/v6/projects/11")) return J({ project: { id: 11, level: "project", name: "슬랙 연동", status_category: "done", description: "슬랙 연동 붙여 줘",
      tasks: [{ id: 12, name: "슬랙 토큰 갱신", status_category: "started" }, { id: 15, name: "끝난 일", status_category: "done" }], knowledge: { required: [], produced: [] }, members: [], updated_at: iso(NOW - D) } });
    if (p.endsWith("/api/ui/v6/tasks/12/detail")) return J({ task: { id: 12, name: "슬랙 토큰 갱신", status_category: "started", description: "토큰이 만료되면 슬랙 수집이 멈춘다.", subtasks: [], sessions: [], updated_at: iso(NOW - 2 * D) },
      project: { id: 11, name: "슬랙 연동" }, feed: [], checklists: [] });
    if (p.endsWith("/api/ui/v6/session-search")) {
      await later("conv");
      if (q.includes("보장")) return J({ results: [{ node_id: "n1", session_id: "conv-g", name: "대화로만 맞은 세션", title: null, at: iso(NOW - 9 * D), hits: 2, top: true, best: { role: "assistant", ts: iso(NOW - 9 * D), text: "그건 보장되지 않습니다" }, edit: null, fields: ["assistant"], project: "어떤 프로젝트" }], pending: 0, capped: false });
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
      return J({ results: rows, total: hit ? 37 : 0, pending: PENDING, capped: false });
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
  const NEWSESS = [];
  OM.setOmniHooks({ data: () => DATA, open: (href, newTab, title) => OPENED.push({ href, newTab, title }), newSession: (seed) => NEWSESS.push(seed) });
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
  const pvShape = () => { const v = $(".v2-opv"); return !v ? null : {
    kind: v.querySelector(".v2-opv-kind")?.textContent || "", tag: v.querySelector(".v2-opv-tag")?.textContent || "", pill: v.querySelector(".v2-opv-pill")?.textContent || "",
    t: v.querySelector(".v2-opv-t")?.textContent || "", facts: [...v.querySelectorAll(".v2-opv-fact")].map((x) => x.textContent),
    secs: [...v.querySelectorAll(".v2-opv-sec")].map((x) => x.textContent), first: v.querySelector(".v2-opv-first")?.textContent || "",
    msgs: [...v.querySelectorAll(".v2-opv-msg")].map((m) => [m.className.replace("v2-opv-msg ", ""), m.querySelector(".v2-opv-who")?.textContent, m.querySelector("p")?.textContent].join("|")),
    files: [...v.querySelectorAll(".v2-opv-files code")].map((x) => x.textContent), crumbs: [...v.querySelectorAll(".v2-opv-crumb")].map((x) => x.textContent),
    lines: [...v.querySelectorAll(".v2-opv-line")].map((x) => (x.classList.contains("hit") ? "★" : "") + x.textContent), toc: [...v.querySelectorAll(".v2-opv-toc li")].map((x) => x.textContent),
    trows: [...v.querySelectorAll(".v2-opv-trow")].map((x) => x.textContent), marks: [...v.querySelectorAll("mark.v2-omni-hl")].map((x) => x.textContent),
    btns: [...v.querySelectorAll(".v2-opv-btn")].map((x) => x.querySelector("span")?.textContent || ""), empty: v.querySelector(".v2-opv-empty")?.textContent || "" }; };
  const hover = async (title, wait = 420) => { rowEl(title)?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, movementX: 3, movementY: 3 })); await sleep(wait); };
  const tabEl = (k) => [...document.querySelectorAll(".v2-omni-tab")].find((b) => b.dataset.tab === k);
  const tabOn = () => document.querySelector(".v2-omni-tab.on")?.dataset.tab || "";
  const allRowsNow = () => shape().flatMap((g) => g.rows);
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

    // ── 안 A: 맨 위 셋에 세션 하나 · 미리보기 ──
    await search("보장");
    R.topGuar = (shape().find((g) => g.h === "가장 맞는 결과")?.rows || []).map((r) => r.t);
    R.guarRow = allRowsNow().find((r) => r.t === "대화로만 맞은 세션") || null;
    await search("슬랙");
    n0 = log.length;
    await hover("슬랙 검색 고치기");
    R.pvSess = pvShape();
    R.navTabIndex = [...document.querySelectorAll(".v2-opv-navb")].map((b) => b.tabIndex);
    R.pvSessReqs = since(n0).filter((x) => x.includes("/session-search/hits"));
    const selBeforeNav = shape().flatMap((g) => g.rows).find((r) => r.sel)?.t || "";
    key("ArrowDown", { shiftKey: true });
    await sleep(60);
    R.pvNav = { sec: pvShape()?.secs.find((x) => x.startsWith("맞은 말")) || "", msgs: pvShape()?.msgs, sel: shape().flatMap((g) => g.rows).find((r) => r.sel)?.t || "", selBefore: selBeforeNav };
    await hover("슬랙 검색 설계");
    R.pvKnow = pvShape();
    await hover("슬랙 연동");
    R.pvProj = pvShape();
    await hover("슬랙 토큰 갱신");
    R.pvTask = pvShape();
    await hover("모르는 세션");
    R.pvNoHit = pvShape();
    n0 = log.length;
    await hover("지난 대화 B");
    R.pvGone = pvShape();
    await hover("모르는 세션", 200);
    await hover("지난 대화 B");
    R.pvGoneReqs = since(n0).filter((x) => x.includes("session_id=conv-b")).length;
    // ── A12 본문을 받다 끊긴 요청 ──
    SLOW_BODY = true;
    await hover("회의록 정리", 260);      // 110ms 머문 뒤 요청이 나가고 본문에서 멈춘다
    await hover("주간 보고", 260);        // 줄을 옮기면 앞 요청을 끊는다 · 이 줄은 404(지식)
    R.pvKnowGone = pvShape();
    SLOW_BODY = false;
    n0 = log.length;
    await hover("회의록 정리");
    R.pvAbort = { reqs: since(n0).filter((x) => x.includes("/api/ui/knowledge/k-minutes")).length, lines: pvShape()?.lines, empty: pvShape()?.empty };
    n0 = log.length;
    await hover("슬랙 검색 고치기", 300);
    R.pvBack = { reqs: since(n0).filter((x) => x.includes("/session-search/hits")).length, sec: pvShape()?.secs.find((x) => x.startsWith("맞은 말")) || "" };
    let nPv = OPENED.length;
    [...document.querySelectorAll(".v2-opv-btn")].find((b) => /새 탭/.test(b.textContent))?.click();
    R.pvNewTab = OPENED.length > nPv ? OPENED[OPENED.length - 1] : null;
    await search("슬랙");
    await hover("슬랙 검색 고치기");
    nPv = OPENED.length;
    document.querySelector(".v2-opv-btn.pri")?.click();
    R.pvOpen = OPENED.length > nPv ? OPENED[OPENED.length - 1] : null;
    await search("슬랙");
    await hover("«슬랙» 로 새 세션 시작", 200);
    R.pvCmd = pvShape();
    document.querySelector(".v2-opv-btn.pri")?.click();
    R.cmdRan = NEWSESS.slice();
    await search("슬랙");

    // ── A11 같은 줄 · 다른 검색어 ── («지식» 탭 — 두 검색어 모두 첫 줄이 «슬랙 검색 설계»)
    tabEl("know")?.click();
    await search("슬랙 검색");
    await sleep(300);
    R.pvQ1 = { sel: allRowsNow().find((r) => r.sel)?.t || "", t: pvShape()?.t, marks: pvShape()?.marks };
    n0 = log.length;
    await search("슬랙 검색 설계");
    await sleep(300);
    R.pvQ2 = { sel: allRowsNow().find((r) => r.sel)?.t || "", t: pvShape()?.t, marks: pvShape()?.marks, reqs: since(n0).filter((x) => x.includes("/api/ui/knowledge/k-design")).length };
    tabEl("all")?.click();
    await search("슬랙");

    // ── A13 키보드만으로 탭 줄 · 단추들 ──
    {
      const cls = () => { const a = document.activeElement; return !a ? "" : a.classList.contains("v2-omni-tab") ? "tab:" + a.dataset.tab : (a.className || "").split(" ").filter((c) => /^v2-/.test(c)).pop() || a.tagName; };
      const fire = (k, extra = {}) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
      key("ArrowUp");                      // 첫 줄이 고른 채 — 맨 위에서 ↑
      const up = cls();
      const right = [];
      for (let i = 0; i < 6; i++) { fire("ArrowRight"); right.push(cls()); }
      const tabStill = tabOn();
      //  정렬 단추에서 Tab — 미리보기 안의 단추들을 지나 입력칸으로 돌아온다(입력칸에서는 Tab 이 다시 종류 넘기기다 — 거기서 멈춘다)
      const tabs = [];
      for (let i = 0; i < 14 && cls() !== "v2-omni-in"; i++) { fire("Tab"); tabs.push(cls()); }
      const inside = !!$(".v2-omni") && $(".v2-omni").contains(document.activeElement);
      tabEl("all").focus(); fire("Tab", { shiftKey: true });
      const shift = cls();                 // 탭 줄에서 Shift+Tab = 닫기 단추
      tabEl("all").focus(); fire("ArrowDown");
      const down = cls();
      tabEl("all").focus(); fire("ㄱ");    // 단추에 초점이 있을 때 글자를 치면 입력칸으로
      const typed = cls();
      tabEl("all").focus(); fire("Process");   // 한글 입력기가 켜져 있을 때의 첫 keydown
      R.kb = { up, right, tabs, inside, shift, down, typed, ime: cls(), tabStill };
    }

    // ── G26 세션 = 대화 포함 · A8 탭 ──
    R.tabLabels = [...document.querySelectorAll(".v2-omni-tab")].map((b) => b.querySelector("span")?.textContent.trim());
    R.tabNums = Object.fromEntries([...document.querySelectorAll(".v2-omni-tab")].map((b) => [b.dataset.tab, b.querySelector(".v2-omni-tabn")?.hidden ? "" : (b.querySelector(".v2-omni-tabn")?.textContent || "")]));
    R.badges = [...document.querySelectorAll(".v2-omni-row .v2-omni-badge")].map((b) => b.textContent);
    n0 = log.length;
    key("Tab");
    await sleep(80);
    R.tabKey = { on: tabOn(), reqs: since(n0), badges: [...new Set([...document.querySelectorAll(".v2-omni-row .v2-omni-badge")].map((b) => b.textContent))], focus: document.activeElement === $(".v2-omni-in") };
    R.sessTabReqs = since(n0);
    R.sessTabShape = shape();
    key("Tab", { shiftKey: true });
    await sleep(60);
    R.tabBack = tabOn();
    // ── A14 자료 탭 — 자료만 묻고, 오는 동안은 «찾는 중» ──
    n0 = log.length;
    DELAY.src = 500;
    tabEl("src")?.click();
    await sleep(160);
    const numsOf = () => Object.fromEntries([...document.querySelectorAll(".v2-omni-tab")].map((b) => [b.dataset.tab, b.querySelector(".v2-omni-tabn")?.hidden ? "" : (b.querySelector(".v2-omni-tabn")?.textContent || "")]));
    R.srcWait = { none: $(".v2-omni-none")?.hidden ? "" : ($(".v2-omni-none")?.textContent || ""), bar: !!$(".v2-omni-bar.on"), nums: numsOf() };
    await waitFor(() => document.querySelectorAll(".v2-omni-row").length > 0, 3000); await waitFor(isSettled); await sleep(40);
    DELAY.src = 0;
    R.srcTab = { on: tabOn(), reqs: since(n0).filter((x) => x.includes("/api/ui/sources")).length, other: since(n0).filter((x) => /session-search|knowledge\/search|projects\/search|similar/.test(x)),
      rows: allRowsNow().map((r) => r.t + "|" + r.sub), nums: numsOf(), none: !$(".v2-omni-none")?.hidden };
    tabEl("all")?.click();
    await sleep(80);

    // ── A19 자료가 오는 동안 누른 Enter ──
    await search("슬랙 자료");
    DELAY.src = 500;
    const nSrcE = OPENED.length;
    for (let i = 0; i < 4; i++) key("Tab");         // 전체 → 세션 → 프로젝트 → 지식 → 자료(이때 자료만 묻는다)
    key("Enter");
    await sleep(140);
    R.srcEnter = { tab: tabOn(), early: OPENED.length - nSrcE, note: $(".v2-omni-note")?.hidden ? "" : ($(".v2-omni-note")?.textContent || "") };
    await waitFor(() => OPENED.length > nSrcE, 3000);
    R.srcEnter.opened = OPENED.length > nSrcE ? OPENED[OPENED.length - 1] : null;
    DELAY.src = 0;
    await search("슬랙");
    tabEl("all")?.click();
    await sleep(80);

    // ── G15 관련도순 + 저장 ── (정렬은 탭 줄 오른쪽 단추의 메뉴)
    const pickSort = async (label) => { $(".v2-omni-sort")?.click(); await waitFor(() => !!$(".pn-ctx")); await sleep(120); [...document.querySelectorAll(".pn-ctx .pn-ctx-i")].find((b) => b.textContent.includes(label))?.click(); await sleep(60); await waitFor(isSettled); await sleep(40); };
    n0 = log.length;
    await pickSort("관련도순");
    R.sortCountReqs = since(n0).filter((x) => x.includes("mode=count")).length;   // 검색어가 같으니 개수는 다시 묻지 않는다
    R.sortReqs = since(n0).filter((x) => x.includes("/api/ui/v6/session-search?")).length;
    R.rel = shape();
    R.sortStored = localStorage.getItem("lively.omni.sort.v2");
    await pickSort("최신순");

    // ── G12 탭: 초점·그 종류만·다시 묻지 않는다·안내 문구 ──
    n0 = log.length;
    tabEl("know")?.click();
    R.tabFocus = document.activeElement === $(".v2-omni-in");
    await sleep(80);
    R.tabReqs = since(n0);
    R.tabBadges = [...new Set([...document.querySelectorAll(".v2-omni-row .v2-omni-badge")].map((b) => b.textContent))];
    R.tabPlaceholder = $(".v2-omni-in").placeholder;
    tabEl("all")?.click();
    await sleep(60);

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
    R.recentIcon = (() => { const r = rowEl("다른말"); return r ? [...r.querySelectorAll(".v2-omni-ic path")].map((p) => p.getAttribute("d")).join(" | ") : ""; })();

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
    key("ArrowUp");   // 입력칸의 Tab 은 종류를 넘긴다 — 창 안을 도는 Tab 은 초점이 단추에 있을 때다(맨 위에서 ↑ 로 탭 줄에 올라간다)
    for (let i = 0; i < 25; i++) document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
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
    R.emptyNote = $(".v2-omni-none")?.hidden ? "" : ($(".v2-omni-none")?.textContent || "");
    R.emptyRows = [...document.querySelectorAll(".v2-omni-row .v2-omni-badge")].filter((b) => b.textContent !== "명령").length;
    CONV_FAIL = true; await search("슬랙"); R.failNote = $(".v2-omni-note")?.textContent || ""; R.failRows = document.querySelectorAll(".v2-omni-row").length; CONV_FAIL = false;
    n0 = log.length; await search("슬랙 " + "가".repeat(205)); R.longReqs = since(n0); R.longNote = $(".v2-omni-note")?.textContent || "";
    PENDING = null; await search("슬랙 다시"); R.unknownNote = $(".v2-omni-note")?.textContent || ""; PENDING = 0;
    CONV_FAIL = "500"; await search("슬랙 또"); R.err500Note = $(".v2-omni-note")?.textContent || ""; CONV_FAIL = false;

    // ── G23 지식 채널 실패 ──
    await search("고장");
    R.knowFailNote = $(".v2-omni-note")?.hidden ? "" : ($(".v2-omni-note")?.textContent || "");
    // ── G24 칩 하나 + 꽉 찬 채널 → 더 보기(앞 장면의 기간 «오늘» 이 남아 있어 시각은 오늘 안에 둔다) ──
    tabEl("know")?.click();
    await sleep(60);
    await search("꽉");
    R.moreShown = !$(".v2-omni-more").hidden;
    R.moreRows0 = document.querySelectorAll(".v2-omni-row").length;
    n0 = log.length;
    $(".v2-omni-more").click();
    await sleep(60); await waitFor(isSettled); await sleep(40);
    R.moreReq = since(n0).find((x) => x.includes("/api/ui/knowledge/search")) || "";
    R.moreRows1 = document.querySelectorAll(".v2-omni-row").length;
    //  A13 — 맨 아래 줄에서 ↓ 는 «결과 더 보기» 와 같은 일(키보드로 닿는 길)
    n0 = log.length;
    for (let i = 0; i < R.moreRows1 - 1; i++) key("ArrowDown");   // 첫 줄에서 마지막 줄까지
    const lastSel = allRowsNow().find((r) => r.sel)?.t || "";
    key("ArrowDown");                                            // 맨 아래에서 한 번 더
    await sleep(60); await waitFor(isSettled); await sleep(40);
    R.moreKey = { req: since(n0).find((x) => x.includes("/api/ui/knowledge/search") && !x.includes("mode=count")) || "", rows: document.querySelectorAll(".v2-omni-row").length, focus: document.activeElement === $(".v2-omni-in"),
      lastSel, sel: allRowsNow().find((r) => r.sel)?.t || "", first: allRowsNow()[0]?.t || "" };
    tabEl("all")?.click();   // 전체로 돌아온다
    await sleep(60);
    // ── G25 Alt+Enter = 새 화면 ──
    await search("슬랙");
    const nAlt = OPENED.length;
    key("Enter", { altKey: true });
    await waitFor(() => OPENED.length > nAlt, 2000);
    R.altEnter = OPENED.length > nAlt ? OPENED[OPENED.length - 1] : null;

    // ── A16 이 탭이 비었고 다른 종류에 있다 → «전체에서 보기» ──
    await search("다른말");
    tabEl("proj")?.click();
    await sleep(80);
    R.noneGo = { text: $(".v2-omni-none")?.hidden ? "" : ($(".v2-omni-none")?.textContent || ""), btn: $(".v2-omni-none-go")?.textContent || "" };
    $(".v2-omni-none-go")?.click();
    await sleep(60);
    R.noneGo.after = tabOn();
    R.noneGo.rows = allRowsNow().filter((r) => r.badge !== "명령").map((r) => r.t);

    // ── A18 태블릿 — 첫 누름은 고르기 · 다시 누르면 연다 / 폰 — 판 ──
    MQ.noHover = true;
    await search("슬랙");
    let nT = OPENED.length;
    const pick = allRowsNow().find((r) => !r.sel && r.badge === "지식")?.t || "";
    rowEl(pick)?.click();
    await sleep(320);
    R.touch = { pick, opened1: OPENED.length - nT, sel: allRowsNow().find((r) => r.sel)?.t || "", pv: pvShape()?.t || "", open: OM.omniIsOpen() };
    rowEl(pick)?.click();
    await sleep(40);
    R.touch.opened2 = OPENED.length - nT;
    MQ.noHover = false;
    MQ.narrow = true;
    await search("슬랙");
    nT = OPENED.length;
    rowEl("슬랙 검색 설계")?.click();
    await sleep(320);
    R.sheet = { up: !!$(".v2-omni-card.sheet"), opened: OPENED.length - nT, pv: pvShape()?.t || "" };
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await sleep(40);
    R.sheet.afterEsc = { up: !!$(".v2-omni-card.sheet"), open: OM.omniIsOpen() };
    rowEl("슬랙 검색 설계")?.click();
    await sleep(60);
    $(".v2-omni-grab")?.click();
    R.sheet.afterGrab = !!$(".v2-omni-card.sheet");
    const nNew = NEWSESS.length;
    rowEl("«슬랙» 로 새 세션 시작")?.click();   // 안을 읽을 것이 없는 줄은 폰에서도 바로 한다
    await sleep(40);
    R.sheet.cmd = NEWSESS.length - nNew;
    MQ.narrow = false;

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
  //  안 A — 맞은 말은 미리보기 칸이 보인다(A1). 목록 둘째 줄은 «어디에 있는 것인가»: 프로젝트가 없는 세션은 고친 파일이 그 자리를 받는다.
  check(!!a && a.badge === "세션" && /고친 파일 v2\/omni\.ts/.test(a.sub) && a.when !== "", "G5 그 줄 = «세션» · 고친 파일 · 시각(맞은 말은 미리보기 칸에)", JSON.stringify(a));
  const b = row(R.def, "지난 대화 B");
  check(!!b && b.badge === "세션" && b.marks.includes("슬랙") && /슬랙처럼 맨 위에 셋/.test(b.sub) && b.when !== "", "G4 대화로 맞은 세션 줄 = «세션» · 발췌 한 줄(색칠) · 시각", JSON.stringify(b));
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
// G27
check(/a10 10 0 1 0 0 20/.test(R.recentIcon || "") && /M12 7v5l3\.5 2/.test(R.recentIcon || "") && !/M4 5h16v12H4z/.test(R.recentIcon || ""), "G27 최근 검색 줄은 시계 그림", JSON.stringify(R.recentIcon));
// 안 A — 미리보기 · 탭
{
  const v = R.pvSess || {};
  check(v.kind === "세션" && v.t === "슬랙 검색 고치기" && v.secs.some((x) => /^맞은 말1 \/ 2/.test(x))
    && JSON.stringify(v.msgs) === JSON.stringify(["dim|AI|무엇을 도와드릴까요", "hit|나|슬랙처럼 검색 고쳐 줘", "dim|AI|네 순서를 고치겠습니다"]),
    "A1 세션 미리보기 = 맞은 말(1 / 2)과 앞뒤 말 · 누구의 말", JSON.stringify({ secs: v.secs, msgs: v.msgs }));
  check((v.files || []).includes("v2/omni.ts") && /검색 순서가 이상해/.test(v.first || "") && (v.facts || []).some((x) => /말 5개/.test(x)) && (v.marks || []).includes("슬랙"),
    "A1 고친 파일 · 처음 시킨 말 · 말 수 · 맞은 낱말 색칠", JSON.stringify({ files: v.files, first: v.first, facts: v.facts, marks: v.marks }));
  check((R.pvSessReqs || []).length === 1 && /session_id=conv-a/.test(R.pvSessReqs[0]) && /q=슬랙/.test(R.pvSessReqs[0]), "A1 요청에 그 세션의 대화 id 와 검색어가 실린다(한 번)", JSON.stringify(R.pvSessReqs));
  check(JSON.stringify(v.btns) === JSON.stringify(["열기", "새 탭"]), "A1 단추 = 열기 · 새 탭(곁칸은 지식만)", JSON.stringify(v.btns));
}
check(/^맞은 말2 \/ 2/.test(R.pvNav?.sec || "") && /슬랙 방식으로 바꿨습니다/.test((R.pvNav?.msgs || []).join()) && R.pvNav.sel === R.pvNav.selBefore && R.pvNav.sel === "슬랙 검색 고치기",
  "A2 Shift+↓ = 다음 맞은 말(2 / 2) · 고른 줄은 그대로", JSON.stringify(R.pvNav));
check(R.pvBack?.reqs === 0 && /^맞은 말1 \/ 2/.test(R.pvBack?.sec || ""), "A3 다른 줄을 봤다 돌아와도 다시 묻지 않는다", JSON.stringify(R.pvBack));
check(!!R.pvNewTab && R.pvNewTab.href === "#/s/box-a" && R.pvNewTab.newTab === true && !!R.pvOpen && R.pvOpen.href === "#/s/box-a" && R.pvOpen.newTab === false,
  "A4 미리보기 [새 탭] = 새 탭 · [열기] = 그 자리", JSON.stringify({ tab: R.pvNewTab, open: R.pvOpen }));
{
  const v = R.pvKnow || {};
  check(v.kind === "지식" && /as-built/.test(v.tag) && (v.facts || []).some((x) => /웹 UI/.test(x)) && JSON.stringify(v.crumbs) === JSON.stringify(["순서"])
    && JSON.stringify(v.lines) === JSON.stringify(["앞 줄입니다.", "★슬랙처럼 최근 것부터 보인다.", "뒤 줄입니다."]) && (v.toc || []).includes("화면"),
    "A5 지식 미리보기 = 머리말 · 분류 · 맞은 줄과 그 절(앞뒤 한 줄) · 목차", JSON.stringify({ tag: v.tag, facts: v.facts, crumbs: v.crumbs, lines: v.lines, toc: v.toc }));
}
{
  const v = R.pvProj || {}, t = R.pvTask || {};
  check(v.kind === "프로젝트" && v.pill === "완료" && (v.secs || []).some((x) => /태스크1 \/ 2 끝남 · 하는 중 1/.test(x)) && /슬랙 토큰 갱신/.test((v.trows || [])[0] || ""),
    "A6 프로젝트 미리보기 = 상태 · 태스크 진행 · 태스크 줄(낱말이 든 것 먼저)", JSON.stringify({ pill: v.pill, secs: v.secs, trows: v.trows }));
  check(t.kind === "태스크" && t.pill === "진행 중" && (t.facts || []).some((x) => /슬랙 연동/.test(x)) && (t.lines || []).some((x) => /★토큰이 만료되면 슬랙 수집이 멈춘다/.test(x)),
    "A6 태스크 미리보기 = 상태 · 상위 프로젝트 · 본문에서 맞은 줄", JSON.stringify({ pill: t.pill, facts: t.facts, lines: t.lines }));
}
check(JSON.stringify(R.pvNoHit?.msgs) === JSON.stringify(["plain|지시|예전에 처음 시킨 말", "plain|AI|예전의 마지막 말"]) && (R.pvNoHit?.secs || []).join() === "처음 시킨 말,마지막 말",
  "A7 낱말이 말에 없는 세션 = 처음 시킨 말 · 마지막 말 — 남의 세션이면 «지시»(서버가 mine 으로 말한다)", JSON.stringify({ secs: R.pvNoHit?.secs, msgs: R.pvNoHit?.msgs }));
check(/아직 서버에 올라오지 않았습니다/.test(R.pvGone?.empty || "") && !/지워졌거나/.test(R.pvGone?.empty || "") && R.pvGone?.t === "지난 대화 B" && (R.pvGone?.btns || []).includes("열기"),
  "A17 세션 기록이 서버에 없으면(404) «아직 올라오지 않았다» 고 말한다 — 지워졌다고 하지 않는다 · 열기 단추는 남는다", JSON.stringify(R.pvGone));
check(R.pvGoneReqs === 2, "A17 그 답은 기억하지 않는다 — 다시 고르면 다시 묻는다(잠시 뒤엔 올라와 있을 수 있다)", JSON.stringify(R.pvGoneReqs));
check(/볼 수 없는 항목/.test(R.pvKnowGone?.empty || "") && R.pvKnowGone?.t === "주간 보고", "A17 다른 종류의 404 = «지금은 볼 수 없는 항목»", JSON.stringify(R.pvKnowGone));
check(R.pvAbort?.reqs === 1 && (R.pvAbort.lines || []).some((x) => /★슬랙 이야기를 했다/.test(x)), "A12 본문을 받다 끊긴 요청은 기억하지 않는다 — 돌아오면 다시 묻고 내용이 선다", JSON.stringify(R.pvAbort));
check(R.pvQ1?.sel === "슬랙 검색 설계" && R.pvQ2?.sel === "슬랙 검색 설계" && !(R.pvQ1.marks || []).includes("설계") && (R.pvQ2.marks || []).includes("설계") && R.pvQ2.reqs === 0,
  "A11 같은 줄 · 검색어만 바뀜 → 미리보기 색칠이 새 낱말로(다시 묻지 않는다)", JSON.stringify({ q1: R.pvQ1, q2: R.pvQ2 }));
{
  const k = R.kb || {};
  check(k.up === "tab:all" && JSON.stringify(k.right) === JSON.stringify(["tab:sess", "tab:proj", "tab:know", "tab:src", "v2-omni-period", "v2-omni-sort"]) && k.tabStill === "all",
    "A13 맨 위 줄에서 ↑ = 탭 줄 · ←→ 로 탭 · 기간 · 정렬(초점만 옮긴다 — 탭은 그대로)", JSON.stringify(k));
  check(k.inside === true && (k.tabs || []).includes("v2-opv-btn") && (k.tabs || [])[k.tabs.length - 1] === "v2-omni-in" && k.shift === "v2-omni-close",
    "A13 정렬에서 Tab = 미리보기 단추를 지나 입력칸으로(창 안에서만) · 탭 줄에서 Shift+Tab = 닫기 단추", JSON.stringify({ tabs: k.tabs, shift: k.shift }));
  check(k.down === "v2-omni-in" && k.typed === "v2-omni-in" && k.ime === "v2-omni-in", "A13 탭 줄에서 ↓ · 글자를 치면(한글 입력기의 첫 키 포함) 입력칸으로 돌아온다", JSON.stringify({ down: k.down, typed: k.typed, ime: k.ime }));
}
check(/limit=50/.test(R.moreKey?.req || "") && R.moreKey.rows > R.moreRows1 && R.moreKey.focus === true, "A13 맨 아래 줄에서 ↓ = 더 가져온다(«결과 더 보기» 와 같은 일)", JSON.stringify(R.moreKey));
check(!!R.moreKey?.lastSel && R.moreKey.sel === R.moreKey.lastSel && R.moreKey.sel !== R.moreKey.first, "A19 더 가져온 뒤에도 고른 줄은 그대로(맨 위로 돌아가지 않는다)", JSON.stringify({ last: R.moreKey?.lastSel, sel: R.moreKey?.sel, first: R.moreKey?.first }));
check(R.sortCountReqs === 0 && R.sortReqs >= 1, "A19 정렬을 바꿔 다시 찾을 때 개수는 다시 묻지 않는다(검색어가 같다 — 줄만 다시 받는다)", JSON.stringify({ count: R.sortCountReqs, conv: R.sortReqs }));
check(R.srcEnter?.tab === "src" && R.srcEnter.early === 0 && /결과가 다 오면 첫 줄을 엽니다/.test(R.srcEnter.note || "") && R.srcEnter.opened?.href === "#/sources/501",
  "A19 자료가 오는 동안 누른 Enter — 바로 열지 않고(버리지도 않고) 다 오면 첫 줄을 연다", JSON.stringify(R.srcEnter));
check((R.navTabIndex || []).length === 2 && R.navTabIndex.every((x) => x === -1) && !(R.kb?.tabs || []).includes("v2-opv-navb"), "A19 ‹ › 는 Tab 길에 없다(키보드는 Shift+↑↓)", JSON.stringify({ idx: R.navTabIndex, tabs: R.kb?.tabs }));
check(/자료에서 찾는 중입니다/.test(R.srcWait?.none || "") && !/결과가 없습니다/.test(R.srcWait?.none || "") && R.srcWait.bar === true && R.srcWait.nums.sess !== "",
  "A14 자료가 오는 동안 = «찾는 중»(«결과가 없습니다» 아님) · 다른 탭의 숫자는 그대로", JSON.stringify(R.srcWait));
check((R.srcTab?.other || []).length === 0 && JSON.stringify(R.srcTab.rows) === JSON.stringify(["슬랙 수집 원문|Slack · general", "슬랙 연동 메모.md|올린 파일"]) && R.srcTab.nums.src === "2" && R.srcTab.none === false,
  "A14 자료 탭은 자료만 묻는다(다른 채널 0) · 오면 줄과 숫자가 선다 — 둘째 줄은 출처를 사람 말로", JSON.stringify(R.srcTab));
check(/프로젝트.*에는 없고 다른 종류에 있습니다/.test(R.noneGo?.text || "") && /전체에서 1개 보기/.test(R.noneGo.btn || "") && R.noneGo.after === "all" && (R.noneGo.rows || []).includes("다른말 문서"),
  "A16 이 탭이 비었고 다른 종류에 있으면 «전체에서 N개 보기» 로 건넌다", JSON.stringify(R.noneGo));
check(!!R.touch?.pick && R.touch.opened1 === 0 && R.touch.sel === R.touch.pick && R.touch.pv === R.touch.pick && R.touch.open === true && R.touch.opened2 === 1,
  "A18 태블릿 — 첫 누름은 고르기(미리보기) · 고른 줄을 다시 누르면 연다", JSON.stringify(R.touch));
check(R.sheet?.up === true && R.sheet.opened === 0 && R.sheet.pv === "슬랙 검색 설계" && R.sheet.afterEsc.up === false && R.sheet.afterEsc.open === true && R.sheet.afterGrab === false && R.sheet.cmd === 1,
  "A18 폰 — 줄을 누르면 판이 올라온다(열지 않는다) · Esc·손잡이는 판만 내린다 · 명령 줄은 바로 한다", JSON.stringify(R.sheet));
check(R.tabKey?.on === "sess" && R.tabKey.focus === true && JSON.stringify(R.tabKey.badges) === JSON.stringify(["세션"]) && !(R.tabKey.reqs || []).some((l) => /search|similar|sources/.test(l)) && R.tabBack === "all",
  "A8 Tab = 다음 탭(세션) · 다시 묻지 않는다 · 초점은 입력칸 · Shift+Tab = 앞 탭", JSON.stringify({ k: R.tabKey, back: R.tabBack }));
check(JSON.stringify(R.tabNums) === JSON.stringify({ all: "304", sess: "37", proj: "12", know: "254", src: "" }), "A15 탭 숫자 = 서버가 센 전체 개수(받은 줄 수가 아니다) · «전체» 는 바로 가기 줄(분류 하나)까지 — 자료는 묻기 전이라 비어 있다", JSON.stringify(R.tabNums));
check(!(R.todayReqs || []).some((l) => /mode=count/.test(l)) && (R.defReqs || []).filter((l) => /mode=count/.test(l)).length === 2, "A15 기간으로 좁혔을 때는 프로젝트·지식 개수를 묻지 않는다(평소엔 둘)", JSON.stringify({ today: R.todayReqs, def: (R.defReqs || []).filter((l) => /mode=count/.test(l)) }));
check(R.srcTab?.on === "src" && R.srcTab.reqs === 1, "A8 자료 탭은 눌렀을 때 묻는다(한 번)", JSON.stringify(R.srcTab));
check(JSON.stringify(R.topGuar) === JSON.stringify(["보장 문서 1", "보장 문서 2", "대화로만 맞은 세션"]), "A9 이름에 낱말이 든 지식 셋이 있어도 맨 위 셋의 끝자리에 대화로 맞은 세션이 선다", JSON.stringify(R.topGuar));
check(!!R.guarRow && /어떤 프로젝트/.test(R.guarRow.sub) && /보장되지/.test(R.guarRow.sub) && R.guarRow.marks.includes("보장"), "A9 셸이 모르는 세션 줄의 둘째 줄 = 서버가 준 프로젝트 이름 + 맞은 말 한 조각(색칠)", JSON.stringify(R.guarRow));
check(R.pvCmd?.kind === "명령" && JSON.stringify(R.pvCmd.btns) === JSON.stringify(["새 세션 시작"]) && (R.pvCmd.lines || []).some((x) => /입력칸에 «슬랙» 를 넣어 둡니다/.test(x)) && JSON.stringify(R.cmdRan) === JSON.stringify(["슬랙"]),
  "A10 명령 줄 = 무엇을 하는지 + [새 세션 시작] — 누르면 그 글로 새 세션", JSON.stringify({ pv: R.pvCmd, ran: R.cmdRan }));
// G26
check(JSON.stringify(R.tabLabels) === JSON.stringify(["전체", "세션", "프로젝트", "지식", "자료"]), "G26 탭 = 전체·세션·프로젝트·지식·자료 — «대화» 는 없다", JSON.stringify(R.tabLabels));
check(!R.badges.includes("대화") && allRows(R.def).some((r) => r.t === "모르는 세션" && r.badge === "세션"), "G26 대화로 걸린 세션도 «세션» 배지", JSON.stringify(R.badges));
check(allRows(R.sessTabShape).some((r) => r.t === "모르는 세션") && allRows(R.sessTabShape).every((r) => r.badge === "세션"), "G26 세션 탭에 대화로 걸린 세션이 선다(세션 줄만)", JSON.stringify(titles(R.sessTabShape)));
check(!(R.rel || []).some((g) => g.h === "대화"), "G26 관련도순에도 «대화» 묶음이 없다", JSON.stringify((R.rel || []).map((g) => g.h)));
// G15
{
  const heads = (R.rel || []).map((g) => g.h);
  check(heads[0] === "가장 맞는 결과" && ["세션", "프로젝트", "지식"].every((h) => heads.includes(h)) && heads[heads.length - 1] === "뜻이 비슷한 지식", "G15 관련도순 = 맨 위 셋 다음 종류별 묶음", JSON.stringify(heads));
  check(R.sortStored === "rel", "G15 정렬은 저장된다(lively.omni.sort.v2)", JSON.stringify(R.sortStored));
}
// G12
check(R.tabFocus === true, "G12 탭을 눌러도 입력칸에 초점이 남는다", JSON.stringify(R.tabFocus));
check(JSON.stringify(R.tabBadges) === JSON.stringify(["지식"]) && !(R.tabReqs || []).some((l) => /search|similar/.test(l)), "G12 «지식» 탭 = 지식 줄만 · 다시 묻지 않는다(받아 둔 결과)", JSON.stringify({ badges: R.tabBadges, reqs: R.tabReqs }));
check(/지식에서 찾기/.test(R.tabPlaceholder || ""), "G12 안내 문구가 좁힌 사실을 말한다", JSON.stringify(R.tabPlaceholder));
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
check(R.moreShown === true && /limit=40/.test(R.moreReq || "") && R.moreRows1 > R.moreRows0, "G24 탭 하나 + 꽉 찬 채널 → «더 보기» → 더 많이 청한다", JSON.stringify({ shown: R.moreShown, req: R.moreReq, rows: [R.moreRows0, R.moreRows1] }));
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
check(R.emptyRows === 0 && /결과가 없습니다/.test(R.emptyNote || "") && /오늘 안의 결과만 봤습니다/.test(R.emptyNote || "") && /«자료» 탭/.test(R.emptyNote || ""), "G17 결과 없음 + 기간 → 목록 자리에 기간 이유와 자료 탭 안내", JSON.stringify({ n: R.emptyRows, note: R.emptyNote }));
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
