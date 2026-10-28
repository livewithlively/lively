#!/usr/bin/env node
// 앱빌더 ④ 「확인」 의 아이콘 줄(#4632) — 런타임 회귀 테스트(헤드리스 크롬 · 가짜 서버).
//
// 원준 2026-10-28:
//  «여기에 자동으로 만들어진 디자인 사항들도 정리해서 보여주면 좋겠음. 여러군데 아마 아이콘 생길거아냐 그거에 대해서 커스텀하는 창도 있으면 좋겠네
//   AI한테 그 아이콘 수정할 수 있는 창도 필요하면 띄우던지 … 내 생각에는 앱 좌측 사이드바랑 세션위젯 만든경우 세션위젯에서 보이는 아이콘 정도면 좋을 것 같은데»
//  앱 아이콘은 매니페스트 icon 한 벌이고 사이드바 줄 · 세션 위젯 탭 · 앱 찾기가 같은 그림을 쓴다(#4769) — ④ 는 그 자리들을 미리 보이고 고르게 한다.
//  [[아이콘]] 줄 읽기 · 보내는 글은 app-studio-flow.test.mjs I 가 잰다. 여기선 화면에서만 보이는 것을 잰다.
//
// 엣지 표(스크래치패드 spec.md 의 화면 편):
//  P1 ④ 줄이 다섯 · 마지막 줄 「아이콘」 · 지금 줄 「다섯 가지」   P2 둘 다 — 미리보기 세 자리(사이드바 · 세션 위젯 · 앱 찾기) · 그림 = 매니페스트 path
//  P3 앱 화면만 — 세션 위젯 자리가 없다   P4 펼치면 — 처음 그림 + 기본 그림 18 · 색 9
//  P5 기본 그림 고름 — 고른 것만 기록(색은 지금 색 그대로) · 저장 · AI 글 0건   P6 색 고름 — 그림 그대로 색만   P7 「처음대로」 — 고른 것을 걷는다
//  P8 AI 에게 부탁 — 글 1건([[아이콘]] 꼴 · 적은 말) · 단추 잠김 · 「그리는 중」   P9 틀린 답은 버리고 기다린다 · 맞는 답이 오면 그림 목록 맨 앞 · 고른 것
//  P10 「완료 · 다음 단계로」 — 마무리 저장의 lively-app.json icon = 고른 것 · 기록에서 걷힘   P11 아이콘 없는 앱 — 「아직 아이콘이 없어」 · 기본 그림(liv)
//  W 페이지 예외 없음
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(이 변경 전 origin/main 에서 P1~P11 이 빨갛다).
// SHOT_DIR=<폴더> 를 주면 눈검수용 화면 HTML(④ · 아이콘 칸 펼침)을 그 폴더에 남긴다.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 앱빌더 ④ 아이콘 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const ENTRY = "export * from './v2/app-studio.ts'; export { cardText } from './lib/studio-flow.ts'; export { iconPath } from './lib/icon-paths.ts';";
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=St", "--platform=browser", "--loader=ts", "--sourcefile=studio-icon-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: ENTRY, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

