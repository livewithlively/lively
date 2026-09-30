// #3870 「분류체계」 재료 캐시(web/lib/tax-loader.ts) — «분류체계만 들어가면 화면 렉걸리고 제대로 로딩도 안됨»(원준 2026-09-27).
//
//  옛 loadTaxonomy 는 캐시가 신선하면 콜백을 그 자리에서 불렀고, 그릴 때마다 loadTaxonomy(() => redraw()) 를 부르는 사이드바가
//   호출 스택이 넘칠 때까지 스스로를 다시 그렸다(실측: 한 번 다시 그리기 = 1,562번 재귀).
//  L: 캐시 규칙을 값으로(가짜 시계 · 가짜 받기).  S: 배선(분류체계 앱이 이 캐시를 쓰고, 옛 «신선하면 곧바로 부르기» 가 없다).
//  ⚠ 단언을 끝까지 센다. 수정 전 규칙(신선하면 곧바로 부르기 · 실패 뒤 곧바로 다시 받기)을 변이로 넣어 빨간불을 먼저 봤다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };
const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}`); } };
const tick = () => new Promise((r) => setTimeout(r, 0));

let lib = null;
try { lib = await import(pathToFileURL(join(root, process.env.TAX_LOADER || "public/app/lib/tax-loader.js")).href); } catch { /* L0 가 빨간불 */ }
ok(!!lib && typeof lib.createCachedLoader === "function", "L0 재료 캐시가 잎 모듈(lib/tax-loader.ts)에 있다");

if (lib) {
  const { createCachedLoader } = lib;
  /** 가짜 시계 · 가짜 받기. fails 가 참이면 받기가 실패한다. */
  const rig = (staleMs = 30_000) => {
    const st = { t: 1_000_000, fetches: 0, fails: false, value: 0 };
    const L = createCachedLoader(() => { st.fetches++; return st.fails ? Promise.reject(new Error("boom")) : Promise.resolve({ v: ++st.value }); }, staleMs, () => st.t);
    return { st, L };
  };
  /** 사이드바 흉내: 그릴 때마다 load(() => redraw()). 몇 번 그렸나 · 가장 깊이 몇 겹이었나. 51겹이거나(동기 고리)
   *  모두 51번이면(비동기 고리 — 실패가 받기를 끝없이 부르는 폭주) 끊고 넘침으로 적는다. 안 끊으면 시험이 끝나지 않는다. */
  const side = (L) => {
    const s = { renders: 0, depth: 0, max: 0, overflow: false };
    const redraw = () => {
      s.renders++; s.depth++; s.max = Math.max(s.max, s.depth);
      try { if (s.depth > 50 || s.renders > 50) { s.overflow = true; return; } L.load(() => redraw()); } finally { s.depth--; }
    };
    return { s, redraw };
  };

  // L1 — 신선한 캐시: 콜백을 부르지 않고 받지도 않는다(★ 렉의 원인)
  {
    const { st, L } = rig();
    L.load(); await tick();
    ok(st.fetches === 1, "L1w (배선) 첫 load 가 받기를 실제로 불렀다");
    let called = 0;
    L.load(() => { called++; });
    ok(called === 0, "L1a 신선한 캐시면 콜백을 그 자리에서 부르지 않는다");
    await tick();
    ok(called === 0, "L1b 신선한 캐시면 나중에도 부르지 않는다");
    ok(st.fetches === 1, "L1c 신선한 캐시면 다시 받지 않는다");
  }

  // L2 — 사이드바 고리: 재료가 있을 때 한 번 다시 그리면 정확히 한 번 그린다
  {
    const { L } = rig();
    L.load(); await tick();
    const { s, redraw } = side(L);
    redraw(); await tick();
    ok(s.renders === 1 && !s.overflow, `L2 신선할 때 사이드바를 한 번 다시 그리면 한 번만 그린다 (renders=${s.renders})`);
  }

  // L3 — 첫 진입: 받기 → 도착 때 앱 화면이 사이드바를 다시 그려도 유한하게 멈춘다
  {
    const { st, L } = rig();
    const { s, redraw } = side(L);
    let appPaints = 0;
    L.load(() => { appPaints++; redraw(); });   // 앱 화면: paint + redrawSide
    redraw();                                   // 사이드바 첫 그리기
    await tick(); await tick();
    ok(st.fetches === 1, `L3a 첫 진입에 받기는 한 번 (fetches=${st.fetches})`);
    ok(appPaints === 1, "L3b 앱 화면 콜백은 도착 때 한 번");
    ok(s.renders <= 3 && !s.overflow && s.max <= 2, `L3c 도착 뒤 사이드바 그리기는 유한하고 얕다 (renders=${s.renders}, depth=${s.max})`);
  }

  // L4 — 받는 중에 온 부름은 같은 받기에 기대고, 끝날 때 한 번씩 불린다
  {
    const { st, L } = rig();
    const calls = [];
    L.load(() => calls.push("a")); L.load(() => calls.push("b")); L.load(() => calls.push("c"), true);
    ok(calls.length === 0, "L4a 받는 중에는 부르지 않는다");
    await tick();
    ok(st.fetches === 1, "L4b 받는 중 부름(force 포함)은 새 받기를 열지 않는다");
    ok(calls.join() === "a,b,c", `L4c 끝날 때 기다린 콜백을 한 번씩 (got ${calls.join()})`);
    await tick();
    ok(calls.length === 3, "L4d 두 번 부르지 않는다");
  }

  // L5 — 경계 · 오래됨 · force
  {
    const { st, L } = rig(30_000);
    L.load(); await tick();
    let n = 0;
    st.t += 29_999;
    L.load(() => n++); await tick();
    ok(st.fetches === 1 && n === 0, "L5a 경계: 29.999초면 아직 신선하다");
    st.t += 2;
    L.load(() => n++); await tick();
    ok(st.fetches === 2 && n === 1, "L5b 30초가 지나면 다시 받고 도착 때 부른다");
    ok(L.data() && L.data().v === 2, "L5c 새 재료로 바뀐다");
    L.load(() => n++, true); await tick();
    ok(st.fetches === 3 && n === 2, "L5d force 면 신선해도 받는다(고친 뒤 다시 읽기)");
  }

  // L6 — 실패: 까닭을 남기고, 앞 재료를 지키고, staleMs 동안 다시 묻지 않는다(도착 콜백 → 다시 load 의 요청 폭주 방지)
  {
    const { st, L } = rig();
    st.fails = true;
    const { s, redraw } = side(L);
    redraw(); await tick(); await tick(); await tick();
    ok(L.error() === "boom", "L6a 실패 까닭을 남긴다");
    ok(L.data() === null, "L6b 한 번도 못 받았으면 재료는 null");
    ok(st.fetches === 1, `L6c 실패 뒤 사이드바가 다시 그려도 다시 받지 않는다 (fetches=${st.fetches})`);
    ok(s.renders === 2 && !s.overflow, `L6d 실패 도착 때 한 번만 다시 그린다 (renders=${s.renders})`);
    st.t += 30_001; st.fails = false;
    L.load(); await tick();
    ok(st.fetches === 2 && L.error() === "" && L.data() && L.data().v === 1, "L6e 시간이 지나 성공하면 까닭을 지운다");
    st.fails = true;
    L.load(undefined, true); await tick();
    ok(L.data() && L.data().v === 1 && L.error() === "boom", "L6f 실패해도 앞서 받은 재료는 버리지 않는다");
  }

  // L7 — 받기 함수가 동기로 던져도 멈추지 않는다 · 던지는 콜백이 다른 콜백을 막지 않는다
  {
    const L = createCachedLoader(() => { throw new Error("sync"); }, 30_000, () => 0);
    let n = 0;
    try { L.load(() => { throw new Error("x"); }); L.load(() => n++); } catch { /* 아래 단언이 잡는다 */ }
    await tick();
    ok(L.error() === "sync" && n === 1, "L7 동기 예외도 실패로 받고, 던지는 콜백 뒤의 콜백도 불린다");
  }
}

// ───────────── S. 배선 ─────────────
const tax = code(read("web/v2/taxonomy.ts"));
ok(/createCachedLoader\s*</.test(tax) && /from '\.\.\/lib\/tax-loader\.js'/.test(tax), "S1 분류체계 앱이 lib/tax-loader 캐시를 쓴다");
ok(/export function loadTaxonomy\([^)]*\)[^{]*\{\s*store\.load\(/.test(tax), "S2 loadTaxonomy 는 캐시에 맡긴다(제 규칙을 따로 두지 않는다)");
ok(!/flush\(\);\s*return;/.test(tax), "S3 옛 «신선하면 곧바로 부르기»(flush(); return;)가 없다");
const sideSrc = code(read("web/v2/side.ts"));
ok(/loadTaxonomy\(\(\) => \{[^}]*redraw\(\)/.test(sideSrc), "S4 (전제) 사이드바는 그릴 때마다 loadTaxonomy(() => redraw()) 를 부른다 — 이 전제가 바뀌면 이 시험을 다시 본다");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
