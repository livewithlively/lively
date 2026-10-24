#!/usr/bin/env node
// [외부 앱 연결] «연결하는 길» 칸 · 목록 — 런타임 시험 (#4970 격리 리뷰 2차).
//
// 사양(엣지 표 — 행마다 시나리오 하나):
//  C1 서버 판정(dist/org/connect-routes.js decideRoutes)이 낼 수 있는 길·상태 전부를 상세 칸으로 그리면 —
//     어느 칸에도 글자 «null»·«undefined» 가 없고, 준비 중·꺼짐이 아닌 칸에는 단추·링크·입력이 하나는 있다(막다른 칸 없음).
//  C2 Claude 길 칸이 구성원·모으는 곳을 다 그린 뒤에도 «null» 이 없다(숨은 곳 0 — replaceChildren 에 null 을 넘기던 결함).
//  C3 접힌 «다른 길» 의 Claude 칸은 펼 때 불러온다(펼치기 전 구성원 조회 0건 → 펼친 뒤 1건 이상).
//  C4 슬랙 앱 등록 — 빈 칸으로 [등록] 하면 보내지 않고 «칸을 채워 주세요» · 채우면 POST /api/ui/org/connect/register {app, values} · 다시 그린다.
//     [슬랙 앱 만들기] 는 서버가 만든 링크(GET /api/ui/org/slack/app-manifest 의 create_url)를 연다.
//  C5 깃허브 앱 등록 — 키 파일(.pem)을 고르면 그 내용이 private_key 로 간다 · 키가 아닌 파일은 받지 않는다.
//  C6 상태를 못 읽은 앱 — [다시 불러오기] 단추가 있고 누르면 다시 그린다.
//  C7 목록 — 묶음 제목이 서고 «null» 이 없다 · 못 읽은 앱은 «상태를 불러오지 못했어요» 묶음.
//  C8 앱 등록 걸음은 번호가 붙는다(스타일시트를 실어 li 가 list-item 인지 본다 — li 를 flex 로 만들어 번호가 사라졌던 결함).
//  C9 길 목록에 원래 없는 앱(관리자가 등록한 앱)의 상세엔 길 칸을 세우지 않는다 · 상태를 통째로 못 읽었을 때만 «못 읽음» 칸.
//  C10 관리자가 등록한 «표에 없는 앱» 은 목록 «그 밖에 연결할 수 있는 앱» 에 선다 · 상태를 못 읽으면 앱마다 상세로 가는 줄.
//  (#4991 등록한 뒤 — 사양 G1~G10)
//  G1 can_edit_registration=true 면 라이블리 앱 칸에 «앱 등록 보기 · 바꾸기 · 지우기» 가 접혀 선다 · 펴기 전 등록 조회 0건.
//  G2 펴면 GET /api/ui/org/connect/registration?app=<앱> 1건 · 지금 등록(Client ID)이 보인다.
//  G3 [등록 값 바꾸기] → 서버가 준 «다른 앱으로 바꾸면» 문장 그대로 · [바꾸기] 칸(등록 단추가 아니다) · POST /register {app, values} · 다시 그린다.
//  G4 [등록 지우기] → 확인 창에 서버가 준 «지우면» 문장 전부 · [취소]면 보내지 않는다 · 확인하면 POST /unregister {app} · 다시 그린다.
//  G5 can_edit_registration 이 false 이거나 없으면(옛 서버) 칸이 없다.
//  G6 지금 등록이 서버 설정(env)이면 [등록 지우기] 없이 [등록 값 넣기].
//  G7 릴레이면 단추 없이 안내 한 줄.
//  G8 조회 실패 → «불러오지 못했어요» + [다시 불러오기] → 다시 조회해 그린다.
//  G9 이 칸들에 «null»·«undefined» 가 없다.  G10 등록 전 칸은 종전대로 [등록](바꾸기 모드가 새지 않는다).
//  G11 지운 결과마다 말이 다르다(지울 것 없음 · 서버 설정의 앱이 남음).  G12 확인 창 직전에 다시 읽어 그새 지워졌으면 묻지 않는다.
//
// 왜 런타임인가: 결함은 DOM 쪽에서 나왔다(replaceChildren 에 null · li 를 flex 로 만들어 번호가 사라짐). 말 표 시험
//  (connect-routes-view.test.mjs)은 그것을 못 본다. 실제 화면 모듈(web/v2/connect-routes.ts)을 묶어 진짜 DOM 에서 돌리고,
//  서버 자리(fetch)만 정해진 응답으로 바꾼다. 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
const UNREG = path.join(ROOT, "dist/org/connect-unregister.js");
if (!existsSync(UNREG)) { console.error("FAIL  dist 가 없다(connect-unregister) — npm run build 먼저"); process.exit(1); }
const { registrationImpact } = await import(pathToFileURL(UNREG).href);

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
// ── (#4991) 등록한 뒤 — 서버가 낼 응답(문장은 실제 판정 registrationImpact 로 만든다) ──
const EDIT = { app: "notion", label: "노션", app_ready: true, routes: [{ kind: "app", state: "collecting" }, { kind: "ai", state: "connect", ai_app: "notion" }], recommended: 0, blocked_before: [],
  registration: null, can_register: true, can_edit_registration: true, connect_url: null, skill: "liv-connect-notion", note: null };
