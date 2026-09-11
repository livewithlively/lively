// 셸 개인화 동기(#3887) — 무엇을 보내고, 응답에서 무엇을 받아 얹나. 값(순수)과 실제 모듈 배선으로 고정한다.
//  사양·엣지 표: 스크래치패드 spec.md — E22~E31. 서버 쪽 병합·순서는 src/v6/shell-pref-store.pg-test.mjs,
//  정규화(상한·형식)는 src/v6/shell-prefs.test.ts 가 맡는다.
//
//  무엇이 문제였나:
//   · 가득 찬 저장소에서 방금 누른 × 가 서버에서 버려지고, 다음 부팅의 동기가 캐시를 서버판으로 덮어 사라졌다.
//   · 화면은 저장할 때마다 문서 전체를 보냈다 — 낡은 캐시를 든 창의 접힘 저장 하나가 다른 기기의 고정·치움을 통째로 덮었다.
//
//  H 절은 **빌드된 실제 shell-prefs.js** 를 임시 폴더에 옮기고 core.js(api·wsKey)만 가짜로 바꿔 끼워 돌린다 —
//   정규식 배선 검사가 못 보는 것(무엇이 실제로 요청에 실렸나 · 응답 뒤 캐시에 무엇이 남았나)을 부작용으로 본다.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };
//  «있어야 할 것» 을 코드에서만 센다 — 주석 인용에 속지 않게(지식 change-request-deploy-set-dev-main-managed «주석 잔류는 구조다»).
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => { const i = l.indexOf("//"); return i >= 0 ? l.slice(0, i) : l; }).join("\n");

const { canonOf, planPush, adoptResponse } = await import(join(root, "public/app/v2/shell-prefs-sync.js"));

// ── P — 순수 판정 ──────────────────────────────────────────────────────────────
{
  ok(canonOf("list", []) === "" && canonOf("map", {}) === "" && canonOf("str", "") === "" && canonOf("list", null) === "",
    "P0 빈 저장소는 «없음» 과 같은 비교값('')이다 — 비움과 없음을 다르게 치면 매 저장마다 헛 patch 가 나간다");
  const base = { a: '["x"]', b: '["y"]', c: "" };
  ok(JSON.stringify(planPush({ a: '["x","z"]', b: '["y"]', c: "" }, base).patch) === '["a"]', "E22 기준판과 다른 저장소 하나만 patch 에 싣는다");
  ok(JSON.stringify(planPush({ a: '["x"]', b: '["y"]', c: "" }, base).patch) === "[]", "E23 바뀐 것이 없으면 실을 것이 없다");
  ok(planPush({ a: '["x"]' }, null).patch === null, "E24 기준판이 없으면 patch 를 만들지 않는다(통째 교체만)");
  ok(JSON.stringify(planPush({ a: "", b: '["y"]', c: "" }, base).patch) === '["a"]', "E25 비운 저장소도 바뀐 것이다(patch 에 실린다)");

  const names = ["a", "b"];
  const r26 = adoptResponse({ names, base, sent: { a: '["x","z"]' }, cacheNow: { a: '["x","z"]', b: '["y"]' }, server: { a: '["z"]', b: '["y"]' } });
  ok(r26.adopt.includes("a") && r26.base.a === '["z"]', "E26 보낸 뒤 캐시가 그대로면 서버가 남긴 값(버린 뒤)을 얹는다");
  const r27 = adoptResponse({ names, base, sent: { a: '["x","z"]' }, cacheNow: { a: '["x","z","w"]', b: '["y"]' }, server: { a: '["x","z"]', b: '["y"]' } });
  ok(!r27.adopt.includes("a") && r27.base.a === '["x","z"]', "★E27 보낸 뒤 캐시가 바뀌었으면 얹지 않고(방금 한 일을 되돌리지 않는다) 기준판만 서버 값으로");
  const r28 = adoptResponse({ names, base, sent: { a: '["x","z"]' }, cacheNow: { a: '["x","z"]', b: '["y"]' }, server: { a: '["x","z"]', b: '["y","q"]' } });
  ok(r28.adopt.includes("b") && r28.base.b === '["y","q"]', "E28 안 보낸 저장소를 다른 기기가 바꿨고 이 창 캐시가 기준판 그대로면 당겨 온다");
  const r29 = adoptResponse({ names, base, sent: { a: '["x","z"]' }, cacheNow: { a: '["x","z"]', b: '["y","mine"]' }, server: { a: '["x","z"]', b: '["y","q"]' } });
  ok(!r29.adopt.includes("b"), "★E29 안 보낸 저장소라도 그새 이 창에서 바뀌었으면 얹지 않는다");
  const r24 = adoptResponse({ names, base: null, sent: { a: '["x"]', b: "" }, cacheNow: { a: '["x"]', b: "" }, server: { a: '["x"]', b: "" } });
  ok(r24.adopt.length === 0 && r24.base.a === '["x"]' && r24.base.b === "", "E24′ 통째 교체의 응답이 기준판을 세운다(다음 저장부터 patch)");
}

