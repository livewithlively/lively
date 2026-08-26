// #1117 — 웹터미널 클라 입력·클립보드 경로 회귀 테스트.
// 단독 터미널 페이지 모듈(web/standalone/terminal.ts → dist/standalone/terminal.js)을 **그대로 import** 해
//  브라우저·백엔드·인증 없이 사양을 검증한다(#1084 하네스 방식의 계승).
//  #1313 R51 이전에는 손편집 public/terminal.js 를 Node vm 에 올리며 소스를 두 군데 변조했다(끝의 boot() 제거,
//  최상단 `let …`→`var …`). 이제 부팅 호출은 번들 엔트리에 있고(import 만으로 안 뜬다) 주입은 세터로 한다 —
//  소스 변조 0. 테스트마다 ?n= 로 새 모듈 인스턴스를 받아 모듈 전역 상태를 격리한다(종전 vm 컨텍스트 재생성 역할).
//  검증 대상 사양(엣지 표): 프로젝트 #1117 산출지식 참조 —
//   S 붙여넣기 위생(제어문자·ESC 제거, 브래킷 탈출 차단) · P 붙여넣기 단일 경로(#1084 보존) ·
//   C 복사(제스처 동기 우선·보류 플러시) · B Cmd+C 브리지 게이팅(앱 드래그 관측) ·
//   H 히든 textarea 위생(버그A 근본수정) · W 반복 전송 워치독 · O OSC52(사파리 사전 커밋).
// fail-first: TERMJS_MOD=<옛 산출 모듈 경로> 로 이 테스트를 돌리면 수정 전 코드에서 빨간불을 재현할 수 있다.
// 실행: npm run build && node dist/terminal/terminal-client-input.test.js
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MOD_PATH = process.env.TERMJS_MOD || path.resolve(here, "..", "standalone", "terminal.js");
const MOD_URL = pathToFileURL(MOD_PATH).href;
let seq = 0;

// 스텁 클립보드 아이템 — 모듈이 전역 ClipboardItem 을 생성자로 쓴다(사파리 사전 커밋 경로).
class ClipboardItemStub { items: any; constructor(items: any) { this.items = items; } }

type Listeners = Map<string, Function[]>;
const on = (m: Listeners, t: string, f: Function): void => { const a = m.get(t) || []; a.push(f); m.set(t, a); };
const off = (m: Listeners, t: string, f: Function): void => { const a = m.get(t) || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); };
const fire = (m: Listeners, t: string, ev?: unknown): void => { for (const f of [...(m.get(t) || [])]) f(ev || {}); };
// 사파리 IME 이벤트 시퀀스 헬퍼(#1300) — beforeinput(+뒤따르는 input)을 실기기 순서대로 흉내낸다.
const bi = (h: Harness, inputType: string, data: string): void => {
  h.term.textarea._fire("beforeinput", { inputType, data });
  h.term.textarea._fire("input", { inputType, data });
};

interface Harness {
  mod: any;                // import 한 모듈 네임스페이스(종전 vm 컨텍스트 자리)
  nav: any;                // navigator 스텁(테스트가 userActivation 등을 직접 조작)
  diag: () => string;      // window.livelyTermDiag — 모듈이 전역에 노출하는 진단 덤프
  term: any;
  panesEl: EventTarget;
  sent: string[];          // ws.send 원문
  execData: string[];      // 동기 copy 커밋 텍스트(copy 이벤트 setData)
  execCalls: () => number; // execCommand('copy') 호출 수
  writeTexts: string[];    // navigator.clipboard.writeText 성공 텍스트
  writeTextCalls: () => number; // writeText 호출 수(실패 포함)
  clipWrites: any[];       // navigator.clipboard.write 항목
  fireDoc: (t: string, ev?: unknown) => void;
  inputs: () => string[];  // {t:'i'} 페이로드만
  kev: (over: Record<string, unknown>) => any;
}

