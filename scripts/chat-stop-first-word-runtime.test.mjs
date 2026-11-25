#!/usr/bin/env node
// 대화창 — 멈춘 세션에 친 **첫 말**이 세션을 되살린다(#5620). 런타임.
//
// 신고(2026-11-19 #대방어): «가끔 재시동 걸 때 치는 말은 무시하더라 · 세션 중단되고 재시동 거는 거 무시해서 두 번 쳐야 해».
//  실측(매니지드 · 멤버 PC 세션): 세션이 멈추면 액자는 곧바로 «없다» 를 듣고 «아래에 말을 걸면 이어서 열려요» 를 띄운다. 그런데 목록은
//  약 15초 동안 그 세션을 «살아 있다» 로 냈고, 대화창은 그 낡은 행으로 액자의 말을 지웠다 — 안내를 보고 친 말은 되살리기 대신
//  POST …/prompt 로 갔고 서버는 그 말을 멈춘 세션의 큐에 묻었다(queued:true · 아무도 안 되살림 · 화면엔 «그 컴퓨터로 전달했어요»).
//
//  엣지 표(사양 spec-5620-first-word.md):
//   S1  액자 «없음»(stop) → 낡은 «살아 있음» 행 → 말        → /restore 먼저 · 그 말은 되살린 세션으로(옛 세션에 곧바로 /prompt 안 함)
//   S2  액자 «없음» → 목록 «멈춤» → 목록 «살아 있음» → 말   → 걸쇠 풀림 → 곧바로 /prompt(되살리지 않음 — 과잉 고정 방지)
//   S3  액자 «없음» → 낡은 «살아 있음» 행                    → 터미널 액자를 다시 붙이지 않는다(깜빡임 · 그 틈에 걸쇠가 풀림)
//   S4  액자 없이 살아 있는 행 · 말 → 서버 409 stopped canRevive → /restore → 같은 id 로 /prompt · 말풍선 하나
//   S5  409 stopped canRevive:false                          → /restore 없음 · 실패 표시 · 친 글은 입력칸으로
//   S6  409 stopped:false(컴퓨터 무응답)                     → /restore 없음 · 실패 표시
//   S7  멤버 PC 세션 · /prompt → queued:true                 → «그 컴퓨터로 전달했어요» 를 말하지 않는다
//   S8  멤버 PC 세션 · /prompt → {ok:true}(곧장 넣음)         → «그 컴퓨터로 전달했어요»(무회귀)
//
//  가짜는 «서버»(기록 · 큐 · 복원 · 프롬프트)뿐이다. 세션 화면은 실제 모듈(web/session-chat.ts)을 싣는다.
//  fail-first: `SRC_ROOT=<옛 트리>`(web/ · public/styles 가 있는 곳)로 옛 코드를 물린다. 크롬이 없는 면에서는 조용히 건너뛴다.
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 멈춘 세션 첫 말 런타임 검증 미실행"); process.exit(0); }

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
  const LOG = line({ type: "user", timestamp: "2026-11-19T08:00:00Z", message: { role: "user", content: "준비됐어?" } })
    + line({ type: "assistant", timestamp: "2026-11-19T08:00:05Z", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "준비됐어요" }] } })
    + line({ type: "system", subtype: "turn_duration", timestamp: "2026-11-19T08:00:05Z", durationMs: 5000 });
  //  세션마다 /prompt 의 답 — 되살린 뒤(restored)에는 늘 큐에 들어간다.
  const PROMPT = {};
  const restored = {};
  const posts = [];       // [세션, 무엇] — 화면이 서버에 무엇을 어떤 순서로 보냈나
  window.fetch = async (url, init) => {
    const u = new URL(String(url), location.href);
    const method = (init && init.method) || "GET";
    const m = /\/api\/ui\/terminal\/sessions\/([^/]+)\/(transcript|outbox|prompt|restore)$/.exec(u.pathname);
    if (!m) return J({ error: "no" }, 404);
    const sid = decodeURIComponent(m[1]);
    if (m[2] === "outbox") return J({ items: [] });
    if (m[2] === "transcript") {
      const from = u.searchParams.has("from") ? Math.min(Number(u.searchParams.get("from")) || 0, LOG.length) : 0;
      return new Response(LOG.slice(from), { status: 200, headers: { "content-type": "text/plain", "X-Log-Bytes": String(LOG.length), "X-Log-From": String(from), "X-Log-To": String(LOG.length), "X-Session-Uuid": "uuid-" + sid } });
    }
    if (method !== "POST") return J({ error: "no" }, 404);
    posts.push([sid, m[2]]);
    if (m[2] === "restore") { restored[sid] = true; return J({ ok: true, resumed: "precise", session: { id: sid, label: "시험" } }); }
    if (restored[sid]) return J({ ok: true, queued: true, outbox_id: 99, seq: 1 });
    const p = PROMPT[sid] || { st: 200, body: { ok: true, queued: true, outbox_id: 1, seq: 1 } };
    return J(p.body, p.st);
  };
  localStorage.setItem("lively_ui_token", "t");
  const SC = (new Function(document.getElementById("src").textContent + "\n;return SC;"))();
  const now = Math.floor(Date.now() / 1000);
  const row = (id, alive, extra) => ({ id, label: "재시동 시험", live: true, alive, node: null, owned: true, stateKey: alive ? "idle" : "restorable",
    stateLabel: alive ? "쉬는 중" : "중단됨", projectId: null, projectName: "",
    ...(extra || {}),
    raw: { harness: "claude", chatMode: "tmux", runtimeMode: "terminal", chat: { read: true, answer: true }, claudeSessionId: "uuid-" + id,
      agentState: alive ? "idle" : "offline", working: false, lastActive: now - 30, restorable: !alive, ...(alive ? {} : { endNote: { why: "stop", at: now - 5 } }), ...((extra && extra.raw) || {}) } });
  const mount = (id, alive, opts, extra) => {
    const box = document.createElement("div");
    box.style.cssText = "position:relative;width:900px;height:500px;display:flex;flex-direction:column;background:#fff";
    document.body.append(box);
    const h = SC.mountSessionChat(box, row(id, alive, extra), { onResumed: () => {}, ...(opts || {}) });
    return { box, h };
  };
  const frames = (box) => box.querySelectorAll("iframe.sc-term-frame").length;
  //  액자가 서버에게 «이 세션 없다» 를 들었다 — 액자 **안에서** 부모로 보낸다(대화창은 출처·보낸 창을 확인한다).
  const frameSaysGone = (box, id) => {
    const fr = box.querySelector("iframe.sc-term-frame");
    if (!fr) return false;
    const msg = { type: "lively-term-gone", id, restorable: true, canRestore: true, end: { exitedByUser: false, oomKilled: false, endWhy: "stop" } };
    fr.contentWindow.Function("parent.postMessage(" + JSON.stringify(msg) + ", '*')")();
    return true;
  };
  const say = async (box, text) => {
    const ta = [...box.querySelectorAll("textarea.livc-input")][0];
    ta.value = text; ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.form.requestSubmit();
    await sleep(900);
  };
  const postsOf = (id) => posts.filter((p) => p[0] === id).map((p) => p[1]);
  const count = (box, text) => box.innerText.split(text).length - 1;
  const term = { terminalSrc: () => "about:blank" };
  try {
    //  S1·S3 — 액자 «없음» 뒤 낡은 «살아 있음» 행 → 말.
    const s1 = mount("box-s1", true, term);
    await sleep(600);
    R.s1Frame0 = frames(s1.box);
    R.s1Posted = frameSaysGone(s1.box, "box-s1");
    await sleep(400);
    R.s1Note = (s1.box.innerText.match(/[^\n]*아래에 말을 걸면[^\n]*/) || [""])[0];
    s1.h.update(row("box-s1", true));            // 목록의 낡은 행 — 액자가 들은 말보다 먼저 만들어졌다
    await sleep(500);
    R.s3Frames = frames(s1.box);
    await say(s1.box, "첫 말 S1");
    R.s1 = postsOf("box-s1");
    R.s1Count = count(s1.box, "첫 말 S1");

    //  S2 — 목록이 따라잡은 뒤의 «살아 있음» 은 진짜 되살아남이다.
    const s2 = mount("box-s2", true, term);
    await sleep(600);
    R.s2Posted = frameSaysGone(s2.box, "box-s2");
    await sleep(400);
    s2.h.update(row("box-s2", false));
    await sleep(200);
    s2.h.update(row("box-s2", true));
    await sleep(300);
    await say(s2.box, "첫 말 S2");
    R.s2 = postsOf("box-s2");

    //  S4 — 화면은 살아 있다고 믿는데 서버가 «멈춘 세션» 이라고 돌려보낸다.
    PROMPT["box-s4"] = { st: 409, body: { error: "멈춘 세션이에요 — 다시 띄운 뒤 이 말을 넣어야 합니다.", stopped: true, canRevive: true, moved: false } };
    const s4 = mount("box-s4", true, { terminalSrc: () => null });
    await sleep(600);
    await say(s4.box, "첫 말 S4");
    await sleep(600);
    R.s4 = postsOf("box-s4");
    R.s4Count = count(s4.box, "첫 말 S4");
    R.s4Err = /보내지 못했/.test(s4.box.innerText);

    //  S5 — 멈췄지만 되살릴 수 없다(남의 세션 등).
    PROMPT["box-s5"] = { st: 409, body: { error: "멈춘 세션이에요 — 세션 주인만 다시 열 수 있어요.", stopped: true, canRevive: false, moved: false } };
    const s5 = mount("box-s5", true, { terminalSrc: () => null });
    await sleep(600);
    await say(s5.box, "첫 말 S5");
    R.s5 = postsOf("box-s5");
    R.s5Err = /보내지 못했/.test(s5.box.innerText);
    R.s5Back = [...s5.box.querySelectorAll("textarea.livc-input")][0].value;

    //  S6 — 그 컴퓨터가 답하지 않았다.
    PROMPT["box-s6"] = { st: 409, body: { error: "이 세션이 있는 컴퓨터가 세션 상태를 알려 주지 않아 말을 넣지 못했어요", stopped: false } };
    const s6 = mount("box-s6", true, { terminalSrc: () => null });
    await sleep(600);
    await say(s6.box, "첫 말 S6");
    R.s6 = postsOf("box-s6");
    R.s6Err = /보내지 못했/.test(s6.box.innerText);

    //  S7·S8 — 멤버 PC 세션: 큐에 들어간 말을 «그 컴퓨터로 전달했어요» 라고 하지 않는다.
    PROMPT["box-s7"] = { st: 200, body: { ok: true, queued: true, outbox_id: 7, seq: 1 } };
    const s7 = mount("box-s7", true, { terminalSrc: () => null }, { node: "pc-1" });
    await sleep(600);
    await say(s7.box, "첫 말 S7");
    R.s7 = postsOf("box-s7");
    R.s7Claim = /그 컴퓨터로 전달했어요/.test(s7.box.innerText);
    PROMPT["box-s8"] = { st: 200, body: { ok: true } };
    const s8 = mount("box-s8", true, { terminalSrc: () => null }, { node: "pc-1" });
    await sleep(600);
    await say(s8.box, "첫 말 S8");
    R.s8 = postsOf("box-s8");
    R.s8Claim = /그 컴퓨터로 전달했어요/.test(s8.box.innerText);
  } catch (e) { R.err = String(e && e.stack || e); }
  R.pageErrors = pageErrors;
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const page = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out" style="position:fixed;left:-9999px">PENDING</pre>
<script type="text/plain" id="src">${sc.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;
const dom = await dumpDom(chrome, { html: page, serve: true, prefix: "chat-stop-first-word-", virtualTimeBudget: 60000, args: ["--window-size=1200,1600"], copy: CSS });
const res = readOut(dom);
if (res.text === null) { console.error(`FAIL  페이지가 결과를 안 냈다(out=${JSON.stringify(res.out)}): ${dom.slice(0, 400)}`); process.exit(1); }
const R = JSON.parse(res.text);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const check = (cond, n, got) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} :: 실제 ${JSON.stringify(got)}`); } };
if (R.fatal || R.err) { fail++; console.error(`FAIL  페이지가 던졌다: ${String(R.fatal || R.err).split("\n").slice(0, 3).join(" | ")}`); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
check(R.s1Frame0 === 1 && R.s1Posted && R.s2Posted, "배선 — 살아 있는 세션은 터미널 액자를 붙였고 그 액자 안에서 «없다» 를 보냈다", { f: R.s1Frame0, p1: R.s1Posted, p2: R.s2Posted });
check(/아래에 말을 걸면/.test(R.s1Note || ""), "배선 — 액자의 «없다» 를 받아 «아래에 말을 걸면 이어서 열려요» 안내를 띄웠다", R.s1Note);
check(eq(R.s1, ["restore", "prompt"]), "★ S1 낡은 «살아 있음» 행 뒤에 친 첫 말 → 먼저 되살리고(/restore) 그 말을 넣는다", R.s1);
check(R.s1Count === 1, "S1 말풍선은 하나다", R.s1Count);
check(R.s3Frames === 0, "S3 낡은 행으로 죽은 터미널에 다시 붙지 않는다", R.s3Frames);
check(eq(R.s2, ["prompt"]), "S2 목록이 따라잡은 뒤 «살아 있음» 이면 되살리지 않고 곧바로 넣는다(과잉 고정 없음)", R.s2);
check(eq(R.s4, ["prompt", "restore", "prompt"]), "★ S4 서버가 «멈춘 세션» 409 로 돌려보내면 그 자리에서 되살리고 같은 말을 넣는다", R.s4);
check(R.s4Count === 1 && !R.s4Err, "S4 말풍선 하나 · 실패 표시 없음", { n: R.s4Count, err: R.s4Err });
check(eq(R.s5, ["prompt"]) && R.s5Err && R.s5Back === "첫 말 S5", "S5 되살릴 수 없는 멈춤 → 되살리지 않고 실패를 말하고 글을 돌려준다", { p: R.s5, err: R.s5Err, back: R.s5Back });
check(eq(R.s6, ["prompt"]) && R.s6Err, "S6 컴퓨터 무응답(stopped:false) → 되살리지 않고 실패를 말한다", { p: R.s6, err: R.s6Err });
check(eq(R.s7, ["prompt"]) && R.s7Claim === false, "S7 큐에 들어간 말을 «그 컴퓨터로 전달했어요» 라고 하지 않는다", { p: R.s7, claim: R.s7Claim });
check(eq(R.s8, ["prompt"]) && R.s8Claim === true, "S8 곧장 넣은 말은 종전대로 «그 컴퓨터로 전달했어요»", { p: R.s8, claim: R.s8Claim });
check(!(R.pageErrors || []).length, "W 페이지 예외 없음", R.pageErrors);
console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
