#!/usr/bin/env node
// 앱 「개발 정보」(#4632) — 런타임 회귀 테스트(헤드리스 크롬 · 가짜 서버).
//
// 원준 2026-10-26 «앱 빌더에서 만들어진 앱의 코드를 SSOT로 해서 코드 내용을 자연어로 번역해준 시트 … 앱 빌더 들어가서 내가 만든 앱 같은거에 (i) 같은거나,
//  개발 정보? 뭐 이런 느낌이 드는 버튼 … 다른 세션을 시켜서 바꿔도 자동으로 그 페이지의 명세가 바뀌도록».
//  화면은 GET /api/ui/apps/:id/spec(capabilities/apps.ts app_spec)의 두 층을 그린다 — AI 설명(doc)과 코드에서 바로 읽은 것(facts).
//
// 엣지 표(스크래치패드 spec-app-spec.md · 화면):
//  U1 내가 만든 앱 · 팀원이 만든 앱 카드에 「개발 정보」 — 누르면 #/builder/spec/<앱> · 목록은 숨고 개발 정보가 선다 · 그 앱의 spec 을 묻는다
//  U2 ok — 요약 · 바깥 서비스 카드 · 표는 코드의 칸 목록에 설명의 뜻을 붙인다(설명에만 있는 표 · 칸은 안 보인다) · 호출 자리 «파일 줄» · 다시 묻지 않는다
//  U3 writing — 도는 표시 · 6초마다 다시 묻다가 ok 가 오면 멈춘다
//  U4 stale — 예전 버전 설명을 «초안 기준» 으로 보이며 «V3 코드로 다시 쓰는 중»
//  U5 failed — 까닭 + 「다시 만들기」 → POST {regenerate:true} 한 번
//  U6 unavailable(키 없음) — API 키 안내 · 코드에서 읽은 것은 그대로 · 다시 묻지 않는다
//  U7 「‹ 앱빌더」 — #/builder?sel=<앱> 목록으로 · 떠난 뒤엔 다시 묻지 않는다(쓰는 중이던 앱이어도)
//  U8 오른쪽 배포 설정에 「개발 정보 보기」 — 누르면 같은 화면
//  U9 볼 수 없는 앱(404) — 찾을 수 없다고 말한다
//  U5b 실패인데 앞 버전 설명이 보이면 그 버전을 말하고 «달라진 점» 은 감춘다(격리 리뷰) · U4 도 감춘다
//  U10 오늘 몫을 다 씀(limit) — 말하고 다시 묻지 않는다
//  U11 만들던 앱도 첫 버전이 있으면 카드에 「개발 정보」(원준 2026-10-27 «개발 정보 페이지 이건 어디있는걸까?» — 회의록은 아직 만들던 앱) · 첫 버전 전(빈 예약)엔 없다
//  U12 만들던 앱의 개발 정보에서 「‹ 앱빌더」 — 그 만들던 앱 카드가 골라지고 오른쪽에 「개발 정보 보기」
//  W  페이지 예외 없음
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(개발 정보가 없던 origin/main 에서 U1~U9 가 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 앱 개발 정보 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=B", "--platform=browser", "--loader=ts", "--sourcefile=spec-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: "export { renderBuilderApp } from './v2/builder.ts';", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

//  가짜 서버 — 요청을 window.__calls 에 적는다. spec 답은 window.__spec[앱](n = 그 앱에 몇 번째 묻는지) 가 정한다.
const FETCH = `<script>window.__calls = [];
const FACTS = {
  pages: [{ key: "main", title: "회의록", entry: "ui/index.html", places: ["세션 옆", "앱 화면"] }],
  tables: [{ name: "meetings", columns: [{ name: "title", type: "text" }, { name: "run_id", type: "int" }] }],
  perms: [{ key: "ai_runs", label: "AI 실행(워크스페이스 AI 계정)" }],
  calls: [{ kind: "lively", name: "/_lively/ai/runs", label: "AI 실행 요청과 결과 받기", count: 7, where: [{ file: "ui/index.html", line: 363 }, { file: "ui/index.html", line: 364 }] }],
  files: [{ path: "lively-app.json", size: 3145, text: true }, { path: "ui/index.html", size: 69666, text: true }],
  server: null, instructions: true,
};
const DOC = {
  summary: "회의 음성을 올리면 받아쓰고 정리해요.",
  screens: [{ name: "회의 목록", where: "세션 옆", what: "회의를 찾아요" }],
  data: [{ name: "meetings", what: "회의 한 건", fields: [{ name: "title", what: "회의 제목" }, { name: "ghost_col", what: "없는 칸" }] }, { name: "ghost_table", what: "코드에 없는 표", fields: [] }],
  features: [{ name: "받아쓰기", steps: ["파일을 올려요", "AI가 받아써요"], code: "ui/index.html startTranscribe" }],
  external: [{ what: "음성 받아쓰기", how: "POST /_lively/ai/runs agent:true", data: "음성 조각이 나가고 전사문이 돌아와요", code: "ui/index.html aiRun" }],
  permissions: [{ name: "AI 실행", why: "받아쓰기와 정리" }], limits: ["앱 화면이 열려 있어야 진행을 봐요"], changes: ["정리 형식 고르기가 생겼어요"],
};
const res = (st, o = {}) => ({ app_id: o.id || "notes", title: o.title || "회의록", version_no: o.v ?? 3, view: "installed", facts: FACTS, spec_state: st, spec_error: o.err || null,
  spec: o.doc === false ? null : { version_no: o.docV ?? 3, made_at: "2026-10-26T07:00:00Z", model: "claude-sonnet-5-5", doc: DOC } });
window.__spec = {
  notes: () => res("ok"),
  poll: (n) => (n < 3 ? res("writing", { id: "poll", title: "쓰는 중 앱", doc: false }) : res("ok", { id: "poll", title: "쓰는 중 앱" })),
  stale: () => res("stale", { id: "stale", title: "예전 설명 앱", docV: 1 }),
  fail: (n, post) => (post ? res("writing", { id: "fail", title: "실패 앱", doc: false }) : res("failed", { id: "fail", title: "실패 앱", doc: false, err: "AI 답을 읽지 못했어요" })),
  nokey: () => res("unavailable", { id: "nokey", title: "키 없음 앱", doc: false }),
  left: () => res("writing", { id: "left", title: "떠날 앱", doc: false }),
  limit: () => res("limit", { id: "limit", title: "몫 다 쓴 앱", doc: false }),
  failold: () => res("failed", { id: "failold", title: "실패했지만 앞 설명 있는 앱", docV: 2, err: "시간 안에 끝나지 않았어요" }),
  draft1: () => res("ok", { id: "draft1", title: "만드는 중 회의록", v: 2, docV: 2 }),
};
const seen = {};
window.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u), method = (init && init.method) || "GET";
  const p = url.replace(/^.*?(\\/api\\/)/, "/api/");
  window.__calls.push(method + " " + p + (init && init.body && method !== "GET" ? " " + init.body : ""));
  const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  const m = /^\\/api\\/ui\\/apps\\/([^/?]+)\\/spec$/.exec(p);
  if (m) {
    const f = window.__spec[decodeURIComponent(m[1])];
    if (!f) return j({ error: "앱 없음" }, 404);
    seen[m[1]] = (seen[m[1]] || 0) + 1;
    return j(f(seen[m[1]], method === "POST"));
  }
  if (p.startsWith("/api/ui/me/whoami")) return j({ member_id: "wonjoon-jang", display_name: "원준" });
  if (p.startsWith("/api/ui/apps?")) {
    const app = (id, title, by) => ({ id, title, status: "active", visibility: "all", installed_by: by, owner_member: by, is_owner: by === "wonjoon-jang", can_edit: by === "wonjoon-jang", current_version_no: 3, manifest: { ui: { pages: [{}] } } });
    //  만들던 앱 둘 — 첫 버전이 있는 것(나만 · 만들기 세션 «"…" 앱 제작») · 아직 첫 버전 전의 빈 예약
    const building = (id, title, sid, empty) => ({ ...app(id, title, "wonjoon-jang"), visibility: "me", made_by: "wonjoon-jang", build_session: sid, empty, current_version_no: empty ? 0 : 2 });
    return j({ apps: [app("notes", "회의록", "wonjoon-jang"), app("team1", "팀 채널", "sangmin-yoon"),
      building("draft1", "만드는 중 회의록", "box-w-d1", false), building("resv1", "빈 예약 앱", "box-w-r1", true)] });
  }
  return j({});
};</script>`;

async function PAGE_MAIN() {
  const R = {}; const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => errors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (n) => (n ? n.textContent.replace(/\s+/g, " ").trim() : null);
  const host = document.getElementById("host");
  const SESS = [{ id: "box-w-d1", label: '"만드는 중 회의록" 앱 제작', projectId: null }, { id: "box-w-r1", label: '"빈 예약 앱" 앱 제작', projectId: null }];
  const env = { projects: () => [], sessions: () => SESS, redrawSide: () => {}, setRoute: () => {} };
  history.replaceState(null, "", "#/builder");
  B.renderBuilderApp(host, ["builder"], new URLSearchParams(""), env);
  await sleep(800);
  const specGets = (id) => window.__calls.filter((c) => c === "GET /api/ui/apps/" + id + "/spec").length;
  const specRoot = () => [...host.querySelectorAll(".v2-spec")].find((x) => x.offsetParent !== null) || null;
  const go = async (h, ms = 600) => { location.hash = h; await sleep(ms); };
  const secOf = (title) => [...(specRoot() || host).querySelectorAll(".v2-spec-sec")].find((s) => (txt(s.querySelector("h2")) || "").startsWith(title)) || null;

  // U1 카드의 「개발 정보」
  const cardOf = (title) => [...host.querySelectorAll(".v2-bld-card")].find((c) => txt(c.querySelector(".hd b")) === title) || null;
  const infoBtn = (title) => { const c = cardOf(title); return c ? [...c.querySelectorAll("button")].find((b) => txt(b) === "개발 정보") || null : null; };
  const teamToggle = [...host.querySelectorAll(".v2-bld-top button")].find((b) => /팀원이 만든 앱/.test(txt(b) || ""));
  if (teamToggle) { teamToggle.click(); await sleep(500); }
  R.u1 = { mine: !!infoBtn("회의록"), team: !!infoBtn("팀 채널") };
  if (infoBtn("회의록")) { infoBtn("회의록").click(); await sleep(700); }
  R.u1.hash = location.hash; R.u1.listHidden = !host.querySelector(".v2-bld-list") || host.querySelector(".v2-bld-list").offsetParent === null;
  R.u1.page = !!specRoot(); R.u1.title = txt(specRoot() && specRoot().querySelector(".v2-spec-top h1")); R.u1.gets = specGets("notes");
  R.u1.head = txt(specRoot() && specRoot().querySelector(".v2-spec-top"));

  // U2 ok
  const ext = secOf("바깥 서비스와 API");
  const dataSec = secOf("저장하는 정보");
  const callSec = secOf("찾은 호출");
  R.u2 = {
    state: txt(specRoot() && specRoot().querySelector(".v2-spec-state")),
    summary: txt(secOf("한눈에") && secOf("한눈에").querySelector(".v2-spec-lead")),
    changes: secOf("이번 버전에서 달라진 점") ? [...secOf("이번 버전에서 달라진 점").querySelectorAll("li")].map(txt) : null,
    ext: txt(ext && ext.querySelector(".v2-spec-card b")),
    tableNames: dataSec ? [...dataSec.querySelectorAll(".v2-spec-card > b")].map(txt) : null,
    cols: dataSec ? [...dataSec.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map(txt)) : null,
    where: txt(callSec && callSec.querySelector("td.w")),
    spinner: !!(specRoot() && specRoot().querySelector(".v2-spec-spin")),
  };
  await sleep(13000);
  R.u2.getsAfter = specGets("notes");

  // U3 쓰는 중 → 다시 묻다가 ok 에서 멈춤
  await go("#/builder/spec/poll", 500);
  R.u3 = { spinner: !!(specRoot() && specRoot().querySelector(".v2-spec-spin")), state: txt(specRoot() && specRoot().querySelector(".v2-spec-state")), gets0: specGets("poll") };
  await sleep(13500);
  R.u3.gets1 = specGets("poll"); R.u3.summary = txt(secOf("한눈에") && secOf("한눈에").querySelector(".v2-spec-lead"));
  await sleep(13000);
  R.u3.gets2 = specGets("poll");

  // U4 예전 판 설명
  await go("#/builder/spec/stale");
  R.u4 = { state: txt(specRoot() && specRoot().querySelector(".v2-spec-state")), summary: txt(secOf("한눈에") && secOf("한눈에").querySelector(".v2-spec-lead")) };

  R.u4.changes = !!secOf("이번 버전에서 달라진 점");

  // U5 실패 → 다시 만들기
  await go("#/builder/spec/fail");
  const again = specRoot() && [...specRoot().querySelectorAll(".v2-spec-top button")].find((b) => txt(b) === "다시 만들기");
  R.u5 = { state: txt(specRoot() && specRoot().querySelector(".v2-spec-state")), again: !!again };
  if (again) { again.click(); await sleep(600); }
  R.u5.posts = window.__calls.filter((c) => c.startsWith("POST /api/ui/apps/fail/spec"));
  R.u5.after = txt(specRoot() && specRoot().querySelector(".v2-spec-state"));

  // U5b 실패인데 앞 버전 설명이 보일 때 — 그 버전을 말한다 · 달라진 점은 감춘다
  await go("#/builder/spec/failold");
  R.u5b = { state: txt(specRoot() && specRoot().querySelector(".v2-spec-state")), changes: !!secOf("이번 버전에서 달라진 점"), summary: !!(secOf("한눈에") && secOf("한눈에").querySelector(".v2-spec-lead")) };

  // U10 오늘 몫을 다 씀 — 말하고 다시 묻지 않는다
  await go("#/builder/spec/limit");
  R.u10 = { state: txt(specRoot() && specRoot().querySelector(".v2-spec-state")), spin: !!(specRoot() && specRoot().querySelector(".v2-spec-spin")), gets0: specGets("limit") };
  await sleep(13000);
  R.u10.gets1 = specGets("limit");

  // U6 키 없음
  await go("#/builder/spec/nokey");
  R.u6 = { state: txt(specRoot() && specRoot().querySelector(".v2-spec-state")), calls: !!(secOf("찾은 호출") && secOf("찾은 호출").querySelector("tbody tr")), files: secOf("파일") ? secOf("파일").querySelectorAll("li").length : 0, gets0: specGets("nokey") };
  await sleep(13000);
  R.u6.gets1 = specGets("nokey");

  // U7 뒤로 — 쓰는 중이던 앱을 떠나면 다시 묻지 않는다
  await go("#/builder/spec/left");
  const backBtn = specRoot() && [...specRoot().querySelectorAll(".v2-spec-top button")].find((b) => /앱빌더/.test(txt(b) || ""));
  R.u7 = { back: !!backBtn, gets0: specGets("left") };
  if (backBtn) { backBtn.click(); await sleep(800); }
  R.u7.hash = location.hash; R.u7.list = !!host.querySelector(".v2-bld-list") && host.querySelector(".v2-bld-list").offsetParent !== null; R.u7.page = !!specRoot();
  await sleep(13000);
  R.u7.gets1 = specGets("left");

  // U8 오른쪽 배포 설정의 「개발 정보 보기」
  await go("#/builder?sel=notes", 900);
  const panelBtn = [...host.querySelectorAll(".v2-bld-panel button")].find((b) => txt(b) === "개발 정보 보기");
  R.u8 = { has: !!panelBtn };
  if (panelBtn) { panelBtn.click(); await sleep(700); }
  R.u8.hash = location.hash; R.u8.page = !!specRoot();

  // U11 만들던 앱 카드
  await go("#/builder", 900);
  const draftSec = [...host.querySelectorAll(".v2-bld-sec")].find((x) => (txt(x.querySelector("h3")) || "").startsWith("만들던 앱")) || null;
  const inSec = (sec, title) => sec ? [...sec.querySelectorAll(".v2-bld-card")].find((c) => txt(c.querySelector(".hd b")) === title) || null : null;
  const btnIn = (c, t) => c ? [...c.querySelectorAll("button")].find((b) => txt(b) === t) || null : null;
  R.u11 = { d: !!inSec(draftSec, "만드는 중 회의록"), r: !!inSec(draftSec, "빈 예약 앱"), dBtn: !!btnIn(inSec(draftSec, "만드는 중 회의록"), "개발 정보"), rBtn: !!btnIn(inSec(draftSec, "빈 예약 앱"), "개발 정보") };
  if (R.u11.dBtn) { btnIn(inSec(draftSec, "만드는 중 회의록"), "개발 정보").click(); await sleep(700); }
  R.u11.hash = location.hash; R.u11.page = !!specRoot(); R.u11.gets = specGets("draft1");
  // U12 돌아오기
  const back2 = specRoot() && [...specRoot().querySelectorAll(".v2-spec-top button")].find((b) => /앱빌더/.test(txt(b) || ""));
  if (back2) { back2.click(); await sleep(900); }
  const onCard = host.querySelector(".v2-bld-card.on");
  R.u12 = { back: !!back2, hash: decodeURIComponent(location.hash), on: txt(onCard && onCard.querySelector(".hd b")), panel: txt(host.querySelector(".v2-bld-panel h3")),
    panelBtn: !![...host.querySelectorAll(".v2-bld-panel button")].find((b) => txt(b) === "개발 정보 보기") };

  // U9 404
  await go("#/builder/spec/nope");
  R.u9 = txt(specRoot() && specRoot().querySelector(".v2-spec-body"));

  R.errors = errors;
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}
const PAGE = `<!doctype html><html data-theme="light" lang="ko"><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css")}
  html,body{margin:0} #host{width:1100px;height:860px;position:relative}
</style>
<div id="host"></div>
<div id="toasts"></div>
<pre id="out">PENDING</pre>
${FETCH}
<script>${bundle}</script>
<script>(${PAGE_MAIN.toString()})().catch((e) => { document.getElementById("out").textContent = "RESULT" + JSON.stringify({ crash: String((e && e.stack) || e).slice(0, 900) }) + "ENDRESULT"; });</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "app-spec-", virtualTimeBudget: 200000, args: ["--window-size=1200,900"] });
const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-800)); process.exit(1); }
const R = JSON.parse(m[1]);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));
if (R.crash) { console.error("FAIL  페이지가 도중에 넘어졌다 — " + R.crash); process.exit(1); }

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why) => (cond ? ok(n) : bad(n, JSON.stringify(why)));
const same = (got, want, n) => { const a = JSON.stringify(got), b = JSON.stringify(want); return a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };

same(R.u1 && [R.u1.mine, R.u1.team, R.u1.hash, R.u1.listHidden, R.u1.page, R.u1.title, R.u1.gets], [true, true, "#/builder/spec/notes", true, true, "「회의록」 개발 정보", 1],
  "U1 내 앱 · 팀원 앱 카드에 「개발 정보」 · 누르면 #/builder/spec/<앱> 화면이 서고 그 앱의 명세를 묻는다");
same(R.u2 && [R.u2.summary, R.u2.changes, R.u2.ext, R.u2.tableNames, R.u2.cols, R.u2.where, R.u2.spinner],
  ["회의 음성을 올리면 받아쓰고 정리해요.", ["정리 형식 고르기가 생겼어요"], "음성 받아쓰기", ["meetings"], [["title", "text", "회의 제목"], ["run_id", "int", ""]], "ui/index.html 363, 364줄 외 5곳", false],
  "U2 ok — 요약 · 달라진 점 · 바깥 서비스 · 표는 코드 칸에 설명의 뜻(설명에만 있는 표 · 칸 없음) · 호출 자리");
check(R.u1 && R.u1.head === "‹ 앱빌더「회의록」 개발 정보", "U1 머리줄엔 돌아가기와 이름만(빈 자리가 글로 새지 않는다)", R.u1 && R.u1.head);
check(R.u2 && /V3 코드 기준/.test(R.u2.state || "") && R.u2.getsAfter === 1, "U2 ok 면 «V3 코드 기준» 이라 말하고 다시 묻지 않는다", R.u2 && [R.u2.state, R.u2.getsAfter]);
check(R.u3 && R.u3.spinner && /쓰는 중/.test(R.u3.state || "") && R.u3.gets0 === 1 && R.u3.gets1 >= 3 && R.u3.summary === "회의 음성을 올리면 받아쓰고 정리해요." && R.u3.gets2 === R.u3.gets1,
  "U3 쓰는 중 — 도는 표시 · 다시 묻다가 ok 가 오면 설명을 그리고 멈춘다", R.u3);
check(R.u4 && /초안 기준 설명/.test(R.u4.state || "") && /V3 코드로 다시 쓰는 중/.test(R.u4.state || "") && R.u4.summary === "회의 음성을 올리면 받아쓰고 정리해요.", "U4 예전 버전 설명을 그 버전 기준이라고 보이며 다시 쓰는 중", R.u4);
check(R.u4 && R.u4.changes === false, "U4 앞 버전 설명이면 «이번 버전에서 달라진 점» 을 감춘다", R.u4);
check(R.u5b && /V2 기준이에요/.test(R.u5b.state || "") && /시간 안에 끝나지 않았어요/.test(R.u5b.state || "") && R.u5b.summary && !R.u5b.changes, "U5b 실패 + 앞 버전 설명 — 그 버전을 말하고 달라진 점은 감춘다", R.u5b);
check(R.u10 && /횟수를 다 썼어요/.test(R.u10.state || "") && !R.u10.spin && R.u10.gets0 === 1 && R.u10.gets1 === 1, "U10 오늘 몫을 다 씀 — 말하고 다시 묻지 않는다", R.u10);
check(R.u5 && R.u5.again && /AI 답을 읽지 못했어요/.test(R.u5.state || "") && JSON.stringify(R.u5.posts) === JSON.stringify(['POST /api/ui/apps/fail/spec {"regenerate":true}']) && /쓰는 중/.test(R.u5.after || ""),
  "U5 실패 — 까닭 + 「다시 만들기」 → regenerate 한 번 → 쓰는 중", R.u5);
check(R.u6 && /API 키/.test(R.u6.state || "") && R.u6.calls && R.u6.files === 2 && R.u6.gets0 === 1 && R.u6.gets1 === 1, "U6 키 없음 — 안내 · 코드에서 읽은 것은 그대로 · 다시 묻지 않는다", R.u6);
check(R.u7 && R.u7.back && R.u7.hash === "#/builder?sel=left" && R.u7.list && !R.u7.page && R.u7.gets1 === R.u7.gets0, "U7 「‹ 앱빌더」 — 그 앱을 고른 목록으로 · 떠나면 다시 묻지 않는다", R.u7);
same(R.u8 && [R.u8.has, R.u8.hash, R.u8.page], [true, "#/builder/spec/notes", true], "U8 오른쪽 배포 설정의 「개발 정보 보기」");
check(/찾을 수 없어요/.test(R.u9 || ""), "U9 볼 수 없는 앱은 찾을 수 없다고 말한다", R.u9);
same(R.u11 && [R.u11.d, R.u11.r, R.u11.dBtn, R.u11.rBtn, R.u11.hash, R.u11.page, R.u11.gets], [true, true, true, false, "#/builder/spec/draft1", true, 1],
  "U11 만들던 앱도 첫 버전이 있으면 카드에 「개발 정보」 · 빈 예약엔 없다");
same(R.u12 && [R.u12.back, R.u12.hash, R.u12.on, R.u12.panel, R.u12.panelBtn], [true, "#/builder?sel=draft:box-w-d1", "만드는 중 회의록", "만들던 앱 「만드는 중 회의록」", true],
  "U12 만들던 앱의 개발 정보에서 돌아오면 그 만들던 앱 카드 · 오른쪽에 「개발 정보 보기」");
same(R.errors, [], "W  페이지 예외 없음");

console.log(`\n#4632 앱 개발 정보: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
