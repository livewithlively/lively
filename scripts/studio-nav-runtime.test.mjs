#!/usr/bin/env node
// 앱빌더 만들기 화면의 단계 바 · 머리줄 · ③ 실제 화면 표시(#4632) — 런타임 회귀 테스트(헤드리스 크롬 · 가짜 서버).
//
// 원준 2026-10-19:
//  «①~⑤ 상단 탭 … 내용 다 저장했었으면 이전으로 가는거 말고 다음으로 가는것도 있어야할 것 같음. 그리고 (3)하는 도중에 뒤로 뒤로 눌러서 (1)로 간 다음에 이전 (3)으로
//   다시 가는 느낌은 없고 밑에 이 내용으로 다시 기획 이거밖에 없어서 어색해. 그리고 상단 탭을 클릭하는 방향으로도 적절히 원하는 위치로 이동할 수 있어야할거같음.»
//  «앱빌더 › 앱 만들기 — 앱 만들기 이 말이 왜 필요한건지? 차라리 만들고 있는 앱 이름을 해야하는 것 아닌가? 그리고 앱빌더 누르면 앱 맨앞으로 나가져야하는데 안되는 것 같음.»
//  «3단계에서 앱 전체화면 보면서 만들 때 갑자기 뜬금없이 어떤 이유에선지 앱 빌더의 사이드바가 등장하네. 안그렇게 해줘.»
//  단계 바 규칙(와 본 끝 · 칸마다 꼴)은 app-studio-flow.test.mjs N, 보는 중 주소 · 사이드바 주인은 builder-flow V · side-owner C8 · C9 가 잰다. 여기선 화면에서만 보이는 것을 잰다.
//
// 엣지 표(스크래치패드 spec-side-foot-phone.md 사양 2 U):
//  U1 머리줄 「앱빌더」 는 단추 · 이름 = 앱 이름 · 「앱 만들기」 「앱 만드는 중」 없음   U2 ③(와 본 끝 ④) 단계 바 = ①② 돌아가기 · ③ 지금 · ④ 다시 가기 · ⑤ 아직
//  U3 ④ 다시 가기(같은 버전 · 같은 카드) — AI 에게 0건 · 지난 대조 그대로   U4 새 버전이 된 뒤 ④ — 대조를 다시 청한다(1건)
//  U5 ① 돌아가기 — 「다음 →」 · 아래 「다음 단계로」 · ②③ 다시 가기 · 「이 내용으로 다시 기획」 은 안 눌린다
//  U6 ① 에서 설명을 고침 — 「이 내용으로 다시 기획」 눌림 · 기록에 남음 · ③ 에 다녀와도 그대로
//  U7 ② 다시 가기(카드 그대로) — 「다음 →」 만 · 카드를 고치면 「바꾼 기획대로 다시 만들기」   U8 「앱빌더」 를 누르면 닫힌다(앱빌더 첫 화면으로)
//  U9 새 앱 ① — 머리줄 「새 앱」 → 이름을 치면 그 이름 · 누를 칸 없음   U10 이어 열기 · 다시 열 실제 화면 없음 — onSee(세션, null)
//  U11 ③ 앱 화면을 보다 새로고침 — 돌아갈 주소가 «보는 중» 주소(see=app)   W 페이지 예외 없음 · 기록이 실제로 쓰였다
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(이 변경 전 origin/main 에서 U1~U11 이 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 앱빌더 만들기 화면 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
//  만들기 화면 + 카드 글(같은 자로 기록을 짓는다) + 새로고침 복귀 표시 — 한 묶음으로.
const ENTRY = "export * from './v2/app-studio.ts'; export { cardText } from './lib/studio-flow.ts'; export { markReviewOpen, reviewResumeTarget } from './v2/review-resume.ts';";
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=St", "--platform=browser", "--loader=ts", "--sourcefile=studio-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: ENTRY, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

const CARD = { name: "회의록", who: "회의에 들어가는 사람", items: "날짜 · 내용", can: ["정리", "찾기"], not: "", first: "날짜별 목록", ref: "", notify: "" };
const FETCH = `<script>window.__prompts = []; window.__ver = 2;
window.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u), method = (init && init.method) || "GET";
  const p = url.replace(/^.*?(\\/api\\/)/, "/api/");
  const j = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
  if (/\\/prompt$/.test(p) && method === "POST") { let t = ""; try { t = JSON.parse(init.body).text || ""; } catch (_) {} window.__prompts.push(t.slice(0, 60)); return j({ ok: true }); }
  if (p.includes("/transcript")) return new Response("", { status: 200, headers: { "X-Log-To": "5" } });
  if (p.startsWith("/api/ui/apps/notes/versions")) { const n = window.__ver; return j({ versions: Array.from({ length: n }, (_, i) => ({ version_no: i + 1, is_current: i + 1 === n, note: i ? "고침" : "초안", saved_at: "2026-10-19T00:00:00Z" })) }); }
  if (/^\\/api\\/ui\\/apps\\/notes(\\?|$)/.test(p)) return j({ app: { id: "notes", title: "회의록", visibility: "me", published_version_no: 0, manifest: { studio: { card: ${JSON.stringify(CARD)} } } } });
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
  const host = document.getElementById("host");
  const $ = (s) => host.querySelector(s), $$ = (s) => [...host.querySelectorAll(s)];
  localStorage.setItem("lively_v2_app_studio_seen", JSON.stringify({ intro: 1, coach: { plan: 1, draft: 1, check: 1, put: 1 } }));
  const card = window.__CARD;
  const CT = St.cardText(card);
  //  ③ 을 보던 기록 — 첫 판 · 고침 한 번(지금 2번째 버전) · ④ 까지 와 봤고 그때 2번째 버전으로 대조했다.
  const rec = { sid: "box-s1", pid: 0, what: "회의록을 날짜별로 정리", place: "both", appId: "notes", known: [], at: Date.now(), stage: "fix", card, round: 1, from: 5, mode: "new",
    title: "회의록", named: true, reached: 3, cardSent: CT, check: { have: ["정리", "찾기"], missing: [], ver: 2, card: CT } };
  localStorage.setItem("lively_v2_app_studio", JSON.stringify([rec]));
  const recNow = () => (JSON.parse(localStorage.getItem("lively_v2_app_studio") || "[]").find((r) => r.sid === "box-s1") || {});
  const seen = []; let closed = 0;
  const opts = { host, onClose: () => { closed++; }, onSee: (sid, v) => { seen.push([sid, v]); } };
  const bar = () => $$(".v2-studio-bar > *").map((n) => (n.tagName === "BUTTON" ? (n.classList.contains("ahead") ? "ahead" : "back") : n.classList.contains("on") ? "on" : n.classList.contains("done") ? "done" : "todo"));
  const tab = async (i) => { const n = $$(".v2-studio-bar > *")[i]; if (n && n.tagName === "BUTTON") n.click(); await sleep(900); return !!n && n.tagName === "BUTTON"; };
  const nowBtns = () => $$(".v2-studio-now button").map(txt);
  const sent = () => window.__prompts.length;

  St.openAppStudio({ sid: "box-s1" }, opts);
  await sleep(1500);
  const top = $(".v2-studio-top");
  R.u1 = { crumb: top && top.querySelector(".v2-studio-crumb") ? top.querySelector(".v2-studio-crumb").tagName : null, name: txt(top && top.querySelector(".v2-studio-name")), top: txt(top) };
  R.u2 = bar();
  R.u10 = seen.slice();
  // U3 — ④ 다시 가기(같은 버전)
  let p0 = sent();
  R.u3 = { clicked: await tab(3), chks: !!$(".v2-studio-chks"), sent: sent() - p0, first: txt($(".v2-studio-chk")) };
  // U4 — 새 버전이 된 뒤(③ 으로 돌아가면 버전을 다시 읽는다) ④
  window.__ver = 3;
  await tab(2);
  p0 = sent();
  R.u4 = { clicked: await tab(3), sent: sent() - p0, what: window.__prompts.slice(-1)[0] || "" };
  // U5 — ① 돌아가기
  R.u5 = { clicked: await tab(0), h2: txt($(".v2-studio-start h2")), now: nowBtns(), bottom: $$(".v2-studio-ai-row button").map(txt), go: $(".v2-studio-go") ? $(".v2-studio-go").disabled : null, bar: bar() };
  // U6 — ① 에서 설명을 고친다 → 다시 기획이 눌린다 · 기록에 남는다 · ③ 에 다녀와도 그대로
  const ta = $(".v2-studio-what");
  if (ta) { ta.value = "회의록을 날짜별로 정리하고 검색"; ta.dispatchEvent(new Event("input", { bubbles: true })); }
  R.u6 = { go: $(".v2-studio-go") ? $(".v2-studio-go").disabled : null, kept: (recNow().whatEdit || {}).what || null };
  R.u6.toThree = await tab(2);
  R.u6.hub = !!$(".v2-studio-hub");
  await tab(0);
  R.u6.back = $(".v2-studio-what") ? $(".v2-studio-what").value : null;
  // U7 — ② 다시 가기(카드 그대로) · 카드를 고치면 다시 만들기
  R.u7 = { clicked: await tab(1), now: nowBtns(), card: !!$(".v2-studio-card") };
  const v = $(".v2-studio-card .v[contenteditable]");
  if (v) { v.textContent = "회의록 정리"; v.dispatchEvent(new FocusEvent("blur")); await sleep(200); }
  R.u7.after = nowBtns();
  // U8 — 머리줄 「앱빌더」
  const cr = $(".v2-studio-top .v2-studio-crumb");
  if (cr) { cr.click(); await sleep(200); }
  R.u8 = { closed, left: !!$(".v2-studio") };
  // U9 — 새 앱 ①
  St.openAppStudio(null, opts);
  await sleep(600);
  const t9 = () => txt($(".v2-studio-top .v2-studio-name"));
  R.u9 = { before: t9(), bar: bar() };
  const ni = $(".v2-studio-name-field");
  if (ni) { ni.value = "주간 안건"; ni.dispatchEvent(new Event("input", { bubbles: true })); }
  R.u9.after = t9();
  // U11 — ③ 앱 화면을 보다 새로고침
  St.markReviewOpen({ sid: "box-s1", appId: "notes", view: "app", route: "#/i/inst-1" });
  R.u11 = St.reviewResumeTarget("#/i/inst-1");
  R.errors = errors;
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}
const PAGE = `<!doctype html><html data-theme="light" lang="ko"><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css")}
  html,body{margin:0} #host{width:1100px;height:860px;position:relative}
</style>
<div id="host"></div>
<pre id="out">PENDING</pre>
${FETCH}
<script>window.__CARD = ${JSON.stringify(CARD)};</script>
<script>${bundle}</script>
<script>(${PAGE_MAIN.toString()})();</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "studio-nav-", virtualTimeBudget: 60000, args: ["--window-size=1200,900"] });
const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-800)); process.exit(1); }
const R = JSON.parse(m[1]);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "") => (cond ? ok(n) : bad(n, why));
const same = (got, want, n) => { const a = JSON.stringify(got), b = JSON.stringify(want); return a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };

