// #4229 후속(원준 2026-09-26 코멘트) — 폰 입력 줄 2차 회귀 테스트.
//  글쇠 줄(Tab·^C·1·2·3 빼기, 손을 뗄 때 누름) · 보내기(단추 하나, 자판 리턴은 줄바꿈) · 쓰던 글 보존 · 글 상자 포커스 알림 ·
//  «번호로 고르기» 판정 · 모드 판정 · 모드 바꾸기(매번 화면으로 확인).
//  사양·엣지 표는 케이스 이름이 곧 행이다(M = 입력 줄, C = 번호 판정, E = 모드 판정, S = 모드 바꾸기).
// fail-first: 고치기 전 산출 모듈(TERMJS_MOD=<origin/main 의 web/standalone 컴파일본>)로 돌리면 M1·M2·M3·M5·M6·M8·M9 와
//  C·E·S 전부(함수 미노출)가 빨간불이다(실측 3/26). M4·M7·M10 은 종전 동작 보존 행이라 그때도 초록. 새 함수는 변이로도 쟀다:
//  cursor 요구 빼기 → C2 · 모드 8줄 창 넓히기 → E3 · stuck 멈춤 빼기 → S4 가 빨간불.
// 실행: npm run build && node dist/terminal/terminal-client-mdock.test.js
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MOD_PATH = process.env.TERMJS_MOD || path.resolve(here, "..", "standalone", "terminal.js");
const MOD_URL = pathToFileURL(MOD_PATH).href;
let seq = 0;

type Listener = (ev: any) => void;

// 가짜 DOM 노드 — 모듈이 쓰는 만큼만(terminal-client-attach.test.ts 와 같은 틀).
class FakeNode {
  tag: string;
  nodeType = 1;
  className = "";
  textContent = "";
  value = "";
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  hidden = false;
  focused = 0;
  blurred = 0;
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
  blur(): void { this.blurred++; }
  append(...nodes: any[]): void { for (const n of nodes) { if (n && n.parent) n.parent.removeChild(n); if (n && typeof n === "object") n.parent = this; this.children.push(n); } }
  prepend(...nodes: any[]): void { for (const n of nodes.reverse()) { if (n && typeof n === "object") n.parent = this; this.children.unshift(n); } }
  removeChild(n: any): void { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parent = null; }
  remove(): void { if (this.parent) this.parent.removeChild(this); }
  replaceChildren(...nodes: any[]): void { this.children = []; this.append(...nodes); }
  contains(n: any): boolean { for (let c = n; c; c = c.parent) if (c === this) return true; return false; }
  querySelector(): any { return null; }
  querySelectorAll(): any[] { return []; }
  find(pred: (n: FakeNode) => boolean): FakeNode | null {
    for (const c of this.children) { if (!(c instanceof FakeNode)) continue; if (pred(c)) return c; const d = c.find(pred); if (d) return d; }
    return null;
  }
}

interface Harness { mod: any; main: FakeNode; sent: string[]; posted: any[]; session: Record<string, string>; doc: any; fireDoc: (type: string, ev: any) => void }

