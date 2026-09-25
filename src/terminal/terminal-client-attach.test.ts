// #4229 — 폰(모바일 입력 바)에서 사진·파일 첨부 회귀 테스트.
// 신고: 아이폰에서 터미널 세션을 쓸 때 키보드가 떠 있는 화면에 사진을 붙일 길이 없었다 — 파일 전달 경로가 끌어놓기·⌘V 뿐인데 폰엔 둘 다 없다.
//  단독 터미널 페이지 모듈(web/standalone/terminal.ts → dist/standalone/terminal.js)을 그대로 import 하고 DOM 은 가짜 노드로 세운다.
//  사양·엣지 표는 이 파일 머리의 각 케이스 이름이 곧 행이다(A1~A12d):
//   A1 입력 바에 첨부 단추·파일 입력이 글 상자 옆에 선다 · A2 고른 파일 → 이 세션 uploads/ PUT + 경로는 **글 상자**에(PTY 아님) ·
//   A3 쓰던 글의 캐럿 자리에 끼운다 · A3b 선택 범위는 갈아 끼운다 · A4 바를 끈 폰은 종전대로 PTY 로 · A5 이미지 붙여넣기 → 같은 길 · A5b 글 붙여넣기는 안 가로챔 ·
//   A6 HEIC 를 못 바꾸면 그대로 올린다 · A6b 바꿀 수 있으면 JPEG 로 · A7 데스크톱은 바가 없고 경로는 PTY 로(보존) · A8 단추가 선택기를 연다(값부터 비움) ·
//   A9 여러 장은 순서대로 전부 · A10 취소는 요청 0건 · A11 새 헬퍼 부재(글 상자 없음 → PTY 폴백 · null/빈 목록/빈 항목 → 무해) ·
//   A12 크기 문턱 정확히 → 안 묻고 올림 · A12b 문턱+1 «아니오» → 안 올림 · A12c «예» → 올림 · A12d 물을 장치 없음 → 올림.
// fail-first: 고치기 전 산출 모듈(TERMJS_MOD=<HEAD 의 web/standalone 컴파일본>)로 돌리면 A1·A2·A3·A3b·A5·A6·A6b·A8·A9·A10·A11·A12 계열이 빨간불이다
//  (setupMobileDock 미노출·첨부 단추 없음·경로가 PTY 로 감). A4·A7 은 종전 동작 보존 행이라 그때도 초록.
// 실행: npm run build && node dist/terminal/terminal-client-attach.test.js
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MOD_PATH = process.env.TERMJS_MOD || path.resolve(here, "..", "standalone", "terminal.js");
const MOD_URL = pathToFileURL(MOD_PATH).href;
let seq = 0;

type Listener = (ev: any) => void;

