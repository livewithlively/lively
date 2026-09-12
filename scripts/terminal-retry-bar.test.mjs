// #3870 — «서버에 연결하지 못했습니다» 배너가 **터미널을 화면 밖으로 밀지 않는지** 못박는다.
//
// ── 무슨 일이 있었나 ────────────────────────────────────────────────────────
// 2026-09-11 원준님 실측: 세션 화면 상단에 이 배너가 떠 있으면 Claude Code 화면이 통째로 아래로 밀려
//  **입력줄이 잘렸다.** 같은 모양의 종료 배너(«이 세션은 종료되었습니다»)는 멀쩡했다.
//
// 기제: 뼈대는 `#root > #ws(height:100dvh) > #main(세로 flex) > … #panes(flex:1·min-height:0)` 이고 body 는 overflow:hidden.
//  종료 배너는 #main 안(#panes 앞)에 들어가 #panes 가 그만큼 줄었다. 재시도 배너는 #root 맨 앞 — **#ws 의 형제** — 에
//  들어가, 화면 높이 그대로인 #ws 를 배너 높이만큼 아래로 밀었다. 게다가 탭 복귀·[화면 복구]로 다시 붙어도 배너를
//  걷는 곳이 없어, 상단은 '연결됨'인데 배너만 남아 계속 밀었다.
//
// ── 어떻게 보나 ─────────────────────────────────────────────────────────────
// 모듈을 진짜로 import 하고(standalone-terminal-env), 최소 DOM 을 꽂아 **배너가 어디에 붙고 언제 사라지는지**를 본다.
//  레이아웃 자체(픽셀)는 노드에서 못 잰다 — 그래서 ⓪ 에서 «#main 안이면 안 밀린다» 의 근거인 CSS 전제를 함께 못박는다.
// 실행: npm run build && node scripts/terminal-retry-bar.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { importTerminalModule } from "./standalone-terminal-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "public/terminal.html"), "utf8");
const src = readFileSync(join(root, "web/standalone/terminal.ts"), "utf8");
const mod = await importTerminalModule();
for (const k of ["showRetryBar", "markConnProven", "__injectRefsForTest"]) {
  assert.equal(typeof mod[k], "function", `${k} 가 모듈에서 노출돼야 한다`);
}

let pass = 0;
const ok = (m) => { pass++; console.log(`ok  ${m}`); };

// ── 최소 DOM — 이 시험이 보는 것(트리 위치·이벤트)만 ────────────────────────
class Node {
  constructor(tag) { this.tagName = tag; this.nodeType = 1; this.children = []; this.parentNode = null; this.attrs = {}; this.listeners = {}; this.className = ""; this.textContent = ""; }
  get id() { return this.attrs.id || ""; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  append(...cs) { for (const c of cs) { c.remove?.(); c.parentNode = this; this.children.push(c); } }
  appendChild(c) { this.append(c); return c; }
  insertBefore(c, ref) {
    if (ref == null) return this.appendChild(c);
    const i = this.children.indexOf(ref);
    assert.notEqual(i, -1, "insertBefore 의 기준 노드가 이 부모의 자식이 아니다(브라우저라면 NotFoundError)");
    c.remove?.(); c.parentNode = this; this.children.splice(this.children.indexOf(ref), 0, c); return c;
  }
  remove() { const p = this.parentNode; if (!p) return; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; }
  click() { for (const fn of this.listeners.click || []) fn({}); }
  walk(fn) { fn(this); for (const c of this.children) c.walk?.(fn); }
  querySelector(sel) { let hit = null; const cls = sel.replace(/^\./, ""); this.walk((n) => { if (!hit && n !== this && n.className?.split(" ").includes(cls)) hit = n; }); return hit; }
}
let docRoot;
function installDom({ withMain = true, endedBar = false } = {}) {
  const r = new Node("div"); r.setAttribute("id", "root");
  let panes = null;
  if (withMain) {
    const ws = new Node("div"); ws.setAttribute("id", "ws");
    const main = new Node("div"); main.setAttribute("id", "main");
    const tabbar = new Node("div"); tabbar.setAttribute("id", "tabbar");
    panes = new Node("div"); panes.setAttribute("id", "panes");
    main.append(tabbar, panes); ws.append(main); r.append(ws);
    if (endedBar) { const b = new Node("div"); b.className = "ended-bar"; main.insertBefore(b, panes); }
  }
  docRoot = r;
  globalThis.document = {
    createElement: (t) => new Node(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: t, remove() { /* noop */ } }),
    getElementById: (id) => { let hit = null; docRoot.walk((n) => { if (!hit && n.id === id) hit = n; }); return hit; },
    querySelector: (sel) => docRoot.querySelector(sel),
    addEventListener() { /* noop */ }, removeEventListener() { /* noop */ },
    title: "",
  };
  // [다시 시도] 가 부르는 connectNow 가 네트워크로 나가지 않게 — «이미 열린 소켓» 이면 즉시 반환한다.
  mod.__injectRefsForTest({ panesEl: panes, ws: { readyState: 1 }, statusEl: { textContent: "", className: "" } });
  return { root: r, panes, main: panes?.parentNode || null, ws: r.children[0] || null };
}
const bars = () => { const out = []; docRoot.walk((n) => { if (n.id === "retry-bar") out.push(n); }); return out; };

