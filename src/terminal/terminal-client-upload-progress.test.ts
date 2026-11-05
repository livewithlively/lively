// #5361 — 세션 화면(웹터미널) 파일 올리기 진행 표시 회귀 테스트.
// 신고(원준 2026-11-05): 257,607,548 바이트 녹화 mp4 를 세션 화면에 끌어다 놓자 «업로드 중…» 알림이 3초쯤 뜨고 사라졌고,
//  다 올라갈 때까지 아무 표시가 없었다. 올라가는지 몰라 같은 파일을 다시 놓았고, 두 업로드가 같은 이름 uploads/…mp4 로 가서
//  경로가 입력창에 두 번 들어갔다. 원인: toast() 는 2.8초 뒤 무조건 지운다 · fetch PUT 은 업로드 진행률을 주지 않는다 ·
//  겹치지 않는 이름은 다 올라간 파일 목록만 보고 골랐다(올리는 중인 파일은 아직 목록에 없다).
// 사양·엣지 표 — 케이스 이름이 곧 행이다:
//  U1~U6 순수 판정(web/standalone/upload-queue.ts): 같은 파일 표지 · 겹치지 않는 이름 · 장부(세우기·예약·빼기·busy) · 숫자·문장.
//  P1~P19 동작(단독 터미널 모듈 dist/standalone/terminal.js 를 가짜 DOM·가짜 XHR 로): 칸이 3초 뒤에도 남는다 · 퍼센트 ·
//   다 보낸 뒤 «마무리»(경계 크기·크기-1) · 끝나면 경로 한 번 + 걷힘 · 본문 없는 응답 폴백 · 같은 파일 다시 놓기 차단 ·
//   같은 이름 예약(목록 실패 포함) · 취소 · 실패 이유 · 네트워크 · 창 닫기 경고 · 데스크톱 앱 예외 · 여러 파일 · 기다리는 파일
//   취소 · 끝난 뒤 다시 놓기 · 폰 자리 · 파일 탐색기 · 요청 머리 · 판이 서기 전 붙여넣기 · 진행률 없는 XHR.
// fail-first: TERMJS_MOD=<고치기 전 산출 모듈(HEAD 의 web/standalone 컴파일본)> UPQ_MOD=<없는 경로> 로 돌리면 P11(데스크톱 앱
//  예외 — «걸지 않는다» 는 종전에도 참)을 뺀 전부가 빨간불이다.
// 실행: npm run build && node dist/terminal/terminal-client-upload-progress.test.js
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MOD_URL = pathToFileURL(process.env.TERMJS_MOD || path.resolve(here, "..", "standalone", "terminal.js")).href;
const UPQ_URL = pathToFileURL(process.env.UPQ_MOD || path.resolve(here, "..", "standalone", "upload-queue.js")).href;
let seq = 0;

type Listener = (ev: any) => void;

// 가짜 DOM 노드 — 모듈이 쓰는 만큼만(el() 의 className·textContent·setAttribute·append, 칸의 contains·remove·hidden·style·classList).
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
  click(): void { this.fire("click", { detail: 1, preventDefault() { /* noop */ } }); }
  focus(): void { this.focused++; }
  blur(): void { /* noop */ }
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
  find(pred: (n: FakeNode) => boolean): FakeNode | null {
    for (const c of this.children) {
      if (!(c instanceof FakeNode)) continue;
      if (pred(c)) return c;
      const d = c.find(pred); if (d) return d;
    }
    return null;
  }
  findAll(pred: (n: FakeNode) => boolean, out: FakeNode[] = []): FakeNode[] {
    for (const c of this.children) { if (c instanceof FakeNode) { if (pred(c)) out.push(c); c.findAll(pred, out); } }
    return out;
  }
  /** 이 노드 아래 글 전부(브라우저 textContent 처럼 자손을 잇는다). */
  text(): string { return this.textContent + this.children.map((c: any) => (c instanceof FakeNode ? c.text() : (c && c.textContent) || "")).join(""); }
}

// 가짜 XHR — 보낸 요청을 남기고, 시험이 진행률·응답·끊김을 손으로 일으킨다.
class FakeXHR {
  method = ""; url = ""; headers: Record<string, string> = {}; body: any = null;
  status = 0; responseText = "";
  upload: { onprogress: ((ev: any) => void) | null } | undefined = { onprogress: null };
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null; onloadend: (() => void) | null = null;
  aborted = false; settled = false;
  static sink: (x: FakeXHR) => void = () => { /* makeCtx 가 갈아 끼운다 */ };
  static noUpload = false;
  constructor() { if (FakeXHR.noUpload) this.upload = undefined; }
  open(m: string, u: string): void { this.method = m; this.url = u; }
  setRequestHeader(k: string, v: string): void { this.headers[k] = v; }
  send(b: any): void { this.body = b; FakeXHR.sink(this); }
  abort(): void { if (this.settled) return; this.settled = true; this.aborted = true; this.onabort?.(); this.onloadend?.(); }
  progress(loaded: number, total = Number(this.body && this.body.size) || 0): void { this.upload?.onprogress?.({ lengthComputable: true, loaded, total }); }
  respond(status: number, json: unknown): void {
    if (this.settled) return;
    this.settled = true; this.status = status; this.responseText = json == null ? "" : JSON.stringify(json);
    this.onload?.(); this.onloadend?.();
  }
  netFail(): void { if (this.settled) return; this.settled = true; this.onerror?.(); this.onloadend?.(); }
}

