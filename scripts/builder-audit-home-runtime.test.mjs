#!/usr/bin/env node
// 앱빌더 첫 화면 · 지우기 · 사본 · 개발 정보(#4632 원준 2026-10-29 «싹 다 고쳐» — 점검 목록 g1 · 4-11 · 6-1 · 6-2 · 6-5~6-9 · 6-14) — 런타임 회귀 테스트(헤드리스 크롬 · 가짜 서버).
//
// 엣지 표(스크래치패드 forkA-spec.md):
//  H1 (1-1) 내 다 된 앱(넣음)을 「고치기」 로 연 기록 — 「만들던 앱」 에도 서고 「내가 만든 앱」 에도 남는다 · 지우면 discard 0건 · 세션 완전 삭제 1건 · 앱 카드 그대로
//  H2 (1-2) 배포 설정 「앱 지우기」(앱빌더로 만든 앱) — discard 1건 + 그 앱의 앱빌딩 세션 완전 삭제 · 「만들던 앱」 으로 되살아나지 않는다
//  H2b      보통 AI 세션으로 만든 앱 — discard 1건 · 세션은 건드리지 않는다
//  H3 (1-3) 이 브라우저에서 다 마친(⑤) 남의 앱 고치기 세션 — 「만들던 앱」 에 안 선다
//  H3b      기록 없는 «"메모" 앱 고치기» 세션 · 메모에 내 초안 — ③ 으로 선다
//  H3c      기록 없는 «"안건" 앱 고치기» 세션 · 내 초안 없음 — 안 선다
//  H4 (1-4) 이미 내 사본이 있는 앱으로 「사본 뜨기」 — 저장 0건 · «이미 만든 사본» 을 묻는다 · 「새 사본 만들기」 → 다른 id(-2)로 저장
//  H5 (1-5) 세션 목록에 없는 오래된 기록 · 서버에 물으니 있다 — 카드가 서고 기록이 남는다
//  H5b      서버에 물으니 없다(404) — 카드가 안 서고 기록을 걷는다
//  H6 (1-6) 「세션 보기」 — 앱빌더 세션이 만든 앱에만 · 보통 AI 세션으로 만든 앱엔 없다
//  H7 (1-7) 관리자가 아니면 공개한 앱에 「앱 지우기」 가 없다 · 남의 앱엔 「켜 둠」 이 없다 · 내 공개 앱 끄기는 한 번 더 묻는다(첫 번 요청 0건)
//  U2 (6-2) 카드를 고르면 목록이 «불러오는 중» 으로 비지 않고 앱 목록을 다시 받지 않는다
//  U3 (6-5) «윤상민 만듦» · 책임자 없음 «관리자가 맡고 있어요» · 만들던 앱 패널에 앱 id 가 안 보인다
//  U4 (6-6) 나(whoami)를 한 번 못 받으면 묶음을 나누지 않고 «불러오지 못했어요» · 다음 그리기에서 다시 물어 내 앱이 「내가 만든 앱」 에
//  U5 (6-7) 사본 기록이 열려 있으면 «만드는 중»
//  U6 (6-8) 만든 사람이 떠난 빈 예약(관리자가 책임자) — 「만들던 앱」 에 안 선다
//  U7 (6-9) 카드 작은 줄 «공개 V3 · 내 버전 V5» · 쓰는 자리 「둘 다」 는 칩 하나만
//  S1 (4-11) 개발 정보가 쓰는 중에 다시 묻기가 한 번 실패 — 계속 묻는다 · 연달아 다섯 번 실패하면 «확인하지 못했어요» 와 「다시 불러오기」
//  S2 (4-11) 「다시 만들기」 가 간격에 막혔다(retry_after_ms) — «42초 뒤에 다시 눌러 주세요»
//  U1 (6-1) 앱 찾기(#v2-root 밖)의 선 그림 아이콘에 선 색이 있다
//  U8 (6-14) 펼친 묶음의 › 는 칸 가운데(grid)
//  B1 (리뷰) 기록 없는 «"가계부" 앱 고치기» 세션이 이어진 내 앱(원본 없음 · 나만 · 넣기 전) — 사본이 아니라 고치기: 「내가 만든 앱」 에도 서고, 지우면 discard 0건
//  N2 (리뷰) 「앱 지우기」 — 앱빌딩 세션이 셸 목록에서 잘렸어도 지운다(이 브라우저 기록의 세션 · 서버에 물어 앱빌더 이름인 세션)
//  N7 (리뷰) 목록 밖 기록인데 서버가 403 — 지운 것으로 치지 않는다(기록이 남는다)
//  S3 (리뷰) 「다시 만들기」 인데 오늘 몫을 다 씀(limit) — «시작했어요» 가 아니라 그렇다고 알린다
//  W  페이지 예외 없음 · 가짜 서버에 실제로 물었다
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(origin/main 에서 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 앱빌더 첫 화면 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=B", "--platform=browser", "--loader=ts", "--sourcefile=home-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: "export { renderBuilderApp } from './v2/builder.ts'; export { renderAppSpec } from './v2/app-spec-page.ts'; export { studioRecBuildingFor } from './v2/app-studio.ts';", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

const FETCH = `<script>window.__calls = []; window.__gone = new Set(); window.__purged = new Set(); window.__whoFail = 0; window.__alive = new Set(["box-trunc"]); window.__sessGet = { "box-old2": [200, { id: "box-old2", label: '"명함" 앱 제작' }], "box-far": [200, { id: "box-far", label: '"원격" 앱 제작' }], "box-forbid": [403, { error: "볼 수 없어요" }] }; window.__saved = []; window.__spec = []; window.__specPost = null;
window.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u), method = (init && init.method) || "GET";
  const p = url.replace(/^.*?(\\/api\\/)/, "/api/");
  const body = init && init.body ? JSON.parse(init.body) : null;
  window.__calls.push(method + " " + p + (p === "/api/ui/terminal/session-trash" && body ? " " + body.op + " " + body.ids.join(",") : ""));
  const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "X-Log-To": "0" } });
  if (p.startsWith("/api/ui/me/whoami")) { if (window.__whoFail > 0) { window.__whoFail--; return j({ error: "잠깐 안 돼요" }, 503); } return j({ member_id: "wonjoon-jang", display_name: "원준" }); }
  if (p.startsWith("/api/ui/org/members")) return j({ members: [{ id: "wonjoon-jang", display_name: "원준", kind: "human" }, { id: "sangmin-yoon", display_name: "윤상민", kind: "human" }] });
  const dm = /^\\/api\\/ui\\/apps\\/([^/?]+)\\/(discard|remove)$/.exec(p);
  if (dm && method === "POST") { window.__gone.add(dm[1]); return j({ ok: true }); }
  if (/^\\/api\\/ui\\/apps\\/[^/?]+\\/enabled$/.test(p) && method === "POST") return j({ ok: true });
  if (/^\\/api\\/ui\\/apps\\/[^/?]+\\/versions/.test(p)) return j({ versions: [] });
  if (/^\\/api\\/ui\\/apps\\/[^/?]+\\/pull/.test(p)) return j({ files: [{ path: "lively-app.json", content: JSON.stringify({ id: "memo", title: "메모", studio: { place: "both", put: true } }) }, { path: "ui/index.html", content: "<p>메모</p>" }] });
  if (p === "/api/ui/apps/save" && method === "POST") { const mf = (body.files || []).find((f) => f.path === "lively-app.json"); window.__saved.push(mf ? JSON.parse(mf.content).id : "?"); return j({ ok: true }); }
  if (/^\\/api\\/ui\\/apps\\/[^/?]+\\/spec$/.test(p)) {
    if (method === "POST") return j(window.__specPost);
    const next = window.__spec.length > 1 ? window.__spec.shift() : window.__spec[0];
    return next === "x" ? j({ error: "잠깐 안 돼요" }, 502) : j(next);
  }
  if (p.startsWith("/api/ui/terminal/sessions/") && method === "GET") { const sid = decodeURIComponent(p.split("/")[5].split("?")[0]); const g = window.__sessGet[sid]; if (g) return j(g[1], g[0]); return window.__alive.has(sid) ? j({ id: sid, label: "", projectId: 0 }) : j({ error: "세션을 찾을 수 없어요" }, 404); }
  if (/^\\/api\\/ui\\/v6\\/sessions\\/[^/]+\\/purge/.test(p) && method === "POST") return j({ ok: true, log: { bytes: 10 } });
  if (p === "/api/ui/terminal/session-trash" && method === "POST") { body.ids.forEach((id) => window.__purged.add(id)); return j({ ok: true, op: body.op, done: body.ids, skipped: [] }); }
  if (p === "/api/ui/apps" || p.startsWith("/api/ui/apps?")) {
    const app = (id, title, o = {}) => ({ id, title, status: "active", visibility: "me", installed_by: "wonjoon-jang", made_by: "wonjoon-jang", owner_member: "wonjoon-jang", is_owner: true, can_edit: true, current_version_no: 1, manifest: { ui: { pages: [{}] } }, ...o });
    const put = (pl) => ({ ui: { pages: [{}] }, studio: { put: true, ...(pl ? { place: pl } : {}) } });
    const all = [
      app("notes", "회의록", { build_session: "box-edit", manifest: put() }),
      app("memo", "메모", { visibility: "all", made_by: "sangmin-yoon", installed_by: "sangmin-yoon", owner_member: "sangmin-yoon", is_owner: false, published_version_no: 3, current_version_no: 5, draft: { by: "wonjoon-jang", version_no: 5 }, manifest: put("both") }),
      app("agenda", "안건", { visibility: "all", made_by: "sangmin-yoon", installed_by: "sangmin-yoon", owner_member: "sangmin-yoon", is_owner: false, published_version_no: 2, current_version_no: 2 }),
      app("trip", "출장비", { visibility: "all", made_by: "sangmin-yoon", installed_by: "sangmin-yoon", owner_member: "sangmin-yoon", is_owner: false, published_version_no: 4, current_version_no: 4 }),
      app("gen", "일반앱", { build_session: "box-gen", manifest: put() }),
      app("quote", "견적", { build_session: "box-quote", manifest: put() }),
      app("own2", "가계부", { build_session: "box-own2" }),                       // B1 — 나만 · 넣기 전 · 원본 없음
      app("old", "명함", { build_session: "box-old2", manifest: put() }),          // N2 — 세션이 셸 목록 밖 · 이 브라우저 기록에 있다
      app("far", "원격", { build_session: "box-far", manifest: put() }),           // N2 — 세션이 셸 목록 밖 · 기록도 없다(서버에 물어 앱빌더 세션)
      app("week", "주간", { visibility: "all", owner_member: null, published_version_no: 1, manifest: put() }),
      app("rec2", "녹음", { visibility: "all", published_version_no: 12, current_version_no: 13, manifest: put() }),   // U7b — 초안 없음 · 공개 번호가 낡았다(같은 내용 마무리 두 번)
      app("empty1", "새 앱", { empty: true, made_by: "left-user", installed_by: "left-user", owner_member: null, build_session: "box-empty", current_version_no: null }),
      ...(p === "/api/ui/apps" ? [app("memo-wonjoon-jang", "메모 · 원준", { manifest: put("both") })] : []),
    ];
    return j({ apps: all.filter((a) => !window.__gone.has(a.id)) });
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
  const NOW = Date.now();
  const rec = (sid, title, appId, o = {}) => ({ sid, pid: 0, what: title, place: "both", appId, known: [], at: NOW - 1000, stage: "fix", mode: "new", title, named: true, reached: 2, card: null, round: 0, from: 0, ...o });
  localStorage.setItem("lively_v2_app_studio", JSON.stringify([
    rec("box-edit", "회의록", "notes", { mode: "edit", origin: { id: "notes", title: "회의록", by: "wonjoon-jang" } }),   // H1
    rec("box-done", "출장비", "trip", { mode: "edit", done: true, stage: "put" }),                                         // H3
    rec("box-trunc", "오래된 기획", "", { stage: "plan", at: NOW - 60 * 86400_000 }),                                     // H5 (목록 밖 · 서버엔 있다)
    rec("box-gone", "지운 기획", "", { stage: "plan", at: NOW - 60 * 86400_000 }),                                        // H5b (서버에도 없다)
    rec("box-copy", "사본 중", "copyx", { mode: "copy" }),                                                                  // U5
    rec("box-old2", "명함", "old", { done: true, stage: "put", at: NOW - 60 * 86400_000 }),                                // N2
    rec("box-forbid", "못 보는 기획", "", { stage: "plan", at: NOW - 60 * 86400_000 }),                                    // N7
  ]));
  const row = (id, label, i) => ({ id, label, projectId: null, owned: true, lastSeen: NOW - (20 + i) * 1000, logId: "uuid-" + id, logNode: "", raw: { claudeSessionId: "uuid-" + id } });
  const SESS = [row("box-edit", '"회의록" 앱 고치기', 1), row("box-done", '"출장비" 앱 고치기', 2), row("box-memo", '"메모" 앱 고치기', 3), row("box-agenda", '"안건" 앱 고치기', 4),
    row("box-gen", "회의록 정리해 줘", 5), row("box-quote", '"견적" 앱 제작', 6), row("box-copy", '"사본 중" 앱 고치기', 7), row("box-own2", '"가계부" 앱 고치기', 8)];
  const env = { projects: () => [], sessions: () => SESS.filter((s) => !window.__purged.has(s.id)), sessionsReady: () => true, redrawSide: () => {}, setRoute: () => {} };
  const secOf = (re) => [...host.querySelectorAll(".v2-bld-sec")].find((s) => re.test(txt(s.querySelector("h3")) || "")) || null;
  const cardIn = (re, title) => { const s = secOf(re); return s ? [...s.querySelectorAll(".v2-bld-card")].find((c) => txt(c.querySelector(".hd b")) === title) || null : null; };
  const DRAFT = /^만들던 앱/, MINE = /^내가 만든 앱/;
  const writes = (from) => window.__calls.slice(from).filter((c) => !c.startsWith("GET "));
  const btn = (root, re) => [...(root || host).querySelectorAll("button")].find((b) => re.test(txt(b) || "")) || null;
  const panel = () => host.querySelector(".v2-bld-panel");

  // U4 — 첫 그리기에서 나를 못 받는다
  window.__whoFail = 1;
  history.replaceState(null, "", "#/builder");
  B.renderBuilderApp(host, ["builder"], new URLSearchParams(""), env);
  await sleep(900);
  R.u4a = { text: txt(host.querySelector(".v2-bld-list")), team: !!secOf(/^팀원이 만든 앱/), mineNotes: !!cardIn(MINE, "회의록") };
  B.renderBuilderApp(host, ["builder"], new URLSearchParams(""), env);
  await sleep(1200);
  R.u4b = { mineQuote: !!cardIn(MINE, "견적"), whoCalls: window.__calls.filter((c) => c.startsWith("GET /api/ui/me/whoami")).length };

  // H1 · H3 · H3b · H3c · H5 · U5 · U6
  const draftTitles = () => [...(secOf(DRAFT) || host).querySelectorAll(".v2-bld-card .hd b")].map(txt);
  R.drafts = draftTitles();
  R.h1 = { draft: !!cardIn(DRAFT, "회의록"), mine: !!cardIn(MINE, "회의록") };
  R.h5 = { card: !!cardIn(DRAFT, "오래된 기획"), rec: JSON.parse(localStorage.getItem("lively_v2_app_studio") || "[]").some((r) => r.sid === "box-trunc"),
    goneCard: !!cardIn(DRAFT, "지운 기획"), goneRec: JSON.parse(localStorage.getItem("lively_v2_app_studio") || "[]").some((r) => r.sid === "box-gone") };
  R.u5 = B.studioRecBuildingFor("copyx");
  R.b1 = { draft: !!cardIn(DRAFT, "가계부"), mine: !!cardIn(MINE, "가계부") };
  R.n7 = JSON.parse(localStorage.getItem("lively_v2_app_studio") || "[]").some((r) => r.sid === "box-forbid");
  // U7 · U3 — 팀원이 만든 앱을 편다
  const teamBtn = btn(host.querySelector(".v2-bld-top"), /팀원이 만든 앱/);
  if (teamBtn) teamBtn.click();
  await sleep(700);
  const memo = cardIn(/^팀원이 만든 앱/, "메모") || cardIn(DRAFT, "메모");
  const memoTeam = cardIn(/^팀원이 만든 앱/, "메모");
  R.u7 = { small: txt(memoTeam && memoTeam.querySelector(".hd small")), chips: memoTeam ? [...memoTeam.querySelectorAll(".v2-bld-chip")].map(txt) : null };
  R.u3 = { chips: R.u7.chips };
  const rec2 = [...document.querySelectorAll(".v2-bld-card")].find((c) => txt(c.querySelector("b")) === "녹음");
  R.u7b = { small: txt(rec2 && rec2.querySelector(".hd small")) };
  // U2 — 카드를 고르면 깜빡이지 않는다
  let flashed = false;
  const mo = new MutationObserver(() => { if (/불러오는 중/.test(txt(host.querySelector(".v2-bld-list")) || "")) flashed = true; });
  mo.observe(host.querySelector(".v2-bld-list"), { childList: true, subtree: true });
  let mark = window.__calls.length;
  const week = cardIn(MINE, "주간"); if (week) week.querySelector(".hd").click();
  await sleep(700);
  mo.disconnect();
  R.u2 = { flashed, refetch: window.__calls.slice(mark).filter((c) => c.startsWith("GET /api/ui/apps?")).length, on: !!(cardIn(MINE, "주간") && cardIn(MINE, "주간").classList.contains("on")) };
  // H7 — 주간(내 공개 앱 · 관리자 아님)
  const P = panel();
  R.h7 = { del: !!btn(P, /^앱 지우기$/), owner: txt([...P.querySelectorAll(".v2-bld-row")].find((r) => txt(r.querySelector(".k")) === "책임자")) };
  mark = window.__calls.length;
  const togOf = () => [...panel().querySelectorAll(".v2-bld-tog")].find((b) => /켜 둠|한 번 더 누르면 꺼져요/.test(txt(b) || ""));
  if (togOf()) togOf().click();
  await sleep(200);
  R.h7.first = { writes: writes(mark), text: txt(togOf()) };
  if (togOf()) togOf().click();
  await sleep(700);
  R.h7.second = writes(mark);
  // 메모(남의 공개 앱) — 켜 둠 없음 · 지우기 없음
  const memoCard = cardIn(/^팀원이 만든 앱/, "메모"); if (memoCard) memoCard.querySelector(".hd").click();
  await sleep(700);
  R.h7.memo = { head: txt(panel().querySelector("h3")), rows: [...panel().querySelectorAll(".v2-bld-row .k")].map(txt), tog: [...panel().querySelectorAll(".v2-bld-tog")].map(txt).filter((t) => /켜 둠|꺼 둠/.test(t)).length, del: !!btn(panel(), /^앱 지우기$/), by: txt([...panel().querySelectorAll(".v2-bld-row")].find((r) => /만든 사람/.test(txt(r.querySelector(".k")) || ""))) };
  // H6 — 세션 보기
  const sessBtn = async (title) => { const c = cardIn(MINE, title); if (c) c.querySelector(".hd").click(); await sleep(600); return !!btn(panel(), /^세션 보기$/); };
  R.h6 = { quote: await sessBtn("견적"), gen: await sessBtn("일반앱") };
  // H2b — 일반앱 지우기(보통 세션)
  const delApp = async (title) => {
    const c = cardIn(MINE, title); if (c) c.querySelector(".hd").click(); await sleep(600);
    const from = window.__calls.length;
    const d = btn(panel(), /^앱 지우기$/); if (d) d.click(); await sleep(150);
    const d2 = btn(panel(), /한 번 더 누르면 지워져요/); if (d2) d2.click(); await sleep(1200);
    return writes(from);
  };
  R.h2b = await delApp("일반앱");
  R.h2 = { writes: await delApp("견적") };
  R.n2 = { old: await delApp("명함"), far: await delApp("원격") };
  B.renderBuilderApp(host, ["builder"], new URLSearchParams(""), env);
  await sleep(1000);
  R.h2.resurrected = draftTitles().includes("견적");
  // H1 — 회의록(고치던 것) 지우기 · 앱은 남는다
  mark = window.__calls.length;
  const delDraft = () => { const c = cardIn(DRAFT, "회의록"); return c ? [...c.querySelectorAll("button")].find((b) => /^지우기$|한 번 더 누르면/.test(txt(b))) : null; };
  if (delDraft()) delDraft().click(); await sleep(150);
  if (delDraft()) delDraft().click(); await sleep(1200);
  R.h1.writes = writes(mark); R.h1.after = { draft: !!cardIn(DRAFT, "회의록"), mine: !!cardIn(MINE, "회의록") };
  // B1 — 가계부(기록 없는 고치기 세션) 지우기 · 앱은 남는다
  mark = window.__calls.length;
  const delB1 = () => { const c = cardIn(DRAFT, "가계부"); return c ? [...c.querySelectorAll("button")].find((b) => /^지우기$|한 번 더 누르면/.test(txt(b))) : null; };
  if (delB1()) delB1().click(); await sleep(150);
  if (delB1()) delB1().click(); await sleep(1200);
  R.b1.writes = writes(mark); R.b1.after = !!cardIn(MINE, "가계부");
  // H4 — 사본이 이미 있다
  mark = window.__calls.length;
  history.replaceState(null, "", "#/builder/app/memo?how=copy");
  B.renderBuilderApp(host, ["builder", "app", "memo"], new URLSearchParams("how=copy"), env);
  await sleep(1200);
  R.h4 = { ask: txt(host.querySelector(".v2-studio-ask b")), saved: window.__saved.slice() };
  const nb = btn(host, /^새 사본 만들기$/); if (nb) nb.click();
  await sleep(1500);
  R.h4.after = window.__saved.slice();

  // S1 — 개발 정보 쓰는 중 · 다시 묻기 실패
  const spec = (state, extra = {}) => ({ app_id: "notes", title: "회의록", version_no: 3, view: "installed", facts: { calls: [], tables: [], pages: [], perms: [], files: [], server: null, instructions: false }, spec_state: state, spec_error: state === "failed" ? "시간이 다 됐어요" : null, spec: null, ...extra });
  const sh = document.getElementById("spec");
  window.__spec = [spec("writing"), "x", spec("writing"), "x", "x", "x", "x", "x"];
  let specFrom = window.__calls.length;
  B.renderAppSpec(sh, "notes", () => {});
  await sleep(6000 * 3 + 500);
  R.s1 = { polls: window.__calls.slice(specFrom).filter((c) => c.startsWith("GET /api/ui/apps/notes/spec")).length, reload: !!btn(sh, /^다시 불러오기$/) };
  await sleep(6000 * 6);
  R.s1.after = { polls: window.__calls.slice(specFrom).filter((c) => c.startsWith("GET /api/ui/apps/notes/spec")).length, reload: !!btn(sh, /^다시 불러오기$/), line: txt(sh.querySelector(".v2-spec-state")) };
  // S2 — 다시 만들기가 간격에 막혔다
  const sh2 = document.getElementById("spec2");
  window.__spec = [spec("failed")];
  window.__specPost = spec("failed", { retry_after_ms: 42000 });
  const toastLog = [];
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => toastLog.push(txt(n))))).observe(document.getElementById("toasts"), { childList: true });
  B.renderAppSpec(sh2, "notes", () => {});
  await sleep(600);
  const rb = btn(sh2, /^다시 만들기$/); if (rb) rb.click();
  await sleep(600);
  R.s2 = { hadBtn: !!rb, toast: toastLog.join(" | ") };
  // S3 — 오늘 몫을 다 씀
  const sh3 = document.getElementById("spec3");
  window.__specPost = spec("limit");
  toastLog.length = 0;
  B.renderAppSpec(sh3, "notes", () => {});
  await sleep(600);
  const rb3 = btn(sh3, /^다시 만들기$/); if (rb3) rb3.click();
  await sleep(600);
  R.s3 = { hadBtn: !!rb3, toast: toastLog.join(" | ") };

  // U1 · U8 — CSS
  const ic = document.querySelector("#padt svg");
  R.u1 = ic ? getComputedStyle(ic).stroke : null;
  const car = document.querySelector("#kspt .v2-car");
  R.u8 = car ? getComputedStyle(car).display : null;
  R.calls = window.__calls.length;
  R.errors = errors;
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}
const PAGE = `<!doctype html><html data-theme="light" lang="ko"><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css", "47-v2-rail.css")}
  html,body{margin:0} #host{width:1100px;height:860px;position:relative} #spec,#spec2,#spec3{width:900px;height:600px;position:relative}
</style>
<div id="host"></div><div id="spec"></div><div id="spec2"></div><div id="spec3"></div>
<div class="v2-pad" id="padt" style="position:static"><button class="v2-pad-item v2-pad-item--new"><span class="v2-pad-ico v2-pad-ico--new"><svg viewBox="0 0 24 24" class="v2-ic"><path d="M12 5v14M5 12h14"/></svg></span></button></div>
<section class="v2-ksp open" id="kspt"><div class="v2-ksp-h"><button class="v2-ksp-t" type="button"><span class="v2-car">›</span><span class="n">만들던 앱</span></button></div></section>
<div id="toasts"></div>
<pre id="out">PENDING</pre>
${FETCH}
<script>${bundle}</script>
<script>(${PAGE_MAIN.toString()})().catch((e) => { document.getElementById("out").textContent = "RESULT" + JSON.stringify({ crash: String((e && e.stack) || e).slice(0, 900) }) + "ENDRESULT"; });</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "bld-home-", virtualTimeBudget: 120000, args: ["--window-size=1200,900"] });
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
const PURGE = (sid) => ["POST /api/ui/terminal/session-trash purge " + sid + ",uuid-" + sid, "POST /api/ui/v6/sessions/uuid-" + sid + "/purge?node="];