async function makeCtx(opts: { safari?: boolean; execOk?: boolean; writeTextOk?: boolean; readText?: string } = {}): Promise<Harness> {
  const sent: string[] = [];
  const execData: string[] = [];
  const writeTexts: string[] = [];
  const clipWrites: any[] = [];
  let execCallCount = 0;
  const docL: Listeners = new Map();
  const doc: any = {
    addEventListener: (t: string, f: Function) => on(docL, t, f),
    removeEventListener: (t: string, f: Function) => off(docL, t, f),
    execCommand: (cmd: string): boolean => {
      if (cmd !== "copy") return false;
      execCallCount++;
      if (opts.execOk === false) return false;
      let filled = false;
      const ev = {
        clipboardData: { setData: (_t: string, v: string) => { execData.push(v); filled = true; } },
        preventDefault() { /* noop */ }, stopImmediatePropagation() { /* noop */ },
      };
      fire(docL, "copy", ev);
      return filled; // 리스너가 채웠으면 성공(브라우저의 listener+preventDefault 성공 경로 모델)
    },
    createElement: (): any => ({
      value: "", style: {}, className: "", textContent: "", nodeType: 1,
      setAttribute() { /* noop */ }, addEventListener() { /* noop */ },
      append() { /* noop */ }, appendChild() { /* noop */ }, remove() { /* noop */ },
      focus() { /* noop */ }, select() { /* noop */ },
    }),
    createTextNode: (t: string): any => ({ nodeType: 3, textContent: t }),
    body: { appendChild() { /* noop */ }, removeChild() { /* noop */ }, append() { /* noop */ } },
    getElementById: () => null,
    title: "", hidden: false,
  };
  const taL: Listeners = new Map();
  const elL: Listeners = new Map();
  const term: any = {
    _keyHandler: null as Function | null,
    _onData: null as Function | null,
    _osc: {} as Record<number, Function>,
    _sel: null as string | null,
    attachCustomKeyEventHandler(f: Function) { term._keyHandler = f; },
    onData(f: Function) { term._onData = f; },
    attachCustomWheelEventHandler() { /* noop */ },
    hasSelection: () => term._sel != null,
    getSelection: () => term._sel || "",
    modes: { mouseTrackingMode: "none" },
    buffer: { active: { type: "normal", length: 0, baseY: 0, getLine: () => null } },
    textarea: { value: "", addEventListener: (t: string, f: Function) => on(taL, t, f), _fire: (t: string, ev?: unknown) => fire(taL, t, ev), focus() { /* noop */ }, blur() { /* noop */ } },
    element: { addEventListener: (t: string, f: Function) => on(elL, t, f), _fire: (t: string) => fire(elL, t), querySelector: () => null },
    parser: { registerOscHandler: (n: number, f: Function) => { term._osc[n] = f; } },
    focus() { /* noop */ }, write() { /* noop */ }, refresh() { /* noop */ }, scrollLines() { /* noop */ },
    clearSelection() { /* noop */ }, select() { /* noop */ },
    options: {}, cols: 80, rows: 24,
  };
  let writeTextCalls = 0;
  const nav: any = {
    vendor: opts.safari ? "Apple Computer, Inc." : "Google Inc.",
    userAgent: opts.safari ? "Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/17.4 Safari/605.1" : "Mozilla/5.0 Chrome/126",
    userActivation: { isActive: false },
    clipboard: {
      writeText: (t: string) => { writeTextCalls++; if (opts.writeTextOk === false) return Promise.reject(new Error("denied")); writeTexts.push(t); return Promise.resolve(); },
      readText: () => Promise.resolve(opts.readText || ""),
      read: () => Promise.resolve(opts.readText ? [{ types: ["text/plain"], getType: async () => new Blob([String(opts.readText)], { type: "text/plain" }) }] : []),
      write: (items: any[]) => { clipWrites.push(items); return Promise.resolve(); },
    },
  };
  // 브라우저 전역 스텁 — 모듈 최상위·본문이 읽는 것만(vm 컨텍스트에 담던 것을 globalThis 에 심는다).
  //  timers·TextEncoder·URLSearchParams·EventTarget·Blob·atob/btoa 는 노드 기본 전역이라 그대로 쓴다.
  const g: any = globalThis;
  const def = (k: string, v: unknown): void => { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); };
  def("window", g); def("self", g);
  def("document", doc); def("navigator", nav);
  def("location", { search: "?session=t-1117", pathname: "/ui/terminal.html", protocol: "https:", host: "test" });
  def("localStorage", { getItem: () => null, setItem() { /* noop */ }, removeItem() { /* noop */ } });
  def("isSecureContext", true);
  def("ClipboardItem", ClipboardItemStub);
  def("WebSocket", class { /* not used */ });
  def("ResizeObserver", class { observe() { /* noop */ } });
  def("BroadcastChannel", class { onmessage = null; });
  def("matchMedia", () => ({ matches: false }));
  def("requestAnimationFrame", (f: () => void) => setTimeout(f, 0));
  def("TERMJS_BUILD", "test"); // 브라우저 산출물엔 esbuild define 이 박는 빌드 스탬프

  // 새 모듈 인스턴스(?n= 로 ESM 캐시 우회) — 위 전역을 최상위에서 읽는다. boot() 는 엔트리에 있어 돌지 않는다.
  const mod: any = await import(`${MOD_URL}?n=${++seq}`);
  const panesEl = new EventTarget();
  // 주입(#1084 방식의 계승) — ESM 은 밖에서 import 바인딩을 못 바꾸니 모듈이 제공하는 세터로 넣는다.
  mod.__injectRefsForTest({
    term,
    panesEl,
    ws: { readyState: 1, send: (s: string) => sent.push(s), close() { /* noop */ } },
    statusEl: { textContent: "", className: "" },
  });
  const inputs = (): string[] => sent.map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter((m: any) => m && m.t === "i").map((m: any) => m.d as string);
  const kev = (over: Record<string, unknown>): any => ({
    type: "keydown", key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    isComposing: false, preventDefault() { /* noop */ }, ...over,
  });
  return {
    mod, nav, diag: () => String(g.livelyTermDiag()),
    term, panesEl, sent, execData, writeTexts, clipWrites,
    execCalls: () => execCallCount,
    writeTextCalls: () => writeTextCalls,
    fireDoc: (t: string, ev?: unknown) => fire(docL, t, ev),
    inputs, kev,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const b64utf8 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const pasteEvent = (text: string): Event => {
  const ev: any = new Event("paste");
  ev.clipboardData = { items: [], getData: (t: string) => (t === "text/plain" ? text : "") };
  return ev as Event;
};

// ── 미니 async 러너 ──
const tests: Array<[string, () => Promise<void> | void]> = [];
const t = (name: string, fn: () => Promise<void> | void): void => { tests.push([name, fn]); };

// S — 붙여넣기 위생
t("S1 CR/CRLF → \\n 정규화 + 여러 줄은 브래킷 1쌍", async () => {
  const h = await makeCtx();
  h.mod.pasteText("a\r\nb\rc");
  assert.deepEqual(h.inputs(), ["\x1b[200~a\nb\nc\x1b[201~"]);
});
t("S2 유니코드 줄구분자(U+2028/29) → \\n", async () => {
  const h = await makeCtx();
  assert.equal(h.mod.sanitizePasteText("x\u2028y\u2029z"), "x\ny\nz");
});
t("S3 한글·이모지·탭 한 줄은 원문 그대로 + 브래킷 없음", async () => {
  const h = await makeCtx();
  h.mod.pasteText("안녕\t탭😀");
  assert.deepEqual(h.inputs(), ["안녕\t탭😀"]);
});
t("S4 브래킷 종료 표식 주입은 살아남지 않는다(보안)", async () => {
  const h = await makeCtx();
  h.mod.pasteText("evil\x1b[201~\r\ninjected");
  assert.deepEqual(h.inputs(), ["\x1b[200~evil\ninjected\x1b[201~"]);
});
t("S5 CSI 색코드 제거", async () => {
  const h = await makeCtx();
  assert.equal(h.mod.sanitizePasteText("\x1b[31mred\x1b[0m"), "red");
});
t("S6 OSC 시퀀스 제거", async () => {
  const h = await makeCtx();
  assert.equal(h.mod.sanitizePasteText("\x1b]0;title\x07txt"), "txt");
});
t("S7 C0·DEL·C1 제거(탭·개행 보존)", async () => {
  const h = await makeCtx();
  assert.equal(h.mod.sanitizePasteText("\x01a\x7fbc\td\ne"), "abc\td\ne");
});
t("S8 빈 입력 → 전송 0건", async () => {
  const h = await makeCtx();
  h.mod.pasteText("");
  assert.equal(h.inputs().length, 0);
});
t("S9 위생 후 빈 문자열 → 전송 0건", async () => {
  const h = await makeCtx();
  h.mod.pasteText("\x1b[2J\x07");
  assert.equal(h.inputs().length, 0);
});

// P — 붙여넣기 단일 경로(#1084 보존)
t("P1 윈도우 Ctrl+V(네이티브 paste 발생) → 정확히 1회, 폴백 미발화", async () => {
  const h = await makeCtx({ readText: "SHOULD-NOT-PASTE" });
  h.mod.setupClipboard(); h.mod.setupPaste();
  assert.equal(h.term._keyHandler(h.kev({ key: "v", ctrlKey: true })), false);
  h.panesEl.dispatchEvent(pasteEvent("hello"));
  await sleep(140);
  assert.deepEqual(h.inputs(), ["hello"]);
});
t("P2 맥 Ctrl+V(네이티브 없음) → 폴백 1회만", async () => {
  const h = await makeCtx({ readText: "clip" });
  h.mod.setupClipboard(); h.mod.setupPaste();
  assert.equal(h.term._keyHandler(h.kev({ key: "v", ctrlKey: true })), false);
  await sleep(140);
  assert.deepEqual(h.inputs(), ["clip"]);
});

// C — 복사 경로
t("C1 제스처 안 → 동기 커밋, 비동기 API 미호출", async () => {
  const h = await makeCtx();
  h.mod.copyText("HI", true, true);
  await sleep(5);
  assert.deepEqual(h.execData, ["HI"]);
  assert.equal(h.writeTexts.length, 0);
});
t("C2 제스처 안 + 동기 전부 실패 → 비동기 폴백", async () => {
  const h = await makeCtx({ execOk: false });
  h.mod.copyText("HI", true, true);
  await sleep(5);
  assert.deepEqual(h.writeTexts, ["HI"]);
});
t("C3 제스처 밖 + 비동기 성공(크롬) → 비동기로 복사", async () => {
  const h = await makeCtx();
  h.mod.copyText("HI", true, false);
  await sleep(5);
  assert.deepEqual(h.writeTexts, ["HI"]);
  assert.equal(h.execData.length, 0);
});
t("C4 제스처 밖 + 비동기 거부(사파리) → 보류 후 다음 키 제스처에서 커밋", async () => {
  const h = await makeCtx({ writeTextOk: false });
  h.mod.copyText("HI", true, false);
  await sleep(10);
  assert.equal(h.execData.length, 0); // 아직 커밋 전(보류)
  h.fireDoc("keydown");
  assert.deepEqual(h.execData, ["HI"]);
});
t("C5 보류 플러시: 동기 실패 → 같은 제스처에서 비동기 1회 후 종료(재시도 반복 금지)", async () => {
  const h = await makeCtx({ writeTextOk: false, execOk: false });
  h.mod.copyText("HI", true, false);
  await sleep(10);
  const before = h.writeTextCalls(); // 스태시 시점까지의 호출 수
  h.fireDoc("keydown");
  assert.equal(h.writeTextCalls(), before + 1); // 제스처 내 비동기 1회
  const execAfter = h.execCalls(), apiAfter = h.writeTextCalls();
  h.fireDoc("keydown"); h.fireDoc("keydown");
  assert.equal(h.execCalls(), execAfter);       // 이후 제스처에 재시도 없음 — 입력 방해 금지
  assert.equal(h.writeTextCalls(), apiAfter);
});
t("C6 보류 없음 + 제스처 → 동기 커밋 시도 0건(부재 no-op)", async () => {
  const h = await makeCtx();
  h.fireDoc("keydown");
  assert.equal(h.execCalls(), 0);
});
t("C7 조합 중 제스처엔 플러시하지 않는다(IME 보호) → 조합 아닌 제스처에서 커밋", async () => {
  const h = await makeCtx({ writeTextOk: false });
  h.mod.copyText("HI", true, false);
  await sleep(10);
  h.fireDoc("keydown", { isComposing: true });
  assert.equal(h.execCalls(), 0);               // 조합 중 — 클립보드 조작 0건
  h.fireDoc("keydown", { keyCode: 229 });
  assert.equal(h.execCalls(), 0);               // IME 프로세스 키도 보호
  h.fireDoc("keydown", {});
  assert.deepEqual(h.execData, ["HI"]);         // 조합 아닌 제스처에서 커밋
});
t("C8 제스처 밖 + userActivation 활성이어도 동기 경로·포커스 이동 없이 비동기로만", async () => {
  const h = await makeCtx();
  h.nav.userActivation.isActive = true; // OSC52 가 최근 제스처의 활성화 창 안에 도착한 상황
  h.mod.copyText("HI", true, false);
  await sleep(5);
  assert.equal(h.execCalls(), 0);               // execCommand/임시 textarea 미사용(IME 안 건드림)
  assert.deepEqual(h.writeTexts, ["HI"]);
});

// B — Cmd+C 브리지 게이팅
const drag = (h: Harness): void => {
  h.mod.handleTermData("\x1b[<0;5;5M");
  h.mod.handleTermData("\x1b[<32;6;5M");
  h.mod.handleTermData("\x1b[<0;7;5m");
};
const cnt03 = (h: Harness): number => h.inputs().filter((d) => d === "\x03").length;
t("B1 앱 드래그 관측 후 Cmd+C → ^C 정확히 1회", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard(); h.term.modes.mouseTrackingMode = "any";
  drag(h);
  assert.equal(h.term._keyHandler(h.kev({ key: "c", metaKey: true })), false);
  assert.equal(cnt03(h), 1);
});
t("B2 관측 없음 + Cmd+C → ^C 0건(앱 종료 사고 차단)", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard(); h.term.modes.mouseTrackingMode = "any";
  assert.equal(h.term._keyHandler(h.kev({ key: "c", metaKey: true })), false);
  assert.equal(cnt03(h), 0);
});
t("B3 드래그 후 일반 타이핑 → 관측 해제 → ^C 0건", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard(); h.term.modes.mouseTrackingMode = "any";
  drag(h);
  h.mod.handleTermData("가");
  h.term._keyHandler(h.kev({ key: "c", metaKey: true }));
  assert.equal(cnt03(h), 0);
});
t("B4 제자리 클릭(이동 없음·같은 좌표) → ^C 0건", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard(); h.term.modes.mouseTrackingMode = "any";
  h.mod.handleTermData("\x1b[<0;5;5M");
  h.mod.handleTermData("\x1b[<0;5;5m");
  h.term._keyHandler(h.kev({ key: "c", metaKey: true }));
  assert.equal(cnt03(h), 0);
});
t("B5 모션 리포트 없이 누름·뗌 좌표만 다름(경계) → 선택 성립 → ^C 1회", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard(); h.term.modes.mouseTrackingMode = "any";
  h.mod.handleTermData("\x1b[<0;5;5M");
  h.mod.handleTermData("\x1b[<0;9;5m");
  h.term._keyHandler(h.kev({ key: "c", metaKey: true }));
  assert.equal(cnt03(h), 1);
});
t("B6 드래그 후 휠 리포트만 → 선택 유지 → ^C 1회", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard(); h.term.modes.mouseTrackingMode = "any";
  drag(h);
  h.mod.handleTermData("\x1b[<64;3;3M");
  h.term._keyHandler(h.kev({ key: "c", metaKey: true }));
  assert.equal(cnt03(h), 1);
});
t("B7 xterm 선택 존재 + Ctrl+C → 선택 복사(동기), ^C 0건", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard(); h.term.modes.mouseTrackingMode = "any";
  h.term._sel = "SEL";
  assert.equal(h.term._keyHandler(h.kev({ key: "c", ctrlKey: true })), false);
  assert.deepEqual(h.execData, ["SEL"]);
  assert.equal(cnt03(h), 0);
});
t("B9 드래그 관측은 1회용: Cmd+C 연타에도 ^C 는 정확히 1회(연타로 CC 종료되던 사고 차단)", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard(); h.term.modes.mouseTrackingMode = "any";
  drag(h);
  h.term._keyHandler(h.kev({ key: "c", metaKey: true }));
  h.term._keyHandler(h.kev({ key: "c", metaKey: true }));
  h.term._keyHandler(h.kev({ key: "c", metaKey: true }));
  assert.equal(cnt03(h), 1); // 첫 번째만 브리지 — 이후는 소비돼 무전송(다시 드래그해야 재발동)
});
t("B10 사파리 IME 어댑터 타이핑도 드래그 관측을 해제한다(직접 전송 경로 우회 구멍)", async () => {
  const h = await makeCtx({ safari: true });
  h.mod.setupClipboard(); h.mod.setupWebkitImeAdapter();
  h.term.modes.mouseTrackingMode = "any";
  drag(h);
  bi(h, "insertText", "요"); // 어댑터 경로 타이핑 — handleTermData 를 안 지난다
  h.term._keyHandler(h.kev({ key: "c", metaKey: true }));
  assert.equal(cnt03(h), 0); // 타이핑으로 앱 선택이 사라졌다고 보고 ^C 미전송
});
// B11~B17 — 다중 클릭 선택(#1646 제보): 앱 화면에서 '더블클릭으로 단어를 선택'했는데 ⌘C 가 먹지 않고
//  "복사할 선택이 없어요" 안내만 떴다. 관측기가 드래그만 선택으로 인정해, 더블·트리플 클릭(같은 자리 연타)이
//  '제자리 클릭'으로 분류돼 게이팅에 걸린 것. 사양·엣지 표는 이 테스트 파일 머리의 B 계열 + #1646 사양 참조.
const clickAt = (h: Harness, x: number, y: number): void => {
  h.mod.handleTermData("\x1b[<0;" + x + ";" + y + "M");
  h.mod.handleTermData("\x1b[<0;" + x + ";" + y + "m");
};
t("B11 같은 자리 더블클릭(= 단어 선택) → ^C 1회", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard(); h.term.modes.mouseTrackingMode = "any";
  clickAt(h, 5, 5); clickAt(h, 5, 5);
  h.term._keyHandler(h.kev({ key: "c", metaKey: true }));
  assert.equal(cnt03(h), 1);
});
t("B12 같은 자리 트리플클릭(= 줄 선택) → ^C 1회", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard(); h.term.modes.mouseTrackingMode = "any";
  clickAt(h, 5, 5); clickAt(h, 5, 5); clickAt(h, 5, 5);
  h.term._keyHandler(h.kev({ key: "c", metaKey: true }));
  assert.equal(cnt03(h), 1);
});
t("B13 더블클릭 뒤 다른 자리 단일 클릭 → 선택 잃음 → ^C 0건", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard(); h.term.modes.mouseTrackingMode = "any";
  clickAt(h, 5, 5); clickAt(h, 5, 5);
  clickAt(h, 20, 9);
  h.term._keyHandler(h.kev({ key: "c", metaKey: true }));
  assert.equal(cnt03(h), 0);
});
t("B14 더블클릭 뒤 타이핑 → 선택 잃음 → ^C 0건", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard(); h.term.modes.mouseTrackingMode = "any";
  clickAt(h, 5, 5); clickAt(h, 5, 5);
  h.mod.handleTermData("가");
  h.term._keyHandler(h.kev({ key: "c", metaKey: true }));
  assert.equal(cnt03(h), 0);
});
t("B15 더블클릭 관측도 1회용: ⌘C 연타 3회에도 ^C 는 1회", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard(); h.term.modes.mouseTrackingMode = "any";
  clickAt(h, 5, 5); clickAt(h, 5, 5);
  for (let i = 0; i < 3; i++) h.term._keyHandler(h.kev({ key: "c", metaKey: true }));
  assert.equal(cnt03(h), 1);
});
t("B16 경계: 같은 자리 2회지만 간격이 임계(600ms)를 넘음 → 연타 아님 → ^C 0건", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard(); h.term.modes.mouseTrackingMode = "any";
  clickAt(h, 5, 5);
  await sleep(650);
  clickAt(h, 5, 5);
  h.term._keyHandler(h.kev({ key: "c", metaKey: true }));
  assert.equal(cnt03(h), 0);
});
t("B17 타이핑 직후 같은 자리 클릭 1회 → 직전 연타에 이어붙지 않는다 → ^C 0건", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard(); h.term.modes.mouseTrackingMode = "any";
  clickAt(h, 5, 5); clickAt(h, 5, 5);   // 여기까지는 선택 성립
  h.mod.handleTermData("가");            // 타이핑 — 앱은 선택을 잃는다
  clickAt(h, 5, 5);                      // 같은 자리 단일 클릭(앱엔 선택 없음)
  h.term._keyHandler(h.kev({ key: "c", metaKey: true }));
  assert.equal(cnt03(h), 0);
});
t("B18 더블클릭 사이 휠 리포트가 끼어도 연타로 인정 → ^C 1회", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard(); h.term.modes.mouseTrackingMode = "any";
  clickAt(h, 5, 5);
  h.mod.handleTermData("\x1b[<64;5;5M"); // 휠 — 선택과 무관
  clickAt(h, 5, 5);
  h.term._keyHandler(h.kev({ key: "c", metaKey: true }));
  assert.equal(cnt03(h), 1);
});
t("B19 마우스모드 아님 + 더블클릭 → 전송 0건 · 브라우저 기본에 위임", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard();
  clickAt(h, 5, 5); clickAt(h, 5, 5);
  assert.equal(h.term._keyHandler(h.kev({ key: "c", metaKey: true })), true);
  assert.equal(cnt03(h), 0);
});
// B20~B21 — 브리지는 갔는데 앱이 복사 신호(OSC52)를 안 보낸 경우(#1646): 종전엔 완전 무음이라
//  사용자가 실패를 알 수 없었다. 성공(OSC52 도착)은 여전히 무음이어야 한다.
t("B20 브리지 후 OSC52 도착 → 실패 안내 없음(성공은 무음)", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard(); h.mod.setupOscClipboard(); h.term.modes.mouseTrackingMode = "any";
  clickAt(h, 5, 5); clickAt(h, 5, 5);
  h.term._keyHandler(h.kev({ key: "c", metaKey: true }));
  h.term._osc[52]("0;" + Buffer.from("HELLO").toString("base64")); // 앱이 복사 신호를 보냄
  await sleep(2700);
  assert.ok(!String(h.diag()).includes("bridge-miss"));
});
t("B21 브리지 후 OSC52 없음 → 실패 안내 1회", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard(); h.mod.setupOscClipboard(); h.term.modes.mouseTrackingMode = "any";
  clickAt(h, 5, 5); clickAt(h, 5, 5);
  h.term._keyHandler(h.kev({ key: "c", metaKey: true }));
  await sleep(2700);
  assert.ok(String(h.diag()).includes("bridge-miss"));
});
t("B8 마우스모드 아님 + Cmd+C → 전송 0건(브라우저 기본 복사 위임)", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard();
  assert.equal(h.term._keyHandler(h.kev({ key: "c", metaKey: true })), true);
  assert.equal(h.inputs().length, 0);
});

