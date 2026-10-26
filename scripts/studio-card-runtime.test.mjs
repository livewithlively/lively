#!/usr/bin/env node
// 앱빌더 ② 기획 카드 — 글이 카드 밖으로 잘리지 않나 · 줄 이름 · 더한 항목(#4632) — 런타임 회귀 테스트(헤드리스 크롬 · 가짜 서버).
//
// 원준 2026-10-26:
//  «이거봐봐 기획카드같은데 잘려있어»(「참고한 것」 에 링크 주소가 길게 든 카드 — 모든 줄이 카드 오른쪽 밖에서 잘렸다)
//  «표현이 무엇을 적나 이런거 좀 이상한데, 좀 명확하게 이해되는 표현으로»
//  «원하면 그냥 섹션 제목(첫 화면, 알림에 이어서)과 본문도 원한다면 더 추가해서 넣을 수 있게»
//  카드 글(cardText) · 읽기(parseCard) 의 줄 이름 · 더한 항목 규칙은 app-studio-flow.test.mjs L · X 가 잰다. 여기선 화면에서만 보이는 것을 잰다.
//
// 엣지 표(스크래치패드 spec-card-wrap.md):
//  C1 「참고한 서비스」 에 카드보다 긴 링크 — 모든 값의 오른쪽 끝 ≤ 카드 안쪽 오른쪽 끝 · 카드 가로 넘침 0 (넓은 창)
//  C2 긴 문장 줄은 여러 줄로 감긴다 · 카드 안
//  C3 좁은 창(380px) — C1 과 같다
//  C4 짧은 값만(경계) — 이름표 칸 폭 그대로 · 값 한 줄
//  C5 고치기 카드 — 값 칸을 눌러 고칠 수 있다
//  L5 이름표 = 새 이름 여덟 · 가장 긴 「넣지 않는 기능」 도 한 줄
//  E1 「+ 항목 더하기」 — 새 줄 · 제목 칸에 커서 · 적고 나가면 기록(card.extra)에 남는다
//  E2 × — 줄과 기록에서 빠진다
//  E3 다시 열기 — 더한 항목이 정해진 줄 뒤에 그대로
//  V1 「참고한 서비스」 보기 — 서비스마다 한 줄(이름 굵게) · 출처는 새 탭 링크(이름만) · 보이는 글에 주소 없음
//  V4 링크를 누르면 고치기로 바뀌지 않는다   V5 보기 상태로 들렀다 나가기만 하면 기록이 그대로(보기 글로 안 덮인다)
//  V2 글을 누르면 원문 그대로 고치기 · 커서   V3 고치고 나가면 기록에 남고 다시 보기
//  W  페이지 예외 없음 · 카드가 실제로 그려졌다
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(이 변경 전 origin/main 에서 C1 · C3 · L5 · E1~E3 이 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 기획 카드 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=St", "--platform=browser", "--loader=ts", "--sourcefile=card-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: "export { renderBuilderApp } from './v2/builder.ts';", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

//  원준 화면(image-15)의 카드 — 「참고한 것」 에 띄어쓰기 없는 긴 링크 주소.
const LONG = {
  name: "회의록", who: "회의 음성을 남겨 두고 나중에 정리본을 다시 찾아보거나 AI 세션에 참고로 넣으려는 사람",
  items: "회의마다 날짜·제목·올린 음성 파일·말한 사람별 전사문·고른 형식으로 만든 정리본",
  can: ["음성 파일을 올려 전사하고 고른 형식으로 요약해 정리본을 만들며 정리본은 직접 고칠 수 있음", "회의 종류에 따라 형식을 저절로 고르게 할 수 있음", "세션 사이드바에서 지난 회의록을 날짜와 낱말로 찾아 넣기"],
  not: "실시간 녹음, 화상회의에 봇으로 들어가기, 다른 사람과 공유하거나 권한 관리하기",
  first: "넓은 창에서는 앱 안 왼쪽에 날짜별(오늘·이번 주·월별)로 묶은 회의록 목록과 검색, 오른쪽에 고른 회의의 정리본과 「세션에 넣기」 버튼이 있는 화면으로 넘어갑니다.",
  notify: "올린 음성의 전사와 정리가 끝나거나 실패하면 그 파일을 올린 사람에게 알립니다.",
  ref: "Otter.ai에서는 회의 종류별 템플릿을 가져왔다. [Otter 블로그](https://otter.ai/blog/otter-meeting-types-get-smarter-tailored-summaries-for-every-conversation), [Fireflies Skills](https://fireflies.ai/blog/fireflies-ai-apps/), [클로바노트 앱스토어](https://apps.apple.com/kr/app/%ED%81%B4%EB%A1%9C%EB%B0%94%EB%85%B8%ED%8A%B8/id1546254396)",
};
//  끊을 자리가 아예 없는 낱말(공유 링크의 토큰 같은 것) — 브라우저는 «/» «%» 에서는 스스로 끊어 주지만 이건 못 끊는다.
LONG.items += " · 첨부 토큰 " + "Q".repeat(180);
//  원준 화면(2026-10-26)의 「참고한 것」 원문 — 산문 + «(출처: [이름](주소), …)».
const REF_PROSE = "Otter.ai에서는 회의 종류별 템플릿·제목과 참석자 규칙으로 템플릿을 저절로 고르는 방식·사용자 질문을 요약에 넣는 기능·요약/전사/AI 채팅 탭 구성을, Fireflies.ai에서는 프롬프트로 만드는 맞춤 정리 형식과 미리 만든 형식에 섹션을 덧붙이는 드롭다운, 전사문 옆 AI 패널을, 네이버 클로바노트에서는 요약·주요 주제·다음 할 일 정리와 그 결과를 고칠 수 있게 한 점, 말한 사람 구분, 검색을 가져왔습니다(출처: [Otter 블로그](https://otter.ai/blog/otter-meeting-types-get-smarter-tailored-summaries-for-every-meeting), [Otter 리뷰](https://kripeshadwani.com/otter-ai-review/), [Fireflies AI Skills](https://fireflies.ai/blog/fireflies-ai-apps/), [Fireflies Notepad 가이드](https://guide.fireflies.ai/articles/6653885315-learn-about-the-fireflies-notepad), [클로바노트 앱스토어](https://apps.apple.com/kr/app/%ED%81%B4%EB%A1%9C%EB%B0%94%EB%85%B8%ED%8A%B8-ai-%EC%9D%8C%EC%84%B1-%EA%B8%B0%EB%A1%9D/id1530010245)).";
const SHORT = { name: "메모", who: "나", items: "글", can: ["쓰기", "찾기", "지우기"], not: "공유", first: "목록", notify: "없음", ref: "애플 메모" };
const FETCH = `<script>
window.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u);
  const p = url.replace(/^.*?(\\/api\\/)/, "/api/");
  const j = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
  if (p.includes("/transcript")) return new Response("", { status: 200, headers: { "X-Log-To": "0" } });
  if (p.startsWith("/api/ui/notify/stream")) return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  if (p.startsWith("/api/ui/me/whoami")) return j({ member_id: "wonjoon-jang", display_name: "원준" });
  if (p.startsWith("/api/ui/apps")) return j({ apps: [] });
  if (p.includes("sessions")) return j({ sessions: [] });
  return j({});
};</script>`;

async function PAGE_MAIN() {
  const R = {}; const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => errors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (n) => (n ? n.textContent.replace(/\s+/g, " ").trim() : null);
  localStorage.setItem("lively_v2_app_studio_seen", JSON.stringify({ intro: 1, coach: { plan: 1, draft: 1, check: 1, put: 1 } }));
  const env = { projects: () => [], sessions: () => [], redrawSide: () => {}, setRoute: () => {} };
  const rec = (sid, card) => ({ sid, pid: 0, what: card.name + " 앱", place: "both", appId: "", known: [], at: Date.now(), stage: "plan", card, round: 0, from: 0, mode: "new", title: card.name, named: true, reached: 1 });
  const recs = () => JSON.parse(localStorage.getItem("lively_v2_app_studio") || "[]");
  //  한 창을 열고 카드를 잰다 — 값 칸이 카드 안쪽(오른쪽 안 여백 앞)을 넘는 만큼(칸 상자 · 칸 안 글이 칸 밖으로 삐져나간 만큼 중 큰 것) · 카드 가로 넘침 · 줄마다 높이.
  const open = async (width, sid, card) => {
    localStorage.setItem("lively_v2_app_studio", JSON.stringify([rec(sid, card)]));
    const host = document.createElement("div"); host.style.cssText = `width:${width}px;height:900px;position:relative;overflow:hidden`; document.body.append(host);
    history.replaceState(null, "", "#/builder/s/" + sid);
    St.renderBuilderApp(host, ["builder", "s", sid], new URLSearchParams(""), env);
    await sleep(1500);
    return host;
  };
  const measure = (host) => {
    const card = host.querySelector(".v2-studio-card");
    if (!card) return null;
    const cr = card.getBoundingClientRect(), hr = host.getBoundingClientRect();
    const inner = Math.min(cr.right - parseFloat(getComputedStyle(card).paddingRight), hr.right);
    const rows = [...card.querySelectorAll(".row")].map((r) => { const k = r.querySelector(".k"), v = r.querySelector(".v"); const vr = v.getBoundingClientRect(), kr = k.getBoundingClientRect();
      return { k: txt(k), over: Math.max(Math.round(vr.right - inner), v.scrollWidth - v.clientWidth), vh: Math.round(vr.height), kw: Math.round(kr.width), kh: Math.round(kr.height), edit: v.getAttribute("contenteditable") === "true" }; });
    return { cardOver: card.scrollWidth - card.clientWidth, cardPastHost: Math.round(cr.right - hr.right), rows };
  };
  window.__step = "C1";
  const wide = await open(1100, "box-p1", JSON.parse(JSON.stringify(window.__LONG)));
  R.wide = measure(wide);
  window.__step = "C3";
  const narrow = await open(380, "box-p2", JSON.parse(JSON.stringify(window.__LONG)));
  R.narrow = measure(narrow);
  window.__step = "C4";
  const short = await open(1100, "box-p3", JSON.parse(JSON.stringify(window.__SHORT)));
  R.short = measure(short);
  window.__step = "E1";
  // E1 — 더하기 · 제목 칸에 커서 · 적고 나가면 기록에
  const card = short.querySelector(".v2-studio-card");
  const add = card && [...card.querySelectorAll("button")].find((b) => /항목 더하기/.test(txt(b)));
  R.e1 = { add: !!add };
  if (add) {
    add.click(); await sleep(100);
    const row = card.querySelector(".row.x");
    const k = row && row.querySelector(".k"), v = row && row.querySelector(".v");
    R.e1.focused = !!k && document.activeElement === k;
    R.e1.last = !!row && row.nextElementSibling === add;
    if (k && v) { k.textContent = "결재 순서"; v.focus(); await sleep(50); v.textContent = "팀장 다음 재무"; v.blur(); await sleep(150); }
    R.e1.saved = (recs().find((r) => r.sid === "box-p3") || {}).card?.extra || null;
    // E2 — ×
    window.__step = "E2";
    const rm = row && row.querySelector("button");
    if (rm) { rm.click(); await sleep(150); }
    R.e2 = { rows: card.querySelectorAll(".row.x").length, saved: (recs().find((r) => r.sid === "box-p3") || {}).card?.extra || null };
  }
  // E3 — 더한 항목이 든 카드를 다시 연다
  window.__step = "E3";
  const re = await open(1100, "box-p4", { ...JSON.parse(JSON.stringify(window.__SHORT)), extra: [{ title: "결재 순서", body: "팀장 다음 재무" }, { title: "보관 기간", body: "5년" }] });
  const m3 = measure(re);
  R.e3 = m3 && m3.rows.map((r) => r.k);
  // V — 「참고한 서비스」 보기 · 고치기
  window.__step = "V1";
  document.addEventListener("click", (e) => { if (e.target.closest && e.target.closest("a")) e.preventDefault(); }, true);   // 링크가 실제로 새 창을 열지 않게(누름 자체는 그대로 흐른다)
  const vh = await open(1100, "box-p5", { ...JSON.parse(JSON.stringify(window.__LONG)), ref: window.__REF });
  const refV = () => [...vh.querySelectorAll(".v2-studio-card .row")].find((r) => txt(r.querySelector(".k")) === "참고한 서비스")?.querySelector(".v");
  const stored = () => (recs().find((r) => r.sid === "box-p5") || {}).card?.ref;
  let rv = refV();
  R.v1 = rv && { view: rv.classList.contains("ref") && rv.getAttribute("contenteditable") !== "true", names: [...rv.querySelectorAll("li b")].map(txt),
    links: [...rv.querySelectorAll("a")].map((a) => ({ t: txt(a), https: /^https:\/\//.test(a.getAttribute("href")), blank: a.target === "_blank", rel: /noopener/.test(a.rel) })), shown: rv.innerText };
  window.__step = "V4";
  if (rv && rv.querySelector("a")) { rv.querySelector("a").click(); await sleep(100); }
  rv = refV(); R.v4 = rv && { view: rv.classList.contains("ref"), editing: rv.getAttribute("contenteditable") === "true" };
  window.__step = "V5";
  if (rv) { rv.focus(); await sleep(50); rv.blur(); await sleep(150); }
  R.v5 = { same: stored() === window.__REF, view: !!refV() && refV().classList.contains("ref") };
  window.__step = "V2";
  rv = refV(); const li = rv && rv.querySelector("li span");
  if (li) { li.click(); await sleep(100); }
  rv = refV(); R.v2 = rv && { editing: rv.getAttribute("contenteditable") === "true", focused: document.activeElement === rv, raw: rv.textContent === window.__REF };
  window.__step = "V3";
  if (rv && R.v2 && R.v2.editing) { rv.textContent = window.__REF + " 노션 캘린더 보기"; rv.blur(); await sleep(150); }
  rv = refV(); R.v3 = { saved: stored() === window.__REF + " 노션 캘린더 보기", view: !!rv && rv.classList.contains("ref") && rv.getAttribute("contenteditable") !== "true" };
  R.errors = errors;
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}
const PAGE = `<!doctype html><html data-theme="light" lang="ko"><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css")}
  html,body{margin:0}
</style>
<div id="toasts"></div>
<pre id="out">PENDING</pre>
${FETCH}
<script>window.__LONG = ${JSON.stringify(LONG)}; window.__SHORT = ${JSON.stringify(SHORT)}; window.__REF = ${JSON.stringify(REF_PROSE)};</script>
<script>${bundle}</script>
<script>(${PAGE_MAIN.toString()})().catch((e) => { document.getElementById("out").textContent = "RESULT" + JSON.stringify({ crash: (window.__step || "") + " " + String((e && e.stack) || e).slice(0, 900) }) + "ENDRESULT"; });</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "studio-card-", virtualTimeBudget: 60000, args: ["--window-size=1200,1000"] });
const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-800)); process.exit(1); }
const R = JSON.parse(m[1]);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));
if (R.crash) { console.error("FAIL  페이지가 도중에 넘어졌다 — " + R.crash); process.exit(1); }

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "") => (cond ? ok(n) : bad(n, why));
const same = (got, want, n) => { const a = JSON.stringify(got), b = JSON.stringify(want); return a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };
const inside = (mm) => !!mm && mm.cardOver <= 0 && mm.cardPastHost <= 0 && mm.rows.length >= 8 && mm.rows.every((r) => r.over <= 1);
const worst = (mm) => (mm ? JSON.stringify({ cardOver: mm.cardOver, cardPastHost: mm.cardPastHost, over: mm.rows.map((r) => r.k + " " + r.over) }) : "카드 없음");
const NEW = ["앱 이름", "쓰는 사람", "저장하는 정보", "주요 기능", "넣지 않는 기능", "첫 화면", "알림", "참고한 서비스"];

check(inside(R.wide), "C1 긴 링크가 든 카드 — 모든 값이 카드 안에서 줄바꿈된다 · 카드가 옆으로 넘치지 않는다(넓은 창)", worst(R.wide));
const refRow = R.wide && R.wide.rows.find((r) => r.k === "참고한 서비스" || r.k === "참고한 것"), canRow = R.wide && R.wide.rows.find((r) => r.k === "주요 기능" || r.k === "할 수 있는 것");
check(!!refRow && refRow.vh > 40 && !!canRow && canRow.vh > 40, "C2 긴 줄은 여러 줄로 감긴다", JSON.stringify([refRow, canRow]));
check(inside(R.narrow), "C3 좁은 창(380px)에서도 카드 안", worst(R.narrow));
const sh = R.short && R.short.rows;
check(!!sh && sh.every((r) => r.over <= 1 && r.vh < 30) && new Set(sh.map((r) => r.kw)).size === 1, "C4 짧은 값만 — 값 한 줄 · 이름표 칸 폭이 모두 같다", JSON.stringify(sh));
check(!!sh && sh.filter((r) => r.k !== "참고한 서비스").every((r) => r.edit), "C5 고치기 카드 — 값 칸을 눌러 고칠 수 있다(참고한 서비스는 V2 — 보기에서 누르면 고치기)", JSON.stringify(sh && sh.map((r) => r.edit)));
same(sh && sh.map((r) => r.k), NEW, "L5 이름표가 새 이름 여덟");
check(!!sh && sh.every((r) => r.kh < 26), "L5 가장 긴 「넣지 않는 기능」 도 이름표 칸 안에 한 줄", JSON.stringify(sh && sh.map((r) => r.k + " " + r.kh)));
same(R.e1 && [R.e1.add, R.e1.focused, R.e1.last, R.e1.saved], [true, true, true, [{ title: "결재 순서", body: "팀장 다음 재무" }]], "E1 「+ 항목 더하기」 — 맨 아래 새 줄 · 제목 칸에 커서 · 적고 나가면 기록에 남는다");
same(R.e2 && [R.e2.rows, R.e2.saved], [0, []], "E2 × — 줄과 기록에서 빠진다");
same(R.e3, [...NEW, "결재 순서", "보관 기간"], "E3 다시 열면 더한 항목이 정해진 줄 뒤에 그대로");
same(R.v1 && [R.v1.view, R.v1.names, R.v1.links.length, R.v1.links.every((l) => l.https && l.blank && l.rel), R.v1.links[0] && R.v1.links[0].t], [true, ["Otter.ai", "Fireflies.ai", "네이버 클로바노트"], 5, true, "Otter 블로그"],
  "V1 「참고한 서비스」 보기 — 서비스마다 한 줄 · 출처는 새 탭 링크 다섯(이름만)");
check(!!R.v1 && !/https?:\/\/|\]\(|가져왔습니다|\(출처/.test(R.v1.shown), "V1 보이는 글에 주소 · 괄호 꼬리 · «가져왔습니다» 없음", R.v1 && R.v1.shown);
same(R.v4, { view: true, editing: false }, "V4 링크를 누르면 고치기로 바뀌지 않는다");
same(R.v5, { same: true, view: true }, "V5 보기로 들렀다 나가기만 하면 기록 그대로");
same(R.v2, { editing: true, focused: true, raw: true }, "V2 글을 누르면 원문 그대로 고치기 · 커서");
same(R.v3, { saved: true, view: true }, "V3 고치고 나가면 기록에 남고 다시 보기");
same(R.errors, [], "W  페이지 예외 없음");

console.log(`\n#4632 기획 카드(잘림 · 줄 이름 · 더한 항목): ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
