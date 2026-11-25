#!/usr/bin/env node
// 대화창 — 세션이 **일하던 중에** 끊긴 턴은 끊겼다고 말한다(#5580 후속). 런타임.
//
// 원준 2026-11-19 «끝난 이유를 알 수 없는 세션이에요 → 이거 뜨면 또 맨 마지막 대화 내용이 보이는게 아니라 그 이전에 보이는듯».
//  실측(GovTech 멘토 미팅 세션, 매니지드): 14:45 «…지우기 전에 폴더를 살펴보고 있습니다» 를 쓴 뒤 질문·답·삭제를 다 하고 15:01 명령을
//  돌리던 중 세션이 사라졌다(기록: «the session ended before this call's result was recorded»). 마지막 답은 애초에 없었다 — 화면은
//  끊긴 턴을 정상으로 끝난 턴처럼 조용히 마감해, 14:45 의 진행 문장이 그 일의 결론처럼 보였다.
//
//  엣지 표:
//   C1  꺼짐 · 사라짐(lost) · 마지막 턴에 끝 줄 없음(마지막 도구 결과도 없음) · 박스 기록   → 그 턴 끝에 «끊겼어요» 한 줄
//   C2  꺼짐 · lost · 마지막 턴이 끝 줄(turn_duration)로 끝났다                          → 줄 없음
//   C3  꺼짐 · 시스템이 껐다(reclaim) · 끝 줄 없음                                       → 줄 없음(끊겼다고 단정하지 않는다)
//   C4  꺼짐 · 사람이 끝냈다(stop) · 끝 줄 없음                                          → 줄 없음
//   C5  살아서 도는 중                                                                   → 줄 없음(도는 중 표시)
//   C6  보는 중에 꺼진다 · 사유가 늦게 온다(살아 있음 → 꺼짐·사유 없음 → 꺼짐·lost → 같은 행 한 번 더) → 사유가 온 뒤 한 줄 · 한 번만
//   C7  꺼짐 · 사유 기록 없음 + 일하던 중 꺼짐(lastRun working)                           → 한 줄
//   C8  대화 화면(desktop look) · C1 과 같은 기록                                         → 한 줄
//   C9  꺼짐 · lost · 끝 줄 없음 · 박스 기록이 없어 중앙 기록으로 읽었다(끝 줄을 안 담는 기록) → 줄 없음
//   C10 꺼짐 · 사유를 모른다(아무 기록 없음)                                               → 줄 없음
//
//  가짜는 «서버»(기록 · 큐 · 중앙 기록)뿐이다. 세션 화면은 실제 모듈(web/session-chat.ts)을 싣는다.
//  fail-first: `SRC_ROOT=<옛 트리>`(web/ · public/styles 가 있는 곳)로 옛 코드를 물린다. 크롬이 없는 면에서는 조용히 건너뛴다.
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 끊긴 턴 표시 런타임 검증 미실행"); process.exit(0); }

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
  const line = (o) => JSON.stringify(o) + "\n";
  const T = (m) => `2026-11-19T05:${m}Z`;
  const user = (ts, text) => line({ type: "user", timestamp: ts, message: { role: "user", content: text } });
  const said = (ts, text) => line({ type: "assistant", timestamp: ts, message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }] } });
  const tool = (ts, id, cmd) => line({ type: "assistant", timestamp: ts, message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id, name: "Bash", input: { command: cmd } }] } });
  const result = (ts, id, out) => line({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: out }] } });
  const end = (ts) => line({ type: "system", subtype: "turn_duration", timestamp: ts, durationMs: 60000 });
  const HEAD = user(T("40:00"), "준비됐어?") + said(T("40:05"), "준비됐어요") + end(T("40:05"));
  //  GovTech 세션의 모양 — 진행 문장 뒤로 삭제를 하고, 마지막 명령은 결과 없이 끊겼다.
  const CUT = HEAD + user(T("43:19"), "최종 영상이랑 최종 덱 빼고 다 지워줘")
    + said(T("45:26"), "남길 최종 덱과 영상이 어느 파일인지, 지우기 전에 폴더를 살펴보고 있습니다.")
    + tool(T("59:01"), "t1", "rm -rf 덱소스") + result(T("59:05"), "t1", "ok")
    + tool(T("59:58"), "t2", "grep -n 덱소스 memory/*.md");
  const DONE = CUT + result(T("59:59"), "t2", "ok") + said(T("59:59"), "다 지웠습니다.") + end(T("59:59"));
  const LOGS = {};        // 박스 기록(대화 파일) — 없으면 404
  const CENTRAL = {};     // 중앙 기록(v6 log) — 대화 uuid 로
  const hits = { box: 0, log: 0 };
  const serve = (LOG, u, sid) => {
    const from = u.searchParams.has("from") ? Math.min(Number(u.searchParams.get("from")) || 0, LOG.length) : 0;
    return new Response(LOG.slice(from), { status: 200, headers: { "content-type": "text/plain", "X-Log-Bytes": String(LOG.length), "X-Log-From": String(from), "X-Log-To": String(LOG.length), "X-Session-Uuid": "uuid-" + sid } });
  };
  window.fetch = async (url) => {
    const u = new URL(String(url), location.href);
    const lg = /\/api\/ui\/v6\/sessions\/([^/]+)\/log$/.exec(u.pathname);
    if (lg) { hits.log++; const k = decodeURIComponent(lg[1]); return CENTRAL[k] != null ? serve(CENTRAL[k], u, k) : J({ error: "아직 중앙 기록이 없습니다" }, 404); }
    const m = /\/api\/ui\/terminal\/sessions\/([^/]+)\/(transcript|outbox)$/.exec(u.pathname);
    if (!m) return J({ error: "no" }, 404);
    const sid = decodeURIComponent(m[1]);
    if (m[2] === "outbox") return J({ items: [] });
    hits.box++;
    return LOGS[sid] != null ? serve(LOGS[sid], u, sid) : J({ error: "대화 기록 파일을 찾지 못했습니다" }, 404);
  };
  localStorage.setItem("lively_ui_token", "t");
  const SC = (new Function(document.getElementById("src").textContent + "\n;return SC;"))();
  const now = Math.floor(Date.now() / 1000);
  const row = (id, raw, alive) => ({ id, label: "GovTech 멘토 미팅", live: true, alive, node: null, owned: true, stateKey: alive ? "idle" : "restorable",
    stateLabel: alive ? "쉬는 중" : "중단됨", projectId: null, projectName: "",
    raw: { harness: "claude", chatMode: "tmux", runtimeMode: "terminal", chat: { read: true, answer: true }, claudeSessionId: "uuid-" + id,
      agentState: alive ? "busy" : "offline", working: alive, lastActive: now - 30, restorable: !alive, ...raw } });
  const mount = (id, log, raw, alive, opts) => {
    if (log != null) LOGS[id] = log;
    const box = document.createElement("div");
    box.style.cssText = "position:relative;width:900px;height:500px;display:flex;flex-direction:column;background:#fff";
    document.body.append(box);
    const h = SC.mountSessionChat(box, row(id, raw, alive), { terminalSrc: () => null, onResumed: () => {}, ...(opts || {}) });
    return { box, h };
  };
  const cutLines = (box) => [...box.querySelectorAll(".livc-cut")].map((e) => e.textContent.trim());
  //  그 줄이 끊긴 턴(진행 문장이 든 턴)의 **끝**에 섰나 — 진행 문장이 그 줄보다 앞에 있고, 그 줄 뒤에 다른 답 글이 없다.
  const placed = (box) => {
    const c = box.querySelector(".livc-cut"); if (!c) return null;
    const txt = box.innerText; const iCut = txt.indexOf(c.textContent.trim()); const iSaid = txt.lastIndexOf("살펴보고 있습니다");
    return { after: iSaid >= 0 && iCut > iSaid, tail: txt.slice(iCut + c.textContent.trim().length).trim().slice(0, 40) };
  };
  try {
    const lost = { endNote: { why: "lost", at: now - 60 } };
    const c1 = mount("box-c1", CUT, lost, false);
    const c2 = mount("box-c2", DONE, lost, false);
    const c3 = mount("box-c3", CUT, { endNote: { why: "reclaim", at: now - 60 }, stopNote: { why: "done" } }, false);
    const c4 = mount("box-c4", CUT, { endNote: { why: "stop", at: now - 60 } }, false);
    const c5 = mount("box-c5", CUT, {}, true);
    const c6 = mount("box-c6", CUT, {}, true);
    const c7 = mount("box-c7", CUT, { lastRun: { at: now - 60, run: "working" } }, false);
    const c8 = mount("box-c8", CUT, lost, false, { chatHome: true });
    CENTRAL["uuid-box-c9"] = CUT;                    // 박스 기록 없음(404) → 중앙 기록으로 읽는다
    const c9 = mount("box-c9", null, lost, false);
    const c10 = mount("box-c10", CUT, {}, false);
    await sleep(2500);
    R.c1 = { lines: cutLines(c1.box), placed: placed(c1.box), shows: c1.box.innerText.includes("살펴보고 있습니다"), tui: !!c1.box.querySelector(".livc-tui") };
    R.c2 = { lines: cutLines(c2.box), shows: c2.box.innerText.includes("다 지웠습니다") };
    R.c3 = { lines: cutLines(c3.box) };
    R.c4 = { lines: cutLines(c4.box) };
    R.c5 = { lines: cutLines(c5.box) };
    R.c7 = { lines: cutLines(c7.box) };
    R.c8 = { lines: cutLines(c8.box), desktop: !c8.box.querySelector(".livc-tui") };
    R.c9 = { lines: cutLines(c9.box), shows: c9.box.innerText.includes("살펴보고 있습니다") };
    R.c10 = { lines: cutLines(c10.box) };
    R.hits = { ...hits };
    //  C6 — 보는 중에 꺼진다. 사유는 늦게 온다(서버는 사라진 세션을 3분 뒤에 lost 로 적는다).
    R.c6a = cutLines(c6.box);
    c6.h.update(row("box-c6", {}, false));
    await sleep(400);
    R.c6b = cutLines(c6.box);
    c6.h.update(row("box-c6", lost, false));
    await sleep(400);
    R.c6c = cutLines(c6.box);
    c6.h.update(row("box-c6", lost, false));
    await sleep(400);
    R.c6d = cutLines(c6.box);
  } catch (e) { R.err = String(e && e.stack || e); }
  R.pageErrors = pageErrors;
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const page = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out" style="position:fixed;left:-9999px">PENDING</pre>
<script type="text/plain" id="src">${sc.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;
const dom = await dumpDom(chrome, { html: page, serve: true, prefix: "chat-cut-turn-", virtualTimeBudget: 30000, args: ["--window-size=1200,1600"], copy: CSS });
const res = readOut(dom);
if (res.text === null) { console.error(`FAIL  페이지가 결과를 안 냈다(out=${JSON.stringify(res.out)}): ${dom.slice(0, 400)}`); process.exit(1); }
const R = JSON.parse(res.text);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const check = (cond, n, got) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} :: 실제 ${JSON.stringify(got)}`); } };
if (R.fatal || R.err) { fail++; console.error(`FAIL  페이지가 던졌다: ${String(R.fatal || R.err).split("\n").slice(0, 3).join(" | ")}`); }
const one = (x) => Array.isArray(x) && x.length === 1 && /일하던 중에 세션이 끊겼어요/.test(x[0]);
const none = (x) => Array.isArray(x) && x.length === 0;
check(R.c1 && R.c1.shows && R.c1.tui && R.c2 && R.c2.shows, "배선 — 터미널 문법 화면이 박스 기록의 진행 문장·마지막 답을 그렸다", { c1: R.c1, c2: R.c2 });
check(R.c9 && R.c9.shows && R.hits && R.hits.log > 0, "배선 — C9 는 박스 기록 404 뒤 중앙 기록으로 읽었다", { c9: R.c9, hits: R.hits });
check(R.c1 && one(R.c1.lines), "C1 사라진 세션의 끝나지 않은 턴 → «일하던 중에 세션이 끊겼어요» 한 줄", R.c1);
check(R.c1 && R.c1.placed && R.c1.placed.after, "C1 그 줄은 진행 문장 뒤(그 턴의 끝)에 선다", R.c1 && R.c1.placed);
check(R.c2 && none(R.c2.lines), "C2 마지막 턴이 끝 줄로 끝났으면 줄 없음", R.c2);
check(R.c3 && none(R.c3.lines), "C3 시스템이 끈 세션은 끊겼다고 단정하지 않는다", R.c3);
check(R.c4 && none(R.c4.lines), "C4 사람이 끝낸 세션은 줄 없음", R.c4);
check(R.c5 && none(R.c5.lines), "C5 살아서 도는 세션은 줄 없음", R.c5);
check(none(R.c6a) && none(R.c6b), "C6 보는 중에 꺼져도 사유가 오기 전에는 줄 없음", { a: R.c6a, b: R.c6b });
check(one(R.c6c) && one(R.c6d), "C6 사유(lost)가 늦게 오면 그때 한 줄 · 같은 행이 다시 와도 한 번만", { c: R.c6c, d: R.c6d });
check(R.c7 && one(R.c7.lines), "C7 일하던 중 꺼짐(lastRun working)도 한 줄", R.c7);
check(R.c8 && R.c8.desktop && one(R.c8.lines), "C8 대화 화면(desktop look)도 한 줄", R.c8);
check(R.c9 && none(R.c9.lines), "C9 중앙 기록(끝 줄을 안 담는다)으로 읽은 세션은 줄 없음", R.c9);
check(R.c10 && none(R.c10.lines), "C10 사유를 모르면 줄 없음", R.c10);
check(!(R.pageErrors || []).length, "W 페이지 예외 없음", R.pageErrors);
console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