// H — 히든 textarea 위생(버그A)
t("H1 잔류물 + 유휴 300ms → 비워짐 + 진단 기록", async () => {
  const h = await makeCtx();
  h.term.textarea.value = "잔류물멀티글자";
  h.mod.setupTextareaHygiene();
  await sleep(380);
  assert.equal(h.term.textarea.value, "");
  assert.ok(String(h.diag()).includes("hygiene"));
});
t("H2/H3 IME 조합 중엔 유지, 조합 종료 후 비워짐", async () => {
  const h = await makeCtx();
  h.mod.setupTextareaHygiene();
  h.term.textarea._fire("compositionstart");
  h.term.textarea.value = "조합중";
  await sleep(380);
  assert.equal(h.term.textarea.value, "조합중"); // 조합 중 보호
  h.term.textarea._fire("compositionend");
  await sleep(380);
  assert.equal(h.term.textarea.value, "");
});
t("H4 우클릭 메뉴 동안 보류 → 상호작용 후 비워짐", async () => {
  const h = await makeCtx();
  h.mod.setupTextareaHygiene();
  h.term.element._fire("contextmenu");
  h.term.textarea.value = "메뉴복사용";
  await sleep(380);
  assert.equal(h.term.textarea.value, "메뉴복사용"); // 메뉴 hold
  h.fireDoc("mousedown");
  await sleep(380);
  assert.equal(h.term.textarea.value, "");
});
t("H5 빈 값(부재) + 유휴 → 기록 없음", async () => {
  const h = await makeCtx();
  h.mod.setupTextareaHygiene();
  await sleep(380);
  assert.ok(!String(h.diag()).includes("hygiene "));
});
t("H6 사파리: 청소 주기 완화 — 짧은 유휴엔 유지, 1.5s 후 비워짐", async () => {
  const h = await makeCtx({ safari: true });
  h.term.textarea.value = "사파리잔류";
  h.mod.setupTextareaHygiene();
  await sleep(500);
  assert.equal(h.term.textarea.value, "사파리잔류"); // 300ms 주기였다면 이미 비워졌을 시점 — IME 상호작용 최소화
  await sleep(1200);
  assert.equal(h.term.textarea.value, "");
});

