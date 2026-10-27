#!/usr/bin/env node
// 리브 객관식 물음 카드(#5059, 런타임) — 실제 카드 코드(web/liv-cards.ts livAskCard)를 헤드리스 크롬에 띄워 누르고, 서버로 간 몸통을 잰다.
//
//  계약(src/capabilities/delivery/liv.ts me_liv_answer): { choices: 저장된 선택지 id[], other?: 그 밖(≤200) }.
//   단일 선택(multi:false)은 **답이 하나**여야 하는데 서버는 «choices 둘 이상» 만 막는다 — choices 하나 + other 는 받아 버린다.
//   그래서 «하나만» 은 화면이 지켜야 한다(격리 리뷰 지적 2026-10-27: 알약을 켜 둔 채 선택지를 누르면 둘 다 갔다).
//
//  엣지 표(행마다 장면 하나):
//   C1  단일 · 알약(Zotero) 켬 → 선택지 누름          → choices [notion] · other 없음
//   C2  단일 · 이름 적음 → 선택지 누름                  → choices [notion] · other 없음
//   C3  단일 · 알약 켬 → 이름 적음 → [이걸로]           → choices [] · other «카카오톡» 만(알약은 꺼진다)
//   C4  복수 · 선택지 둘 + 알약 + 적은 이름 → [이걸로]  → choices 둘 · other «Zotero, 카카오톡»
//   C5  단일 · 보내는 중에 다른 선택지를 또 누름         → POST 한 번
//   C6  «연결됨» — Gmail·드라이브는 둘 다 «Google» 한 줄 → 두 카드 모두 «연결됨»
//   C7  다른 앱 알약 — 준비가 필요한 앱(길 없음)은 «연결할 수 있는 다른 앱» 에 안 선다 · 목록에 이미 있는 앱도 안 선다
//   C8  앱 선택지는 공식 로고 타일(.svc-tile[data-svc]) · 앱 질문이 아니면 타일이 없다
//   C9  알약을 고른 채 [+ 다른 앱]을 다시 눌러도 접히지 않는다(접힌 채 보내지면 무엇이 갔는지 못 본다)
//  fail-first: `SRC_ROOT=<옛 트리>`(e312d42d1 — 리뷰 반영 전)로 물리면 C1 · C2 · C3 · C5 · C6 · C7 · C9 가 빨갛다(실측).
//   크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 리브 객관식 카드 런타임 검증 미실행"); process.exit(0); }