async function makeCtx(opts: { session?: Record<string, string>; parent?: boolean } = {}): Promise<Harness> {
  const g: any = globalThis;
  const def = (k: string, v: unknown): void => { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  const sent: string[] = [];
  const posted: any[] = [];
  const session = opts.session || {};
  const body = new FakeNode("body");
  def("window", g); def("self", g);
  def("parent", opts.parent === false ? g : { postMessage: (m: any, origin: string) => posted.push({ m, origin }) });
  def("addEventListener", () => { /* noop */ });
  def("removeEventListener", () => { /* noop */ });
  const docL = new Map<string, Listener[]>();
  const doc = {
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text, parent: null }),
    body, getElementById: () => null, querySelector: () => null,
    addEventListener(type: string, fn: Listener) { const a = docL.get(type) || []; a.push(fn); docL.set(type, a); },
    removeEventListener(type: string, fn: Listener) { const a = docL.get(type) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    activeElement: null as any,
    title: "", hidden: false,
  };
  def("document", doc);
  const fireDoc = (type: string, ev: any): void => { for (const fn of [...(docL.get(type) || [])]) fn({ preventDefault() { /* noop */ }, ...ev }); };
  def("navigator", { platform: "iPhone", vendor: "Apple Computer, Inc.", userAgent: "Mozilla/5.0 (iPhone) Safari", userActivation: { isActive: false }, clipboard: {} });
  def("location", { search: "?session=t-4229&mobile=1", pathname: "/ui/terminal.html", protocol: "https:", host: "test", origin: "https://test" });
  const store: Record<string, string> = {};
  def("localStorage", { getItem: (k: string) => (k in store ? store[k] : null), setItem(k: string, v: string) { store[k] = v; }, removeItem(k: string) { delete store[k]; } });
  def("sessionStorage", { getItem: (k: string) => (k in session ? session[k] : null), setItem(k: string, v: string) { session[k] = String(v); }, removeItem(k: string) { delete session[k]; } });
  def("isSecureContext", true);
  def("WebSocket", class { /* not used */ });
  def("ResizeObserver", class { observe() { /* noop */ } });
  def("BroadcastChannel", class { onmessage = null; });
  def("matchMedia", () => ({ matches: false, addEventListener() { /* noop */ } }));
  def("requestAnimationFrame", (f: () => void) => setTimeout(f, 0));
  def("scrollTo", () => { /* noop */ });
  def("TERMJS_BUILD", "test");
  def("fetch", () => Promise.resolve({ ok: true, status: 200, json: async () => ({ items: [] }) }));
  const mod: any = await import(`${MOD_URL}?n=${++seq}`);
  const main = new FakeNode("div");
  mod.__injectRefsForTest({
    ws: { readyState: 1, send: (s: string) => { try { sent.push(JSON.parse(s).d); } catch (_) { sent.push(s); } } },
    term: { cols: 80, rows: 24, textarea: new FakeNode("textarea"), modes: {}, buffer: { active: { type: "normal", length: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => null } } },
    fit: null, panesEl: new FakeNode("div"), explorerEl: new FakeNode("aside"),
  });
  return { mod, main, sent, posted, session, doc, fireDoc };
}

const dock = (h: Harness): FakeNode | null => h.main.find((n) => n.attrs.id === "mdock");
const keyRow = (h: Harness): FakeNode | null => h.main.find((n) => /(^|\s)mkeys(\s|$)/.test(n.className));
const keyLabels = (h: Harness): string[] => (keyRow(h)?.children || []).filter((k: any) => k instanceof FakeNode && !k.hidden).map((k: any) => k.textContent || k.attrs.title || "");
const keyByLabel = (h: Harness, label: string): FakeNode => {
  const k = (keyRow(h)?.children || []).find((c: any) => c instanceof FakeNode && c.textContent === label);
  assert.ok(k, `글쇠 «${label}» 가 있어야 한다: ${JSON.stringify(keyLabels(h))}`);
  return k as FakeNode;
};
const composer = (h: Harness): FakeNode => { const c = h.main.find((n) => n.tag === "textarea"); assert.ok(c, "전제: 글 상자"); return c!; };
const sendBtn = (h: Harness): FakeNode => { const b = h.main.find((n) => /(^|\s)msend(\s|$)/.test(n.className)); assert.ok(b, "전제: 보내기 단추"); return b!; };
const touch = (x: number, y: number) => ({ clientX: x, clientY: y });
const tapStart = (b: FakeNode, x = 10, y = 10): void => { b.fire("touchstart", { touches: [touch(x, y)], preventDefault() { /* noop */ } }); };
const tapEnd = (b: FakeNode, x = 10, y = 10): void => { b.fire("touchend", { changedTouches: [touch(x, y)], preventDefault() { /* noop */ } }); };
const press = (b: FakeNode): void => { tapStart(b); tapEnd(b); };
const key = (c: FakeNode, init: Record<string, unknown>): any => c.fire("keydown", { key: "Enter", keyCode: 13, isComposing: false, shiftKey: false, metaKey: false, ctrlKey: false, preventDefault() { /* noop */ }, ...init });

// ── 미니 async 러너 ──
const tests: Array<[string, () => Promise<void> | void]> = [];
const t = (name: string, fn: () => Promise<void> | void): void => { tests.push([name, fn]); };

