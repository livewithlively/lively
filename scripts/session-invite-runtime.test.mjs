#!/usr/bin/env node
// 세션 초대 — 빈 칸 ↵ 로 초대 · 초대받은 사람의 나가기 · 홈 「초대받은 세션」 층 (#3870, 원준 2026-10-14)
//
//  «+버튼 한 번 누르고 사람 이름 누르고 엔터 치면 그 사람 초대가 되는데, 저장 버튼은 또 따로 마우스로 가져가서 눌러야 하거든?
//   이거 그냥 엔터 한 번 더 치면 초대되게 할 수 있어?» · «초대받은 뒤에 나갈 수가 있나? … 만든 사람은 나가는 경로 없어야 되고»
//  · «초대받은 세션을 위에 보이게.. 프로젝트 묶기 버튼처럼 온오프 가능하게»
//
// 사양(엣지 표 — 행마다 단언 하나 이상, 사양 원본은 커밋 메시지):
//  E1 글자 + 맨 위 후보 → 담기          E2 글자 + 후보 없음 → 없음        E3 빈 칸 + 바뀜 → 저장
//  E4 빈 칸 + 안 바뀜 + 후보 → 담기(종전) E5 빈 칸 + 안 바뀜 + 후보 없음 → 없음
//  E6 ⌘ + 바뀜(글자 있어도) → 저장       E7 ⌘ + 안 바뀜 → 없음
//  D1 inviteDirty 순서 무관 · 크기 다름 · 같은 크기 다른 사람  D2 inviteAdded = 처음에 없던 사람만
//  V1 치움 → 안 섬  V2 도는 → 섬  V3 멈춤 7일 이내 → 섬  V4 정확히 7일 → 섬  V5 7일 넘음 → 안 섬  V6 lastSeen 0 → 안 섬
//  P1 켬: 초대 · 안 고정 → 층  P2 켬: 초대 · 고정 → 나머지(「고정」 층)  P3 끔 → 층 없음
//  S1 한 명: 이름 → ↵(담김 · 칸 비움 · 요청 0 · ↵ 표식이 저장 단추로 · 단추 «초대» · 안내 보임) → ↵(요청 1건 · 명단) · «알림을 보냈어요»
//  S2 여러 명: 이름 → ↵ → 이름 → ↵ → ↵ = 요청 1건에 둘
//  S3 조합 중 ↵ — 아무것도 안 담고 요청 0
//  S4 빈 칸 · 안 바뀜 — ↵ 는 맨 위 사람 담기(표식이 그 줄에) · 요청 0
//  S5 ⌘↵ — 칸에 글자가 있어도 바뀐 게 있으면 저장 · 바뀐 게 없으면 요청 0
//  S6 빼기만 — 단추 «저장» · 빈 칸 ↵ 로 저장(명단에서 빠짐)
//  S7 서버가 알림 0건이라 답하면 «알림을 보냈어요» 를 말하지 않는다 · 바뀐 것 없으면 저장 단추가 꺼져 있다
//  L1 초대받은 사람 — 공유 창에 [이 세션에서 나가기] · 취소면 요청 0 · 나가기면 POST …/leave 1건 + session-left 신호(그 세션 id)
//  L2 만든 사람(편집기) — 나가기 단추 없음  L3 명단 밖의 남(관리자로 보는 것) — 없음
//  G1 켬 — 「고정」 → 「초대받은 세션」 → 「지금 볼 것」 순 · 초대 줄은 그 층 카드에만 · 고정한 초대 줄은 「고정」 에
//  G2 프로젝트로 묶기 축에서도 같은 층 · 초대 줄이 프로젝트 카드에 섞이지 않는다
//  G3 토글 — 초대받은 세션 0 이면 단추 없음 · 있으면 단추(눌림) · 누르면 꺼지고 셸에 다시 세우라 알린다 · 끄면 층 없음
//  W1 셸(main.ts) — 내 세션이 아닌 초대받은 세션만 · 토글이 켜졌을 때만 · invitedRowStands 로 · 초대 표식을 달아 세운다 · 정렬에서 「고정」 다음
//  W2 나가기 입구 셋 — 우클릭 · 설정 창은 isInvitedSess 로 가른다 · 셸은 session-left 신호에 창을 닫고 목록을 다시 받는다
//
// fail-first: 변경 전 web/(WEB_SRC 로 origin/main 판을 물림)과 변이에서 빨강을 먼저 봤다 — 결과는 커밋 메시지에.
// ⚠ 이름은 ASCII 만(글꼴 없는 면). 크롬이 없는 면에서는 런타임 절을 조용히 건너뛴다.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "기대와 다르다") => (cond ? ok(n) : bad(n, why));
const done = () => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };
const j = (o) => JSON.stringify(o);
const WEB = process.env.WEB_SRC || path.join(ROOT, "web");
const STYLES = process.env.STYLES_SRC || path.join(ROOT, "public/styles");

