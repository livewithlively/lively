// 셸 개인화 동기(#3887) — 무엇을 보내고, 응답에서 무엇을 받아 얹나. 값(순수)과 실제 모듈 배선으로 고정한다.
//  사양·엣지 표: 스크래치패드 spec.md — E22~E41 · 개정 r2(적대검토 반영). 서버 쪽 병합·순서·409 는
//  src/v6/shell-pref-store.pg-test.mjs, 정규화(상한·형식)는 src/v6/shell-prefs.test.ts 가 맡는다.
//
//  무엇이 문제였나:
//   · 가득 찬 저장소에서 방금 누른 × 가 서버에서 버려지고, 다음 부팅의 동기가 캐시를 서버판으로 덮어 사라졌다.
//   · 화면은 저장할 때마다 문서 전체를 보냈다 — 낡은 캐시를 든 창의 접힘 저장 하나가 다른 기기의 고정·치움을 통째로 덮었다.
//  적대검토(r2)가 짚은 것: 남의 저장소를 응답에서 당겨 얹으면, 조회 실패 창·옛 번들의 통째 교체 한 번이 새 화면에 **영구
//   채택**된다. 그래서 얹는 것은 «보낸 저장소의 서버 정규화 결과» 뿐이고, 조회가 실패해도 통째 교체를 보내지 않는다.
//
//  H 절은 **빌드된 실제 shell-prefs.js** 를 임시 폴더에 옮기고 core.js(api·wsKey·currentWorkspace)만 가짜로 바꿔 끼워
//   돌린다. 시계도 가짜다(디바운스 400ms · 저장 타임아웃 15초 · 재시도 5초) — 기다리지 않고 결정적으로 잰다.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };
//  배선 검사는 **코드에서만** 센다 — 주석 인용에 속지 않게(지식 change-request-deploy-set-dev-main-managed «주석 잔류는 구조다»).
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => { const i = l.indexOf("//"); return i >= 0 ? l.slice(0, i) : l; }).join("\n");
const J = (v) => JSON.stringify(v);

const { canonOf, planPush, adoptResponse, isPrefsResponse, retryDelay } = await import(join(root, "public/app/v2/shell-prefs-sync.js"));

// ── P — 순수 판정 ──────────────────────────────────────────────────────────────
{
  ok(canonOf("list", []) === "" && canonOf("map", {}) === "" && canonOf("str", "") === "" && canonOf("list", null) === "",
    "P0 빈 저장소는 «없음» 과 같은 비교값('')이다 — 비움과 없음을 다르게 치면 매 저장마다 헛 patch 가 나간다");
  const base = { a: '["x"]', b: '["y"]', c: "" };
  ok(J(planPush({ a: '["x","z"]', b: '["y"]', c: "" }, base)) === '["a"]', "E22 기준판과 다른 저장소 하나만 싣는다");
  ok(J(planPush({ a: '["x"]', b: '["y"]', c: "" }, base)) === "[]", "E23 바뀐 것이 없으면 실을 것이 없다");
  ok(J(planPush({ a: "", b: '["y"]', c: "" }, base)) === '["a"]', "E25 비운 저장소도 바뀐 것이다");

  ok(isPrefsResponse({ prefs: {}, saved: true }) && isPrefsResponse({ prefs: { a: ["x"] }, saved: false }), "E33 정상 조회 응답을 믿는다");
  ok(![null, undefined, "x", {}, { prefs: {} }, { prefs: [], saved: true }, { prefs: null, saved: true }, { saved: true }].some(isPrefsResponse),
    "★E33 모양이 틀린 응답(2xx 인데 JSON 아님 → null 등)을 «이력 없음» 으로 믿지 않는다 — 믿으면 이 창의 낡은 정리가 이관으로 올라간다");

  const sent = { a: '["x","z"]' };
  const r26 = adoptResponse({ base, sent, all: { ...base, ...sent }, cacheNow: { ...base, ...sent }, server: { a: '["z"]', b: '["y"]', c: "" } });
  ok(J(r26.adopt) === '["a"]' && r26.base.a === '["z"]', "E26 보낸 뒤 캐시가 그대로면 서버가 남긴 값(버린 뒤)을 얹는다");
  const r27 = adoptResponse({ base, sent, all: { ...base, ...sent }, cacheNow: { ...base, a: '["x","z","w"]' }, server: { a: '["x","z"]', b: '["y"]', c: "" } });
  ok(r27.adopt.length === 0 && r27.base.a === '["x","z"]', "★E27 보낸 뒤 캐시가 바뀌었으면 얹지 않고(방금 한 일을 되돌리지 않는다) 기준판만 서버 값으로");
  const r28 = adoptResponse({ base, sent, all: { ...base, ...sent }, cacheNow: { ...base, ...sent }, server: { a: '["x","z"]', b: '["old-week"]', c: "" } });
  ok(r28.adopt.length === 0 && r28.base.b === '["y"]',
    "★E28′ 안 보낸 저장소는 서버 값이 달라도 **얹지도 기준판을 옮기지도 않는다** — 낡은 통째 교체(조회 실패 창·옛 번들)를 새 결정과 가를 수 없다");
  const r34 = adoptResponse({ base, sent, all: { ...base, ...sent }, cacheNow: { ...base, ...sent }, server: null });
  ok(r34.adopt.length === 0 && J(r34.base) === J({ ...base, ...sent }), "E34 병합 표식이 없으면(옛 서버의 통째 교체) 기준판 = 보낼 때 캐시 전부 · 얹는 것 없음");
  ok(retryDelay(0) === 5000 && retryDelay(1) === 20000 && retryDelay(2) === 60000 && retryDelay(3) === null, "E35 재시도 5초·20초·60초 뒤 멈춘다(다음 조작이 다시 보낸다)");
}

