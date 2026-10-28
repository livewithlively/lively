#!/usr/bin/env node
// 대화창 — 셸 목록 밖 세션 화면(앱빌더 ③ 시험 세션)은 못 읽는 기록을 영영 되묻지 않는다(점검 3-12) · 그 화면의 안내 글(점검 6-3). 런타임.
//
// 원준 2026-10-29 «다 봤는데 그냥 싹 다 고쳐». 점검 3-12: 「세션 위젯으로 보기」 화면이 읽을 권한이 없거나 없는 기록을 몇 분 동안
//  수십 번 되물었다(403 · 404). 6-3: 그 화면의 안내 글이 터미널 칸 간격을 물려받아 글자마다 벌어졌고 «—» · 합니다체가 섞였다.
//
//  엣지 표(스크래치패드 spec-audit-g3.md R1 · R2 · U2):
//   R1 stopOnMissing · 기록 403 → 더 묻지 않는다(첫 읽기 포함 2번 안쪽)
//   R2 stopOnMissing · 기록 404 가 이어진다 → 유예(10번) 뒤로는 묻지 않는다(40초 · 80초 셈이 같다)
//   R2' 일반 세션 화면(stopOnMissing 없음) · 404 → 종전대로 계속 묻는다(회귀 가드)
//   U2 시험 세션 화면(.v2-try) 안의 빈 기록 안내 — «—» 없음 · 해요체 · 글자 간격 보통(letter-spacing normal) · 터미널 문법 화면(배선)
//
//  가짜는 «서버»(기록 · 큐 · 중앙 기록)뿐이다. 세션 화면은 실제 모듈(web/session-chat.ts)을 싣는다.
//  fail-first: `SRC_ROOT=<옛 트리>`(web/ · public/styles 가 있는 곳)로 옛 코드를 물린다. 크롬이 없는 면에서는 조용히 건너뛴다.
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 못 읽는 기록 되묻기 런타임 검증 미실행"); process.exit(0); }

const CSS = ["01-base.css", "03-components.css", "36-chat.css", "38-chat-tui.css", "40-v2.css"].map((f) => path.join(ROOT, "public/styles", f)).filter(existsSync);
const sc = buildSync({
  stdin: { contents: "export { mountSessionChat } from './web/session-chat.ts';", resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "SC", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;

async function PAGE_MAIN() {
  const R = {};
  const pageErrors = [];
  window.addEventListener("error", (e) => pageErrors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => pageErrors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
  const hits = {}; const STATUS = { "box-a": 404, "box-b": 404, "box-c": 403 };
  window.fetch = async (url) => {
    const u = new URL(String(url), location.href);
    if (/\/api\/ui\/v6\/sessions\/[^/]+\/log$/.test(u.pathname)) return J({ error: "아직 중앙 기록이 없습니다" }, 404);
    const m = /\/api\/ui\/terminal\/sessions\/([^/]+)\/(transcript|outbox)$/.exec(u.pathname);
    if (!m) return J({ error: "no" }, 404);
    const sid = decodeURIComponent(m[1]);
    if (m[2] === "outbox") return J({ items: [] });
    hits[sid] = (hits[sid] || 0) + 1;
    return J({ error: STATUS[sid] === 403 ? "이 세션 로그를 볼 권한이 없습니다" : "대화 기록 파일을 찾지 못했습니다" }, STATUS[sid] || 404);
  };
  localStorage.setItem("lively_ui_token", "t");
  const SC = (new Function(document.getElementById("src").textContent + "\n;return SC;"))();
  const live = (id) => ({ id, label: "「회의록」 앱 시험", live: true, alive: true, node: null, owned: true, stateKey: "idle", stateLabel: "쉬는 중",
    projectId: null, projectName: "", raw: { harness: "claude", chatMode: "tmux", runtimeMode: "terminal", chat: { read: true, answer: true },
      claudeSessionId: "uuid-" + id, agentState: "idle", lastActive: Math.floor(Date.now() / 1000) - 60 } });
  const mount = (id, opts, tryWrap) => {
    const box = document.createElement("div");
    box.style.cssText = "position:relative;width:900px;height:500px;display:flex;flex-direction:column;background:#fff";
    if (tryWrap) { const w = document.createElement("div"); w.className = "v2-try"; w.style.cssText = "position:relative;width:900px;height:500px"; w.append(box); document.body.append(w); }
    else document.body.append(box);
    SC.mountSessionChat(box, live(id), { terminalSrc: () => null, onResumed: () => {}, ...opts });
    return box;
  };
  try {
    const boxA = mount("box-a", { stopOnMissing: true }, true);
    mount("box-b", {}, false);
    mount("box-c", { stopOnMissing: true }, true);
    await sleep(40000);
    const at40 = { ...hits };
    await sleep(40000);
    R.counts = { at40, at80: { ...hits } };
    const p = boxA.querySelector(".sc-empty p");
    R.u2 = { tui: !!boxA.querySelector(".livc-tui"), text: p ? p.textContent : null, ls: p ? getComputedStyle(p).letterSpacing : null };
  } catch (e) { R.err = String(e && e.stack || e); }
  R.pageErrors = pageErrors;
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const page = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out" style="position:fixed;left:-9999px">PENDING</pre>
<script type="text/plain" id="src">${sc.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;
const dom = await dumpDom(chrome, { html: page, serve: true, prefix: "chat-stop-missing-", virtualTimeBudget: 120000, args: ["--window-size=1200,1600"], copy: CSS });
const res = readOut(dom);
if (res.text === null) { console.error(`FAIL  페이지가 결과를 안 냈다(out=${JSON.stringify(res.out)}): ${dom.slice(0, 400)}`); process.exit(1); }
const R = JSON.parse(res.text);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const check = (cond, n, got) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} :: 실제 ${JSON.stringify(got)}`); } };
if (R.fatal || R.err) { fail++; console.error(`FAIL  페이지가 던졌다: ${String(R.fatal || R.err).split("\n").slice(0, 3).join(" | ")}`); }
const c = R.counts || { at40: {}, at80: {} };
check((c.at80["box-a"] || 0) >= 1 && (c.at80["box-b"] || 0) >= 1 && (c.at80["box-c"] || 0) >= 1, "배선 — 가짜 서버가 세 화면의 기록 요청을 받았다", c);
check((c.at80["box-c"] || 0) <= 2, "R1 시험 세션 화면 · 기록 403 → 더 묻지 않는다", c);
check((c.at80["box-a"] || 0) <= 12 && c.at80["box-a"] === c.at40["box-a"], "R2 시험 세션 화면 · 기록 404 가 이어지면 유예 뒤로는 묻지 않는다", c);
check((c.at80["box-b"] || 0) > (c.at40["box-b"] || 0) && (c.at80["box-b"] || 0) > 12, "R2' 일반 세션 화면은 종전대로 계속 묻는다", c);
check(R.u2 && R.u2.tui, "U2 배선 — 터미널 문법 화면이다", R.u2);
check(R.u2 && R.u2.text && !/—/.test(R.u2.text) && !/습니다/.test(R.u2.text) && /요\.$/.test(R.u2.text.trim()), "U2 안내 글 — «—» · 합니다체 없이 해요체", R.u2);
check(R.u2 && R.u2.ls === "normal", "U2 시험 세션 화면의 안내 글은 글자 간격 보통", R.u2);
check(!(R.pageErrors || []).length, "W 페이지 예외 없음", R.pageErrors);
console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
