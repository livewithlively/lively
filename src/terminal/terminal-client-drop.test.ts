// #3948 — 웹터미널 끌어놓기 안내·강조가 «그 자리 위에서 끌고 있는 동안만» 보이는지 회귀 테스트.
// 신고: 세션 화면에서 파일을 끌어 터미널 위를 지나 오른쪽 자료에 놓으면, 업로드는 되는데 터미널의 «여기에 놓으세요» 가 남았다.
//  원인 — 안내를 걷는 조건이 dragleave 의 `e.target === 존` 뿐이었다. target 은 «포인터가 떠난 요소» 라서, 존을 덮은
//  xterm 자식 위에서 프레임 밖으로 나가면(relatedTarget=null) 그 조건이 영영 참이 안 됐다(헤드리스 크로미움 CDP 끌어놓기로 재현).
// 단독 터미널 페이지 모듈(web/standalone/terminal.ts → dist/standalone/terminal.js)을 그대로 import 하고, 존·자식은 가짜 노드로 세운다.
//  엣지 표: E1 파일 끌기 → 안내 · E2 존 안 자식 사이 → 유지 · E3 같은 화면의 존 밖 요소로 → 걷힘 · E4 프레임 밖(null) → 걷힘 ·
//   E5 존 자신에서 나감 → 걷힘 · E6 터미널에 놓음 → 걷힘 + 업로드 PUT · E7 dragleave 없이 끝남 → 포인터 이동에 걷힘 ·
//   E8 안내 없을 때 포인터 이동 → 무변화 · E9 판정의 빈 값(null·undefined) → 나감 · E10 경계(rel = 존 자신) → 유지 ·
//   E11 파일 아닌 끌기 → 안 뜸 · X1~X3 파일 탐색기 강조(.drag)도 같은 규칙 · F1 새 셸 파일 앱(web/v2/files.ts) 배선.
// fail-first: TERMJS_MOD=<판정을 `e.target === 존` 으로 되돌리고 포인터 안전망을 뺀 산출 모듈> 로 돌리면 E3·E4·E7·X1·X3 이,
//  FILES_TS=<고치기 전 web/v2/files.ts> 로 돌리면 F1 이 빨간불이다.
// 실행: npm run build && node dist/terminal/terminal-client-drop.test.js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MOD_PATH = process.env.TERMJS_MOD || path.resolve(here, "..", "standalone", "terminal.js");
const MOD_URL = pathToFileURL(MOD_PATH).href;
const FILES_TS = process.env.FILES_TS || path.resolve(here, "..", "..", "web", "v2", "files.ts");
let seq = 0;

type Listener = (ev: any) => void;

// 가짜 DOM 노드 — 모듈이 쓰는 만큼만: el() 의 className·textContent·setAttribute·append, 안내의 remove,
//  판정의 contains, 강조의 classList·style, 리스너 배선.
class FakeNode {
  tag: string;
  nodeType = 1;
  className = "";
  textContent = "";
  parent: FakeNode | null = null;
  children: any[] = [];
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  cls = new Set<string>();
  ls = new Map<string, Listener[]>();
  classList = {
    add: (c: string): void => { this.cls.add(c); },
    remove: (c: string): void => { this.cls.delete(c); },
    contains: (c: string): boolean => this.cls.has(c),
  };
  constructor(tag: string) { this.tag = tag; }
  setAttribute(k: string, v: unknown): void { this.attrs[k] = String(v); }
  addEventListener(type: string, fn: Listener): void { const a = this.ls.get(type) || []; a.push(fn); this.ls.set(type, a); }
  fire(type: string, ev: any): void { for (const fn of [...(this.ls.get(type) || [])]) fn(ev); }
  append(...nodes: any[]): void {
    for (const n of nodes) {
      if (n && n.parent) n.parent.removeChild(n);
      if (n && typeof n === "object") n.parent = this;
      this.children.push(n);
    }
  }
  removeChild(n: any): void { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parent = null; }
  remove(): void { if (this.parent) this.parent.removeChild(this); }
  contains(n: any): boolean { for (let c = n; c; c = c.parent) if (c === this) return true; return false; }
}