// ── H — 빌드된 실제 모듈 · 가짜 core.js · 가짜 시계 ──────────────────────────────
const realSetImmediate = setImmediate;
const timers = new Map();
let clock = 0, tid = 0;
globalThis.setTimeout = (fn, ms) => { const id = ++tid; timers.set(id, { fn, at: clock + (ms || 0) }); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => realSetImmediate(r)); };
async function advance(ms) {
  const target = clock + ms;
  for (;;) {
    let due = null;
    for (const [id, t] of timers) if (t.at <= target && (!due || t.at < due.t.at)) due = { id, t };
    if (!due) break;
    timers.delete(due.id);
    clock = due.t.at;
    due.t.fn();
    await flush();
  }
  clock = target;
  await flush();
}

const tmp = mkdtempSync(join(tmpdir(), "shell-prefs-sync-"));
mkdirSync(join(tmp, "v2"));
copyFileSync(join(root, "public/app/v2/shell-prefs.js"), join(tmp, "v2/shell-prefs.js"));
copyFileSync(join(root, "public/app/v2/shell-prefs-sync.js"), join(tmp, "v2/shell-prefs-sync.js"));
writeFileSync(join(tmp, "core.js"), `
export const currentWorkspace = () => globalThis.__ws || '';
export const wsKey = (b) => b + ':ws1';
export function api(url, opts) { return globalThis.__api(url, opts); }
`);

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
};

let seq = 0;
/**
 * 모듈을 새로 띄운다(판마다 새 상태). get = 부팅 조회가 돌려줄 것('fail' 이면 실패) · seed = 부팅 전 캐시.
 *  POST 는 posts 에 쌓이고 respond(i, 응답) 로 끝낸다. 요청의 signal 이 끊기면 그 요청은 실패로 끝난다.
 */
async function boot({ get, seed = {} }) {
  mem.clear();
  timers.clear();
  globalThis.__ws = "";
  const posts = [];
  globalThis.__api = (url, opts) => {
    const method = (opts && opts.method) || "GET";
    if (method === "GET") return get === "fail" ? Promise.reject(new Error("502")) : Promise.resolve(get);
    return new Promise((resolve, reject) => {
      const rec = { body: JSON.parse(opts.body), signal: opts.signal, resolve, reject };
      if (opts.signal) opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
      posts.push(rec);
    });
  };
  const m = await import(pathToFileURL(join(tmp, "v2/shell-prefs.js")).href + `?n=${++seq}`);
  const A = m.shellPrefStore("a", "list");
  const B = m.shellPrefStore("b", "list");
  for (const [k, v] of Object.entries(seed)) localStorage.setItem(k === "a" ? A : B, JSON.stringify(v));
  let adopted = 0;
  m.onShellPrefsAdopted(() => { adopted++; });
  await m.shellPrefsSync();
  await flush();
  const push = async () => { m.shellPrefsPush(); await advance(400); };
  const respond = async (i, res) => { posts[i].resolve(res); await flush(); };
  return { m, A, B, posts, push, respond, adopted: () => adopted };
}
const setList = (k, v) => { if (v.length) localStorage.setItem(k, J(v)); else localStorage.removeItem(k); };
const getRaw = (k) => localStorage.getItem(k);
const merged = (prefs, extra = {}) => ({ prefs, saved: true, merged: true, ...extra });

