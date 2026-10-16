#!/usr/bin/env node
// 답까지 끝난 말이 회수 뒤 다시 열면 «보냈지만 세션 기록에서 확인되지 않았어요» 로 또 그려지던 것 (#4819, 런타임).
//
//  신고(상민님 2026-10-16): «대화창 세션에서 이미 보내진 프롬프트고 답변까지 다 끝낸 다음 회수된 세션 들어가면 다시 대화창
//   나오잖아. 근데 이전에 보내고 처리 끝난 그 프롬프트가 아래 문구 뜨면서 대화창에서 보여 — 보냈지만 세션 기록에서 확인되지
//   않았어요 — 안 들어갔을 수 있어요 [다시 보내기][지우기]»
//  원인: 서버 큐 행이 'sent·echo-unconfirmed'(친 뒤 15초 창의 판정)로 남았고, 화면은 기록을 다 그린 뒤 그 행을 «처음 보는 행» 으로
//   읽어 맨 아래에 대기 말풍선을 또 세웠다. 매니지드 실측 행 131295(세션 c3d46537): 큐 07:58:32 · 그 말의 기록 줄 시각 07:59:07 ·
//   서버가 07:59:29 에 «미확인» 으로 마감(UserPromptSubmit 훅이 22.5초 — Claude Code 는 훅이 끝난 뒤에야 그 줄을 적는다).
//  서버는 이제 목록을 줄 때 기록과 다시 대조해 바로잡는다(src/sessions/outbox-late-echo.ts · 시험 outbox-late-echo.test).
//   이 시험은 **서버가 여전히 «미확인» 을 줄 때**(대조가 못 읽음·배포 전 서버) 화면이 스스로 지키는 몫을 잰다.
//
//  엣지 표(행마다 장면 하나 — 스크래치패드 spec-4819.md 의 O 행):
//   O1 회수된 세션 · 기록에 그 말(행보다 뒤)과 답이 있다 · 큐는 sent·echo-unconfirmed → 경고 없음 · 그 말은 한 번만 보인다(신고 장면)
//   O2 같은데 기록에 그 말이 없다(정말 안 들어갔다) → 경고가 보인다([다시 보내기]·[지우기]) · 그 말은 대기 말풍선으로 한 번
//   O3 기록에 같은 말이 있지만 행보다 **앞**에 적혔다(같은 지시를 두 번 보냄) → 경고가 보인다(두 번째가 안 들어갔을 수 있다)
//   O4 열어 둔 화면 · 처음엔 기록에 없다(경고) → 기록이 그 말을 늦게 적는다 · 큐는 계속 «미확인» → 경고가 걷히고 그 말은 한 번만
//      (종전: 말풍선이 기록에 이어져 대기 목록에서 빠지면, 다음 3초 폴링이 그 행을 처음 보는 행으로 읽어 맨 아래에 또 세웠다)
//   O5 큐가 failed·send: host-unknown(호스트가 쳤는지 모를 때 같은 15초 창이 붙이는 이름) · 기록에 그 말(행보다 뒤) → «전달 안 됨» 없음
//   O6 큐가 failed·not-ready(입력창이 끝내 안 떠 **치지도 않은** 실패) · 기록에 같은 말이 행보다 뒤에 있어도 → 그대로 «전달 안 됨»
//      (기록 대조는 «쳤는데 못 봤다» 둘에만 쓴다 — 아예 안 친 실패를 덮지 않는다)
//   O7 열어 둔 화면 · 기록이 그 말을 실었는데 큐는 아직 sending(서버가 에코를 기다리는 창 안) → 같은 말을 맨 아래에 또 세우지 않는다
//      (종전: 기록에 이어진 말풍선이 대기 목록에서 빠진 뒤 «전달하는 중…» 짝이 맨 아래에 다시 서고, 큐에서 빠지면 빈 줄로 남았다)
//   O8 같은 글의 행 둘 — 하나는 sending(낙관 말풍선이 있다) · 하나는 «미확인» · 기록엔 둘 다 없다 → 둘 다 보인다
//      (아직 기록에 안 이어진 낙관 말풍선은 «들어갔다» 의 증거가 아니다)
//
//  가짜는 «서버»(기록·큐 응답)뿐이다. 세션 화면은 실제 모듈(web/session-chat.ts)을 싣는다.
//  fail-first: `SRC_ROOT=<옛 트리>`(web/ · public/styles 가 있는 곳)로 옛 코드를 물린다.
//  크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 늦은 에코 화면 런타임 검증 미실행"); process.exit(0); }

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
  const user = (text, ts) => line({ type: "user", timestamp: ts, message: { role: "user", content: text } });
  const ai = (text, ts) => line({ type: "assistant", timestamp: ts, message: { role: "assistant", model: "claude-opus-4-1", content: [{ type: "text", text }] } })
    + line({ type: "system", subtype: "turn_duration", timestamp: ts, durationMs: 4000 });
  //  실측 행의 모양 — 큐 시각 07:58:32 · 그 말의 기록 줄 07:59:07(행보다 35초 뒤).
  const QUEUED = "2026-10-16T07:58:32.321Z";
  const SAID = "자료 공개범위 설정 끈 곳에는 전체에게 보이게해. 단, 이거는 공개범위 설정여부와 무관하게 먼저 검토하면 되는 일이잖아.";
  const OLD = user("예전에 물어본 말", "2026-10-16T07:40:00Z") + ai("예전 답", "2026-10-16T07:40:05Z");
  const ECHO = user(SAID, "2026-10-16T07:59:07.361Z") + ai("반영했습니다 — 공개범위를 전체로 바꿨어요.", "2026-10-16T08:05:02Z");
  const row = (st, err) => ({ id: 131295, seq: 3, session_id: "", text: SAID, status: st, kind: "prompt", attempts: 0, trust_ok: false,
    last_error: err, created_at: QUEUED, updated_at: "2026-10-16T07:59:29.849Z", delivered_at: null, stalled_since: null });
  const TRANSCRIPTS = {
    "box-o1": OLD + ECHO,
    "box-o2": OLD,
    "box-o3": user(SAID, "2026-10-16T07:41:00Z") + ai("그때 답", "2026-10-16T07:41:09Z"),
    "box-o4": OLD,                                              // 장면 도중에 ECHO 가 붙는다
    "box-o5": OLD + ECHO,
    "box-o6": OLD + ECHO,
    "box-o7": OLD,                                              // 장면 도중에 ECHO 가 붙는다
    "box-o8": OLD,
  };
  const OUTBOX = {
    "box-o1": [row("sent", "echo-unconfirmed")],
    "box-o2": [row("sent", "echo-unconfirmed")],
    "box-o3": [row("sent", "echo-unconfirmed")],
    "box-o4": [row("sent", "echo-unconfirmed")],
    "box-o5": [row("failed", "send: host-unknown")],
    "box-o6": [row("failed", "not-ready")],
    "box-o7": [row("sending", null)],
    "box-o8": [row("sending", null), Object.assign(row("sent", "echo-unconfirmed"), { id: 131296, seq: 4, created_at: "2026-10-16T07:58:40.000Z" })],
  };
  const outboxHits = {};
  //  O4 배선 — «기록이 그 말을 실어 준 뒤에 큐를 다시 물었나» 를 시각으로 잰다(그 물음이 곧 종전 결함이 다시 세우던 자리다).
  const o4 = { echoServedAt: 0, outboxAt: [] };
  const sidOf = (p, tail) => decodeURIComponent((new RegExp(`/sessions/([^/]+)/${tail}$`).exec(p) || [])[1] || "");
  window.fetch = async (url) => {
    const u = new URL(String(url), location.href);
    if (/\/transcript$/.test(u.pathname)) {
      //  진짜 서버처럼 창(from · 크기)을 머리에 싣는다 — 안 실으면 화면의 폴링이 «파일이 줄었다» 로 읽고 처음부터 다시 그린다.
      const sid = sidOf(u.pathname, "transcript");
      const all = TRANSCRIPTS[sid] || "";
      const from = u.searchParams.has("from") ? Math.min(Number(u.searchParams.get("from")) || 0, all.length) : 0;
      if (sid === "box-o4" && !o4.echoServedAt && all.slice(from).includes(SAID)) o4.echoServedAt = performance.now();
      return new Response(all.slice(from), { status: 200, headers: { "content-type": "text/plain",
        "X-Log-Bytes": String(all.length), "X-Log-From": String(from), "X-Log-To": String(all.length) } });
    }
    if (/\/outbox$/.test(u.pathname)) {
      const sid = sidOf(u.pathname, "outbox");
      outboxHits[sid] = (outboxHits[sid] || 0) + 1;
      //  기록 폴과 큐 폴이 같은 가상 시각에 돈다(둘 다 3초) — 큐 응답을 조금 늦게 줘 «기록이 실은 뒤 큐 응답» 순서를 확정하고,
      //   그 응답 시각을 잰다(종전 결함이 다시 세우던 바로 그 순서다).
      if (sid === "box-o4" || sid === "box-o7") { await sleep(50); if (sid === "box-o4") o4.outboxAt.push(performance.now()); }
      return J({ items: OUTBOX[sid] || [] });
    }
    return J({ error: "no" }, 404);
  };
  localStorage.setItem("lively_ui_token", "t");
  const SC = (new Function(document.getElementById("src").textContent + "\n;return SC;"))();
  //  회수된 세션의 목록 행(하네스 꺼짐 · 되살릴 수 있음) — 대화창이 뜨는 그 모양.
  const reclaimed = (id) => ({ id, label: "세션", live: true, alive: false, node: null, owned: true, stateKey: "restorable", stateLabel: "중단됨",
    projectId: null, projectName: "", raw: { harness: "claude", chatMode: "tmux", restorable: true } });
  const mount = (id) => {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:0;top:0;width:1000px;height:700px;display:flex;flex-direction:column;background:#fff";
    document.body.append(box);
    const h = SC.mountSessionChat(box, reclaimed(id), { terminalSrc: () => null, onResumed: () => {} });
    const chat = () => box.querySelector(".sc-chat") || box;
    return {
      count: (text) => chat().innerText.split(text).length - 1,   // 보이는 글(innerText)로 센다
      warn: () => chat().innerText.includes("보냈지만 세션 기록에서 확인되지 않았어요"),
      failed: () => chat().innerText.includes("전달 안 됨"),
      buttons: () => [...box.querySelectorAll(".dt-qstate button")].map((b) => b.textContent.trim()),
      done: () => { try { h.destroy(); } catch (_) { /* 이미 */ } box.remove(); },
    };
  };
  const look = (v, sid) => ({ said: v.count(SAID), warn: v.warn(), failed: v.failed(), buttons: v.buttons(), outboxHits: outboxHits[sid] || 0 });
  try {
    for (const sid of ["box-o1", "box-o2", "box-o3", "box-o5", "box-o6", "box-o8"]) {
      const v = mount(sid);
      await sleep(1500);                                         // 기록 그리기 → 큐 맞추기
      R[sid] = { first: look(v, sid) };
      await sleep(6500);                                         // 큐 폴링 두어 번 — 다시 세우지 않나
      R[sid].later = look(v, sid);
      v.done();
    }
    {
      const v = mount("box-o4");
      await sleep(1500);
      R["box-o4"] = { before: look(v, "box-o4") };
      TRANSCRIPTS["box-o4"] = OLD + ECHO;                         // 하네스가 그 말을 늦게 적었다(훅이 끝난 뒤)
      await sleep(4000);                                         // 기록 폴(3초) — 대기 말풍선이 그 줄에 이어진다
      R["box-o4"].echoed = look(v, "box-o4");
      await sleep(7000);                                         // 큐 폴(3초) 두어 번 — 서버는 여전히 «미확인» 을 준다
      R["box-o4"].after = look(v, "box-o4");
      R["box-o4"].askedAfterEcho = o4.echoServedAt > 0 && o4.outboxAt.some((at) => at > o4.echoServedAt);
      v.done();
    }
    {
      const v = mount("box-o7");
      await sleep(1500);
      R["box-o7"] = { before: look(v, "box-o7") };
      TRANSCRIPTS["box-o7"] = OLD + ECHO;                         // 하네스가 받아 적었다 — 서버는 아직 에코 창 안(sending)
      await sleep(4000);
      R["box-o7"].echoed = look(v, "box-o7");
      await sleep(7000);
      R["box-o7"].after = look(v, "box-o7");
      v.done();
    }
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
  html: page, serve: true, prefix: "outbox-late-echo-", virtualTimeBudget: 90000, args: ["--window-size=1200,900"], copy: CSS,
});
const res = readOut(dom);
if (res.text === null) { console.error(`FAIL  페이지가 결과를 안 냈다(out=${JSON.stringify(res.out)}): ${dom.slice(0, 400)}`); process.exit(1); }
const R = JSON.parse(res.text);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const check = (cond, n, got) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} :: 실제 ${JSON.stringify(got)}`); } };
if (R.fatal || R.err) { fail++; console.error(`FAIL  페이지가 던졌다: ${String(R.fatal || R.err).split("\n").slice(0, 3).join(" | ")}`); }

const o1 = R["box-o1"] || {};
check(o1.first && o1.first.outboxHits >= 1, "O1 전제 — 화면이 큐를 물었다(큐 응답은 sent·echo-unconfirmed)", o1.first);
check(o1.first && !o1.first.warn && o1.first.said === 1, "O1 회수된 세션 · 기록에 그 말과 답이 있다 → 경고 없음 · 그 말은 한 번만(신고 장면)", o1.first);
check(o1.later && !o1.later.warn && o1.later.said === 1, "O1 폴링이 지나도 맨 아래에 다시 세우지 않는다", o1.later);

const o2 = R["box-o2"] || {};
check(o2.first && o2.first.warn && o2.first.said === 1 && o2.first.buttons.includes("다시 보내기") && o2.first.buttons.includes("지우기"),
  "O2 기록에 그 말이 없다(정말 안 들어갔다) → 경고와 [다시 보내기]·[지우기]가 그대로 보인다", o2.first);
check(o2.later && o2.later.warn && o2.later.said === 1 && o2.later.outboxHits > o2.first.outboxHits,
  "O2 큐를 다시 물은 뒤에도 한 번만(두 번 세우지 않는다)", o2.later);

const o3 = R["box-o3"] || {};
check(o3.later && o3.later.warn && o3.later.said === 2,
  "O3 같은 말이 행보다 앞에 적혀 있다(같은 지시 두 번) → 경고가 보인다 · 옛 말과 대기 말풍선으로 두 번", o3.later);

const o4 = R["box-o4"] || {};
check(o4.before && o4.before.warn && o4.before.said === 1, "O4 전제 — 기록에 아직 없을 땐 경고가 보인다(사실 그대로)", o4.before);
check(o4.echoed && !o4.echoed.warn && o4.echoed.said === 1, "O4 기록이 그 말을 늦게 적는다 → 대기 말풍선이 그 줄에 이어지고 경고가 걷힌다", o4.echoed);
check(o4.askedAfterEcho === true, "O4 전제 — 기록이 그 말을 실어 준 뒤에 화면이 큐를 다시 물었다(큐는 여전히 «미확인»)", o4);
check(o4.after && !o4.after.warn && o4.after.said === 1,
  "O4 큐가 계속 «미확인» 을 줘도 맨 아래에 같은 말을 또 세우지 않는다", o4.after);

const o5 = R["box-o5"] || {};
check(o5.later && !o5.later.failed && !o5.later.warn && o5.later.said === 1,
  "O5 failed·send: host-unknown 인데 기록에 그 말(행보다 뒤) → «전달 안 됨» 을 그리지 않는다 · 한 번만", o5.later);

const o6 = R["box-o6"] || {};
check(o6.later && o6.later.failed && o6.later.said === 2,
  "O6 failed·not-ready(치지도 않은 실패)는 기록에 같은 말이 있어도 그대로 «전달 안 됨»", o6.later);

const o7 = R["box-o7"] || {};
check(o7.before && o7.before.said === 1 && !o7.before.warn, "O7 전제 — 기록에 실리기 전엔 대기 말풍선 하나(전달하는 중)", o7.before);
check(o7.echoed && o7.echoed.said === 1 && o7.after && o7.after.said === 1 && o7.after.outboxHits > o7.before.outboxHits,
  "O7 기록이 실은 뒤 큐가 아직 sending 이라고 답해도 같은 말을 맨 아래에 또 세우지 않는다", o7);

const o8 = R["box-o8"] || {};
check(o8.later && o8.later.said === 2 && o8.later.warn,
  "O8 같은 글의 행 둘(sending · 미확인) · 기록엔 없음 → 둘 다 보인다(낙관 말풍선은 증거가 아니다)", o8.later);

check(!(R.pageErrors || []).length, "페이지 오류 없음", R.pageErrors);
console.log(`\n${pass} passed, ${fail} failed — 늦은 에코 화면(#4819)`);
process.exit(fail ? 1 : 0);