check(R.u1 && R.u1.crumb === "BUTTON" && R.u1.name === "회의록" && !/앱 만들기|앱 만드는 중/.test(R.u1.top || ""), "U1 머리줄 = 「앱빌더 ›」 단추 + 만들고 있는 앱 이름(「앱 만들기」 「앱 만드는 중」 없이)", JSON.stringify(R.u1));
same(R.u2, ["back", "back", "on", "ahead", "todo"], "U2 ③ 에서 단계 바 — 지난 ①② 돌아가기 · 와 본 ④ 다시 가기 · 안 간 ⑤ 는 못 누른다");
same(R.u3 && [R.u3.clicked, R.u3.chks, R.u3.sent], [true, true, 0], "U3 ④ 다시 가기 — 같은 버전 · 같은 카드면 AI 에게 다시 묻지 않는다");
check(R.u3 && /있어요: 정리, 찾기/.test(R.u3.first || ""), "U3 지난 대조 결과가 그대로 선다", R.u3 && R.u3.first);
same(R.u4 && [R.u4.clicked, R.u4.sent], [true, 1], "U4 새 버전이 된 뒤 ④ — 대조를 다시 청한다(1건)");
same(R.u5 && [R.u5.clicked, R.u5.h2, R.u5.now.includes("다음 →"), R.u5.bottom.includes("다음 단계로"), R.u5.go, R.u5.bar], [true, "앱의 이름과 기능을 정해주세요.", true, true, true, ["on", "ahead", "ahead", "ahead", "todo"]],
  "U5 ① 돌아가기 — 「다음 →」 · 아래 「다음 단계로」 · 와 본 ②③④ 다시 가기 · 바꾼 게 없으면 「이 내용으로 다시 기획」 은 안 눌린다");