try {
  // E22·E23·E25 — 바뀐 저장소만 patch · 통째(prefs)도 함께 · 끊을 수 있는 요청
  {
    const h = await boot({ get: { saved: true, prefs: { a: ["x"], b: ["y"] } } });
    setList(h.A, ["x", "z"]);
    await h.push();
    ok(h.posts.length === 1, `H-E22 저장 요청이 한 번 나간다(${h.posts.length})`);
    ok(J(h.posts[0].body.patch) === J({ a: ["x", "z"] }), `★H-E22 patch 에 바뀐 저장소만 실린다 — ${J(h.posts[0].body.patch)}`);
    ok(J(h.posts[0].body.prefs) === J({ a: ["x", "z"], b: ["y"] }),
      "★H-E22 통째(prefs)도 함께 실린다 — patch 만 가면 옛 서버가 prefs 없는 요청을 «빈 문서로 교체» 로 읽어 계정의 정리를 지운다");
    ok(h.posts[0].signal && typeof h.posts[0].signal.aborted === "boolean", "H-E35 저장 요청은 끊을 수 있다(signal) — 멈춘 요청 하나가 이 창의 저장을 영영 막지 않게");
    await h.respond(0, merged({ a: ["x", "z"], b: ["y"] }));
    await h.push();
    ok(h.posts.length === 1, `H-E23 서버와 같으면 저장 요청을 안 보낸다(${h.posts.length})`);
    setList(h.A, []);
    await h.push();
    ok(h.posts[1] && J(h.posts[1].body.patch) === J({ a: null }), `H-E25 비운 저장소는 patch 에 null 로 실린다 — ${J(h.posts[1] && h.posts[1].body.patch)}`);
    await h.respond(1, merged({ b: ["y"] }));
  }

  // ★E32·E33 — 부팅 조회가 실패하거나 모양이 틀려도 통째 교체를 안 보낸다: 로드 뒤 바뀐 저장소만
  for (const [label, get] of [["E32 조회 실패", "fail"], ["E33 2xx 인데 JSON 아님(null)", null]]) {
    const h = await boot({ get, seed: { a: ["last-week"], b: ["last-week"] } });
    await h.push();
    ok(h.posts.length === 0, `H-${label} — 아무것도 안 바꿨으면 보내지 않는다(지난주 캐시로 서버를 덮지 않는다)(${h.posts.length})`);
    setList(h.B, ["last-week", "now"]);
    await h.push();
    ok(h.posts.length === 1 && J(h.posts[0].body.patch) === J({ b: ["last-week", "now"] }),
      `★H-${label} — 로드 뒤 바뀐 저장소(b)만 patch 로 싣는다(a 는 안 싣는다) — ${J(h.posts[0] && h.posts[0].body.patch)}`);
    ok(h.posts.every((p) => p.body.patch && typeof p.body.patch === "object"), `H-${label} — patch 없는 통째 교체는 한 번도 안 나간다`);
    await h.respond(0, merged({ a: ["today-other-device"], b: ["last-week", "now"] }));
  }

  // ★E28′ — 응답에 다른 저장소의 다른 값이 와도 얹지 않고, 다음 저장이 그 저장소를 싣지도 않는다
  {
    const h = await boot({ get: { saved: true, prefs: { a: ["x"], b: ["mine-p1", "mine-p2"] } } });
    setList(h.A, ["x", "1"]);
    await h.push();
    await h.respond(0, merged({ a: ["x", "1"], b: ["stale-full-replace"] }));
    ok(getRaw(h.B) === J(["mine-p1", "mine-p2"]) && h.adopted() === 0,
      `★H-E28′ 안 보낸 저장소는 서버 값(낡은 통째 교체일 수 있다)을 얹지 않는다 — ${getRaw(h.B)} · 다시 그림 ${h.adopted()}`);
    setList(h.A, ["x", "1", "2"]);
    await h.push();
    ok(h.posts[1] && J(Object.keys(h.posts[1].body.patch)) === '["a"]', `H-E28′ 다음 저장도 바뀐 저장소만 — 기준판을 서버 값으로 옮기지 않아 b 가 «바뀐 것» 이 되지 않는다 — ${J(h.posts[1] && h.posts[1].body.patch)}`);
    await h.respond(1, merged({ a: ["x", "1", "2"], b: ["stale-full-replace"] }));
  }

  // E26 — 보낸 저장소를 서버가 버렸으면 캐시에 얹고 다시 그리라고 알린다
  {
    const h = await boot({ get: { saved: true, prefs: { a: ["old"], b: ["y"] } } });
    setList(h.A, ["old", "new"]);
    await h.push();
    await h.respond(0, merged({ a: ["new"], b: ["y"] }, { dropped: { a: { overflow: 1 } } }));
    ok(getRaw(h.A) === J(["new"]), `★H-E26 서버가 버린 뒤의 값이 캐시에 얹힌다(화면 = 저장된 것) — ${getRaw(h.A)}`);
    ok(h.adopted() === 1, `H-E26 캐시가 바뀌었으니 다시 그리라는 신호가 한 번 간다(${h.adopted()})`);
  }

  // ★E34 — 병합 표식 없는 응답(옛 서버)은 얹지 않는다 — 옛 서버의 앞-500 버림과 자동 기록이 무한 반복하지 않게
  {
    const h = await boot({ get: { saved: true, prefs: { a: ["x"], b: ["y"] } } });
    setList(h.A, ["x", "newest"]);
    await h.push();
    await h.respond(0, { prefs: { a: ["x"], b: ["y"] }, saved: true });   // 옛 서버: 방금 것을 버린 통째 교체
    ok(getRaw(h.A) === J(["x", "newest"]) && h.adopted() === 0, `★H-E34 옛 서버 응답은 얹지 않는다 — ${getRaw(h.A)} · 다시 그림 ${h.adopted()}`);
    await h.push();
    ok(h.posts.length === 1, `H-E34 기준판 = 보낼 때 캐시 전부 — 같은 것을 다시 보내지 않는다(${h.posts.length})`);
  }

  // E27·E29·E30 — 도는 중에 또 바뀌면: 동시 요청 없음 · 되돌리지 않음 · 끝난 뒤 한 번 더
  {
    const h = await boot({ get: { saved: true, prefs: { a: ["x"], b: ["y"] } } });
    setList(h.A, ["x", "1"]);
    await h.push();
    setList(h.A, ["x", "1", "2"]);
    setList(h.B, ["y", "mine"]);
    await h.push();
    ok(h.posts.length === 1, `★H-E30 저장이 도는 동안 두 번째 요청을 동시에 내지 않는다(${h.posts.length})`);
    await h.respond(0, merged({ a: ["x", "1"], b: ["y"] }));
    ok(getRaw(h.A) === J(["x", "1", "2"]), `★H-E27 그새 바뀐 캐시를 서버의 옛 값으로 되돌리지 않는다 — ${getRaw(h.A)}`);
    ok(getRaw(h.B) === J(["y", "mine"]), `★H-E29 안 보낸 저장소의 새 값도 그대로 — ${getRaw(h.B)}`);
    ok(h.posts.length === 2 && J(h.posts[1].body.patch) === J({ a: ["x", "1", "2"], b: ["y", "mine"] }),
      `H-E30 끝난 뒤 한 번 더 — 기준판과 다른 저장소를 싣는다 — ${J(h.posts[1] && h.posts[1].body.patch)}`);
    await h.respond(1, merged({ a: ["x", "1", "2"], b: ["y", "mine"] }));
  }

  // ★E35 — 응답 없이 멈춘 저장은 15초에 끊고, 5초 뒤 같은 저장소를 다시 보낸다
  {
    const h = await boot({ get: { saved: true, prefs: { a: ["x"], b: ["y"] } } });
    setList(h.A, ["x", "1"]);
    await h.push();
    await advance(14_999);
    ok(h.posts.length === 1 && !h.posts[0].signal.aborted, "H-E35 15초 전엔 끊지 않는다");
    await advance(1);
    ok(h.posts[0].signal.aborted, "★H-E35 15초에 요청을 끊는다");
    setList(h.B, ["y"]);   // 끊긴 사이 다른 조작은 없다 — 재시도만으로 다시 나가야 한다
    await advance(4_999);
    ok(h.posts.length === 1, `H-E35 재시도는 5초를 기다린다(${h.posts.length})`);
    await advance(1);
    ok(h.posts.length === 2 && J(h.posts[1].body.patch) === J({ a: ["x", "1"] }),
      `★H-E35 5초 뒤 같은 저장소를 다시 보낸다(끊겨도 이 창의 저장이 멈추지 않는다) — ${J(h.posts[1] && h.posts[1].body.patch)}`);
    await h.respond(1, merged({ a: ["x", "1"], b: ["y"] }));
  }

  // ★E35b — 재시도 예산은 결정마다 — 긴 장애로 다 쓴 뒤의 새 결정도 제 몫의 재시도를 받는다
  {
    const h = await boot({ get: { saved: true, prefs: { a: ["x"], b: ["y"] } } });
    const fail = (i) => h.posts[i].reject(new Error("503"));
    setList(h.A, ["x", "1"]);
    await h.push();
    fail(0); await flush();
    for (const [i, wait] of [[1, 5_000], [2, 20_000], [3, 60_000]]) { await advance(wait); fail(i); await flush(); }
    await advance(120_000);
    ok(h.posts.length === 4, `H-E35b 한 결정의 재시도는 세 번에서 멈춘다(${h.posts.length})`);
    setList(h.B, ["y", "later"]);   // 장애가 길어진 뒤의 새 결정
    await h.push();
    ok(h.posts.length === 5, `H-E35b 새 결정의 저장이 나간다(${h.posts.length})`);
    fail(4); await flush();
    await advance(5_000);
    ok(h.posts.length === 6 && J(h.posts[5].body.patch) === J({ a: ["x", "1"], b: ["y", "later"] }),
      `★H-E35b 예산을 다 쓴 뒤의 새 결정도 5초 뒤 다시 보낸다 — 안 그러면 복구된 뒤에도 안 올라가고 새로 고치면 사라진다 — ${J(h.posts[5] && h.posts[5].body.patch)}`);
    await h.respond(5, merged({ a: ["x", "1"], b: ["y", "later"] }));
  }

  // ★E38 — 다른 탭이 워크스페이스를 바꿨으면 보내지 않는다(캐시 키는 로드 때 워크스페이스, 요청은 지금 워크스페이스)
  {
    const h = await boot({ get: { saved: true, prefs: { a: ["x"], b: ["y"] } } });
    globalThis.__ws = "other";
    setList(h.A, ["x", "1"]);
    await h.push();
    ok(h.posts.length === 0, `★H-E38 워크스페이스가 로드 때와 다르면 저장 요청 0 — 남의 워크스페이스 행에 쓰지 않는다(${h.posts.length})`);
  }

  // H-M — 서버에 이력이 없으면 이 창의 정리를 patch 로 1회 이관(통째 교체 아님)
  {
    const h = await boot({ get: { saved: false, prefs: {} }, seed: { a: ["local"] } });
    await flush();
    ok(h.posts.length === 1 && J(h.posts[0].body.patch) === J({ a: ["local"] }) && J(h.posts[0].body.prefs) === J({ a: ["local"] }),
      `H-M 이력 없는 계정은 비지 않은 저장소를 patch 로 한 번 옮긴다 — ${J(h.posts[0] && h.posts[0].body)}`);
    await h.respond(0, merged({ a: ["local"] }));
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
  const mig = /async function migrateSessionDismissals\(\): Promise<void> \{([\s\S]*?)\n\}/.exec(main);
  ok(!!mig && /await dismissSessions\([\s\S]*dismissed = withoutSessionKeys\(dismissed\);/.test(mig[1]) && !/dismissed = plan\.nextMap/.test(mig[1]),
    "★R10 옮긴 뒤엔 **지금 맵**에서 세션 키만 뺀다 — 옮기기 전 계획으로 덮으면 옮기는 동안 사람이 치운 행이 사라진다");

  const rail = code(read("web/v2/rail.ts"));
  const reload = /export function reloadRailPrefs\(\): void \{([\s\S]*?)\n\}/.exec(rail);
  ok(!!reload && /const hadSources = order\.includes\('sources'\);/.test(reload[1]) && /cleanedSrcThisLoad && !hadSources/.test(reload[1])
      && /cleanedSrcThisLoad = false;/.test(reload[1]),
    "★R9 레일 #2423 청소는 정본이 옛 기본값을 되돌린 그 한 번만 — 표식을 내리고, 이미 'sources' 가 있던 판(사람이 다시 고정)은 건드리지 않는다");
}

console.log(`\n${pass} pass`);
