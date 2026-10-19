#!/usr/bin/env node
// 화면이 기억하는 첫 지시 = 서버가 넣을 첫 지시 (#4906 — #4794 후속 §10-2, 런타임).
//
//  태스크의 [새 세션 열기]·[세션 열기]는 지시를 비워 spawnSession('', { taskId })로 세션을 만들고, 첫 지시는 서버가 «태스크 #id 진행해» +
//   본문으로 채운다. 화면은 친 글이 있을 때만 그 세션의 첫 지시로 기억해서(`if (t) firstPrompts.set(id, t)`), 세션 화면이 #4794 의
//   «숨겨 붙였다가 그 말이 실제로 제출된 뒤 터미널로» 를 못 타고 하네스가 뜨는 몇 초 동안 빈 터미널을 보였다. 서버가 글을 다시 짓는 길
//   (태스크 여러 개 · 첨부를 프로젝트로 옮긴 홈 첫 지시)도 친 글로 기억해 «다 쳤다» · 에코 맞추기가 빗나갔다.
//  이제 생성 응답이 넣을 첫 지시를 싣고(src/terminal/session-launch.ts launchReply — 단위 표는 session-launch.test.ts), 화면은 그 글을 기억한다.
//  ★ 프로젝트 보드는 셸 안의 **액자(다른 문서)** 라 그 [세션 열기]가 기억한 첫 지시를 셸 문서가 못 읽는다(문서마다 모듈이 따로다 — 격리 검토가
//   찾음). 액자는 «이 주소 열어 줘» 메시지에 첫 지시를 싣고, 셸은 탭을 열기 전에 그것을 제 기억으로 옮긴다(web/lib/open-route.ts — 표는
//   scripts/open-route.test.mjs).
//
//  엣지 표(사양 — 태스크 #4906):
//   B1 프로젝트 · taskId · 친 글 없음 → 응답의 «태스크 #id 진행해 + 본문» 을 기억한다(요청엔 initialPrompt 를 안 싣는다 — 종전 그대로)
//   B2 프로젝트 · taskIds · 덧붙인 말 → 응답의 «순서 안내 + 1번 본문 + 덧붙인 말» 을 기억한다(친 글이 아니다)
//   B3 프로젝트 · 태스크 없음 · 친 글 → 응답의 같은 글
//   B4 홈 · 첨부를 프로젝트로 옮겨 좌표를 고친 글 → 응답의 고친 글
//   B5 홈 · 평범 → 같은 글
//   B6 응답에 첫 지시가 없고 친 글도 없다 → 기억할 것이 없다(null)
//   B7 옛 서버(응답에 필드 없음) · 친 글 → 친 글(종전)
//   B8 응답의 값이 공백뿐 · 문자열 아님 → 친 글(이상값을 기억하지 않는다)
//   R1 두 문서(셸 · 보드 액자) — 액자에서 만든 세션의 첫 지시는 셸 문서의 기억에 없다(대조) → 메시지로 옮기면 셸이 그 글을 꺼낸다
//   W1·W2 배선 — 두 입구(홈 routes.ts · 프로젝트 project-routes.ts)가 launchReply 로 답한다
//   W3 배선 — 보드의 [세션 열기](detail-task-actions pjvOpenSessionRoute)가 그 세션의 첫 지시를 꺼내 셸 메시지에 싣는다
//   W4 배선 — 셸(main.ts lively:open-route)이 탭을 열기 **전에** 받은 첫 지시를 기억한다
//
//  가짜는 «서버»(생성 응답)뿐이다. 화면 쪽은 실제 모듈(web/v2/quick-session.ts · web/lib/open-route.ts)을 싣는다.
//  fail-first: `SRC_ROOT=<옛 트리>`(web/ · src/ 가 있는 곳)로 옛 코드를 물린다.
//  배선(W)은 소스 글이라 크롬 없이 돈다. 크롬이 없는 면에서는 런타임 장면만 건너뛴다.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
let pass = 0, fail = 0;
const check = (cond, n, got) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} :: 실제 ${JSON.stringify(got)}`); } };
const finish = () => { console.log(`\n${pass} passed, ${fail} failed — 첫 지시 기억(#4906)`); process.exit(fail ? 1 : 0); };

//  W — 배선(소스 글). 라우트 · 셸 메시지 처리기를 띄우지 않는 이 층에서 배선이 끊기면 아래 표는 그대로 초록이라 따로 박는다.
{
  const read = (p) => { try { return readFileSync(path.join(ROOT, p), "utf8"); } catch { return ""; } };
  const home = read("src/terminal/routes.ts"), proj = read("src/project/project-routes.ts");
  check(/res\.json\(launchReply\(session, input\)\)/.test(home), "W1 홈 입구(routes.ts 세션 생성)가 launchReply(session, input) 로 답한다", null);
  check(/res\.json\(launchReply\(await launchSession\([\s\S]*?\), input\)\)/.test(proj), "W2 프로젝트 입구(project-routes.ts 세션 생성)가 launchReply(…, input) 로 답한다", null);
  const acts = read("web/projects/detail-task-actions.ts");
  const a0 = acts.indexOf("function pjvOpenSessionRoute");
  const fn = a0 >= 0 ? acts.slice(a0, acts.indexOf("\n}\n", a0)) : "";
  check(/const first = takeFirstPrompt\(sid\);/.test(fn) && /window\.parent\.postMessage\(openRouteMsg\(href, first\), location\.origin\)/.test(fn),
    "W3 보드의 [세션 열기]가 그 세션의 첫 지시를 꺼내 셸 메시지(openRouteMsg)에 싣는다", fn.slice(0, 400));
  const main = read("web/v2/main.ts");
  const m0 = main.indexOf("m.type === 'lively:open-route'");
  const br = m0 >= 0 ? main.slice(m0, main.indexOf("\n      return;\n    }", m0)) : "";
  const iRem = br.indexOf("rememberFirstPrompt(first.sid, first.text)"), iAdd = br.indexOf("tabsApi.add(m.href)");
  check(/const first = openRouteFirstPrompt\(m\);/.test(br) && iRem >= 0 && iAdd > iRem,
    "W4 셸(main.ts lively:open-route)이 탭을 열기 전에 받은 첫 지시를 기억한다", br.slice(0, 600));
}

const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 런타임 장면을 건너뜁니다(CHROME_BIN 으로 지정) — 배선(W)만 봤다"); finish(); }

const bundle = (contents, globalName) => buildSync({
  stdin: { contents, resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName, write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;
const qs = bundle("export { spawnSession, takeFirstPrompt, rememberFirstPrompt } from './web/v2/quick-session.ts';", "QS");
//  옛 트리엔 이 모듈이 없다 — 그때는 R1 이 «옮기는 길이 없다» 로 빨개진다(나머지 장면은 그대로 돈다).
let or = "";
try { or = bundle("export { openRouteMsg, openRouteFirstPrompt } from './web/lib/open-route.ts';", "OR"); } catch { or = ""; }
const esc = (s) => s.replace(/<\/script/gi, "<\\/script");
const KICK = "태스크 #9 진행해\n\n## 할 일\n- 대화창에서 보낸 말이 제출된 뒤 터미널로 넘긴다\n";

//  R1 의 액자 문서 — 보드의 [세션 열기]가 하는 일을 그대로 한다: 세션을 만들고(이 문서의 기억에 첫 지시) · 그 첫 지시를 꺼내 셸에 올린다.
//   (실제 보내는 줄은 detail-task-actions pjvOpenSessionRoute — 배선 W3 가 소스로 잠근다.)
async function FRAME_MAIN(KICK) {
  const QS = (new Function(document.getElementById("src").textContent + "\n;return QS;"))();
  const OR = (new Function(document.getElementById("or").textContent + "\n;return typeof OR === 'undefined' ? null : OR;"))();
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
  window.fetch = async (url, init) => {
    const u = new URL(String(url), location.href);
    if ((init && init.method) === "POST" && /\/api\/ui\/v6\/projects\/\d+\/sessions$/.test(u.pathname)) return J({ session: { id: "box-r1", projectId: 7 }, initialPrompt: KICK });
    return J({ error: "no" }, 404);
  };
  const made = await QS.spawnSession("", { projectId: 7, taskId: 9 });
  const first = QS.takeFirstPrompt(made.id);
  const href = "#/s/" + encodeURIComponent(made.id);
  parent.postMessage(OR ? OR.openRouteMsg(href, first) : { type: "lively:open-route", href }, location.origin);
}
const tmp = mkdtempSync(path.join(os.tmpdir(), "spawn-first-prompt-frame-"));
const FRAME = path.join(tmp, "frame-sf.html");
writeFileSync(FRAME, `<!doctype html><meta charset="utf-8"><div id="toasts"></div>
<script type="text/plain" id="src">${esc(qs)}</script>
<script type="text/plain" id="or">${esc(or)}</script>
<script>(${FRAME_MAIN.toString()})(${JSON.stringify(KICK)}).catch(function (e) { parent.postMessage({ type: 'frame-error', e: String(e && e.stack || e) }, location.origin); });</script>`);

async function PAGE_MAIN(KICK) {
  const R = { calls: [] };
  const pageErrors = [];
  window.addEventListener("error", (e) => pageErrors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => pageErrors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
  //  장면마다 서버가 줄 응답의 나머지(세션 id · initialPrompt 유무)를 정한다.
  let reply = null;
  window.fetch = async (url, init) => {
    const u = new URL(String(url), location.href);
    const m = (init && init.method) || "GET";
    if (m === "POST" && (/\/api\/ui\/terminal\/sessions$/.test(u.pathname) || /\/api\/ui\/v6\/projects\/\d+\/sessions$/.test(u.pathname))) {
      R.calls.push({ path: u.pathname, body: JSON.parse(String(init.body || "{}")) });
      return J(reply);
    }
    return J({ error: "no" }, 404);
  };
  localStorage.setItem("lively_ui_token", "t");
  const QS = (new Function(document.getElementById("src").textContent + "\n;return QS;"))();
  const OR = (new Function(document.getElementById("or").textContent + "\n;return typeof OR === 'undefined' ? null : OR;"))();
  const SEQ = "태스크 2개를 이 순서로 진행해: #9 → #10\n\n#9 본문\n\n덧붙인 말";
  const MOVED = "그림 /work/shared/project/7/a.png 봐 줘";
  const scene = async (name, text, opts, rep) => {
    reply = rep;
    const made = await QS.spawnSession(text, opts);
    R[name] = { made: made ? made.id : null, first: made ? QS.takeFirstPrompt(made.id) : null, call: R.calls[R.calls.length - 1] || null };
  };
  try {
    await scene("b1", "", { projectId: 7, taskId: 9 }, { session: { id: "box-b1", projectId: 7 }, initialPrompt: KICK });
    await scene("b2", "덧붙인 말", { projectId: 7, taskIds: [9, 10] }, { session: { id: "box-b2", projectId: 7 }, initialPrompt: SEQ });
    await scene("b3", "지시 B3", { projectId: 7 }, { session: { id: "box-b3", projectId: 7 }, initialPrompt: "지시 B3" });
    await scene("b4", "그림 /uploads/a.png 봐 줘", {}, { session: { id: "box-b4" }, initialPrompt: MOVED });
    await scene("b5", "지시 B5", {}, { session: { id: "box-b5" }, initialPrompt: "지시 B5" });
    await scene("b6", "", { projectId: 7, taskId: 9 }, { session: { id: "box-b6", projectId: 7 } });
    await scene("b7", "지시 B7", {}, { session: { id: "box-b7" } });
    await scene("b8", "지시 B8", {}, { session: { id: "box-b8" }, initialPrompt: "   " });
    await scene("b8b", "지시 B8b", {}, { session: { id: "box-b8b" }, initialPrompt: 42 });
    R.SEQ = SEQ; R.MOVED = MOVED;
    //  R1 — 셸(이 문서)과 보드 액자(다른 문서). 셸 main.ts 의 받는 쪽이 하는 일을 그대로 한다(실제 줄은 배선 W4 가 잠근다).
    R.realm = await new Promise((resolve) => {
      const out = { got: null, before: "unset", after: null, frameErr: null, timeout: false };
      const done = () => { window.removeEventListener("message", onMsg); resolve(out); };
      const onMsg = (ev) => {
        if (ev.origin !== location.origin) return;
        if (ev.data && ev.data.type === "frame-error") { out.frameErr = ev.data.e; done(); return; }
        out.got = OR ? OR.openRouteFirstPrompt(ev.data) : null;
        out.before = QS.takeFirstPrompt("box-r1");            // 대조 — 액자가 기억한 첫 지시는 이 문서의 기억에 없다
        if (out.got) QS.rememberFirstPrompt(out.got.sid, out.got.text);
        out.after = QS.takeFirstPrompt("box-r1");
        done();
      };
      window.addEventListener("message", onMsg);
      const fr = document.createElement("iframe");
      fr.src = "frame-sf.html";
      document.body.append(fr);
      setTimeout(() => { out.timeout = true; done(); }, 10000);
    });
  } catch (e) { R.err = String(e && e.stack || e); }
  R.pageErrors = pageErrors;
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const page = `<!doctype html><html data-theme="light"><meta charset="utf-8">
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out" style="position:fixed;left:-9999px">PENDING</pre>
<script type="text/plain" id="src">${esc(qs)}</script>
<script type="text/plain" id="or">${esc(or)}</script>
<script>(${PAGE_MAIN.toString()})(${JSON.stringify(KICK)}).catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;
let dom = "";
try {
  dom = await dumpDom(chrome, { html: page, serve: true, prefix: "spawn-first-prompt-", virtualTimeBudget: 40000, timeoutMs: 60000, args: ["--window-size=800,600"], copy: [FRAME] });
} finally { rmSync(tmp, { recursive: true, force: true }); }
const res = readOut(dom);
if (res.text === null) { console.error(`FAIL  페이지가 결과를 안 냈다(out=${JSON.stringify(res.out)}): ${dom.slice(0, 400)}`); fail++; finish(); }
const R = JSON.parse(res.text);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));
if (R.fatal || R.err) { fail++; console.error(`FAIL  페이지가 던졌다: ${String(R.fatal || R.err).split("\n").slice(0, 3).join(" | ")}`); }

const b1 = R.b1 || {};
check(b1.call && /\/v6\/projects\/7\/sessions$/.test(b1.call.path) && b1.call.body.taskId === 9 && !("initialPrompt" in b1.call.body),
  "배선 — 태스크에서 연 세션은 지시를 비워 프로젝트 입구로 보낸다(서버가 태스크로 채운다 · 종전 그대로)", b1.call);
check(b1.made === "box-b1" && b1.first === KICK, "B1 태스크에서 연 세션 → 서버가 채운 «태스크 #id 진행해 + 본문» 을 첫 지시로 기억한다", b1);
const b2 = R.b2 || {};
check(b2.first === R.SEQ, "B2 태스크 여러 개 → 서버가 지은 «순서 안내 + 1번 본문 + 덧붙인 말» 을 기억한다(친 글이 아니다)", b2);
check((R.b3 || {}).first === "지시 B3", "B3 프로젝트 · 태스크 없음 → 같은 글", R.b3);
const b4 = R.b4 || {};
check(b4.call && /\/api\/ui\/terminal\/sessions$/.test(b4.call.path) && b4.first === R.MOVED, "B4 홈 · 첨부를 옮겨 좌표를 고친 글 → 고친 글을 기억한다", b4);
check((R.b5 || {}).first === "지시 B5", "B5 홈 · 평범 → 같은 글", R.b5);
check((R.b6 || {}).made === "box-b6" && (R.b6 || {}).first === null, "B6 응답에 첫 지시가 없고 친 글도 없다 → 기억할 것이 없다", R.b6);
check((R.b7 || {}).first === "지시 B7", "B7 옛 서버(응답에 필드 없음) → 친 글(종전)", R.b7);
check((R.b8 || {}).first === "지시 B8" && (R.b8b || {}).first === "지시 B8b", "B8 응답의 값이 공백뿐 · 문자열 아님 → 친 글", { b8: R.b8, b8b: R.b8b });
const rm = R.realm || {};
check(!rm.frameErr && !rm.timeout && rm.before === null, "R1 대조 — 액자에서 만든 세션의 첫 지시는 셸 문서의 기억에 없다(문서마다 모듈이 따로다)", rm);
//  셸의 rememberFirstPrompt 는 앞뒤 공백을 걷어 기억한다(종전 규약 — 맞추기는 어차피 정규화 뒤에 한다).
check(rm.got && rm.got.sid === "box-r1" && rm.got.text === KICK && rm.after === KICK.trim(),
  "R1 액자가 메시지에 첫 지시를 싣고 셸이 탭을 열기 전에 옮기면 → 셸이 그 세션의 첫 지시를 꺼낸다(앞뒤 공백만 걷은 같은 글)", rm);
check(!(R.pageErrors || []).length, "페이지 오류 없음", R.pageErrors);
finish();
