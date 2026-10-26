#!/usr/bin/env node
// 처음 설정 «AI 연결» 장면 — 서버 계정 준비(격리 박스)를 기다리는 흐름 (#4970, 런타임).
//
//  왜: 격리 박스에서 그 사람의 서버 계정(box_<사람>)이 다 만들어지기 전에 목록을 그리면 챗GPT·그록이 «이 서버 공용 계정» 으로
//   보이고([연결]이 거짓 물음을 띄운다) 로그인은 깔리는 중인 codex 를 «없음» 으로 만난다(격리 리뷰 2026-10-23). 장면은 서버에 준비를
//   묻고(POST /api/ui/me/ai-login/prepare → state), 준비 중이면 안내만 보이며 4초마다 다시 묻고, 다 되면 그린다.
//
//  엣지 표(행마다 단언):
//   Q1  준비 중 → 안내만 · 목록 안 그림 · 계정 목록도 안 묻는다 · [다음] 꺼짐 · «PC에서 쓰는 AI로» 살아 있음 · 첫 물음은 retry 아님
//   Q2  4초 뒤 다시 묻는다 · 아직 준비 중이면 그대로
//   Q3  준비 중을 본 뒤 한 번 못 물으면(500 — 배포 중) 그리지 않고 다시 묻는다
//   Q4  ready → 넷을 그린다 · 그 뒤엔 더 묻지 않는다
//   Q5  failed → 안내 + «다시 해 보기» · 묻기 멈춤 · 누르면 retry:true · 그 뒤 준비 중 → ready 면 그린다
//   Q6  옛 서버(prepare 404) → 곧바로 그린다(처음 설정이 막히면 안 된다)
//   Q7  준비 중에 장면을 떠나면(PC 경로) 묻기를 멈춘다 — 이미 걸어 둔 다음 묻기도 나가지 않는다(종전엔 한 번 더 나갔다)
//   Q0  (#5031) 처음부터 열어도 인사·이름 장면은 계정 준비를 묻지 않는다(종전 #4970 은 인사 장면에서 미리 만들어 PC 길을 고를 사람도 치렀다) ·
//       AI 장면이 한 번 묻는다 — **묻기만**(start:false).
//   Q1~Q7 의 장면 물음도 전부 start:false(묻기만) — 만들기는 사람이 [연결]을 누를 때다.
//   Q8  계정 없음(absent · 줄 pending) → 곧바로 넷 · 줄마다 [연결] · «공용» 문구 없음 · [다음] 꺼짐 · 만들기 물음(start:true) 0
//   Q9  Q8 에서 한 줄 [연결] → start:true 1회 · «만들고 있어요» 안내 · 다른 [연결] 막힘 · 묻기(start:false)로 기다림 → ready → 목록 다시 읽음 →
//       **그 AI** 의 로그인 시작(ai-login/start harness=그 줄)
//   Q10 [연결] → failed → 실패 안내 + «다시 해 보기» · 로그인 시작 0 · 누르면 retry:true → ready → 그 AI 로그인 시작
//   Q11 계정 없음에서 «PC에서 쓰는 AI로» → 만들기 물음(start:true) 0
//   Q12 옛 서버(줄에 pending 없음) → [연결]이 곧바로 로그인 시작(만들기 물음 없음)
//  fail-first(2026-10-23): `SRC_ROOT=<옛 트리>`(web/ · public/styles 가 있는 곳)로 옛 코드를 물린다 — 88fb373c4(v0.1.379)는 Q7 만
//   빨갛다(«떠난 뒤에도 1번 더 물었다»), 그 전 판(v0.1.378)은 AI 장면 자체가 없어 장면이 죽는다. 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 처음 설정 AI 장면 준비 흐름 런타임 검증 미실행"); process.exit(0); }