t("M1 평소 글쇠 줄 — Tab·^C(중단)·1·2·3 이 없고 Esc·⏎·↑·↓·모드·←·→·복사·붙여넣기가 있다", async () => {
  const h = await makeCtx();
  h.mod.setupMobileDock(h.main);
  assert.ok(dock(h), "입력 줄이 선다");
  const labels = keyLabels(h);
  for (const gone of ["Tab", "^C", "중단", "1", "2", "3"]) assert.ok(!labels.includes(gone), `«${gone}» 는 없어야 한다: ${JSON.stringify(labels)}`);
  for (const want of ["Esc", "⏎", "↑", "↓", "←", "→", "복사", "붙여넣기"]) assert.ok(labels.includes(want), `«${want}» 가 있어야 한다: ${JSON.stringify(labels)}`);
  assert.ok(labels.some((l) => /방식|모드/.test(l)), `모드 단추: ${JSON.stringify(labels)}`);
});
t("M2 글쇠는 손을 뗄 때 누른다 — 닿기만 하면 아무것도 안 나가고, 제자리에서 떼면 Esc 가 나간다", async () => {
  const h = await makeCtx();
  h.mod.setupMobileDock(h.main);
  const esc = keyByLabel(h, "Esc");
  tapStart(esc);
  assert.deepEqual(h.sent, [], "닿는 순간엔 아무것도 안 보낸다(줄을 밀려고 댄 손가락)");
  tapEnd(esc);
  assert.deepEqual(h.sent, ["\x1b"]);
});
t("M3 글쇠 줄을 밀면(10px 넘게 움직임) 누른 게 아니다 · 경계 10px 정확히는 누른 것", async () => {
  const h = await makeCtx();
  h.mod.setupMobileDock(h.main);
  const esc = keyByLabel(h, "Esc");
  tapStart(esc, 100, 10); tapEnd(esc, 89, 10);   // 11px
  assert.deepEqual(h.sent, [], "민 것은 안 보낸다");
  tapStart(esc, 100, 10); tapEnd(esc, 90, 10);   // 정확히 10px
  assert.deepEqual(h.sent, ["\x1b"], "10px 은 누른 것");
});
t("M4 보내기 — 글이 있으면 글과 Enter 를 보내고 글 상자를 비운다(보존)", async () => {
  const h = await makeCtx();
  h.mod.setupMobileDock(h.main);
  const c = composer(h);
  c.value = "안녕하세요";
  press(sendBtn(h));
  assert.deepEqual(h.sent, ["안녕하세요", "\r"]);
  assert.equal(c.value, "");
});
t("M5 보내기 — 빈 글·공백만이면 아무것도 안 보낸다", async () => {
  const h = await makeCtx();
  h.mod.setupMobileDock(h.main);
  const c = composer(h);
  press(sendBtn(h));
  c.value = "   ";
  press(sendBtn(h));
  assert.deepEqual(h.sent, [], `빈 Enter 가 새지 않는다: ${JSON.stringify(h.sent)}`);
});
t("M6 자판의 리턴(수식키 없는 Enter)은 보내지 않는다 — 줄바꿈은 브라우저 기본", async () => {
  const h = await makeCtx();
  h.mod.setupMobileDock(h.main);
  const c = composer(h);
  c.value = "첫 줄";
  const ev = key(c, {});
  assert.deepEqual(h.sent, [], "보내지 않는다");
  assert.equal(c.value, "첫 줄", "글은 그대로");
  assert.notEqual(ev.defaultPrevented, true, "줄바꿈을 막지 않는다");
});
t("M7 ⌘/Ctrl+Enter 는 보낸다(하드웨어 자판) · 한글 조합 중이면 안 보낸다", async () => {
  const h = await makeCtx();
  h.mod.setupMobileDock(h.main);
  const c = composer(h);
  c.value = "조합";
  key(c, { ctrlKey: true, isComposing: true, keyCode: 229 });
  assert.deepEqual(h.sent, [], "조합 중 Enter 는 확정이다");
  key(c, { ctrlKey: true });
  assert.deepEqual(h.sent, ["조합", "\r"]);
  c.value = "맥";
  key(c, { metaKey: true });
  assert.deepEqual(h.sent, ["조합", "\r", "맥", "\r"]);
});
t("M8 쓰던 글은 이 탭 저장소에 남고, 입력 줄을 새로 세우면 되살아난다 · 보내면 지워진다", async () => {
  const session: Record<string, string> = {};
  const h = await makeCtx({ session });
  h.mod.setupMobileDock(h.main);
  const c = composer(h);
  c.value = "쓰다 만 글";
  c.fire("input");
  assert.equal(session["lively:mdraft:t-4229"], "쓰다 만 글", "세션별 열쇠로 남는다");
  const h2 = await makeCtx({ session });
  h2.mod.setupMobileDock(h2.main);
  assert.equal(composer(h2).value, "쓰다 만 글", "화면이 다시 떠도 되살아난다");
  press(sendBtn(h2));
  assert.equal(session["lively:mdraft:t-4229"], undefined, "보냈으면 지운다");
});
t("M9 글 상자 포커스를 세션 화면(부모)에 알린다 — 초점 들어오면 true, 나가면 false, 같은 오리진으로", async () => {
  const h = await makeCtx();
  h.mod.setupMobileDock(h.main);
  const c = composer(h);
  c.fire("focus"); c.fire("blur");
  const mine = h.posted.filter((p) => p.m && p.m.type === "lively-term-composer");
  assert.deepEqual(mine.map((p) => p.m.focus), [true, false]);
  assert.ok(mine.every((p) => p.origin === "https://test"), "대상 오리진을 * 로 두지 않는다");
});
t("M10 부모가 없으면(단독 탭) 알리지 않는다 · 오류 없음", async () => {
  const h = await makeCtx({ parent: false });
  h.mod.setupMobileDock(h.main);
  const c = composer(h);
  c.fire("focus"); c.fire("blur");
  assert.equal(h.posted.length, 0);
});