const CSS = ["01-base.css", "03-components.css", "34-service-logins.css", "35-liv.css"].map((f) => path.join(ROOT, "public/styles", f)).filter(existsSync);
const sc = buildSync({
  stdin: { contents: "export { livAskCard } from './web/liv-cards.ts';", resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "LC", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;

async function PAGE_MAIN() {
  const R = { errors: [] };
  window.addEventListener("error", (e) => R.errors.push(String(e.message || e)));
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const route = (state) => ({ app_ready: true, routes: [{ kind: "app", state }], recommended: 0, blocked_before: [] });
  const APPS = [
    { app: "notion", label: "Notion", ...route("connect") },
    { app: "slack", label: "Slack", ...route("connect") },
    { app: "google", label: "Google", ...route("collecting") },
    { app: "zotero", label: "Zotero", ...route("connect") },
    { app: "figma", label: "Figma", app_ready: null, routes: [], recommended: null, blocked_before: [] },   // 길 없음 → 준비 필요
  ];
  let posts = []; let answerDelay = 0;
  window.fetch = async (u, o) => {
    const url = String(u);
    if (url.includes("connect-status")) return new Response(JSON.stringify({ apps: APPS }), { headers: { "content-type": "application/json" } });
    if (url.includes("liv-answer")) {
      const b = JSON.parse(o.body); posts.push(b);
      if (answerDelay) await sleep(answerDelay);
      return new Response(JSON.stringify({ ok: true, labels: b.choices, other: b.other }), { headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { headers: { "content-type": "application/json" } });
  };
  const hooks = { say() {}, refresh() {}, fill() {} };
  const OPTS = [{ id: "notion", label: "Notion" }, { id: "slack", label: "슬랙" }, { id: "gmail", label: "메일(Gmail)" }, { id: "gdrive", label: "구글 드라이브" }];
  const mount = async (multi, opts = OPTS) => {
    const host = document.createElement("div"); document.body.append(host);
    host.append(LC.livAskCard({ kind: "choice", key: "connect_apps", question: "Q", multi, allow_other: true, options: opts }, hooks));
    await sleep(80);   // connect-status 가 와서 «연결됨» · 알약이 선다
    const q = (s) => host.querySelector(s);
    const qa = (s) => [...host.querySelectorAll(s)];
    const opt = (label) => qa(".liv-pick:not(.liv-pick-add)").find((b) => b.textContent.includes(label));
    const chip = (name) => qa(".liv-pick-chip").find((b) => b.textContent.includes(name));
    const type = (t) => { const i = q(".liv-pick-in"); i.value = t; i.dispatchEvent(new Event("input")); };
    const openMore = () => q(".liv-pick-add").click();
    return { host, q, qa, opt, chip, type, openMore };
  };
  const last = () => posts[posts.length - 1] || null;

  { posts = []; const c = await mount(false); c.openMore(); c.chip("Zotero").click(); c.opt("Notion").click(); await sleep(30);
    R.c1 = { n: posts.length, body: last() }; c.host.remove(); }
  { posts = []; const c = await mount(false); c.openMore(); c.type("카카오톡"); c.opt("Notion").click(); await sleep(30);
    R.c2 = { n: posts.length, body: last() }; c.host.remove(); }
  { posts = []; const c = await mount(false); c.openMore(); c.chip("Zotero").click(); c.type("카카오톡");
    const chipOn = c.chip("Zotero").classList.contains("on"); c.q(".liv-pick-send").click(); await sleep(30);
    R.c3 = { n: posts.length, body: last(), chipOn }; c.host.remove(); }
  { posts = []; const c = await mount(true); c.opt("Notion").click(); c.opt("슬랙").click(); c.openMore(); c.chip("Zotero").click(); c.type("카카오톡");
    c.q(".liv-pick-send").click(); await sleep(30);
    R.c4 = { n: posts.length, body: last() }; c.host.remove(); }
  { posts = []; answerDelay = 200; const c = await mount(false); c.opt("Notion").click(); await sleep(10); c.opt("슬랙").click(); await sleep(260);
    R.c5 = { n: posts.length }; answerDelay = 0; c.host.remove(); }
  { const c = await mount(true);
    const st = (label) => (c.opt(label)?.querySelector(".liv-pick-st")?.textContent || "");
    R.c6 = { gmail: st("Gmail"), drive: st("드라이브"), notion: st("Notion") };
    c.openMore();
    R.c7 = { chips: c.qa(".liv-pick-chip").map((b) => b.textContent.trim()) };
    R.c8 = { svc: c.qa(".liv-pick .svc-tile[data-svc]").map((t) => t.getAttribute("data-svc")) };
    c.chip("Zotero").click(); c.q(".liv-pick-add").click();
    R.c9 = { hidden: c.q(".liv-pick-more").hidden }; c.host.remove(); }
  { const c = await mount(false, [{ id: "sales", label: "영업" }, { id: "product", label: "제품" }]);
    R.c8.plainTiles = c.qa(".svc-tile").length; c.host.remove(); }

  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const page = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><pre id="out" style="position:fixed;left:-9999px">PENDING</pre>
<script>${sc.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;

const dom = await dumpDom(chrome, { html: page, serve: true, prefix: "liv-choice-", virtualTimeBudget: 20000, timeoutMs: 120000, args: ["--window-size=1100,900"], copy: CSS });
const res = readOut(dom);
if (res.text === null) { console.error(`FAIL  페이지가 결과를 안 냈다(out=${JSON.stringify(res.out)}): ${dom.slice(0, 300)}`); process.exit(1); }
const R = JSON.parse(res.text);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const check = (cond, n, got) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} :: 실제 ${JSON.stringify(got)}`); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (R.fatal) { fail++; console.error(`FAIL  페이지가 던졌다: ${String(R.fatal).split("\n").slice(0, 3).join(" | ")}`); }
check(!R.errors || R.errors.length === 0, "페이지 오류 0", R.errors);
check(R.c1?.n === 1 && same(R.c1.body?.choices, ["notion"]) && !R.c1.body?.other, "C1 ★ 단일 — 알약을 켜 둔 채 선택지를 누르면 선택지만 간다", R.c1);
check(R.c2?.n === 1 && same(R.c2.body?.choices, ["notion"]) && !R.c2.body?.other, "C2 ★ 단일 — 이름을 적어 둔 채 선택지를 누르면 선택지만 간다", R.c2);
check(R.c3?.n === 1 && same(R.c3.body?.choices, []) && R.c3.body?.other === "카카오톡" && R.c3.chipOn === false, "C3 단일 — 알약 뒤에 이름을 적으면 적은 이름 하나만(알약은 꺼진다)", R.c3);
check(R.c4?.n === 1 && same(R.c4.body?.choices, ["notion", "slack"]) && R.c4.body?.other === "Zotero, 카카오톡", "C4 복수 — 선택지 둘 + 알약 + 적은 이름이 모두 간다", R.c4);
check(R.c5?.n === 1, "C5 ★ 단일 — 보내는 중의 두 번째 클릭은 두 번째 답이 되지 않는다", R.c5);
check(R.c6?.gmail === "연결됨" && R.c6?.drive === "연결됨" && R.c6?.notion === "", "C6 «연결됨» — 같은 앱(Google)의 두 카드 모두 · 안 된 앱엔 없음", R.c6);
check(same(R.c7?.chips, ["Zotero"]), "C7 다른 앱 알약 — 준비 필요(Figma)·이미 목록에 있는 앱(Notion·Slack·Google)은 빠지고 Zotero 만", R.c7);
check(same(R.c8?.svc, ["notion", "slack", "google-gmail", "google-drive"]) && R.c8?.plainTiles === 0, "C8 앱 선택지는 공식 로고 타일 · 앱 질문이 아니면 타일 없음", R.c8);
check(R.c9?.hidden === false, "C9 알약을 고른 채로는 [+ 다른 앱]이 접히지 않는다", R.c9);
console.log(`\n${fail ? "✗" : "✓"} liv-choice-card-runtime: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