const NO_EDIT = { ...EDIT, can_edit_registration: false };
const REG_IMPACT = registrationImpact("notion", "노션", { members: { total: 0, expiring: 0 }, places: [{ id: "a1b2c3d4-0000", name: "위시스트" }], collecting: true, envFallback: false });
const REG_INFO = Object.fromEntries(["vault", "env", "relay"].map((source) => [source, {
  app: "notion", label: "노션",
  current: source === "vault" ? { source, client_id: "notion-client-abc", updated_at: "2026-10-25T03:00:00.000Z" } : { source, client_id: null, updated_at: null },
  impact: REG_IMPACT,
  registration: registrationView("notion", { callbackUrl: "https://lively.acme.example/oauth/callback", gatewayUrl: "https://lively.acme.example" }),
}]));
//  앱 등록 걸음 번호(C8)를 보려고 화면 스타일시트를 그대로 싣는다.
const CSS = readFileSync(path.join(ROOT, "public/styles/40-v2.css"), "utf8").replace(/<\/style/gi, "<\\/style");
const VIEW = { all: [{ key: "slack", label: "Slack" }, { key: "hubspot-crm", label: "Hubspot Crm", dynamic: true }, { key: "asana", label: "Asana", dynamic: true }],
  connected: [{ key: "hubspot-crm", label: "Hubspot Crm" }] };