same(R.u6 && [R.u6.go, R.u6.kept, R.u6.toThree, R.u6.hub, R.u6.back], [false, "회의록을 날짜별로 정리하고 검색", true, true, "회의록을 날짜별로 정리하고 검색"],
  "U6 ① 에서 고치면 「이 내용으로 다시 기획」 이 눌린다 · 고친 것은 기록에 남아 ③ 에 다녀와도 그대로(다시 기획 없이 ③ 으로 간다)");
same(R.u7 && [R.u7.clicked, R.u7.card, R.u7.now.includes("다음 →"), R.u7.now.some((t) => /완료|다시 만들기/.test(t))], [true, true, true, false], "U7 ② 다시 가기 — 카드 그대로면 「다음 →」 만(다시 만들지 않는다)");
check(R.u7 && R.u7.after.includes("바꾼 기획대로 다시 만들기"), "U7 ② 에서 카드를 고치면 「바꾼 기획대로 다시 만들기」", JSON.stringify(R.u7 && R.u7.after));
same(R.u8, { closed: 1, left: false }, "U8 머리줄 「앱빌더」 를 누르면 닫힌다(앱빌더 첫 화면으로 · onClose)");
same(R.u9 && [R.u9.before, R.u9.after, R.u9.bar], ["새 앱", "주간 안건", ["on", "todo", "todo", "todo", "todo"]], "U9 새 앱 ① — 머리줄 「새 앱」 → 치는 이름 그대로 · 누를 칸 없음");
same(R.u10, [["box-s1", null]], "U10 이어 열기 · 다시 열 실제 화면 없음 — 주소의 «보는 중» 표시를 걷는다(onSee(세션, null))");
same(R.u11, "#/builder/s/box-s1?see=app", "U11 ③ 앱 화면을 보다 새로고침 — «보는 중» 주소로 돌아간다(다시 여는 동안 앱빌더 사이드바가 서지 않게)");
same(R.errors, [], "W  페이지 예외 없음");

console.log(`\n#4632 앱빌더 단계 바 · 머리줄: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