// W — 반복 전송 워치독
t("W1 7자 동일 ×3 → textarea 자가치유 + 진단", async () => {
  const h = await makeCtx();
  h.term.textarea.value = "junk";
  for (let i = 0; i < 3; i++) h.mod.handleTermData("ABCDEFG");
  assert.equal(h.term.textarea.value, "");
  assert.ok(String(h.diag()).includes("spam-detect"));
});
t("W2 동일 ×2(경계) → 유지", async () => {
  const h = await makeCtx();
  h.term.textarea.value = "junk";
  for (let i = 0; i < 2; i++) h.mod.handleTermData("ABCDEFG");
  assert.equal(h.term.textarea.value, "junk");
});
t("W3 5자(경계) ×3 → 유지", async () => {
  const h = await makeCtx();
  h.term.textarea.value = "junk";
  for (let i = 0; i < 3; i++) h.mod.handleTermData("ABCDE");
  assert.equal(h.term.textarea.value, "junk");
});
t("W4 ESC 시퀀스(마우스) ×3 → 유지", async () => {
  const h = await makeCtx();
  h.term.textarea.value = "junk";
  for (let i = 0; i < 3; i++) h.mod.handleTermData("\x1b[<35;1;1M");
  assert.equal(h.term.textarea.value, "junk");
});

