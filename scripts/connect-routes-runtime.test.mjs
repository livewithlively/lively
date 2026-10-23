#!/usr/bin/env node
// [외부 앱 연결] «연결하는 길» 칸 · 목록 — 런타임 시험 (#4970 격리 리뷰 2차).
//
// 사양(엣지 표 — 행마다 시나리오 하나):
//  C1 서버 판정(dist/org/connect-routes.js decideRoutes)이 낼 수 있는 길·상태 전부를 상세 칸으로 그리면 —
//     어느 칸에도 글자 «null»·«undefined» 가 없고, 칸마다 단추·링크·입력 하나 또는 상태 문장이 있다(막다른 칸 없음).
//  C2 Claude 길 칸이 구성원·모으는 곳을 다 그린 뒤에도 «null» 이 없다(숨은 곳 0 — replaceChildren 에 null 을 넘기던 결함).
//  C3 접힌 «다른 길» 의 Claude 칸은 펼 때 불러온다(펼치기 전 구성원 조회 0건 → 펼친 뒤 1건 이상).
//  C4 슬랙 앱 등록 — 빈 칸으로 [등록] 하면 보내지 않고 «칸을 채워 주세요» · 채우면 POST /api/ui/org/connect/register {app, values} · 다시 그린다.
//     [슬랙 앱 만들기] 는 서버가 만든 링크(GET /api/ui/org/slack/app-manifest 의 create_url)를 연다.
//  C5 깃허브 앱 등록 — 키 파일(.pem)을 고르면 그 내용이 private_key 로 간다 · 키가 아닌 파일은 받지 않는다.
//  C6 상태를 못 읽은 앱 — [다시 불러오기] 단추가 있고 누르면 다시 그린다.
//  C7 목록 — 묶음 제목이 서고 «null» 이 없다 · 못 읽은 앱은 «상태를 불러오지 못했어요» 묶음.
//
// 왜 런타임인가: 결함은 DOM 쪽에서 나왔다(replaceChildren 에 null · li 를 flex 로 만들어 번호가 사라짐). 말 표 시험
//  (connect-routes-view.test.mjs)은 그것을 못 본다. 실제 화면 모듈(web/v2/connect-routes.ts)을 묶어 진짜 DOM 에서 돌리고,
//  서버 자리(fetch)만 정해진 응답으로 바꾼다. 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BREATHE_URL, dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 연결 길 화면 런타임 검증 미실행");
  process.exit(0);
}
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const ROUTES = path.join(ROOT, "dist/org/connect-routes.js");
const REG = path.join(ROOT, "dist/org/connect-registration.js");
if (!existsSync(ROUTES) || !existsSync(REG)) { console.error("FAIL  dist 가 없다 — npm run build 먼저"); process.exit(1); }
const { decideRoutes } = await import(pathToFileURL(ROUTES).href);
const { registrationView } = await import(pathToFileURL(REG).href);

const bundle = execFileSync(ESBUILD, [
  path.join(ROOT, "web/v2/connect-routes.ts"), "--bundle", "--format=iife", "--global-name=CR", "--platform=browser", "--log-level=error",
], { encoding: "utf8", maxBuffer: 1 << 26 });   // 화면 모듈이 셸 코어(나 창 등)를 함께 묶어 1MB 를 넘는다

// ── 서버가 낼 수 있는 앱 상태(길 셋을 다 가진 앱 기준 — 조합 전수) ──
const B = [true, false];
const scen = [];
const seenKey = new Set();
for (const ready of B) for (const heldBy of ["lively", "workspace"]) for (const canRegister of B) for (const canCollect of B) for (const meConnected of B) for (const collecting of B)
  for (const policy of ["allowed", "blocked", "unknown"]) for (const mine of [null, "connected", "needs-auth"]) for (const login of [null, false])
    for (const tk of [{ canCollect, meConnected: false, collecting: false }, { canCollect, meConnected: true, collecting }]) {
      const d = decideRoutes({ app: { ready, heldBy, canRegister, canCollect, meConnected, collecting }, ai: { aiApp: "slack", policy, mine, login }, token: tk });
      const key = JSON.stringify([ready, d.routes, d.recommended, d.blocked_before]);
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      const appRoute = d.routes.find((r) => r.kind === "app");
      const registration = appRoute && !ready && (appRoute.state === "register" || appRoute.state === "ask_admin")
        ? registrationView("slack", { callbackUrl: "https://lively.acme.example/oauth/callback", gatewayUrl: "https://lively.acme.example" }) : null;
      scen.push({ app: "slack", label: "슬랙", app_ready: ready, routes: d.routes, recommended: d.recommended, blocked_before: d.blocked_before,
        registration, can_register: canRegister, connect_url: "https://lively.acme.example/ui/#/connect/slack", skill: "liv-connect-slack", note: null });
    }