// ── H — 빌드된 실제 모듈을 가짜 core.js 로 돌린다 ─────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "shell-prefs-sync-"));
mkdirSync(join(tmp, "v2"));
copyFileSync(join(root, "public/app/v2/shell-prefs.js"), join(tmp, "v2/shell-prefs.js"));
copyFileSync(join(root, "public/app/v2/shell-prefs-sync.js"), join(tmp, "v2/shell-prefs-sync.js"));
writeFileSync(join(tmp, "core.js"), `
export const wsKey = (b) => b + ':ws1';
export function api(url, opts) { return globalThis.__api(url, opts); }
`);

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEBOUNCE = 460;   // shell-prefs.ts 의 400ms 디바운스 + 여유

let seq = 0;
/** 모듈을 새로 띄운다(판마다 새 상태). 요청은 calls 에 쌓이고, 응답은 respond 로 준다. */
async function boot({ server, getFails = false } = {}) {
  mem.clear();
  const calls = [];
  const pending = [];
  globalThis.__api = (url, opts) => {
    const method = (opts && opts.method) || "GET";
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, body });
    if (method === "GET") return getFails ? Promise.reject(new Error("down")) : Promise.resolve(server);
    return new Promise((resolve, reject) => pending.push({ body, resolve, reject }));
  };
  const m = await import(pathToFileURL(join(tmp, "v2/shell-prefs.js")).href + `?n=${++seq}`);
  const A = m.shellPrefStore("a", "list");
  const B = m.shellPrefStore("b", "list");
  let adopted = 0;
  m.onShellPrefsAdopted(() => { adopted++; });
  await m.shellPrefsSync();
  const posts = () => calls.filter((c) => c.method === "POST");
  return { m, A, B, posts, pending, adopted: () => adopted };
}
const setList = (k, v) => { if (v.length) localStorage.setItem(k, JSON.stringify(v)); else localStorage.removeItem(k); };
const getList = (k) => JSON.parse(localStorage.getItem(k) || "[]");

