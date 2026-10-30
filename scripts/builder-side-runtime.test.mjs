#!/usr/bin/env node
// 「앱빌더」 사이드바(#4632) — 앱빌더가 활성이면 사이드바가 앱빌더의 것인가 · 무엇이 서고 무엇이 켜지나 · 다른 화면에선 아닌가 — 런타임 회귀 테스트.
//
// 원준 2026-10-17 «앱 빌더의 사이드바도 기획해줘 … 사이드바 내용까지가 하나의 앱이야. 한 앱을 실행했는데 다른 앱의 사이드바가 계속 떠있거나,
//  홈의 사이드바가 떠있는 경우는 없어야한다». 종전엔 앱빌더에 제 사이드바가 없어 직전 구역(대개 홈)의 목록이 그대로 남았다.
//  규칙(누가 사이드바를 갖나)은 side-owner.test.mjs, 주소 · 켜질 줄 · 짧은 단계는 builder-flow.test.mjs 가 잰다. 여기선 셸 문서에서만 보이는 것을 잰다.
//
// 엣지 표(스크래치패드 spec-side-owner.md D):
//  D1 앱빌더 활성 — data-sec=builder · 머리 「앱빌더」 · 고정 줄 「새 앱 만들기」 「모든 앱」 · 홈 목록 · 홈 발치 도크 없음 · 발치에 「앱 찾기」
//  D2 받기 전(세션 목록) — 「불러오는 중…」 · 「모든 앱」 에 수 없음
//  D3 받은 뒤 — 만들던 앱(세션 이름 꼴 · 서버의 만드는 중 · 빈 예약) · 내가 만든 앱 · 팀원이 만든 앱 · 수 = 줄 수 · 남이 만들던 앱 · 시험 세션 · 위탁 · 기본 앱 · 지운 앱은 안 선다
//  D4 줄 — 만들던 앱 → #/builder/s/<세션> · 짧은 단계 · 앱 → #/builder?sel=<앱> · 꺼짐 · 나만
//  D5 켜진 줄 — 주소를 따라 하나만
//  D6 팀원 카드 — 기본 접힘 · 그 안의 앱이 켜지면 펴진다 · 머리를 누르면 펴진다
//  D7 다른 화면(리브) — 앱빌더 사이드바가 아니다
//  D8 셸이 주인을 «구역» 이라 하면(폰 탭 바로 연 목록) — 앱빌더 화면이어도 구역 목록
//  D9 앱 목록을 못 받았다(받아 둔 것 없음) — «아직 만든 앱이 없어요» 라고 거짓말하지 않고 못 받았다고 말한다 · 다음 그리기에서 다시 받아 선다
//  W  페이지 예외 없음 · 앱 목록 · 나 요청이 실제로 나갔다
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(앱빌더 사이드바가 없던 origin/main 에서 D1~D6 이 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 앱빌더 사이드바 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const pack = (entry, name) => execFileSync(ESBUILD, [path.join(WEB, entry), "--bundle", "--format=iife", "--global-name=" + name, "--platform=browser",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

async function PAGE_MAIN() {
  const R = {};
  const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => errors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const host = document.getElementById("host");
  const side = document.querySelector(".v2-side");
  const $ = (s, r = host) => r.querySelector(s);
  const $$ = (s, r = host) => [...r.querySelectorAll(s)];
  const txt = (n) => (n ? n.textContent.replace(/\s+/g, " ").trim() : null);

  const NOW = Date.now();
  const data = {
    projects: [{ id: 10, name: "앱빌더" }, { id: 11, name: "결제" }],
    sessions: [
      { id: "box-b1", label: '"회의록 정리" 앱 제작', projectId: 10, owned: true, lastSeen: NOW - 1000 },     // 내 만들던 앱 — 아직 앱 없음(②)
      { id: "box-b2", label: '"노트" 앱 제작', projectId: 10, owned: true, lastSeen: NOW - 5000 },            // 서버가 아는 만드는 중인 앱(③)의 세션
      { id: "box-o1", label: '"남의 앱" 앱 제작', projectId: 10, owned: false, lastSeen: NOW },               // 남이 만들던 앱 — 안 선다
      { id: "box-t1", label: '"노트" 앱 시험', projectId: 10, owned: true, lastSeen: NOW },                   // 시험 세션 — 안 선다
      { id: "box-w1", label: '"위탁" 앱 제작', projectId: 10, owned: true, task: { id: 1 }, lastSeen: NOW },  // 위탁 워커 — 안 선다
      { id: "box-n1", label: "결제 백오프", projectId: 11, owned: true, lastSeen: NOW },                      // 보통 세션 — 안 선다
    ],
    lists: [], folders: [], loadedAt: 0,
  };
  let active = "builder";
  let owner = null;
  const hooks = { section: () => "home", instances: () => [], navHost: () => null, railHidden: () => false };
  const draw = async () => { Side.drawSide(host, data, () => active, owner ? { ...hooks, owner: () => owner } : hooks); await sleep(40); };
  const fixed = () => $$(".v2-kviews .v2-kview").map((a) => ({ n: txt($(".n", a)), cnt: txt($(".v2-cnt", a)), on: a.classList.contains("on"), href: a.getAttribute("href") }));
  const cards = () => $$(".v2-ksp").map((c) => ({ name: txt($(".v2-ksp-t .n", c)), n: txt($(".v2-ksp-h > .v2-cnt", c)), open: c.classList.contains("open"),
    rows: $$(".v2-kcat", c).map((l) => [txt($(".n", l)), txt($(".v2-cnt", l)) || "", l.getAttribute("href"), l.classList.contains("on")]) }));
  const onN = () => $$(".v2-kview.on, .v2-kcat.on").length;
  const onWhat = () => $$(".v2-kview.on, .v2-kcat.on").map((a) => txt($(".n", a)));
  const at = async (hash) => { history.replaceState(null, "", "#" + hash.replace(/^#/, "")); await draw(); return { on: onWhat(), n: onN(), cards: cards() }; };

  // ── D2 — 세션 목록을 받기 전 ──
  history.replaceState(null, "", "#/builder");
  await draw();
  R.d2 = { sec: side.getAttribute("data-sec"), empty: txt($(".v2-empty")), fixed: fixed(), cards: cards().length };
  // ── D1 · D3 · D4 — 받은 뒤 ──
  data.loadedAt = NOW;
  await draw(); await sleep(120); await draw();
  R.d1 = {
    sec: side.getAttribute("data-sec"), head: txt($(".v2-app-space-head .v2-k")),
    spaces: $$(".v2-app-space").map((s) => s.getAttribute("aria-label")),
    fixed: fixed(), dock: !!$(".v2-app-dock"), foot: $$(".v2-app-foot .v2-foot-link").map((b) => txt($(".n", b))),
  };
  R.d3 = cards();
  // ── D5 · D6 — 켜진 줄 ──
  R.d5 = {
    list: await at("/builder"), neu: await at("/builder/new"), resume: await at("/builder/s/box-b2"), sel: await at("/builder?sel=memo-w"),
    copy: await at("/builder/app/meeting?how=copy"), draftSel: await at("/builder?sel=draft%3Abox-b1"),
  };
  R.d6a = await at("/builder?sel=agenda");
  await at("/builder");
  R.d6b = cards().find((c) => c.name === "팀원이 만든 앱");
  const teamBtn = $$(".v2-ksp").find((c) => txt($(".v2-ksp-t .n", c)) === "팀원이 만든 앱");
  if (teamBtn) { $(".v2-ksp-t", teamBtn).click(); await sleep(40); }
  R.d6c = cards().find((c) => c.name === "팀원이 만든 앱");
  // ── D7 — 다른 화면 ──
  active = "liv"; await draw();
  R.d7 = { sec: side.getAttribute("data-sec"), bld: !!$('.v2-app-space[aria-label="앱빌더"]') };
  // ── D8 — 셸이 «구역» 이라 한다(폰 탭 바로 연 목록) ──
  active = "builder"; owner = "section"; await draw();
  R.d8 = { sec: side.getAttribute("data-sec"), bld: !!$('.v2-app-space[aria-label="앱빌더"]') };

  R.errors = errors;
  R.calls = window.__calls.slice();
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}

const ME = "wonjoon-jang";
const APPS = [
  { id: "memo-w", title: "메모 · 원준", status: "active", enabled: true, installed_at: "2026-10-10T00:00:00Z", manifest: { ui: { pages: [{ key: "home" }] } }, visibility: "me", made_by: ME, owner_member: ME, can_edit: true },
  { id: "meeting", title: "회의록", status: "active", enabled: false, installed_at: "2026-10-11T00:00:00Z", manifest: {}, visibility: "all", made_by: ME, can_edit: true },
  { id: "agenda", title: "주간 안건", status: "active", enabled: true, installed_at: "2026-10-09T00:00:00Z", manifest: {}, visibility: "all", made_by: "sangmin-yoon" },
  //  서버가 아는 만드는 중인 앱 — 나만 · 첫 판 있음 · 넣기 전 · 그 만들기 세션이 «"노트" 앱 제작»
  { id: "notes", title: "노트", status: "active", enabled: true, installed_at: "2026-10-12T00:00:00Z", manifest: { studio: { put: false } }, visibility: "me", made_by: ME, owner_member: ME, is_owner: true, build_session: "box-b2" },
  //  빈 예약(첫 판 전) — 만들던 앱 ②
  { id: "rsv", title: "예약된 앱", status: "active", empty: true, manifest: {}, visibility: "me", made_by: ME, owner_member: ME, is_owner: true, build_session: "box-rsv" },
  { id: "builtin-x", title: "기본 앱", status: "active", source: { kind: "builtin" }, manifest: {}, visibility: "all" },
  { id: "gone", title: "지운 앱", status: "removed", manifest: {}, made_by: ME },
];
const FETCH = `<script>window.__calls = [];
window.fetch = async (u) => {
  const url = String(u && u.url ? u.url : u); window.__calls.push(url.replace(/^.*?(\\/api\\/)/, "/api/"));
  const j = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.includes("/api/ui/apps?include_empty=1")) return j({ apps: ${JSON.stringify(APPS)} });
  if (url.includes("/api/ui/me/whoami")) return j({ member_id: "${ME}", display_name: "원준" });
  return j({});
};</script>`;
const PAGE = `<!doctype html><html data-theme="light" lang="ko"><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css", "47-v2-rail.css", "49-v2-ctx.css")}
  html,body{margin:0} #v2-root{display:block} .v2-side{width:316px;height:800px}
</style>
<div id="v2-root"><nav class="v2-side stu-side" id="v2-side"><div class="stu-panel"><div class="stu-panel-tree" id="host"></div></div></nav></div>
<pre id="out">PENDING</pre>
${FETCH}
<script>${pack("v2/side.ts", "Side")}</script>
<script>(${PAGE_MAIN.toString()})();</script>`;

//  D9 — 앱 목록 요청이 처음엔 실패하고(500) 그다음엔 된다. 받아 둔 것이 없는 새 페이지여야 한다(모듈의 받아 둔 것은 페이지 수명).
async function PAGE_FAIL() {
  const R = {}; const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => errors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const host = document.getElementById("host");
  const txt = (n) => (n ? n.textContent.replace(/\s+/g, " ").trim() : null);
  const data = { projects: [], sessions: [], lists: [], folders: [], loadedAt: Date.now() };
  const hooks = { section: () => "home", instances: () => [], navHost: () => null, railHidden: () => false };
  history.replaceState(null, "", "#/builder");
  const draw = async () => { Side.drawSide(host, data, () => "builder", hooks); await sleep(80); };
  await draw(); await sleep(80);
  R.fail = { empty: txt(host.querySelector(".v2-empty")), cards: host.querySelectorAll(".v2-ksp").length, all: txt(host.querySelector(".v2-kview:nth-child(2) .v2-cnt")) };
  window.__failApps = false;
  await draw(); await sleep(80); await draw();
  R.back = { empty: txt(host.querySelector(".v2-empty")), cards: [...host.querySelectorAll(".v2-ksp .v2-ksp-t .n")].map(txt) };
  R.errors = errors; R.calls = window.__calls.filter((u) => u.startsWith("/api/ui/apps")).length;
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}
const PAGE2 = PAGE.replace("window.__calls = [];", "window.__calls = []; window.__failApps = true;")
  .replace('if (url.includes("/api/ui/apps?include_empty=1")) return', 'if (url.includes("/api/ui/apps?include_empty=1") && window.__failApps) return new Response("{}", { status: 500, headers: { "Content-Type": "application/json" } });\n  if (url.includes("/api/ui/apps?include_empty=1")) return')
  .replace(`(${PAGE_MAIN.toString()})();`, `(${PAGE_FAIL.toString()})();`);

const grab = async (html, prefix) => {
  const dom = await dumpDom(chrome, { html, prefix, virtualTimeBudget: 30000, args: ["--window-size=1400,900"] });
  const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-800)); process.exit(1); }
  return JSON.parse(m[1]);
};
const R = await grab(PAGE, "builder-side-");
const R2 = await grab(PAGE2, "builder-side-fail-");
if (process.env.DEBUG) console.log(JSON.stringify(R2, null, 1));
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "") => (cond ? ok(n) : bad(n, why));
const same = (got, want, n) => { const a = JSON.stringify(got), b = JSON.stringify(want); return a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };

// ── D2 ──
same(R.d2 && [R.d2.sec, R.d2.empty, R.d2.cards], ["builder", "불러오는 중…", 0], "D2 세션 목록을 받기 전엔 «불러오는 중» — 카드도 «없어요» 도 없다");
same(R.d2 && R.d2.fixed.map((f) => [f.n, f.cnt]), [["새 앱 만들기", null], ["모든 앱", null]], "D2 그동안 「모든 앱」 에 수를 붙이지 않는다");
// ── D1 ──
same(R.d1 && [R.d1.sec, R.d1.head, R.d1.spaces], ["builder", "앱빌더", ["앱빌더"]], "D1 앱빌더가 활성이면 사이드바는 앱빌더의 것(홈 목록이 아니다)");
same(R.d1 && R.d1.fixed.map((f) => [f.n, f.href]), [["새 앱 만들기", "#/builder/new"], ["모든 앱", "#/builder"]], "D1 고정 줄 둘 — 새 앱 만들기 · 모든 앱");
same(R.d1 && [R.d1.dock, R.d1.foot], [false, ["앱 찾기"]], "D1 발치는 앱빌더의 것만 — 홈의 도크(지난 세션 · 휴지통 · 외부 앱 연결) 없이 「앱 찾기」");
// ── D3 · D4 ──
const card = (name) => (R.d3 || []).find((c) => c.name === name);
same((R.d3 || []).map((c) => [c.name, c.n, c.open]), [["만들던 앱", "3", true], ["내가 만든 앱", "2", true], ["팀원이 만든 앱", "1", false]], "D3 카드 셋 — 수 = 줄 수 · 팀원이 만든 앱은 접힌 채");
same(card("만들던 앱") && card("만들던 앱").rows.map((r) => r.slice(0, 3)),
  [["회의록 정리", "② 기획", "#/builder/s/box-b1"], ["노트", "③ 시안", "#/builder/s/box-b2"], ["예약된 앱", "② 기획", "#/builder/s/box-rsv"]],
  "D3 · D4 만들던 앱 — 내 앱빌딩 세션 · 서버의 만드는 중인 앱 · 빈 예약(최근 것 먼저) · 짧은 단계 · 누르면 이어서 만들기. 남이 만들던 앱 · 시험 세션 · 위탁 · 보통 세션은 없다");
same(card("내가 만든 앱") && card("내가 만든 앱").rows.map((r) => r.slice(0, 3)),
  [["메모 · 원준", "나만", "#/builder?sel=memo-w"], ["회의록", "꺼짐", "#/builder?sel=meeting"]],
  "D3 · D4 내가 만든 앱 — 만드는 중인 앱(노트) · 기본 앱 · 지운 앱은 없다 · 나만 보는 앱 「나만」 · 꺼진 앱 「꺼짐」 · 누르면 그 앱의 배포 설정");
same(R.d1 && (R.d1.fixed.find((f) => f.n === "모든 앱") || {}).cnt, "6", "D3 「모든 앱」 = 가운데 목록에 서는 서로 다른 앱 수(만들던 앱 3 + 내가 만든 앱 2 + 팀원이 만든 앱 1 · 감사 6-9)");
// ── D5 ──
const D5 = R.d5 || {};
same([D5.list && D5.list.on, D5.neu && D5.neu.on, D5.resume && D5.resume.on, D5.sel && D5.sel.on, D5.copy && D5.copy.on, D5.draftSel && D5.draftSel.on],
  [["모든 앱"], ["새 앱 만들기"], ["노트"], ["메모 · 원준"], ["회의록"], ["회의록 정리"]],
  "D5 켜진 줄은 주소를 따라 하나 — 목록 · 새 앱 · 이어 만드는 그 앱 · 고른 앱 · 사본을 뜨는 그 앱 · 고른 만들던 앱");
// ── D6 ──
const team6a = R.d6a && R.d6a.cards.find((c) => c.name === "팀원이 만든 앱");
same(team6a && [team6a.open, team6a.rows.map((r) => [r[0], r[2], r[3]])], [true, [["주간 안건", "#/builder?sel=agenda", true]]], "D6 팀원이 만든 앱을 고르면 그 카드가 펴지고 그 줄이 켜진다");
same(R.d6b && [R.d6b.open, R.d6b.rows.length], [false, 0], "D6 고른 것이 없으면 다시 접힌 채(기본)");
same(R.d6c && [R.d6c.open, R.d6c.rows.map((r) => r[0])], [true, ["주간 안건"]], "D6 머리를 누르면 펴진다");
// ── D7 · D8 ──
check(!!R.d7 && R.d7.sec !== "builder" && !R.d7.bld, "D7 다른 화면(리브)이 활성이면 앱빌더 사이드바가 아니다", JSON.stringify(R.d7));
same(R.d8, { sec: "home", bld: false }, "D8 셸이 주인을 «구역» 이라 하면(폰 탭 바로 연 목록) 앱빌더 화면이어도 그 구역의 목록");
// ── D9 ──
same(R2.fail && [R2.fail.empty, R2.fail.cards, R2.fail.all], ["앱 목록을 불러오지 못했어요. 잠시 후 다시 시도해주세요.", 0, null], "D9 앱 목록을 못 받으면 못 받았다고 말한다(«없어요» 카드 · 수를 세우지 않는다)");
same(R2.back && R2.back.cards, ["만들던 앱", "내가 만든 앱", "팀원이 만든 앱"], "D9 실패를 받아 둔 것으로 삼지 않는다 — 다음 그리기에서 다시 받아 카드가 선다");
check(!!R2.back && R2.calls >= 2, "D9 배선 — 앱 목록 요청이 두 번 나갔다(실패 · 다시)", String(R2.calls));
// ── W ──
same(R.errors, [], "W 페이지 예외 없음");
same(R2.errors, [], "W 페이지 예외 없음(실패 장면)");
check((R.calls || []).some((u) => u.startsWith("/api/ui/apps?include_empty=1")) && (R.calls || []).some((u) => u.startsWith("/api/ui/me/whoami")),
  "W 배선 — 앱 목록 · 나 요청이 실제로 나갔다", JSON.stringify(R.calls));
check((R.calls || []).filter((u) => u.startsWith("/api/ui/apps?include_empty=1")).length <= 2, "W 그릴 때마다 다시 받지 않는다(30초 안에는 받아 둔 것)", JSON.stringify(R.calls));

console.log(`\n#4632 앱빌더 사이드바(셸 · 런타임): ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