const regApp = (app, label, opts = {}) => ({
  app, label, app_ready: false, routes: [{ kind: "app", state: "register" }], recommended: 0, blocked_before: [],
  registration: registrationView(app, { callbackUrl: opts.noAddr ? null : "https://lively.acme.example/oauth/callback", gatewayUrl: opts.noAddr ? null : "https://lively.acme.example" }),
  can_register: true, connect_url: `https://lively.acme.example/ui/#/connect/${app}`, skill: `liv-connect-${app}`, note: null,
});
const SLACK_REG = regApp("slack", "슬랙");
const GITHUB_REG = regApp("github", "깃허브");
const LAZY = { app: "slack", label: "슬랙", app_ready: true, routes: [{ kind: "app", state: "collecting" }, { kind: "ai", state: "connect", ai_app: "slack" }], recommended: 0, blocked_before: [],
  registration: null, can_register: true, connect_url: null, skill: "liv-connect-slack", note: null };
const PRIMARY_AI = { ...LAZY, routes: [{ kind: "app", state: "preparing" }, { kind: "ai", state: "connect", ai_app: "slack" }], recommended: 1, blocked_before: [0] };
const ERR = { app: "notion", label: "노션", app_ready: null, routes: null, recommended: null, blocked_before: null, registration: null,
  can_register: false, connect_url: null, skill: "liv-connect-notion", note: null, error: "조회 실패" };
