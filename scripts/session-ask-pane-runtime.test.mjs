#!/usr/bin/env node
// 세션 사이드바의 «요청» 탭(#5713, 런타임) — 실제 셸(web/v2/panes.ts mountPanes)을 헤드리스 크롬에 세우고, 가짜 서버가 주는
//  요청 목록에 따라 탭이 서고 켜지고 걷히는지 · 카드가 답을 어디로 보내는지 잰다.
//
//  세션 요청 = 세션의 AI 가 사람에게 화면으로 받는 것(값 입력 · 고르기 · 파일 올리기). 종전엔 리브 세션 대화창에만 떴다.
//  이제 **요청을 건 그 세션 화면의 사이드바**에 «요청» 탭으로 선다(배치에 저장하지 않는 탭 — 요청이 있을 때만).
//
// 사양(엣지 표 — 행마다 단언 하나 이상):
//  Q1  열린 요청이 없는 세션                          → «요청» 탭이 없다 · 기본 탭이 켜져 있다
//  Q2  열린 요청이 있는 세션을 연다                    → 탭이 맨 앞에 서고 **켜져 있다** · 종류마다 카드가 선다 · 탭에 × 가 없다
//  Q3  다른 탭을 보는 중에 요청이 새로 걸린다           → «요청» 탭이 켜진다 · 여럿이면 이름에 개수(«요청 2»)
//  Q4  같은 목록을 다시 읽는다(되묻기)                 → 카드 노드가 그대로다(치던 값 · 고른 것이 남는다) · 보던 탭을 뺏지 않는다
//  Q5  값을 넣고 [저장]                               → 그 요청의 submit 로 값만 간다 · 한 마디는 서버 tell 로 · 목록이 비면 탭이 걷힌다
//  Q6  요청이 하나 줄었다(둘 → 하나)                   → 탭은 남고 이름이 «요청» 으로 · 남은 카드는 그대로
//  Q7  배치 저장본                                    → «요청» 탭(sessask)이 저장되지 않는다
//  Q8  화면이 모르는 종류                             → 되는 척하지 않는다: «새로고침» 안내 카드 · [나중에] 는 있다
//  Q9  목록 요청                                      → 그 세션 id 로만 묻는다(다른 세션 것을 섞어 그리지 않는다)
//  Q10 주소에서 짚으러 왔다(focusAsk) — 다른 탭을 보는 중 → «요청» 탭이 켜지고 그 카드가 밝혀진다
//  Q11 [나중에]                                       → 그 요청의 dismiss 로 간다 · 값은 안 간다
//  Q12 세션이 없는 화면(새 세션 자리)                   → 묻지도 않고 탭도 없다(새로 도입한 세션 id 가 **비었을 때**)
//
// 왜 런타임인가: 탭이 서고 켜지는 것은 셸의 배치 · 구독 · 그리기가 맞물린 결과다 — 소스 글만으로는 «있지만 안 켜진다» 를 못 본다.
// fail-first(2026-11-23): PANES_ASK_MUT=nobringup(새 요청에도 탭을 안 켠다)이면 Q2 · Q3 가, PANES_ASK_MUT=nofocus(짚으러 온 신호를 셸이
//  안 듣는다)이면 Q10 이, ASK_REG_MUT=rebuild(카드를 매번 다시 만든다)이면 Q3(치던 값) · Q6(남은 카드)이 빨간불이었다. Q10 은 처음 쓴 구현에서도 빨갰다 —
//  탭이 이미 서 있고 목록이 그대로면 구독이 다시 불리지 않아 탭이 안 켜졌다(그래서 셸이 신호를 따로 듣게 했다).
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — «요청» 탭 런타임 검증 미실행"); process.exit(0); }
const CSS = ["01-base.css", "03-components.css", "20-dashboard.css", "35-liv.css", "40-v2.css", "42-v2-dock.css", "42-v2-panes.css", "45-v2-side-swap.css", "49-v2-ctx.css"]
  .map((f) => path.join(ROOT, "public/styles", f)).filter(existsSync);