//  키 판별 시험용 가짜 키 — 표지를 쪼개 이어 붙인다(파일에 키 모양 글자가 남으면 비밀 검사기 gitleaks private-key 가 진짜 키로 잡는다).
const PEM_MARK = (edge) => `-----${edge} RSA PRIVATE ` + "KEY-----";
const PEM = `${PEM_MARK("BEGIN")}\nZmFrZS1rZXktZm9yLWxpdmVseS1jb25uZWN0LXJ1bnRpbWUtdGVzdA==\n${PEM_MARK("END")}\n`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div id="toasts"></div><div id="all"></div><div id="ai"></div><div id="lazy"></div><div id="slack"></div><div id="gh"></div><div id="err"></div><div id="list"></div>
<div id="mg"></div><div id="mg5"></div><div id="mg6"></div><div id="mg7"></div><div id="mg8"></div><div id="mg10"></div><div id="mg11"></div><div id="mg12"></div>
<pre id="out">PENDING</pre>
<script>
  window.__calls = []; window.__opened = [];
  window.__regInfo = ${JSON.stringify(REG_INFO)}; window.__regSource = 'vault'; window.__regFail = false;
  //  진짜 비동기(파일 읽기)를 기다릴 때 가상 시계를 붙잡는 «숨 고르기» — 가짜 fetch 를 걸기 전에 진짜 fetch 를 쥐어 둔다(headless-chrome.mjs).
  const realFetch = window.fetch.bind(window);
  window.__breathe = () => realFetch("${BREATHE_URL}").then((r) => r.text()).catch(() => '');
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  window.open = (u) => { window.__opened.push(String(u)); return null; };
  window.fetch = async (url, opts = {}) => {
    const u = String(url), method = (opts.method || 'GET').toUpperCase();
    window.__calls.push({ u, method, body: opts.body || null });
    if (u.indexOf('/api/ui/org/slack/app-manifest') >= 0) return json({ create_url: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D', redirect_url: 'x' });
    //  보기(GET)·지우기를 등록보다 먼저 가른다 — 주소가 모두 /api/ui/org/connect/ 로 시작한다.
    if (u.indexOf('/api/ui/org/connect/registration') >= 0) return window.__regFail ? json({ error: '잠시 읽지 못했어요' }, 500) : json(window.__regInfo[window.__regSource]);
    if (u.indexOf('/api/ui/org/connect/unregister') >= 0) return json({ ok: true, app: JSON.parse(opts.body).app, ...(window.__unregResult || { deleted: 1, app_ready: false }) });
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
  //  다시 그리기는 칸마다 이름으로도 센다 — 앞 칸의 늦은 다시 그리기(실측: C5 의 것이 G1 중에 도착)가 공용 카운터를 올려
  //   뒤 칸이 자기 것을 기다리지 않고 지나가지 않게(#4991 G 칸들).
  const reloadLog = [];
  const ctx = (name = '') => ({ startAppConnect: () => {}, toCollect: () => {}, openToken: () => {}, reload: () => { reloads++; reloadLog.push(name); }, canManage: true });
  const reloadsOf = (name) => reloadLog.filter((n) => n === name).length;
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
        const state = (Array.from(card.classList).find((c) => c.indexOf('s-') === 0) || '').slice(2);
        const act = card.querySelector('button, a, input, select');
        //  준비 중·꺼짐은 사람이 할 일이 없다 — 상태 문장만 있으면 된다. 그 밖의 칸은 누를 것이 하나는 있어야 한다.
        if (!st.trim() || (!act && state !== 'preparing' && state !== 'off')) dead.push(state + ' ' + JSON.stringify(a.routes));
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
    // C8 — 걸음 번호
    const li0 = document.querySelector('#slack ol.cn-reg-steps > li');
    R.c8_numbered = !!li0 && getComputedStyle(li0).display === 'list-item' && !!li0.querySelector('.cn-reg-li');
    // C9 — 길 목록에 없는 앱 · 못 읽음
    const st9 = ${JSON.stringify(STATUS)};
    R.c9_unlisted_none = CR.routesAppFor(st9, 'asana', 'Asana') === null;
    R.c9_listed = (CR.routesAppFor(st9, 'slack', '슬랙') || {}).app === 'slack';
    const errApp = CR.routesAppFor(null, 'notion', 'Notion');
    R.c9_failed_error = !!errApp && !!errApp.error && errApp.routes === null;
    // C10 — 그 밖의 앱 · 못 읽음 폴백
    const v = ${JSON.stringify(VIEW)};
    const o1 = document.createElement('div'); o1.append(...CR.otherRows(v, st9, ''));
    const t1 = o1.innerText;
    R.c10_dynamic = /그 밖에 연결할 수 있는 앱/.test(t1) && /Hubspot Crm/.test(t1) && /Asana/.test(t1) && !/Slack/.test(t1) && /내 계정으로 연결됨/.test(t1);
    const o2 = document.createElement('div'); o2.append(...CR.otherRows(v, null, ''));
    const heads2 = Array.from(o2.querySelectorAll('.cn-gh b')).map((b) => b.textContent);
    R.c10_fallback = heads2.indexOf('앱') >= 0 && /Slack/.test(o2.innerText) && Array.from(o2.querySelectorAll('a.cn-row')).every((a) => (a.getAttribute('href') || '').indexOf('#/connect/') === 0);
    R.c10_search = CR.otherRows(v, st9, 'asana').length === 1 && !/Hubspot/.test(CR.otherRows(v, st9, 'asana')[0].innerText);
    // ── (#4991) 등록한 뒤 ──
    const regCalls = () => window.__calls.filter((c) => c.u.indexOf('/api/ui/org/connect/registration') >= 0);
    const unregPosts = () => window.__calls.filter((c) => c.method === 'POST' && c.u.indexOf('/api/ui/org/connect/unregister') >= 0);
    const mgr = (host) => Array.from(host.querySelectorAll('details')).find((d) => /앱 등록 보기/.test((d.querySelector('summary') || {}).textContent || ''));
    const btns = (host) => Array.from(host.querySelectorAll('button'));
    const EDIT = ${JSON.stringify(EDIT)};
    const IMP = ${JSON.stringify(REG_IMPACT)};
    // G1
    const mg = document.getElementById('mg');
    mg.appendChild(CR.routesSection(EDIT, ctx('g')));
    await sleep(150);
    const md = mgr(mg);
    R.g1_closed = !!md && !md.open && regCalls().length === 0;
    // G2
    md.open = true;
    const shown = await until(() => /notion-client-abc/.test(mg.innerText));
    R.g2_loaded = !!shown && regCalls().length === 1 && regCalls()[0].method === 'GET' && /[?&]app=notion(&|$)/.test(regCalls()[0].u);
    // G3
    btns(mg).find((b) => b.textContent === '등록 값 바꾸기').click();
    await sleep(60);
    const items = Array.from(mg.querySelectorAll('.cn-reg-impact li')).map((li) => li.textContent);
    R.g3_impact = items.length === IMP.replace.length && items.every((x, i) => x === IMP.replace[i]);
    const goSwap = btns(mg).find((b) => b.textContent === '바꾸기');
    const swapSteps = (mg.querySelector('.cn-reg-swap ol.cn-reg-steps') || {}).textContent || '';
    R.g3_swap_btn = !!goSwap && !btns(mg).some((b) => b.textContent === '등록')
      && swapSteps.indexOf('[바꾸기] 를 누릅니다') >= 0 && swapSteps.indexOf('[등록] 을') < 0;
    const sins = Array.from(mg.querySelectorAll('.cn-reg-form input'));
    set(sins[0], ' new-client '); set(sins[1], 'new-secret');
    const before3 = posts().length;
    const r3 = reloadsOf('g');
    goSwap.click();
    const p3 = await until(() => posts()[before3]);
    R.g3_post = !!p3 && JSON.stringify(JSON.parse(p3.body)) === JSON.stringify({ app: 'notion', values: { client_id: 'new-client', client_secret: 'new-secret' } });
    R.g3_reload = !!(await until(() => reloadsOf('g') > r3));
    // G4
    const r4 = reloadsOf('g');
    const delBtn = btns(mg).find((b) => b.textContent === '등록 지우기');
    delBtn.click();
    const dlg = await until(() => document.querySelector('.ov-confirm'));
    const lines = dlg ? Array.from(dlg.querySelectorAll('.ov-confirm-line')).map((x) => x.textContent) : [];
    R.g4_lines = lines.length === IMP.remove.length && lines.every((x, i) => x === IMP.remove[i]);
    btns(dlg).find((b) => b.textContent === '취소').click();
    await sleep(80);
    R.g4_cancel = unregPosts().length === 0 && !document.querySelector('.ov-confirm') && reloadsOf('g') === r4;
    delBtn.click();
    const dlg2 = await until(() => document.querySelector('.ov-confirm'));
    btns(dlg2).find((b) => b.textContent === '등록 지우기').click();
    const up = await until(() => unregPosts()[0]);
    R.g4_post = !!up && JSON.stringify(JSON.parse(up.body)) === JSON.stringify({ app: 'notion' });
    R.g4_reload = !!(await until(() => reloadsOf('g') > r4));
    // G5
    const m5 = document.getElementById('mg5');
    m5.appendChild(CR.routesSection(${JSON.stringify(NO_EDIT)}, ctx()));
    m5.appendChild(CR.routesSection(${JSON.stringify(LAZY)}, ctx()));
    R.g5_hidden = !mgr(m5) && m5.querySelectorAll('.cn-rt-card').length >= 2;
    // G6
    window.__regSource = 'env';
    const m6 = document.getElementById('mg6');
    m6.appendChild(CR.routesSection(EDIT, ctx()));
    mgr(m6).open = true;
    await until(() => /서버 설정/.test(m6.innerText));
    const b6 = btns(m6).map((b) => b.textContent);
    R.g6_env = b6.includes('등록 값 넣기') && !b6.includes('등록 지우기') && !b6.includes('등록 값 바꾸기');
    // G7
    window.__regSource = 'relay';
    const m7 = document.getElementById('mg7');
    m7.appendChild(CR.routesSection(EDIT, ctx()));
    mgr(m7).open = true;
    await until(() => /라이블리 클라우드/.test(m7.innerText));
    R.g7_relay = /라이블리 클라우드/.test(m7.innerText) && btns(m7.querySelector('.cn-reg-man')).length === 0;
    // G8
    window.__regSource = 'vault'; window.__regFail = true;
    const m8 = document.getElementById('mg8');
    m8.appendChild(CR.routesSection(EDIT, ctx()));
    mgr(m8).open = true;
    await until(() => /불러오지 못했어요/.test(m8.innerText));
    const c8 = regCalls().length;
    const retry = btns(m8).find((b) => b.textContent === '다시 불러오기');
    window.__regFail = false;
    if (retry) retry.click();
    const back = await until(() => /notion-client-abc/.test(m8.innerText));
    R.g8_retry = !!retry && !!back && regCalls().length === c8 + 1;
    // G9
    R.g9_no_null = !bad(mg.innerText + m5.innerText + m6.innerText + m7.innerText + m8.innerText);
    // G10
    const m10 = document.getElementById('mg10');
    m10.appendChild(CR.routesSection(${JSON.stringify(SLACK_REG)}, ctx()));
    R.g10_register = btns(m10).some((b) => b.textContent === '등록') && !btns(m10).some((b) => b.textContent === '바꾸기') && !mgr(m10);
    // G11 — 지운 결과마다 말이 다르다(지울 것 없음 · 서버 설정의 앱이 남음)
    const delOnce = async (host, result) => {
      window.__unregResult = result;
      const before = unregPosts().length;
      btns(host).find((b) => b.textContent === '등록 지우기').click();
      const dlg = await until(() => document.querySelector('.ov-confirm'));
      if (!dlg) return false;
      btns(dlg).find((b) => b.textContent === '등록 지우기').click();
      return !!(await until(() => unregPosts().length > before));
    };
    const m11 = document.getElementById('mg11');
    window.__regSource = 'vault';
    m11.appendChild(CR.routesSection(EDIT, ctx('g11')));
    mgr(m11).open = true;
    await until(() => /notion-client-abc/.test(m11.innerText));
    const sent0 = await delOnce(m11, { deleted: 0, app_ready: false });
    const said0 = !!(await until(() => /지울 앱 등록이 없었어요/.test(document.body.innerText)));
    const sentEnv = await delOnce(m11, { deleted: 1, app_ready: true });
    //  ⚠ 이 줄은 템플릿 문자열 안이라 정규식의 \( 가 ( 로 풀린다 — 괄호가 든 글은 includes 로 본다.
    const saidEnv = !!(await until(() => document.body.innerText.includes('서버 설정(환경 변수)의 앱으로 계속 연결해요')));
    R.g11_toasts = sent0 && said0 && sentEnv && saidEnv;
    R.g11_parts = [sent0, said0, sentEnv, saidEnv];
    window.__unregResult = null;
    // G12 — 칸을 편 뒤 누가 이미 지웠으면(다시 읽으니 vault 아님) 묻지도 보내지도 않고 다시 그린다
    const m12 = document.getElementById('mg12');
    m12.appendChild(CR.routesSection(EDIT, ctx('g12')));
    mgr(m12).open = true;
    await until(() => /notion-client-abc/.test(m12.innerText));
    window.__regSource = 'env';
    const p12 = unregPosts().length, r12 = reloadsOf('g12');
    btns(m12).find((b) => b.textContent === '등록 지우기').click();
    const reloaded12 = !!(await until(() => reloadsOf('g12') > r12));
    await sleep(60);
    R.g12_stale = reloaded12 && unregPosts().length === p12 && !document.querySelector('.ov-confirm');
    window.__regSource = 'vault';
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
check("c1_no_dead", `C1 서버가 낼 수 있는 길·상태 ${R.c1_count}가지 — 칸마다 상태 문장 · 준비 중·꺼짐이 아니면 누를 것 하나`);
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
check("c8_numbered", "C8 앱 등록 걸음에 번호가 붙는다(스타일을 실어 li 가 list-item)");
check("c9_unlisted_none", "★C9 길 목록에 원래 없는 앱(관리자가 등록한 앱)은 길 칸을 세우지 않는다(가짜 «못 읽음» 없음)");
check("c9_listed", "C9 길 목록에 있는 앱은 그 앱");
check("c9_failed_error", "C9 상태를 통째로 못 읽었을 때만 «못 읽음» 칸");
check("c10_dynamic", "C10 표에 없는 앱은 «그 밖에 연결할 수 있는 앱» 에 선다(길 목록의 앱은 다시 세우지 않는다 · 연결됨 표시)");
check("c10_fallback", "C10 상태를 못 읽으면 앱마다 상세로 가는 줄");
check("c10_search", "C10 찾기 칸이 그 밖의 앱에도 먹는다");
check("g1_closed", "G1 등록한 앱 — «앱 등록 보기 · 바꾸기 · 지우기» 가 접혀 서고, 펴기 전엔 조회하지 않는다");
check("g2_loaded", "G2 펴면 GET …/registration?app=notion 한 번 · 지금 등록(Client ID)이 보인다");
check("g3_impact", "G3 [등록 값 바꾸기] — 서버가 준 «다른 앱으로 바꾸면» 문장을 그대로 보인다");
check("g3_swap_btn", "G3 바꾸기 칸의 단추는 [바꾸기](등록 단추가 아니다) · 걸음 글도 «[바꾸기] 를 누릅니다»");
check("g3_post", "G3 채우면 POST /api/ui/org/connect/register {app, values} — 앞뒤 공백은 뗀다");
check("g3_reload", "G3 바꾼 뒤 다시 그린다");
check("g4_lines", "★G4 [등록 지우기] — 확인 창에 서버가 준 «지우면» 문장이 전부 있다");
check("g4_cancel", "★G4 [취소] 면 지우지 않는다(POST 0건 · 창 닫힘 · 다시 그리지 않음)");
check("g4_post", "G4 확인하면 POST /api/ui/org/connect/unregister {app}");
check("g4_reload", "G4 지운 뒤 다시 그린다(등록 칸이 다시 선다)");
check("g5_hidden", "★G5 can_edit_registration 이 false 이거나 없으면(매니지드 · 옛 서버) 칸이 없다");
check("g6_env", "G6 서버 설정의 앱이면 [등록 값 넣기]만 — 지울 것이 없다");
check("g7_relay", "G7 릴레이면 단추 없이 안내 한 줄");
check("g8_retry", "G8 조회 실패 → [다시 불러오기] 로 다시 조회해 그린다");
check("g9_no_null", "G9 등록한 뒤 칸들에 «null» · «undefined» 가 없다");
check("g10_register", "G10 등록 전 칸은 종전대로 [등록] · 등록한 뒤 칸이 섞이지 않는다");
check("g11_toasts", "G11 지운 결과마다 말이 다르다 — 지울 것이 없었음 · 서버 설정의 앱으로 계속 연결");
check("g12_stale", "★G12 칸을 편 뒤 그새 지워졌으면(다시 읽으니 등록 없음) 묻지도 보내지도 않고 다시 그린다");
if (fails) console.log(JSON.stringify({ dead: R.c1_dead, heads: R.heads, g11: R.g11_parts, error: R.error || null }));
console.log(fails ? `\n${fails}건 실패` : `\n${total}건 통과`);
process.exit(fails ? 1 : 0);