const CARD = { name: "회의록", who: "회의에 들어가는 사람", items: "날짜 · 내용", can: ["정리", "찾기"], not: "", first: "날짜별 목록", ref: "", notify: "" };
const ICON = { path: "M6 4h12v16H6z M9 9h6 M9 13h4", color: "#2D6BF0", color_dark: "#739DF5" };
//  앱 둘 — notes(아이콘 있음) · bare(아이콘 없음). 세션 기록(transcript)은 window.__log 에 쌓인 AI 답을 from 뒤로만 준다.
const FETCH = `<script>window.__prompts = []; window.__saves = []; window.__log = {};   // 세션마다 따로(진짜 기록처럼)
window.__apps = { notes: { id: "notes", title: "회의록", visibility: "me", published_version_no: 0, manifest: { id: "notes", title: "회의록", icon: ${JSON.stringify(ICON)}, studio: { card: ${JSON.stringify(CARD)} } } },
  bare: { id: "bare", title: "안건", visibility: "me", published_version_no: 0, manifest: { id: "bare", title: "안건", studio: { card: ${JSON.stringify(CARD)} } } } };
window.fetch = async (u, init) => {
  const url = String(u && u.url ? u.url : u), method = (init && init.method) || "GET";
  const p = url.replace(/^.*?(\\/api\\/)/, "/api/");
  const j = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
  if (/\\/prompt$/.test(p) && method === "POST") { let t = ""; try { t = JSON.parse(init.body).text || ""; } catch (_) {} window.__prompts.push(t); return j({ ok: true }); }
  if (p.includes("/transcript")) {
    const sid = decodeURIComponent((/sessions\\/([^/]+)\\/transcript/.exec(p) || [])[1] || ""), log = window.__log[sid] || [];
    const to = 5 + log.length, m = /from=(\\d+)/.exec(p), from = m ? Number(m[1]) : to;
    const lines = log.slice(Math.max(0, from - 5)).map((t) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t }] } }));
    return new Response(lines.join("\\n"), { status: 200, headers: { "X-Log-To": String(to) } });
  }
  if (p === "/api/ui/apps/save" && method === "POST") { window.__saves.push(JSON.parse(init.body)); return j({ ok: true }); }
  let m = /^\\/api\\/ui\\/apps\\/(\\w+)\\/pull/.exec(p);
  if (m) { const a = window.__apps[m[1]]; return j({ app_id: a.id, files: [{ path: "lively-app.json", content: JSON.stringify(a.manifest) }, { path: "ui/index.html", content: "<p>x</p>" }] }); }
  m = /^\\/api\\/ui\\/apps\\/(\\w+)\\/versions/.exec(p);
  if (m) return j({ versions: [{ version_no: 1, is_current: false, note: "초안", saved_at: "2026-10-28T00:00:00Z" }, { version_no: 2, is_current: true, note: "고침", saved_at: "2026-10-28T00:00:00Z" }] });
  m = /^\\/api\\/ui\\/apps\\/(\\w+)\\/server/.exec(p);
  if (m) return j({ server_declared: false });
  m = /^\\/api\\/ui\\/apps\\/(\\w+)(\\?|$)/.exec(p);
  if (m && m[1] === "flaky") return new Response("{}", { status: 500 });
  if (m && window.__apps[m[1]]) return j({ app: window.__apps[m[1]] });
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
  const card = window.__CARD, CT = St.cardText(card);
  //  ④ 에 와 있는 기록 — 2번째 버전으로 이미 대조했다(AI 에게 다시 묻지 않는다).
  const base = { pid: 0, what: "회의록을 날짜별로 정리", place: "both", known: [], at: Date.now() - 600000, stage: "check", card, round: 1, from: 5, mode: "new",
    named: true, reached: 3, cardSent: CT, check: { have: ["정리", "찾기"], missing: [], ver: 2, card: CT } };
  const rec = { ...base, sid: "box-s1", appId: "notes", title: "회의록" };
  localStorage.setItem("lively_v2_app_studio", JSON.stringify([rec]));
  const recNow = (sid = "box-s1") => (JSON.parse(localStorage.getItem("lively_v2_app_studio") || "[]").find((r) => r.sid === sid) || {});
  const opts = { host, onClose: () => {}, onSee: () => {} };
  const icoRow = () => $$(".v2-studio-chk").find((r) => txt(r.querySelector("b")) === "아이콘") || null;
  const spots = () => $$(".v2-studio-ico-spot figcaption").map(txt);
  const sideD = () => { const pth = $(".v2-studio-ico-side svg path"); return pth ? pth.getAttribute("d") : null; };
  const sub = () => txt(icoRow() && icoRow().querySelector(".v2-studio-ico > span"));
  const btn = (re) => $$("button").find((b) => re.test(b.textContent || "") || re.test(b.getAttribute("aria-label") || ""));

  St.openAppStudio({ sid: "box-s1" }, opts);
  await sleep(1800);
  R.p1 = { rows: $$(".v2-studio-chk").map((r) => txt(r.querySelector("b"))), now: txt($(".v2-studio-now")) };
  R.p2 = { spots: spots(), d: sideD(), tile: !!$(".v2-studio-ico-pad svg.v2-gi"), sub: sub() };
  if (window.__SHOT) { const t = btn(/^아이콘 바꾸기$/); if (t) t.click(); await sleep(300); document.getElementById("out").textContent = "RESULT{}ENDRESULT"; return; }
  // P3 — 앱 화면만
  const full = $$(".v2-studio-chk-places button").find((b) => txt(b) === "앱 화면"); if (full) full.click();
  await sleep(200);
  R.p3 = { spots: spots() };
  const both = $$(".v2-studio-chk-places button").find((b) => txt(b) === "둘 다"); if (both) both.click();
  await sleep(200);
  // P4 — 펼치기
  const p0 = window.__prompts.length, s0 = window.__saves.length;
  const open = btn(/^아이콘 바꾸기$/); if (open) open.click();
  await sleep(200);
  const picks = () => $$(".v2-studio-ico-pick");
  R.p4 = { open: !!open, tiles: picks().length, first: picks()[0] ? picks()[0].getAttribute("title") : null, firstOn: picks()[0] ? picks()[0].classList.contains("on") : null, sw: $$(".v2-studio-ico-sw").length };
  // P5 — 기본 그림(목록의 셋째 = 기본 그림 둘째) 고르기
  const preset = picks()[2]; const presetD = preset ? preset.querySelector("path").getAttribute("d") : null;
  if (preset) { preset.focus(); preset.click(); }
  await sleep(200);
  R.p5 = { focusK: document.activeElement ? document.activeElement.getAttribute("data-ico-k") : null,  icon: recNow().icon || null, presetD, d: sideD(), on: picks()[2] ? picks()[2].classList.contains("on") : null, sub: sub(), reset: !!btn(/^처음대로$/), prompts: window.__prompts.length - p0, saves: window.__saves.length - s0 };
  // P6 — 색(넷째 = 와인)
  const sw = $$(".v2-studio-ico-sw")[3]; if (sw) sw.click();
  await sleep(200);
  R.p6 = { icon: recNow().icon || null, swOn: $$(".v2-studio-ico-sw")[3] ? $$(".v2-studio-ico-sw")[3].classList.contains("on") : null, pressed: $$(".v2-studio-ico-sw").map((b) => b.getAttribute("aria-pressed")) };
  // P7 — 처음대로
  const rs = btn(/^처음대로$/); if (rs) rs.click();
  await sleep(200);
  R.p7 = { icon: recNow().icon || null, d: sideD(), firstOn: picks()[0] ? picks()[0].classList.contains("on") : null };
  // P8 — AI 에게 부탁
  const ask = $(".v2-studio-ico-ask input"); if (ask) { ask.value = "마이크와 메모지"; ask.dispatchEvent(new Event("input", { bubbles: true })); }
  const go = btn(/AI에게 그려 달라기/); if (go) go.click();
  await sleep(600);
  const last = window.__prompts.slice(-1)[0] || "";
  R.p8 = { sent: window.__prompts.length - p0, iconLine: /\[\[아이콘\]\] path:/.test(last), ask: last.includes("마이크와 메모지"), app: last.includes("notes"), noSave: /app_save 하지 마/.test(last),
    locked: btn(/AI에게 그려 달라기/) ? btn(/AI에게 그려 달라기/).disabled : null, status: txt($(".v2-studio-ico-ed > small")) };
  // P9 — 틀린 답 · 맞는 답
  (window.__log["box-s1"] = window.__log["box-s1"] || []).push("[[아이콘]] path: <svg/> | color: blue | dark: #000000");
  await sleep(3200);
  R.p9 = { badIcon: recNow().icon || null, status: txt($(".v2-studio-ico-ed > small")) };
  const NEW = { path: "M8 3v10 M5 10a3 3 0 0 0 6 0 M14 6h6 M14 10h6 M14 14h4", color: "#D5541F", dark: "#E7845B" };
  window.__log["box-s1"].push("그렸어요.\n[[아이콘]] path: " + NEW.path + " | color: " + NEW.color + " | dark: " + NEW.dark);
  await sleep(3200);
  R.p9.icon = recNow().icon || null; R.p9.ai = (recNow().iconAi || []).length;
  R.p9.first = picks()[0] ? [picks()[0].getAttribute("title"), picks()[0].classList.contains("on"), picks()[0].querySelector("path").getAttribute("d")] : null;
  R.p9.d = sideD(); R.p9.unlocked = btn(/AI에게 그려 달라기/) ? !btn(/AI에게 그려 달라기/).disabled : null;
  R.p9.newD = NEW.path;
  // P10 — 완료 · 다음 단계로
  const fin = $$(".v2-studio-now button").find((b) => /완료 · 다음 단계로/.test(b.textContent)); if (fin) fin.click();
  await sleep(1500);
  const sv = window.__saves.slice(-1)[0];
  const mf = sv && Array.isArray(sv.files) ? sv.files.find((f) => f.path === "lively-app.json") : null;
  R.p10 = { saves: window.__saves.length - s0, icon: mf ? JSON.parse(mf.content).icon : null, recIcon: recNow().icon || null, stage: recNow().stage };
  // P11 — 아이콘 없는 앱
  const rec2 = { ...base, sid: "box-s2", appId: "bare", title: "안건" };
  localStorage.setItem("lively_v2_app_studio", JSON.stringify([rec2]));
  St.openAppStudio({ sid: "box-s2" }, opts);
  await sleep(1800);
  R.p11 = { sub: sub(), d: sideD(), liv: St.iconPath("liv") };
  // P12 — 고른 뒤 AI 가 새 버전에 다른 아이콘을 넣었다(고를 때 저장돼 있던 것 = 옛 그림) → 고른 것은 걷히고 새 아이콘이 선다
  const rec3 = { ...base, sid: "box-s3", appId: "notes", title: "회의록", icon: { path: "M1 1h3", color: "#118E6E" }, iconBase: "M2 2h9" };
  localStorage.setItem("lively_v2_app_studio", JSON.stringify([rec3]));
  St.openAppStudio({ sid: "box-s3" }, opts);
  await sleep(1800);
  R.p12 = { icon: recNow("box-s3").icon || null, d: sideD() };
  // P13 — 같은 기록인데 저장된 아이콘이 고를 때 그대로면 고른 것을 지킨다
  const rec4 = { ...rec3, sid: "box-s4", iconBase: window.__apps.notes.manifest.icon.path };
  localStorage.setItem("lively_v2_app_studio", JSON.stringify([rec4]));
  St.openAppStudio({ sid: "box-s4" }, opts);
  await sleep(1800);
  R.p13 = { icon: recNow("box-s4").icon ? recNow("box-s4").icon.path : null, d: sideD() };
  // P14 — 지금 아이콘을 못 읽었다 → 「없다」 가 아니라 「못 불러왔다」
  window.__apps.flaky = null;
  const rec5 = { ...base, sid: "box-s5", appId: "flaky", title: "안건" };
  localStorage.setItem("lively_v2_app_studio", JSON.stringify([rec5]));
  St.openAppStudio({ sid: "box-s5" }, opts);
  await sleep(1800);
  R.p14 = { sub: sub() };
  R.errors = errors;
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}
const page = (w, h, shot, theme = "light") => `<!doctype html><html data-theme="${theme}" lang="ko"><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css", "90-dark.css")}
  html,body{margin:0} #host{width:${w}px;height:${h}px;position:relative}
