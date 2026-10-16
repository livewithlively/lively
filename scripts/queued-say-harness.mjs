// 일하는 중에 보낸 말 화면 시험의 공통 틀 (#4850) — 가짜 서버 · 실제 세션 화면 모듈 · 장면들.
//  두 시험 파일이 장면 묶음 하나씩을 돌린다(queued-say-runtime: 다시 열기·위로 더·발자취 / queued-say-live-runtime: 라이브 보내기).
//  한 파일에 다 두면 크롬 실시간이 CI 파일당 예산(45초)에 가까워져(이 맥미니 부하 실측 47~125초) 둘로 나눴다.
//  가짜는 «서버»(기록 창 · 큐 · 보내기 응답)뿐이다. 세션 화면은 실제 모듈(web/session-chat.ts · web/session-trail.ts)을 싣는다.
//  fail-first: `SRC_ROOT=<옛 트리>`(web/ · public/styles 가 있는 곳)로 옛 코드를 물린다.
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, readOut } from "./headless-chrome.mjs";

/** 장면 묶음(group: "reopen" | "live")을 헤드리스 크롬에서 돌려 결과(R)를 돌려준다. 결과를 못 받으면 { fatal } 을 담아 돌려준다. */
export async function runQueuedSayScenes(chrome, group, root) {
  const CSS = ["01-base.css", "03-components.css", "36-chat.css", "38-chat-tui.css"].map((f) => path.join(root, "public/styles", f)).filter(existsSync);
  const sc = buildSync({
    stdin: { contents: "export { mountSessionChat } from './web/session-chat.ts'; export { replayTrail } from './web/session-trail.ts';", resolveDir: root, loader: "ts" },
    bundle: true, format: "iife", globalName: "SC", write: false, platform: "browser", target: "es2020", logLevel: "silent",
  }).outputFiles[0].text;
  const page = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out" style="position:fixed;left:-9999px">PENDING</pre>
<script type="text/plain" id="src">${sc.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})(${JSON.stringify(group)}).catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;
  //  크롬 실시간 상한(기본 20초)은 넉넉히 — 바쁜 기계에서 가상시간이 남았는데 실시간 상한에 먼저 걸리지 않게(term-warm 과 같은 사정).
  //   이 맥미니(다른 세션 빌드가 겹친 load 7~27)에서 같은 묶음이 13~104초로 흔들렸다. 오래 걸리는 것 자체는 CI 의 파일당 예산(45초)이 따로 잡는다.
  const dom = await dumpDom(chrome, { html: page, serve: true, prefix: "queued-say-" + group + "-", virtualTimeBudget: 200000, timeoutMs: 240000, args: ["--window-size=1200,900"], copy: CSS });
  const res = readOut(dom);
  if (res.text === null) return { fatal: `페이지가 결과를 안 냈다(out=${JSON.stringify(res.out)}): ${dom.slice(0, 300)}` };
  return JSON.parse(res.text);
}