check(R.u4a && /불러오지 못했어요/.test(R.u4a.text || "") && !R.u4a.team && !R.u4a.mineNotes, "U4 나를 못 받으면 묶음을 나누지 않고 «불러오지 못했어요»", R.u4a);
check(R.u4b && R.u4b.mineQuote && R.u4b.whoCalls >= 2, "U4 다음 그리기에서 다시 물어 내 앱이 「내가 만든 앱」 에", R.u4b);
same(R.h1 && [R.h1.draft, R.h1.mine], [true, true], "H1 「고치기」 로 연 내 앱 — 「만들던 앱」 에도 서고 「내가 만든 앱」 에도 남는다");
same(R.h1 && [R.h1.writes, R.h1.after], [PURGE("box-edit"), { draft: false, mine: true }], "H1 지우면 앱은 두고(discard 0건) 고치던 세션만 완전 삭제 · 앱 카드 그대로");
check(R.drafts && !R.drafts.includes("출장비"), "H3 이 브라우저에서 다 마친 고치기 세션은 「만들던 앱」 에 안 선다", R.drafts);
check(R.drafts && R.drafts.includes("메모") && !R.drafts.includes("안건"), "H3b · H3c 기록 없는 고치기 세션 — 내 초안이 있는 앱(메모)만 선다", R.drafts);
same(R.h5, { card: true, rec: true, goneCard: false, goneRec: false }, "H5 · H5b 목록 밖 기록은 서버에 물어 — 있으면 카드 · 기록 그대로, 없으면 걷는다");
same(R.u5, true, "U5 사본 기록이 열려 있으면 «만드는 중»");
check(R.drafts && !R.drafts.includes("새 앱"), "U6 만든 사람이 떠난 빈 예약은 「만들던 앱」 에 안 선다", R.drafts);
check(R.u7 && R.u7.small && /^공개 V3 · 내 버전 V5/.test(R.u7.small) && !/둘 다/.test(R.u7.small) && R.u7.chips.filter((c) => c === "둘 다").length === 1, "U7 카드 작은 줄 «공개 V3 · 내 버전 V5» · 쓰는 자리는 칩 하나만", R.u7);
check(R.u7b && /^V13/.test(R.u7b.small || ""), "U7b 초안이 없으면 카드는 지금 판 번호(배포 설정 「지금 쓰는 버전」 과 같은 번호)", R.u7b);
check(R.u3 && R.u3.chips && R.u3.chips.includes("윤상민 만듦") && !R.u3.chips.some((c) => /sangmin-yoon/.test(c)), "U3 카드에 계정 아이디 대신 표시 이름", R.u3);
same(R.u2, { flashed: false, refetch: 0, on: true }, "U2 카드를 고르면 목록이 비지 않고 앱 목록을 다시 받지 않는다");
check(R.h7 && !R.h7.del && /관리자가 맡고 있어요/.test(R.h7.owner || ""), "H7 · U3 관리자가 아니면 공개 앱에 「앱 지우기」 없음 · 책임자 없음 «관리자가 맡고 있어요»", R.h7);
check(R.h7 && R.h7.first && R.h7.first.writes.length === 0 && /한 번 더 누르면 꺼져요/.test(R.h7.first.text || "") && R.h7.second.includes("POST /api/ui/apps/week/enabled"), "H7 내 공개 앱 끄기는 한 번 더 묻고 두 번째에 끈다", R.h7);
check(R.h7 && R.h7.memo && R.h7.memo.tog === 0 && !R.h7.memo.del && /윤상민/.test(R.h7.memo.by || "") && !/sangmin-yoon/.test(R.h7.memo.by || ""), "H7 · U3 남의 앱엔 「켜 둠」 · 「앱 지우기」 가 없다 · 만든 사람은 표시 이름", R.h7 && R.h7.memo);
same(R.h6, { quote: true, gen: false }, "H6 「세션 보기」 는 앱빌더 세션이 만든 앱에만");
same(R.h2b, ["POST /api/ui/apps/gen/discard"], "H2b 보통 AI 세션으로 만든 앱을 지우면 세션은 건드리지 않는다");
same(R.h2 && [R.h2.writes, R.h2.resurrected], [["POST /api/ui/apps/quote/discard", ...PURGE("box-quote")], false], "H2 「앱 지우기」 는 그 앱의 앱빌딩 세션도 완전 삭제 · 「만들던 앱」 으로 되살아나지 않는다");
check(R.h4 && /이미 만든 사본/.test(R.h4.ask || "") && R.h4.saved.length === 0 && JSON.stringify(R.h4.after) === JSON.stringify(["memo-wonjoon-jang-2"]), "H4 이미 사본이 있으면 덮지 않고 묻는다 · 「새 사본 만들기」 는 다른 id 로", R.h4);
check(R.s1 && R.s1.polls >= 3 && !R.s1.reload, "S1 쓰는 중에 다시 묻기가 한 번 실패해도 계속 묻는다", R.s1);
check(R.s1 && R.s1.after.reload && /확인하지 못했어요/.test(R.s1.after.line || ""), "S1 연달아 다섯 번 실패하면 멈추고 「다시 불러오기」", R.s1 && R.s1.after);
check(R.s2 && R.s2.hadBtn && /42초 뒤에 다시 눌러 주세요/.test(R.s2.toast) && !/다시 쓰기 시작했어요/.test(R.s2.toast), "S2 다시 만들기가 간격에 막히면 언제 다시 누를지 알린다", R.s2);
same(R.b1 && [R.b1.draft, R.b1.mine], [true, true], "B1 기록 없는 고치기 세션이 이어진 내 앱(원본 없음)은 고치기 — 「내가 만든 앱」 에도 선다");
same(R.b1 && [R.b1.writes, R.b1.after], [PURGE("box-own2"), true], "B1 지우면 discard 0건 · 고치던 세션만 완전 삭제 · 앱 그대로");
same(R.n2, { old: ["POST /api/ui/apps/old/discard", "POST /api/ui/terminal/session-trash purge box-old2"], far: ["POST /api/ui/apps/far/discard", "POST /api/ui/terminal/session-trash purge box-far"] },
  "N2 앱빌딩 세션이 셸 목록에서 잘렸어도 「앱 지우기」 가 지운다(기록의 세션 · 서버에 물어 앱빌더 이름인 세션)");
same(R.n7, true, "N7 서버가 403 이면 지운 것으로 치지 않아 기록이 남는다");
check(R.s3 && R.s3.hadBtn && /횟수를 다 썼어요/.test(R.s3.toast) && !/시작했어요/.test(R.s3.toast), "S3 오늘 몫을 다 쓰면 «시작했어요» 가 아니라 그렇다고 알린다", R.s3);
check(R.u1 && R.u1 !== "none", "U1 앱 찾기의 선 그림 아이콘에 선 색이 있다", R.u1);
check(R.u8 === "grid" || R.u8 === "inline-grid", "U8 펼친 묶음의 › 는 칸 가운데(grid)", R.u8);
same([R.calls > 10, R.errors], [true, []], "W  가짜 서버에 실제로 물었다 · 페이지 예외 없음");

console.log(`\n#4632 앱빌더 첫 화면 점검: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