//  fail-first 용 변형 — 환경변수로 켠다(평소엔 원본 그대로).
const mutate = {
  name: "ask-mutate",
  setup(b) {
    b.onLoad({ filter: /web\/v2\/panes\.ts$/ }, (a) => {
      let s = readFileSync(a.path, "utf8");
      if (process.env.PANES_ASK_MUT === "nobringup") {
        const old = "if (added.length || !had || (wanted && asks.some((a) => a.id === wanted))) { bringUp(z, SESSASK_TAB); return; }";
        if (!s.includes(old)) throw new Error("변형할 줄을 못 찾았다(panes.ts)");
        s = s.replace(old, "");
      }
      if (process.env.PANES_ASK_MUT === "nofocus") {
        const old = "if (!id || !sessAskIds.has(id)) return;";
        if (!s.includes(old)) throw new Error("변형할 줄을 못 찾았다(panes.ts onAskFocus)");
        s = s.replace(old, "return;");
      }
      return { contents: s, loader: "ts" };
    });
    b.onLoad({ filter: /web\/asks\/registry\.ts$/ }, (a) => {
      let s = readFileSync(a.path, "utf8");
      if (process.env.ASK_REG_MUT === "rebuild") {
        const old = "if (!id || want.get(id) !== c.dataset.askSig) c.remove(); else have.set(id, c);";
        if (!s.includes(old)) throw new Error("변형할 줄을 못 찾았다(registry.ts)");
        s = s.replace(old, "c.remove();");
      }
      return { contents: s, loader: "ts" };
    });
  },
};
const bundle = (await build({   // 변형 플러그인을 쓰려고 비동기 build 다(buildSync 는 플러그인을 못 쓴다)
  stdin: { contents: [
    "export { mountPanes } from './web/v2/panes.ts';",
    "export { refreshAsks } from './web/asks/api.ts';",
    "export { focusAsk } from './web/v2/session-ask-pane.ts';",
  ].join("\n"), resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "PN", write: false, platform: "browser", target: "es2020", logLevel: "silent", plugins: [mutate],
})).outputFiles[0].text;

async function PAGE_MAIN() {
  const R = {};
  const pageErrors = [];
  window.addEventListener("error", (e) => pageErrors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => pageErrors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const waitFor = async (fn, ms = 3000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { try { if (fn()) return true; } catch (_) { /* 아직 */ } await sleep(20); } return false; };
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
  const LAYOUT = "lively_panes_layout_v2";

  // ── 가짜 서버 — 세션마다 열린 요청 목록 · 화면이 보낸 것 기록 ──
  const ASKS = {};                       // sid → 요청[]
  const calls = { list: [], submit: [], tell: [], dismiss: [] };
  const mk = (id, kind, sid, payload, extra = {}) => ({ id, kind, kind_label: { secret: "값 입력", choice: "고르기", upload: "파일 올리기" }[kind] || "새 종류", title: payload.label || payload.question || kind,
    session_id: sid, status: "open", created_at: "2026-11-23T00:00:00.000Z", resolved_at: null, payload, result: null, ...extra });
  window.fetch = async (url, init) => {
    const u = new URL(url, "http://x/");
    const method = (init && init.method) || "GET";
    if (u.pathname === "/api/ui/me/asks") { const s = u.searchParams.get("session"); calls.list.push(s); return J({ asks: s ? (ASKS[s] || []) : Object.values(ASKS).flat() }); }
    const it = /^\/api\/ui\/me\/asks\/item\/([^/]+)\/(submit|tell|dismiss)$/.exec(u.pathname);
    if (it && method === "POST") {
      const id = decodeURIComponent(it[1]); const body = JSON.parse((init && init.body) || "{}");
      calls[it[2]].push({ id, body });
      if (it[2] === "submit" || it[2] === "dismiss") for (const s of Object.keys(ASKS)) ASKS[s] = ASKS[s].filter((a) => a.id !== id);
      if (it[2] === "submit") return J({ ok: true, ask: { id, status: "done" }, say: "«" + id + "» 값을 저장했어요." });
      if (it[2] === "tell") return J({ delivered: true });
      return J({ ask: { id, status: "dismissed" }, dismissed: true });
    }
    if (u.pathname === "/api/ui/apps") return J({ apps: [] });
    if (/^\/api\/ui\/terminal\/sessions\/[^/]+\/apps$/.test(u.pathname)) return J({ apps: [] });
    if (u.pathname === "/api/ui/org/connect-status") return J({ apps: [] });
    const mm = /\/projects\/(\d+)(\/.*)?$/.exec(u.pathname);
    if (mm && mm[2] === "/files") return J({ items: [] });
    if (mm && !mm[2]) return J({ project: { id: Number(mm[1]), name: "P", status_category: "started" } });
    return J({ error: "no" }, 404);
  };
  localStorage.setItem("lively_ui_token", "t");
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe(e) { setTimeout(() => this.cb([{ target: e, isIntersecting: true }]), 0); } unobserve() {} disconnect() {} };

  const PN = (new Function(document.getElementById("pfsrc").textContent + "\n;return PN;"))();
  let handle = null;
  const mount = async (sid) => {
    if (handle) { try { handle.destroy(); } catch (_) { /* 이미 */ } handle = null; }
    document.getElementById("app")?.remove();
    const host = document.createElement("div");
    host.id = "app"; host.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;display:flex;flex-direction:column;background:var(--bg)";
    document.body.append(host);
    handle = PN.mountPanes(host, { id: 7, detail: { project: { id: 7, name: "P" } }, data: () => ({ projects: [{ id: 7, name: "P" }], sessions: [], loadedAt: Date.now() }), sessionId: sid, onOpenDrawer: () => {}, onCloseDrawer: () => {} });
    await sleep(400);
  };
  const tabs = () => $$('#app .pn-pane[data-zone="side"] .pn-tab').map((b) => b.getAttribute("aria-label"));
  const act = () => $$('#app .pn-pane[data-zone="side"] .pn-tab').find((b) => b.getAttribute("aria-selected") === "true")?.getAttribute("aria-label") || null;
  const tabBtn = (nm) => $$('#app .pn-pane[data-zone="side"] .pn-tab').find((b) => b.getAttribute("aria-label") === nm);
  const askTab = () => $$('#app .pn-pane[data-zone="side"] .pn-tabwrap').find((w) => w.dataset.tab === "sessask") || null;
  const cards = () => $$("#app .pn-sessask .ask-card");
  const shown = (el) => !!el && !el.hidden && el.getClientRects().length > 0;
  const SEC = (id, sid) => mk(id, "secret", sid, { kind: "secret", target: "vault", vault_kind: "notion_token", vault_scope: "", label: "Notion 토큰", why: "노션을 읽으려고요", dest: "이 값은 내 개인 금고의 «Notion 토큰» 칸에 저장됩니다." });
  const CHO = (id, sid) => mk(id, "choice", sid, { kind: "choice", question: "A 안 / B 안?", multi: true, options: [{ id: "a", label: "A 안" }, { id: "b", label: "B 안" }] });

  try {
    // ── Q1 · Q12 ──
    localStorage.removeItem(LAYOUT);
    await mount("box-q-00000001");
    R.q1 = { tabs: tabs(), act: act(), askTab: !!askTab(), listed: calls.list.slice() };
    calls.list.length = 0;
    await mount(null);
    R.q12 = { askTab: !!askTab(), listed: calls.list.slice() };

    // ── Q2 열린 요청이 있는 세션을 연다 ──
    ASKS["box-q-00000002"] = [SEC("ask_sec1", "box-q-00000002"), CHO("ask_cho1", "box-q-00000002")];
    ASKS["box-other-0000000f"] = [SEC("ask_other", "box-other-0000000f")];
    calls.list.length = 0;
    await mount("box-q-00000002");
    await waitFor(() => cards().length === 2);
    const w = askTab();
    R.q2 = { tabs: tabs(), act: act(), kinds: cards().map((c) => c.dataset.askKind), ids: cards().map((c) => c.dataset.askId), hasX: !!(w && w.querySelector(".pn-tab-x")), paneShown: shown($("#app .pn-sessask")),
      dest: $("#app .pn-sessask .liv-ask-dest")?.textContent || null };
    R.q9 = { listed: [...new Set(calls.list)] };
    R.q7 = { saved: JSON.stringify(JSON.parse(localStorage.getItem(LAYOUT) || "{}")).includes("sessask") };

    // ── Q4 같은 목록을 다시 읽는다 — 치던 값 · 고른 것이 남는다 · 보던 탭을 뺏지 않는다 ──
    const inp = $("#app .pn-sessask .ask-card[data-ask-kind=secret] .liv-ask-input");
    inp.value = "typing-secret"; inp.dispatchEvent(new Event("input", { bubbles: true }));
    const pick = $("#app .pn-sessask .ask-card[data-ask-kind=choice] .liv-pick"); pick.click();
    const nodesBefore = cards();
    const other = tabs().find((n) => n !== act());
    tabBtn(other).click(); await sleep(80);
    PN.refreshAsks("box-q-00000002"); await sleep(250);
    const nodesAfter = cards();
    R.q4 = { sameNodes: nodesBefore.length === 2 && nodesBefore.every((n, i) => n === nodesAfter[i]), value: $("#app .pn-sessask .liv-ask-input")?.value, picked: $$("#app .pn-sessask .liv-pick.on").length, actStays: act() === other, other };

    // ── Q3 다른 탭을 보는 중에 요청이 새로 걸린다 ──
    ASKS["box-q-00000002"] = [...ASKS["box-q-00000002"], CHO("ask_cho2", "box-q-00000002")];
    PN.refreshAsks("box-q-00000002"); await waitFor(() => cards().length === 3);
    R.q3 = { act: act(), tabs: tabs(), n: cards().length, keptValue: $("#app .pn-sessask .liv-ask-input")?.value };

    // ── Q10 주소에서 짚으러 왔다 — 다른 탭을 보는 중 ──
    tabBtn(other).click(); await sleep(80);
    const before10 = act();
    PN.focusAsk("ask_cho2");            // 목록은 그대로다(다시 읽지 않는다) — 탭이 이미 서 있어도 켜져야 한다
    PN.focusAsk("ask_other");           // 다른 세션의 요청 id — 이 셸은 움직이지 않는다(아래 flashed 가 여전히 ask_cho2)
    await waitFor(() => !!$("#app .pn-sessask .ask-card.ask-flash"), 1500);
    R.q10 = { before: before10, act: act(), flashed: $("#app .pn-sessask .ask-card.ask-flash")?.dataset.askId || null };

    // ── Q11 [나중에] ──
    $('#app .pn-sessask .ask-card[data-ask-id="ask_cho2"] .liv-ask-later').click();
    await waitFor(() => cards().length === 2);
    R.q11 = { dismiss: calls.dismiss.slice(), submits: calls.submit.length, n: cards().length };

    // ── Q5 값을 넣고 저장 — submit 몸통 · tell · (둘 → 하나: Q6) ──
    const inp2 = $("#app .pn-sessask .ask-card[data-ask-kind=secret] .liv-ask-input");
    inp2.value = "ntn_runtime_value"; inp2.dispatchEvent(new Event("input", { bubbles: true }));
    const keepNode = $('#app .pn-sessask .ask-card[data-ask-id="ask_cho1"]');
    $("#app .pn-sessask .ask-card[data-ask-kind=secret] .liv-ask-go").click();
    await waitFor(() => cards().length === 1);
    R.q5 = { submit: calls.submit.slice(), tell: calls.tell.slice() };
    R.q6 = { tabs: tabs(), n: cards().length, sameNode: $('#app .pn-sessask .ask-card[data-ask-id="ask_cho1"]') === keepNode, askTab: !!askTab() };
    // 마지막 하나도 답한다 → 탭이 걷힌다
    $("#app .pn-sessask .ask-card[data-ask-kind=choice] .liv-pick-send").click();
    await waitFor(() => !askTab());
    R.q5.afterAll = { askTab: !!askTab(), tabs: tabs(), act: act(), lastSubmit: calls.submit[calls.submit.length - 1] };
    R.q7.savedAfter = JSON.stringify(JSON.parse(localStorage.getItem(LAYOUT) || "{}")).includes("sessask");

    // ── Q8 모르는 종류 ──
    ASKS["box-q-00000003"] = [mk("ask_new1", "sign_document", "box-q-00000003", { label: "계약서 서명" })];
    await mount("box-q-00000003");
    await waitFor(() => cards().length === 1);
    const c8 = cards()[0];
    R.q8 = { text: c8 ? c8.innerText : null, later: !!(c8 && c8.querySelector(".liv-ask-later")), reload: !!(c8 && [...c8.querySelectorAll("button")].some((b) => b.textContent === "새로고침")), unknown: !!(c8 && c8.classList.contains("ask-unknown")) };
  } catch (e) { R.err = String(e && e.stack || e); }
  R.pageErrors = pageErrors;
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const PAGE = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out">PENDING</pre>
<script type="text/plain" id="pfsrc">${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;
const dom = await dumpDom(chrome, { html: PAGE, copy: CSS, prefix: "sessask-pane-", virtualTimeBudget: 60000, args: ["--window-size=1400,900"] });
const res = readOut(dom);
if (res.text === null) { console.error(`FAIL  페이지가 결과를 안 냈다(out=${JSON.stringify(res.out)})\n` + dom.slice(0, 1500)); process.exit(1); }
const R = JSON.parse(res.text);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const J = (v) => JSON.stringify(v);
const check = (cond, n, got) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — 실제 ${J(got)}`); } };
if (R.fatal || R.err) { fail++; console.error(`FAIL  장면이 던졌다 — ${String(R.fatal || R.err).split("\n").slice(0, 3).join(" | ")}`); }
const q1 = R.q1 || {}, q2 = R.q2 || {}, q3 = R.q3 || {}, q4 = R.q4 || {}, q5 = R.q5 || {}, q6 = R.q6 || {}, q7 = R.q7 || {}, q8 = R.q8 || {}, q9 = R.q9 || {}, q10 = R.q10 || {}, q11 = R.q11 || {}, q12 = R.q12 || {};

check(Array.isArray(q1.tabs) && q1.tabs.length >= 2 && !q1.askTab && !q1.tabs.some((n) => /^요청/.test(n)) && !!q1.act && J(q1.listed) === J(["box-q-00000001"]),
  "Q1 열린 요청이 없는 세션엔 «요청» 탭이 없다(그 세션 것을 물어는 봤다 — 관측 장치)", q1);
check(Array.isArray(q2.tabs) && q2.tabs[0] === "요청 2" && q2.act === "요청 2" && q2.paneShown === true, "Q2 ★ 열린 요청이 있는 세션을 열면 «요청» 탭이 맨 앞에 서고 켜져 있다(여럿이면 개수)", q2);
check(J(q2.kinds) === J(["secret", "choice"]) && J(q2.ids) === J(["ask_sec1", "ask_cho1"]) && /내 개인 금고의 «Notion 토큰»/.test(q2.dest || ""), "Q2 종류마다 카드가 건 순서대로 선다 · 저장 위치 문장이 보인다", q2);
check(q2.hasX === false, "Q2 «요청» 탭엔 × 가 없다(닫는 탭이 아니라 다 하면 사라지는 탭)", q2.hasX);
check(q4.sameNodes === true && q4.value === "typing-secret" && q4.picked === 1, "Q4 ★ 같은 목록을 다시 읽어도 카드는 그대로다 — 치던 값 · 고른 것이 남는다", q4);
check(q4.actStays === true, "Q4 목록이 그대로면 사람이 보던 탭을 뺏지 않는다", q4);
check(q3.act === "요청 3" && q3.n === 3 && q3.keptValue === "typing-secret", "Q3 ★ 다른 탭을 보는 중에 요청이 새로 걸리면 «요청» 탭이 켜진다 — 치던 값은 그대로", q3);
check(q10.before !== q10.act && /^요청/.test(q10.act || "") && q10.flashed === "ask_cho2", "Q10 주소에서 짚으러 오면 «요청» 탭이 켜지고 그 카드가 밝혀진다", q10);
check(J(q11.dismiss) === J([{ id: "ask_cho2", body: {} }]) && q11.submits === 0 && q11.n === 2, "Q11 [나중에] 는 그 요청의 dismiss 로 간다 — 답(submit)은 안 간다", q11);
check(Array.isArray(q5.submit) && q5.submit.length >= 1 && q5.submit[0].id === "ask_sec1" && J(q5.submit[0].body) === J({ value: "ntn_runtime_value" }),
  "Q5 ★ [저장] 은 그 요청의 submit 로 값만 보낸다(넣을 자리는 화면이 싣지 않는다)", q5.submit);
check(Array.isArray(q5.tell) && q5.tell.some((t) => t.id === "ask_sec1" && !t.body.told), "Q5 그 세션 대화창이 이 화면에 없으면 한 마디는 서버가 넣는다(tell)", q5.tell);
check(q6.askTab === true && q6.n === 1 && q6.sameNode === true && Array.isArray(q6.tabs) && q6.tabs.includes("요청") && !q6.tabs.includes("요청 2"),
  "Q6 하나를 답해 줄면 탭은 남고 이름이 «요청» 으로 — 남은 카드는 그대로", q6);
check(!!q5.afterAll && q5.afterAll.askTab === false && !q5.afterAll.tabs.some((n) => /^요청/.test(n)) && !!q5.afterAll.act && J(q5.afterAll.lastSubmit) === J({ id: "ask_cho1", body: { choices: ["a"] } }),
  "Q5 다 답하면 «요청» 탭이 걷히고 다른 탭이 켜진다 · 고른 것이 submit 로 갔다", q5.afterAll);
check(q7.saved === false && q7.savedAfter === false, "Q7 «요청» 탭은 배치 저장본에 남지 않는다", q7);
check(q8.unknown === true && /새로고침/.test(q8.text || "") && /계약서 서명/.test(q8.text || "") && q8.later === true && q8.reload === true, "Q8 화면이 모르는 종류는 «새로고침» 안내 카드로 — 되는 척하지 않는다", q8);
check(J(q9.listed) === J(["box-q-00000002"]), "Q9 목록은 그 세션 id 로만 묻는다(다른 세션의 요청을 섞어 그리지 않는다)", q9);
check(q12.askTab === false && J(q12.listed) === "[]", "Q12 세션이 없는 화면(새 세션 자리)에선 묻지도 않고 탭도 없다", q12);
check(Array.isArray(R.pageErrors) && R.pageErrors.length === 0, "화면 오류 없음", R.pageErrors);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
