#!/usr/bin/env node
// 앱빌더 ③ 실제 화면 위 코멘트 막대 — 고침을 기다리다 AI 가 멈추면 시계를 세우고 앱빌더 막대와 같은 말 · 같은 단추(#4632) · 런타임 회귀 테스트(헤드리스 크롬).
//
// 원준 2026-10-28 «중간에 안됐는데 수정중 하면서 시간 세고있으면 어떡해» — 실제 화면의 막대도 «AI 수정 중 m:ss» 를 계속 셌다.
//
// 엣지 표:
//  R1 고침을 기다림 — 「AI 수정 중 0:0x」 가 센다 · 눌리지 않는다
//  R2 멈춤이 옴(resume) — 「이어서 수정하기」 · 눌린다 · 도움말이 그 까닭 · 5초 뒤에도 같은 글(시계가 서 있다)
//  R3 「이어서 수정하기」 를 누르면 onResume 1번(onSend 는 안 간다)
//  R4 멈춤이 오되 이어 할 수 없음(컴퓨터가 꺼짐) — 단추 잠김
//  R5 멈춤이 걷힘 — 시계가 그때부터 다시 센다
//  R6 새 버전이 옴(waiting false) — 「수정하기 · n건」 으로 돌아온다   W 페이지 예외 없음
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 코멘트 막대 멈춤 런타임 검증 미실행"); process.exit(0); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const ENTRY = "export * from './v2/app-review.ts';";
const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=Rv", "--platform=browser", "--loader=ts", "--sourcefile=review-entry.ts",
  "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { cwd: WEB, input: ENTRY, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");

async function PAGE_MAIN() {
  const R = {}; const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => errors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const calls = [];
  const host = { appId: "mn", title: "회의록", route: location.hash || "#/i/x", pins: [{ kind: "pin", x: 0.2, y: 0.3, where: "제목", note: "더 크게" }], general: "",
    version: 2, waiting: false, chat: document.getElementById("chat"),
    onTalk: async () => true, onChange: () => {}, onSend: () => calls.push("send"), onLike: () => {}, onBack: () => {}, onResume: () => calls.push("resume") };
  location.hash = host.route;
  const api = Rv.openReview(host);
  const send = () => [...document.querySelectorAll(".v2-review-bar .v2-studio-now-pri")].pop();
  const v = () => ({ send: send().textContent, off: send().disabled, hint: ($(".v2-review-hint") || {}).textContent || "" });
  const STALL = "AI가 끝내지 못하고 멈췄어요. 「이어서 수정하기」를 누르면 멈춘 곳부터 다시 해요.";

  window.__step = "R1";
  api.update({ waiting: true }); await sleep(3200);
  R.r1 = v();
  window.__step = "R2";
  api.update({ stall: { text: STALL, resume: true } }); await sleep(300);
  R.r2 = { a: v() }; await sleep(5000); R.r2.b = v();
  window.__step = "R3";
  send().click(); await sleep(100);
  R.r3 = calls.slice();
  window.__step = "R4";
  api.update({ stall: { text: "세션이 돌던 컴퓨터가 꺼져 있거나 잠들어 있어서 AI가 멈췄어요.", resume: false } }); await sleep(300);
  R.r4 = v();
  window.__step = "R5";
  api.update({ stall: null }); await sleep(2200);
  R.r5 = v();
  window.__step = "R6";
  api.update({ waiting: false }); await sleep(300);
  R.r6 = v();
  api.close();
  R.errors = errors;
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css")}</style></head><body>
<div id="side" class="v2-studio-side"><div id="chat" class="v2-studio-chat"></div></div>
<div id="out"></div>
<script>${bundle}</script>
<script>(${PAGE_MAIN.toString()})().catch((e) => { document.getElementById("out").textContent = "RESULT" + JSON.stringify({ crash: (window.__step || "") + " " + String((e && e.stack) || e).slice(0, 900) }) + "ENDRESULT"; });</script>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "review-stall-", virtualTimeBudget: 60000, args: ["--window-size=1400,900"] });
const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-800)); process.exit(1); }
const R = JSON.parse(m[1]);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));
if (R.crash) { console.error("FAIL  페이지가 도중에 넘어졌다 — " + R.crash); process.exit(1); }

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "") => (cond ? ok(n) : bad(n, typeof why === "string" ? why : JSON.stringify(why)));
const same = (got, want, n) => { const a = JSON.stringify(got), b = JSON.stringify(want); return a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };

check(R.r1 && /^AI 수정 중 0:0[2-4]$/.test(R.r1.send) && R.r1.off, "R1 고침을 기다림 — 시계가 센다 · 눌리지 않는다", R.r1);
check(R.r2 && R.r2.a.send === "이어서 수정하기" && !R.r2.a.off && /끝내지 못하고 멈췄어요/.test(R.r2.a.hint), "R2 멈춤 — 「이어서 수정하기」 · 도움말이 그 까닭", R.r2 && R.r2.a);
check(R.r2 && R.r2.b.send === "이어서 수정하기" && R.r2.b.hint === R.r2.a.hint, "R2 5초 뒤에도 같은 글(«AI 수정 중 m:ss» 로 돌아가지 않는다)", R.r2 && R.r2.b);
same(R.r3, ["resume"], "R3 누르면 onResume 만(새 고침을 보내지 않는다)");
check(R.r4 && R.r4.send === "이어서 수정하기" && R.r4.off && /컴퓨터가 꺼져/.test(R.r4.hint), "R4 이어 할 수 없는 멈춤 — 단추 잠김", R.r4);
check(R.r5 && /^AI 수정 중 0:0[1-3]$/.test(R.r5.send) && R.r5.off, "R5 멈춤이 걷히면 시계가 그때부터", R.r5);
check(R.r6 && /^수정하기 · 1건$/.test(R.r6.send) && !R.r6.off, "R6 새 버전이 오면 「수정하기 · n건」 으로", R.r6);
same(R.errors, [], "W  페이지 예외 없음");

console.log(`\n#4632 코멘트 막대 멈춤: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