const STATUS = { prereq: { vault_ready: true, callback_url: "https://lively.acme.example/oauth/callback" }, can_collect: true, gateway_url: "https://lively.acme.example",
  apps: [PRIMARY_AI, { ...LAZY, app: "github", label: "깃허브", routes: [{ kind: "app", state: "set_scope" }, { kind: "token", state: "connect" }] }, ERR, { ...SLACK_REG, app: "linear", label: "리니어", registration: regApp("linear", "리니어").registration }] };
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----\n";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="toasts"></div><div id="all"></div><div id="ai"></div><div id="lazy"></div><div id="slack"></div><div id="gh"></div><div id="err"></div><div id="list"></div>
<pre id="out">PENDING</pre>
<script>
  window.__calls = []; window.__opened = [];
  //  진짜 비동기(파일 읽기)를 기다릴 때 가상 시계를 붙잡는 «숨 고르기» — 가짜 fetch 를 걸기 전에 진짜 fetch 를 쥐어 둔다(headless-chrome.mjs).
  const realFetch = window.fetch.bind(window);
  window.__breathe = () => realFetch("${BREATHE_URL}").then((r) => r.text()).catch(() => '');
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  window.open = (u) => { window.__opened.push(String(u)); return null; };
  window.fetch = async (url, opts = {}) => {
    const u = String(url), method = (opts.method || 'GET').toUpperCase();
    window.__calls.push({ u, method, body: opts.body || null });
    if (u.indexOf('/api/ui/org/slack/app-manifest') >= 0) return json({ create_url: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D', redirect_url: 'x' });
    if (u.indexOf('/api/ui/org/connect/register') >= 0) return json({ ok: true, app: JSON.parse(opts.body).app });
    if (u.indexOf('/api/ui/member-ai-connectors') >= 0) return json({ policy: { state: 'allowed' }, members: [{ member_id: 'me', scan: { ok: true, error: null }, connectors: [{ app: 'Slack', status: 'connected' }] }] });
    if (u.indexOf('/api/ui/collect/units') >= 0) return json({ hidden: 0, visibility_enforced: true, units: [{ id: 1, app: 'slack', kind: 'channel', name: 'general', route: 'member_ai', state: 'active', visibility: 'all', access: 'full', candidates: [] }] });
    if (u.indexOf('/api/ui/org/members') >= 0) return json({ members: [{ id: 'me', display_name: '나', is_person: true, state: 'active' }] });
    if (u.indexOf('/api/ui/org/collectors') >= 0) return json({ collectors: [] });
    return json({});
  };
</script>
<script>${bundle}</script>
<script>
(async function () {
  const R = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, n = 150) => { for (let i = 0; i < n; i++) { const v = f(); if (v) return v; await sleep(20); } return null; };
  const posts = () => window.__calls.filter((c) => c.method === 'POST' && c.u.indexOf('/api/ui/org/connect/register') >= 0);
  const memberCalls = () => window.__calls.filter((c) => c.u.indexOf('/api/ui/member-ai-connectors') >= 0).length;
  const toasts = () => document.body.innerText;
  let reloads = 0;
  const ctx = () => ({ startAppConnect: () => {}, toCollect: () => {}, openToken: () => {}, reload: () => { reloads++; }, canManage: true });
  const bad = (t) => /\\bnull\\b|\\bundefined\\b/.test(t);
  try {
    // C1 — 전수
    const SC = ${JSON.stringify(scen)};
    const all = document.getElementById('all');
    let dead = [], nulls = [];
    for (const a of SC) {
      const sec = CR.routesSection(a, ctx());
      all.appendChild(sec);
      for (const card of sec.querySelectorAll('.cn-rt-card')) {
        const st = (card.querySelector('.cn-rt-st') || {}).textContent || '';
        const act = card.querySelector('button, a, input, select');
        if (!act && !st.trim()) dead.push(JSON.stringify(a.routes));
      }
    }
    await sleep(400);
    if (bad(all.innerText)) nulls.push('all');
    R.c1_count = SC.length;
    R.c1_no_dead = dead.length === 0;
    R.c1_no_null = nulls.length === 0;
    R.c1_dead = dead.slice(0, 3);
    // C2 — 권하는 Claude 길이 구성원·모으는 곳을 다 그린 뒤
    const ai = document.getElementById('ai');
    ai.appendChild(CR.routesSection(${JSON.stringify(PRIMARY_AI)}, ctx()));
    const got = await until(() => /general/.test(ai.innerText));
    R.c2_loaded = !!got;
    R.c2_no_null = !bad(ai.innerText);
    // C3 — 접힌 칸은 펼 때
    const before = memberCalls();
    const lazy = document.getElementById('lazy');
    lazy.appendChild(CR.routesSection(${JSON.stringify(LAZY)}, ctx()));
    await sleep(200);
    const closedCalls = memberCalls() - before;
    const det = lazy.querySelector('details.cn-rt-more');
    det.open = true;
    const opened = await until(() => memberCalls() - before > 0);
    R.c3_lazy = closedCalls === 0 && !!opened;
    // C4 — 슬랙 앱 등록
    const sl = document.getElementById('slack');
    reloads = 0;
    sl.appendChild(CR.routesSection(${JSON.stringify(SLACK_REG)}, ctx()));
    const steps = sl.querySelectorAll('ol.cn-reg-steps > li');
    R.c4_steps = steps.length === ${SLACK_REG.registration.steps.length};
    const mk = Array.from(sl.querySelectorAll('button')).find((b) => /슬랙 앱 만들기/.test(b.textContent));
    mk.click();
    R.c4_manifest = !!(await until(() => window.__opened.some((u) => u.indexOf('https://api.slack.com/apps?new_app=1') === 0)));
    const go = Array.from(sl.querySelectorAll('button')).find((b) => b.textContent === '등록');
    go.click();
    await sleep(80);
    R.c4_empty_blocked = posts().length === 0 && /칸을 채워 주세요/.test(toasts());
    const ins = Array.from(sl.querySelectorAll('.cn-reg-form input'));
    const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(ins[0], ' 123.456 '); set(ins[1], 'sec-abc');
    R.c4_secret_masked = ins[1].classList.contains('secret-input') && ins[1].type !== 'password' || ins[1].type === 'password';
    go.click();
    const p = await until(() => posts()[0]);
    R.c4_post = !!p && JSON.stringify(JSON.parse(p.body)) === JSON.stringify({ app: 'slack', values: { client_id: '123.456', client_secret: 'sec-abc' } });
    R.c4_reload = !!(await until(() => reloads > 0));
    // C5 — 깃허브 키 파일
    const gh = document.getElementById('gh');
    gh.appendChild(CR.routesSection(${JSON.stringify(GITHUB_REG)}, ctx()));
    const file = gh.querySelector('input[type=file]');
    //  파일 읽기(file.text())는 진짜 비동기라 가상 시계가 기다려 주지 않는다 — 결과 글이 바뀔 때까지 숨을 고르며 본다.
    const pick = async (name, text, want) => {
      const dt = new DataTransfer(); dt.items.add(new File([text], name)); file.files = dt.files; file.dispatchEvent(new Event('change'));
      for (let i = 0; i < 50 && !want.test(gh.innerText); i++) await window.__breathe();
    };
    await pick('cert.pem', '-----BEGIN CERTIFICATE-----\\nMII\\n-----END CERTIFICATE-----\\n', /키 파일이 아니에요/);
    R.c5_rejects_cert = /키 파일이 아니에요/.test(gh.innerText);
    await pick('lively.2026-10-23.private-key.pem', ${JSON.stringify(PEM)}, /골랐어요/);
    R.c5_picked = /골랐어요/.test(gh.innerText);
    const gins = Array.from(gh.querySelectorAll('.cn-reg-form input')).filter((i) => i.type !== 'file');
    const vals = { app_id: '123456', client_id: 'Iv1.abc', client_secret: 'gh-sec', app_slug: 'lively-acme' };
    const order = ${JSON.stringify(GITHUB_REG.registration.fields.filter((f) => !f.file).map((f) => f.key))};
    order.forEach((k, i) => set(gins[i], vals[k]));
    const before5 = posts().length;
    Array.from(gh.querySelectorAll('button')).find((b) => b.textContent === '등록').click();
    const p5 = await until(() => posts()[before5]);
    const body5 = p5 ? JSON.parse(p5.body) : null;
    R.c5_post = !!body5 && body5.app === 'github' && body5.values.private_key === ${JSON.stringify(PEM.trim())} && body5.values.app_slug === 'lively-acme' && body5.values.app_id === '123456';
    // C6 — 못 읽은 앱
    const er = document.getElementById('err');
    reloads = 0;
    er.appendChild(CR.routesSection(${JSON.stringify(ERR)}, ctx()));
    const rb = Array.from(er.querySelectorAll('button')).find((b) => /다시 불러오기/.test(b.textContent));
    if (rb) rb.click();
    R.c6_reload = !!rb && reloads === 1;
    // C7 — 목록
    const li = document.getElementById('list');
    li.appendChild(CR.appRows(${JSON.stringify(STATUS)}, ''));
    const heads = Array.from(li.querySelectorAll('.cn-gh b')).map((b) => b.textContent);
    R.c7_groups = heads.includes('바로 연결할 수 있어요') && heads.includes('상태를 불러오지 못했어요') && heads.includes('하나만 더 하면 돼요');
    R.c7_no_null = !bad(li.innerText);
    R.heads = heads;
  } catch (e) { R.error = String(e && e.stack || e); }
  document.getElementById('out').textContent = JSON.stringify(R) + 'ENDRESULT';
})();
</script></body></html>`;

const dom = await dumpDom(chrome, { html: PAGE, prefix: "connect-routes-", virtualTimeBudget: 20000, timeoutMs: 40000 });
const res = readOut(dom);
if (res.text === null) { console.error(`FAIL  결과 표지를 못 받았다(out=${JSON.stringify(res.out)})\n` + dom.slice(0, 600)); process.exit(1); }
const R = JSON.parse(res.text.trim());
if (R.error) console.error("페이지 예외:", R.error);
let fails = 0, total = 0;
const check = (k, why) => { total++; const ok = R[k] === true; console.log(`${ok ? "ok  " : "FAIL"}  ${k} — ${why}`); if (!ok) fails++; };
check("c1_no_dead", `C1 서버가 낼 수 있는 길·상태 ${R.c1_count}가지 — 칸마다 단추·링크·입력 또는 상태 문장`);
check("c1_no_null", "C1 어느 칸에도 «null» · «undefined» 글자가 없다");
check("c2_loaded", "C2 (배선) 권하는 Claude 길이 구성원·모으는 곳을 실제로 그렸다");
check("c2_no_null", "★C2 다 그린 뒤에도 «null» 이 없다(숨은 곳 0)");
check("c3_lazy", "C3 접힌 «다른 길» 의 Claude 칸은 펼 때 불러온다");
check("c4_steps", "C4 슬랙 앱 등록 걸음 수 = 안내 데이터");
check("c4_manifest", "C4 [슬랙 앱 만들기] 는 서버가 만든 링크를 연다");
check("c4_empty_blocked", "C4 빈 칸으로 [등록] 하면 보내지 않고 «칸을 채워 주세요»");
check("c4_secret_masked", "C4 비밀 칸은 가린다(레포 도우미 secretInput)");
check("c4_post", "C4 채우면 POST /api/ui/org/connect/register {app, values} — 앞뒤 공백은 뗀다");
check("c4_reload", "C4 등록 뒤 다시 그린다");
check("c5_rejects_cert", "C5 키가 아닌 파일(인증서)은 받지 않는다");
check("c5_picked", "C5 키 파일을 고르면 «골랐어요»");
check("c5_post", "C5 키 파일 내용이 private_key 로 간다(다섯 값)");
check("c6_reload", "C6 상태를 못 읽은 앱 — [다시 불러오기] 를 누르면 다시 그린다");
check("c7_groups", "C7 목록 묶음(바로 연결 · 하나만 더 · 못 읽음)");
check("c7_no_null", "C7 목록에 «null» 이 없다");
if (fails) console.log(JSON.stringify({ dead: R.c1_dead, heads: R.heads }));
console.log(fails ? `\n${fails}건 실패` : `\n${total}건 통과`);
process.exit(fails ? 1 : 0);