interface Harness {
  mod: any;
  zone: FakeNode;        // 터미널 존(#panes)
  canvas: FakeNode;      // 존을 덮은 xterm 캔버스(자식)
  scrollbar: FakeNode;   // 존 안의 다른 자식(xterm 스크롤 영역)
  explorer: FakeNode;    // 같은 문서의 존 밖 요소 = 파일 탐색기 존
  rowA: FakeNode;        // 탐색기 목록 줄
  rowB: FakeNode;
  fetched: string[];     // 나간 요청 «메서드 URL» — 드롭이 업로드 경로를 탔는지
  fireWindow: (type: string, ev?: any) => void;
}

async function makeCtx(): Promise<Harness> {
  const g: any = globalThis;
  const def = (k: string, v: unknown): void => { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  const winL = new Map<string, Listener[]>();
  const fetched: string[] = [];
  def("window", g); def("self", g);
  def("addEventListener", (type: string, fn: Listener) => { const a = winL.get(type) || []; a.push(fn); winL.set(type, a); });
  def("removeEventListener", (type: string, fn: Listener) => { const a = winL.get(type) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); });
  def("document", {
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text, parent: null }),
    body: new FakeNode("body"),
    getElementById: () => null,
    addEventListener() { /* noop */ }, removeEventListener() { /* noop */ },
    title: "", hidden: false,
  });
  def("navigator", { platform: "Win32", vendor: "Google Inc.", userAgent: "Mozilla/5.0 Chrome/126", userActivation: { isActive: false }, clipboard: {} });
  def("location", { search: "?session=t-3948", pathname: "/ui/terminal.html", protocol: "https:", host: "test" });
  def("localStorage", { getItem: () => null, setItem() { /* noop */ }, removeItem() { /* noop */ } });
  def("isSecureContext", true);
  def("WebSocket", class { /* not used */ });
  def("ResizeObserver", class { observe() { /* noop */ } });
  def("BroadcastChannel", class { onmessage = null; });
  def("matchMedia", () => ({ matches: false }));
  def("requestAnimationFrame", (f: () => void) => setTimeout(f, 0));
  def("TERMJS_BUILD", "test");
  // 목록 조회(겹치는 이름 확인)는 빈 폴더로 답하고, 업로드(PUT)는 끝나지 않게 둔다 — 업로드 요청이 «나갔는지» 까지만 본다
  //  (그 뒤 경로를 입력창에 넣는 단계는 이 테스트 범위 밖).
  def("fetch", (url: unknown, opts?: any) => {
    const method = String((opts && opts.method) || "GET").toUpperCase();
    fetched.push(`${method} ${String(url)}`);
    if (method === "GET") return Promise.resolve({ ok: true, status: 200, json: async () => ({ items: [] }) });
    return new Promise(() => { /* pending */ });
  });

  const mod: any = await import(`${MOD_URL}?n=${++seq}`);
  const zone = new FakeNode("div");
  const canvas = new FakeNode("canvas");
  const scrollbar = new FakeNode("div");
  zone.append(canvas, scrollbar);
  const explorer = new FakeNode("aside");
  const rowA = new FakeNode("div");
  const rowB = new FakeNode("div");
  explorer.append(rowA, rowB);
  mod.__injectRefsForTest({ panesEl: zone, explorerEl: explorer });
  return {
    mod, zone, canvas, scrollbar, explorer, rowA, rowB, fetched,
    fireWindow: (type: string, ev?: any) => { for (const fn of [...(winL.get(type) || [])]) fn(ev || {}); },
  };
}

// 끌기 이벤트 — 존 리스너에 곧장 쏜다(실제로는 target 자식에서 존까지 버블링되어 오는 것과 같은 모양).
const drag = (over: Record<string, unknown>): any => {
  const e: any = { defaultPrevented: false, target: null, relatedTarget: null, dataTransfer: { types: ["Files"], files: [] }, ...over };
  e.preventDefault = (): void => { e.defaultPrevented = true; };
  return e;
};
const notes = (zone: FakeNode): any[] => zone.children.filter((c: any) => c && c.className === "drop-note");
// 안내를 띄운 뒤 «정말 떴는지» 부터 확인한다 — 안 뜬 채로 «걷혔다» 를 단언하면 아무것도 안 본 테스트가 된다.
const showNote = (h: Harness): void => {
  h.zone.fire("dragover", drag({ target: h.canvas }));
  assert.equal(notes(h.zone).length, 1, "전제: 안내가 떠 있어야 한다");
};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

// ── 미니 async 러너 ──
const tests: Array<[string, () => Promise<void> | void]> = [];
const t = (name: string, fn: () => Promise<void> | void): void => { tests.push([name, fn]); };