try {
  // E22 — 한 저장소만 바뀌면 그것만 patch · 통째(prefs)도 함께 실린다(옛 서버 호환)
  {
    const h = await boot({ server: { saved: true, prefs: { a: ["x"], b: ["y"] } } });
    setList(h.A, ["x", "z"]);
    h.m.shellPrefsPush();
    await sleep(DEBOUNCE);
    const p = h.posts();
    ok(p.length === 1, `H-E22 저장 요청이 한 번 나간다(${p.length})`);
    ok(JSON.stringify(p[0].body.patch) === JSON.stringify({ a: ["x", "z"] }), `★H-E22 patch 에 바뀐 저장소만 실린다 — ${JSON.stringify(p[0].body.patch)}`);
    ok(JSON.stringify(p[0].body.prefs) === JSON.stringify({ a: ["x", "z"], b: ["y"] }),
      "★H-E22 통째(prefs)도 함께 실린다 — patch 만 가면 옛 서버가 prefs 없는 요청을 «빈 문서로 교체» 로 읽어 계정의 정리를 지운다");
    h.pending[0].resolve({ prefs: { a: ["x", "z"], b: ["y"] }, saved: true });
    await sleep(10);

    // E23 — 응답이 기준판을 세웠다: 바뀐 게 없으면 보내지 않는다
    h.m.shellPrefsPush();
    await sleep(DEBOUNCE);
    ok(h.posts().length === 1, `H-E23 서버와 같으면 저장 요청을 안 보낸다(${h.posts().length})`);

    // E25 — 저장소를 비우면 patch 에 null
    setList(h.A, []);
    h.m.shellPrefsPush();
    await sleep(DEBOUNCE);
    const p2 = h.posts()[1];
    ok(p2 && p2.body.patch && p2.body.patch.a === null && !("b" in p2.body.patch), `H-E25 비운 저장소는 patch 에 null 로 실린다 — ${JSON.stringify(p2 && p2.body.patch)}`);
    h.pending[1].resolve({ prefs: { b: ["y"] }, saved: true });
    await sleep(10);
  }

  // E24 — 부팅 조회가 실패하면 patch 없이 통째만
  {
    const h = await boot({ getFails: true });
    setList(h.A, ["x"]);
    h.m.shellPrefsPush();
    await sleep(DEBOUNCE);
    const p = h.posts();
    ok(p.length === 1 && !("patch" in p[0].body) && JSON.stringify(p[0].body.prefs) === JSON.stringify({ a: ["x"] }),
      `H-E24 기준판이 없으면 patch 를 싣지 않는다(무엇이 바뀌었는지 모른다) — ${JSON.stringify(p[0] && p[0].body)}`);
    h.pending[0].resolve({ prefs: { a: ["x"] }, saved: true });
    await sleep(10);
    setList(h.B, ["q"]);
    h.m.shellPrefsPush();
    await sleep(DEBOUNCE);
    const p2 = h.posts()[1];
    ok(p2 && JSON.stringify(p2.body.patch) === JSON.stringify({ b: ["q"] }), `H-E24′ 통째 저장이 성공한 뒤부터는 바뀐 것만 patch — ${JSON.stringify(p2 && p2.body)}`);
    h.pending[1].resolve({ prefs: { a: ["x"], b: ["q"] }, saved: true });
    await sleep(10);
  }

  // E26·E28 — 응답을 캐시에 얹는다(서버가 버린 것 · 다른 기기가 바꾼 저장소) + 다시 그림 신호
  {
    const h = await boot({ server: { saved: true, prefs: { a: ["old"], b: ["y"] } } });
    setList(h.A, ["old", "new"]);
    h.m.shellPrefsPush();
    await sleep(DEBOUNCE);
    h.pending[0].resolve({ prefs: { a: ["new"], b: ["y", "other-device"] }, saved: true, dropped: { a: { overflow: 1 } } });
    await sleep(10);
    ok(JSON.stringify(getList(h.A)) === '["new"]', `★H-E26 서버가 버린 뒤의 값이 캐시에 얹힌다(화면 = 저장된 것) — ${localStorage.getItem(h.A)}`);
    ok(JSON.stringify(getList(h.B)) === '["y","other-device"]', `H-E28 다른 기기가 바꾼 저장소를 당겨 온다 — ${localStorage.getItem(h.B)}`);
    ok(h.adopted() === 1, `H-E26 캐시가 바뀌었으니 다시 그리라는 신호가 한 번 간다(${h.adopted()})`);
  }

  // E27·E29·E30 — 도는 중에 또 바뀌면: 동시 요청 없음 · 얹지 않음 · 끝난 뒤 한 번 더
  {
    const h = await boot({ server: { saved: true, prefs: { a: ["x"], b: ["y"] } } });
    setList(h.A, ["x", "1"]);
    h.m.shellPrefsPush();
    await sleep(DEBOUNCE);
    ok(h.posts().length === 1, "H-E30 첫 저장이 나갔다");
    setList(h.A, ["x", "1", "2"]);   // 도는 중 — 같은 저장소가 또 바뀜
    setList(h.B, ["y", "mine"]);     // 도는 중 — 안 보낸 저장소도 바뀜
    h.m.shellPrefsPush();
    await sleep(DEBOUNCE);
    ok(h.posts().length === 1, `★H-E30 저장이 도는 동안 두 번째 요청을 동시에 내지 않는다(${h.posts().length})`);
    h.pending[0].resolve({ prefs: { a: ["x", "1"], b: ["y", "server"] }, saved: true });
    await sleep(20);
    ok(JSON.stringify(getList(h.A)) === '["x","1","2"]', `★H-E27 그새 바뀐 캐시를 서버의 옛 값으로 되돌리지 않는다 — ${localStorage.getItem(h.A)}`);
    ok(JSON.stringify(getList(h.B)) === '["y","mine"]', `★H-E29 안 보낸 저장소도 그새 바뀌었으면 서버 값으로 덮지 않는다 — ${localStorage.getItem(h.B)}`);
    const p = h.posts();
    ok(p.length === 2, `H-E30 끝난 뒤 한 번 더 보낸다(${p.length})`);
    ok(p[1] && JSON.stringify(p[1].body.patch) === JSON.stringify({ a: ["x", "1", "2"], b: ["y", "mine"] }),
      `H-E30 두 번째 저장은 응답 뒤의 기준판과 다른 저장소를 싣는다 — ${JSON.stringify(p[1] && p[1].body.patch)}`);
    h.pending[1].resolve({ prefs: { a: ["x", "1", "2"], b: ["y", "mine"] }, saved: true });
    await sleep(10);
  }

  // 부팅 전 · 1회 이관 — 서버에 이력이 없고 이 창에 정리가 있으면 통째로 올린다(종전 동작 보존)
  {
    mem.clear();
    const calls = [];
    const pending = [];
    globalThis.__api = (url, opts) => {
      const method = (opts && opts.method) || "GET";
      calls.push({ method, body: opts && opts.body ? JSON.parse(opts.body) : null });
      if (method === "GET") return Promise.resolve({ saved: false, prefs: {} });
      return new Promise((resolve) => pending.push({ resolve }));
    };
    const m = await import(pathToFileURL(join(tmp, "v2/shell-prefs.js")).href + `?n=${++seq}`);
    const A = m.shellPrefStore("a", "list");
    m.shellPrefStore("b", "list");
    localStorage.setItem(A, JSON.stringify(["local"]));
    await m.shellPrefsSync();
    await sleep(10);
    const p = calls.filter((c) => c.method === "POST");
    ok(p.length === 1 && !("patch" in p[0].body) && JSON.stringify(p[0].body.prefs) === '{"a":["local"]}',
      `H-M 서버에 이력이 없으면 이 창의 정리를 통째로 1회 이관한다 — ${JSON.stringify(p[0] && p[0].body)}`);
    pending[0].resolve({ prefs: { a: ["local"] }, saved: true });
    await sleep(10);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── W — 셸 배선 ────────────────────────────────────────────────────────────────
{
  const main = code(read("web/v2/main.ts"));
  const hook = /const reloadShellPrefs = \(\): void => \{([\s\S]*?)\n  \};/.exec(main);
  ok(!!hook && /readDismissed\(\)/.test(hook[1]) && /reloadSidePrefs\(\)/.test(hook[1]) && /reloadRailPrefs\(\)/.test(hook[1]) && /drawSide\(\)/.test(hook[1]),
    "W1 저장소를 다시 읽는 한 자리(reloadShellPrefs)가 치움·사이드바·레일을 모두 다시 읽고 그린다");
  ok(/onShellPrefsAdopted\(reloadShellPrefs\)/.test(main),
    "★W1 저장 응답으로 캐시가 바뀌면 같은 자리가 불린다 — 안 불리면 캐시만 서버 값이고 화면은 옛 모듈 상태로 그린다");
  ok(/shellPrefsSync\(\)\.then\(\(changed\) => \{ if \(changed\) reloadShellPrefs\(\); \}\)/.test(main), "W2 부팅 동기도 같은 자리를 부른다");
  const close = /async function closeSideRow\(key: string\): Promise<void> \{([\s\S]*?)\n\}/.exec(main);
  ok(!!close && /delete dismissed\[key\];\s*dismissed\[key\] = /.test(close[1]),
    "★E31 이미 치운 키를 다시 치우면 지우고 적는다(맨 뒤로) — 제자리 덮어쓰기면 방금 치운 행이 옛 자리에 남아 넘칠 때 먼저 버려진다");
}

console.log(`\n${pass} pass`);