const CSS = ["01-base.css", "03-components.css", "06-learn.css", "41-onboarding.css"].map((f) => path.join(ROOT, "public/styles", f)).filter(existsSync);
const bundle = buildSync({
  stdin: { contents: "export { renderOnboarding } from './web/v2/onboarding.ts';", resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "OB", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;

async function PAGE_MAIN() {
  const R = { errors: [] };
  window.addEventListener("error", (e) => R.errors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => R.errors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
  const calls = { prepare: [], accounts: 0, login: [] };
  let ACC_PENDING = false;   // true 면 계정 없는 사람의 목록(#5031 — 줄마다 pending · isolated · 연결 전)
  let PREP = [];             // 차례로 돌려줄 prepare 응답: 'preparing' | 'ready' | 'failed' | 500 | 404
  let PREP_DEFAULT = "ready";
  const ACC = [
    { key: "claude", label: "Claude Code", scope: "member", loggedIn: false, how: "file", installed: true },
    { key: "codex", label: "Codex", scope: "member", loggedIn: false, how: "file", installed: true },
    { key: "grok", label: "Grok Build", scope: "member", loggedIn: false, how: "file", installed: true },
    { key: "antigravity", label: "Antigravity", scope: "member", loggedIn: null, how: "probe", installed: true },
  ];
  window.fetch = async (url, init) => {
    const u = new URL(String(url), location.href);
    const method = String((init && init.method) || "GET").toUpperCase();
    if (u.pathname === "/api/ui/me/ai-login/prepare" && method === "POST") {
      let body = {}; try { body = JSON.parse(String((init && init.body) || "{}")); } catch (_) { /* 빈 몸 */ }
      //  서버와 같은 뜻으로 적는다 — start 를 안 보내면 서버는 «없으면 만든다»(옛 화면 호환, login-seat-prep prepareMemberSeat).
      calls.prepare.push({ retry: body.retry === true, start: body.start !== false || body.retry === true });
      const nx = PREP.length ? PREP.shift() : PREP_DEFAULT;
      if (nx === "ready") ACC_PENDING = false;   // 계정이 다 됐다 — 이제 목록은 그 사람 홈에서 잰 값이다
      if (nx === 500) return J({ error: "boom" }, 500);
      if (nx === 404) return J({ error: "not found" }, 404);
      return J({ ok: true, state: nx });
    }
    if (u.pathname === "/api/ui/me/ai-accounts" && method === "GET") {
      calls.accounts++;
      const rows = JSON.parse(JSON.stringify(ACC));
      return J({ accounts: ACC_PENDING ? rows.map((r) => ({ ...r, scope: "isolated", loggedIn: false, pending: true })) : rows });
    }
    if (u.pathname === "/api/ui/me/ai-login/start" && method === "POST") {
      let body = {}; try { body = JSON.parse(String((init && init.body) || "{}")); } catch (_) { /* 빈 몸 */ }
      calls.login.push(String(body.harness || ""));
      return J({ ok: true });
    }
    if (u.pathname === "/api/ui/me/ai-login/state") return J({ ok: true, state: "starting" });
    if (u.pathname === "/api/ui/me/ai-accounts/check") return J({ loggedIn: null });
    if (u.pathname === "/api/ui/me/welcome") return J({ progress: null });
    return J({ ok: true });
  };
  window.confirm = () => true; window.alert = () => {}; window.open = () => null;
  localStorage.setItem("lively_ui_token", "t");
  const OB = (new Function(document.getElementById("src").textContent + "\n;return OB;"))();
  const mount = () => {
    sessionStorage.setItem("lively-ob-v2", JSON.stringify({ scene: "ai", name: "민", nameSet: true, trail: ["intro", "name"], viaPc: false }));
    const old = document.getElementById("root"); const host = document.createElement("div"); host.id = "root"; old.replaceWith(host);
    OB.renderOnboarding(host, {});
    return host;
  };
  const view = (host) => ({
    rows: host.querySelectorAll(".ob-ai-item").length,
    text: (host.querySelector("#aiList")?.innerText || "").replace(/\s+/g, " ").slice(0, 90),
    next: host.querySelector("#aiNext")?.disabled === true,
    pc: !!host.querySelector("#aiPc"),
    retry: !!host.querySelector("#aiList .ob-ai-retry"),
    scene: host.dataset.scene || "",
  });
  const n = () => calls.prepare.length;
  const starts = () => calls.prepare.filter((c) => c.start).length;
  const goBtns = (host) => [...host.querySelectorAll("#aiList .ob-ai-go")];
  const rowGo = (host, re) => { const w = [...host.querySelectorAll(".ob-ai-item")].find((x) => re.test(x.innerText || "")); return w ? w.querySelector(".ob-ai-go") : null; };
  const noteText = (host) => ((host.querySelector(".ob-ai-note") && !host.querySelector(".ob-ai-note").hidden) ? host.querySelector(".ob-ai-note").innerText : "").replace(/\s+/g, " ");

  //  Q1~Q4 — 준비 중 → (4초 뒤) 준비 중 → 한 번 못 물음(500) → ready
  PREP = ["preparing", "preparing", 500, "ready"];
  let host = mount();
  await sleep(500);
  R.q1 = { ...view(host), accounts: calls.accounts, firstRetry: calls.prepare[0] ? calls.prepare[0].retry : null, asks: n(), starts: starts() };
  await sleep(4300);
  R.q2 = { ...view(host), asks: n() };
  await sleep(4300);
  R.q3 = { ...view(host), asks: n() };
  await sleep(4600);
  R.q4 = { ...view(host), asks: n(), accounts: calls.accounts };
  await sleep(4500);
  R.q4.asksLater = n();
  R.q4.starts = starts();

  //  Q5 — failed → «다시 해 보기» → retry:true → 준비 중 → ready
  calls.prepare = []; calls.accounts = 0;
  PREP = ["failed", "preparing", "ready"];
  host = mount();
  await sleep(500);
  R.q5a = { ...view(host), asks: n() };
  await sleep(4500);
  R.q5a.asksLater = n();
  const btn = host.querySelector("#aiList .ob-ai-retry");
  if (btn) btn.click();
  await sleep(500);
  R.q5b = { ...view(host), asks: n(), lastRetry: calls.prepare.length ? calls.prepare[calls.prepare.length - 1].retry : null };
  await sleep(4500);
  R.q5c = view(host);

  //  Q6 — 옛 서버(404)
  calls.prepare = []; calls.accounts = 0;
  PREP = [404];
  host = mount();
  await sleep(600);
  R.q6 = view(host);

  //  Q7 — 준비 중에 장면을 떠난다(PC 경로)
  calls.prepare = []; calls.accounts = 0;
  PREP = []; PREP_DEFAULT = "preparing";
  host = mount();
  await sleep(500);
  host.querySelector("#aiPc").click();
  await sleep(300);
  R.q7 = { asksAtLeave: n() };
  await sleep(9000);
  R.q7 = { ...R.q7, ...view(host), asksLater: n() };

  //  Q0 — 처음부터 연다(탭에 남은 자리 없음 · 서버도 없음) → 인사 → 이름 → AI
  const mountFresh = () => {
    sessionStorage.removeItem("lively-ob-v2");
    const old = document.getElementById("root"); const h = document.createElement("div"); h.id = "root"; old.replaceWith(h);
    OB.renderOnboarding(h, {});
    return h;
  };
  calls.prepare = []; calls.accounts = 0;
  PREP = []; PREP_DEFAULT = "ready";
  host = mountFresh();
  await sleep(600);
  R.q0a = { intro: !!host.querySelector("#introGo"), asks: n(), accounts: calls.accounts };
  host.querySelector("#introGo")?.click();
  await sleep(300);
  R.q0b = { name: !!host.querySelector("#nameIn"), asks: n() };
  const nameIn = host.querySelector("#nameIn");
  if (nameIn) nameIn.value = "민";
  host.querySelector("#nameGo")?.click();
  await sleep(900);
  R.q0c = { ...view(host), ai: !!host.querySelector("#aiList"), asks: n(), starts: starts() };

  //  Q8·Q9 — 계정 없음 → 곧바로 그림 → 한 줄 [연결] → 만들기 → 기다림 → ready → 그 AI 로그인
  calls.prepare = []; calls.accounts = 0; calls.login = [];
  PREP = ["absent"]; PREP_DEFAULT = "preparing"; ACC_PENDING = true;
  host = mount();
  await sleep(600);
  R.q8 = { ...view(host), asks: n(), starts: starts(), go: goBtns(host).length, goOn: goBtns(host).filter((b) => !b.disabled && !b.hidden).length,
    shared: /공용/.test(host.querySelector("#aiList")?.innerText || "") };
  PREP = ["preparing", "preparing", "ready"];
  rowGo(host, /Codex|ChatGPT|챗GPT/)?.click();
  await sleep(400);
  R.q9a = { starts: starts(), lastStart: calls.prepare.length ? calls.prepare[calls.prepare.length - 1].start : null, note: noteText(host),
    goOff: goBtns(host).filter((b) => b.disabled).length, go: goBtns(host).length, login: calls.login.slice() };
  await sleep(9500);
  R.q9b = { asks: n(), starts: starts(), accounts: calls.accounts, login: calls.login.slice(), note: noteText(host) };

  //  Q10 — [연결] → failed → 다시 해 보기 → ready → 그 AI 로그인
  calls.prepare = []; calls.accounts = 0; calls.login = [];
  PREP = ["absent"]; ACC_PENDING = true;
  host = mount();
  await sleep(600);
  PREP = ["failed", "ready"];
  rowGo(host, /Codex|ChatGPT|챗GPT/)?.click();
  await sleep(600);
  R.q10a = { note: noteText(host), retry: !!host.querySelector(".ob-ai-seat-retry"), login: calls.login.slice(), goOn: goBtns(host).filter((b) => !b.disabled).length };
  host.querySelector(".ob-ai-seat-retry")?.click();
  await sleep(1200);
  R.q10b = { lastRetry: calls.prepare.length ? calls.prepare[calls.prepare.length - 1].retry : null, login: calls.login.slice() };

  //  Q11 — 계정 없음 → PC 길
  calls.prepare = []; calls.accounts = 0; calls.login = [];
  PREP = ["absent"]; ACC_PENDING = true;
  host = mount();
  await sleep(600);
  host.querySelector("#aiPc")?.click();
  await sleep(1500);
  R.q11 = { asks: n(), starts: starts(), scene: host.dataset.scene || "" };

  //  Q12 — 옛 서버(줄에 pending 없음) → [연결]이 곧바로 로그인
  calls.prepare = []; calls.accounts = 0; calls.login = [];
  PREP = ["none"]; PREP_DEFAULT = "none"; ACC_PENDING = false;
  host = mount();
  await sleep(600);
  rowGo(host, /Codex|ChatGPT|챗GPT/)?.click();
  await sleep(600);
  R.q12 = { starts: starts(), login: calls.login.slice() };

  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const page = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out" style="position:fixed;left:-9999px">PENDING</pre><div id="root"></div>
<script type="text/plain" id="src">${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;

const dom = await dumpDom(chrome, { html: page, serve: true, prefix: "ob-ai-prep-", virtualTimeBudget: 120000, timeoutMs: 90000, args: ["--window-size=1200,900"], copy: CSS });
const res = readOut(dom);
assert.ok(res.text !== null, `결과를 못 받았다 — ${res.out}`);
const R = JSON.parse(res.text);
assert.ok(!R.fatal, `장면이 죽었다: ${R.fatal}`);
let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };
const PREPARING = /개인 계정을 준비하고 있어요/;

t("Q1 준비 중 → 안내만 · 목록·계정 목록 안 묻기 · [다음] 꺼짐 · PC 링크 · 첫 물음은 retry 아님", () => {
  assert.match(R.q1.text, PREPARING, `준비 안내가 없다: ${R.q1.text}`);
  assert.equal(R.q1.rows, 0, "★ 준비 중인데 목록을 그렸다(«이 서버 공용 계정» 거짓 문구)");
  assert.equal(R.q1.accounts, 0, "준비 중인데 계정 목록을 물었다");
  assert.equal(R.q1.next, true, "[다음] 이 켜져 있다");
  assert.equal(R.q1.pc, true, "«PC에서 쓰는 AI로» 가 없다 — 준비 중에도 다른 길이 있어야 한다");
  assert.equal(R.q1.firstRetry, false, "첫 물음이 retry 다 — 실패 뒤 5분 막음을 사람 몰래 푼다");
  assert.equal(R.q1.starts, 0, "★ 장면을 열자마자 계정 만들기를 시작했다(start:true) — PC 길을 고를 사람도 치른다");
});
t("Q2 4초 뒤 다시 묻는다 · 아직 준비 중이면 그대로", () => {
  assert.ok(R.q2.asks >= 2, `다시 묻지 않았다(${R.q2.asks})`);
  assert.match(R.q2.text, PREPARING); assert.equal(R.q2.rows, 0);
});
t("Q3 준비 중 뒤 한 번 못 물어도(500) 그리지 않고 다시 묻는다", () => {
  assert.ok(R.q3.asks >= 3, `배선 — 세 번째 물음이 없다(${R.q3.asks})`);
  assert.equal(R.q3.rows, 0, "★ 한 번 못 물었다고 준비 중인 목록을 그렸다");
  assert.match(R.q3.text, PREPARING);
});
t("Q4 ready → 넷을 그린다 · 그 뒤엔 더 묻지 않는다", () => {
  assert.equal(R.q4.rows, 4, `ready 인데 넷을 안 그렸다: ${JSON.stringify(R.q4)}`);
  assert.ok(R.q4.accounts >= 1, "계정 목록을 안 물었다");
  assert.equal(R.q4.asksLater, R.q4.asks, "ready 뒤에도 계속 묻는다");
  assert.equal(R.q4.starts, 0, "기다리는 동안 만들기를 시작했다 — 묻기만 해야 한다");
});
t("Q5 failed → 안내 + 다시 해 보기 · 묻기 멈춤 · 누르면 retry:true · 그 뒤 ready 면 그린다", () => {
  assert.match(R.q5a.text, /만들지 못했어요/, `실패 안내가 없다: ${R.q5a.text}`);
  assert.equal(R.q5a.retry, true, "«다시 해 보기» 가 없다");
  assert.equal(R.q5a.rows, 0);
  assert.equal(R.q5a.asksLater, R.q5a.asks, "실패인데 계속 묻는다(오래 걸리는 만들기를 몇 초마다 다시 띄운다)");
  assert.equal(R.q5b.asks, R.q5a.asksLater + 1, "«다시 해 보기» 가 묻지 않았다");
  assert.equal(R.q5b.lastRetry, true, "★ «다시 해 보기» 가 retry:true 를 안 보낸다 — 서버가 실패 표식을 안 지운다");
  assert.match(R.q5b.text, PREPARING);
  assert.equal(R.q5c.rows, 4, "다시 해 본 뒤 ready 인데 안 그렸다");
});
t("Q6 옛 서버(prepare 404) → 곧바로 그린다", () => {
  assert.equal(R.q6.rows, 4, `옛 서버에서 처음 설정이 막혔다: ${JSON.stringify(R.q6)}`);
});
t("Q7 준비 중에 장면을 떠나면 묻기를 멈춘다 — 걸어 둔 다음 묻기도 나가지 않는다", () => {
  assert.notEqual(R.q7.scene, "ai", "배선 — 장면을 안 떠났다");
  assert.ok(R.q7.asksAtLeave >= 1, "배선 — 떠나기 전에 한 번도 안 물었다");
  assert.equal(R.q7.asksLater, R.q7.asksAtLeave, `★ 장면을 떠난 뒤에도 ${R.q7.asksLater - R.q7.asksAtLeave}번 더 물었다`);
});
t("Q0 ★ 처음부터 열어도 인사·이름 장면은 계정 준비를 묻지 않는다 · AI 장면이 한 번 묻는다(묻기만) · 그린다", () => {
  assert.equal(R.q0a.intro, true, "배선 — 인사 장면이 아니다");
  assert.equal(R.q0a.asks, 0, `★ 인사 장면에서 계정 준비를 물었다(${R.q0a.asks}) — PC 길을 고를 사람도 계정을 치른다`);
  assert.equal(R.q0a.accounts, 0, "인사 장면에서 계정 목록을 물었다");
  assert.equal(R.q0b.name, true, "배선 — 이름 장면이 아니다");
  assert.equal(R.q0b.asks, 0, "이름 장면에서 계정 준비를 물었다");
  assert.equal(R.q0c.ai, true, "배선 — AI 장면이 아니다");
  assert.equal(R.q0c.asks, 1, `AI 장면이 묻지 않았다(${R.q0c.asks})`);
  assert.equal(R.q0c.starts, 0, "AI 장면이 열자마자 만들기를 시작했다");
  assert.equal(R.q0c.rows, 4, `ready 인데 넷을 안 그렸다: ${JSON.stringify(R.q0c)}`);
});
t("Q8 ★ 계정 없음 → 곧바로 넷 · 줄마다 [연결] · «공용» 문구 없음 · [다음] 꺼짐 · 만들기 0", () => {
  assert.equal(R.q8.rows, 4, `★ 계정이 없다고 목록을 안 그렸다(준비를 기다린다): ${JSON.stringify(R.q8)}`);
  assert.equal(R.q8.goOn, 4, "줄의 [연결]이 다 살아 있지 않다");
  assert.equal(R.q8.shared, false, "«이 서버 공용 계정» 문구가 보인다");
  assert.equal(R.q8.next, true, "[다음] 이 켜져 있다");
  assert.equal(R.q8.starts, 0, "★ 아무것도 안 눌렀는데 계정 만들기를 시작했다");
});
t("Q9 ★ 한 줄 [연결] → 만들기 1회 · 안내 · 다른 [연결] 막힘 → ready → 그 AI 로그인 시작", () => {
  assert.equal(R.q9a.starts, 1, `[연결]이 계정 만들기를 시작하지 않았다(${R.q9a.starts})`);
  assert.equal(R.q9a.lastStart, true);
  assert.match(R.q9a.note, /개인 계정을 만들고 있어요/, `만드는 중 안내가 없다: ${R.q9a.note}`);
  assert.equal(R.q9a.goOff, R.q9a.go, "만드는 동안 다른 [연결]이 살아 있다(두 번 만든다)");
  assert.deepEqual(R.q9a.login, [], "계정이 다 되기 전에 로그인을 시작했다");
  assert.equal(R.q9b.starts, 1, `기다리는 동안 만들기를 또 시작했다(${R.q9b.starts})`);
  assert.ok(R.q9b.asks >= 3, `배선 — 기다리며 묻지 않았다(${R.q9b.asks})`);
  assert.ok(R.q9b.accounts >= 2, "다 된 뒤 목록을 다시 읽지 않았다");
  assert.deepEqual(R.q9b.login, ["codex"], `★ 다 된 뒤 누른 그 AI 의 로그인을 잇지 않았다: ${JSON.stringify(R.q9b.login)}`);
});
t("Q10 [연결] → failed → 실패 안내 + 다시 해 보기 · 로그인 0 · 누르면 retry → 그 AI 로그인", () => {
  assert.match(R.q10a.note, /만들지 못했어요/, `실패 안내가 없다: ${R.q10a.note}`);
  assert.equal(R.q10a.retry, true, "«다시 해 보기» 가 없다");
  assert.deepEqual(R.q10a.login, [], "실패했는데 로그인을 시작했다");
  assert.ok(R.q10a.goOn >= 1, "실패 뒤 [연결]이 막힌 채 남았다");
  assert.equal(R.q10b.lastRetry, true, "★ «다시 해 보기» 가 retry:true 를 안 보낸다");
  assert.deepEqual(R.q10b.login, ["codex"], `다시 해 본 뒤 그 AI 로그인을 잇지 않았다: ${JSON.stringify(R.q10b.login)}`);
});
t("Q11 ★ 계정 없음 → PC 길 → 계정 만들기 0", () => {
  assert.notEqual(R.q11.scene, "ai", "배선 — 장면을 안 떠났다");
  assert.ok(R.q11.asks >= 1, "배선 — AI 장면이 묻지 않았다");
  assert.equal(R.q11.starts, 0, "★ PC 길을 골랐는데 계정 만들기를 시작했다");
});
t("Q12 옛 서버(줄에 pending 없음) → [연결]이 곧바로 로그인", () => {
  assert.equal(R.q12.starts, 0, "계정 개념이 없는데 만들기를 물었다");
  assert.deepEqual(R.q12.login, ["codex"], `곧바로 로그인을 시작하지 않았다: ${JSON.stringify(R.q12.login)}`);
});
t("화면 오류 0", () => { assert.deepEqual(R.errors, []); });
console.log(`onboarding-ai-prepare-runtime.test: ${pass} ok`);