</style>
<div id="host"></div>
<pre id="out" style="position:absolute;left:-9999px">PENDING</pre>
${FETCH}
<script>window.__CARD = ${JSON.stringify(CARD)}; window.__SHOT = ${shot ? "true" : "false"};</script>
<script>${bundle}</script>
<script>(${PAGE_MAIN.toString()})().catch((e) => { document.getElementById("out").textContent = "RESULT" + JSON.stringify({ crash: String((e && e.stack) || e).slice(0, 900) }) + "ENDRESULT"; });</script>`;

if (process.env.SHOT_DIR) {
  for (const [w, h, th] of [[1200, 860, "light"], [390, 860, "light"], [1200, 860, "dark"]]) writeFileSync(path.join(process.env.SHOT_DIR, `studio-icon-${w}-${th}.html`), page(w, h, true, th));
  console.log("note  눈검수 화면을 남겼다 — " + process.env.SHOT_DIR);
}

const dom = await dumpDom(chrome, { html: page(1100, 860, false), prefix: "studio-icon-", virtualTimeBudget: 60000, args: ["--window-size=1200,900"] });
const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-800)); process.exit(1); }
const R = JSON.parse(m[1]);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));
if (R.crash) { console.error("FAIL  페이지가 도중에 넘어졌다 — " + R.crash); process.exit(1); }

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const same = (got, want, n) => { const a = JSON.stringify(got), b = JSON.stringify(want); return a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };

same(R.p1 && [R.p1.rows, /다섯 가지/.test(R.p1.now || "")], [["원하던 것이 다 있나요?", "이름", "쓰는 자리", "누가 쓰나", "아이콘"], true], "P1 ④ 줄이 다섯 · 마지막 「아이콘」 · 지금 줄 「다섯 가지」");
same(R.p2 && [R.p2.spots, R.p2.d, R.p2.tile, /AI가 앱을 만들 때 그린/.test(R.p2.sub || "")], [["사이드바", "세션 위젯", "앱 찾기"], ICON.path, true, true], "P2 둘 다 — 세 자리에 매니페스트 그림 · AI 가 그렸다고 말한다");
same(R.p3 && R.p3.spots, ["사이드바", "앱 찾기"], "P3 앱 화면만 — 세션 위젯 자리가 없다");
same(R.p4 && [R.p4.open, R.p4.tiles, R.p4.first, R.p4.firstOn, R.p4.sw], [true, 19, "AI가 처음 그린 그림", true, 9], "P4 펼치면 — 처음 그림(골라져 있음) + 기본 그림 18 · 색 9");
same(R.p5 && [R.p5.icon && R.p5.icon.path === R.p5.presetD, R.p5.icon && R.p5.icon.color, R.p5.icon && R.p5.icon.color_dark, R.p5.d === R.p5.presetD, R.p5.on, /완료 · 다음 단계로/.test(R.p5.sub || ""), R.p5.reset, R.p5.prompts, R.p5.saves],
  [true, ICON.color, ICON.color_dark, true, true, true, true, 0, 0], "P5 기본 그림 — 고른 것만 기록(색 그대로) · 미리보기 바뀜 · 저장 · AI 글 0건");
same(R.p6 && [R.p6.icon && R.p6.icon.path === R.p5.presetD, R.p6.icon && R.p6.icon.color, R.p6.swOn], [true, "#B0323F", true], "P6 색 — 그림 그대로 색만");
same(R.p7 && [R.p7.icon, R.p7.d, R.p7.firstOn], [null, ICON.path, true], "P7 「처음대로」 — 고른 것을 걷고 처음 그림으로");
same(R.p8 && [R.p8.sent, R.p8.iconLine, R.p8.ask, R.p8.app, R.p8.noSave, R.p8.locked, /그리는 중/.test(R.p8.status || "")], [1, true, true, true, true, true, true], "P8 AI 에게 부탁 — 글 1건 · 잠김 · 그리는 중");
same(R.p9 && [R.p9.badIcon, /그리는 중/.test(R.p9.status || ""), R.p9.icon && R.p9.icon.path, R.p9.ai, R.p9.first && R.p9.first[0], R.p9.first && R.p9.first[1], R.p9.d, R.p9.unlocked],
  [null, true, R.p9 && R.p9.newD, 1, "AI가 방금 그린 그림", true, R.p9 && R.p9.newD, true], "P9 틀린 답은 버리고 기다린다 · 맞는 답은 그림 목록 맨 앞에 골라져 선다");
same(R.p10 && [R.p10.saves, R.p10.icon, R.p10.recIcon, R.p10.stage], [1, { path: R.p9 && R.p9.newD, color: "#D5541F", color_dark: "#E7845B" }, null, "put"], "P10 「완료 · 다음 단계로」 — 마무리 저장에 아이콘이 실린다 · 기록에서 걷힌다");
same(R.p11 && [/아직 아이콘이 없어/.test(R.p11.sub || ""), R.p11.d === R.p11.liv], [true, true], "P11 아이콘 없는 앱 — 기본 그림이라고 말한다");
same(R.p5 && R.p5.focusK, R.p5 && "g:" + R.p5.presetD, "P5b 고른 뒤에도 포커스가 고른 그림 칸에 남는다(다시 그려도)");
same(R.p6 && R.p6.pressed, ["false", "false", "false", "true", "false", "false", "false", "false", "false"], "P6b 색 칸 — 고른 것만 aria-pressed");
same(R.p12, { icon: null, d: ICON.path }, "P12 고른 뒤 저장된 아이콘이 바뀌었으면 고른 것을 걷는다(새 아이콘을 덮지 않는다)");
same(R.p13, { icon: "M1 1h3", d: "M1 1h3" }, "P13 저장된 아이콘이 그대로면 고른 것을 지킨다");
same(R.p14 && /불러오지 못했어요/.test(R.p14.sub || ""), true, "P14 지금 아이콘을 못 읽으면 「없다」 고 하지 않는다");
same(R.errors, [], "W 페이지 예외 없음");

console.log(`studio-icon-runtime: ${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