// O — OSC52
t("O1 OSC52 수신(비사파리) → 비동기 쓰기에 그 텍스트", async () => {
  const h = await makeCtx();
  h.mod.setupOscClipboard();
  h.term._osc[52](";" + b64utf8("복사텍스트"));
  await sleep(5);
  assert.deepEqual(h.writeTexts, ["복사텍스트"]);
});
t("O2 사파리: 복사 의도 제스처의 사전 커밋이 OSC52 로 resolve, 직접 쓰기 없음", async () => {
  const h = await makeCtx({ safari: true, writeTextOk: false });
  h.mod.setupClipboard(); h.mod.setupOscClipboard();
  h.term.modes.mouseTrackingMode = "any";
  drag(h);
  assert.equal(h.term._keyHandler(h.kev({ key: "c", ctrlKey: true })), true); // Ctrl+C 는 앱으로 통과(흐름 불변)
  assert.equal(h.clipWrites.length, 1); // 제스처에서 write 사전 커밋
  h.term._osc[52](";" + b64utf8("S"));
  const item = h.clipWrites[0][0];
  const blob: Blob = await item.items["text/plain"];
  assert.equal(await blob.text(), "S");
  assert.ok(!h.writeTexts.includes("S")); // 직접 쓰기 경로 미사용
});