// ⓪ 전제 — «#main 안에 넣으면 안 밀린다» 는 이 CSS 가 참일 때만 성립한다.
assert.match(html, /#ws\s*\{[^}]*height:\s*100dvh/, "#ws 가 화면 높이 고정이 아니다 — 시험 전제가 바뀌었다");
assert.match(html, /body\s*\{[^}]*overflow:\s*hidden/, "body 가 overflow:hidden 이 아니다 — 시험 전제가 바뀌었다");
assert.match(html, /#main\s*\{[^}]*flex-direction:\s*column/, "#main 이 세로 flex 가 아니다 — 시험 전제가 바뀌었다");
assert.match(html, /#panes\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0/, "#panes 가 남은 공간을 채우지 않는다 — 시험 전제가 바뀌었다");
ok("⓪ 전제: #ws 100dvh · body overflow:hidden · #main 세로 flex · #panes flex:1·min-height:0");

// ① ★ 회귀 그 자체 — 포기 배너는 #main 안, #panes 바로 앞. #ws 의 형제(#root 직속)가 아니다.
{
  const d = installDom();
  mod.showRetryBar();
  const [b] = bars();
  assert.ok(b, "배너가 뜨지 않았다");
  assert.equal(b.parentNode, d.main, "배너가 #main 안에 있지 않다 — #ws 바깥이면 배너 높이만큼 터미널 아래가 잘린다(#3870 회귀)");
  assert.equal(d.main.children[d.main.children.indexOf(d.panes) - 1], b, "배너가 #panes 바로 앞이 아니다");
  assert.deepEqual(d.root.children.map((n) => n.id), ["ws"], "#root 에 #ws 말고 다른 것이 붙었다 — 그게 #ws 를 민다");
  ok("① 포기 배너는 #main 안 #panes 바로 앞 — #root 에는 #ws 하나뿐");
}

// ② 종료 배너가 이미 있어도 같은 판(#main) 안에 쌓인다.
{
  const d = installDom({ endedBar: true });
  mod.showRetryBar();
  assert.deepEqual(d.root.children.map((n) => n.id), ["ws"], "종료 배너가 있을 때 포기 배너가 #root 로 새었다");
  assert.equal(bars()[0].parentNode, d.main);
  ok("② 종료 배너와 함께여도 둘 다 #main 안");
}

// ③ [다시 시도] 를 누르면 배너가 사라진다.
{
  installDom();
  mod.showRetryBar();
  const btn = bars()[0].children.find((n) => n.tagName === "button");
  assert.ok(btn, "배너에 [다시 시도] 버튼이 없다");
  btn.click();
  assert.equal(bars().length, 0, "[다시 시도] 뒤에도 배너가 남았다");
  ok("③ [다시 시도] 클릭 → 배너 사라짐");
}

// ④ ★ 포기 뒤 다른 길로 다시 붙어 **버텼으면** 배너를 걷는다.
{
  installDom();
  mod.showRetryBar();
  mod.markConnProven();
  assert.equal(bars().length, 0, "연결이 버텼는데 «연결하지 못했습니다» 가 남았다 — 상단은 '연결됨'인데 배너가 화면을 민다");
  ok("④ 버틴 연결(markConnProven) → 배너 사라짐");
}

// ⑤ 새 헬퍼의 부재 엣지 — 배너가 없을 때 버틴 연결 확인은 아무것도 안 건드린다(평소 연결마다 도는 길이다).
{
  const d = installDom();
  const before = JSON.stringify(d.main.children.map((n) => n.id));
  assert.doesNotThrow(() => mod.markConnProven());
  assert.equal(JSON.stringify(d.main.children.map((n) => n.id)), before, "배너가 없는데 판 구성이 바뀌었다");
  ok("⑤ 배너가 없을 때 markConnProven 은 무해(에러·DOM 변화 없음)");
}

// ⑥ 포기가 두 번 와도 배너는 하나.
{
  installDom();
  mod.showRetryBar(); mod.showRetryBar();
  assert.equal(bars().length, 1, "배너가 겹쳐 쌓였다 — 그만큼 더 줄어든다");
  ok("⑥ 포기 두 번 → 배너 1개");
}

// ⑦ 판(#main)이 아직 없는 화면 — 폴백으로 #root 맨 앞, 에러 없음.
{
  const d = installDom({ withMain: false });
  assert.doesNotThrow(() => mod.showRetryBar());
  assert.equal(bars()[0]?.parentNode, d.root, "#main 이 없을 때 배너가 어디에도 안 붙었다");
  ok("⑦ #main 이 없으면 #root 로 폴백");
}

// ⑧ onopen 은 배너를 걷지 않는다 — 붙자마자 끊기는 판(#3546)에서 포기 상태(gaveUp)는 남았는데 '다시 시도' 출구만 사라진다.
//  onopen 은 connectNow 안의 클로저라 노드에서 부를 수 없다 → 이 한 줄만 배선(소스)으로 본다.
{
  const i = src.indexOf("sock.onopen = () => {");
  assert.notEqual(i, -1, "sock.onopen 을 못 찾았다 — 시험이 낡았다");
  let depth = 0, end = -1;
  for (let j = i; j < src.length; j++) { if (src[j] === "{") depth++; else if (src[j] === "}" && --depth === 0) { end = j; break; } }
  assert.ok(!/hideRetryBar\(|retry-bar/.test(src.slice(i, end + 1)), "onopen 이 재시도 배너를 걷는다 — 곧바로 끊기면 출구 없는 화면이 된다");
  ok("⑧ onopen 은 배너를 걷지 않는다");
}

console.log(`\n${pass} passed`);
