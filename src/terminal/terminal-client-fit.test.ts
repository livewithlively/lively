// 2026-09-01 상민님 신고 — 웹터미널 '창에 안 꽉 차고 작은 창으로 뜬다' 회귀 테스트.
// 단독 터미널 페이지 모듈(web/standalone/terminal.ts → dist/standalone/terminal.js)을 그대로 import 해
//  브라우저 없이 사양을 검증한다(#1117 terminal-client-input.test.ts 하네스 방식의 계승 — 소스 변조 0,
//  주입은 __injectRefsForTest, ?n= 로 모듈 인스턴스 격리).
//
// 사양(엣지 표) — 축은 «fit 이 실제 레이아웃을 쟀는가» 하나다:
//   proposeDimensions()      | 서버 통지            | 근거
//   -------------------------|----------------------|-------------------------------------------------
//   {cols:113, rows:33}      | {t:'r',c:113,r:33}   | 정상 — 보이는 프레임
//   같은 값 재호출           | 없음                 | 종전 규약(불필요한 SIGWINCH 제거)
//   {cols:NaN, rows:NaN}     | **없음**             | 숨은 프레임 — 부모가 display:none 이면 FitAddon 이 NaN
//   undefined                | **없음**             | element/parent 미부착 또는 셀 크기 0
//   throw                    | **없음**             | 애드온 내부 예외(버전차) — 죽지 않고 조용히 보류
//   NaN → 이후 측정 가능     | 그때 통지            | 보이게 되는 순간 ResizeObserver 가 발화해 회복
//
// 왜 '안 보내기'가 사양인가: 못 잰 프레임의 xterm 은 **생성 기본값 80x24 그대로**다. 그 값을 통지하면 서버가
//  `refresh-client -C 80x24` 로 옮기고 tmux(window-size latest)가 그 세션의 창 전체를 80x24 로 줄인다 —
//  같은 세션을 보고 있는 창에는 좌상단 80x24 만 그려진다. 게다가 control-mode 클라는 refresh-client 로
//  '최근 활동' 클라가 되지 못해(실측 tmux 3.3a) 큰 쪽이 다시 보내도 못 되돌린다(src/terminal/tmux-exec.ts 주석).
//
// fail-first: TERMJS_MOD=<수정 전 산출 모듈 경로> 로 돌리면 F2/F3/F4 가 빨간불(80x24 통지)로 재현된다.
// 실행: npm run build && node dist/terminal/terminal-client-fit.test.js
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MOD_PATH = process.env.TERMJS_MOD || path.resolve(here, "..", "standalone", "terminal.js");
const MOD_URL = pathToFileURL(MOD_PATH).href;
let seq = 0;

interface Dims { cols: number; rows: number }
interface Harness {
  mod: any;
  term: any;
  sent: string[];
  /** proposeDimensions() 가 낼 값을 바꾼다 — undefined = 못 잼, 'throw' = 예외. */
  setDims: (d: Dims | undefined | "throw") => void;
  /** {t:'r'} 페이로드만 — 크기 통지가 실제로 나갔는지. */
  resizes: () => Array<{ c: number; r: number }>;
}