async function PAGE_MAIN(GROUP) {
  const R = {};
  const pageErrors = [];
  window.addEventListener("error", (e) => pageErrors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => pageErrors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  //  ── 기록 줄 — Claude Code 2.1.301 실측 모양 ──
  //  시각은 «지금» 근처로 둔다 — 화면은 마지막 줄 시각으로 «오래 조용함» 을 판정한다(쉬는 세션의 도는 표시 마감 · 120초).
  let seq = 0;
  let clock = Date.now() - 10 * 60_000;
  const ts = () => { seq++; clock += 1000; return new Date(clock).toISOString(); };
  const line = (o) => JSON.stringify(o) + "\n";
  const user = (text, uuid) => line({ type: "user", uuid, timestamp: ts(), message: { role: "user", content: text } });
  const toolUse = (id, cmd) => line({ type: "assistant", uuid: "a-" + id, timestamp: ts(), message: { id: "m-" + id, role: "assistant", model: "claude-opus-4-1", content: [{ type: "tool_use", id, name: "Bash", input: { command: cmd } }] } });
  //  파일 쓰기 — 발자취가 «남긴 것» 으로 세우는 도구(명령 실행은 발자취 항목이 아니다).
  const writeUse = (id, file) => line({ type: "assistant", uuid: "a-" + id, timestamp: ts(), message: { id: "m-" + id, role: "assistant", model: "claude-opus-4-1", content: [{ type: "tool_use", id, name: "Write", input: { file_path: file, content: "x" } }] } });
  const toolRes = (id, out) => line({ type: "user", uuid: "r-" + id, timestamp: ts(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: out }] } });
  const ai = (text, uuid) => line({ type: "assistant", uuid: uuid || ("t-" + seq), timestamp: ts(), message: { id: "m-" + (uuid || seq), role: "assistant", model: "claude-opus-4-1", content: [{ type: "text", text }] } });
  const end = () => line({ type: "system", subtype: "turn_duration", uuid: "e-" + seq, timestamp: ts(), durationMs: 11000 });
  //  일하는 중에 친 말 — 줄 timestamp = 친 때, 파일엔 끼워 넣은 뒤 적힌다.
  //  backMs — 그 줄의 시각을 앞선 줄보다 이르게(실측: 줄 시각은 «친 때» 라 끼워 넣기 전에 적힌 도구 결과보다 이르다 — 중앙값 15초).
  const queued = (text, src, lineUuid, att = {}, backMs = 0) => {
    const at = backMs ? new Date(clock - backMs).toISOString() : ts();
    return line({ type: "attachment", uuid: lineUuid, timestamp: at, isSidechain: false,
      attachment: { type: "queued_command", prompt: text, source_uuid: src, delivery_id: "d-" + src, commandMode: "prompt", origin: { kind: "human" }, timestamp: at, humanTurn: true, ...att },
      renderedRole: "system" });
  };
  const enqueue = (text) => line({ type: "queue-operation", operation: "enqueue", timestamp: ts(), content: text });
  const NOTE = (id) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "기록: 정리" finished</summary>\n<usage><duration_ms>61000</duration_ms></usage>\n</task-notification>`;

  const TR = {};                                     // 세션 → 기록 원문(장면 도중에 자란다)
  const OB = {};                                     // 세션 → 큐 응답
  const FAIL_POST = {};
  const ACTS = [];                                   // [다시 보내기]·[지우기] 요청(배선 단언)
  let obSeq = 9000;
  const sidOf = (p, tail) => decodeURIComponent((new RegExp(`/sessions/([^/]+)/${tail}$`).exec(p) || [])[1] || "");
  window.fetch = async (url, init) => {
    const u = new URL(String(url), location.href);
    const method = String((init && init.method) || "GET").toUpperCase();
    if (/\/transcript$/.test(u.pathname)) {
      //  진짜 서버처럼 창(꼬리 · from/to)을 줄 경계에 맞추고 머리에 싣는다(rawGet 이 X-Log-* 를 읽는다).
      const sid = sidOf(u.pathname, "transcript");
      const all = TR[sid] || "";
      const size = all.length;
      let from = 0, to = size;
      if (u.searchParams.has("tail")) from = Math.max(0, size - Number(u.searchParams.get("tail")));
      if (u.searchParams.has("from")) from = Math.min(Number(u.searchParams.get("from")) || 0, size);
      if (u.searchParams.has("to")) to = Math.min(Number(u.searchParams.get("to")), size);
      if (from > 0 && all[from - 1] !== "\n") { const nl = all.indexOf("\n", from); from = nl < 0 || nl + 1 > to ? to : nl + 1; }
      return new Response(all.slice(from, to), { status: 200, headers: { "content-type": "text/plain",
        "X-Log-Bytes": String(size), "X-Log-From": String(from), "X-Log-To": String(to), "X-Session-Uuid": "conv-" + sid } });
    }
    if (/\/outbox$/.test(u.pathname)) return J({ items: OB[sidOf(u.pathname, "outbox")] || [] });
    //  [다시 보내기]·[지우기] — 행 상태만 바꿔 준다(진짜 서버의 retry 는 queued 로, discard 는 목록에서 뺀다).
    { const m = /\/sessions\/([^/]+)\/outbox\/(\d+)\/(retry|discard)$/.exec(u.pathname);
      if (m && method === "POST") {
        const sid = decodeURIComponent(m[1]), id = Number(m[2]);
        ACTS.push({ sid, id, act: m[3] });
        OB[sid] = (OB[sid] || []).flatMap((r) => r.id !== id ? [r] : m[3] === "discard" ? [] : [{ ...r, status: "queued", last_error: null }]);
        return J({ ok: true });
      } }
    if (/\/prompt$/.test(u.pathname) && method === "POST") {
      const sid = sidOf(u.pathname, "prompt");
      if (FAIL_POST[sid]) return J({ error: "전달 경로가 끊겼어요" }, 500);
      const text = JSON.parse(String(init.body || "{}")).text;
      const id = ++obSeq;
      const now = new Date().toISOString();
      (OB[sid] = OB[sid] || []).push({ id, seq: id, session_id: sid, text, status: "sending", kind: "prompt", attempts: 1, trust_ok: true,
        last_error: null, created_at: now, updated_at: now, delivered_at: null, stalled_since: null });
      return J({ outbox_id: id });
    }
    return J({ error: "no" }, 404);
  };
  //  «위로 더» 는 맨 위 표지가 보이면 부른다(IntersectionObserver). 이 틀(--dump-dom)에선 관찰자가 안 불리므로 «곧바로 보인다» 로 바꿔 낀다.
  window.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe(t) { setTimeout(() => this.cb([{ target: t, isIntersecting: true }]), 0); } unobserve() {} disconnect() {} };
  localStorage.setItem("lively_ui_token", "t");
  const SC = (new Function(document.getElementById("src").textContent + "\n;return SC;"))();

  const target = (id, o = {}) => ({ id, label: "세션", live: true, alive: o.alive !== false, node: null, owned: true, stateKey: o.working ? "busy" : "idle", stateLabel: "",
    projectId: null, projectName: "", raw: { harness: "claude", chatMode: "tmux", working: !!o.working, agentState: o.working ? "busy" : "idle" } });
  const mount = (id, o = {}) => {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:0;top:0;width:1000px;height:700px;display:flex;flex-direction:column;background:#fff";
    document.body.append(box);
    const TRAIL = [];
    const trail = { add: (it, at) => TRAIL.push({ id: it.id, kind: it.kind, label: it.label, at, ts: it.ts }), result: () => {}, clear: () => { TRAIL.length = 0; } };
    const h = SC.mountSessionChat(box, target(id, o), { terminalSrc: () => null, onResumed: () => {}, chatHome: !!o.desktop, trail });
    const list = () => box.querySelector(".livc-list") || box;
    const turns = () => [...list().querySelectorAll(":scope > .livc-turn")];
    const askOf = (sec) => { const a = sec.querySelector(".livc-ask-text"); return a ? norm(a.textContent) : null; };
    return {
      box, h, TRAIL,
      //  보이는 글로 센다(innerText) — 내 말 띠/말풍선에 그 글이 몇 번 섰나.
      asks: () => turns().map(askOf).filter((x) => x !== null),
      askCount: (text) => turns().filter((s) => askOf(s) === norm(text)).length,
      //  어느 턴(사람 말 머리 · 없으면 null)에 그 글이 들어 있나 — 턴 순서 번호와 그 턴의 머리.
      //  textContent 로 본다 — tui 는 도구 호출을 «Ran 1 shell command» 로 접어 명령·결과가 innerText 엔 안 보인다(접힌 것도 그 턴의 것이다).
      where: (text) => { const ts = turns(); for (let i = 0; i < ts.length; i++) { const w = ts[i].querySelector(".livc-work"); if (w && norm(w.textContent).includes(norm(text))) return { i, ask: askOf(ts[i]) }; } return null; },
      askIdx: (text) => turns().findIndex((x) => askOf(x) === norm(text)),
      //  «작업 중» 표시(입력칸의 busy — 멈춤 단추가 서는 상태). 도는 턴이 있는 동안 꺼지면 안 된다.
      busy: () => !!box.querySelector("form.tui-busy, form.dt-busy"),
      //  목록의 자식 순서 — 내 말 턴은 그 말, 사람 말 없는 턴은 "turn", 구분선은 "divider".
      order: () => [...list().children].map((n) => n.matches(".livc-divider") ? "divider" : n.matches(".livc-turn") ? (askOf(n) ?? "turn") : null).filter((x) => x !== null),
      lastAsk: () => { const ts = turns(); return ts.length ? askOf(ts[ts.length - 1]) : null; },
      stateOf: (text) => { const s = turns().find((x) => askOf(x) === norm(text)); const q = s && s.querySelector(".dt-qstate"); return q ? norm(q.textContent) : null; },
      spinIn: () => { const ts = turns(); const i = ts.findIndex((s) => s.querySelector(".tui-spin, .dt-live, .livc-live")); return i < 0 ? null : askOf(ts[i]); },
      notices: () => [...list().querySelectorAll(".tui-notice")].map((n) => norm(n.textContent)),
      //  화면 서명 — 턴·구분선마다 보이는 글(정규화). 라이브로 쌓인 화면과 새로 연 화면을 이것으로 견준다.
      sig: () => [...list().querySelectorAll(":scope > .livc-turn, :scope > .livc-divider")].map((n) => norm(n.innerText)),
      text: () => norm(list().innerText),
      click: (label, text) => { const t2 = turns().find((x) => askOf(x) === norm(text)); const b = t2 && [...t2.querySelectorAll(".dt-qstate button")].find((x) => norm(x.textContent) === label); if (b) b.click(); return !!b; },
      send: (text) => { const inp = box.querySelector("textarea"); inp.value = text; inp.dispatchEvent(new Event("input")); const f = inp.closest("form"); if (f.requestSubmit) f.requestSubmit(); else f.dispatchEvent(new Event("submit", { cancelable: true })); },
      done: () => { try { h.destroy(); } catch (_) { /* 이미 */ } box.remove(); },
    };
  };
  //  같은 기록을 새로 연 화면의 서명(죽은 세션으로 열어 — 다시 열기의 그 모양)
  const freshSig = async (sid, o = {}) => { const v = mount(sid, { alive: false, desktop: o.desktop }); await sleep(1500); const s = v.sig(); const a = v.asks(); v.done(); return { sig: s, asks: a }; };

  try {
    if (GROUP === "reopen") {
    // ── R1 다시 열기 — tui · desktop ───────────────────────────────────────────
    TR["box-r1"] = user("A 첫 지시 — 로그 정리해 줘", "u-a") + toolUse("t1", "sleep 30") + toolRes("t1", "Running in the background")
      + writeUse("w1", "/repo/docs/log-summary.md") + toolRes("w1", "File created")
      + queued("B 일하는 중에 보낸 말 — 이것도 같이 봐 줘", "src-b", "q-b", {}, 2500) + ai("B 에 대한 답이에요.", "ans-b") + end();
    for (const desktop of [false, true]) {
      const v = mount("box-r1", { alive: false, desktop });
      await sleep(1500);
      R["r1" + (desktop ? "d" : "t")] = { asks: v.asks(), b: v.askCount("B 일하는 중에 보낸 말 — 이것도 같이 봐 줘"), tool: v.where("sleep 30"), ans: v.where("B 에 대한 답이에요."), trail: v.TRAIL.filter((x) => x.kind === "say").map((x) => x.id), trailTs: Object.fromEntries(v.TRAIL.map((x) => [x.id, x.ts])) };
      v.done();
    }
    // ── R2 작업 끝 알림 끼워 넣기 ──────────────────────────────────────────────
    TR["box-r2"] = user("A 지시", "u-a2") + toolUse("t2", "sleep 5") + toolRes("t2", "ok")
      + line({ type: "attachment", uuid: "q-n", timestamp: ts(), attachment: { type: "queued_command", prompt: NOTE("ag1"), commandMode: "task-notification", origin: { kind: "task-notification", producer: "session-task" }, timestamp: ts() } })
      + ai("알림 받고 이어서 답", "ans-n") + end();
    {
      const v = mount("box-r2", { alive: false });
      await sleep(1500);
      R.r2 = { asks: v.asks(), notices: v.notices(), raw: v.text().includes("task-notification") };
      v.done();
    }
    // ── R3 사람이 아닌 끼워 넣기 ───────────────────────────────────────────────
    TR["box-r3"] = user("A 지시", "u-a3") + toolUse("t3", "ls") + toolRes("t3", "a b")
      + line({ type: "attachment", uuid: "q-p", timestamp: ts(), attachment: { type: "queued_command", prompt: '<agent-message from="a9">하위 에이전트 보고서 P</agent-message>', commandMode: "prompt", origin: { kind: "peer", from: "a9" }, isMeta: true } })
      + line({ type: "attachment", uuid: "q-c", timestamp: ts(), attachment: { type: "queued_command", prompt: '<channel source="plugin:discord:discord">채널 사람 말 C</channel>', commandMode: "prompt", origin: { kind: "channel" }, isMeta: true } })
      + line({ type: "attachment", uuid: "q-k", timestamp: ts(), attachment: { type: "queued_command", prompt: "코디네이터 지시 K", commandMode: "prompt", origin: { kind: "coordinator" } } })
      + ai("답 R3", "ans-r3") + end();
    {
      const v = mount("box-r3", { alive: false });
      await sleep(1500);
      R.r3 = { asks: v.asks(), p: v.text().includes("하위 에이전트 보고서 P"), c: v.text().includes("채널 사람 말 C"), k: v.text().includes("코디네이터 지시 K") };
      v.done();
    }
    // ── R4 같은 정체성은 한 번 · 다시 보낸 같은 글은 두 번 ─────────────────────
    TR["box-r4a"] = user("X 같은 말", "same-1") + ai("X 답", "ans-x") + end()
      + queued("X 같은 말", "same-1", "q-x");                      // 같은 말이 두 꼴로 적힌 기록(정체성 같음)
    TR["box-r4b"] = user("Y 다시 보낸 말", "y-1") + line({ type: "assistant", uuid: "err-y", timestamp: ts(), isApiErrorMessage: true, message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "Please run /login" }] } }) + end()
      + user("다른 일 Z", "z-1") + toolUse("t4", "make") + toolRes("t4", "built")
      + queued("Y 다시 보낸 말", "y-2", "q-y2") + ai("이제 Y 답", "ans-y") + end();   // 로그인 오류 뒤 사람이 다시 보냄(정체성 다름) — 실측 장면
    for (const sid of ["box-r4a", "box-r4b"]) {
      const v = mount(sid, { alive: false });
      await sleep(1500);
      R[sid] = { x: v.askCount("X 같은 말"), y: v.askCount("Y 다시 보낸 말"), asks: v.asks() };
      v.done();
    }
    // ── R9 위로 더 불러오기 — 끼워 넣은 말이 이전 창에 ────────────────────────
    {
      //  창(1.5MB)보다 긴 기록 — 앞쪽에 A · B(끼워 넣기)가 있고, 뒤는 화면이 안 그리는 큰 줄(파일 기록 사진)로 채운다.
      const filler = Array.from({ length: 34 }, (_, i) => line({ type: "file-history-snapshot", messageId: "f" + i, snapshot: { pad: "x".repeat(50_000) } })).join("");
      TR["box-r9"] = user("A 오래전 지시", "u-a9") + toolUse("t9", "sleep 60") + toolRes("t9", "done 60")
        + writeUse("w9", "/repo/notes/old.md") + toolRes("w9", "File created")
        + queued("B 오래전에 끼워 넣은 말", "src-b9", "q-b9", {}, 2500) + ai("B 오래전 답", "ans-b9") + end()
        + filler + user("C 최근 지시", "u-c9") + ai("C 답", "ans-c9") + end();
      const v = mount("box-r9", { alive: false });
      await sleep(3000);
      R.r9 = { asks: v.asks(), b: v.askCount("B 오래전에 끼워 넣은 말"), ans: v.where("B 오래전 답"), tool: v.where("sleep 60"), trail: v.TRAIL.filter((x) => x.kind === "say").map((x) => x.id), trailTs: Object.fromEntries(v.TRAIL.map((x) => [x.id, x.ts])), size: TR["box-r9"].length };
      v.done();
    }
    // ── R10 발자취 — 얇은 판 되감기 ───────────────────────────────────────────
    {
      const thin = [
        { type: "user", uuid: "u-a10", timestamp: "2026-10-16T14:00:00Z", message: { role: "user", content: [{ type: "text", text: "A 지시 R10" }] } },
        { type: "assistant", uuid: "a-10", timestamp: "2026-10-16T14:00:01Z", message: { role: "assistant", content: [{ type: "tool_use", id: "t10", name: "Write", input: { file_path: "/repo/web/r10.ts" } }] } },
        //  친 때(14:00:00.5)는 앞 줄(도구 호출 14:00:01)보다 이르다 — 줄은 끼워 넣은 뒤에 적혔다(실측 모양).
        { type: "attachment", uuid: "q-b10", timestamp: "2026-10-16T14:00:00.500Z", attachment: { type: "queued_command", prompt: "B 끼워 넣은 말 R10", commandMode: "prompt", origin: { kind: "human" }, source_uuid: "src-b10" } },
        { type: "attachment", uuid: "q-p10", timestamp: "2026-10-16T14:00:03Z", attachment: { type: "queued_command", prompt: "peer 말 R10", commandMode: "prompt", origin: { kind: "peer" } } },
        { type: "assistant", uuid: "a-11", timestamp: "2026-10-16T14:00:04Z", message: { role: "assistant", content: [{ type: "text", text: "B 답 R10" }] } },
      ].map((o) => JSON.stringify(o)).join("\n") + "\n";
      const W = [];
      SC.replayTrail({ add: (it) => W.push({ id: it.id, kind: it.kind, label: it.label, ts: it.ts }), result: () => {} }, thin);
      //  loadThinTrail 은 붓고 나서 시간순으로 다시 세운다(sortByTime — 안정 정렬) — 그 순서에서 A 의 도구 호출이 B 장보다 앞이어야 A 장에 남는다.
      const sorted = W.map((x, i) => ({ ...x, i })).sort((a, b) => (Date.parse(a.ts || "") || 0) - (Date.parse(b.ts || "") || 0) || a.i - b.i).map((x) => x.id);
      R.r10 = { says: W.filter((x) => x.kind === "say").map((x) => x.id), labels: W.filter((x) => x.kind === "say").map((x) => x.label), sorted };
    }
    } else {
    // ── R5 라이브 · 도는 중에 보냄 → 끼워 넣어짐 ───────────────────────────────
    {
      TR["box-r5"] = user("A 도는 지시", "u-a5") + toolUse("t5", "npm test");
      const v = mount("box-r5", { working: true });
      await sleep(1500);
      v.send("B 도는 중에 보낸 말");
      await sleep(600);
      R.r5 = { sent: { asks: v.asks(), last: v.lastAsk(), spin: v.spinIn() } };
      TR["box-r5"] += enqueue("B 도는 중에 보낸 말") + ai("A 하던 일 출력 — 테스트가 도는 중", "mid-a");
      OB["box-r5"] = [];                                          // 하네스에 넣었다(큐에서 사라짐) — 아직 끼워 넣지는 않았다
      await sleep(3200);
      R.r5.waiting = { asks: v.asks(), last: v.lastAsk(), mid: v.where("A 하던 일 출력 — 테스트가 도는 중"), state: v.stateOf("B 도는 중에 보낸 말"), spin: v.spinIn() };
      TR["box-r5"] += toolRes("t5", "42 passed") + queued("B 도는 중에 보낸 말", "src-b5", "q-b5") + ai("B 에 대한 답 R5", "ans-b5") + end();
      await sleep(2000);
      R.r5.after = { asks: v.asks(), b: v.askCount("B 도는 중에 보낸 말"), state: v.stateOf("B 도는 중에 보낸 말"), res: v.where("42 passed"), ans: v.where("B 에 대한 답 R5"), sig: v.sig(), trail: v.TRAIL.filter((x) => x.kind === "say").map((x) => x.id) };
      v.done();
      R.r5.fresh = await freshSig("box-r5");
    }
    // ── R6 라이브 · 도는 중에 보냈는데 턴이 먼저 끝나 사람 말 줄로 들어감 ─────────
    {
      TR["box-r6"] = user("A 마무리 지시", "u-a6") + toolUse("t6", "git status") + toolRes("t6", "clean") + ai("A 정리하는 중", "mid-a6");
      const v = mount("box-r6", { working: true });
      await sleep(1500);
      v.send("B 턴 끝에 들어갈 말");
      await sleep(600);
      TR["box-r6"] += ai("A 답 끝", "fin-a6") + end();
      OB["box-r6"] = [];
      await sleep(2000);
      R.r6 = { mid: { last: v.lastAsk(), fin: v.where("A 답 끝") } };
      TR["box-r6"] += user("B 턴 끝에 들어갈 말", "u-b6") + ai("B 답 R6", "ans-b6") + end();
      await sleep(2000);
      R.r6.after = { asks: v.asks(), b: v.askCount("B 턴 끝에 들어갈 말"), fin: v.where("A 답 끝"), ans: v.where("B 답 R6"), sig: v.sig() };
      v.done();
      R.r6.fresh = await freshSig("box-r6");
    }
    // ── R7 라이브 · 쉬는 중에 보냄 ─────────────────────────────────────────────
    {
      clock = Date.now() - 5000;                                  // 방금 끝난 턴(조용해진 지 몇 초)
      TR["box-r7"] = user("A 끝난 지시", "u-a7") + ai("A 답", "ans-a7") + end();
      const v = mount("box-r7", { working: false });
      await sleep(1500);
      v.send("B 쉬는 중에 보낸 말");
      await sleep(300);
      R.r7 = { asks: v.asks(), last: v.lastAsk(), spin: v.spinIn() };
      v.done();
    }
    // ── R8 라이브 · 도는 중에 둘을 보냄 → 같은 틈에 둘 다 ──────────────────────
    {
      TR["box-r8"] = user("A 긴 지시", "u-a8") + toolUse("t8", "npm run build");
      const v = mount("box-r8", { working: true });
      await sleep(1500);
      v.send("B1 첫째 말");
      await sleep(300);
      v.send("B2 둘째 말");
      await sleep(600);
      TR["box-r8"] += ai("A 빌드 출력", "mid-a8");
      await sleep(1500);
      R.r8 = { waiting: { asks: v.asks(), mid: v.where("A 빌드 출력") } };
      TR["box-r8"] += toolRes("t8", "build ok") + queued("B1 첫째 말", "src-b81", "q-b81") + queued("B2 둘째 말", "src-b82", "q-b82") + ai("둘 다 반영한 답", "ans-b8") + end();
      OB["box-r8"] = [];                                          // 서버도 에코를 보고 큐에서 뺐다(새로 연 화면이 대기 말풍선을 다시 세우지 않게 — 실제 순서)
      await sleep(2000);
      R.r8.after = { asks: v.asks(), b1: v.askCount("B1 첫째 말"), b2: v.askCount("B2 둘째 말"), ans: v.where("둘 다 반영한 답"), sig: v.sig() };
      v.done();
      R.r8.fresh = await freshSig("box-r8");
    }
    // ── R11 도는 중 보내기 실패 ─────────────────────────────────────────────────
    {
      TR["box-r11"] = user("A 도는 지시 R11", "u-a11") + toolUse("t11", "sleep 100");
      FAIL_POST["box-r11"] = true;
      const v = mount("box-r11", { working: true });
      await sleep(1500);
      const before = v.spinIn(), busyBefore = v.busy();
      v.send("B 못 간 말");
      await sleep(800);
      R.r11 = { before, busyBefore, spin: v.spinIn(), busy: v.busy(), failText: v.text().includes("보내지 못했습니다"), asks: v.asks() };
      v.done();
    }
    //  큐 행의 상태를 바꾼다(서버가 그 행을 어떻게 마감했나).
    const setRow = (sid, text, patch) => { OB[sid] = (OB[sid] || []).map((r) => r.text === text ? { ...r, ...patch } : r); };
    const dropRow = (sid, text) => { OB[sid] = (OB[sid] || []).filter((r) => r.text !== text); };
    // ── R12 붙들린 말풍선 위로 새 턴이 선다(작업 끝 알림이 연 턴) ────────────────
    {
      TR["box-r12"] = user("A 지시 R12", "u-a12") + toolUse("t12", "make lint") + toolRes("t12", "clean") + ai("A 정리 중 R12", "mid-a12");
      const v = mount("box-r12", { working: true });
      await sleep(1500);
      v.send("B 알림 뒤에 들어갈 말");
      await sleep(600);
      dropRow("box-r12", "B 알림 뒤에 들어갈 말");
      //  하던 턴이 끝나고, 쉬는 사이 백그라운드 작업 끝 알림이 먼저 새 턴을 연다(사람 말 줄 꼴 — 터미널은 `⏺ … finished` 한 줄) — 그 답까지.
      TR["box-r12"] += ai("A 답 끝 R12", "fin-a12") + end()
        + line({ type: "user", uuid: "n-12", timestamp: ts(), message: { role: "user", content: NOTE("bg12") } }) + ai("알림 받고 한 말 R12", "ans-n12") + end();
      await sleep(2000);
      R.r12 = { mid: { last: v.lastAsk(), note: v.where("알림 받고 한 말 R12"), fin: v.where("A 답 끝 R12"), bIdx: v.askIdx("B 알림 뒤에 들어갈 말") } };
      TR["box-r12"] += user("B 알림 뒤에 들어갈 말", "u-b12") + ai("B 답 R12", "ans-b12") + end();
      await sleep(2000);
      R.r12.after = { asks: v.asks(), b: v.askCount("B 알림 뒤에 들어갈 말"), note: v.where("알림 받고 한 말 R12"), ans: v.where("B 답 R12"), sig: v.sig() };
      v.done();
      R.r12.fresh = await freshSig("box-r12");
    }
    // ── R13 나중 말이 먼저 들어간다(앞 말은 전달 실패) ──────────────────────────
    {
      TR["box-r13"] = user("A 지시 R13", "u-a13") + toolUse("t13", "npm test");
      const v = mount("box-r13", { working: true });
      await sleep(1500);
      v.send("B1 못 들어간 말 R13");
      await sleep(300);
      v.send("B2 들어간 말 R13");
      await sleep(600);
      setRow("box-r13", "B1 못 들어간 말 R13", { status: "failed", last_error: "not-ready" });
      dropRow("box-r13", "B2 들어간 말 R13");
      TR["box-r13"] += toolRes("t13", "ok 13") + queued("B2 들어간 말 R13", "src-b13", "q-b13") + ai("B2 답 R13", "ans-b13") + end();
      await sleep(3200);
      R.r13 = { asks: v.asks(), ans: v.where("B2 답 R13"), failed: v.stateOf("B1 못 들어간 말 R13"), sig: v.sig() };
      v.done();
      R.r13.fresh = await freshSig("box-r13");
    }
    // ── R14 도는 중 [다시 보내기] — 하던 턴의 도는 표시를 뺏지 않는다 ─────────────
    {
      TR["box-r14"] = user("A 지시 R14", "u-a14") + toolUse("t14", "sleep 300");
      const v = mount("box-r14", { working: true });
      await sleep(1500);
      v.send("B 다시 보낼 말 R14");
      await sleep(600);
      setRow("box-r14", "B 다시 보낼 말 R14", { status: "failed", last_error: "not-ready" });
      await sleep(3000);
      const before = { spin: v.spinIn(), state: v.stateOf("B 다시 보낼 말 R14") };
      const clicked = v.click("다시 보내기", "B 다시 보낼 말 R14");
      await sleep(400);
      R.r14 = { before, clicked, acts: ACTS.filter((a) => a.sid === "box-r14").map((a) => a.act), spin: v.spinIn(), state: v.stateOf("B 다시 보낼 말 R14") };
      v.done();
    }
    // ── R15 [지우기] 한 말풍선이 지금 턴이었다 — 그 뒤의 줄이 지운 턴에 붙지 않는다 ─────
    {
      clock = Date.now() - 5000;
      TR["box-r15"] = user("A 끝난 지시 R15", "u-a15") + ai("A 답 R15", "ans-a15") + end();
      const v = mount("box-r15", { working: false });
      await sleep(1500);
      v.send("B 지울 말 R15");
      await sleep(400);
      setRow("box-r15", "B 지울 말 R15", { status: "failed", last_error: "not-ready" });
      await sleep(3000);
      const clicked = v.click("지우기", "B 지울 말 R15");
      await sleep(400);
      TR["box-r15"] += ai("주인 없는 답 R15", "orph-15");
      await sleep(3500);
      R.r15 = { clicked, acts: ACTS.filter((a) => a.sid === "box-r15").map((a) => a.act), asks: v.asks(), orphan: v.text().includes("주인 없는 답 R15") };
      v.done();
    }
    // ── R16 슬래시 명령은 붙들지 않는다 — 기록에 사람 말로 안 남는다(하네스가 그 자리에서 실행) ─────────────
    {
      clock = Date.now() - 5000;
      TR["box-r16"] = user("A 끝난 지시 R16", "u-a16") + ai("A 답 R16", "ans-a16") + end();
      const v = mount("box-r16", { working: false });
      await sleep(1500);
      v.send("/compact");
      await sleep(400);
      dropRow("box-r16", "/compact");
      //  Claude Code 는 명령 줄(주입 — 사람 말 아님)과 압축 구분을 적고, 압축 뒤 대화가 이어진다.
      TR["box-r16"] += line({ type: "user", uuid: "cmd-16", timestamp: ts(), message: { role: "user", content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>" } })
        + line({ type: "system", subtype: "compact", uuid: "cp-16", timestamp: ts(), text: "앞 대화 요약 R16" }) + ai("압축 뒤 답 R16", "ans-c16") + end();
      await sleep(2500);
      R.r16 = { order: v.order(), after: v.where("압축 뒤 답 R16") };
      //  그 뒤 터미널에서 친 지시가 돈다 — 기록에 안 나타나는 `/compact` 말풍선은 대기 목록에 남아 있지만 «다음 틈» 을 말하면 거짓이다.
      TR["box-r16"] += user("C 터미널에서 친 지시 R16", "u-c16") + toolUse("t16", "sleep 120");
      await sleep(6500);                                          // 쉬는 세션의 기록 폴(3초) + 그 뒤 큐 폴(3초)
      R.r16.later = { running: v.spinIn(), state: v.stateOf("/compact") };
      v.done();
    }
    // ── R17 처음 열 때 마지막 줄이 오래전에 친 끼워 넣기 줄 — «오래 조용함» 으로 도는 턴을 마감하지 않는다 ─────────────
    {
      //  하네스 상태 보고가 없는 세션(working 거짓)에서 화면은 마지막 줄 시각으로 «도는 중» 을 가른다(120초). 끼워 넣기 줄의 시각은 친 때라 앞 줄보다
      //   몇 분 이를 수 있다 — 그 줄이 마지막이면 그 시각으로 재지 말아야 한다(방금 끼워 넣어져 이제 답할 차례다).
      clock = Date.now() - 20_000;
      TR["box-r17"] = user("A 긴 작업 R17", "u-a17") + toolUse("t17", "make release") + toolRes("t17", "release ok")
        + queued("B 3분 전에 친 말 R17", "src-b17", "q-b17", {}, 200_000);
      const v = mount("box-r17", { working: false });
      await sleep(1500);
      R.r17 = { asks: v.asks(), spin: v.spinIn() };
      v.done();
    }
    }
  } catch (e) { R.err = String(e && e.stack || e); }
  R.pageErrors = pageErrors;
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}