// ───────────────────────── E · D · V · P. 순수 규칙
const tscOut = (lib, tag) => {
  const out = mkdtempSync(path.join(tmpdir(), tag));
  execFileSync(path.join(ROOT, "node_modules/.bin/tsc"), [lib, "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"], { stdio: "inherit" });
  return path.join(out, path.basename(lib).replace(/\.ts$/, ".js"));
};
const ENTER_LIB = path.join(WEB, "lib/share-enter.ts"), INV_LIB = path.join(WEB, "lib/invited-up.ts");
if (!existsSync(ENTER_LIB)) bad("E0 web/lib/share-enter.ts 가 있다", "없다 — 빈 칸 ↵ 를 정하는 자리가 없다");
else {
  const { shareEnterAction: A, inviteDirty, inviteAdded } = await import(tscOut(ENTER_LIB, "share-enter-"));
  const t = (query, hasTop, dirty, mod) => A({ query, hasTop, dirty, mod });
  check(t("al", true, false) === "pick" && t("al", true, true) === "pick", "E1 글자 + 맨 위 후보 → 담기", j([t("al", true, false), t("al", true, true)]));
  check(t("zz", false, false) === "none" && t("zz", false, true) === "none", "E2 글자 + 후보 없음 → 없음");
  check(t("", true, true) === "save" && t("  ", false, true) === "save", "E3 빈 칸 + 바뀜 → 저장(공백만도 빈 칸)");
  check(t("", true, false) === "pick", "E4 빈 칸 + 안 바뀜 + 후보 → 담기(종전)");
  check(t("", false, false) === "none", "E5 빈 칸 + 안 바뀜 + 후보 없음 → 없음");
  check(t("al", true, true, true) === "save" && t("", false, true, true) === "save", "E6 ⌘ + 바뀜 → 저장");
  check(t("al", true, false, true) === "none" && t("", true, false, true) === "none", "E7 ⌘ + 안 바뀜 → 없음");
  check(inviteDirty(["a", "b"], ["b", "a"]) === false && inviteDirty(["a"], ["a", "b"]) === true && inviteDirty(["a", "b"], ["a", "c"]) === true && inviteDirty([], []) === false,
    "D1 inviteDirty 순서 무관 · 크기 · 같은 크기 다른 사람");
  check(j(inviteAdded(["a"], ["a", "b", "c"])) === '["b","c"]' && j(inviteAdded(["a", "b"], ["a"])) === "[]", "D2 inviteAdded = 처음에 없던 사람만");
}
if (!existsSync(INV_LIB)) bad("V0 web/lib/invited-up.ts 가 있다", "없다 — 「초대받은 세션」 층 규칙이 없다");
else {
  const { invitedRowStands: S, splitInvited, INVITED_RECENT_MS: W } = await import(tscOut(INV_LIB, "invited-up-"));
  const now = 1_800_000_000_000;
  check(S({ live: true, lastSeen: now, now, dismissed: true }) === false, "V1 치움 → 안 섬(도는 세션이어도)");
  check(S({ live: true, lastSeen: 0, now, dismissed: false }) === true, "V2 도는 → 섬");
  check(S({ live: false, lastSeen: now - 3600e3, now, dismissed: false }) === true, "V3 멈춤 7일 이내 → 섬");
  check(W === 7 * 86400e3 && S({ live: false, lastSeen: now - W, now, dismissed: false }) === true, "V4 정확히 7일 → 섬", String(W));
  check(S({ live: false, lastSeen: now - W - 1, now, dismissed: false }) === false, "V5 7일 넘음 → 안 섬");
  check(S({ live: false, lastSeen: 0, now, dismissed: false }) === false, "V6 lastSeen 0 → 안 섬");
  const rows = [{ id: "a", invited: true }, { id: "b" }, { id: "c", invited: true, pinned: true }];
  const on = splitInvited(rows, true), off = splitInvited(rows, false);
  check(j(on.invited.map((r) => r.id)) === '["a"]' && j(on.rest.map((r) => r.id)) === '["b","c"]', "P1·P2 켬 — 안 고정 초대는 층, 고정한 초대는 나머지(「고정」)", j(on));
  check(off.invited.length === 0 && off.rest.length === 3, "P3 끔 → 층 없음", j(off));
}