// I — 사파리 무조합이벤트 IME 어댑터(#1300, 즉시 에코 모델). 실기기 트레이스 순서(input 이 keydown 229 보다
//  먼저)를 재현한다. 불변식: 출력 스트림이 키 단위로 textarea 조합 상태를 따라간다(지연 0).
t("I1 자모 즉시 에코 → 치환은 DEL+새상태 → 새 음절: xterm 자모 유출은 삼킴", async () => {
  const h = await makeCtx({ safari: true });
  h.mod.setupWebkitImeAdapter();
  h.term.textarea._fire("beforeinput", { inputType: "insertText", data: "ㅇ" });
  h.mod.handleTermData("ㅇ"); // xterm _inputEvent 의 산발 유출 재현 — 삼켜져야 한다(우리 에코와 중복 금지)
  h.term.textarea._fire("input", { inputType: "insertText", data: "ㅇ" });
  bi(h, "insertReplacementText", "아");
  bi(h, "insertReplacementText", "안");
  bi(h, "insertText", "ㄴ"); // 다음 음절 시작 — 즉시 에코
  assert.deepEqual(h.inputs(), ["ㅇ", "\x7f아", "\x7f안", "ㄴ"]); // 화면 순변화: ㅇ→아→안→안ㄴ (유출 중복 0)
});
t("I2 비IME 키다운(Space) = 커밋 신호: 이미 다 에코돼 있어 추가 전송·DEL 없음", async () => {
  const h = await makeCtx({ safari: true });
  h.mod.setupClipboard(); h.mod.setupWebkitImeAdapter();
  bi(h, "insertText", "요");
  assert.deepEqual(h.inputs(), ["요"]); // 즉시 에코(보류 없음)
  h.term._keyHandler(h.kev({ key: " ", keyCode: 32 }));
  assert.deepEqual(h.inputs(), ["요"]); // 커밋은 추적 해제만 — 중복·DEL 없음
});
t("I3 마지막 음절도 즉시 표시(유휴 대기 없음)", async () => {
  const h = await makeCtx({ safari: true });
  h.mod.setupWebkitImeAdapter();
  bi(h, "insertText", "다");
  assert.deepEqual(h.inputs(), ["다"]); // 타이머 없이 곧바로
});
t("I4 에코된 음절이 이어질 때(다→달): DEL+새 음절 정정", async () => {
  const h = await makeCtx({ safari: true });
  h.mod.setupWebkitImeAdapter();
  bi(h, "insertText", "다");
  bi(h, "insertReplacementText", "달");
  assert.deepEqual(h.inputs(), ["다", "\x7f달"]);
});
t("I5 IME 경유 비한글(숫자): 직전 음절 유지 + 즉시 전송", async () => {
  const h = await makeCtx({ safari: true });
  h.mod.setupWebkitImeAdapter();
  bi(h, "insertText", "감");
  bi(h, "insertText", "2");
  assert.deepEqual(h.inputs(), ["감", "2"]); // 2 앞에 DEL 없음(감은 확정)
});
t("I6 비사파리: 어댑터 미설치 — 같은 이벤트에 무동작(부재 엣지)", async () => {
  const h = await makeCtx();
  h.mod.setupWebkitImeAdapter();
  bi(h, "insertText", "ㅇ");
  bi(h, "insertReplacementText", "아");
  assert.deepEqual(h.inputs(), []);
});
t("I7 사파리 + 진짜 조합 이벤트 존재 → 어댑터가 물러남(xterm 경로 존중)", async () => {
  const h = await makeCtx({ safari: true });
  h.mod.setupTextareaHygiene(); h.mod.setupWebkitImeAdapter();
  h.term.textarea._fire("compositionstart"); // imeComposing = true
  bi(h, "insertText", "ㅇ");
  bi(h, "insertReplacementText", "아");
  assert.deepEqual(h.inputs(), []);
});
t("I8 빈 치환(조합 전부 지움 — 경계): 에코된 자모를 DEL 로 지움", async () => {
  const h = await makeCtx({ safari: true });
  h.mod.setupWebkitImeAdapter();
  bi(h, "insertText", "ㅇ");
  bi(h, "insertReplacementText", "");
  assert.deepEqual(h.inputs(), ["ㅇ", "\x7f"]);
});
t("I9 커밋 후 '다른 값' 치환(비정상 순서 방어): 엉뚱한 글자를 지우지 않게 DEL 없이 새로 쓴다", async () => {
  const h = await makeCtx({ safari: true });
  h.mod.setupClipboard(); h.mod.setupWebkitImeAdapter();
  bi(h, "insertText", "요");
  h.term._keyHandler(h.kev({ key: " ", keyCode: 32 })); // 커밋 — 추적 해제
  bi(h, "insertReplacementText", "용");
  assert.deepEqual(h.inputs(), ["요", "용"]); // \x7f 미포함
});
t("I10 한글 뒤 Shift+특수문자: 수정자 keydown 은 커밋 아님 + 동일값 커밋 치환 스킵 — 마지막 글자 반복 금지", async () => {
  const h = await makeCtx({ safari: true });
  h.mod.setupClipboard(); h.mod.setupWebkitImeAdapter();
  bi(h, "insertText", "요"); // 안녕하세요 의 마지막 음절 에코
  h.term._keyHandler(h.kev({ key: "Shift", keyCode: 16, shiftKey: true })); // Shift 자체는 커밋 신호가 아니다
  bi(h, "insertReplacementText", "요"); // 사파리의 커밋 재확인 치환(같은 값)
  h.term._keyHandler(h.kev({ key: "!", keyCode: 49, shiftKey: true }));
  assert.deepEqual(h.inputs(), ["요"]); // 반복('요요')도 유령 DEL 도 없다 — '!' 는 xterm 기본 경로
});
t("I11 순서 변형(키다운이 커밋 치환보다 먼저): 직전 에코값 기억으로 동일 방어", async () => {
  const h = await makeCtx({ safari: true });
  h.mod.setupClipboard(); h.mod.setupWebkitImeAdapter();
  bi(h, "insertText", "요");
  h.term._keyHandler(h.kev({ key: "!", keyCode: 49, shiftKey: true })); // 리셋이 먼저 일어나는 순서
  bi(h, "insertReplacementText", "요"); // 그 뒤 도착한 커밋 치환(같은 값)
  assert.deepEqual(h.inputs(), ["요"]); // imeEchoDone 매칭으로 스킵
});

