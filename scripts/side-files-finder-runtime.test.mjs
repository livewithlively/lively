#!/usr/bin/env node
// 곁칸 «자료» 가 파인더·탐색기처럼 도나 — **런타임** 회귀 테스트 (#3870, 원준 2026-09-30)
//
// 신고 다섯(한 번에 왔다):
//  ① «맥이랑 윈도우의 Finder나 파일탐색기 수준으로 … 구현안된 단축키 등도 모두 … 맥은 파일 선택하고 엔터 누르면 이름 수정»
//  ② «일부 드롭다운 사진처럼 다 깨져서 뒤에가 다 보이고» — 정렬 메뉴(앵커 팝오버)에 바탕이 없었다
//  ③ «자료찾기 폰트가 좌측의 새 폴더 글자 크기보다 커서» · «두 줄로 될게 아니라 덜중요한거부터 안보이게»
//  ④ «＋ 올리기 옆에 폴더 올리기 버튼은 따로있는데 이게 최선이야?»
//  ⑤ «미리보기 보이는거 왜캐 느리고 오래 기다려야하고»
//
// 엣지 표(행마다 장면 하나 — 번호는 사양 spec R 표):
//  R1  도구줄 폭 280·340·420·600 → 한 줄(높이 ≤ 30) · 가로 넘침 없음
//  R2  접힌 것은 [크기, 보기, 정렬, 새 폴더] 의 **앞부분**(덜 중요한 것부터) · [⋯] 는 접힌 것이 있을 때만
//  R3  넓은 폭(600) → 아무것도 안 접힘 · [⋯] 없음
//  R4  찾기칸 글자 = [새 폴더] 글자 · 높이 같음
//  R5  정렬 메뉴 → 뜬 메뉴 바탕 불투명 · 지금 기준(이름)에 체크
//  R6  바탕을 안 준 앵커 팝오버 → 바탕 불투명 · 제 바탕을 가진 패널(.dash-pop-panel)은 제 반경·여백 그대로
//  R7  [⌄] → 메뉴에 파일·폴더 둘 · 큰 단추는 파일 창(폴더 입력이 아닌 file input)을 연다
//  R8  맥 Enter → 이름칸이 그 항목에 선다 · 열기 0
//  R9  윈도 Enter → 그 파일 열기 1 · 이름칸 없음
//  R10 → 는 다음 칸 · ↓ 는 한 줄 아래(격자 열 수만큼)
//  R11 ⇧→ → 두 개 고름
//  R12 ⌘A → 전부 · Esc → 0
//  R13 폴더 고르고 ⌘↓(열기) → 들어감 · ⌘↑ → 나오고 나온 폴더가 골라져 있다
//  R14 ⌘[ → 앞 폴더로
//  R15 타이핑 q(자판 KeyQ — 한글 입력기 꺼진 채 «ㅂ») → 보고서 고름
//  R16 Space → 파일 열기(빠른 보기)
//  R17 ⇧⌘N → POST folder «새 폴더» + 그 칸에 이름칸
//  R18 ⌘C → paste(클립보드가 아직 그 표식) → 원본 GET download + PUT «보고서 복사본.txt»
//  R19 paste(그새 딴 글을 복사) → 파일 복사 없이 그 글을 올린다(마지막에 복사한 것이 붙는다)
//  R20 ⌘D → PUT «사진 복사본.png»
//  R21 이름 바꾸기 Enter 확정 → ⌘Z → rename 두 번(둘째는 원래 이름으로)
//  R22 윈도 Backspace → 뒤로(삭제 확인창 없음)
//  R23 미리보기 요청 주소에 &v=<mtime>.<size>
//  R24 같은 페이지에서 다시 열기 → /file 요청 0 · 미리보기 곧바로 섬
//  R25 한 파일 판이 바뀜 → 그 파일만 1회 다시 받는다
//  R26 판 없이(mtime 없음) 부른 미리보기 → 보관하지 않는다(다시 열면 다시 받는다)
//  R27 서버가 느릴 때 이름 확정 **직후**(응답 전) ⌘Z → 방금 바꾼 이름이 되돌려진다(그 앞의 일이 아니다)
//  R28 서버가 느릴 때 ⌘D 를 빠르게 두 번 → 복사본 둘이 서로 다른 이름(뒤엣것이 앞엣것을 덮지 않는다)
//  R29 이름칸을 연 채 다른 폴더로 간다(경로 조각) → 격자가 온전히 선다 · 페이지 오류 0(그리는 도중 또 그리지 않는다)
//  R30 메뉴 요소가 엔진 밖에서 떼어져도(부품 destroy 등) Esc 가 삼켜지지 않는다
//  W2  모든 장면을 통틀어 페이지 오류(잡히지 않은 예외·거부) 0
//
// 왜 런타임인가: 결함이 «CSS 특이도(찾기 14px) · 앵커 팝오버가 바탕을 안 준다 · 넘치면 줄바꿈» 같은 **계산된 모양**과
//  «키 → 동작 → 서버 요청» 의 배선이라 소스 문자열로는 안 보인다. 그래서 실제 스타일시트와 프로덕션 소스(web/v2/panes-files.ts
//  를 esbuild 로 묶음)를 헤드리스 크롬에 세우고, 가짜 서버(fetch·XHR 대역)가 받은 요청으로 부작용을 잰다 — 문구가 아니다.
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles 를 물린다(변경 전 = `git archive HEAD web public/styles`).
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;