// ───────────────────────── W. 배선(주석을 걷고 본다)
const strip = (f) => (existsSync(f) ? readFileSync(f, "utf8").replace(/^[ \t]*\/\/.*$/gm, "") : "");
const MAIN = strip(path.join(WEB, "v2/main.ts")), CTX = strip(path.join(WEB, "v2/ctx-shell.ts")), CHAT = strip(path.join(WEB, "session-chat.ts"));
{
  const at = MAIN.indexOf("function sideInstances(");
  const body = at > 0 ? MAIN.slice(at, MAIN.indexOf("\nfunction ", at + 10)) : "";
  const blk = /if \(sideInvitedUp\(\)\) \{\s*for \(const s of data\.sessions\) \{([\s\S]*?)\n    \}\n  \}/.exec(body);
  check(!!blk && /if \(s\.owned \|\| isTrashedSess\(s\) \|\| !isInvitedSess\(s\)\) continue;/.test(blk[1])
    && /invitedRowStands\(\{ live: liveNow, lastSeen: s\.lastSeen \|\| 0, now, dismissed: dismissedNow \}\)/.test(blk[1])
    && /put\('sess:' \+ s\.id,[^\n]*, true\);/.test(blk[1]),
    "W1a 셸 — 토글이 켜졌을 때 남의 세션 중 초대받은 것만 · 서기 규칙으로 · 초대 표식을 달아 세운다");
  check(/pin \? PINNED_GROUP : invited \? INVITED_GROUP :/.test(body)
    && body.indexOf("af ? -1 : 1") > 0 && body.indexOf("ai ? -1 : 1") > body.indexOf("af ? -1 : 1") && body.indexOf("ap ? -1 : 1") > body.indexOf("ai ? -1 : 1"),
    "W1b 셸 — 초대 줄의 묶음은 「초대받은 세션」 · 정렬은 고정 → 초대 → 지금 볼 것");
}
check(/if \(isInvitedSess\(s\)\) rows\.push\([^\n]*label: '이 세션에서 나가기'[^\n]*leaveInvitedSession\(/.test(CTX)
  && /isInvitedSess\(target\)\s*\?\s*row\('이 세션에서 나가기'/.test(CHAT)
  && /window\.addEventListener\(SESSION_LEFT_EVENT,[\s\S]{0,700}closeRowTabs\([\s\S]{0,200}v2Refresh\(\);/.test(MAIN),
  "W2 나가기 입구 — 우클릭 · 설정 창은 초대받은 사람만 · 셸은 신호에 창을 닫고 다시 받는다");

// ───────────────────────── 런타임
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 런타임 검증 미실행"); done(); }
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다(node_modules/.bin/esbuild)"); process.exit(1); }
const ENTRY_DIR = mkdtempSync(path.join(tmpdir(), "invite-entry-"));
const pack = (src, name) => {
  const entry = path.join(ENTRY_DIR, name + ".ts");
  writeFileSync(entry, src);
  return execFileSync(ESBUILD, [entry, "--bundle", "--format=iife", "--global-name=" + name, "--platform=browser",
    "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
};
const css = (...fs) => fs.map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");
const run = async (html, prefix) => {
  const dom = await dumpDom(chrome, { html, prefix, args: ["--window-size=1400,900"] });
  const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-600)); process.exit(1); }
  const R = JSON.parse(m[1]);
  if (R.error) { console.error("FAIL  페이지 예외 — " + R.error); process.exit(1); }
  return R;
};
const W_ = (p) => JSON.stringify(path.join(WEB, p));

// ───────────────────────── S · L. 공유 창
const SHARE = pack(`export * from ${W_("v2/share-session.ts")}; export { state } from ${W_("core.ts")};`, "Share");
const SHARE_PAGE = `<!doctype html><html data-theme="light"><meta charset="utf-8"><style>${css("01-base.css", "03-components.css", "42-v2-panes.css")}</style>
<button id="anchor">FACES</button><div id="toasts"></div>
<pre id="out">PENDING</pre>
<script>
  window.__posts = []; window.__notified = 1;
  window.fetch = async (url, opts) => {
    const u = String(url), method = (opts && opts.method) || 'GET';
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (/\\/api\\/ui\\/dash\\/members/.test(u)) return json({ members: [
      { id: 'me', display_name: 'ME' }, { id: 'alice', display_name: 'ALICE' }, { id: 'bob', display_name: 'BOB' }, { id: 'carol', display_name: 'CAROL' }, { id: 'boss', display_name: 'BOSS' }] });
    if (method === 'POST') { window.__posts.push({ url: u.replace(/^.*\\/api/, '/api'), body: JSON.parse((opts && opts.body) || '{}') }); return json({ ok: true, notified: window.__notified }); }
    return json({});
  };
</script>
<script>${SHARE}</script>
<script>
(async function(){
  const R = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    Share.state.me = { userId: 'me' };
    const anchor = document.getElementById('anchor');
    const left = []; window.addEventListener('lively:session-left', (e) => left.push(e.detail && e.detail.id));
    const pop = () => document.querySelector('.pn-share');
    const q = () => document.querySelector('.pn-share-in');
    const save = () => document.querySelector('.pn-share-save') || [...document.querySelectorAll('.pn-share-act .btn-primary')][0];
    const typed = async (v) => { q().value = v; q().dispatchEvent(new Event('input', { bubbles: true })); await sleep(10); };
    const enter = async (o) => { q().dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: 'Enter', bubbles: true, cancelable: true }, o || {}))); await sleep(40); };
    const chips = () => [...document.querySelectorAll('.pn-share-chip > span:not(.pn-share-face)')].map((s) => s.textContent);
    const view = () => ({ chips: chips(), q: q() ? q().value : null, posts: window.__posts.length,
      topOn: !!document.querySelector('.pn-share-row.on .pn-share-kbd'), saveKbd: !!(save() && save().querySelector('.pn-share-kbd')),
      saveText: save() ? save().textContent.replace('↵', '').trim() : null, saveOff: save() ? save().disabled : null,
      hint: (() => { const h = document.querySelector('.pn-share-hint'); return h && !h.hidden ? h.textContent : ''; })(), open: !!pop() });
    const toasts = () => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent);
    const openFor = async (s) => { document.querySelectorAll('.pn-share').forEach((p) => p.remove()); document.getElementById('toasts').replaceChildren();
      window.__posts = []; Share.openSharePopover(anchor, s); await sleep(60); };
    const mine = (invites) => ({ id: 'box-1', label: 'SESS-ONE', node: null, owned: true, owner: 'me', invites: invites.slice() });

    // S1 — 한 명
    await openFor(mine(['carol']));
    await typed('ali'); const s1a = view(); await enter(); const s1b = view(); await enter();
    R.s1 = { a: s1a, b: s1b, c: view(), post: window.__posts[0] || null, toast: toasts() };
    // S2 — 여러 명
    await openFor(mine([]));
    await typed('ali'); await enter(); await typed('bo'); await enter(); const s2a = view(); await enter();
    R.s2 = { a: s2a, posts: window.__posts.slice() };
    // S3 — 조합 중 Enter
    await openFor(mine([]));
    await typed('ali'); await enter({ isComposing: true });
    R.s3 = view();
    // S4 — 빈 칸 · 안 바뀜
    await openFor(mine(['carol']));
    const s4a = view(); await enter();
    R.s4 = { a: s4a, b: view() };
    // S5 — ⌘↵
    await openFor(mine([]));
    await enter({ metaKey: true }); const s5none = window.__posts.length;
    await typed('bo'); await enter(); await typed('zz'); await enter({ metaKey: true });
    R.s5 = { none: s5none, posts: window.__posts.slice() };
    // S6 — 빼기만
    await openFor(mine(['carol', 'bob']));
    { const x = document.querySelector('.pn-share-chip .pn-share-x'); if (x) x.click(); } await sleep(20);
    const s6a = view(); await enter();
    R.s6 = { a: s6a, posts: window.__posts.slice() };
    // S7 — 알림 0건 · 안 바뀐 저장 단추
    await openFor(mine([]));
    const s7a = view(); window.__notified = 0;
    await typed('ali'); await enter(); await enter();
    R.s7 = { a: s7a, toast: toasts() }; window.__notified = 1;

    // L1 — 초대받은 사람
    const invited = { id: 'box-9', label: 'SESS-NINE', node: null, owned: false, owner: 'boss', invites: ['me', 'alice'] };
    await openFor(invited);
    const leaveBtn = () => document.querySelector('.pn-share-leave');
    const l1 = { has: !!leaveBtn(), editor: !!q() };
    //  단추가 없으면(고치기 전) 누를 것이 없다 — 예외로 죽지 않고 그 장면이 «안 바뀜» 으로 찍히게 한다.
    const press = (b) => { if (b) b.click(); return !!b; };
    press(leaveBtn()); await sleep(60);
    const dlg = () => document.querySelector('.ov-confirm');
    l1.dlg = !!dlg(); l1.popClosed = !pop();
    press(dlg() && [...dlg().querySelectorAll('button')].find((b) => b.textContent.trim() === '취소')); await sleep(60);
    l1.afterCancel = { posts: window.__posts.length, left: left.slice() };
    await openFor(invited); press(leaveBtn()); await sleep(60);
    press(dlg() && dlg().querySelector('.btn-danger')); await sleep(80);
    l1.afterOk = { posts: window.__posts.slice(), left: left.slice() };
    R.l1 = l1;
    // L2 · L3
    await openFor(mine(['alice'])); R.l2 = !!leaveBtn();
    await openFor({ id: 'box-8', label: 'SESS-EIGHT', node: null, owned: false, owner: 'boss', invites: ['alice'] }); R.l3 = { leave: !!leaveBtn(), ro: !q() };
  } catch (e) { R.error = String(e && e.stack || e); }
  document.getElementById('out').textContent = 'RESULT' + JSON.stringify(R) + 'ENDRESULT';
})();
</script>`;
{
  const R = await run(SHARE_PAGE, "invite-share-");
  const s1 = R.s1;
  check(j(s1.a.chips) === '["CAROL"]' && s1.a.topOn === true && s1.a.saveKbd === false, "S1a 이름을 치면 ↵ 표식은 맨 위 줄에", j(s1.a));
  check(j(s1.b.chips) === '["CAROL","ALICE"]' && s1.b.q === "" && s1.b.posts === 0 && s1.b.saveKbd === true && s1.b.topOn === false
    && s1.b.saveText === "초대" && s1.b.hint.includes("↵"), "S1b ↵ — 담고 칸을 비운다 · 요청 0 · 표식이 «초대» 단추로 · 안내", j(s1.b));
  check(s1.c.posts === 1 && s1.post && s1.post.url === "/api/ui/terminal/sessions/box-1" && j(s1.post.body.invites) === '["carol","alice"]' && s1.c.open === false,
    "S1c 한 번 더 ↵ — 저장 요청 1건(명단) · 창이 닫힌다", j([s1.c, s1.post]));
  check(s1.toast.some((t) => t.includes("ALICE") && t.includes("알림을 보냈어요")), "S1d 토스트 — 누구를 초대했고 알림을 보냈다", j(s1.toast));
  check(j(R.s2.a.chips) === '["ALICE","BOB"]' && R.s2.a.posts === 0 && R.s2.posts.length === 1 && j(R.s2.posts[0].body.invites) === '["alice","bob"]',
    "S2 여러 명 — 이름 ↵ 이름 ↵ ↵ = 요청 1건에 둘", j(R.s2));
  check(j(R.s3.chips) === "[]" && R.s3.posts === 0 && R.s3.q === "ali", "S3 조합 중 ↵ — 담지 않는다", j(R.s3));
  check(R.s4.a.topOn === true && R.s4.a.saveKbd === false && R.s4.a.saveOff === true && j(R.s4.b.chips) === '["CAROL","ALICE"]' && R.s4.b.posts === 0,
    "S4 빈 칸 · 안 바뀜 — ↵ 는 맨 위 사람 담기(종전) · 저장 단추는 꺼져 있다", j(R.s4));
  check(R.s5.none === 0 && R.s5.posts.length === 1 && j(R.s5.posts[0].body.invites) === '["bob"]', "S5 ⌘↵ — 안 바뀌면 요청 0 · 글자가 있어도 바뀌었으면 저장", j(R.s5));
  check(R.s6.a.saveText === "저장" && R.s6.a.saveKbd === true && R.s6.posts.length === 1 && j(R.s6.posts[0].body.invites) === '["bob"]',
    "S6 빼기만 — «저장» · 빈 칸 ↵ 로 저장", j(R.s6));
  check(R.s7.a.saveOff === true && R.s7.toast.length > 0 && R.s7.toast.every((t) => !t.includes("알림을 보냈어요")), "S7 알림 0건이면 «알림을 보냈어요» 를 말하지 않는다", j(R.s7));
  const l1 = R.l1;
  check(l1.has && !l1.editor && l1.dlg && l1.popClosed, "L1a 초대받은 사람 — 읽기 전용 창에 [이 세션에서 나가기] · 누르면 확인 창", j(l1));
  check(l1.afterCancel.posts === 0 && l1.afterCancel.left.length === 0, "L1b 취소 — 요청 0 · 신호 0", j(l1.afterCancel));
  check(l1.afterOk.posts.length === 1 && l1.afterOk.posts[0].url === "/api/ui/terminal/sessions/box-9/leave" && j(l1.afterOk.left) === '["box-9"]',
    "L1c 나가기 — POST …/leave 1건 + session-left(그 세션)", j(l1.afterOk));
  check(R.l2 === false, "L2 만든 사람 — 나가기 단추 없음");
  check(R.l3.leave === false && R.l3.ro === true, "L3 명단 밖의 남 — 나가기 단추 없음", j(R.l3));
}

// ───────────────────────── G. 홈 사이드바 층
const SIDE = pack(`export * from ${W_("v2/side.ts")};`, "Side");
const SIDE_PAGE = `<!doctype html><html data-theme="light"><meta charset="utf-8"><style>${css("01-base.css", "40-v2.css")}
  html,body{margin:0} .v2-side{width:300px;height:800px}
</style>
<div id="v2-root"><nav class="v2-side stu-side"><div class="stu-panel"><div class="stu-panel-tree" id="host"></div></div></nav></div>
<pre id="out">PENDING</pre>
<script>window.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });</script>
<script>${SIDE}</script>
<script>
(async function(){
  const R = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const host = document.getElementById('host');
    const NOW = Date.now();
    const row = (id, title, o) => Object.assign({ id: id, title: title, active: false, icon: 'chat', meta: 'AI', project: { id: 7, name: 'PROJ-SEVEN' }, owner: null, ask: null,
      status: null, pinned: false, past: false, group: 'TODAY-GROUP', rank: 9, at: NOW }, o || {});
    //  셸(main.ts)이 정렬해 넘기는 순서 그대로: 고정 → 초대 → 지금 볼 것 → 날짜.
    const rows = [
      row('sess:pin-mine', 'PIN-MINE', { pinned: true, group: '고정' }),
      row('sess:inv-pinned', 'INV-PINNED', { pinned: true, group: '고정', invited: true, owner: { id: 'boss', name: 'BOSS' } }),
      row('sess:inv-a', 'INV-A', { invited: true, group: '초대받은 세션', owner: { id: 'boss', name: 'BOSS' } }),
      row('sess:inv-b', 'INV-B', { invited: true, group: '초대받은 세션', owner: { id: 'boss', name: 'BOSS' }, project: { id: 9, name: 'PROJ-NINE' } }),
      row('sess:now-mine', 'NOW-MINE', { group: '지금 볼 것', status: { key: 'waiting', label: 'WAIT' }, rank: 0 }),
      row('sess:day-mine', 'DAY-MINE'),
    ];
    const sessions = [{ id: 'inv-a', owned: false, raw: { owner: 'boss', invites: ['me'] } }];
    const data = { projects: [{ id: 7, name: 'PROJ-SEVEN' }, { id: 9, name: 'PROJ-NINE' }], lists: [], folders: [], loadedAt: NOW, sessions: [] };
    let invN = 2, toggled = 0;
    //  셸이 하는 대로 — 토글이 꺼지면 초대 표식 없이 제 날짜 묶음으로 넘긴다(main.ts sideInstances ①″ 은 켜졌을 때만 단다).
    const asShell = () => Side.sideInvitedUp() ? rows : rows.map((r) => r.invited && !r.pinned ? Object.assign({}, r, { invited: false, group: 'TODAY-GROUP' }) : r);
    const hooks = { section: () => 'home', instances: asShell, navHost: () => null, railHidden: () => false,
      invitedCount: () => invN, onInvitedToggle: () => { toggled++; draw(); } };
    const draw = () => Side.drawSide(host, data, () => '', hooks);
    const layout = () => [...host.querySelectorAll('.v2-app-group, .v2-app-inst[data-instance]')]
      .map((e) => e.classList.contains('v2-app-group') ? '#' + e.textContent.trim() : e.getAttribute('data-instance').slice(5));
    const inLayer = () => [...host.querySelectorAll('.v2-pg--invited .v2-app-inst[data-instance]')].map((e) => e.getAttribute('data-instance').slice(5));
    const btn = () => host.querySelector('.v2-invbtn');
    draw(); await sleep(40);
    R.g1 = { layout: layout(), layer: inLayer(), up: Side.sideInvitedUp ? Side.sideInvitedUp() : 'no-export', btn: btn() ? btn().getAttribute('aria-pressed') : null };
    //  G2 — 프로젝트로 묶기 축
    { const a = host.querySelector('.v2-axisbtn:not(.v2-invbtn)'); if (a) a.click(); } await sleep(40);
    const cards = [...host.querySelectorAll('.v2-pg:not(.v2-pg--invited) .v2-app-inst[data-instance]')].map((e) => e.getAttribute('data-instance').slice(5));
    R.g2 = { layout: layout(), layer: inLayer(), cards };
    { const a = host.querySelector('.v2-axisbtn:not(.v2-invbtn)'); if (a) a.click(); } await sleep(40);
    //  G3 — 토글
    invN = 0; draw(); await sleep(20); const none = !btn(); invN = 2; draw(); await sleep(20);
    if (btn()) btn().click(); await sleep(40);
    R.g3 = { none, toggled, up: Side.sideInvitedUp ? Side.sideInvitedUp() : 'no-export', pressed: btn() ? btn().getAttribute('aria-pressed') : null, layer: inLayer(), groups: layout().filter((x) => x[0] === '#') };
    if (btn()) btn().click(); await sleep(40); R.g3.back = Side.sideInvitedUp ? Side.sideInvitedUp() : 'no-export';
  } catch (e) { R.error = String(e && e.stack || e); }
  document.getElementById('out').textContent = 'RESULT' + JSON.stringify(R) + 'ENDRESULT';
})();
</script>`;
{
  const R = await run(SIDE_PAGE, "invite-side-");
  const L = R.g1.layout;
  const gi = (g) => L.indexOf("#" + g);
  check(gi("고정") === 0 && gi("초대받은 세션") > gi("고정") && gi("지금 볼 것") > gi("초대받은 세션")
    && L.indexOf("inv-pinned") < gi("초대받은 세션") && j(R.g1.layer) === '["inv-a","inv-b"]',
    "G1 켬 — 고정 → 초대받은 세션 → 지금 볼 것 · 초대 줄은 그 층 카드에 · 고정한 초대 줄은 「고정」", j(R.g1));
  check(j(R.g2.layer) === '["inv-a","inv-b"]' && !R.g2.cards.includes("inv-a") && !R.g2.cards.includes("inv-b")
    && R.g2.layout.indexOf("#초대받은 세션") > R.g2.layout.indexOf("#고정"),
    "G2 프로젝트로 묶기 축 — 같은 층 · 초대 줄이 프로젝트 카드에 섞이지 않는다", j(R.g2));
  check(R.g3.none === true && R.g1.btn === "true" && R.g3.toggled === 1 && R.g3.up === false && R.g3.pressed === "false"
    && R.g3.layer.length === 0 && !R.g3.groups.includes("#초대받은 세션") && R.g3.back === true,
    "G3 토글 — 초대 0 이면 단추 없음 · 눌림 · 누르면 끄고 셸에 알린다 · 끄면 층 없음 · 다시 켠다", j(R.g3));
}
done();