// 배선(wiring) — 스텁이 실제로 물렸는지(vacuous 방지)
t("wiring: setupClipboard/onData/OSC 핸들러가 실제로 등록된다", async () => {
  const h = await makeCtx();
  h.mod.setupClipboard(); h.mod.setupOscClipboard();
  assert.ok(typeof h.term._keyHandler === "function");
  assert.ok(typeof h.term._osc[52] === "function");
  assert.ok(typeof h.mod.handleTermData === "function");
  h.mod.handleTermData("x");
  assert.deepEqual(h.inputs(), ["x"]); // onData 본체가 ws 로 실제 전송
});

// ── 마우스 리포트 코얼레싱(#1437, 2026-08-26) — 프레임당 1회로 합쳐 보낸다(바이트 무손실·순서보존) ──
t("COAL1 연속 마우스 리포트는 즉시 안 나가고 버퍼링 → flush 시 1프레임으로 이어붙여 나간다", async () => {
  const h = await makeCtx();
  h.mod.handleTermData("\x1b[<64;5;5M");     // 휠 up
  h.mod.handleTermData("\x1b[<64;5;5M");     // 휠 up
  h.mod.handleTermData("\x1b[<64;5;5M");     // 휠 up
  assert.deepEqual(h.inputs(), [], "버퍼링 — flush 전엔 한 건도 안 나간다");
  h.mod.flushMouseReports();
  assert.deepEqual(h.inputs(), ["\x1b[<64;5;5M\x1b[<64;5;5M\x1b[<64;5;5M"], "3건이 1프레임으로 이어붙어 나간다(무손실)");
});
t("COAL2 비-마우스 입력은 즉시 나가되, 버퍼된 마우스를 먼저 비운다(순서 마우스→키)", async () => {
  const h = await makeCtx();
  h.mod.handleTermData("\x1b[<32;6;5M");     // 호버 이동(버퍼)
  h.mod.handleTermData("a");                  // 키 — 즉시, 단 마우스 먼저 flush
  assert.deepEqual(h.inputs(), ["\x1b[<32;6;5M", "a"], "마우스 flush 후 키 — 순서 보존");
});
t("COAL3 마우스 없이 키만이면 종전대로 즉시(버퍼 우회)", async () => {
  const h = await makeCtx();
  h.mod.handleTermData("x");
  assert.deepEqual(h.inputs(), ["x"]);
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