// ── 번호로 고르기 판정 ──
const tail = (...lines: Array<string | undefined>): Array<string | undefined> => lines;
t("C1 «❯ 1. / 2. / 3.» → 3", async () => {
  const { mod } = await makeCtx();
  assert.equal(mod.detectChoiceCount(tail(" Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again", "   3. No, and tell Claude")), 3);
});
t("C2 고르는 표시 없는 번호 목록 → 0(AI 가 쓴 글)", async () => {
  const { mod } = await makeCtx();
  assert.equal(mod.detectChoiceCount(tail("1. 첫째", "2. 둘째", "3. 셋째")), 0);
});
t("C3 고르는 표시 + 1 하나뿐 → 0", async () => {
  const { mod } = await makeCtx();
  assert.equal(mod.detectChoiceCount(tail("❯ 1. 하나")), 0);
});
t("C4 2 부터 시작(1 없음) → 0", async () => {
  const { mod } = await makeCtx();
  assert.equal(mod.detectChoiceCount(tail("❯ 2. 둘", "3. 셋")), 0);
});
t("C5 인용 «> 1. / > 2.» → 0", async () => {
  const { mod } = await makeCtx();
  assert.equal(mod.detectChoiceCount(tail("> 1. 인용 하나", "> 2. 인용 둘")), 0);
});
t("C6 테두리 «│ ❯ 1. / │ 2.» → 2 · 코덱스 «› 1. / 2.» → 2", async () => {
  const { mod } = await makeCtx();
  assert.equal(mod.detectChoiceCount(tail("│ ❯ 1. 예", "│   2. 아니오")), 2);
  assert.equal(mod.detectChoiceCount(tail("› 1. Yes", "  2. No")), 2);
});
t("C7 빈 줄·undefined 섞여도 무해 · 빈 목록 → 0", async () => {
  const { mod } = await makeCtx();
  assert.equal(mod.detectChoiceCount(tail(undefined, "", "❯ 1. a", undefined, "2. b")), 2);
  assert.equal(mod.detectChoiceCount([]), 0);
});
t("C8 경계 — 1~12 가 이어져도 단추는 9 까지", async () => {
  const { mod } = await makeCtx();
  const lines = Array.from({ length: 12 }, (_, i) => (i === 0 ? "❯ " : "  ") + (i + 1) + ". 항목");
  assert.equal(mod.detectChoiceCount(lines), 9);
});

