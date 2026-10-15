#!/usr/bin/env node
// 하네스 종료 규칙(#4695 T5)이 끈 세션을 다시 열었을 때 — 대화창이 쪽지로 **입력칸을 채우고 질문을 다시 보여 주나**(런타임).
//
//  서버(sessions/session-stop-rule.ts)는 끄기 직전 화면에서 쓰다 만 글·질문을 읽어 복원 가능 행에 싣는다(SessionInfo.stopNote).
//  대화창(web/session-chat.ts applyStopNote · renderStopQuestion)이 그 쪽지로:
//   K1 쓰다 만 글 → 입력칸 · «보내지 못한 말을 입력칸에 돌려 두었어요»
//   K2 사람이 입력칸을 비운 뒤 다시 열어도 같은 쪽지로 다시 채우지 않는다(쪽지마다 한 번)
//   K3 질문 하나 · 하나 고르기 → 카드 · 누르면 그 자리에서 되살리고(/restore) «앞서 물은 ‹질문›에 대한 답: ‹선택›» 을 보낸다(/prompt) · 카드는 걷힌다
//   K4 질문 여럿 · 여러 개 고르기 → 골라 두었다가 [답 보내기] — 답마다 한 줄
//   K5 카드가 떠 있을 때 입력칸에 직접 쓴 답 → 그 질문을 붙여 보낸다(AI 는 그 질문을 모른다)
//   K6 codex(다시 열면 같은 창이 뜬다) → [이어서 열고 답하기] 는 열기만 한다(/prompt 없음)
//   K7 세션이 다시 살아나면(다른 곳에서 열었다) 카드를 걷는다
//   K8 남의 세션(되살릴 수 없다)엔 카드도 입력칸 채움도 없다
//  가짜는 «서버» 쪽뿐이다 — fetch 를 가로채 요청을 적고 정해진 답을 준다. 대화창은 실제 모듈(web/session-chat.ts)을 묶어 싣는다.
//  크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 쪽지 되돌림 런타임 검증 미실행"); process.exit(0); }
const CSS = ["01-base.css", "03-components.css", "36-chat.css", "38-chat-tui.css"].map((f) => path.join(ROOT, "public/styles", f)).filter(existsSync);
const bundle = buildSync({
  stdin: { contents: "export { mountSessionChat } from './web/session-chat.ts';", resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "SC", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;

async function PAGE_MAIN() {
  const R = {};
  const pageErrors = [];
  window.addEventListener("error", (e) => pageErrors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => pageErrors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const waitFor = async (fn, ms = 4000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { try { if (fn()) return true; } catch (_) { /* 아직 */ } await sleep(25); } return false; };
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
  const calls = [];
  window.fetch = async (url, init) => {
    const u = new URL(String(url), "http://x/");
    const m = (init && init.method) || "GET";
    if (m !== "GET") calls.push({ m, p: u.pathname, b: init && init.body ? String(init.body) : "" });
    if (/\/transcript$/.test(u.pathname)) return new Response("", { status: 200, headers: { "content-type": "text/plain" } });
    const sid = decodeURIComponent((/\/sessions\/([^/]+)\//.exec(u.pathname) || [])[1] || "");
    if (/\/restore$/.test(u.pathname)) return J({ session: { id: sid } });   // #4694 — 같은 id 로 다시 띄웠다
    if (/\/prompt$/.test(u.pathname)) return J({ outbox_id: 1 });
    return J({ error: "no" }, 404);
  };
  localStorage.setItem("lively_ui_token", "t");
  const SC = (new Function(document.getElementById("src").textContent + "\n;return SC;"))();
  const NOTE_ASK = { at: 1800000000, why: "asking", harness: "claude", question: { kind: "ask", items: [{ header: "색상", text: "가장 좋아하는 색은?", options: [{ n: 1, label: "빨강" }, { n: 2, label: "파랑" }], free: true }] } };
  const mk = (id, raw, extra) => Object.assign({ id, label: "세션", live: true, alive: false, node: null, owned: true, stateKey: "restorable", stateLabel: "중단됨", projectId: null, projectName: "", raw: Object.assign({ restorable: true, harness: "claude" }, raw) }, extra || {});
  const mount = async (t) => {
    const box = document.createElement("div"); box.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column;background:#fff";
    document.body.append(box);
    let routed = null;
    const h = SC.mountSessionChat(box, t, { onResumed: (id) => { routed = id; } });
    await sleep(300);
    const input = () => box.querySelector("textarea.livc-input");
    return {
      box, h, input, routed: () => routed,
      note: () => { const n = box.querySelector(".livc-note"); return n ? n.textContent : ""; },
      card: () => box.querySelector(".sc-stopq"),
      btns: () => [...box.querySelectorAll(".sc-stopq button")].map((b) => b.textContent.trim()),
      click: (label) => { const b = [...box.querySelectorAll(".sc-stopq button")].find((x) => x.textContent.trim() === label); if (b) b.click(); return !!b; },
      done: () => { try { h.destroy(); } catch (_) { /* 이미 */ } box.remove(); },
    };
  };
  const since = () => { const n = calls.length; return () => calls.slice(n).map((c) => ({ p: c.p.replace(/^\/api\/ui\/terminal\/sessions\//, ""), text: (() => { try { return JSON.parse(c.b).text; } catch (_) { return undefined; } })() })); };
  try {
    // K1 — 쓰다 만 글
    {
      const v = await mount(mk("box-k1", { stopNote: { at: 1800000001, why: "done", harness: "claude", draft: "다음엔 이걸 해 줘" } }));
      await waitFor(() => v.input() && v.input().value);
      R.k1 = { value: v.input() ? v.input().value : null, note: v.note(), card: !!v.card() };
      // K2 — 사람이 비우고 다시 열면 같은 쪽지로 다시 채우지 않는다
      v.input().value = ""; v.input().dispatchEvent(new Event("input"));
      v.done();
      const w = await mount(mk("box-k1", { stopNote: { at: 1800000001, why: "done", harness: "claude", draft: "다음엔 이걸 해 줘" } }));
      await sleep(300);
      R.k2 = { value: w.input() ? w.input().value : null };
      w.done();
    }
    // K3 — 질문 하나 · 하나 고르기 → 누르는 즉시 되살리며 답을 보낸다
    {
      const v = await mount(mk("box-k3", { stopNote: NOTE_ASK }));
      await waitFor(() => v.card());
      R.k3 = { card: !!v.card(), text: v.card() ? v.card().textContent : "", btns: v.btns() };
      const got = since();
      R.k3.clicked = v.click("파랑");
      await waitFor(() => got().some((c) => c.p.endsWith("/prompt")), 4000);
      R.k3.calls = got();
      R.k3.cardAfter = !!v.card();
      R.k3.routed = v.routed();
      v.done();
    }
    // K4 — 질문 여럿 · 여러 개 고르기 → [답 보내기]
    {
      const note = { at: 1800000004, why: "asking", harness: "claude", question: { kind: "ask", items: [
        { header: "색", text: "가장 좋아하는 색은?", options: [{ n: 1, label: "빨강" }, { n: 2, label: "파랑" }] },
        { header: "과일", text: "좋아하는 과일을 모두 고르세요", options: [{ n: 1, label: "사과" }, { n: 2, label: "배" }], multi: true },
      ] } };
      const v = await mount(mk("box-k4", { stopNote: note }));
      await waitFor(() => v.card());
      R.k4 = { btns: v.btns() };
      const got = since();
      v.click("빨강"); v.click("사과"); v.click("배");
      R.k4.beforeSend = got().length;
      v.click("답 보내기");
      await waitFor(() => got().some((c) => c.p.endsWith("/prompt")), 4000);
      R.k4.calls = got();
      v.done();
    }
    // K5 — 카드가 떠 있을 때 입력칸에 직접 쓴 답
    {
      const v = await mount(mk("box-k5", { stopNote: NOTE_ASK }));
      await waitFor(() => v.card());
      const got = since();
      v.input().value = "초록"; v.input().dispatchEvent(new Event("input"));
      const form = v.input().closest("form");
      if (form && form.requestSubmit) form.requestSubmit(); else v.input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await waitFor(() => got().some((c) => c.p.endsWith("/prompt")), 4000);
      R.k5 = { calls: got(), cardAfter: !!v.card(), form: !!form };
      v.done();
    }
    // K6 — codex: 다시 열면 같은 창이 뜬다 → 열기만
    {
      const note = { at: 1800000006, why: "asking", harness: "codex", question: { kind: "permission", target: "touch a.txt", reappears: true, items: [{ text: "Would you like to run the following command?", options: [{ n: 1, label: "Yes, proceed" }] }] } };
      const v = await mount(mk("box-k6", { harness: "codex", stopNote: note }));
      await waitFor(() => v.card());
      R.k6 = { btns: v.btns(), text: v.card() ? v.card().textContent : "" };
      const got = since();
      R.k6.clicked = v.click("이어서 열고 답하기");
      await waitFor(() => got().some((c) => c.p.endsWith("/restore")), 4000);
      await sleep(300);
      R.k6.calls = got();
      v.done();
    }
    // K7 — 다시 살아나면 카드를 걷는다
    {
      const t = mk("box-k7", { stopNote: NOTE_ASK });
      const v = await mount(t);
      await waitFor(() => v.card());
      const before = !!v.card();
      v.h.update(Object.assign({}, t, { alive: true, stateKey: "idle", raw: { harness: "claude", agentState: "idle" } }));
      await sleep(300);
      R.k7 = { before, after: !!v.card() };
      v.done();
    }
    // K8 — 남의 세션
    {
      const v = await mount(mk("box-k8", { stopNote: Object.assign({}, NOTE_ASK, { draft: "남의 글" }) }, { owned: false }));
      await sleep(400);
      R.k8 = { card: !!v.card(), value: v.input() ? v.input().value : null };
      v.done();
    }
  } catch (e) { R.err = String(e && e.stack || e); }
  R.pageErrors = pageErrors;
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const page = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out" style="position:fixed;left:-9999px">PENDING</pre>
<script type="text/plain" id="src">${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;

const dom = await dumpDom(chrome, { html: page, copy: CSS, prefix: "stop-note-chat-", virtualTimeBudget: 60000, args: ["--window-size=1200,900"] });
const res = readOut(dom);
if (res.text === null) { console.error(`FAIL  페이지가 결과를 안 냈다(out=${JSON.stringify(res.out)}): ${dom.slice(0, 400)}`); process.exit(1); }
const R = JSON.parse(res.text);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const Js = (v) => JSON.stringify(v);
const check = (cond, n, got) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} :: 실제 ${Js(got)}`); } };
if (R.fatal || R.err) { fail++; console.error(`FAIL  페이지가 던졌다: ${String(R.fatal || R.err).split("\n").slice(0, 3).join(" | ")}`); }
const prompts = (calls) => (calls || []).filter((c) => c.p.endsWith("/prompt")).map((c) => c.text);
const restores = (calls) => (calls || []).filter((c) => c.p.endsWith("/restore")).length;
const k1 = R.k1 || {};
check(k1.value === "다음엔 이걸 해 줘" && /보내지 못한 말을 입력칸에 돌려 두었어요/.test(k1.note) && !k1.card, "K1 쓰다 만 글 → 입력칸 · 안내 · 질문 카드 없음", k1);
check(!!R.k2 && R.k2.value === "", "K2 사람이 비운 뒤 다시 열어도 같은 쪽지로 다시 채우지 않는다", R.k2);
const k3 = R.k3 || {};
check(k3.card && /가장 좋아하는 색은\?/.test(k3.text) && Js(k3.btns) === Js(["빨강", "파랑"]), "K3 질문 카드 — 질문 글 · 선택지 단추(직접 쓰기·메타 없음)", { card: k3.card, btns: k3.btns });
const p3 = prompts(k3.calls);
check(k3.clicked && restores(k3.calls) === 1 && p3.length === 1 && p3[0].startsWith("앞서 물은 ‹가장 좋아하는 색은?›에 대한 답: ‹파랑›") && !k3.cardAfter && k3.routed === "box-k3",
  "K3 누르면 되살리고(/restore 1) 답 문장을 보내고(/prompt 1) 카드가 걷힌다 · 같은 id 로 옮겨 간다", { calls: k3.calls, cardAfter: k3.cardAfter, routed: k3.routed });
const k4 = R.k4 || {};
const p4 = prompts(k4.calls);
check(Js(k4.btns) === Js(["빨강", "파랑", "사과", "배", "답 보내기"]) && k4.beforeSend === 0, "K4 여럿이면 골라 두기만 한다(보내기 전 요청 0) · [답 보내기]", { btns: k4.btns, before: k4.beforeSend });
check(p4.length === 1 && p4[0].includes("앞서 물은 ‹가장 좋아하는 색은?›에 대한 답: ‹빨강›") && p4[0].includes("앞서 물은 ‹좋아하는 과일을 모두 고르세요›에 대한 답: ‹사과, 배›"), "K4 [답 보내기] → 답마다 한 줄", p4);
const k5 = R.k5 || {};
const p5 = prompts(k5.calls);
check(p5.length === 1 && p5[0].startsWith("앞서 물은 ‹가장 좋아하는 색은?›에 대한 답: ‹초록›") && !k5.cardAfter, "K5 카드가 떠 있을 때 직접 쓴 답 → 그 질문을 붙여 보낸다", { p5, cardAfter: k5.cardAfter, form: k5.form });
const k6 = R.k6 || {};
check(Js(k6.btns) === Js(["이어서 열고 답하기"]) && /touch a\.txt/.test(k6.text), "K6 codex — 같은 창이 다시 뜨니 [이어서 열고 답하기] 하나 · 대상 명령을 보여 준다", { btns: k6.btns });
check(k6.clicked && restores(k6.calls) === 1 && prompts(k6.calls).length === 0, "K6 누르면 열기만 한다(/restore 1 · /prompt 0)", k6.calls);
check(!!R.k7 && R.k7.before && !R.k7.after, "K7 다시 살아나면 카드를 걷는다", R.k7);
check(!!R.k8 && !R.k8.card && R.k8.value === "", "K8 남의 세션엔 카드도 입력칸 채움도 없다", R.k8);
check((R.pageErrors || []).length === 0, "E 페이지 오류 없음", R.pageErrors);
console.log(`\nstop-note-chat-runtime: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