const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 곁칸 자료 런타임 검증 미실행");
  process.exit(0);
}
const STYLES = path.join(SRC_ROOT, "public/styles");
const CSS = ["01-base.css", "03-components.css", "20-dashboard.css", "42-v2-panes.css", "49-v2-ctx.css"].map((f) => path.join(STYLES, f));
for (const f of CSS) if (!existsSync(f)) { console.error(`FAIL  스타일시트 없음: ${f}`); process.exit(1); }

// 프로덕션 소스를 그대로 묶는다 — 자료 부품 · 앵커 팝오버(core) · 미리보기 기계.
const bundle = buildSync({
  stdin: {
    contents: "export { filesPart } from './web/v2/panes-files.ts'; export { anchoredPopover } from './web/core.ts'; export { createPreviewKit } from './web/v2/file-preview.ts';",
    resolveDir: SRC_ROOT, loader: "ts",
  },
  bundle: true, format: "iife", globalName: "PF", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;

// ── 페이지 안에서 도는 장면들(문자열로 직렬화해 싣는다) ─────────────────────────────
async function PAGE_MAIN() {
  const R = {};
  const pageErrors = [];
  window.addEventListener("error", (e) => pageErrors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => pageErrors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  //  서버 왕복을 기다리는 자리는 **조건**으로 기다린다 — 고정 시간은 느린 러너(CI 리눅스)에서 앞 장면의 되돌리기를 집었다(R21 실측).
  const waitFor = async (fn, ms = 4000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(20); } return false; };
  const SRC = document.getElementById("pfsrc").textContent;
  localStorage.setItem("lively_ui_token", "t");
  localStorage.setItem("lively_pn_files_sort", "name:asc");
  localStorage.setItem("lively_pn_files_view", "icon");
  localStorage.setItem("lively_pn_files_iconsz", "110");
  localStorage.setItem("lively_pn_files_note", "0");
  // ── 가짜 서버 ──
  const png = await new Promise((res) => { const c = document.createElement("canvas"); c.width = 40; c.height = 30; const x = c.getContext("2d"); x.fillStyle = "#39c"; x.fillRect(0, 0, 40, 30); c.toBlob((b) => b.arrayBuffer().then((a) => res(new Uint8Array(a))), "image/png"); });
  const enc = (s) => new TextEncoder().encode(s);
  let FS;
  const seed = () => {
    FS = new Map();
    const put = (p, type, data, mtime) => FS.set(p, { type, data: data || new Uint8Array(0), mtime });
    put("docs", "dir", null, 1000);
    put("docs/inner.txt", "file", enc("inner"), 1001);
    put("readme.md", "file", enc("# readme"), 2000);
    put("notes.txt", "file", enc("notes"), 3000);
    put("보고서.txt", "file", enc("보고서 본문"), 4000);
    put("사진.png", "file", png, 5000);
  };
  seed();
  const log = [];
  const kids = (dir) => [...FS.keys()].filter((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === dir);
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
  let DELAY = 0;   // 느린 서버(R27·R28) — 요청마다 이만큼 늦게 답한다
  const serve = async (url, opts = {}) => {
    if (DELAY) await sleep(DELAY);
    const u = new URL(url, "http://x/");
    const m = String(opts.method || "GET").toUpperCase();
    log.push(m + " " + decodeURIComponent(u.pathname + u.search));
    const mm = /\/projects\/(\d+)(\/.*)$/.exec(u.pathname);
    if (!mm) return J({ error: "no" }, 404);
    const route = mm[2], q = u.searchParams.get("path") || "";
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (route === "/files") return J({ items: kids(q).map((p) => { const e = FS.get(p); return { name: p.split("/").pop(), type: e.type, size: e.data.length, mtime: e.mtime }; }) });
    if (route === "/shared/manifest") return J({ files: [...FS].filter(([, e]) => e.type === "file").map(([p, e]) => ({ path: p, size: e.data.length, mtime: e.mtime })) });
    if (route === "/file" && m === "GET") { const e = FS.get(q); return e ? new Response(e.data, { status: 200 }) : J({ error: "없음" }, 404); }
    if (route === "/file" && m === "DELETE") { for (const k of [...FS.keys()]) if (k === q || k.startsWith(q + "/")) FS.delete(k); return J({ ok: true, trashed: 0 }); }
    if (route === "/folder" && m === "POST") { FS.set(q, { type: "dir", data: new Uint8Array(0), mtime: 9000 + log.length }); return J({ ok: true }); }
    if (route === "/file/rename") { const e = FS.get(body.path); const to = (body.path.includes("/") ? body.path.slice(0, body.path.lastIndexOf("/") + 1) : "") + body.name; FS.delete(body.path); FS.set(to, e); return J({ ok: true }); }
    if (route === "/move") { const moved = []; for (const p of body.paths) { const to = (body.to ? body.to + "/" : "") + p.split("/").pop(); FS.set(to, FS.get(p)); FS.delete(p); moved.push(to); } return J({ ok: true, moved, failed: [] }); }
    return J({ error: "?" }, 404);
  };
  window.fetch = serve;
  window.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.status = 0; this.responseText = ""; }
    open(m, url) { this.m = m; this.url = url; }
    setRequestHeader() {}
    send(file) {
      const u = new URL(this.url, "http://x/");
      log.push(this.m + " " + decodeURIComponent(u.pathname + u.search));
      Promise.resolve(DELAY ? sleep(DELAY) : 0).then(() => (file && file.arrayBuffer ? file.arrayBuffer() : new ArrayBuffer(0))).then((a) => {
        FS.set(u.searchParams.get("path"), { type: "file", data: new Uint8Array(a), mtime: 9500 + log.length });
        this.status = 200; this.responseText = "{}"; this.onload && this.onload(); this.onloadend && this.onloadend();
      });
    }
    abort() {}
  };
  let clipWrites = 0;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { clipWrites++; }, read: async () => [] } });
  const clicked = [];
  const origClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () { if (this.type === "file") { clicked.push(this.hasAttribute("webkitdirectory") ? "dir" : "file"); return; } return origClick.call(this); };

  // ⚠ 구식 헤드리스(--dump-dom)는 화면 갱신 주기를 돌리지 않는다 — ResizeObserver·IntersectionObserver·rAF 가 한 번도 안 불린다
  //  (2026-09-30 실측 0/0/0). 배치 계산(scrollWidth·offsetTop)은 실제 값 그대로 쓰고, **알림만** 여기서 쏜다:
  //  크기 관찰자는 fireRO() 로(폭을 바꾼 뒤), 보임 관찰자는 observe 즉시 «보인다» 로.
  const ROs = new Set();
  window.ResizeObserver = class { constructor(cb) { this.cb = cb; this.els = new Set(); ROs.add(this); } observe(e) { this.els.add(e); setTimeout(() => this.els.size && this.cb([...this.els].map((t) => ({ target: t }))), 0); } unobserve(e) { this.els.delete(e); } disconnect() { this.els.clear(); ROs.delete(this); } };
  const fireRO = () => { for (const o of ROs) if (o.els.size) o.cb([...o.els].map((t) => ({ target: t }))); };
  window.IntersectionObserver = class { constructor(cb) { this.cb = cb; this.dead = false; } observe(e) { setTimeout(() => { if (!this.dead) this.cb([{ target: e, isIntersecting: true }]); }, 0); } unobserve() {} disconnect() { this.dead = true; } };
  const fresh = (platform) => { Object.defineProperty(navigator, "platform", { configurable: true, get: () => platform }); return (new Function(SRC + "\n;return PF;"))(); };
  let PFm = null;
  const opened = [];
  const mount = (mod, width, height = 700) => {
    document.getElementById("host")?.remove();
    const host = document.createElement("div");
    host.id = "host";
    host.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;display:flex;flex-direction:column;background:var(--bg)`;
    document.body.append(host);
    let dead = false;
    const part = mod.filesPart({ id: 7, dead: () => dead, openFile: (f) => opened.push(f.path) });
    part.root.style.cssText += ";flex:1;min-height:0;display:flex;flex-direction:column";
    host.append(part.root);
    return { host, part, root: part.root, kill: () => { dead = true; part.destroy(); host.remove(); } };
  };
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const order = () => $$("#host [data-fp]").map((n) => n.dataset.fp);
  const selected = () => $$("#host [data-fp].on").map((n) => n.dataset.fp);
  const key = (target, k, code, mods = {}) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true, ...mods }));
  const clickFp = (fp, mods = {}) => $(`#host [data-fp="${CSS.escape(fp)}"]`).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, ...mods }));
  const since = (n) => log.slice(n);
  const crumb = () => $$("#host .pn-fcrumb").map((b) => b.textContent).join("/");
  const opaque = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ""); if (!m) return false; const p = m[1].split(",").map(Number); return p.length < 4 || p[3] > 0.95; };

  // ═══ 장면 A — 도구줄 · 메뉴(맥) ═══
  try {
    PFm = fresh("MacIntel");
    const A = mount(PFm, 600);
    await sleep(400);
    const tools = $("#host .pn-ftools");
    const FOLD = ["size", "view", "sort", "mk"];
    const whichFolded = () => {
      const vis = (n) => !!n && getComputedStyle(n).display !== "none" && !n.hidden;
      const els = { size: $("#host .pn-fsize"), view: $$("#host .pn-ftools .pn-fbtn").find((b) => !b.classList.contains("wide") && !b.classList.contains("pn-fmore-tools")), sort: $("#host .pn-fbtn.wide"), mk: $$("#host .pn-ftools .btn-text").find((b) => b.textContent.trim() === "새 폴더") };
      return FOLD.filter((k) => !vis(els[k]));
    };
    R.tools = {};
    for (const w of [600, 420, 340, 280]) {
      A.host.style.width = w + "px";
      fireRO();
      await sleep(250);
      const moreB = $("#host .pn-fmore-tools");
      R.tools[w] = { h: Math.round(tools.getBoundingClientRect().height), over: tools.scrollWidth - tools.clientWidth, folded: whichFolded(), more: !!moreB && getComputedStyle(moreB).display !== "none" && !moreB.hidden };
    }
    A.host.style.width = "600px"; fireRO(); await sleep(250);
    const find = $("#host .pn-ffind"), mk = $$("#host .pn-ftools .btn-text").find((b) => b.textContent.trim() === "새 폴더");
    R.font = { find: getComputedStyle(find).fontSize, mk: mk ? getComputedStyle(mk).fontSize : "-", findH: Math.round(find.getBoundingClientRect().height), mkH: mk ? Math.round(mk.getBoundingClientRect().height) : -1 };
    // R5 정렬 메뉴
    const sortB = $("#host .pn-fbtn.wide");
    sortB.click();
    await sleep(120);
    const menu = $(".pn-ctx") || $(".dash-pop");
    R.sort = menu ? { bg: getComputedStyle(menu).backgroundColor, checked: $$('[aria-checked="true"]', menu).map((b) => b.textContent.trim()), onAt: $$(".on", menu).map((b) => b.textContent.trim()) } : null;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(30);
    // R6 앵커 팝오버
    const a = document.createElement("button"); document.body.append(a);
    const bare = document.createElement("div"); bare.textContent = "x";
    const c1 = PFm.anchoredPopover(a, bare); R.bare = getComputedStyle(bare).backgroundColor; c1();
    const own = document.createElement("div"); own.className = "dash-pop-panel";
    const c2 = PFm.anchoredPopover(a, own); const cs = getComputedStyle(own); R.own = { bg: cs.backgroundColor, radius: cs.borderTopLeftRadius, pad: cs.paddingTop }; c2(); a.remove();
    // R7 올리기
    const car = $("#host .pn-up-car");
    if (car) { car.click(); await sleep(120); R.upMenu = $$(".pn-ctx .pn-ctx-i").map((b) => b.textContent.trim()); document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(30); } else R.upMenu = null;
    // R30 메뉴 요소를 밖에서 떼어 낸 뒤 Esc — 다른 자리(입력칸)가 Esc 를 받아야 한다
    sortB.click(); await sleep(120);
    $(".pn-ctx")?.remove();
    const probe = document.createElement("input"); document.body.append(probe); probe.focus();
    let escGot = 0; probe.addEventListener("keydown", (e) => { if (e.key === "Escape") escGot++; });
    probe.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    probe.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    R.r30 = escGot; probe.remove();
    clicked.length = 0;
    const mainUp = $$("#host .pn-ftools button").find((b) => /올리기/.test(b.textContent));
    mainUp.click();
    R.upMain = clicked.slice();
    A.kill();
  } catch (e) { R.errA = String(e && e.stack || e); }

  // ═══ 장면 B — 키보드 · 클립보드 · 되돌리기(맥) ═══
  try {
    seed(); opened.length = 0;
    PFm = fresh("MacIntel");
    const B = mount(PFm, 420);
    await sleep(400);
    const root = B.root; root.focus();
    const ord = order();
    R.order = ord;
    const first = ord[0], files = ord.filter((p) => p !== "docs");
    // R8 맥 Enter
    clickFp("readme.md"); key(root, "Enter", "Enter"); await sleep(60);
    R.r8 = { editor: !!$('#host [data-fp="readme.md"] .pn-frename'), opened: opened.length };
    const ed = $("#host .pn-frename"); if (ed) key(ed, "Escape", "Escape"); await sleep(60);
    // R10·R11 방향키
    clickFp(first); key(root, "ArrowRight", "ArrowRight");
    R.r10a = { want: ord[1], got: selected() };
    const kidsEl = $$("#host .pn-fgrid > [data-fp]"); const top0 = kidsEl[0].offsetTop; const cols = kidsEl.filter((k) => k.offsetTop === top0).length;
    key(root, "ArrowDown", "ArrowDown");
    R.r10b = { cols, want: ord[Math.min(ord.length - 1, 1 + cols)], got: selected() };
    clickFp(first); key(root, "ArrowRight", "ArrowRight", { shiftKey: true });
    R.r11 = selected().length;
    // R12
    key(root, "a", "KeyA", { metaKey: true }); R.r12a = selected().length; R.total = ord.length;
    key(root, "Escape", "Escape"); R.r12b = selected().length;
    // R13·R14 폴더 드나들기
    clickFp("docs"); key(root, "ArrowDown", "ArrowDown", { metaKey: true });
    await waitFor(() => order().includes("docs/inner.txt"));
    R.r13a = { crumb: crumb(), items: order() };
    key(root, "ArrowUp", "ArrowUp", { metaKey: true });
    await waitFor(() => order().includes("docs") && selected().length > 0);
    R.r13b = { crumb: crumb(), sel: selected() };
    key(root, "[", "BracketLeft", { metaKey: true });
    await waitFor(() => order().includes("docs/inner.txt"));
    R.r14 = crumb();
    key(root, "ArrowUp", "ArrowUp", { metaKey: true });
    await waitFor(() => order().includes("docs"));
    // R15 타이핑 고르기
    await sleep(1100);
    key(root, "q", "KeyQ"); R.r15 = selected();
    await sleep(1100);
    // R16 Space
    opened.length = 0; clickFp("보고서.txt"); key(root, " ", "Space"); R.r16 = opened.slice();
    // R17 새 폴더
    let n0 = log.length;
    key(root, "N", "KeyN", { metaKey: true, shiftKey: true });
    await waitFor(() => !!$('#host [data-fp="새 폴더"] .pn-frename'));
    R.r17 = { reqs: since(n0).filter((l) => /^POST .*\/folder/.test(l)), editor: !!$('#host [data-fp="새 폴더"] .pn-frename') };
    const ed2 = $("#host .pn-frename"); if (ed2) key(ed2, "Escape", "Escape"); await sleep(80);
    root.focus();
    // R18 ⌘C → paste(표식)
    clickFp("보고서.txt"); key(root, "c", "KeyC", { metaKey: true }); await sleep(30);
    n0 = log.length;
    const dt = new DataTransfer(); dt.setData("text/plain", "보고서.txt");
    root.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    await waitFor(() => since(n0).some((l) => /^PUT /.test(l)) && FS.has("보고서 복사본.txt"));
    await sleep(100);
    R.r18 = { clipWrites, reqs: since(n0).filter((l) => /\/file\?/.test(l)) };
    // R19 paste(딴 글)
    n0 = log.length;
    const dt2 = new DataTransfer(); dt2.setData("text/plain", "hello other");
    root.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt2, bubbles: true, cancelable: true }));
    await waitFor(() => since(n0).some((l) => /^PUT /.test(l)));
    await sleep(100);
    R.r19 = since(n0).filter((l) => /\/file\?/.test(l));
    // R20 ⌘D
    root.focus(); clickFp("사진.png"); n0 = log.length;
    key(root, "d", "KeyD", { metaKey: true });
    await waitFor(() => since(n0).some((l) => /^PUT /.test(l)) && FS.has("사진 복사본.png"));
    await sleep(150);
    R.r20 = since(n0).filter((l) => /^PUT /.test(l));
    // R21 이름 바꾸기 → ⌘Z
    root.focus(); clickFp("notes.txt"); key(root, "Enter", "Enter"); await sleep(60);
    const ed3 = $('#host [data-fp="notes.txt"] .pn-frename');
    n0 = log.length;
    if (ed3) { ed3.value = "memo.txt"; key(ed3, "Enter", "Enter"); }
    await waitFor(() => FS.has("memo.txt") && order().includes("memo.txt"));
    await sleep(100);
    root.focus();
    key(root, "z", "KeyZ", { metaKey: true });
    await waitFor(() => FS.has("notes.txt") && order().includes("notes.txt"));
    R.r21 = since(n0).filter((l) => /rename/.test(l)).length;
    R.r21fs = [FS.has("notes.txt"), FS.has("memo.txt")];
    // R27 느린 서버 — 이름 확정 직후 곧바로 ⌘Z
    DELAY = 150;
    const n27 = log.length;
    root.focus(); clickFp("readme.md"); key(root, "Enter", "Enter"); await sleep(60);
    const ed4 = $('#host [data-fp="readme.md"] .pn-frename');
    if (ed4) { ed4.value = "readme2.md"; key(ed4, "Enter", "Enter"); }
    root.focus();
    key(root, "z", "KeyZ", { metaKey: true });
    //  이름 바꾸기 → 되돌리기 두 요청이 **다** 간 뒤에 잰다(첫 요청 전에는 원래 상태라 «되돌려졌다» 로 거짓 초록이 난다).
    await waitFor(() => since(n27).filter((l) => /rename/.test(l)).length >= 2, 6000);
    await waitFor(() => FS.has("readme.md") && order().includes("readme.md"), 3000);
    await sleep(200);
    R.r27 = { readme: FS.has("readme.md"), readme2: FS.has("readme2.md"), dupKept: FS.has("사진 복사본.png") };
    R.r27log = since(n27).filter((l) => !/\/files\?/.test(l));
    R.r27toasts = $$("#toasts .toast").map((t) => t.textContent).slice(-4);
    // R28 느린 서버 — ⌘D 두 번 빠르게
    root.focus(); clickFp("보고서.txt"); n0 = log.length;
    key(root, "d", "KeyD", { metaKey: true });
    key(root, "d", "KeyD", { metaKey: true });
    await waitFor(() => since(n0).filter((l) => /^PUT /.test(l)).length >= 2, 8000);
    await sleep(400);
    R.r28 = since(n0).filter((l) => /^PUT /.test(l));
    DELAY = 0;
    // R29 이름칸을 연 채 경로 조각으로 다른 폴더로
    root.focus(); clickFp("docs"); key(root, "ArrowDown", "ArrowDown", { metaKey: true });
    await waitFor(() => order().includes("docs/inner.txt"));
    clickFp("docs/inner.txt"); key(root, "Enter", "Enter"); await sleep(60);
    const ed5 = $('#host [data-fp="docs/inner.txt"] .pn-frename'); if (ed5) ed5.focus();
    const e0 = pageErrors.length;
    $$("#host .pn-fcrumb")[0].click();
    await waitFor(() => order().includes("docs") && order().includes("보고서.txt"));
    await sleep(100);
    R.r29 = { editorWas: !!ed5, errors: pageErrors.slice(e0), order: order(), editorLeft: !!$("#host .pn-frename") };
    B.kill();
  } catch (e) { R.errB = String(e && e.stack || e); }

  // ═══ 장면 C — 윈도 ═══
  try {
    seed(); opened.length = 0;
    PFm = fresh("Win32");
    const C = mount(PFm, 420);
    await sleep(400);
    const root = C.root; root.focus();
    clickFp("readme.md"); key(root, "Enter", "Enter"); await sleep(60);
    R.r9 = { opened: opened.slice(), editor: !!$("#host .pn-frename") };
    clickFp("docs"); key(root, "Enter", "Enter");
    await waitFor(() => order().includes("docs/inner.txt"));
    const inDocs = crumb();
    key(root, "Backspace", "Backspace");
    await waitFor(() => order().includes("docs"));
    R.r22 = { inDocs, after: crumb(), confirm: !!$(".ov-back") };
    $(".ov-back")?.remove();
    C.kill();
  } catch (e) { R.errC = String(e && e.stack || e); }

  // ═══ 장면 D — 미리보기 보관 ═══
  try {
    seed();
    PFm = fresh("MacIntel");
    const waitPv = async (want, ms = 3000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if ($$("#host .pn-fic.has-pv").length >= want) break; await sleep(20); } return $$("#host .pn-fic.has-pv").length; };
    const want = $$("#host").length; void want;
    let n0 = log.length;
    let D = mount(PFm, 600, 900);
    const firstFill = await waitPv(4);
    R.r23 = { fill: firstFill, gets: since(n0).filter((l) => /^GET .*\/file\?/.test(l)) };
    D.kill();
    n0 = log.length;
    D = mount(PFm, 600, 900);
    await sleep(0);
    R.r24 = { gets: since(n0).filter((l) => /^GET .*\/file\?/.test(l)).length, fillSoon: 0 };
    await sleep(120);
    R.r24.fillSoon = $$("#host .pn-fic.has-pv").length;
    D.kill();
    FS.get("사진.png").mtime = 6000;
    n0 = log.length;
    D = mount(PFm, 600, 900);
    //  다시 열면 보관본 목록으로 **먼저** 그린다(옛 판 그림이 곧바로 선다) — 서버 목록이 와서 판이 바뀐 걸 안 뒤에 다시 받는다.
    const t0 = performance.now();
    while (performance.now() - t0 < 3000 && !since(n0).some((l) => /^GET .*\/files\?/.test(l))) await sleep(20);
    await sleep(300);
    await waitPv(4);
    R.r25 = since(n0).filter((l) => /^GET .*\/file\?/.test(l));
    D.kill();
    // R26 판 없이
    const kit1 = PFm.createPreviewKit({ fileUrl: (p) => "/api/ui/v6/projects/7/file?path=" + encodeURIComponent(p), dead: () => false });
    const mk = () => { const b = document.createElement("span"); b.className = "pn-fic text"; b.dataset.pv = "readme.md"; b.dataset.pvk = "text"; b.dataset.pvs = "8"; b.style.cssText = "display:block;width:100px;height:80px"; document.body.append(b); return b; };
    n0 = log.length;
    kit1.watch(mk(), "readme.md", "text", 8); await sleep(200);
    const kit2 = PFm.createPreviewKit({ fileUrl: (p) => "/api/ui/v6/projects/7/file?path=" + encodeURIComponent(p), dead: () => false });
    kit2.watch(mk(), "readme.md", "text", 8); await sleep(200);
    R.r26 = since(n0).filter((l) => /^GET .*\/file\?/.test(l)).length;
  } catch (e) { R.errD = String(e && e.stack || e); }

  R.pageErrors = pageErrors;
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const PAGE = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out">PENDING</pre>
<script type="text/plain" id="pfsrc">${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;

if (process.env.DUMP_PAGE) { const fs = await import("node:fs"); fs.writeFileSync(process.env.DUMP_PAGE, PAGE); for (const f of CSS) fs.copyFileSync(f, path.join(path.dirname(process.env.DUMP_PAGE), path.basename(f))); }
const dom = await dumpDom(chrome, { html: PAGE, copy: CSS, prefix: "side-files-", virtualTimeBudget: 60000 });
const m = /<pre id="out">([\s\S]*?)ENDRESULT/.exec(dom);
if (!m) { console.error("FAIL  페이지가 결과를 안 냈다\n" + dom.slice(0, 1500)); process.exit(1); }
const txt = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const R = JSON.parse(txt);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why) => (cond ? ok(n) : bad(n, why));
const opaque = (c) => { const mm = /rgba?\(([^)]+)\)/.exec(c || ""); if (!mm) return false; const p = mm[1].split(",").map(Number); return p.length < 4 || p[3] > 0.95; };
for (const k of ["fatal", "errA", "errB", "errC", "errD"]) if (R[k]) bad(`장면 오류 ${k}`, R[k].slice(0, 400));