// 판정(dragLeftZone)
t("E9 판정의 빈 값 — 새로 들어간 요소가 null·undefined 면 «나갔다»", async () => {
  const h = await makeCtx();
  assert.equal(h.mod.dragLeftZone(h.zone, null), true);
  assert.equal(h.mod.dragLeftZone(h.zone, undefined), true);
});
t("E10 판정 — 새로 들어간 요소가 존 자신이면 «존 안»", async () => {
  const h = await makeCtx();
  assert.equal(h.mod.dragLeftZone(h.zone, h.zone), false);
});
t("판정 — 존 안 깊은 자식은 안, 같은 문서의 존 밖 요소는 밖", async () => {
  const h = await makeCtx();
  const deep = new FakeNode("span");
  h.canvas.append(deep);
  assert.equal(h.mod.dragLeftZone(h.zone, deep), false);
  assert.equal(h.mod.dragLeftZone(h.zone, h.rowA), true);
});

// 터미널 안내(setupTermDrop)
t("E1 파일을 끌어 터미널 위에 올리면 안내가 한 장 뜨고 테두리가 켜진다(여러 번 와도 한 장)", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  const first = drag({ target: h.canvas });
  h.zone.fire("dragover", first);
  h.zone.fire("dragover", drag({ target: h.canvas }));
  h.zone.fire("dragover", drag({ target: h.scrollbar }));
  assert.equal(first.defaultPrevented, true, "드롭을 받겠다고 알려야 브라우저가 파일을 열지 않는다");
  assert.equal(notes(h.zone).length, 1);
  assert.ok(h.zone.style.outline, "테두리가 켜져야 한다");
});
t("E11 파일이 아닌 끌기(글자)는 안내를 띄우지 않고 가로채지도 않는다", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  const e = drag({ target: h.canvas, dataTransfer: { types: ["text/plain"], files: [] } });
  h.zone.fire("dragover", e);
  assert.equal(notes(h.zone).length, 0);
  assert.equal(e.defaultPrevented, false);
});
t("E2 터미널 안 자식 사이를 옮겨 다니면 안내가 그대로다", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  showNote(h);
  h.zone.fire("dragleave", drag({ target: h.canvas, relatedTarget: h.scrollbar }));
  assert.equal(notes(h.zone).length, 1);
});
t("E10 행위 — 자식에서 존의 여백으로 옮겨도 안내가 그대로다", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  showNote(h);
  h.zone.fire("dragleave", drag({ target: h.canvas, relatedTarget: h.zone }));
  assert.equal(notes(h.zone).length, 1);
});
t("E3 ★자식 위에서 같은 화면의 터미널 밖 요소로 나가면 안내와 테두리가 걷힌다", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  showNote(h);
  h.zone.fire("dragleave", drag({ target: h.canvas, relatedTarget: h.rowA }));
  assert.equal(notes(h.zone).length, 0);
  assert.equal(h.zone.style.outline, "");
});
t("E4 ★신고 — 자식 위에서 프레임 밖(세션 화면 오른쪽 자료)으로 나가면 안내가 걷힌다", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  showNote(h);
  h.zone.fire("dragleave", drag({ target: h.scrollbar, relatedTarget: null }));
  assert.equal(notes(h.zone).length, 0);
  assert.equal(h.zone.style.outline, "");
});
t("E5 존 자신에서 나가도 걷힌다(종전에도 되던 경우 — 보존)", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  showNote(h);
  h.zone.fire("dragleave", drag({ target: h.zone, relatedTarget: null }));
  assert.equal(notes(h.zone).length, 0);
});
t("E6 터미널에 놓으면 안내가 걷히고 이 세션의 uploads/ 로 업로드(PUT)가 나간다", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  showNote(h);
  const e = drag({ target: h.canvas, dataTransfer: { types: ["Files"], files: [{ name: "shot.png", type: "image/png", size: 3 }] } });
  h.zone.fire("drop", e);
  assert.equal(notes(h.zone).length, 0);
  assert.equal(e.defaultPrevented, true);
  for (let i = 0; i < 40 && !h.fetched.some((u) => u.startsWith("PUT ")); i++) await tick();
  const put = h.fetched.find((u) => u.startsWith("PUT "));
  assert.ok(put && put.includes("t-3948") && put.includes(encodeURIComponent("uploads/shot.png")), `업로드 요청이 없다: ${JSON.stringify(h.fetched)}`);
});
t("E7 ★dragleave 없이 끌기가 끝나도(취소·포인터 아래 요소 교체) 그 뒤 포인터가 움직이면 안내가 걷힌다", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  showNote(h);
  h.fireWindow("pointermove");
  assert.equal(notes(h.zone).length, 0);
  assert.equal(h.zone.style.outline, "");
});
t("E8 안내가 없을 때 포인터가 움직여도 아무것도 건드리지 않는다", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  h.zone.style.outline = "keep";
  const before = [...h.zone.children];
  h.fireWindow("pointermove");
  assert.equal(h.zone.style.outline, "keep");
  assert.deepEqual(h.zone.children, before);
});