interface Harness {
  mod: any;
  zone: FakeNode;             // 터미널 판(#panes) — 칸이 여기 선다
  main: FakeNode;             // #main — 폰 입력 바가 붙는 곳
  explorer: FakeNode;
  body: FakeNode;
  xhrs: FakeXHR[];            // 나간 올리기(PUT)
  puts: () => string[];       // 나간 PUT 의 URL(XHR·fetch 어느 길이든 — 고치기 전 모듈은 fetch 로 보낸다)
  lsCalls: () => number;      // 겹치는 이름을 보려고 목록을 읽은 횟수(배선 확인)
  sent: string[];             // PTY 로 나간 바이트
  toasts: () => string[];     // body 에 직접 뜬 알림 글
  winL: Map<string, Listener[]>;
  ls: string[];               // uploads/ 목록(이미 있는 이름)
}

interface CtxOpts { mobile?: boolean; desktopApp?: boolean; token?: string; lsFail?: boolean; noPanes?: boolean; noUploadProp?: boolean }

async function makeCtx(opts: CtxOpts = {}): Promise<Harness> {
  const g: any = globalThis;
  const def = (k: string, v: unknown): void => { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  const winL = new Map<string, Listener[]>();
  const sent: string[] = [];
  const xhrs: FakeXHR[] = [];
  const fetchPuts: string[] = [];
  let lsN = 0;
  const ls: string[] = [];
  const body = new FakeNode("body");
  //  파일 탐색기 목록 자리(loadDir 가 그린다 — 탐색기에 놓으면 먼저 목록을 연다).
  const byId: Record<string, FakeNode> = { "exp-list": new FakeNode("div"), "exp-path": new FakeNode("div") };
  def("window", g); def("self", g);
  def("livelyDesktop", opts.desktopApp ? { platform: "darwin" } : undefined);
  def("addEventListener", (type: string, fn: Listener) => { const a = winL.get(type) || []; a.push(fn); winL.set(type, a); });
  def("removeEventListener", (type: string, fn: Listener) => { const a = winL.get(type) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); });
  def("document", {
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text, parent: null }),
    body,
    getElementById: (id: string) => byId[id] || null,
    querySelector: () => null,
    addEventListener() { /* noop */ }, removeEventListener() { /* noop */ },
    title: "", hidden: false,
  });
  def("navigator", { platform: "Win32", vendor: "Google Inc.", userAgent: "Mozilla/5.0 Chrome/126", userActivation: { isActive: false }, clipboard: {} });
  def("location", { search: "?session=t-5361" + (opts.mobile ? "&mobile=1" : ""), pathname: "/ui/terminal.html", protocol: "https:", host: "test", origin: "https://test", href: "https://test/ui/terminal.html" });
  const store: Record<string, string> = {};
  if (opts.token) store["lively_ui_token"] = opts.token;
  def("localStorage", { getItem: (k: string) => (k in store ? store[k] : null), setItem(k: string, v: string) { store[k] = v; }, removeItem(k: string) { delete store[k]; } });
  const session: Record<string, string> = {};
  def("sessionStorage", { getItem: (k: string) => (k in session ? session[k] : null), setItem(k: string, v: string) { session[k] = String(v); }, removeItem(k: string) { delete session[k]; } });
  def("isSecureContext", true);
  def("WebSocket", class { /* not used */ });
  def("ResizeObserver", class { observe() { /* noop */ } });
  def("BroadcastChannel", class { onmessage = null; });
  def("matchMedia", () => ({ matches: false, addEventListener() { /* noop */ } }));
  def("requestAnimationFrame", (f: () => void) => setTimeout(f, 0));
  def("scrollTo", () => { /* noop */ });
  def("TERMJS_BUILD", "test");
  //  목록(겹치는 이름 확인)은 ls 로 답한다(lsFail 이면 404 — 폴더 없음). 고치기 전 모듈은 PUT 을 fetch 로 보낸다 — 그 길은 세기만 하고 끝내지 않는다.
  def("fetch", (url: unknown, o?: any) => {
    const method = String((o && o.method) || "GET").toUpperCase();
    if (method === "GET") {
      lsN++;
      if (opts.lsFail) return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: "디렉터리 없음" }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ items: ls.map((name) => ({ name, type: "file" })) }) });
    }
    fetchPuts.push(String(url));
    return new Promise(() => { /* 끝나지 않는다 */ });
  });
  FakeXHR.sink = (x) => { xhrs.push(x); };
  FakeXHR.noUpload = !!opts.noUploadProp;
  def("XMLHttpRequest", FakeXHR);

  const mod: any = await import(`${MOD_URL}?n=${++seq}`);
  const zone = new FakeNode("div");
  const main = new FakeNode("div");
  main.append(zone);
  const explorer = new FakeNode("aside");
  mod.__injectRefsForTest({
    ws: { readyState: 1, send: (s: string) => { try { sent.push(JSON.parse(s).d); } catch (_) { sent.push(s); } } },
    term: { cols: 80, rows: 24, textarea: new FakeNode("textarea"), modes: {}, buffer: { active: { type: "normal", length: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => null } } },
    fit: null,
    panesEl: opts.noPanes ? null : zone,
    explorerEl: explorer,
    uploadDoneMs: 40,
  });
  return {
    mod, zone, main, explorer, body, xhrs, sent, winL, ls,
    puts: () => [...xhrs.filter((x) => x.method === "PUT").map((x) => x.url), ...fetchPuts],
    lsCalls: () => lsN,
    toasts: () => body.children.filter((c: any) => c instanceof FakeNode && c.tag === "div" && c.className !== "upq").map((c: any) => c.text()),
  };
}

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, tries = 100): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) await tick();
  assert.ok(pred(), `기다렸지만 오지 않았다: ${what}`);
}
// 파일 흉내 — 브라우저 File 에서 모듈이 읽는 것만.
const file = (name: string, size: number, lastModified = 1_762_300_000_000, type = "video/mp4"): any => ({ name, size, lastModified, type });
const REC_NAME = "GMT20261105-021343_Recording_1920x1112.mp4";
const REC = (): any => file(REC_NAME, 257_607_548);
// 터미널에 끌어다 놓았다.
const dropOnTerm = (h: Harness, files: any[]): void => {
  h.zone.fire("drop", { dataTransfer: { types: ["Files"], files }, preventDefault() { /* noop */ } });
};
const panelIn = (root: FakeNode): FakeNode | null => root.find((n) => n.className === "upq");
const panel = (h: Harness): FakeNode | null => panelIn(h.zone);
const rows = (h: Harness, root: FakeNode = h.zone): FakeNode[] => root.findAll((n) => n.className === "upq-row");
const part = (row: FakeNode, cls: string): FakeNode => { const n = row.find((x) => x.className === cls); assert.ok(n, `줄에 ${cls} 가 없다`); return n!; };
const btnOf = (row: FakeNode): FakeNode => part(row, "upq-btn");
const pathsSent = (h: Harness): string[] => h.sent.filter((d) => /uploads\//.test(d));
const guards = (h: Harness): number => (h.winL.get("beforeunload") || []).length;

// ── 미니 async 러너 ──
const tests: Array<[string, () => Promise<void> | void]> = [];
const t = (name: string, fn: () => Promise<void> | void): void => { tests.push([name, fn]); };

// ── U: 순수 판정 ─────────────────────────────────────────────────────────────
t("U1 같은 파일 표지 — 이름·크기·수정 시각·폴더가 모두 같아야 같은 파일이다 · 빈 값도 오류 없이", async () => {
  const q = await import(UPQ_URL);
  const a = file("a.mp4", 10, 111);
  assert.equal(q.uploadKey(a, "uploads"), q.uploadKey({ ...a }, "uploads"), "같은 값이면 같은 표지");
  assert.notEqual(q.uploadKey(a, "uploads"), q.uploadKey({ ...a, name: "b.mp4" }, "uploads"), "이름");
  assert.notEqual(q.uploadKey(a, "uploads"), q.uploadKey({ ...a, size: 11 }, "uploads"), "크기");
  assert.notEqual(q.uploadKey(a, "uploads"), q.uploadKey({ ...a, lastModified: 112 }, "uploads"), "수정 시각");
  assert.notEqual(q.uploadKey(a, "uploads"), q.uploadKey(a, "docs"), "폴더");
  assert.equal(typeof q.uploadKey({}, ""), "string", "빈 값");
  assert.equal(typeof q.uploadKey(null, ""), "string", "null");
});
t("U2 겹치지 않는 이름 — 비면 그대로 · 있으면 -2 · -2 도 있으면 -3 · 확장자 없음 · 점으로 시작 · 점 여럿", async () => {
  const q = await import(UPQ_URL);
  const S = (...a: string[]): Set<string> => new Set(a);
  assert.equal(q.freeUploadName("a.png", S()), "a.png");
  assert.equal(q.freeUploadName("a.png", S("a.png")), "a-2.png");
  assert.equal(q.freeUploadName("a.png", S("a.png", "a-2.png")), "a-3.png");
  assert.equal(q.freeUploadName("README", S("README")), "README-2");
  assert.equal(q.freeUploadName(".env", S(".env")), ".env-2");
  assert.equal(q.freeUploadName("a.tar.gz", S("a.tar.gz")), "a.tar-2.gz");
});
t("U3 장부 세우기 — 올리는 중 같은 파일은 새로 세우지 않고 그 일을 돌려준다 · 다른 폴더는 따로 · 빼면 다시 세운다", async () => {
  const q = await import(UPQ_URL);
  const b = new q.UploadBook();
  const f = file("a.mp4", 10, 111);
  const first = b.claim(f, "uploads", "a.mp4");
  assert.equal(first.dup, false);
  const again = b.claim({ ...f }, "uploads", "a.mp4");
  assert.equal(again.dup, true);
  assert.equal(again.job, first.job, "이미 올라가는 그 일");
  assert.equal(b.claim(f, "docs", "a.mp4").dup, false, "다른 폴더로는 따로 올린다");
  b.release(first.job);
  const third = b.claim(f, "uploads", "a.mp4");
  assert.equal(third.dup, false, "끝난 뒤 다시 놓으면 새로 올린다");
  assert.notEqual(third.job.id, first.job.id);
});
t("U4 이름 예약 — 함께 올라가는 같은 이름은 -2 · 잠정 이름은 막지 않는다 · 다른 폴더 · 목록+예약 · 뺀 이름은 풀린다 · 취소된 일은 예약하지 않는다", async () => {
  const q = await import(UPQ_URL);
  const b = new q.UploadBook();
  const A = b.claim(file("x.png", 1, 1), "uploads", "x.png").job;
  const B = b.claim(file("x.png", 2, 2), "uploads", "x.png").job;     // 같은 이름 · 다른 파일
  assert.equal(b.reserve(A, []), "x.png", "앞 것은 원래 이름(뒤 것의 잠정 이름은 막지 않는다)");
  assert.equal(b.reserve(B, []), "x-2.png", "올리는 중인 이름은 예약이다");
  const C = b.claim(file("x.png", 3, 3), "docs", "x.png").job;
  assert.equal(b.reserve(C, []), "x.png", "다른 폴더");
  const D = b.claim(file("x.png", 4, 4), "uploads", "x.png").job;
  assert.equal(b.reserve(D, ["x-3.png"]), "x-4.png", "서버 목록과 예약을 함께 피한다");
  b.release(A);
  const E = b.claim(file("x.png", 5, 5), "uploads", "x.png").job;
  assert.equal(b.reserve(E, []), "x.png", "다 올라가 빠진 이름은 풀린다(그 뒤엔 서버 목록이 막는다)");
  const F = b.claim(file("y.png", 6, 6), "uploads", "y.png").job;
  b.release(F);
  b.reserve(F, []);
  assert.equal(F.reserved, false, "취소된 일은 예약하지 않는다");
  const G = b.claim(file("y.png", 7, 7), "uploads", "y.png").job;
  assert.equal(b.reserve(G, []), "y.png");
});
t("U5 busy — 세운 것이 있으면 참 · 다 빼면 거짓(창 닫기 경고의 기준) · 두 번 빼도 무해", async () => {
  const q = await import(UPQ_URL);
  const b = new q.UploadBook();
  assert.equal(b.busy(), false);
  const A = b.claim(file("a", 1, 1), "uploads", "a").job;
  const B = b.claim(file("b", 1, 1), "uploads", "b").job;
  assert.equal(b.busy(), true);
  b.release(A); assert.equal(b.busy(), true, "하나 남았다");
  b.release(B); assert.equal(b.busy(), false);
  b.release(B); assert.equal(b.busy(), false, "두 번 빼도 무해");
});
t("U6 경계 숫자·문장 — 신고 파일 크기 · 단위 경계 · 다 보내기 전엔 100% 가 아니다 · 줄 문장은 어미까지 맺는다", async () => {
  const q = await import(UPQ_URL);
  assert.equal(q.fmtBytes(257_607_548), "245.7MB");
  assert.equal(q.fmtBytes(0), "0B");
  assert.equal(q.fmtBytes(1023), "1023B");
  assert.equal(q.fmtBytes(1024), "1KB");
  assert.equal(q.fmtBytes(1024 ** 3), "1.00GB");
  assert.equal(q.upPercent(0, 100), 0);
  assert.equal(q.upPercent(50, 100), 50);
  assert.equal(q.upPercent(99_999, 100_000), 99, "내림 — 다 보내기 전엔 100 을 말하지 않는다");
  assert.equal(q.upPercent(100, 100), 100);
  assert.equal(q.upPercent(150, 100), 100, "넘쳐도 100");
  const job = (state: string, extra: Record<string, unknown> = {}): any => ({ id: 1, key: "k", dir: "uploads", name: "a", reserved: true, size: 100, loaded: 0, state, error: "", note: "", ...extra });
  const texts = [
    q.upStatusText(job("wait")), q.upStatusText(job("send", { loaded: 40 })), q.upStatusText(job("send", { loaded: 100 })),
    q.upStatusText(job("done")), q.upStatusText(job("done", { note: "경로를 입력창에 넣었어요." })),
    q.upStatusText(job("fail", { error: "파일이 너무 큽니다(1GB 초과)" })), q.upStatusText(job("fail")), q.upStatusText(job("cancel")),
  ];
  for (const s of texts) assert.match(s, /(요\.|다\(1GB 초과\))$/, `어미로 끝나지 않은 문장: ${s}`);
  assert.equal(texts[1], "100B 중 40B를 올렸어요.");
  assert.equal(texts[2], "다 보냈어요. 저장을 마치는 중이에요.", "다 보냈으면 서버 저장을 기다린다고 말한다");
});

// ── P: 동작 ──────────────────────────────────────────────────────────────────
t("P1 ★신고 — 큰 파일을 놓으면 터미널 판 오른쪽 아래 칸에 이름·크기가 뜨고, 3초(옛 알림 수명 2.8초)가 지나도 올리는 동안 남는다", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  dropOnTerm(h, [REC()]);
  await until(() => h.puts().length === 1, "PUT");
  assert.ok(h.lsCalls() >= 1, "배선: 겹치는 이름을 보려고 목록을 읽었다");
  const p = panel(h);
  assert.ok(p, "칸이 떠야 한다");
  assert.equal(p!.parent, h.zone, "칸은 터미널 판(#panes) 안이다");
  const [row] = rows(h);
  assert.equal(part(row, "upq-name").textContent, REC_NAME);
  assert.match(row.text(), /245\.7MB/, "크기를 말한다");
  await tick(3000);
  assert.ok(panel(h) && rows(h).length === 1, "3초가 지나도 칸이 남아 있다(옛 알림은 2.8초 뒤 사라졌다)");
  assert.equal(h.xhrs[0].settled, false, "전제: 아직 올리는 중");
  assert.equal(btnOf(row).textContent, "취소", "올리는 중엔 [취소]");
  assert.equal(btnOf(row).hidden, false);
});
t("P2 진행률 — 보낸 바이트가 오면 퍼센트·막대·«N 중 M를 올렸어요» 가 바뀐다", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  dropOnTerm(h, [REC()]);
  await until(() => h.xhrs.length === 1, "XHR");
  h.xhrs[0].progress(128_803_774);
  const [row] = rows(h);
  assert.equal(part(row, "upq-pct").textContent, "50%");
  assert.equal(part(row, "upq-bar").attrs["aria-valuenow"], "50");
  assert.equal(part(row, "upq-bar").children[0].style.width, "50%");
  assert.equal(part(row, "upq-sub").textContent, "245.7MB 중 122.8MB를 올렸어요.");
});
t("P3 경계 — 크기만큼 다 보냈는데 서버 답이 오기 전엔 «저장을 마치는 중» 이고 [취소]를 감춘다(멈춰도 파일이 남을 수 있는 구간)", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  dropOnTerm(h, [REC()]);
  await until(() => h.xhrs.length === 1, "XHR");
  h.xhrs[0].progress(257_607_548);
  const [row] = rows(h);
  assert.equal(part(row, "upq-pct").textContent, "100%");
  assert.equal(part(row, "upq-sub").textContent, "다 보냈어요. 저장을 마치는 중이에요.");
  assert.equal(btnOf(row).hidden, true);
  assert.equal(pathsSent(h).length, 0, "서버 답 전엔 경로를 넣지 않는다");
});
t("P3b 경계 — 크기보다 1바이트 덜 보냈으면 99% 이고 [취소]가 보인다", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  dropOnTerm(h, [REC()]);
  await until(() => h.xhrs.length === 1, "XHR");
  h.xhrs[0].progress(257_607_547);
  const [row] = rows(h);
  assert.equal(part(row, "upq-pct").textContent, "99%");
  assert.equal(btnOf(row).hidden, false);
  assert.equal(btnOf(row).textContent, "취소");
});
t("P4 끝나면 — 경로가 입력창(PTY)에 정확히 한 번 · 줄은 «다 올렸어요» · 잠시 뒤 줄과 칸이 걷힌다", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  dropOnTerm(h, [REC()]);
  await until(() => h.xhrs.length === 1, "XHR");
  h.xhrs[0].respond(200, { ok: true, path: "/work/shared/project/5133/uploads/" + REC_NAME });
  await until(() => pathsSent(h).length === 1, "경로 삽입");
  assert.deepEqual(pathsSent(h), [" '/work/shared/project/5133/uploads/" + REC_NAME + "' "]);
  const [row] = rows(h);
  assert.equal(row.attrs["data-state"], "done");
  assert.match(part(row, "upq-sub").textContent, /^다 올렸어요\. 경로를 입력창에 넣었어요\./);
  assert.equal(btnOf(row).textContent, "닫기");
  await until(() => !panel(h), "칸이 걷힌다");
  assert.equal(pathsSent(h).length, 1, "경로는 한 번뿐");
});
t("P4b 서버가 본문 없이 200 으로 답하면 — 종전처럼 상대경로 'uploads/<이름>' 을 넣는다", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  dropOnTerm(h, [file("shot.png", 10, 1, "image/png")]);
  await until(() => h.xhrs.length === 1, "XHR");
  h.xhrs[0].respond(200, null);
  await until(() => pathsSent(h).length === 1, "경로 삽입");
  assert.deepEqual(pathsSent(h), [" 'uploads/shot.png' "]);
});
t("P5 ★신고 — 올리는 중 같은 파일을 다시 놓으면 다시 올리지 않고 «이미 올리고 있는 파일» 이라고 알린다 · 끝나도 경로는 한 번", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  dropOnTerm(h, [REC()]);
  await until(() => h.puts().length === 1, "첫 PUT");
  dropOnTerm(h, [REC()]);   // 같은 파일(이름·크기·수정 시각)을 다시 놓았다 — 브라우저는 새 File 객체를 준다
  await tick(30);
  assert.equal(h.puts().length, 1, `두 번째 업로드가 나갔다: ${JSON.stringify(h.puts())}`);
  assert.ok(h.toasts().some((s) => /이미 올리고 있는 파일이에요/.test(s) && s.includes(REC_NAME)), `알림: ${JSON.stringify(h.toasts())}`);
  assert.equal(rows(h).length, 1, "줄도 하나");
  assert.equal(rows(h)[0].cls.has("upq-flash"), true, "이미 올라가는 줄을 짚어 준다");
  h.xhrs[0].respond(200, { path: "/w/uploads/" + REC_NAME });
  await until(() => pathsSent(h).length === 1, "경로");
  await tick(20);
  assert.equal(pathsSent(h).length, 1, "경로가 입력창에 두 번 들어가지 않는다");
});
t("P6 ★신고 — 다른 파일이 같은 이름으로 함께 올라가면 두 번째는 겹치지 않는 이름(-2)으로 간다(목록이 비어 있어도)", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  dropOnTerm(h, [file("rec.mp4", 100, 1)]);
  await until(() => h.puts().length === 1, "첫 PUT");
  dropOnTerm(h, [file("rec.mp4", 200, 2)]);
  await until(() => h.puts().length === 2, "둘째 PUT");
  assert.ok(h.puts()[0].includes(encodeURIComponent("uploads/rec.mp4")), h.puts()[0]);
  assert.ok(h.puts()[1].includes(encodeURIComponent("uploads/rec-2.mp4")), `둘째가 같은 이름으로 갔다: ${h.puts()[1]}`);
  assert.equal(part(rows(h)[1], "upq-name").textContent, "rec-2.mp4", "칸도 실제 이름을 보인다");
});
t("P6b 목록을 못 읽어도(폴더 없음) 함께 올라가는 같은 이름은 피한다", async () => {
  const h = await makeCtx({ lsFail: true });
  h.mod.setupTermDrop();
  dropOnTerm(h, [file("rec.mp4", 100, 1)]);
  await until(() => h.puts().length === 1, "첫 PUT");
  dropOnTerm(h, [file("rec.mp4", 200, 2)]);
  await until(() => h.puts().length === 2, "둘째 PUT");
  assert.ok(h.lsCalls() >= 2, "배선: 목록을 읽으려 했다");
  assert.ok(h.puts()[1].includes(encodeURIComponent("uploads/rec-2.mp4")), `둘째: ${h.puts()[1]}`);
});
t("P7 [취소] — 보내던 요청을 끊고 줄을 걷는다 · 경로 0 · 실패로 말하지 않는다 · 창 닫기 경고를 거둔다", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  dropOnTerm(h, [REC()]);
  await until(() => h.xhrs.length === 1, "XHR");
  h.xhrs[0].progress(1000);
  assert.equal(guards(h), 1, "전제: 올리는 동안 경고가 걸려 있다");
  btnOf(rows(h)[0]).click();
  await tick(20);
  assert.equal(h.xhrs[0].aborted, true, "요청을 끊는다");
  assert.equal(panel(h), null, "줄과 칸이 걷힌다");
  assert.equal(pathsSent(h).length, 0);
  assert.ok(h.toasts().some((s) => /취소했어요/.test(s)), "취소했다고 알린다");
  assert.ok(!h.toasts().some((s) => /못했어요|실패/.test(s)), "실패로 말하지 않는다");
  assert.equal(guards(h), 0, "창 닫기 경고를 거둔다");
});
t("P8 서버가 거절하면(413) — 이유와 함께 줄이 남는다(저절로 걷히지 않는다) · [닫기]로 걷힌다 · 경로 0", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  dropOnTerm(h, [REC()]);
  await until(() => h.xhrs.length === 1, "XHR");
  h.xhrs[0].respond(413, { error: "파일이 너무 큽니다(1GB 초과)" });
  await until(() => !!rows(h)[0] && rows(h)[0].attrs["data-state"] === "fail", "실패 줄");
  const [row] = rows(h);
  assert.equal(part(row, "upq-sub").textContent, "올리지 못했어요. 파일이 너무 큽니다(1GB 초과)");
  await tick(120);   // 다 올린 줄을 걷는 시간(40ms)보다 오래
  assert.equal(rows(h).length, 1, "실패 줄은 사람이 닫을 때까지 남는다");
  assert.equal(btnOf(row).textContent, "닫기");
  btnOf(row).click();
  assert.equal(panel(h), null);
  assert.equal(pathsSent(h).length, 0);
  assert.equal(guards(h), 0);
});
t("P9 네트워크가 끊기면 «네트워크 연결이 끊겼어요.» · 본문 없는 403 은 막은 곳(보안 프로그램)을 짚는다 · 앞 파일이 실패해도 다음은 간다", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  dropOnTerm(h, [file("a.mp4", 10, 1), file("b.mp4", 10, 2)]);
  await until(() => h.xhrs.length === 1, "첫 XHR");
  h.xhrs[0].netFail();
  await until(() => h.xhrs.length === 2, "둘째 XHR");
  h.xhrs[1].respond(403, null);
  await until(() => rows(h).length === 2 && rows(h).every((r) => r.attrs["data-state"] === "fail"), "두 줄 다 실패");
  assert.equal(part(rows(h)[0], "upq-sub").textContent, "올리지 못했어요. 네트워크 연결이 끊겼어요.");
  assert.match(part(rows(h)[1], "upq-sub").textContent, /오류를 돌려줬어요\(403\)\..*보안 프로그램/);
});
t("P10 창 닫기 경고 — 올리는 동안 beforeunload 를 하나만 걸고(부르면 막는다) 다 끝나면 뗀다", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  assert.equal(guards(h), 0, "올리기 전엔 없다");
  dropOnTerm(h, [REC()]);
  await until(() => h.xhrs.length === 1, "XHR");
  const ls = h.winL.get("beforeunload") || [];
  assert.equal(ls.length, 1, "올리는 동안 하나");
  const ev: any = { defaultPrevented: false, returnValue: undefined, preventDefault() { this.defaultPrevented = true; } };
  ls[0](ev);
  assert.equal(ev.defaultPrevented, true, "브라우저가 묻게 한다");
  assert.equal(ev.returnValue, "", "옛 브라우저용 returnValue");
  dropOnTerm(h, [file("other.png", 5, 9, "image/png")]);   // 둘째 파일이 와도 하나만
  await until(() => h.xhrs.length === 2, "둘째 XHR");
  assert.equal(guards(h), 1);
  h.xhrs[0].respond(200, { path: "/w/uploads/a.mp4" });
  await tick(20);
  assert.equal(guards(h), 1, "아직 하나가 남았다");
  h.xhrs[1].respond(200, { path: "/w/uploads/other.png" });
  await until(() => guards(h) === 0, "다 끝나면 뗀다");
});
t("P11 데스크톱 앱 안에서는 창 닫기 경고를 걸지 않는다(Electron 은 묻지 않고 조용히 닫기를 취소한다)", async () => {
  const h = await makeCtx({ desktopApp: true });
  h.mod.setupTermDrop();
  dropOnTerm(h, [REC()]);
  await tick(30);
  assert.equal(guards(h), 0);
});
t("P12 여러 파일을 한 번에 — 두 줄이 바로 뜨고(둘째는 «차례를 기다리고 있어요.») 하나씩 보낸다 · 경로는 놓은 순서", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  dropOnTerm(h, [file("1.png", 10, 1, "image/png"), file("2.png", 20, 2, "image/png")]);
  await until(() => h.xhrs.length === 1, "첫 XHR");
  assert.equal(rows(h).length, 2, "둘 다 바로 보인다");
  assert.equal(part(rows(h)[1], "upq-sub").textContent, "차례를 기다리고 있어요.");
  assert.equal(btnOf(rows(h)[1]).textContent, "취소");
  await tick(20);
  assert.equal(h.xhrs.length, 1, "하나씩 보낸다");
  h.xhrs[0].respond(200, { path: "/w/uploads/1.png" });
  await until(() => h.xhrs.length === 2, "둘째 XHR");
  h.xhrs[1].respond(200, { path: "/w/uploads/2.png" });
  await until(() => pathsSent(h).length === 2, "경로 둘");
  assert.deepEqual(pathsSent(h), [" '/w/uploads/1.png' ", " '/w/uploads/2.png' "]);
});
t("P13 기다리는 파일을 [취소]하면 그 파일은 보내지 않는다 · 앞 파일은 그대로 간다", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  dropOnTerm(h, [file("1.png", 10, 1, "image/png"), file("2.png", 20, 2, "image/png")]);
  await until(() => h.xhrs.length === 1, "첫 XHR");
  btnOf(rows(h)[1]).click();
  assert.equal(rows(h).length, 1, "기다리던 줄이 걷힌다");
  h.xhrs[0].respond(200, { path: "/w/uploads/1.png" });
  await until(() => pathsSent(h).length === 1, "앞 파일 경로");
  await tick(30);
  assert.equal(h.xhrs.length, 1, "취소한 파일은 보내지 않는다");
  assert.deepEqual(pathsSent(h), [" '/w/uploads/1.png' "]);
});
t("P14 다 올린 뒤 같은 파일을 다시 놓으면 새로 올린다(장부에서 빠졌다) — 목록에 이미 있으니 -2", async () => {
  const h = await makeCtx();
  h.mod.setupTermDrop();
  dropOnTerm(h, [file("rec.mp4", 100, 1)]);
  await until(() => h.xhrs.length === 1, "첫 XHR");
  h.xhrs[0].respond(200, { path: "/w/uploads/rec.mp4" });
  await until(() => pathsSent(h).length === 1, "첫 경로");
  h.ls.push("rec.mp4");
  dropOnTerm(h, [file("rec.mp4", 100, 1)]);
  await until(() => h.xhrs.length === 2, "둘째 XHR");
  assert.ok(h.xhrs[1].url.includes(encodeURIComponent("uploads/rec-2.mp4")), h.xhrs[1].url);
});
t("P15 폰 — 칸은 터미널 판(#panes) 안이라 입력 바(#mdock) 위에 서고, 다 올리면 경로는 글 상자로 간다", async () => {
  const h = await makeCtx({ mobile: true });
  h.mod.setupMobileDock(h.main);
  const dock = h.main.find((n) => n.attrs.id === "mdock");
  assert.ok(dock, "전제: 입력 바");
  void h.mod.attachFilesToAgent([file("IMG_0001.jpeg", 30, 5, "image/jpeg")]);
  await until(() => h.puts().length >= 1, "PUT");
  const p = panel(h);
  assert.ok(p, "칸이 떠야 한다");
  assert.equal(h.zone.contains(p), true, "판 안");
  assert.equal(dock!.contains(p), false, "입력 바 안이 아니다");
  h.xhrs[0].respond(200, { path: "/w/uploads/IMG_0001.jpeg" });
  const comp = h.main.find((n) => n.tag === "textarea");
  await until(() => !!comp && comp.value.includes("IMG_0001.jpeg"), "글 상자");
  assert.equal(pathsSent(h).length, 0, "PTY 로는 안 간다");
  assert.match(part(rows(h)[0], "upq-sub").textContent, /입력칸에 넣었어요/);
});
t("P16 파일 탐색기에 놓은 파일도 같은 칸에 줄이 서고 지금 폴더로 간다 · 끝나면 «다 올렸어요.» · 경로는 넣지 않는다", async () => {
  const h = await makeCtx();
  h.mod.setupDnd();
  h.explorer.fire("drop", { dataTransfer: { types: ["Files"], files: [file("doc.pdf", 50, 1, "application/pdf")] }, preventDefault() { /* noop */ } });
  await until(() => h.puts().length === 1, "PUT");
  assert.ok(h.puts()[0].includes("path=doc.pdf"), `지금 폴더(최상위)로: ${h.puts()[0]}`);
  assert.equal(rows(h).length, 1, "같은 칸");
  h.xhrs[0].respond(200, { ok: true });
  await until(() => !!rows(h)[0] && rows(h)[0].attrs["data-state"] === "done", "다 올림");
  assert.equal(part(rows(h)[0], "upq-sub").textContent, "다 올렸어요.");
  assert.equal(pathsSent(h).length, 0, "탐색기 업로드는 경로를 입력창에 넣지 않는다(종전 그대로)");
});
t("P17 요청 머리 — 본문은 octet-stream(.json 이 전역 json 파서에 먹히지 않게) · 토큰이 있으면 Bearer · 이 세션 주소", async () => {
  const h = await makeCtx({ token: "tok-5361" });
  h.mod.setupTermDrop();
  dropOnTerm(h, [file("data.json", 10, 1, "application/json")]);
  await until(() => h.xhrs.length === 1, "XHR");
  const x = h.xhrs[0];
  assert.equal(x.method, "PUT");
  assert.equal(x.headers["Content-Type"], "application/octet-stream");
  assert.equal(x.headers["Authorization"], "Bearer tok-5361");
  assert.ok(x.url.startsWith("/api/ui/terminal/sessions/t-5361/file?path=") && x.url.includes(encodeURIComponent("uploads/data.json")), x.url);
});
t("P18 터미널 판이 서기 전(판 없음)에 이미지를 붙여넣어도 칸은 body 에 서고 오류 없이 올라간다", async () => {
  const h = await makeCtx({ noPanes: true });
  h.mod.setupPaste();   // 판이 없으면 body 에서 받는다(종전)
  const ev: any = { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file("image.png", 12, 7, "image/png") }], getData: () => "" }, preventDefault() { /* noop */ }, stopImmediatePropagation() { /* noop */ } };
  h.body.fire("paste", ev);
  await until(() => h.puts().length === 1, "PUT");
  assert.ok(panelIn(h.body), "칸이 body 에 선다");
  h.xhrs[0].respond(200, { path: "/w/uploads/image.png" });
  await until(() => pathsSent(h).length === 1, "경로");
});
t("P19 진행률을 주지 않는 XHR(upload 없음)이어도 올라가고 경로가 들어간다", async () => {
  const h = await makeCtx({ noUploadProp: true });
  h.mod.setupTermDrop();
  dropOnTerm(h, [file("a.png", 10, 1, "image/png")]);
  await until(() => h.xhrs.length === 1, "XHR");
  assert.equal(h.xhrs[0].upload, undefined, "전제: 진행률 없음");
  assert.equal(part(rows(h)[0], "upq-pct").textContent, "0%");
  h.xhrs[0].respond(200, { path: "/w/uploads/a.png" });
  await until(() => pathsSent(h).length === 1, "경로");
});

// 화면 핸들러(async)가 던진 오류는 테스트 함수 밖에서 터진다 — 파일 전체를 죽이지 말고 그 행의 실패로 센다.
const stray: unknown[] = [];
process.on("unhandledRejection", (e) => { stray.push(e); });

async function main(): Promise<void> {
  let pass = 0; const fails: Array<[string, unknown]> = [];
  for (const [name, fn] of tests) {
    stray.length = 0;
    try {
      await fn();
      await tick(10);
      if (stray.length) throw new Error(`처리되지 않은 오류: ${(stray[0] as Error)?.message || String(stray[0])}`);
      pass++; console.log(`ok  ${name}`);
    } catch (e) { fails.push([name, e]); console.error(`FAIL ${name}\n  ${(e as Error)?.message}`); }
  }
  console.log(`\n${pass}/${tests.length} pass${fails.length ? ` · ${fails.length} FAIL` : ""}`);
  setTimeout(() => process.exit(fails.length ? 1 : 0), 50); // 알림 타이머(2.8초)가 프로세스를 붙들지 않게
}
void main();
