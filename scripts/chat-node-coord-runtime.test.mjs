#!/usr/bin/env node
// 대화창이 살아 있는 매니지드 세션을 «그 컴퓨터» 세션으로 다루던 것 (#4904 — #4794 후속, 런타임).
//
//  매니지드 실측(2026-10-19 lively-46e3, 시험 세션 box-sangmin-yoon-242e4676): 살아 있는 매니지드 세션의 목록 행엔 세션 호스트 좌표
//   (`node: sesshost-lively-46e3-i-…`)가 실린다. 대화창은 그 좌표만 보고 멤버 PC 세션 갈래로 갔다 — 턴이 도는 중 Esc → «멈출 턴이 없어요.»
//   (키 요청 0) · 전달 큐를 한 번도 안 물음(/outbox 0) · 보낸 말 상태 «그 컴퓨터로 전달했어요 — 답은 턴이 끝나면 중앙 기록으로…» ·
//   빈 기록 안내 «아직 중앙 기록이 없어요 — 그 컴퓨터의 세션은…» · 머리줄 칩과 설정에 인스턴스 id. 서버는 같은 좌표를 이미 접어
//   받아 준다(#2600 T2 d6 — keys · outbox · transcript 라우트). 판정은 web/lib/node-coord.ts 한 벌(표는 scripts/node-coord.test.mjs).
//
//  엣지 표(사양 — 태스크 #4904):
//   H1 세션 호스트 · 열기 · 큐에 치지도 않은 실패 행 → 큐를 묻고 «전달 안 됨»·[다시 보내기]·[지우기]
//   H2 〃 · 멈춤 → interrupt 키 요청 · «멈춤을 보냈어요.»
//   H3 〃 · 질의 대기 → [기본 선택으로 답하기]·[거부] · [거부] → deny 키 요청
//   H4 〃 · 대화창에서 보내기 → 상태 줄에 «그 컴퓨터» 없음 · 보낸 뒤 큐를 다시 묻는다
//   H5 〃 · 기록 아직 없음 → 빈 안내에 «그 컴퓨터»·«중앙 기록» 없음 · 박스 기록을 다시 묻고 중앙 기록은 폴링하지 않는다
//   H6 〃 · 머리줄 → 노드 칩 없음
//   H7 옛 축 세션 호스트(sesshost-46e3) · 멈춤 → H2 와 같다
//   H9 〃 · 못 읽는 하네스(409 문장) · 목록 갱신 세 번 → 기록을 다시 열지 않는다(같은 답)
//   P1~P6 멤버 PC(laibeulliui-macmini) · 같은 장면 → 종전 그대로(큐 안 물음 · «멈출 턴이 없어요.» · 단추 없음 · «그 컴퓨터로 전달했어요…» ·
//          중앙 기록 폴링 · 칩에 노드 이름)
//   N1 좌표 없음(중앙) · 열기 · 멈춤 → 큐를 묻고 interrupt 키 요청(회귀 가드)
//
//  가짜는 «서버»(기록 · 중앙 기록 · 큐 · 키 · 보내기 응답)뿐이다. 세션 화면은 실제 모듈(web/session-chat.ts)을 싣는다.
//  fail-first: `SRC_ROOT=<옛 트리>`(web/ · public/styles 가 있는 곳)로 옛 코드를 물린다.
//  크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 대화창 노드 좌표 런타임 검증 미실행"); process.exit(0); }