// 파일 탐색기 강조(setupDnd)
t("X1 ★파일 탐색기 — 목록 줄 위에서 프레임 밖·탐색기 밖으로 나가면 강조가 꺼진다", async () => {
  const h = await makeCtx();
  h.mod.setupDnd();
  h.explorer.fire("dragover", drag({ target: h.rowA }));
  assert.equal(h.explorer.classList.contains("drag"), true, "전제: 강조가 켜져야 한다");
  h.explorer.fire("dragleave", drag({ target: h.rowA, relatedTarget: null }));
  assert.equal(h.explorer.classList.contains("drag"), false, "프레임 밖");
  h.explorer.fire("dragover", drag({ target: h.rowB }));
  h.explorer.fire("dragleave", drag({ target: h.rowB, relatedTarget: h.canvas }));
  assert.equal(h.explorer.classList.contains("drag"), false, "터미널 쪽으로");
});
t("X2 파일 탐색기 — 목록 줄 사이를 옮기면 강조가 유지된다", async () => {
  const h = await makeCtx();
  h.mod.setupDnd();
  h.explorer.fire("dragover", drag({ target: h.rowA }));
  h.explorer.fire("dragleave", drag({ target: h.rowA, relatedTarget: h.rowB }));
  assert.equal(h.explorer.classList.contains("drag"), true);
});
t("X3 ★파일 탐색기 — dragleave 없이 끌기가 끝나도 그 뒤 포인터가 움직이면 강조가 꺼진다", async () => {
  const h = await makeCtx();
  h.mod.setupDnd();
  h.explorer.fire("dragover", drag({ target: h.rowA }));
  assert.equal(h.explorer.classList.contains("drag"), true, "전제: 강조가 켜져야 한다");
  h.fireWindow("pointermove");
  assert.equal(h.explorer.classList.contains("drag"), false);
});

// 새 셸 파일 앱(web/v2/files.ts) — import·DOM 에 묶인 화면 모듈이라 배선만 소스에서 못박는다(레포 선례: category-groups-sidebar).
//  주석은 지우고 본다 — 설명 주석에 남은 옛 문구가 거짓 빨강·초록을 만든 선례가 있다. 동작은 as-built 지식의 브라우저 전후 대조가 본다.
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
t("F1 ★새 셸 파일 앱 — 강조를 끄는 판정은 relatedTarget 포함이고, dragleave 없이 끝난 끌기는 포인터 이동에 끄며, 닫을 때 그 리스너를 뗀다", () => {
  const src = stripComments(readFileSync(FILES_TS, "utf8"));
  const from = src.indexOf("addEventListener('dragleave'");
  const to = src.indexOf("addEventListener('drop'");
  assert.ok(from >= 0 && to > from, "dragleave·drop 배선을 못 찾았다");
  const leave = src.slice(from, to);
  assert.match(leave, /relatedTarget/, "새로 들어간 요소로 판정해야 한다");
  assert.match(leave, /root\.contains\(/, "존 안인지 contains 로 가려야 한다");
  assert.doesNotMatch(src, /e\.target\s*===\s*root/, "떠난 요소(target)로 판정하면 자식 위에서 나갈 때 강조가 남는다");
  const reg = /window\.addEventListener\('pointermove',\s*(\w+)\)/.exec(src);
  assert.ok(reg, "포인터 이동 안전망이 없다");
  const destroyAt = src.lastIndexOf("destroy()");
  assert.ok(destroyAt >= 0, "destroy 를 못 찾았다");
  assert.match(src.slice(destroyAt), new RegExp(`window\\.removeEventListener\\('pointermove',\\s*${reg![1]}\\)`), "닫을 때 창 리스너를 떼야 한다");
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
