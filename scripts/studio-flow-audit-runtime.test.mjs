#!/usr/bin/env node
// 앱빌더 ①②④⑤ 흐름 점검(#4632 · 원준 2026-10-29 «다 봤는데 그냥 싹 다 고쳐») — 런타임 회귀 테스트(헤드리스 크롬 · 가짜 서버).
//  점검 목록(shared/project/4632/앱빌더_점검목록.html)의 g2(④⑤ 넣기 · 공개 · 버전) · g4(② 두 번 보내기 · 기다림) · 6-10 · 6-11 · 6-13 · 6-15 를 화면에서 잰다.
//  순수 규칙(verPlan · systemNote · plainNote · parseNotify · draftAsked · planBrief)은 app-studio-flow.test.mjs P · N · T · D · B 가 잰다.
//
// 엣지 표(스크래치패드 spec-forkC-flow.md):
//  A1 2-1 ④ 에서 이름 · 공개 범위를 바꾸고 「다음 →」 — 저장 1 · 공개 1 · ⑤        A2 2-1/2-7 아무것도 안 바꾸고 「다음 →」 — 저장 0 · 공개 0 · ⑤
//  A3 2-3 고치는 중 머리줄 되돌리기 잠김                                          A4 2-3 고치는 중 «되돌림» 사건은 끝맺지 않는다 · AI 저장은 끝맺는다 · C2 6-13 띠에 「판」 없음
//  A5 2-4 저장은 되고 공개만 막힘 — «저장했어요. 공개는 못 했어요» · 바꾼 이름   A6 2-4 저장 실패 — «저장하지 못했어요» · ④ 그대로
//  A7 2-5 ⑤ 공개 상태 못 읽음 — «확인하지 못했어요» · 「팀에 알리기」 없음        A8 2-9 알리기는 [[알림]] 답이 와야 굳는다
//  A9 2-11 세션 위젯 앱 「지금 써 보기」 — 닫지 않고 붙이는 길 안내              A11 2-7 마무리 판 위 「되돌리기」 는 그 앞 AI 판으로
//  A12 2-6 서버 빌드를 기다리다 닫으면 뒤늦게 저장 · 공개하지 않는다
//  B1 4-1 ② 「완료」 두 번 — 초안 청함 1건   B2 4-2 카드 고침 기다림 — 편집 · 완료 잠김 · 카드 오면 풀림   B5 4-5 기록 끝 조회 실패 — 자리 그대로
//  B3 4-3 앱 있음 · 카드 없음 — «남아 있는 기획 카드가 없어요» · 「다음 →」     B4 4-4 ② 에 있는데 첫 판 저장 — ② 그대로
//  B6 4-7 「준비하는 중…」 사이 닫음 — 예약 앱 0 · 화면 안 열림   B7 4-8 ① 다시 기획 — 지난 카드 + «바뀐 점만»   B8 4-9 준비 중 ① 칸 잠김
//  B9 4-10 기록 없이 이어 열기 · 초안을 이미 청함 — ② 「완료」 없음            C1 6-11 이름 없이 시작 — 머리줄 「새 앱」   C3 6-10 판 정보 전 ③ 제목 비움
//  R1~R9 격리 리뷰 #1583 후속 — 공개 앱 이름 바꿔 「모두」 넣기도 공개 · 다른 단계에서 온 카드 받기 · 대조 한 번 · 판 읽는 동안 «확인 중» · 카드 고침과 「완료」 한 자물쇠
//        · 나갔다 온 사이 [[알림]] · 기록 끝을 못 읽으면 0 부터 안 읽기 · ⑤ 저장 중 표시 · 시작 길이 던져도 ① 풀기
//  E1 6-15 앱 화면을 못 열면 까닭을 말한다                                      W 페이지 예외 없음 · 가짜 서버가 실제로 불렸다
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(이 변경 전 origin/main 에서 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 앱빌더 흐름 점검 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const ENTRY = "export * from './v2/app-studio.ts'; export { cardText, planBrief, draftBrief, fixBrief } from './lib/studio-flow.ts'; export { startLiveSync } from './v2/live-sync.ts'; export { buildModel } from './v2/builder-model.ts';";
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=St", "--platform=browser", "--loader=ts", "--sourcefile=studio-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: ENTRY, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

const CARD = { name: "회의록", who: "회의에 들어가는 사람", items: "날짜 · 내용", can: ["정리", "찾기"], not: "", first: "날짜별 목록", ref: "", notify: "" };
//  가짜 서버 — 앱마다 상태(window.__A[id])를 둔다. 시험이 칸을 바꿔 실패 · 늦음을 만든다. 부른 것은 window.__calls 에 남는다.
const FETCH = `<script>window.__prompts = []; window.__calls = []; window.__log = []; window.__A = {};
window.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u), method = (init && init.method) || "GET";
  const p = url.replace(/^.*?(\\/api\\/)/, "/api/");
  let body = null; try { body = init && init.body ? JSON.parse(init.body) : null; } catch (_) {}
  window.__calls.push(method + " " + p);
  const j = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: { "Content-Type": "application/json" } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (/\\/prompt$/.test(p) && method === "POST") { window.__prompts.push((body && body.text) || ""); return j({ ok: true }); }
  if (p.includes("/transcript")) {
    if (/tail=1/.test(p) && window.__tailFail) return new Response("x", { status: 500 });
    const m = /from=(\\d+)/.exec(p); const from = m ? Number(m[1]) : window.__log.length;
    return new Response(window.__log.slice(from).join("\\n"), { status: 200, headers: { "X-Log-To": String(window.__log.length) } });
  }
  if (p.startsWith("/api/ui/notify/stream")) return new Response(new ReadableStream({ start(c) { window.__sse = (o) => c.enqueue(new TextEncoder().encode("data: " + JSON.stringify(o) + "\\n\\n")); } }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  const am = /^\\/api\\/ui\\/apps\\/([^/?]+)(\\/[a-z-]+)?/.exec(p);
  if (am && am[1] !== "save" && am[1] !== "build-start") {
    const a = window.__A[am[1]]; const sub = am[2] || "";
    if (!a) return j({ error: "없음" }, 404);
    if (sub === "/versions") { if (a.verDelay) await sleep(a.verDelay); return j({ versions: a.versions.map((v, i) => ({ version_no: v[0], note: v[1], is_current: v[0] === a.cur, saved_at: "2026-10-29T00:00:00Z" })) }); }
    if (sub === "/pull") return j({ files: [{ path: "lively-app.json", content: JSON.stringify(a.manifest) }] });
    if (sub === "/server") return j({ server_declared: !!a.server, installed: { deployed_to_cur: !a.server }, deploying: !!a.server });
    if (sub === "/server/deploy" || (sub === "/server" && method === "POST")) return j({ ok: true });
    if (sub === "/visibility" && method === "POST") {
      if (a.pubFail) return j({ error: "3판을 나만 보는 앱으로 저장했습니다 — 공개는 하지 못했습니다: 기존 데이터가 새 표 규칙에 맞지 않아요" }, 409);
      a.vis = "all"; a.draft = false; a.pubNo = a.cur; return j({ version_no: a.cur });
    }
    if (!sub) { if (a.getFail) return j({ error: "잠시 오류" }, 500); return j({ app: { id: am[1], title: a.manifest.title, visibility: a.vis, published_version_no: a.pubNo || 0, draft: a.draft ? { by: "wonjoon-jang" } : null, can_publish: true, can_unpublish: true, empty: !!a.empty, manifest: a.manifest } }); }
    return j({});
  }
  if (p.startsWith("/api/ui/apps/save")) {
    let man = {}; try { man = JSON.parse(body.files.find((f) => f.path === "lively-app.json").content); } catch (_) {}
    const a = window.__A[man.id];
    if (!a || a.saveFail) return j({ error: "저장소가 잠시 응답하지 않아요" }, 500);
    a.versions.push([a.cur + 1, body.note]); a.cur += 1; a.manifest = man; a.saves = (a.saves || 0) + 1;
    if (a.vis === "all") a.draft = true;   // 공개 앱에 저장하면 저장한 사람의 초안(#4667)
    return j({ version_no: a.cur });
  }
  if (p.startsWith("/api/ui/apps/build-start")) { window.__buildStarts = (window.__buildStarts || 0) + 1; return j({ app_id: "res-new" }); }
  if (p.startsWith("/api/ui/apps?session=")) return j({ apps: [] });
  if (p.startsWith("/api/ui/me/whoami")) return j({ member_id: "wonjoon-jang", display_name: "원준" });
  if (p.startsWith("/api/ui/v6/projects?mine=1")) { if (window.__projDelay) await sleep(window.__projDelay); return j({ projects: [{ id: 7, name: "앱빌더", status_category: "active" }] }); }
  if (/^\\/api\\/ui\\/v6\\/projects\\/\\d+\\/sessions$/.test(p) && method === "POST") { window.__spawns = (window.__spawns || 0) + 1; return j({ session: { id: "box-new" + window.__spawns, label: "x" } }); }
  if (p.startsWith("/api/ui/terminal/sessions") && method === "POST") return j({ ok: true });
  if (p.startsWith("/api/ui/app-instances")) { if (window.__instFail) return j({ error: "인스턴스 자리가 꽉 찼어요" }, 500); return j({ instance: { id: "inst-1" } }); }
  //  앱 목록 — 앱 찾기 목록(listSessionApps)을 쓰는 「앱 화면으로 보기」 시험만 채운다(window.__listApps). 다른 때는 빈 목록(새로 생긴 앱 찾기가 잡지 않게).
  if ((p === "/api/ui/apps" || p.startsWith("/api/ui/apps?")) && window.__appsNull) return j({ apps: [null] });   // 이상한 목록 — 시작 길이 던지게(R9)
  if (p === "/api/ui/apps" || p.startsWith("/api/ui/apps?")) return j({ apps: window.__listApps ? Object.keys(window.__A).map((id) => ({ id, title: window.__A[id].manifest.title, status: "active", enabled: true, visibility: "me", manifest: { title: window.__A[id].manifest.title, ui: { pages: [{ key: "main", title: "앱", entry: "ui/index.html" }] } } })) : [] });
  //  세션 한 줄(멈춤 보기) — 시험이 window.__rows[sid] 로 정한다(없으면 빈 목록 = 세션 없음).
  { const om = /sessions\?only=([^&]+)/.exec(p); if (om) { const r = (window.__rows || {})[decodeURIComponent(om[1])]; return j({ sessions: r ? [r] : [] }); } }
  if (p.includes("sessions")) return j({ sessions: [] });
  return j({});
};</script>`;

async function PAGE_MAIN() {
  const R = {}; const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => errors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const toasts = [];
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.textContent) toasts.push(n.textContent.replace(/\s+/g, " ").trim()); }))).observe(document.getElementById("toasts"), { childList: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (n) => (n ? n.textContent.replace(/\s+/g, " ").trim() : null);
  const host = document.getElementById("host");
  const $ = (s) => host.querySelector(s), $$ = (s) => [...host.querySelectorAll(s)];
  const btn = (re, root) => [...(root || host).querySelectorAll("button")].find((b) => re.test(b.textContent || ""));
  localStorage.setItem("lively_v2_app_studio_seen", JSON.stringify({ intro: 1, coach: { plan: 1, draft: 1, check: 1, put: 1 } }));
  localStorage.setItem("lively_v2_ui_token", "t"); localStorage.setItem("lively_ui_token", "t");
  St.startLiveSync(() => {});
  await sleep(300);
  const card = window.__CARD; const CT = St.cardText(card);
  const opts = { host, onClose: () => {} };
  const app = (id, o) => { window.__A[id] = Object.assign({ vis: "me", cur: 2, versions: [[1, "초안"], [2, "고침"]], manifest: { id, title: "회의록", studio: { place: "both", put: true, card } } }, o || {}); return window.__A[id]; };
  const base = (sid, o) => Object.assign({ sid, pid: 0, what: "회의록을 날짜별로 정리", place: "both", appId: "", known: [], at: Date.now() - 600000, stage: "fix", card, round: 1, from: 0, mode: "new",
    title: "회의록", named: true, reached: 3, cardSent: CT }, o || {});
  const open = async (rec, wait = 1500) => { localStorage.setItem("lively_v2_app_studio", JSON.stringify([rec])); St.openAppStudio({ sid: rec.sid }, opts); await sleep(wait); };
  const recOf = (sid) => (JSON.parse(localStorage.getItem("lively_v2_app_studio") || "[]").find((r) => r.sid === sid) || {});
  const onTab = () => $$(".v2-studio-bar > *").findIndex((n) => n.classList.contains("on"));
  const saves = (id) => window.__A[id].saves || 0;
  const pubs = (id) => window.__calls.filter((c) => c === "POST /api/ui/apps/" + id + "/visibility").length;
  const nameTop = () => txt($(".v2-studio-top .v2-studio-name"));
  const t0 = () => toasts.length;

  // ── A1 2-1 — ④ 에서 이름 · 공개 범위를 바꾸고 「다음 →」(⑤ 와 본 앱)
  window.__step = "A1";
  app("a1");
  await open(base("s-a1", { appId: "a1", stage: "check", reached: 4, check: { have: ["정리"], missing: [], ver: 2, card: CT } }));
  const ni = $(".v2-studio-name-in"); if (ni) { ni.value = "회의록 정리"; ni.dispatchEvent(new Event("input", { bubbles: true })); }
  const allB = btn(/워크스페이스 모두/); if (allB) allB.click(); await sleep(200);
  const next1 = btn(/^다음 →$/); R.a1 = { next: !!next1 };
  if (next1) next1.click();
  await sleep(1500);
  R.a1.saves = saves("a1"); R.a1.pubs = pubs("a1"); R.a1.put = !!$(".v2-studio-fin"); R.a1.name = nameTop();

  // ── A2 2-1/2-7 — 아무것도 안 바꾸고 「다음 →」(이미 마무리됨 · 같은 이름 · 같은 자리)
  window.__step = "A2";
  app("a2", { versions: [[1, "초안"], [2, "고침"], [3, "마무리 · 회의록"]], cur: 3 });
  const p2 = window.__prompts.length;
  await open(base("s-a2", { appId: "a2", stage: "check", reached: 4, check: { have: ["정리"], missing: [], ver: 2, card: CT } }));
  const next2 = btn(/^다음 →$/); if (next2) next2.click();
  await sleep(1200);
  R.a2 = { next: !!next2, saves: saves("a2"), pubs: pubs("a2"), put: !!$(".v2-studio-fin"), asked: window.__prompts.length - p2 };

  // ── A11 2-7 — 지금 판이 마무리(3) · 그 아래 AI 판 2 → 되돌리기는 초안(1)으로 · A2 의 ④ 는 대조를 다시 묻지 않았다(내용 판 2 = 지난 대조 판)
  window.__step = "A11";
  await open(base("s-a11", { appId: "a2", stage: "fix" }));
  const undoB = [...host.querySelectorAll(".v2-studio-top button")].find((b) => /되돌리기|이전 버전/.test(b.textContent));
  R.a11 = { undo: txt(undoB), hidden: undoB ? undoB.hidden : null };

  // ── A3 · A4 · C2 2-3 · 6-13 — 고치는 중 머리줄 잠김 · 사람이 한 저장 사건은 끝맺지 않는다
  window.__step = "A3";
  app("a3", { versions: [[1, "초안"], [2, "고침"]], cur: 2 });
  await open(base("s-a3", { appId: "a3", stage: "fix", fixing: { at: Date.now() - 5000, ver: 2 } }));
  const undo3 = [...host.querySelectorAll(".v2-studio-top button")].find((b) => /되돌리기/.test(b.textContent));
  R.a3 = { undo: !!undo3, disabled: undo3 ? undo3.disabled : null };
  window.__A.a3.cur = 1;
  if (window.__sse) window.__sse({ type: "app", app_id: "a3", kind: "updated", note: "되돌림 → 1판" });
  await sleep(800);
  R.a4 = { stillFixing: !!recOf("s-a3").fixing };
  window.__A.a3.versions.push([3, "글자를 키웠어요"]); window.__A.a3.cur = 3;
  if (window.__sse) window.__sse({ type: "app", app_id: "a3", kind: "updated", note: "글자를 키웠어요" });
  await sleep(800);
  R.a4.settled = !recOf("s-a3").fixing; R.a4.undoAfter = undo3 ? undo3.disabled : null;
  //  C2 — 고침이 끝난 뒤 되돌림 사건이 오면 띠는 서버 글(«되돌림 → 2판») 대신 화면 말로
  window.__A.a3.cur = 2;
  if (window.__sse) window.__sse({ type: "app", app_id: "a3", kind: "updated", note: "되돌림 → 2판" });
  await sleep(800);
  R.a4.band = txt($(".v2-studio-band"));

  // ── A5 2-4 — 「모두」 넣기 · 저장은 되고 공개만 409
  window.__step = "A5";
  app("a5", { pubFail: true });
  await open(base("s-a5", { appId: "a5", stage: "check", reached: 3, vis: "all", check: { have: ["정리"], missing: [], ver: 2, card: CT } }));
  const ni5 = $(".v2-studio-name-in"); if (ni5) { ni5.value = "회의 정리"; ni5.dispatchEvent(new Event("input", { bubbles: true })); }
  let k = t0();
  const done5 = btn(/완료 · 다음 단계로/, $(".v2-studio-now")); if (done5) done5.click();
  await sleep(1500);
  R.a5 = { saves: saves("a5"), toasts: toasts.slice(k), name: nameTop(), put: !!$(".v2-studio-fin") };

  // ── A6 2-4 — 저장 자체가 실패
  window.__step = "A6";
  app("a6", { saveFail: true, manifest: { id: "a6", title: "회의록", studio: { place: "both", card } } });
  await open(base("s-a6", { appId: "a6", stage: "check", reached: 3, check: { have: ["정리"], missing: [], ver: 2, card: CT } }));
  k = t0();
  const done6 = btn(/완료 · 다음 단계로/, $(".v2-studio-now")); if (done6) done6.click();
  await sleep(1200);
  R.a6 = { toasts: toasts.slice(k), check: !!$(".v2-studio-chks"), put: !!$(".v2-studio-fin") };

  // ── A7 2-5 — ⑤ 에서 공개 상태를 못 읽음
  window.__step = "A7";
  app("a7", { getFail: true });
  await open(base("s-a7", { appId: "a7", stage: "put", done: true, reached: 4 }));
  R.a7 = { fin: txt($(".v2-studio-fin")), tell: !!btn(/팀에 알리기/), now: txt($(".v2-studio-now")) };

  // ── A8 2-9 — 팀에 알리기는 AI 의 [[알림]] 답이 와야 굳는다
  window.__step = "A8";
  app("a8", { vis: "all", pubNo: 2 });
  window.__log = [];
  await open(base("s-a8", { appId: "a8", stage: "put", done: true, reached: 4 }));
  const tell = btn(/팀에 알리기/); R.a8 = { tell: !!tell };
  if (tell) tell.click(); await sleep(600);
  const tell2 = btn(/알리기|알렸어요/, $(".v2-studio-tell"));
  R.a8.after = { text: txt(tell2), disabled: tell2 ? tell2.disabled : null };
  window.__log.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "[[알림]] 알렸어요" }] } }));
  await sleep(3500);
  const tell3 = btn(/알리기|알렸어요/, $(".v2-studio-tell"));
  R.a8.done = { text: txt(tell3), disabled: tell3 ? tell3.disabled : null };

  // ── A9 2-11 — 세션 위젯 앱 「지금 써 보기」(앱빌더 안엔 붙일 세션이 없다)
  window.__step = "A9";
  app("a9", { vis: "all", pubNo: 2, manifest: { id: "a9", title: "회의록", studio: { place: "side", put: true, card } } });
  await open(base("s-a9", { appId: "a9", stage: "put", done: true, reached: 4, place: "side" }));
  const try9 = btn(/지금 써 보기/); if (try9) try9.click(); await sleep(500);
  R.a9 = { btn: !!try9, still: !!document.querySelector(".v2-studio"), note: txt($(".v2-studio-try-note:not([hidden])")) };

  // ── B1 4-1 — ② 「완료 · 다음 단계로」 빨리 두 번
  window.__step = "B1";
  await open(base("s-b1", { appId: "", stage: "plan", reached: 1, cardSent: undefined, round: 0 }));
  let pb = window.__prompts.length;
  const done1 = btn(/완료 · 다음 단계로/, $(".v2-studio-now")); if (done1) { done1.click(); done1.click(); }
  await sleep(1000);
  R.b1 = { btn: !!done1, drafts: window.__prompts.slice(pb).filter((t) => /초안을 만들어/.test(t)).length };

  // ── B2 · B5 4-2 · 4-5 — ② 카드 「수정하기」 → 고친 카드가 올 때까지 편집 · 완료 잠김 · 기록 끝 조회가 실패해도 읽던 자리 그대로
  window.__step = "B2";
  window.__log = ["a", "b", "c"];
  await open(base("s-b2", { appId: "", stage: "plan", reached: 1, cardSent: undefined, round: 0, from: 3 }));
  window.__tailFail = true;
  const ask = $(".v2-studio-ask-in"); if (ask) { ask.value = "더 단순하게"; }
  const askGo = btn(/^수정하기$/, $(".v2-studio-ask")); if (askGo) askGo.click();
  await sleep(600);
  window.__tailFail = false;
  const done2 = btn(/완료 · 다음 단계로/, $(".v2-studio-now"));
  R.b2 = { ask: !!askGo, editable: $$(".v2-studio-card [contenteditable=true]").length, done: done2 ? done2.disabled : null, wait: txt($(".v2-studio-ask--wait")), from: recOf("s-b2").from };
  window.__log.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: St.cardText({ ...card, name: "회의록 간단히" }) }] } }));
  await sleep(3500);
  const done2b = btn(/완료 · 다음 단계로/, $(".v2-studio-now"));
  R.b2.after = { editable: $$(".v2-studio-card [contenteditable=true]").length, done: done2b ? done2b.disabled : null, wait: !!$(".v2-studio-ask--wait") };

  // ── B3 4-3 — 앱은 있는데 남은 기획 카드가 없다 · ② 탭
  window.__step = "B3";
  app("b3", { manifest: { id: "b3", title: "메모", studio: { place: "both", put: true } } });
  await open(base("s-b3", { appId: "b3", stage: "fix", card: null, title: "메모" }));
  const tab2 = $$(".v2-studio-bar > *")[1]; if (tab2 && tab2.tagName === "BUTTON") tab2.click();
  await sleep(800);
  R.b3 = { now: txt($(".v2-studio-now")), next: !!btn(/^다음 →$/), spin: !!$(".v2-studio-app-body .v2-studio-spin") };

  // ── B4 4-4 — ② 에 있는데(다시 기획을 청한 뒤) 첫 판이 저장된다
  window.__step = "B4";
  app("res-b4", { versions: [[1, "초안"]], cur: 1 });
  await open(base("s-b4", { appId: "", draftId: "res-b4", stage: "plan", card: null, reached: 2, planAt: Date.now(), round: 0 }));
  if (window.__sse) window.__sse({ type: "app", app_id: "res-b4", kind: "updated", note: "초안" });
  await sleep(1500);
  R.b4 = { tab: onTab(), appId: recOf("s-b4").appId, stage: recOf("s-b4").stage };

  // ── B7 4-8 — ① 로 와서 이름만 바꾸고 다시 기획 — 지난 카드를 함께 보낸다
  window.__step = "B7";
  await open(base("s-b7", { appId: "", stage: "plan", reached: 1, cardSent: undefined, round: 0, card: { ...card, extra: [{ title: "담당자", body: "회의마다 한 명" }] } }));
  const tab1 = $$(".v2-studio-bar > *")[0]; if (tab1 && tab1.tagName === "BUTTON") tab1.click(); await sleep(600);
  const ni7 = $(".v2-studio-name-field"); if (ni7) { ni7.value = "회의 기록"; ni7.dispatchEvent(new Event("input", { bubbles: true })); }
  pb = window.__prompts.length;
  const go7 = $(".v2-studio-go"); if (go7) go7.click();
  await sleep(800);
  const sent7 = window.__prompts.slice(pb)[0] || "";
  R.b7 = { sent: !!sent7, prev: /지난 기획 카드/.test(sent7) && /담당자/.test(sent7) && /바뀐 점만/.test(sent7) };

  // ── B8 · B6 · C1 4-9 · 4-7 · 6-11 — 새 앱 ① 「만들기 시작」 → 준비 중 칸 잠김 → 그 사이 닫으면 예약 앱도 화면도 없다
  window.__step = "B8";
  localStorage.setItem("lively_v2_app_studio", "[]");
  St.openAppStudio(null, opts); await sleep(500);
  const w8 = $(".v2-studio-what"); if (w8) { w8.value = "회의록을 음성으로 받아 정리"; w8.dispatchEvent(new Event("input", { bubbles: true })); }
  window.__projDelay = 1500; window.__buildStarts = 0; window.__spawns = 0;
  const go8 = $(".v2-studio-go"); if (go8) go8.click();
  await sleep(100);
  R.b8 = { what: w8 ? w8.disabled : null, name: $(".v2-studio-name-field") ? $(".v2-studio-name-field").disabled : null };
  St.closeAppStudio();
  await sleep(2500);
  R.b6 = { buildStarts: window.__buildStarts, spawns: window.__spawns, open: !!document.querySelector(".v2-studio") };
  window.__projDelay = 0;
  // C1 — 이름 없이 시작한 만들기 · 카드 전 — 머리줄 「새 앱」(설명 전체가 이름처럼 뜨지 않게)
  window.__step = "C1";
  await open(base("s-c1", { appId: "", stage: "plan", card: null, title: undefined, named: false, reached: 1, what: "회의록을 음성 파일로 주면 전사하고 요약해서 정리해 주면 좋겠어요", at: Date.now() }));
  R.c1 = nameTop();

  // ── B9 4-10 — 기록 없이 이어 열기 · 그 세션에 이미 초안을 청했다
  window.__step = "B9";
  window.__log = [JSON.stringify({ type: "user", message: { content: "「회의록」 앱을 만들고 싶어." } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: CT }] } }),
    JSON.stringify({ type: "user", message: { content: "이 기획 카드대로 초안을 만들어 저장해 줘. 세션 위젯…" } })];
  localStorage.setItem("lively_v2_app_studio", "[]");
  pb = window.__prompts.length;
  St.openAppStudio({ sid: "s-b9", what: "회의록" }, opts); await sleep(1800);
  R.b9 = { tab: onTab(), done: !!btn(/완료 · 다음 단계로/, $(".v2-studio-now")), stage: recOf("s-b9").stage, sent: window.__prompts.length - pb };

  // ── C3 6-10 — 판 정보를 받기 전 ③ 제목은 비운다
  window.__step = "C3";
  app("c3", { verDelay: 2500, versions: [[1, "초안"], [2, "고침"], [3, "고침"], [4, "고침"], [5, "고침"]], cur: 5 });
  localStorage.setItem("lively_v2_app_studio", JSON.stringify([base("s-c3", { appId: "c3", stage: "fix" })]));
  St.openAppStudio({ sid: "s-c3" }, opts); await sleep(700);
  R.c3 = { early: txt($(".v2-studio-hub-head h2")) };
  await sleep(3500);
  R.c3.late = txt($(".v2-studio-hub-head h2"));

  // ── E1 6-15 — 「앱 화면으로 보기」 가 서버 오류로 못 열면 까닭을 말한다
  window.__step = "E1";
  app("e1", {});
  await open(base("s-e1", { appId: "e1", stage: "fix", place: "full" }));
  window.__instFail = true; window.__listApps = true; k = t0();
  const see = btn(/앱 화면으로 보기/); if (see) see.click();
  await sleep(1500);
  R.e1 = { btn: !!see, toasts: toasts.slice(k) };
  window.__instFail = false; window.__listApps = false;

  // ── A12 2-6 — 서버가 있는 앱을 넣다가(서버 빌드를 기다리는 중) 앱빌더를 닫는다 — 뒤늦게 저장 · 공개하지 않는다
  window.__step = "A12";
  app("a12", { server: true, manifest: { id: "a12", title: "회의록", studio: { place: "both", card } } });
  await open(base("s-a12", { appId: "a12", stage: "check", reached: 3, vis: "all", check: { have: ["정리"], missing: [], ver: 2, card: CT } }));
  const done12 = btn(/완료 · 다음 단계로/, $(".v2-studio-now")); if (done12) done12.click();
  await sleep(800);
  St.closeAppStudio();
  window.__A.a12.server = false;   // 닫은 뒤 서버가 다 올라갔다
  await sleep(4500);
  R.a12 = { btn: !!done12, saves: saves("a12"), pubs: pubs("a12") };



  // ══ 기록 없이 이어 열기 — 세션 기록에서 되짓기(원준 2026-10-29 실제 화면 box-wonjoon-jang-67049116 · T1~T3) ══
  // T1 — 서버의 만들기 세션 칸이 다른 세션을 가리킨다(역조회 빈 목록) · 이 세션 기록은 카드 → 초안 청함(id) → app_save → 「1번째 고침이야 … app_pull app-2c」
  window.__step = "T1";
  app("app-2c", { versions: [[1, "초안"], [2, "고침"]], cur: 2, manifest: { id: "app-2c", title: "회의록", studio: { place: "both", card } } });
  const U = (t) => JSON.stringify({ type: "user", message: { role: "user", content: t } });
  const AT = (t) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
  const TOOL = (name, input) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
  window.__log = [U(St.planBrief("회의록", "both", "회의록")), AT(CT), U(St.draftBrief(card, "both", "app-2c")),
    TOOL("mcp__lively__app_save", { files: [{ path: "lively-app.json", content: JSON.stringify({ id: "app-2c", title: "회의록" }) }], note: "초안" }),
    U(St.fixBrief(1, [], "글자 크게", "both", "app-2c"))];
  window.__rows = { "s-t1": { id: "s-t1", agentState: "idle" } };
  localStorage.setItem("lively_v2_app_studio", "[]");
  St.openAppStudio({ sid: "s-t1", what: "회의록", title: "회의록" }, opts); await sleep(2500);
  R.t1 = { tab: onTab(), appId: recOf("s-t1").appId, round: recOf("s-t1").round, stage: recOf("s-t1").stage, writing: /쓰는 중/.test(txt(host) || ""), hub: !!$(".v2-studio-hub") };

  // T2 — 아무것도 되짓지 못했다(기획을 청한 글뿐 · 카드 없음) · AI 도 안 돈다 — «쓰는 중» 으로 돌지 않고 «쓰지 않았어요» · 「다시 부탁하기」
  window.__step = "T2";
  window.__log = [U(St.planBrief("회의록", "both", "회의록"))];
  window.__rows = { "s-t2": { id: "s-t2", agentState: "idle" } };
  localStorage.setItem("lively_v2_app_studio", "[]");
  St.openAppStudio({ sid: "s-t2", what: "회의록", title: "회의록" }, opts); await sleep(2500);
  const again = btn(/다시 부탁하기/, $(".v2-studio-now"));
  R.t2 = { now: txt($(".v2-studio-now")), body: txt($(".v2-studio-app-body")), again: again ? !again.disabled : null, spin: !!$(".v2-studio-app-body .v2-studio-spin") };
  const pt2 = window.__prompts.length;
  if (again) again.click();
  await sleep(800);
  R.t2.sent = window.__prompts.slice(pt2).filter((t) => /앱을 만들고 싶어/.test(t)).length;

  // T3 — 앱빌더 첫 화면 목록 — 서버 칸이 다른 세션을 가리켜도 세션의 마지막 글(«1번째 고침이야 … app_pull app-2c»)로 그 앱의 ③ 으로 선다(② 라 하지 않는다)
  window.__step = "T3";
  const bapp = { id: "app-2c", title: "회의록", version: "1", enabled: true, installedBy: "wonjoon-jang", installedAt: 0, hasUi: true, canEdit: true, builtin: false, versionNo: 2, hasInstructions: false, icon: null,
    studio: { place: "both", card }, visibility: "me", madeBy: "wonjoon-jang", ownerMember: "wonjoon-jang", origin: null, view: "installed", draft: null, buildSession: "s-other", isOwner: true, canPublish: true, canUnpublish: false, publishedNo: 0, empty: false, folder: null };
  const envT3 = { projects: () => [{ id: 7, name: "앱빌더" }], sessionsReady: () => true,
    sessions: () => [{ id: "s-t3", label: '"회의록" 앱 제작', projectId: 7, owned: true, lastSeen: Date.now(), raw: { lastPrompt: St.fixBrief(1, [], "글자 크게", "both", "app-2c") } }] };
  localStorage.setItem("lively_v2_app_studio", "[]");
  const M3 = St.buildModel([bapp], { id: "wonjoon-jang", name: "원준" }, envT3);
  const d3 = M3.drafts.find((d) => d.sid === "s-t3");
  R.t3 = d3 ? { stage: d3.stage, appId: d3.appId } : null;

  // ══ 격리 리뷰 #1583 후속(R1~R9) ══
  // R1 · 1 — 이미 공개된 앱(초안 없음)을 ④ 에서 「모두」 로 두고 이름을 바꿨다 — 저장이 만든 내 초안을 공개까지 한다(비공개 초안으로 남지 않게)
  window.__step = "R1";
  app("r1", { vis: "all", pubNo: 2 });
  await open(base("s-r1", { appId: "r1", stage: "check", reached: 3, vis: "all", check: { have: ["정리"], missing: [], ver: 2, card: CT } }));
  const nr1 = $(".v2-studio-name-in"); if (nr1) { nr1.value = "회의록 새 이름"; nr1.dispatchEvent(new Event("input", { bubbles: true })); }
  const dr1 = btn(/완료 · 다음 단계로/, $(".v2-studio-now")); if (dr1) dr1.click();
  await sleep(1500);
  R.r1 = { saves: saves("r1"), pubs: pubs("r1"), draft: !!window.__A.r1.draft, fin: /워크스페이스 앱이 됐어요/.test(txt($(".v2-studio-fin")) || "") };

  // R2 · 2 — ② 에서 카드 고침을 청해 두고 ③ 으로 갔는데 그 사이 고친 카드가 왔다 — 받아 두고 ② 로 돌아오면 풀려 있다
  window.__step = "R2";
  window.__log = ["a"];
  app("r2", {});
  await open(base("s-r2", { appId: "r2", stage: "plan", reached: 2, from: 1, cardFix: Date.now() - 1000 }));
  const t3 = $$(".v2-studio-bar > *")[2]; if (t3 && t3.tagName === "BUTTON") t3.click(); await sleep(600);
  window.__log.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: St.cardText({ ...card, first: "주제별 목록" }) }] } }));
  await sleep(3500);
  const t2b = $$(".v2-studio-bar > *")[1]; if (t2b && t2b.tagName === "BUTTON") t2b.click(); await sleep(700);
  R.r2 = { cardFix: !!recOf("s-r2").cardFix, first: (recOf("s-r2").card || {}).first, wait: !!$(".v2-studio-ask--wait"), editable: $$(".v2-studio-card [contenteditable=true]").length };

  // R3 · 3 — ④ 에 들어와 대조를 청한 뒤 답 전에 ③ 에 갔다가 다시 ④ — 대조는 한 번만 청한다
  window.__step = "R3";
  app("r3", {});
  let pr3 = window.__prompts.length;
  await open(base("s-r3", { appId: "r3", stage: "check", reached: 3 }));
  const t3c = $$(".v2-studio-bar > *")[2]; if (t3c && t3c.tagName === "BUTTON") t3c.click(); await sleep(500);
  const t4c = $$(".v2-studio-bar > *")[3]; if (t4c && t4c.tagName === "BUTTON") t4c.click(); await sleep(900);
  R.r3 = { checks: window.__prompts.slice(pr3).filter((t) => /\[\[대조\]\]/.test(t)).length };

  // R4 · 4 — ④ 에서 판을 다시 읽는 동안 «확인하는 중» · 「완료」 잠김(지난 판 결과를 먼저 그리지 않는다)
  window.__step = "R4";
  app("r4", { verDelay: 2500 });
  localStorage.setItem("lively_v2_app_studio", JSON.stringify([base("s-r4", { appId: "r4", stage: "check", reached: 3, check: { have: ["정리"], missing: [], ver: 2, card: CT } })]));
  St.openAppStudio({ sid: "s-r4" }, opts); await sleep(4200);   // 열 때 판 읽기(2.5초)가 끝나 ④ 를 그린 뒤
  const t3d = $$(".v2-studio-bar > *")[2]; if (t3d && t3d.tagName === "BUTTON") t3d.click(); await sleep(3000);
  const t4d = $$(".v2-studio-bar > *")[3]; if (t4d && t4d.tagName === "BUTTON") t4d.click(); await sleep(400);
  const d4 = () => btn(/완료 · 다음 단계로/, $(".v2-studio-now"));
  R.r4 = { early: { row: txt($(".v2-studio-chk")), done: d4() ? d4().disabled : null } };
  await sleep(3200);
  R.r4.late = { row: txt($(".v2-studio-chk")), done: d4() ? d4().disabled : null };

  // R5 · 5 — ② 카드 「수정하기」 를 보내는 사이 「완료」 — 초안을 청하지 않는다
  window.__step = "R5";
  window.__log = [];
  await open(base("s-r5", { appId: "", stage: "plan", reached: 1, cardSent: undefined, round: 0 }));
  const pr5 = window.__prompts.length;
  const a5 = $(".v2-studio-ask-in"); if (a5) a5.value = "담당자 칸 추가";
  const ag5 = btn(/^수정하기$/, $(".v2-studio-ask")); if (ag5) ag5.click();
  const d5 = btn(/완료 · 다음 단계로/, $(".v2-studio-now")); if (d5) d5.click();
  await sleep(1000);
  const s5 = window.__prompts.slice(pr5);
  R.r5 = { fix: s5.filter((t) => /기획 카드를 이렇게 고쳐서/.test(t)).length, drafts: s5.filter((t) => /초안을 만들어/.test(t)).length };

  // R6 · 6 — 알리기를 보내 두고 나갔다 왔다 · 그 사이 온 [[알림]] 답을 읽어 굳힌다
  window.__step = "R6";
  app("r6", { vis: "all", pubNo: 2 });
  window.__log = ["x", "y", JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "[[알림]] 알렸어요" }] } })];
  await open(base("s-r6", { appId: "r6", stage: "put", done: true, reached: 4, from: 2, notifySent: Date.now() - 60000 }), 3500);
  const tb6 = btn(/알리기|알렸어요/, $(".v2-studio-tell"));
  R.r6 = { text: txt(tb6), disabled: tb6 ? tb6.disabled : null, notified: !!recOf("s-r6").notified };

  // R7 · 7 — 오래된 세션 · 읽던 자리 0 · 열 때 기록 끝을 못 읽었다 — 옛 카드를 처음부터 다시 읽지 않는다
  window.__step = "R7";
  window.__log = [JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: St.cardText({ ...card, name: "옛 카드" }) }] } })];
  window.__tailFail = true;
  await open(base("s-r7", { appId: "", stage: "plan", card: null, reached: 1, from: 0, at: Date.now() - 3600000, title: "회의록" }), 3500);
  window.__tailFail = false;
  await sleep(3500);
  R.r7 = { card: recOf("s-r7").card ? recOf("s-r7").card.name : null, from: recOf("s-r7").from };

  // R8 · 8 — ④ 에서 「다음 →」(서버 빌드를 기다리는 넣기) — 바로 «저장하는 중» · ⑤ 칸은 못 누른다
  window.__step = "R8";
  app("r8", { server: true, manifest: { id: "r8", title: "회의록", studio: { place: "both", card } } });
  await open(base("s-r8", { appId: "r8", stage: "check", reached: 4, check: { have: ["정리"], missing: [], ver: 2, card: CT } }));
  const n8 = btn(/^다음 →$/); if (n8) n8.click();
  await sleep(300);
  const tab5 = $$(".v2-studio-bar > *")[4];
  R.r8 = { next: !!n8, now: txt($(".v2-studio-now")), tab5: tab5 ? tab5.tagName : null };
  St.closeAppStudio(); window.__A.r8.server = false;
  await sleep(500);

  // R9 · 9 — 「만들기 시작」 길이 중간에 던졌다 — ① 칸이 다시 풀리고 까닭을 말한다
  window.__step = "R9";
  localStorage.setItem("lively_v2_app_studio", "[]");
  St.openAppStudio(null, opts); await sleep(500);
  const w9 = $(".v2-studio-what"); if (w9) { w9.value = "회의록을 음성으로 받아 정리"; w9.dispatchEvent(new Event("input", { bubbles: true })); }
  window.__appsNull = true; k = t0();
  const g9 = $(".v2-studio-go"); if (g9) g9.click();
  await sleep(1500);
  window.__appsNull = false;
  R.r9 = { what: w9 ? w9.disabled : null, go: g9 ? [g9.disabled, txt(g9)] : null, toast: toasts.slice(k).some((t) => /시작하지 못했어요/.test(t)) };
  St.closeAppStudio();

  R.calls = window.__calls.length;
  R.errors = errors;
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}
const PAGE = `<!doctype html><html data-theme="light" lang="ko"><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css")}
  html,body{margin:0} #host{width:1100px;height:860px;position:relative}
</style>
<div id="host"></div><div id="toasts"></div>
<pre id="out">PENDING</pre>
${FETCH}
<script>window.__CARD = ${JSON.stringify(CARD)};</script>
<script>${bundle}</script>
<script>(${PAGE_MAIN.toString()})().catch((e) => { document.getElementById("out").textContent = "RESULT" + JSON.stringify({ crash: (window.__step || "") + " " + String((e && e.stack) || e).slice(0, 900) }) + "ENDRESULT"; });</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "studio-flow-audit-", virtualTimeBudget: 120000, args: ["--window-size=1200,900"] });
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
const plain = (ts) => ts.every((t) => !/판|—/.test(t));

same(R.a1, { next: true, saves: 1, pubs: 1, put: true, name: "회의록 정리" }, "A1 2-1 ④ 에서 이름 · 공개 범위를 바꾸고 「다음 →」 — 저장 · 공개를 거쳐 ⑤(바꾼 이름이 머리줄에)");
same(R.a2, { next: true, saves: 0, pubs: 0, put: true, asked: 0 }, "A2 2-1/2-7 바꾼 것 없이 「다음 →」 — 마무리를 다시 저장하지 않고 ⑤ · ④ 대조도 다시 묻지 않았다");
same(R.a11, { undo: "초안으로 되돌리기", hidden: false }, "A11 2-7 마무리 판 위 「되돌리기」 — 마무리 판 아래 AI 판(V2)이 아니라 그 앞 판으로");
same(R.a3, { undo: true, disabled: true }, "A3 2-3 AI 가 고치는 중 — 머리줄 「되돌리기」 가 잠긴다");
check(R.a4 && R.a4.stillFixing === true, "A4 2-3 고치는 중 «되돌림» 사건(사람이 한 저장)은 고침 끝으로 치지 않는다", JSON.stringify(R.a4));
check(R.a4 && R.a4.settled === true && R.a4.undoAfter === false, "A4 2-3 AI 가 저장한 사건은 끝맺고 머리줄이 풀린다", JSON.stringify(R.a4));
check(R.a4 && R.a4.band && !/판|→/.test(R.a4.band) && /되돌렸어요/.test(R.a4.band), "C2 6-13 띠 — 서버 글 «되돌림 → 1판» 을 화면 말로", R.a4 && R.a4.band);
check(R.a5 && R.a5.saves === 1 && R.a5.toasts.some((t) => /저장했어요\. 공개는 못 했어요/.test(t)) && !R.a5.toasts.some((t) => /저장하지 못했어요/.test(t)) && plain(R.a5.toasts) && R.a5.name === "회의 정리",
  "A5 2-4 공개만 막힘 — «저장했어요. 공개는 못 했어요(까닭)» · 「판」 「—」 없이 · 바꾼 이름은 머리줄에", JSON.stringify(R.a5));
check(R.a6 && R.a6.toasts.some((t) => /^저장하지 못했어요/.test(t)) && R.a6.check && !R.a6.put, "A6 2-4 저장 실패 — «저장하지 못했어요» · ④ 그대로", JSON.stringify(R.a6));
check(R.a7 && /공개 상태를 확인하지 못했어요/.test(R.a7.fin || "") && !/워크스페이스 앱이 됐어요/.test(R.a7.fin || "") && !R.a7.tell, "A7 2-5 공개 상태를 못 읽음 — 그렇다고 말하고 「팀에 알리기」 는 없다", JSON.stringify(R.a7));
same(R.a8 && [R.a8.tell, R.a8.after, R.a8.done], [true, { text: "다시 알리기", disabled: false }, { text: "알렸어요", disabled: true }], "A8 2-9 보내기만 해선 안 굳는다(다시 누를 수 있다) · [[알림]] 알렸어요 답이 오면 굳는다");
check(R.a9 && R.a9.btn && R.a9.still && /세션 오른쪽 위 \+/.test(R.a9.note || ""), "A9 2-11 세션 위젯 앱 「지금 써 보기」 — 앱빌더를 닫지 않고 붙이는 길을 알린다", JSON.stringify(R.a9));
same(R.a12, { btn: true, saves: 0, pubs: 0 }, "A12 2-6 서버 빌드를 기다리다 닫으면 — 뒤늦게 저장 · 공개하지 않는다");
same(R.b1, { btn: true, drafts: 1 }, "B1 4-1 ② 「완료 · 다음 단계로」 를 빨리 두 번 — 초안 청함은 한 번");
same(R.b2 && [R.b2.ask, R.b2.editable, R.b2.done, !!R.b2.wait], [true, 0, true, true], "B2 4-2 카드 고침을 기다리는 동안 — 카드 편집 · 「완료」 잠김 · 기다림 줄");
check(R.b2 && R.b2.after && R.b2.after.editable > 0 && R.b2.after.done === false && R.b2.after.wait === false, "B2 4-2 고친 카드가 오면 풀린다(카드를 다시 고칠 수 있고 「완료」 가 눌린다)", JSON.stringify(R.b2 && R.b2.after));
same(R.b2 && R.b2.from, 3, "B5 4-5 보낼 때 기록 끝을 못 읽으면 읽던 자리 그대로(0 으로 가 처음부터 다시 읽지 않는다)");
check(R.b3 && /남아 있는 기획 카드가 없어요/.test(R.b3.now || "") && R.b3.next && !R.b3.spin, "B3 4-3 앱은 있는데 카드가 없다 — «남아 있는 기획 카드가 없어요» · 「다음 →」 · 도는 표시 없음", JSON.stringify(R.b3));
same(R.b4, { tab: 1, appId: "res-b4", stage: "plan" }, "B4 4-4 ② 에 있는데 첫 판이 저장된다 — ② 그대로 · 앱이 생긴 것만 기록");
same(R.b7, { sent: true, prev: true }, "B7 4-8 ① 에서 이름만 바꿔 다시 기획 — 지난 카드(더한 항목 포함)를 보내고 «바뀐 점만» 반영하게");
same(R.b8, { what: true, name: true }, "B8 4-9 「준비하는 중…」 동안 ① 칸은 잠긴다");
same(R.b6, { buildStarts: 0, spawns: 0, open: false }, "B6 4-7 준비하는 사이 닫았다 — 세션 · 예약 앱을 만들지 않고 화면도 다시 열지 않는다");
same(R.b9 && [R.b9.tab, R.b9.done, R.b9.stage, R.b9.sent], [2, false, "draft", 0], "B9 4-10 기록 없이 이어 열기 · 이미 초안을 청한 세션 — 초안 기다림으로 연다(② 「완료」 로 또 청하지 않게)");
same(R.c1, "새 앱", "C1 6-11 이름 없이 시작 · 카드 전 — 머리줄은 「새 앱」(설명 전체가 이름처럼 뜨지 않게)");
check(R.c3 && R.c3.early === "" && /다섯 번째 버전이 나왔어요/.test(R.c3.late || ""), "C3 6-10 판 정보를 받기 전 ③ 제목은 비우고 · 받으면 그 판으로", JSON.stringify(R.c3));
check(R.e1 && R.e1.btn && R.e1.toasts.some((t) => /^앱 화면을 열지 못했어요\(.+\)$/.test(t)) && plain(R.e1.toasts), "E1 6-15 「앱 화면으로 보기」 가 서버 오류로 못 열면 «앱 화면을 열지 못했어요(까닭)»", JSON.stringify(R.e1));
same(R.t1, { tab: 2, appId: "app-2c", round: 1, stage: "fix", writing: false, hub: true }, "T1 기록 없이 이어 열기 · 서버 칸이 다른 세션 — 세션 기록의 앱 id · 고침 차례로 ③ 에 연다(«② 쓰는 중» 이 아니라)");
check(R.t2 && /쓰지 않았어요/.test(R.t2.now || "") && /쓰지 않았어요/.test(R.t2.body || "") && R.t2.again === true && !R.t2.spin, "T2 되짓지 못했고 AI 도 안 돈다 — «AI가 기획 카드를 쓰지 않았어요» · 「다시 부탁하기」(도는 표시 없음)", JSON.stringify(R.t2));
same(R.t2 && R.t2.sent, 1, "T2 「다시 부탁하기」 — 처음 적은 내용으로 기획을 다시 청한다");
same(R.t3, { stage: "fix", appId: "app-2c" }, "T3 앱빌더 목록 — 세션의 마지막 글이 가리킨 앱으로 ③ 에 선다(② 세부 기획이라 하지 않는다)");
same(R.r1, { saves: 1, pubs: 1, draft: false, fin: true }, "R1 공개 앱(초안 없음)을 「모두」 로 두고 이름을 바꿈 — 저장한 초안을 공개까지(비공개 초안으로 남지 않는다)");
same(R.r2 && [R.r2.cardFix, R.r2.first, R.r2.wait, R.r2.editable > 0], [false, "주제별 목록", false, true], "R2 카드 고침을 청해 두고 ③ 에 간 사이 온 카드 — 받아 두고 ② 는 풀려 있다");
same(R.r3, { checks: 1 }, "R3 대조를 청한 뒤 답 전에 ④ 를 다시 들어와도 대조는 한 번");
check(R.r4 && /확인하는 중/.test(R.r4.early.row || "") && R.r4.early.done === true && /있어요: 정리/.test(R.r4.late.row || "") && R.r4.late.done === false, "R4 판을 다시 읽는 동안 «확인하는 중» · 「완료」 잠김 · 읽은 뒤 풀린다", JSON.stringify(R.r4));
same(R.r5, { fix: 1, drafts: 0 }, "R5 카드 고침을 보내는 사이 「완료」 — 초안을 청하지 않는다");
same(R.r6, { text: "알렸어요", disabled: true, notified: true }, "R6 나갔다 온 사이 온 [[알림]] 답 — 다시 열면 읽어서 굳힌다");
same(R.r7 && R.r7.card, null, "R7 오래된 세션에서 기록 끝을 못 읽었다 — 옛 카드를 처음부터 다시 읽지 않는다");
check(R.r7 && R.r7.from === 1, "R7 기록 끝을 다시 읽으면 그 자리부터", JSON.stringify(R.r7));
check(R.r8 && R.r8.next && /저장하는 중/.test(R.r8.now || "") && R.r8.tab5 !== "BUTTON", "R8 ⑤ 로 가며 저장하는 중 — 바로 «저장하는 중» · ⑤ 칸은 못 누른다", JSON.stringify(R.r8));
same(R.r9, { what: false, go: [false, "만들기 시작"], toast: true }, "R9 시작 길이 던졌다 — ① 칸이 풀리고 «시작하지 못했어요»");
check(R.calls > 30, "W  가짜 서버가 실제로 불렸다", R.calls);
same(R.errors, [], "W  페이지 예외 없음");

console.log(`\n#4632 앱빌더 ①②④⑤ 흐름 점검: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