// ── 모드 판정 ──
t("E1 상태 줄의 네 방식 → 제 열쇠", async () => {
  const { mod } = await makeCtx();
  assert.equal(mod.detectMode(["⏵⏵ accept edits on (shift+tab to cycle)"]), "acceptEdits");
  assert.equal(mod.detectMode(["⏸ plan mode on (shift+tab to cycle)"]), "plan");
  assert.equal(mod.detectMode(["▸▸ auto mode on (shift+tab to cycle) · esc to interrupt"]), "auto");
  assert.equal(mod.detectMode(["⏵⏵ bypass permissions on (shift+tab to cycle)"]), "bypass");
});
t("E2 «? for shortcuts» → 기본(하나씩 묻기) · 다른 방식 줄과 함께면 다른 방식이 이긴다", async () => {
  const { mod } = await makeCtx();
  assert.equal(mod.detectMode(["  ? for shortcuts"]), "default");
  assert.equal(mod.detectMode(["  ? for shortcuts", "⏵⏵ accept edits on"]), "acceptEdits");
});
t("E3 아무것도 없으면 '' · 모드 줄이 아래 8줄 밖이면 ''", async () => {
  const { mod } = await makeCtx();
  assert.equal(mod.detectMode(["그냥 출력", ""]), "");
  assert.equal(mod.detectMode(["▸▸ auto mode on", ...Array.from({ length: 8 }, () => "출력")]), "");
});

// ── 모드 바꾸기 ──
const fakeScreen = (seqModes: string[]) => {
  let i = 0; let presses = 0;
  return { presses: () => presses, deps: { read: () => seqModes[Math.min(i, seqModes.length - 1)], press: () => { presses++; i++; }, wait: async () => { /* noop */ } } };
};
const modeKey = (h: Harness): FakeNode => { const k = h.main.find((n) => n.cls.has("mkey-mode")); assert.ok(k, "전제: 모드 단추"); return k!; };
const sheetOf = (h: Harness): FakeNode | null => h.doc.body.find((n: FakeNode) => n.attrs.role === "dialog");
t("M11 폰 시트가 열리면 초점이 시트(대화상자)로 간다 · [완료](손가락)로 닫으면 연 자리로 초점을 돌려주지 않는다", async () => {
  const h = await makeCtx();
  h.mod.setupMobileDock(h.main);
  const c = composer(h);
  h.doc.activeElement = c;                       // 쓰던 중(자판이 떠 있다)에 모드 단추를 눌렀다
  const before = c.focused;
  press(modeKey(h));
  const sh = sheetOf(h);
  assert.ok(sh, "일하는 방식 시트가 떠야 한다");
  assert.equal(sh!.attrs["aria-modal"], "true", "대화상자다(뒤는 못 만진다)");
  assert.ok(sh!.focused >= 1, "초점이 시트로 간다(뒤 터미널로 글쇠가 새지 않는다)");
  const done = sh!.find((n) => n.tag === "button" && n.textContent === "완료");
  assert.ok(done, "전제: [완료]");
  done!.click();
  assert.equal(sheetOf(h), null, "닫힌다");
  assert.equal(c.focused, before, "손가락으로 닫으면 글 상자로 초점을 돌려주지 않는다(자판이 다시 튀어 오르지 않게)");
});
t("M12 Esc 로 닫으면 연 자리(글 상자)로 초점을 돌려준다 · 닫힌 뒤의 Esc 는 아무 일도 안 한다", async () => {
  const h = await makeCtx();
  h.mod.setupMobileDock(h.main);
  const c = composer(h);
  h.doc.activeElement = c;
  press(modeKey(h));
  assert.ok(sheetOf(h), "전제: 시트가 떴다");
  const before = c.focused;
  h.fireDoc("keydown", { key: "Escape" });
  assert.equal(sheetOf(h), null, "Esc 로 닫힌다");
  assert.equal(c.focused, before + 1, "연 자리로 초점을 돌려준다");
  h.fireDoc("keydown", { key: "Escape" });
  assert.equal(c.focused, before + 1, "닫힌 뒤의 Esc 로는 초점이 또 움직이지 않는다(듣는 이를 뗐다)");
});
t("S1 지금 방식을 못 읽으면 아무것도 안 누른다 → unknown", async () => {
  const { mod } = await makeCtx();
  const f = fakeScreen([""]);
  assert.equal(await mod.switchModeTo("plan", f.deps), "unknown");
  assert.equal(f.presses(), 0);
});
t("S2 이미 고른 방식이면 안 누른다 → ok", async () => {
  const { mod } = await makeCtx();
  const f = fakeScreen(["plan"]);
  assert.equal(await mod.switchModeTo("plan", f.deps), "ok");
  assert.equal(f.presses(), 0);
});
t("S3 default → acceptEdits → plan 에서 plan → 두 번 눌러 ok", async () => {
  const { mod } = await makeCtx();
  const f = fakeScreen(["default", "acceptEdits", "plan", "auto"]);
  assert.equal(await mod.switchModeTo("plan", f.deps), "ok");
  assert.equal(f.presses(), 2);
});
t("S4 눌렀는데 그대로 → 한 번에서 멈춘다(stuck) · 눌렀는데 못 읽어도 stuck", async () => {
  const { mod } = await makeCtx();
  const a = fakeScreen(["default", "default", "default"]);
  assert.equal(await mod.switchModeTo("plan", a.deps), "stuck");
  assert.equal(a.presses(), 1);
  const b = fakeScreen(["default", ""]);
  assert.equal(await mod.switchModeTo("plan", b.deps), "stuck");
  assert.equal(b.presses(), 1);
});
t("S5 한 바퀴 돌아 처음으로 오면(목표가 이 세션에 없음) 멈춘다 → absent", async () => {
  const { mod } = await makeCtx();
  const f = fakeScreen(["default", "acceptEdits", "plan", "default", "acceptEdits"]);
  assert.equal(await mod.switchModeTo("bypass", f.deps), "absent");
  assert.equal(f.presses(), 3, "처음 방식으로 돌아온 그 한 번까지만");
});