async function makeCtx(initial: Dims | undefined | "throw"): Promise<Harness> {
  const sent: string[] = [];
  const doc: any = {
    addEventListener() { /* noop */ }, removeEventListener() { /* noop */ },
    createElement: (): any => ({ style: {}, setAttribute() { /* noop */ }, addEventListener() { /* noop */ }, append() { /* noop */ }, appendChild() { /* noop */ }, remove() { /* noop */ }, focus() { /* noop */ }, select() { /* noop */ } }),
    createTextNode: (t: string): any => ({ nodeType: 3, textContent: t }),
    body: { appendChild() { /* noop */ }, removeChild() { /* noop */ }, append() { /* noop */ } },
    getElementById: () => null,
    title: "", hidden: false,
  };
  const g: any = globalThis;
  const def = (k: string, v: unknown): void => { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  def("window", g); def("self", g);
  def("document", doc);
  def("navigator", { vendor: "Google Inc.", userAgent: "Mozilla/5.0 Chrome/126", clipboard: {} });
  def("location", { search: "?session=t-termfit", pathname: "/ui/terminal.html", protocol: "https:", host: "test" });
  def("localStorage", { getItem: () => null, setItem() { /* noop */ }, removeItem() { /* noop */ } });
  def("isSecureContext", true);
  def("WebSocket", class { /* not used */ });
  def("ResizeObserver", class { observe() { /* noop */ } });
  def("BroadcastChannel", class { onmessage = null; });
  def("matchMedia", () => ({ matches: false }));
  def("requestAnimationFrame", (f: () => void) => setTimeout(f, 0));
  def("TERMJS_BUILD", "test");

  const mod: any = await import(`${MOD_URL}?n=${++seq}`);

  // xterm 스텁 — 생성 기본값 80x24 에서 시작한다(실물과 같다: fit 이 성립해야만 그 값이 바뀐다).
  const term: any = { cols: 80, rows: 24, options: {}, buffer: { active: { type: "normal" } }, refresh() { /* noop */ }, write() { /* noop */ }, focus() { /* noop */ } };
  let dims: Dims | undefined | "throw" = initial;
  // FitAddon 스텁 — 실물 계약 그대로: 못 재면 proposeDimensions 가 NaN/undefined 를 내고 fit() 은 **아무것도 안 한다**.
  const fit: any = {
    proposeDimensions: () => { if (dims === "throw") throw new Error("addon internals changed"); return dims; },
    fit: () => { if (dims && dims !== "throw" && Number.isFinite(dims.cols) && Number.isFinite(dims.rows)) { term.cols = dims.cols; term.rows = dims.rows; } },
  };
  mod.__injectRefsForTest({
    term, fit,
    ws: { readyState: 1, send: (s: string) => sent.push(s), close() { /* noop */ } },
    statusEl: { textContent: "", className: "" },
  });
  return {
    mod, term, sent,
    setDims: (d) => { dims = d; },
    resizes: () => sent.map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter((m: any) => m && m.t === "r").map((m: any) => ({ c: m.c, r: m.r })),
  };
}

const tests: Array<[string, () => Promise<void> | void]> = [];
const t = (name: string, fn: () => Promise<void> | void): void => { tests.push([name, fn]); };

t("F1 보이는 프레임 — 잰 크기를 통지한다", async () => {
  const h = await makeCtx({ cols: 113, rows: 33 });
  h.mod.applyFit();
  assert.deepEqual(h.resizes(), [{ c: 113, r: 33 }]);
  assert.equal(h.term.cols, 113);
});

t("F1b 같은 크기 재호출은 통지하지 않는다(불필요한 SIGWINCH 억제 — 종전 규약)", async () => {
  const h = await makeCtx({ cols: 113, rows: 33 });
  h.mod.applyFit(); h.mod.applyFit(); h.mod.applyFit();
  assert.deepEqual(h.resizes(), [{ c: 113, r: 33 }]);
});

t("F2 숨은 프레임(NaN) — 기본값 80x24 를 통지하지 않는다", async () => {
  const h = await makeCtx({ cols: NaN, rows: NaN });
  h.mod.applyFit();
  assert.deepEqual(h.resizes(), [], "못 잰 크기가 서버로 새면 tmux 창이 80x24 로 줄어 남의 화면을 깬다");
  assert.equal(h.term.cols, 80, "fit 이 성립하지 않았으니 터미널은 생성 기본값 그대로");
});

t("F3 element/parent 미부착(undefined) — 통지하지 않는다", async () => {
  const h = await makeCtx(undefined);
  h.mod.applyFit();
  assert.deepEqual(h.resizes(), []);
});

t("F4 애드온이 예외를 던져도 죽지 않고 통지도 하지 않는다", async () => {
  const h = await makeCtx("throw");
  h.mod.applyFit();
  assert.deepEqual(h.resizes(), []);
});

t("F5 못 재던 프레임이 보이게 되면 그때 통지한다(ResizeObserver 회복 경로)", async () => {
  const h = await makeCtx({ cols: NaN, rows: NaN });
  h.mod.applyFit();
  assert.deepEqual(h.resizes(), [], "숨은 동안은 침묵");
  h.setDims({ cols: 113, rows: 33 });   // 탭이 활성화돼 #term-host 가 실제 크기를 얻은 순간
  h.mod.applyFit();
  assert.deepEqual(h.resizes(), [{ c: 113, r: 33 }]);
});

t("F6 fitMeasured 판정표(순수)", async () => {
  const { fitMeasured } = await makeCtx({ cols: 1, rows: 1 }).then((h) => h.mod);
  assert.equal(fitMeasured({ cols: 113, rows: 33 }), true);
  assert.equal(fitMeasured({ cols: NaN, rows: 33 }), false);
  assert.equal(fitMeasured({ cols: 113, rows: NaN }), false);
  assert.equal(fitMeasured({ cols: 0, rows: 33 }), false, "0열은 잰 게 아니다");
  assert.equal(fitMeasured({ cols: 113, rows: 0 }), false);
  assert.equal(fitMeasured(undefined), false);
  assert.equal(fitMeasured(null), false);
});

async function main(): Promise<void> {
  let pass = 0; const fails: Array<[string, unknown]> = [];
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log(`ok  ${name}`); }
    catch (e) { fails.push([name, e]); console.error(`FAIL ${name}\n  ${(e as Error)?.message}`); }
  }
  console.log(`\n${pass}/${tests.length} pass${fails.length ? ` · ${fails.length} FAIL` : ""}`);
  if (fails.length) process.exit(1);
}
void main();