const CSS = ["01-base.css", "03-components.css", "36-chat.css", "38-chat-tui.css"].map((f) => path.join(ROOT, "public/styles", f)).filter(existsSync);
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
  const OLD = line({ type: "user", timestamp: "2026-10-19T07:40:00Z", message: { role: "user", content: "예전에 물어본 말" } })
    + line({ type: "assistant", timestamp: "2026-10-19T07:40:05Z", message: { role: "assistant", model: "claude-opus-4-1", content: [{ type: "text", text: "예전 답" }] } })
    + line({ type: "system", subtype: "turn_duration", timestamp: "2026-10-19T07:40:05Z", durationMs: 4000 });
  const FAILED = "앞서 못 간 말";
  const failedRow = { id: 501, seq: 1, session_id: "", text: FAILED, status: "failed", kind: "prompt", attempts: 3, trust_ok: false,
    last_error: "not-ready", created_at: "2026-10-19T07:50:00Z", updated_at: "2026-10-19T07:50:30Z", delivered_at: null, stalled_since: null };
  const HOST = "sesshost-lively-46e3-i-0abc123def4567890";
  const PC = "laibeulliui-macmini";
  //  세션마다 가짜 서버가 받은 요청을 센다(sid = 박스 id · 중앙 기록은 대화 uuid «uuid-<박스 id>» 로 온다).
  const hits = {};
  const H = (sid) => (hits[sid] ||= { transcript: 0, log: 0, outbox: 0, keys: [], prompt: [] });
  const KIND = {};                       // sid → 'host' | 'pc' | 'central'
  const EMPTY = new Set();               // 아직 기록 파일이 없는 세션(박스 404)
  const UNREADABLE = new Set();          // 파서가 없는 하네스(박스 409 + 문장)
  const OUTBOX = {};
  const SLOW_OUTBOX = {};                // sid → 큐 응답을 늦출 ms
  window.fetch = async (url, init) => {
    const u = new URL(String(url), location.href);
    const lg = /\/api\/ui\/v6\/sessions\/([^/]+)\/log$/.exec(u.pathname);
    if (lg) { H(decodeURIComponent(lg[1]).replace(/^uuid-/, "")).log++; return J({ error: "아직 중앙 기록이 없습니다" }, 404); }
    const m = /\/api\/ui\/terminal\/sessions\/([^/]+)\/(transcript|outbox|keys|prompt)$/.exec(u.pathname);
    if (!m) return J({ error: "no" }, 404);
    const sid = decodeURIComponent(m[1]); const h = H(sid);
    if (m[2] === "transcript") {
      h.transcript++;
      //  진짜 서버: 멤버 PC 세션의 박스 경로는 409 node(대화 uuid 를 같이 준다 — 화면이 중앙 기록으로 갈아탄다, #1744).
      if (KIND[sid] === "pc") return J({ error: "node", uuid: "uuid-" + sid, node: PC }, 409);
      if (EMPTY.has(sid)) return J({ error: "대화 기록 파일을 찾지 못했습니다" }, 404);
      //  진짜 서버: 파서가 없는 하네스는 409 + 문장(chat-routes — «… 의 대화는 아직 여기서 읽을 수 없습니다»).
      if (UNREADABLE.has(sid)) return J({ error: "OpenCode 의 대화는 아직 여기서 읽을 수 없습니다 — 터미널로 보세요." }, 409);
      const from = u.searchParams.has("from") ? Math.min(Number(u.searchParams.get("from")) || 0, OLD.length) : 0;
      return new Response(OLD.slice(from), { status: 200, headers: { "content-type": "text/plain",
        "X-Log-Bytes": String(OLD.length), "X-Log-From": String(from), "X-Log-To": String(OLD.length) } });
    }
    if (m[2] === "outbox") {
      h.outbox++;
      //  보낸 직후의 상태 줄을 큐 응답 **전에** 보려고 큐를 늦게 답한다(매니지드 큐 조회는 기록 대조로 길게는 2초 걸린다 — 그 사이 보이는 글).
      if (SLOW_OUTBOX[sid]) await sleep(SLOW_OUTBOX[sid]);
      return J({ items: OUTBOX[sid] || [] });
    }
    const body = JSON.parse(String((init && init.body) || "{}"));
    if (m[2] === "keys") { h.keys.push(body.action); return J({ ok: true, action: body.action }); }
    h.prompt.push(body.text);              // prompt — 서버 큐에 들어갔다(전달 대기)
    const id = 900 + h.prompt.length;
    (OUTBOX[sid] ||= []).push(Object.assign({}, failedRow, { id, seq: 1 + h.prompt.length, text: body.text, status: "queued", attempts: 0, last_error: null }));
    return J({ ok: true, outbox_id: id });
  };
  localStorage.setItem("lively_ui_token", "t");
  const SC = (new Function(document.getElementById("src").textContent + "\n;return SC;"))();
  //  살아 있는 claude(tmux) 세션의 목록 행 — 매니지드 실측 행의 모양(runtimeMode terminal · chatMode tmux · 대화 uuid 를 안다).
  const live = (id, node, extra) => ({ id, label: "세션", live: true, alive: true, node, owned: true, stateKey: "idle", stateLabel: "쉬는 중",
    projectId: null, projectName: "", raw: Object.assign({ harness: "claude", chatMode: "tmux", runtimeMode: "terminal", chat: { read: true, answer: true },
      claudeSessionId: "uuid-" + id, agentState: "idle", lastActive: Math.floor(Date.now() / 1000) - 60 }, extra || {}) });
  const mount = (t, firstPrompt) => {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:0;top:0;width:1000px;height:700px;display:flex;flex-direction:column;background:#fff";
    document.body.append(box);
    const h = SC.mountSessionChat(box, t, { terminalSrc: () => null, onResumed: () => {}, ...(firstPrompt ? { firstPrompt } : {}) });
    const q = (s) => box.querySelector(s);
    return {
      look: () => ({
        ...JSON.parse(JSON.stringify(H(t.id))),
        note: (q(".livc-note") || {}).textContent || "",
        chip: (q(".sc-run-node") || {}).textContent || "",
        aria: (q("textarea") || { getAttribute: () => "" }).getAttribute("aria-label") || "",
        waitBtns: [...box.querySelectorAll(".sc-wait button")].map((b) => b.textContent.trim()),
        qstates: [...box.querySelectorAll(".dt-qstate")].map((x) => x.innerText.trim()).filter(Boolean),
        qbuttons: [...box.querySelectorAll(".dt-qstate button")].map((b) => b.textContent.trim()),
        empty: (q(".sc-empty") || {}).textContent || "",
        failed: (q(".sc-chat") || box).innerText.includes("전달 안 됨"),
        said: (q(".sc-chat") || box).innerText.includes(firstPrompt || "\u0000"),
      }),
      //  [⋯ 더 보기] 설정 창의 줄들 — «돌아가는 컴퓨터» 줄이 서는지 본다(창은 읽고 걷는다).
      settings: async () => {
        const more = [...box.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || b.title || "") === "더 보기");
        if (!more) return null;
        const before = new Set(document.body.children);
        more.click();
        await sleep(500);
        const rows = [...document.querySelectorAll(".v2set-row")].map((r) => r.innerText.replace(/\s*\n+\s*/g, " / "));
        for (const n of [...document.body.children]) if (!before.has(n) && n !== box) n.remove();
        return rows;
      },
      //  멈춤 — 상태 줄의 «esc to interrupt»(손가락 화면의 Esc) 단추. 키보드 Esc 와 같은 doStop → onStop 을 탄다.
      stop: () => { const b = q(".tui-esc") || q(".tui-stop") || q(".dt-stop") || q(".livc-send-stop"); if (b) b.click(); return !!b; },
      send: (text) => { const ta = q("textarea"); ta.value = text; ta.dispatchEvent(new Event("input", { bubbles: true })); ta.form.requestSubmit(); },
      clickWait: (label) => { const b = [...box.querySelectorAll(".sc-wait button")].find((x) => x.textContent.trim() === label); if (b) b.click(); return !!b; },
      done: () => { try { h.destroy(); } catch (_) { /* 이미 */ } box.remove(); },
    };
  };
  //  열기 → 멈춤 → 보내기 → 큐 폴(3초) 한 번 더.
  const full = async (sid, node, kind) => {
    KIND[sid] = kind; OUTBOX[sid] = [failedRow];
    const v = mount(live(sid, node));
    await sleep(1500);
    const opened = v.look();
    opened.settings = await v.settings();
    const stopFound = v.stop();
    await sleep(800);
    const stopped = v.look();
    const outboxBeforeSend = H(sid).outbox;
    SLOW_OUTBOX[sid] = 1500;
    v.send("새로 보내는 말");
    await sleep(400);
    const sentEarly = v.look();          // 보내기 응답은 왔고 큐 응답은 아직(1.5초 늦게) — 그 사이 상태 줄
    await sleep(1600);
    SLOW_OUTBOX[sid] = 0;
    const sent = v.look();
    await sleep(3500);
    const later = v.look();
    v.done();
    return { opened, stopFound, stopped, sentEarly, sent, later, outboxBeforeSend };
  };
  const empty = async (sid, node, kind) => {
    KIND[sid] = kind; EMPTY.add(sid);
    const v = mount(live(sid, node));
    await sleep(1500);
    const first = v.look();
    await sleep(12000);
    const later = v.look();
    v.done();
    return { first, later };
  };
  const wait = async (sid, node, kind) => {
    KIND[sid] = kind; EMPTY.add(sid);
    const v = mount(live(sid, node, { awaiting: true, agentState: "waiting" }));
    await sleep(1500);
    const first = v.look();
    const clicked = v.clickWait("거부");
    await sleep(800);
    const after = v.look();
    v.done();
    return { first, clicked, after };
  };
  //  홈 입력창 · 되살리기처럼 첫 지시를 들고 연 화면 — 기록은 아직 없고, 큐 행은 아직 화면에 안 실렸다(큐 응답 전 · 비어 있음).
  const first = async (sid, node, kind) => {
    KIND[sid] = kind; EMPTY.add(sid);
    const v = mount(live(sid, node), "첫 지시를 들고 연 말");
    await sleep(1500);
    const r = v.look();
    v.done();
    return r;
  };
  //  못 읽는 하네스 — 열 때 409(문장)를 받은 뒤 목록 갱신(update)이 세 번 온다. 다시 열기를 되풀이하나 센다.
  const unreadable = async (sid, node, kind) => {
    KIND[sid] = kind; UNREADABLE.add(sid);
    const t = live(sid, node, { harness: "opencode" });
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:0;top:0;width:1000px;height:700px;display:flex;flex-direction:column;background:#fff";
    document.body.append(box);
    const hd = SC.mountSessionChat(box, t, { terminalSrc: () => null, onResumed: () => {} });
    await sleep(1500);
    const first = JSON.parse(JSON.stringify(H(sid)));
    for (let i = 0; i < 3; i++) { hd.update(live(sid, node, { harness: "opencode" })); await sleep(1000); }
    const after = JSON.parse(JSON.stringify(H(sid)));
    try { hd.destroy(); } catch (_) { /* 이미 */ }
    box.remove();
    return { first, after };
  };
  const stopOnly = async (sid, node, kind) => {
    KIND[sid] = kind;
    const v = mount(live(sid, node));
    await sleep(1500);
    v.stop();
    await sleep(800);
    const r = v.look();
    v.done();
    return r;
  };
  try {
    R.host = await full("box-host", HOST, "host");
    R.pc = await full("box-pc", PC, "pc");
    R.central = await full("box-central", null, "central");
    R.hostEmpty = await empty("box-host-empty", HOST, "host");
    R.pcEmpty = await empty("box-pc-empty", PC, "pc");
    R.hostWait = await wait("box-host-wait", HOST, "host");
    R.pcWait = await wait("box-pc-wait", PC, "pc");
    R.hostOld = await stopOnly("box-host-old", "sesshost-46e3", "host");
    //  ⚠ 멤버 PC 의 같은 장면은 없다 — 그 세션의 박스 경로는 409 node 라 «기록 없음» 갈래(첫 지시 말풍선)에 들어가지 않는다(종전 그대로).
    R.hostFirst = await first("box-host-first", HOST, "host");
    R.hostUnreadable = await unreadable("box-host-unread", HOST, "host");
  } catch (e) { R.err = String(e && e.stack || e); }
  R.pageErrors = pageErrors;
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const page = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out" style="position:fixed;left:-9999px">PENDING</pre>
<script type="text/plain" id="src">${sc.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;
const dom = await dumpDom(chrome, {
  html: page, serve: true, prefix: "chat-node-coord-", virtualTimeBudget: 180000, args: ["--window-size=1200,900"], copy: CSS,
});
const res = readOut(dom);
if (res.text === null) { console.error(`FAIL  페이지가 결과를 안 냈다(out=${JSON.stringify(res.out)}): ${dom.slice(0, 400)}`); process.exit(1); }
const R = JSON.parse(res.text);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const check = (cond, n, got) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} :: 실제 ${JSON.stringify(got)}`); } };
if (R.fatal || R.err) { fail++; console.error(`FAIL  페이지가 던졌다: ${String(R.fatal || R.err).split("\n").slice(0, 3).join(" | ")}`); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const noRemoteWords = (s) => !/그 컴퓨터|중앙 기록/.test(String(s));

const h = R.host || {}, p = R.pc || {}, c = R.central || {};
check(h.opened && h.opened.transcript >= 1 && h.stopFound && p.stopFound, "배선 — 가짜 서버가 기록 요청을 받았고 멈춤 단추를 찾았다", { h: h.opened, hs: h.stopFound, ps: p.stopFound });
check(h.opened && h.opened.outbox >= 1 && h.opened.failed && h.opened.qbuttons.includes("다시 보내기") && h.opened.qbuttons.includes("지우기"),
  "H1 세션 호스트 · 열기 → 전달 큐를 묻고 치지도 않은 실패를 «전달 안 됨»·[다시 보내기]·[지우기]로 그린다", h.opened);
check(h.stopped && eq(h.stopped.keys, ["interrupt"]) && h.stopped.note === "멈춤을 보냈어요.",
  "H2 세션 호스트 · 멈춤 → interrupt 키 요청 하나 · «멈춤을 보냈어요.»", h.stopped);
check(h.sent && eq(h.sent.prompt, ["새로 보내는 말"]) && h.sent.qstates.length >= 1 && h.sent.qstates.every(noRemoteWords) && h.later.outbox > h.outboxBeforeSend,
  "H4 세션 호스트 · 보내기 → 상태 줄에 «그 컴퓨터»·«중앙 기록» 없음 · 보낸 뒤 큐를 다시 묻는다", { sent: h.sent, later: h.later, before: h.outboxBeforeSend });
check(h.sentEarly && eq(h.sentEarly.prompt, ["새로 보내는 말"]) && h.sentEarly.qstates.every(noRemoteWords),
  "H4 세션 호스트 · 보낸 직후 큐 응답 전에도 상태 줄에 «그 컴퓨터로 전달했어요» 가 뜨지 않는다", h.sentEarly);
check(h.opened && h.opened.chip === "", "H6 세션 호스트 · 머리줄에 노드 칩(인스턴스 id)이 없다", h.opened);
check(h.opened && Array.isArray(h.opened.settings) && h.opened.settings.some((r) => r.includes("무엇으로 도나")) && !h.opened.settings.some((r) => r.includes("돌아가는 컴퓨터")),
  "H6 세션 호스트 · 설정 창에 «돌아가는 컴퓨터» 줄이 없다(창은 떴다)", h.opened && h.opened.settings);
check(h.opened && h.opened.aria === "이 세션에 보내기", "H4 세션 호스트 · 입력칸 이름에 «그 컴퓨터로 전달» 이 없다", h.opened && h.opened.aria);
const hf = R.hostFirst || {};
check(hf.said && hf.qstates.every(noRemoteWords) && noRemoteWords(hf.empty),
  "H4 세션 호스트 · 첫 지시를 들고 연 화면 → 그 말이 보이고 상태·안내에 «그 컴퓨터»·«중앙 기록» 없음", hf);

const he = R.hostEmpty || {};
check(he.first && he.first.empty && noRemoteWords(he.first.empty), "H5 세션 호스트 · 기록 아직 없음 → 빈 안내에 «그 컴퓨터»·«중앙 기록» 없음", he.first);
check(he.later && he.later.transcript >= 3 && he.later.log <= 1, "H5 세션 호스트 · 기록 아직 없음 → 박스 기록을 다시 묻고 중앙 기록은 폴링하지 않는다", he.later);

const hw = R.hostWait || {};
check(hw.first && hw.first.waitBtns.includes("기본 선택으로 답하기") && hw.first.waitBtns.includes("거부"),
  "H3 세션 호스트 · 질의 대기 → [기본 선택으로 답하기]·[거부] 단추가 선다", hw.first);
check(hw.clicked && hw.after && eq(hw.after.keys, ["deny"]), "H3 세션 호스트 · [거부] → deny 키 요청", hw);

const hu = R.hostUnreadable || {};
check(hu.first && hu.first.transcript === 1 && hu.after && hu.after.transcript === 1 && hu.after.log === hu.first.log,
  "H9 세션 호스트 · 못 읽는 하네스(409) → 목록 갱신이 와도 기록을 다시 열지 않는다(같은 답 — 종전엔 갱신마다 박스·중앙 기록을 또 물었다)", hu);

const ho = R.hostOld || {};
check(eq(ho.keys, ["interrupt"]) && ho.note === "멈춤을 보냈어요.", "H7 옛 축 세션 호스트(sesshost-46e3) · 멈춤 → interrupt 키 요청", ho);

check(p.opened && p.opened.outbox === 0 && !p.opened.failed, "P1 멤버 PC · 열기 → 큐를 묻지 않는다(종전 — 그 세션의 말은 그 컴퓨터로 곧장 간다)", p.opened);
check(p.stopped && p.stopped.keys.length === 0 && p.stopped.note === "멈출 턴이 없어요.", "P2 멤버 PC · 멈춤 → 키 요청 없음 · «멈출 턴이 없어요.»(종전)", p.stopped);
check(p.sent && p.sentEarly.qstates.some((s) => s.includes("그 컴퓨터로 전달했어요")) && p.sent.qstates.some((s) => s.includes("그 컴퓨터로 전달했어요")) && p.later.outbox === 0,
  "P4 멤버 PC · 보내기 → «그 컴퓨터로 전달했어요…» · 큐는 안 묻는다(종전)", { sentEarly: p.sentEarly, sent: p.sent, later: p.later });
check(p.opened && p.opened.chip === "laibeulliui-macmini", "P6 멤버 PC · 머리줄 칩에 그 컴퓨터 이름(종전)", p.opened);
check(p.opened && Array.isArray(p.opened.settings) && p.opened.settings.some((r) => r.includes("돌아가는 컴퓨터") && r.includes("laibeulliui-macmini")),
  "P6 멤버 PC · 설정 창에 «돌아가는 컴퓨터 — 그 이름»(종전)", p.opened && p.opened.settings);
check(p.opened && p.opened.aria === "이 세션에 보내기(그 컴퓨터로 전달)", "P4 멤버 PC · 입력칸 이름 «(그 컴퓨터로 전달)»(종전)", p.opened && p.opened.aria);

const pe = R.pcEmpty || {};
check(pe.first && /그 컴퓨터/.test(pe.first.empty), "P5 멤버 PC · 기록 아직 없음 → «그 컴퓨터의 세션은…» 안내(종전)", pe.first);
check(pe.later && pe.later.log >= 2 && pe.later.transcript <= 1, "P5 멤버 PC · 기록 아직 없음 → 중앙 기록을 폴링한다 · 박스는 한 번만(409 node)", pe.later);

const pw = R.pcWait || {};
check(pw.first && !pw.first.waitBtns.includes("거부") && !pw.first.waitBtns.includes("기본 선택으로 답하기") && !pw.clicked && pw.after.keys.length === 0,
  "P3 멤버 PC · 질의 대기 → 대신 누르는 단추 없음(종전 — 서버도 그 컴퓨터엔 키를 못 보낸다)", pw);

check(c.opened && c.opened.outbox >= 1 && c.opened.failed && c.opened.chip === "" && c.stopped && eq(c.stopped.keys, ["interrupt"]),
  "N1 좌표 없음(중앙) · 큐를 묻고 · 멈춤은 interrupt 키 요청(회귀 가드)", { opened: c.opened, stopped: c.stopped });

check(!(R.pageErrors || []).length, "페이지 오류 없음", R.pageErrors);
console.log(`\n${pass} passed, ${fail} failed — 대화창 노드 좌표(#4904)`);
process.exit(fail ? 1 : 0);