// 가짜 DOM 노드 — 모듈이 쓰는 만큼만: el() 의 className·textContent·setAttribute·append, 글 상자의 value·selection·focus,
//  파일 입력의 files·click, 캔버스(HEIC 변환)의 getContext·toBlob, 리스너 배선.
class FakeNode {
  tag: string;
  nodeType = 1;
  className = "";
  textContent = "";
  value = "";
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  files: any[] = [];
  hidden = false;
  width = 0; height = 0;
  clicked = 0;
  focused = 0;
  parent: FakeNode | null = null;
  children: any[] = [];
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  cls = new Set<string>();
  ls = new Map<string, Listener[]>();
  classList = {
    add: (c: string): void => { this.cls.add(c); },
    remove: (c: string): void => { this.cls.delete(c); },
    toggle: (c: string, on?: boolean): void => { if (on === false || (on === undefined && this.cls.has(c))) this.cls.delete(c); else this.cls.add(c); },
    contains: (c: string): boolean => this.cls.has(c),
  };
  constructor(tag: string) { this.tag = tag; }
  setAttribute(k: string, v: unknown): void { this.attrs[k] = String(v); }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  addEventListener(type: string, fn: Listener): void { const a = this.ls.get(type) || []; a.push(fn); this.ls.set(type, a); }
  removeEventListener(type: string, fn: Listener): void { const a = this.ls.get(type) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  fire(type: string, ev: any = {}): any { ev.target = ev.target || this; for (const fn of [...(this.ls.get(type) || [])]) fn(ev); return ev; }
  click(): void { this.clicked++; this.fire("click", { detail: 1, preventDefault() { /* noop */ } }); }
  focus(): void { this.focused++; }
  blur(): void { /* noop */ }
  // 캔버스 흉내(A6b) — 그리기는 기록만, 인코딩은 작은 블롭
  getContext(): any { return { drawImage: () => { /* noop */ } }; }
  toBlob(cb: (b: Blob | null) => void, type?: string): void { cb(new Blob(["jpg"], { type: type || "image/jpeg" })); }
  append(...nodes: any[]): void {
    for (const n of nodes) {
      if (n && n.parent) n.parent.removeChild(n);
      if (n && typeof n === "object") n.parent = this;
      this.children.push(n);
    }
  }
  prepend(...nodes: any[]): void { for (const n of nodes.reverse()) { if (n && typeof n === "object") n.parent = this; this.children.unshift(n); } }
  removeChild(n: any): void { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parent = null; }
  remove(): void { if (this.parent) this.parent.removeChild(this); }
  replaceChildren(...nodes: any[]): void { this.children = []; this.append(...nodes); }
  contains(n: any): boolean { for (let c = n; c; c = c.parent) if (c === this) return true; return false; }
  querySelector(): any { return null; }
  querySelectorAll(): any[] { return []; }
  // 깊이 우선으로 자손을 찾는다(테스트 전용).
  find(pred: (n: FakeNode) => boolean): FakeNode | null {
    for (const c of this.children) {
      if (!(c instanceof FakeNode)) continue;
      if (pred(c)) return c;
      const d = c.find(pred); if (d) return d;
    }
    return null;
  }
}

interface Harness {
  mod: any;
  main: FakeNode;         // 터미널 페이지 #main — 입력 바가 여기 붙는다
  zone: FakeNode;         // 터미널 존(#panes) — 끌어놓기(종전 경로)의 드롭존
  fetched: string[];      // 나간 요청 «메서드 URL»
  sent: string[];         // PTY 로 나간 바이트(ws.send 의 d)
  asked: string[];        // confirm 으로 물은 문구
  toasts: () => string[]; // 화면에 뜬 알림 글
  dock: () => FakeNode | null;
  composer: () => FakeNode | null;
  attachBtn: () => FakeNode | null;
  fileInput: () => FakeNode | null;
}

interface CtxOpts {
  mobile?: boolean;                  // 폰으로 볼지(?mobile=1 — 검증용 스위치, terminal.ts IS_MOBILE). 기본 폰
  prefs?: Record<string, unknown>;   // localStorage 의 환경 설정(바 끄기 등)
  confirm?: boolean | null;          // 큰 파일 물음의 답. null = 물을 장치가 아예 없음(confirm 미정의)
  bitmap?: boolean;                  // 브라우저가 HEIC 를 그릴 수 있나(createImageBitmap 제공)
}

async function makeCtx(opts: CtxOpts = {}): Promise<Harness> {
  const g: any = globalThis;
  const def = (k: string, v: unknown): void => { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  const undef = (k: string): void => { try { delete g[k]; } catch (_) { def(k, undefined); } };
  const winL = new Map<string, Listener[]>();
  const fetched: string[] = [];
  const sent: string[] = [];
  const asked: string[] = [];
  const body = new FakeNode("body");
  def("window", g); def("self", g);
  def("addEventListener", (type: string, fn: Listener) => { const a = winL.get(type) || []; a.push(fn); winL.set(type, a); });
  def("removeEventListener", (type: string, fn: Listener) => { const a = winL.get(type) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); });
  def("document", {
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text, parent: null }),
    body,
    getElementById: () => null,
    querySelector: () => null,
    addEventListener() { /* noop */ }, removeEventListener() { /* noop */ },
    title: "", hidden: false,
  });
  def("navigator", { platform: "Win32", vendor: "Google Inc.", userAgent: "Mozilla/5.0 Chrome/126", userActivation: { isActive: false }, clipboard: {} });
  def("location", { search: "?session=t-4229" + (opts.mobile === false ? "" : "&mobile=1"), pathname: "/ui/terminal.html", protocol: "https:", host: "test" });
  const store: Record<string, string> = {};
  if (opts.prefs) store["lively_term_prefs"] = JSON.stringify(opts.prefs);
  def("localStorage", { getItem: (k: string) => (k in store ? store[k] : null), setItem(k: string, v: string) { store[k] = v; }, removeItem(k: string) { delete store[k]; } });
  def("isSecureContext", true);
  def("WebSocket", class { /* not used */ });
  def("ResizeObserver", class { observe() { /* noop */ } });
  def("BroadcastChannel", class { onmessage = null; });
  def("matchMedia", () => ({ matches: false, addEventListener() { /* noop */ } }));
  def("requestAnimationFrame", (f: () => void) => setTimeout(f, 0));
  def("scrollTo", () => { /* noop */ });
  def("TERMJS_BUILD", "test");
  if (opts.confirm === null) undef("confirm"); else def("confirm", (msg: string) => { asked.push(msg); return opts.confirm !== false; });
  if (opts.bitmap) def("createImageBitmap", async () => ({ width: 4, height: 3 })); else undef("createImageBitmap");
  // 목록 조회(겹치는 이름 확인)는 빈 폴더로, 업로드(PUT)는 서버가 주는 절대경로로 답한다 — 그 경로가 어디로 가는지가 이 테스트의 표적.
  def("fetch", (url: unknown, o?: any) => {
    const method = String((o && o.method) || "GET").toUpperCase();
    const u = String(url);
    fetched.push(`${method} ${u}`);
    if (method === "GET") return Promise.resolve({ ok: true, status: 200, json: async () => ({ items: [] }) });
    const rel = decodeURIComponent((u.match(/path=([^&]+)/) || [])[1] || "");
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ path: "/srv/box/work/" + rel }) });
  });

  const mod: any = await import(`${MOD_URL}?n=${++seq}`);
  const main = new FakeNode("div");
  const zone = new FakeNode("div");
  mod.__injectRefsForTest({
    ws: { readyState: 1, send: (s: string) => { try { sent.push(JSON.parse(s).d); } catch (_) { sent.push(s); } } },
    term: { cols: 80, rows: 24, textarea: new FakeNode("textarea"), modes: {}, buffer: { active: { type: "normal", length: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => null } } },
    fit: null,
    panesEl: zone,
    explorerEl: new FakeNode("aside"),
  });
  return {
    mod, main, zone, fetched, sent, asked,
    toasts: () => body.children.filter((c: any) => c instanceof FakeNode && c.tag === "div").map((c: any) => c.textContent),
    dock: () => main.find((n) => n.attrs.id === "mdock"),
    composer: () => main.find((n) => n.tag === "textarea"),
    attachBtn: () => main.find((n) => n.tag === "button" && /첨부/.test(n.attrs["aria-label"] || n.attrs.title || "")),
    fileInput: () => main.find((n) => n.tag === "input" && n.attrs.type === "file"),
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
const PUTS = (h: Harness): string[] => h.fetched.filter((u) => u.startsWith("PUT "));
// 업로드(PUT)가 n건 나갈 때까지 기다린다 — 비동기 사슬(목록 조회 → PUT → 경로 삽입)을 넘겨서 본다.
async function waitPut(h: Harness, n = 1): Promise<string[]> {
  for (let i = 0; i < 80 && PUTS(h).length < n; i++) await tick();
  await tick(); await tick();
  return PUTS(h);
}
// 파일 선택기에서 골랐다 — 파일 입력에 목록을 채우고 change 를 쏜다.
const pick = (h: Harness, files: any[]): void => {
  const inp = h.fileInput();
  assert.ok(inp, "전제: 파일 입력이 있어야 한다");
  inp!.files = files;
  inp!.fire("change");
};
// 종전 경로 — 터미널에 끌어다 놓았다(setupTermDrop 의 drop).
const dropOnTerm = (h: Harness, files: any[]): void => {
  h.mod.setupTermDrop();
  h.zone.fire("drop", { dataTransfer: { types: ["Files"], files }, preventDefault() { /* noop */ } });
};
const img = (name: string, type = "image/jpeg", size = 3): any => ({ name, type, size });
const MB50 = 50 * 1024 * 1024;

// ── 미니 async 러너 ──
const tests: Array<[string, () => Promise<void> | void]> = [];
const t = (name: string, fn: () => Promise<void> | void): void => { tests.push([name, fn]); };

t("A1 폰이면 입력 바에 첨부 단추와 파일 입력(여러 개·숨김)이 글 상자 왼쪽, 같은 줄에 선다", async () => {
  const h = await makeCtx();
  h.mod.setupMobileDock(h.main);
  assert.ok(h.dock(), "입력 바가 붙어야 한다");
  const btn = h.attachBtn(); const inp = h.fileInput();
  assert.ok(btn, "첨부 단추"); assert.ok(inp, "파일 입력");
  assert.equal(btn!.attrs.type, "button", "폼 제출 단추가 아니다");
  assert.ok(btn!.attrs["aria-label"], "이름이 있어야 한다(스크린리더)");
  assert.ok("multiple" in inp!.attrs, "여러 장 고를 수 있어야 한다");
  assert.ok("hidden" in inp!.attrs, "파일 입력 자체는 숨긴다(단추가 연다)");
  const row = btn!.parent!;
  assert.ok(row.children.includes(h.composer()), "글 상자와 같은 줄(늘 보이는 자리)에 있어야 한다");
  assert.ok(row.children.indexOf(btn) < row.children.indexOf(h.composer()), "글 상자 왼쪽");
});
t("A2 ★신고 — 고른 사진은 이 세션 uploads/ 로 올라가고, 경로는 글 상자에 들어간다(PTY 로 흘리지 않는다)", async () => {
  const h = await makeCtx();
  h.mod.setupMobileDock(h.main);
  pick(h, [img("IMG_0001.jpeg")]);
  const puts = await waitPut(h);
  assert.equal(puts.length, 1);
  assert.ok(puts[0].includes("t-4229") && puts[0].includes(encodeURIComponent("uploads/IMG_0001.jpeg")), `업로드 요청: ${puts[0]}`);
  const c = h.composer()!;
  assert.equal(c.value, " '/srv/box/work/uploads/IMG_0001.jpeg' ", "따옴표로 감싼 절대경로 + 앞뒤 공백");
  assert.equal(h.sent.length, 0, "PTY 로는 아무것도 안 나가야 한다(사람이 글을 붙여 [보내기]로 보낸다)");
  assert.ok(c.focused >= 1, "글 상자로 초점을 돌려준다");
  assert.ok(h.toasts().some((s) => s.includes("IMG_0001.jpeg")), "파일명으로 알린다");
});
t("A3 쓰던 글이 있으면 캐럿 자리에 끼운다 — 글은 지워지지 않고 캐럿은 끼운 글 뒤", async () => {
  const h = await makeCtx();
  h.mod.setupMobileDock(h.main);
  const c = h.composer()!;
  c.value = "이 사진 봐줘"; c.selectionStart = c.selectionEnd = c.value.length;
  pick(h, [img("a.png", "image/png")]);
  await waitPut(h);
  assert.equal(c.value, "이 사진 봐줘 '/srv/box/work/uploads/a.png' ");
  assert.equal(c.selectionStart, c.value.length);
  assert.equal(c.selectionEnd, c.value.length);
});
t("A3b 선택 범위가 있으면 그 범위를 경로로 갈아 끼운다(앞뒤 글 보존)", async () => {
  const h = await makeCtx();
  h.mod.setupMobileDock(h.main);
  const c = h.composer()!;
  c.value = "앞XX뒤"; c.selectionStart = 1; c.selectionEnd = 3;
  pick(h, [img("s.png", "image/png")]);
  await waitPut(h);
  assert.equal(c.value, "앞 '/srv/box/work/uploads/s.png' 뒤");
});
t("A4 입력 바를 끈 폰(환경 설정)에선 끌어놓기 경로가 종전대로 PTY(터미널 줄)로 간다", async () => {
  const h = await makeCtx({ prefs: { mobileDock: false } });
  if (typeof h.mod.setupMobileDock === "function") h.mod.setupMobileDock(h.main);   // 종전 동작 보존 행 — 고치기 전 모듈(미노출)에서도 돈다
  if (h.dock()) assert.equal(h.dock()!.hidden, true, "전제: 바가 숨어 있다");
  dropOnTerm(h, [img("b.jpg")]);
  await waitPut(h);
  if (h.composer()) assert.equal(h.composer()!.value, "", "숨은 글 상자에 넣으면 사람이 못 본다");
  assert.ok(h.sent.some((d) => d.includes("'/srv/box/work/uploads/b.jpg'")), `PTY 로 가야 한다: ${JSON.stringify(h.sent)}`);
});
t("A5 글 상자에 이미지를 붙여넣으면(사진 앱 «복사») 같은 길로 올린다", async () => {
  const h = await makeCtx();
  h.mod.setupMobileDock(h.main);
  const c = h.composer()!;
  const ev = c.fire("paste", { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => img("image.png", "image/png") }] }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  assert.equal(ev.defaultPrevented, true, "이미지는 우리가 받는다");
  const puts = await waitPut(h);
  assert.ok(puts[0] && puts[0].includes(encodeURIComponent("uploads/image.png")), `업로드: ${JSON.stringify(puts)}`);
  assert.ok(c.value.includes("'/srv/box/work/uploads/image.png'"));
});
t("A5b 글 붙여넣기는 가로채지 않는다(브라우저 기본 동작) · 업로드 0건", async () => {
  const h = await makeCtx();
  h.mod.setupMobileDock(h.main);
  const c = h.composer()!;
  const ev = c.fire("paste", { clipboardData: { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }], getData: () => "글" }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  assert.equal(ev.defaultPrevented, false);
  await tick(); await tick();
  assert.equal(h.fetched.length, 0);
});
t("A6 HEIC 를 못 바꾸는 환경에선 그대로 올린다(막지 않고 알린다)", async () => {
  const h = await makeCtx({ bitmap: false });
  h.mod.setupMobileDock(h.main);
  pick(h, [img("IMG_7.HEIC", "image/heic", 10)]);
  const puts = await waitPut(h);
  assert.ok(puts[0] && puts[0].includes(encodeURIComponent("uploads/IMG_7.HEIC")), `업로드: ${JSON.stringify(puts)}`);
  assert.ok(h.toasts().some((s) => /HEIC/.test(s)), "그대로 올렸다고 알린다");
});
t("A6b HEIC 를 그릴 수 있는 브라우저에선 JPEG 로 바꿔 .jpg 로 올린다", async () => {
  const h = await makeCtx({ bitmap: true });
  h.mod.setupMobileDock(h.main);
  pick(h, [img("IMG_8.heic", "image/heic", 10)]);
  const puts = await waitPut(h);
  assert.ok(puts[0] && puts[0].includes(encodeURIComponent("uploads/IMG_8.jpg")), `업로드: ${JSON.stringify(puts)}`);
  assert.ok(!h.toasts().some((s) => /HEIC/.test(s)), "바꿨으니 경고는 없다");
});
t("A7 데스크톱(폰 아님)엔 입력 바가 없고, 끌어놓기 경로는 종전대로 PTY 로 간다(보존)", async () => {
  const h = await makeCtx({ mobile: false });
  if (typeof h.mod.setupMobileDock === "function") h.mod.setupMobileDock(h.main);   // 종전 동작 보존 행 — 고치기 전 모듈에서도 돈다
  assert.equal(h.dock(), null);
  assert.equal(h.attachBtn(), null);
  dropOnTerm(h, [img("d.png", "image/png")]);
  await waitPut(h);
  assert.ok(h.sent.some((d) => d.includes("'/srv/box/work/uploads/d.png'")), `PTY: ${JSON.stringify(h.sent)}`);
});
t("A8 첨부 단추를 누르면 파일 선택기가 열린다 — 같은 파일을 다시 고를 수 있게 값부터 비운다", async () => {
  const h = await makeCtx();
  h.mod.setupMobileDock(h.main);
  const inp = h.fileInput()!;
  inp.value = "C:\\fakepath\\old.jpg";
  h.attachBtn()!.click();
  assert.equal(inp.clicked, 1, "파일 입력을 눌러 선택기를 연다");
  assert.equal(inp.value, "");
});
t("A9 여러 장을 고르면 순서대로 전부 올라가고 경로가 모두 글 상자에 들어간다", async () => {
  const h = await makeCtx();
  h.mod.setupMobileDock(h.main);
  pick(h, [img("1.jpg"), img("2.jpg")]);
  const puts = await waitPut(h, 2);
  assert.equal(puts.length, 2);
  assert.ok(puts[0].includes(encodeURIComponent("uploads/1.jpg")) && puts[1].includes(encodeURIComponent("uploads/2.jpg")), "고른 순서대로");
  assert.equal(h.composer()!.value, " '/srv/box/work/uploads/1.jpg'  '/srv/box/work/uploads/2.jpg' ");
});
t("A10 선택기에서 취소하면(고른 것 없음) 아무 요청도 안 나간다", async () => {
  const h = await makeCtx();
  h.mod.setupMobileDock(h.main);
  pick(h, []);
  await tick(); await tick();
  assert.equal(h.fetched.length, 0);
  assert.equal(h.composer()!.value, "");
});
t("A11 새 헬퍼의 부재 — 바가 아직 안 세워진 폰이면 PTY 로 폴백 · null/빈 목록/빈 항목은 요청 0건·오류 없음", async () => {
  const h = await makeCtx();
  dropOnTerm(h, [img("early.png", "image/png")]);   // setupMobileDock 이전
  await waitPut(h);
  assert.ok(h.sent.some((d) => d.includes("'/srv/box/work/uploads/early.png'")), `PTY 폴백: ${JSON.stringify(h.sent)}`);
  const before = h.fetched.length;
  await h.mod.attachFilesToAgent(null);
  await h.mod.attachFilesToAgent([]);
  await h.mod.attachFilesToAgent([null, undefined]);
  await tick();
  assert.equal(h.fetched.length, before);
});
t("A12 경계 — 파일 크기가 묻는 문턱(50MB) 정확히면 묻지 않고 올린다", async () => {
  const h = await makeCtx({ confirm: false });
  h.mod.setupMobileDock(h.main);
  pick(h, [img("edge.jpg", "image/jpeg", MB50)]);
  const puts = await waitPut(h);
  assert.equal(h.asked.length, 0, "문턱 정확히는 묻지 않는다");
  assert.equal(puts.length, 1);
});
t("A12b 문턱 + 1바이트 · 사람이 «아니오» → 올리지 않는다", async () => {
  const h = await makeCtx({ confirm: false });
  h.mod.setupMobileDock(h.main);
  pick(h, [img("big.mov", "video/quicktime", MB50 + 1)]);
  await tick(); await tick(); await tick();
  assert.equal(h.asked.length, 1, "한 번 묻는다");
  assert.ok(/MB/.test(h.asked[0]), "크기를 말해 준다");
  assert.equal(PUTS(h).length, 0);
  assert.equal(h.composer()!.value, "");
});
t("A12c 문턱 + 1바이트 · 사람이 «예» → 올린다", async () => {
  const h = await makeCtx({ confirm: true });
  h.mod.setupMobileDock(h.main);
  pick(h, [img("big.mov", "video/quicktime", MB50 + 1)]);
  const puts = await waitPut(h);
  assert.equal(h.asked.length, 1);
  assert.equal(puts.length, 1);
});
t("A12d 문턱 초과인데 물을 장치(confirm)가 없으면 막지 않고 올린다", async () => {
  const h = await makeCtx({ confirm: null });
  h.mod.setupMobileDock(h.main);
  pick(h, [img("big.mov", "video/quicktime", MB50 + 1)]);
  const puts = await waitPut(h);
  assert.equal(puts.length, 1);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (e) { failed++; console.log(`not ok - ${name}\n  ${(e as Error).stack || e}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
setTimeout(() => process.exit(failed ? 1 : 0), 50); // 알림 타이머(2.8초)가 프로세스를 붙들지 않게