t("S6 바꾸는 중에 또 고르면 두 번째는 누르지 않고 busy · 앞의 것은 끝까지 가서 ok", async () => {
  const { mod } = await makeCtx();
  let i = 0; let presses = 0; let release: () => void = () => { /* 아래에서 채운다 */ };
  const screen = ["default", "acceptEdits"];
  const first = mod.switchModeTo("acceptEdits", {
    read: () => screen[Math.min(i, screen.length - 1)], press: () => { presses++; i++; },
    wait: () => new Promise<void>((r) => { release = r; }),
  });
  assert.equal(presses, 1, "전제: 앞의 것이 한 번 누르고 화면을 기다린다");
  const second = fakeScreen(["default", "plan"]);
  assert.equal(await mod.switchModeTo("plan", second.deps), "busy");
  assert.equal(second.presses(), 0, "두 번째는 Shift+Tab 을 보내지 않는다");
  release();
  assert.equal(await first, "ok", "앞의 것은 끝까지 간다");
  assert.equal(presses, 1);
});
t("S7 새 잠금의 풀림 — 앞의 바꾸기가 오류(throw)·stuck 으로 끝나도 다음 고르기는 막히지 않는다", async () => {
  const { mod } = await makeCtx();
  await assert.rejects(mod.switchModeTo("plan", { read: () => { throw new Error("화면 못 읽음"); }, press: () => { /* noop */ }, wait: async () => { /* noop */ } }));
  const a = fakeScreen(["default", "acceptEdits"]);
  assert.equal(await mod.switchModeTo("acceptEdits", a.deps), "ok", "오류 뒤에도 busy 가 아니다");
  assert.equal(a.presses(), 1);
  const b = fakeScreen(["default", "default"]);
  assert.equal(await mod.switchModeTo("plan", b.deps), "stuck");
  const c = fakeScreen(["default", "plan"]);
  assert.equal(await mod.switchModeTo("plan", c.deps), "ok", "stuck 뒤에도 busy 가 아니다");
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (e) { failed++; console.log(`not ok - ${name}\n  ${(e as Error).stack || e}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
setTimeout(() => process.exit(failed ? 1 : 0), 50);