// 배선 — 장치가 살아 있나(가짜 서버가 목록을 줬고 칸이 섰다). 안 섰으면 아래 «0건» 단언이 공짜로 초록이 된다.
check(Array.isArray(R.order) && R.order.length === 5 && R.order.includes("docs"), "W1 가짜 서버 목록으로 칸 다섯이 섰다", JSON.stringify(R.order));

const FOLD = ["size", "view", "sort", "mk"];
for (const w of [600, 420, 340, 280]) {
  const t = R.tools?.[w];
  if (!t) { bad(`R1 도구줄 ${w}`, "측정 없음"); continue; }
  check(t.h <= 30 && t.over <= 1, `R1 폭 ${w} — 도구줄 한 줄`, `높이 ${t.h} · 넘침 ${t.over}`);
  check(JSON.stringify(t.folded) === JSON.stringify(FOLD.slice(0, t.folded.length)), `R2 폭 ${w} — 덜 중요한 것부터 접힌다`, `접힘 ${JSON.stringify(t.folded)}`);
  check(t.more === t.folded.length > 0, `R2 폭 ${w} — [⋯] 는 접힌 것이 있을 때만`, `[⋯] ${t.more} · 접힘 ${t.folded.length}`);
}
check(R.tools?.[600]?.folded.length === 0 && !R.tools?.[600]?.more, "R3 넓은 폭은 아무것도 안 접는다", JSON.stringify(R.tools?.[600]));
check(R.tools?.[280]?.folded.length > 0, "R2 대조: 좁은 폭(280)에선 실제로 접힌다", JSON.stringify(R.tools?.[280]));
check(R.font && R.font.find === R.font.mk && Math.abs(R.font.findH - R.font.mkH) <= 1, "R4 찾기칸 글자·높이 = [새 폴더]", JSON.stringify(R.font));
check(R.sort && opaque(R.sort.bg), "R5 정렬 메뉴 바탕이 불투명하다", JSON.stringify(R.sort));
check(R.sort && (R.sort.checked.includes("이름") || R.sort.onAt.includes("이름")), "R5 지금 기준(이름)이 표시된다", JSON.stringify(R.sort));
check(opaque(R.bare), "R6 바탕을 안 준 앵커 팝오버도 바탕이 깔린다", String(R.bare));
check(R.own && opaque(R.own.bg) && R.own.radius === "12px" && R.own.pad === "6px", "R6 제 바탕 가진 패널은 제 것 그대로", JSON.stringify(R.own));
check(Array.isArray(R.upMenu) && R.upMenu.some((s) => /파일/.test(s)) && R.upMenu.some((s) => /폴더/.test(s)), "R7 [⌄] 메뉴에 파일·폴더", JSON.stringify(R.upMenu));
check(JSON.stringify(R.upMain) === '["file"]', "R7 큰 단추는 파일 창을 곧바로 연다", JSON.stringify(R.upMain));
check(R.r8 && R.r8.editor && R.r8.opened === 0, "R8 맥 Enter → 이름 바꾸기(열지 않는다)", JSON.stringify(R.r8));
check(R.r9 && JSON.stringify(R.r9.opened) === '["readme.md"]' && !R.r9.editor, "R9 윈도 Enter → 열기", JSON.stringify(R.r9));
check(R.r10a && JSON.stringify(R.r10a.got) === JSON.stringify([R.r10a.want]), "R10 → 다음 칸", JSON.stringify(R.r10a));
check(R.r10b && R.r10b.cols > 1 && JSON.stringify(R.r10b.got) === JSON.stringify([R.r10b.want]), "R10 ↓ 한 줄 아래(격자 열 수만큼)", JSON.stringify(R.r10b));
check(R.r11 === 2, "R11 ⇧→ 두 개", String(R.r11));
check(R.r12a === R.total && R.r12b === 0, "R12 ⌘A 전부 · Esc 0", `${R.r12a}/${R.total} · ${R.r12b}`);
check(R.r13a && /docs/.test(R.r13a.crumb) && R.r13a.items.includes("docs/inner.txt"), "R13 ⌘↓ 폴더로 들어간다", JSON.stringify(R.r13a));
check(R.r13b && !/docs/.test(R.r13b.crumb) && JSON.stringify(R.r13b.sel) === '["docs"]', "R13 ⌘↑ 나오고 나온 폴더가 골라져 있다", JSON.stringify(R.r13b));
check(typeof R.r14 === "string" && /docs/.test(R.r14), "R14 ⌘[ 앞 폴더로", String(R.r14));
check(JSON.stringify(R.r15) === '["보고서.txt"]', "R15 q(자판 ㅂ) → 보고서", JSON.stringify(R.r15));
check(JSON.stringify(R.r16) === '["보고서.txt"]', "R16 Space → 빠른 보기(연다)", JSON.stringify(R.r16));
check(R.r17 && R.r17.reqs.some((l) => /path=새 폴더$/.test(l)) && R.r17.editor, "R17 ⇧⌘N → 새 폴더 + 이름칸", JSON.stringify(R.r17));
check(R.r18 && R.r18.reqs.some((l) => /^GET .*path=보고서\.txt&download=1/.test(l)) && R.r18.reqs.some((l) => /^PUT .*path=보고서 복사본\.txt$/.test(l)), "R18 ⌘C → ⌘V 복사본을 만든다", JSON.stringify(R.r18));
check(Array.isArray(R.r19) && !R.r19.some((l) => /download=1/.test(l)) && R.r19.some((l) => /^PUT .*붙여넣은 글/.test(l)), "R19 그새 딴 글을 복사했으면 그 글을 붙인다", JSON.stringify(R.r19));
check(Array.isArray(R.r20) && R.r20.some((l) => /path=사진 복사본\.png$/.test(l)), "R20 ⌘D 복제", JSON.stringify(R.r20));
check(R.r21 === 2 && JSON.stringify(R.r21fs) === "[true,false]", "R21 이름 바꾸기 → ⌘Z 원래 이름", `rename ${R.r21} · fs ${JSON.stringify(R.r21fs)}`);
check(R.r27 && R.r27.readme && !R.r27.readme2 && R.r27.dupKept, "R27 응답 전 ⌘Z 도 방금 한 이름 바꾸기를 되돌린다(앞의 복제는 그대로)", JSON.stringify(R.r27));
check(Array.isArray(R.r28) && R.r28.length === 2 && new Set(R.r28).size === 2, "R28 ⌘D 두 번 → 서로 다른 복사본 이름", JSON.stringify(R.r28));
check(R.r29 && R.r29.editorWas && R.r29.errors.length === 0 && R.r29.order.includes("docs") && R.r29.order.length >= 5 && !R.r29.editorLeft, "R29 이름칸 연 채 다른 폴더로 — 격자 온전 · 오류 0", JSON.stringify(R.r29));
check(R.r30 === 2, "R30 떼어진 메뉴가 Esc 를 삼키지 않는다", String(R.r30));
check(Array.isArray(R.pageErrors) && R.pageErrors.length === 0, "W2 페이지 오류 0", JSON.stringify(R.pageErrors));
check(R.r22 && /docs/.test(R.r22.inDocs) && !/docs/.test(R.r22.after) && !R.r22.confirm, "R22 윈도 Backspace → 뒤로(삭제 아님)", JSON.stringify(R.r22));
check(R.r23 && R.r23.fill >= 4 && R.r23.gets.length >= 4 && R.r23.gets.every((l) => /&v=\d+\.\d+/.test(l)), "R23 미리보기 요청에 판(&v=)", JSON.stringify(R.r23));
check(R.r24 && R.r24.gets === 0 && R.r24.fillSoon >= 4, "R24 다시 열면 받지 않고 곧바로 선다", JSON.stringify(R.r24));
check(Array.isArray(R.r25) && R.r25.length === 1 && /사진\.png&v=6000\./.test(R.r25[0]), "R25 판이 바뀐 파일만 다시 받는다", JSON.stringify(R.r25));
check(R.r26 === 2, "R26 판 없이 부른 것은 보관하지 않는다(두 번 받는다)", String(R.r26));

console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
