#!/usr/bin/env node
// 웹 판 원격 화면(#4993 (A)) 배선을 실제 크롬에 세워 보는 런타임 검증 — v2/remote-web.ts.
//
//  판정(키 · 좌표 · 휠 · 입력 모으기 · 받기 간격)은 remote-web-kit.test.mjs 가 값으로 잰다. 여기는 그 판정이 **칸에 어떻게
//  이어졌나**를 본다 — 격리 리뷰의 blocking(세션을 바꾸는 순간 아직 안 보낸 글 · 클릭이 새 세션 탭으로 가고, 날아가던 옛 화면이
//  새 칸에 그려졌다)은 전부 배선에 있었고, 순수 시험으로는 잡을 수 없었다.
//  가짜는 둘 — fetch(/api/ui/browser/* — 느린 데스크톱 흉내: 동작 0.6초 · 화면 0.3초)와 IntersectionObserver(아래 ioShow). 부품 · CSS 는 제품 그대로.
//
// 사양(엣지 표 — 행마다 단언 하나 이상):
//  R1 세션 A 화면에서 글을 치고 40ms 안에 세션 B 로 — 그 글은 A 로(x-lively-session A) · B 로 가는 type 0건
//  R2 A 에서 누르고(두 번 누름 대기 중) 100ms 안에 B 로 — 그 누르기는 A 로 · B 로 가는 click 0건
//  R3 A 화면을 받는 중에 B 로 — 늦게 온 A 그림이 칸에 그려지지 않고 칸 탭 이름도 A 것으로 안 바뀐다 · 칸엔 B 그림
//  R3b A 에서 연 주소의 이동 응답이 늦게 오는 중에 B 로 — 그 응답이 칸 탭 이름 · 주소줄을 A 것으로 바꾸지 않는다
//  R4 B 로 바꾼 뒤 나가는 요청은 전부 B
//  R5 원격 동작이 느린데(0.6초) 키를 꾹 눌러 40번(반복) — act 8번 이하 · 키 40개 다 간다 · 놓은 뒤 5초 안에 끝난다
//  R5b (경계) 아주 느린데(3초) 60번 — 밀린 반복은 30개에서 끊는다(30~40개만 가고 90초 안에 다 끝난다) · 처음 누른 키는 간다
//  R6 동작이 느린데 단어를 0.3초 간격으로 8번 — type 은 8번보다 적다(모아 보냄) · 글은 순서대로 다 · 다 A 로
//  R7 act 가 409 인데 다시 물으니 연결돼 있다(세션 주인 불일치 같은 것) — 원격 화면 그대로 · 서버 문구를 보인다
//  R7b act 가 409 이고 다시 물어도 끊겼다 — iframe 칸으로
//  R8 곁칸 뿌리에 pn:open-web {url} — 그 주소로 navigate(이 칸의 세션 · 탭 번호)
//  R9 칸 안을 만진 뒤 ⌘R — 원격 새로고침(라이블리 전체가 아니라) · 칸 밖을 만진 뒤 ⌘R 은 손대지 않는다
//  R10 데스크톱이 없어 iframe 칸인데 칸이 숨어 있으면 연결을 묻지 않는다 · 다시 보이고 데스크톱이 켜지면 30초 안에 원격 화면
//  R11 칸이 숨으면 화면 받기를 멈추고, 다시 보이면 곧바로(1.5초 안) 받는다 — 셸의 8초 틱을 기다리지 않는다
//  R12 느린 두 번 누름(0.3초 간격 — OS 간격 안) — double_click 하나만(click 이 먼저 나가 원격에서 세 번 눌리지 않는다)
//  R12b 누르고 0.1초 뒤 친 글 — 누르기가 먼저, 글이 뒤(두 번 누름을 기다리는 누르기를 글이 앞지르지 않는다)
//  R7c 데스크톱이 한 번 «없음» 이었다가 2.5초 안에 돌아온다 — iframe 칸으로 안 바뀐다(두 번 물어 둘 다 없을 때만)
//  R13 트랙패드처럼 2초 굴림(16ms 간격) — scroll act 6번 이하 · 굴린 만큼 다 간다 · 끝난 뒤 2초 안에 다 굴렀다 · 굴리는 동안에도 그림이 온다
//  R13b 1초 굴리고 0.1초 뒤 누름 — 화면이 굴리기를 따라오는 중이라 누르기를 안 보내고 알린다(보이는 그림의 그 자리는 원격에선
//       이미 굴러간 다른 곳이다) · 2.5초 안에 따라오고, 그 뒤 누르면 간다(굴리기 다음)
//  R13c 아주 느린 원격(동작 2초)에서 0.3초 굴리고 0.1초 뒤 누름 — 따라오는 동안엔 안 가고, 다 따라온 뒤 누르면 굴리기 다음에 간다 · 굴린 만큼 다
//  R13d 같은데 누르지 않는다 — 굴리기가 끝날 때 원격이 바빠도, 줄이 비면 남은 휠이 간다(굴린 만큼 다)
//  R13e 짧게 굴리고 0.3초 뒤 누름 — 굴리기는 나갔지만 그 결과 그림이 아직 안 왔다 → 따라오는 중이라 안 보낸다(그림 번호로 가른다)
//  R13f 굴리기가 실패해(오류) 그림이 아직일 때 누름 — 거절하되 «멈춘 뒤 다시» 가 아니라 «화면이 아직 안 와서» 라고 말한다
//  R13h 한 번 거절한 뒤 3.5초 지나 다시 굴림(누르지 않음) — 거절 알림이 다시 뜨지 않는다(알림을 남기는 것은 거절한 뒤 3초까지)
//  R13g PageDown 으로 굴리고 곧바로 누름 — 그것도 따라오는 중이라 안 보낸다(화살표 · Home · End 는 입력칸 키라 넣지 않는다)
//  R27 거절된 뒤 다시 누름(브라우저는 detail=2 «두 번 누름» 으로 센다) — 한 번 누름 하나만 간다(두 번 누름으로 보내면 버튼이 두 번 눌린다)
//  R27b 거절된 뒤 연달아 누름(detail 2 · 3 · 4 · 5, 0.15초 간격) — 따라온 뒤 누른 넷이 다 한 번 누름으로 간다(«세 번째» 로 소리 없이 버리지 않는다)
//  R14 iframe 칸에서 세션을 바꾸면 곧바로 묻는다 — 3초 안에 원격 화면(30초를 기다리지 않는다)
//  R14b 원격 화면에서 세션을 바꾸면 상태를 다시 묻지 않고 곧바로 새 세션 화면을 받는다(상태 묻기가 3초 걸려도 1초 안에)
//  R15 묻는 사이 세션 없는 자리로 가면 원격 화면이 서지 않는다 · 그 자리 열쇠로 화면을 받지 않는다
//  R15b 원격 화면에서 B 로 바꾸고(묻기 1초) 0.2초 뒤 세션 없는 자리로 — 원격 화면이 서지 않는다 · 그 자리 열쇠로 화면을 받지 않는다
//  R16 A → B → A 로 곧바로 돌아와 이어 친 글 — 데스크톱엔 친 순서대로(hello → world · 옛 A 화면이 남은 글을 보내는 중이어도)
//  R17 클립보드 API 가 없는 자리(https 아님)에서 ⌘C — 알림이 뜨고 원격 글을 읽으러 가지 않는다 · 페이지 오류 0
//  R18 같은 세션을 두고 늦게 온 옛 «없음» 답(첫 묻기)이 그 사이 선 원격 화면을 iframe 칸으로 되돌리지 않는다(더 새로 물은 답이 이긴다)
//  R19 데스크톱이 동작 하나에 끝내 답하지 않는다 — 그동안에도 화면은 받고, 60초 뒤 끊고 뒤에 친 글을 보낸다
//  R21 섞어 친다(시드 고정 6번 × 40 — 글 · 키 · 누르기 · 두 번 누름 · 휠 · 오른쪽 누름 · 이동 · ⌘R · ⌘C, 동작 0.15~1.45초) —
//       데스크톱이 받은 차례가 사람이 한 차례와 같다(인접한 같은 종류는 합쳐 본다 · 굴린 양도 같다)
//  R22 늦게 온 옛 그림(먼저 보냈지만 1.5초 걸린 화면 받기)이 그 사이 온 새 그림을 덮지 않는다
//  R23 느린 이동(4초) 중 받은 화면이 주소줄 · 칸 탭 이름을 옛 주소로 되돌리지 않는다
//  R24 창에 초점이 돌아오면 다음 받기 간격(2초 넘게)을 기다리지 않고 곧바로(0.3초 안) 받는다
//  R26 409 뒤 상태 묻기가 끝내 안 오면 15초 상한으로 끊고 iframe 칸으로(45초 안) — 묻기 하나가 줄 · 화면 받기를 묶지 않는다
//  P  페이지 오류 0
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 원격 화면 런타임 검증 미실행"); process.exit(0); }
const CSS = ["01-base.css", "03-components.css", "40-v2.css", "42-v2-panes.css"].map((f) => path.join(ROOT, "public/styles", f)).filter(existsSync);
const bundle = buildSync({
  stdin: { contents: "export { remoteWebPart } from './web/v2/remote-web.ts';", resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "RW", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;

async function PAGE_MAIN() {
  const R = {};
  const pageErrors = [];
  window.addEventListener("error", (e) => pageErrors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => pageErrors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const waitFor = async (fn, ms = 5000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { try { if (fn()) return true; } catch (_) { /* 아직 */ } await sleep(20); } return false; };
  const SRC = document.getElementById("pfsrc").textContent;
  const $ = (s, r = document) => r.querySelector(s);

  // 세션마다 다른 그림(색) — 칸에 그려진 그림이 어느 세션 것인지 src 로 가른다.
  const IMG = {};
  const colorOf = (i) => `hsl(${(i * 47) % 360} 70% ${35 + (i % 3) * 15}%)`;
  const imgOf = (s) => {
    if (!IMG[s]) {
      const c = document.createElement("canvas"); c.width = 400; c.height = 300;
      const g = c.getContext("2d"); g.fillStyle = colorOf(Object.keys(IMG).length); g.fillRect(0, 0, 400, 300);
      IMG[s] = c.toDataURL("image/png").split(",")[1];
    }
    return IMG[s];
  };
  const srcOf = (s) => "data:image/png;base64," + imgOf(s);
  const keyOfSrc = (src) => Object.keys(IMG).find((k) => "data:image/png;base64," + IMG[k] === src) || null;

  // 가짜 데스크톱(중계 너머) — 부른 것을 다 적는다: op · 세션 머리글 · 본문 · 시작/끝 시각.
  //  versioned — 동작마다 페이지 판이 오르고 그림이 그 판의 것이 된다(늦게 온 옛 그림을 가른다) · trackUrl — 이동이 끝나면 그 주소가
  //   그 세션의 주소가 된다(느린 이동 중 받은 화면은 옛 주소) · statusHang — 상태 묻기가 끝내 안 온다(끊을 때만 끝난다).
  const F = { connected: true, statusConnected: null, statusScript: [], statusDelayScript: [], shotDelayScript: [], hangNext: 0, statusHang: false, versioned: false, ver: {}, trackUrl: false, urlOf: {},
    actStatus: 200, actError: "", delay: { act: 600, screenshot: 300, navigate: 300, eval: 100, status: 20 }, calls: [] };
  const hang = (init) => new Promise((_, rej) => { init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))); });
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
  window.fetch = async (url, init = {}) => {
    const u = new URL(url, "http://x/");
    const m = /^\/api\/ui\/browser\/(\w+)$/.exec(u.pathname);
    if (!m) return J({ error: "no" }, 404);
    const op = m[1];
    const sess = (init.headers || {})["x-lively-session"];
    const body = init.body ? JSON.parse(init.body) : {};
    const rec = { op, sess, body, t0: performance.now(), t1: null };
    F.calls.push(rec);
    //  끝내 안 온다 — 부르는 쪽이 끊을 때만(AbortSignal) 끝난다. 끊긴 요청도 끝난 것으로 적는다(아래 settle 이 영영 기다리지 않게).
    const hung = async () => { try { await hang(init); } catch (e) { rec.t1 = performance.now(); rec.aborted = true; throw e; } };
    if (op === "act" && F.hangNext > 0) { F.hangNext--; await hung(); }
    if (op === "status" && F.statusHang) await hung();
    if (op === "act" && F.versioned) F.ver[sess] = (F.ver[sess] || 0) + 1;   // 동작이 페이지를 바꾼다
    const verAt = F.ver[sess] || 0;
    //  상태 묻기의 답과 걸리는 시간은 **묻는 순간** 대본에서 꺼낸다(늦게 묻고 빨리 끝난 것이 앞 대본을 가로채지 않게).
    const ans = op === "status" && F.statusScript.length ? F.statusScript.shift() : null;
    const ms = op === "status" && F.statusDelayScript.length ? F.statusDelayScript.shift()
      : op === "screenshot" && F.shotDelayScript.length ? F.shotDelayScript.shift()
      : typeof F.delay[op] === "function" ? F.delay[op]() : (F.delay[op] ?? 50);
    rec.ms = ms;
    await sleep(ms);
    if (op === "navigate" && F.trackUrl && body.url) F.urlOf[sess] = body.url;
    rec.t1 = performance.now();
    if (op === "status") return J({ connected: ans ?? (F.statusConnected ?? F.connected) });
    if (!F.connected) return J({ error: "데스크톱 앱이 연결돼 있지 않습니다" }, 409);
    if (op === "act" && F.actStatus !== 200) return J({ error: F.actError }, F.actStatus);
    const res = { url: (F.trackUrl && F.urlOf[sess]) || `https://site-${sess}.test/p`, title: String(sess) };
    if (op === "screenshot" || (op === "act" && body.screenshot)) Object.assign(res, { width: 400, height: 300, scale: 1, image: { mime: "image/png", data: imgOf(F.versioned ? `${sess}@${verAt}` : sess) } });
    if (op === "eval") res.value = "";
    return J(res);
  };
  localStorage.setItem("lively_ui_token", "t");

  //  IntersectionObserver — 이 헤드리스(가상 시간)에선 그리기 단계가 거의 돌지 않아 알림이 오지 않는다(실측: 원격 화면 13개를 세우는 동안
  //   알림 2번). 그래서 가짜로 둔다 — 숨은 칸을 다시 보이게 할 때 시험이 브라우저 대신 «보인다» 알림을 낸다(ioShow). 실제 브라우저는
  //   display:none → 보임 에서 이 알림을 낸다(표준 동작).
  const IOS = new Set();
  window.IntersectionObserver = class { constructor(cb) { this.cb = cb; this.els = []; IOS.add(this); } observe(e) { this.els.push(e); } unobserve() {} disconnect() { IOS.delete(this); } };
  const ioShow = (root) => { for (const io of [...IOS]) { const es = io.els.filter((e) => root.contains(e)).map((e) => ({ target: e, isIntersecting: true })); if (es.length) io.cb(es, io); } };
  const RW = (new Function(SRC + "\n;return RW;"))();
  let cur = null;
  /** 칸 하나를 세운다 — 곁칸 뿌리(.pn-pane) · 이 칸의 세션(바꿀 수 있다) · 칸 탭 이름 기록. 앞의 칸은 닫는다. */
  const mount = (sess0) => {
    if (cur) { try { cur.part.destroy(); } catch (_) { /* 이미 */ } cur.paneRoot.remove(); }
    const paneRoot = document.createElement("div");
    paneRoot.className = "pn-pane";
    paneRoot.style.cssText = "position:fixed;left:0;top:0;width:800px;height:600px;display:flex;flex-direction:column;background:var(--bg)";
    document.body.append(paneRoot);
    const st = { sess: sess0, subs: new Set(), titles: [] };
    const ctx = {
      slotKey: () => (st.sess ?? "p7") + "#2",           // 세션 없는 자리(새 세션 자리)는 프로젝트 열쇠다
      curSession: () => st.sess,
      onSession: (fn) => { st.subs.add(fn); return () => st.subs.delete(fn); },
      setTabTitle: (t) => st.titles.push(t),
      paneRoot: () => paneRoot,
    };
    const part = RW.remoteWebPart(ctx, () => { const r = document.createElement("div"); r.className = "pn-part FRAME"; r.textContent = "FRAME"; return { root: r, destroy() {} }; });
    paneRoot.append(part.root);
    cur = { part, paneRoot, st, switchTo: (s) => { st.sess = s; for (const f of [...st.subs]) f(s); } };
    return cur;
  };
  const remoteRoot = () => $(".pn-web-remote", cur.paneRoot);
  const img = () => $(".pn-remote-img", cur.paneRoot);
  const sink = () => $(".pn-remote-sink", cur.paneRoot);
  const frameShown = () => !!$(".FRAME", cur.paneRoot);
  const live = () => remoteRoot()?.dataset.state === "live" && (img()?.naturalWidth || 0) > 0 && img().getBoundingClientRect().width > 0;
  const clickImg = (detail = 1) => { const i = img(); const r = i.getBoundingClientRect(); i.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, detail })); };
  const clickAt = (detail, fx, fy) => { const i = img(); const r = i.getBoundingClientRect(); i.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: r.left + r.width * (0.05 + 0.9 * fx), clientY: r.top + r.height * (0.05 + 0.9 * fy), detail })); };
  const ctxMenu = () => { const i = img(); const r = i.getBoundingClientRect(); i.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 60, clientY: r.top + 60 })); };
  const isBehind = () => remoteRoot()?.dataset.behind === "1";
  const typeText = (t) => { const s = sink(); s.focus(); s.value = t; s.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: t })); };
  const keyDown = (key, o = {}) => sink().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...o }));
  const wheel = (dy) => { const st = $(".pn-remote-stage", cur.paneRoot); const r = img().getBoundingClientRect(); st.dispatchEvent(new WheelEvent("wheel", { deltaY: dy, deltaMode: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true })); };
  const since = (t, pred = () => true) => F.calls.filter((c) => c.t0 >= t && pred(c));
  /** 화면 받기 말고 원격 일(act · navigate · eval)이 quietMs 동안 새로 안 나가고 다 끝났을 때까지. */
  const settle = async (quietMs = 1500, max = 30000) => {
    const t0 = performance.now();
    let last = performance.now(), n = -1;
    while (performance.now() - t0 < max) {
      const work = F.calls.filter((c) => c.op !== "screenshot" && c.op !== "status");
      if (work.length !== n || work.some((c) => c.t1 === null)) { n = work.length; last = performance.now(); }
      if (performance.now() - last >= quietMs) return true;
      await sleep(50);
    }
    return false;
  };
  const keysIn = (calls) => calls.reduce((n, c) => n + String(c.body.keys || "").split(" ").filter(Boolean).length, 0);

  // ── R1 · 글을 치고 곧바로 세션을 바꾼다 ──────────────────────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    const t = performance.now();
    typeText("secret-for-A");
    await sleep(40);
    cur.switchTo("sB");
    await settle();
    R.r1 = { ok, types: since(t, (c) => c.op === "act" && c.body.action === "type").map((c) => ({ s: c.sess, text: c.body.text })) };
  } catch (e) { R.errR1 = String(e && e.stack || e); }

  // ── R2 · 누르고(두 번 누름 대기 중) 곧바로 세션을 바꾼다 ────────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    const t = performance.now();
    clickImg(1);
    await sleep(100);
    cur.switchTo("sB");
    await settle();
    R.r2 = { ok, clicks: since(t, (c) => c.op === "act" && /click/.test(c.body.action)).map((c) => ({ s: c.sess, a: c.body.action })) };
  } catch (e) { R.errR2 = String(e && e.stack || e); }

  // ── R3 · R4 · A 화면을 받는 중에 세션을 바꾼다 ───────────────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    F.delay.screenshot = 1500;
    const flying = await waitFor(() => F.calls.some((c) => c.op === "screenshot" && c.sess === "sA" && c.t1 === null), 15000);
    const seen = [];
    const mo = new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === "attributes") seen.push(m.target.getAttribute("src") || "");
        else for (const n of m.addedNodes) if (n.querySelectorAll) for (const i of n.querySelectorAll("img")) seen.push(i.getAttribute("src") || "");
      }
    });
    mo.observe(cur.paneRoot, { attributes: true, attributeFilter: ["src"], subtree: true, childList: true });
    const titles0 = cur.st.titles.length;
    //  바꾸기 직전까지 나간 요청(날아가는 A 화면 포함) — 가상 시간에선 그 요청과 «지금» 이 같은 시각으로 찍혀 시각으로는 못 가른다.
    const before = new Set(F.calls);
    cur.switchTo("sB");
    await sleep(4000);                                  // A 의 늦은 응답(1.5초)이 오고 B 그림도 온 뒤
    mo.disconnect();
    F.delay.screenshot = 300;
    R.r3 = { ok, flying, seenA: seen.filter((s) => s === srcOf("sA")).length, seenB: seen.filter((s) => s === srcOf("sB")).length,
      nowB: img()?.getAttribute("src") === srcOf("sB"), titlesAfter: cur.st.titles.slice(titles0) };
    const after = F.calls.filter((c) => !before.has(c));
    R.r4 = { sess: [...new Set(after.map((c) => c.sess))], bShots: after.filter((c) => c.op === "screenshot" && c.sess === "sB").length };
  } catch (e) { R.errR3 = String(e && e.stack || e); }

  // ── R3b · 이동 응답이 늦게 오는 중에 세션을 바꾼다 ─────────────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    F.delay.navigate = 1500;
    cur.paneRoot.dispatchEvent(new CustomEvent("pn:open-web", { detail: { url: "https://example.com/late" } }));
    const flying = await waitFor(() => F.calls.some((c) => c.op === "navigate" && c.t1 === null), 3000);
    const titles0 = cur.st.titles.length;
    cur.switchTo("sB");
    await sleep(3000);                                  // A 의 늦은 이동 응답(1.5초)이 온 뒤
    F.delay.navigate = 300;
    R.r3b = { ok, flying, titlesAfter: cur.st.titles.slice(titles0), addr: $(".pn-web-in", cur.paneRoot)?.value || "" };
  } catch (e) { R.errR3b = String(e && e.stack || e); }

  // ── R12 · 느린 두 번 누름(0.3초 간격) ────────────────────────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    const t = performance.now();
    clickImg(1);
    await sleep(300);
    clickImg(2);
    await settle();
    R.r12 = { ok, acts: since(t, (c) => c.op === "act" && /click/.test(c.body.action)).map((c) => c.body.action) };
  } catch (e) { R.errR12 = String(e && e.stack || e); }

  // ── R12b · 누르고 곧바로 친 글 ─────────────────────────────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    const t = performance.now();
    clickImg(1);
    await sleep(100);
    typeText("x");
    await settle();
    R.r12b = { ok, order: since(t, (c) => c.op === "act").map((c) => c.body.action) };
  } catch (e) { R.errR12b = String(e && e.stack || e); }

  // ── R5 · 느린 원격에서 키를 꾹 누른다 ────────────────────────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    const t = performance.now();
    sink().focus();
    for (let i = 0; i < 40; i++) { keyDown("Backspace", { repeat: i > 0 }); await sleep(33); }
    const tUp = performance.now();
    await settle(1500, 60000);
    const acts = since(t, (c) => c.op === "act" && c.body.action === "key");
    R.r5 = { ok, acts: acts.length, keys: keysIn(acts), afterRelease: Math.round(Math.max(0, ...acts.map((c) => c.t1)) - tUp), sess: [...new Set(acts.map((c) => c.sess))] };
  } catch (e) { R.errR5 = String(e && e.stack || e); }

  // ── R5b · 아주 느린 원격에서 60번 — 밀린 반복을 끊는다 ──────────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    F.delay.act = 3000;
    const t = performance.now();
    sink().focus();
    for (let i = 0; i < 60; i++) { keyDown("Backspace", { repeat: i > 0 }); await sleep(33); }
    const settled = await settle(1500, 90000);      // 끊지 않으면 60번 × 3초 — 여기서 못 끝난다(그것도 실패다)
    F.delay.act = 600;
    const acts = since(t, (c) => c.op === "act" && c.body.action === "key");
    R.r5b = { ok, settled, keys: keysIn(acts), firstSent: acts.length > 0 && acts[0].t0 - t < 200 };
  } catch (e) { R.errR5b = String(e && e.stack || e); }

  // ── R6 · 느린 원격에서 단어를 이어 친다 ──────────────────────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    const t = performance.now();
    const words = ["hello ", "this ", "is ", "a ", "password ", "for ", "site ", "A"];
    for (const w of words) { typeText(w); await sleep(300); }
    await settle(1500, 30000);
    const types = since(t, (c) => c.op === "act" && c.body.action === "type");
    R.r6 = { ok, n: types.length, text: types.map((c) => c.body.text).join(""), want: words.join(""), sess: [...new Set(types.map((c) => c.sess))] };
  } catch (e) { R.errR6 = String(e && e.stack || e); }

  // ── R7 · R7b · 409 ─────────────────────────────────────────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    F.actStatus = 409; F.actError = "이 세션은 다른 사람의 세션입니다 — 시험 문구"; F.statusConnected = true;
    clickImg(1);
    const said = await waitFor(() => /다른 사람의 세션/.test($(".pn-remote-note", cur.paneRoot)?.textContent || ""), 6000);
    await sleep(1500);
    R.r7 = { ok, said, remote: !!remoteRoot(), frame: frameShown() };
    F.statusConnected = false;
    clickImg(1);
    R.r7b = { frame: await waitFor(frameShown, 6000) };
    F.actStatus = 200; F.actError = ""; F.statusConnected = null;
  } catch (e) { R.errR7 = String(e && e.stack || e); }

  // ── R8 · 밖에서 여는 주소(미리보기 행 · 터미널 링크) ───────────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    const t = performance.now();
    cur.paneRoot.dispatchEvent(new CustomEvent("pn:open-web", { detail: { url: "https://example.com/x" } }));
    await settle();
    R.r8 = { ok, navs: since(t, (c) => c.op === "navigate").map((c) => ({ s: c.sess, url: c.body.url, tab: c.body.tab })) };
  } catch (e) { R.errR8 = String(e && e.stack || e); }

  // ── R9 · ⌘R 은 마지막으로 만진 칸이 이 칸일 때만 ──────────────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    const t = performance.now();
    const reloads = () => since(t, (c) => c.op === "navigate" && c.body.action === "reload").length;
    $(".pn-web-bar", cur.paneRoot).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const evIn = new KeyboardEvent("keydown", { key: "r", code: "KeyR", metaKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(evIn);
    await settle();
    const inside = reloads();
    const outside = document.createElement("div");
    document.body.append(outside);
    outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const evOut = new KeyboardEvent("keydown", { key: "r", code: "KeyR", metaKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(evOut);
    await settle();
    outside.remove();
    R.r9 = { ok, inside, preventedIn: evIn.defaultPrevented, after: reloads(), preventedOut: evOut.defaultPrevented };
  } catch (e) { R.errR9 = String(e && e.stack || e); }

  // ── R10 · 숨은 iframe 칸은 연결을 묻지 않는다 ─────────────────────────────────
  try {
    F.connected = false;
    mount("sA");
    const fr = await waitFor(frameShown, 6000);
    cur.paneRoot.style.display = "none";
    const t = performance.now();
    await sleep(65000);
    const hiddenProbes = since(t, (c) => c.op === "status").length;
    F.connected = true;
    cur.paneRoot.style.display = "flex";
    const t2 = performance.now();
    const back = await waitFor(() => !!remoteRoot(), 35000);
    R.r10 = { fr, hiddenProbes, back, after: Math.round(performance.now() - t2) };
  } catch (e) { R.errR10 = String(e && e.stack || e); F.connected = true; }

  // ── R11 · 숨으면 멈추고 보이면 곧바로 ────────────────────────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    cur.paneRoot.style.display = "none";
    await sleep(3000);                                  // 숨기 직전에 떠난 받기가 끝날 시간
    const t = performance.now();
    await sleep(10000);
    const hiddenShots = since(t, (c) => c.op === "screenshot").length;
    const t2 = performance.now();
    cur.paneRoot.style.display = "flex";
    ioShow(cur.paneRoot);
    const resumed = await waitFor(() => since(t2, (c) => c.op === "screenshot").length > 0, 1500);
    R.r11 = { ok, hiddenShots, resumed, after: Math.round(performance.now() - t2) };
  } catch (e) { R.errR11 = String(e && e.stack || e); }

  // ── R13 · 트랙패드처럼 2초 굴린다(16ms 간격) ────────────────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    const t = performance.now();
    let n = 0;
    while (performance.now() - t < 2000) { wheel(10); n++; await sleep(16); }
    const tEnd = performance.now();
    await settle(1500, 30000);
    const sc = since(t, (c) => c.op === "act" && c.body.action === "scroll");
    const kNow = 400 / img().getBoundingClientRect().width;    // 그림 px / 보이는 px(찍기 배율 1)
    const imgsDuring = F.calls.filter((c) => c.t1 !== null && c.t1 >= t && c.t1 <= tEnd && (c.op === "screenshot" || (c.op === "act" && c.body.screenshot))).length;
    const withPoint = sc.length > 0 && sc.every((c) => Number.isFinite(c.body.x) && Number.isFinite(c.body.y) && c.body.x >= 0 && c.body.x < 400 && c.body.y >= 0 && c.body.y < 300);
    R.r13 = { ok, n, acts: sc.length, total: sc.reduce((a, c) => a + Number(c.body.amount || 0), 0), want: Math.round(n * 10 * kNow), afterEnd: Math.round(Math.max(0, ...sc.map((c) => c.t1)) - tEnd), imgsDuring, withPoint };
  } catch (e) { R.errR13 = String(e && e.stack || e); }

  // ── R13b · 1초 굴리고 0.1초 뒤 누른다 — 화면이 따라오는 중이면 안 보낸다 ──────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    const t = performance.now();
    while (performance.now() - t < 1000) { wheel(10); await sleep(16); }
    await sleep(100);
    const behindAt = isBehind();
    clickImg(1);
    const said = /따라오는 중/.test($(".pn-remote-note", cur.paneRoot)?.textContent || "");
    await sleep(600);
    const stillSaid = isBehind() && /따라오는 중/.test($(".pn-remote-note", cur.paneRoot)?.textContent || "");   // 다음 응답이 기본 안내로 덮지 않았다
    const caught = await waitFor(() => !isBehind(), 5000);
    const caughtAfter = Math.round(performance.now() - t - 1100);
    //  «안 보냈다» 는 줄이 다 빈 뒤에 센다 — 보내는 판이라면 그 누르기는 굴리기 뒤에 줄을 서 늦게 나간다(일찍 세면 못 본다).
    await settle(1500, 30000);
    const refused = since(t, (c) => c.op === "act" && /click/.test(c.body.action)).length === 0;
    clickImg(1);
    await settle(1500, 30000);
    const acts = since(t, (c) => c.op === "act");
    const ci = acts.findIndex((c) => c.body.action === "click");
    R.r13b = { ok, behindAt, said, stillSaid, caught, caughtAfter, refused, clickAfter: ci >= 0, scrollsAfterClick: ci >= 0 ? acts.slice(ci + 1).filter((c) => c.body.action === "scroll").length : null };
  } catch (e) { R.errR13b = String(e && e.stack || e); }

  // ── R13c · R13d · 아주 느린 원격(동작 2초)에서 0.3초 굴린다 — 누르거나(c) 그냥 둔다(d) ─────────────
  for (const press of [true, false]) {
    try {
      mount("sA");
      const ok = await waitFor(live, 10000);
      F.delay.act = 2000;
      const t = performance.now();
      let n = 0;
      while (performance.now() - t < 300) { wheel(10); n++; await sleep(16); }
      await sleep(100);
      let refused = null;
      if (press) {
        clickImg(1);                                   // 따라오는 중 — 안 간다
        await waitFor(() => !isBehind(), 20000);
        await settle(2500, 30000);                     // 보내는 판이라면 굴리기 뒤에 줄을 서 늦게 나간다 — 줄이 빈 뒤에 센다
        refused = since(t, (c) => c.op === "act" && /click/.test(c.body.action)).length === 0;
        clickImg(1);                                   // 다 따라온 뒤 — 간다
      }
      await settle(2500, 30000);
      F.delay.act = 600;
      const acts = since(t, (c) => c.op === "act");
      const ci = acts.findIndex((c) => c.body.action === "click");
      const kNow = 400 / img().getBoundingClientRect().width;
      R[press ? "r13c" : "r13d"] = { ok, n, refused, total: acts.filter((c) => c.body.action === "scroll").reduce((a, c) => a + Number(c.body.amount || 0), 0), want: Math.round(n * 10 * kNow),
        order: acts.map((c) => c.body.action), scrollsAfterClick: ci >= 0 ? acts.slice(ci + 1).filter((c) => c.body.action === "scroll").length : null };
    } catch (e) { R[press ? "errR13c" : "errR13d"] = String(e && e.stack || e); F.delay.act = 600; }
  }

  // ── R13e · 짧게 한 번 굴리고(휠 3번) 0.3초 뒤 누른다 — 굴리기는 이미 나갔지만 그 결과 그림이 아직 안 왔다 ──────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    const t = performance.now();
    for (let i = 0; i < 3; i++) { wheel(20); await sleep(16); }
    await sleep(300);                                  // 0.12초 뒤 굴리기가 나가 0.6초 걸린다 — 지금은 나갔고 그림은 아직
    const sentNoImg = since(t, (c) => c.op === "act" && c.body.action === "scroll").length === 1 && !F.calls.some((c) => c.t0 >= t && c.op === "act" && c.body.action === "scroll" && c.t1 !== null);
    const behindAt = isBehind();
    clickImg(1);
    await settle(1500, 15000);
    R.r13e = { ok, sentNoImg, behindAt, refused: since(t, (c) => c.op === "act" && /click/.test(c.body.action)).length === 0 };
  } catch (e) { R.errR13e = String(e && e.stack || e); }

  // ── R27 · R27b · 거절 뒤 다시 누르기 — 브라우저가 센 누른 수(detail)에 끌려가지 않는다 ──────────────
  //  동작을 빠르게(0.1초) 해 두 번째 누름 때는 따라온 뒤다. d1 은 거절, 그 뒤 d2(브라우저는 «두 번 누름» 으로 센다) · d3 … 이 온다.
  for (const burst of [false, true]) {
    try {
      mount("sA");
      const ok = await waitFor(live, 10000);
      F.delay.act = 100;
      const t = performance.now();
      for (let i = 0; i < 3; i++) { wheel(20); await sleep(16); }
      await sleep(90);                                 // 굴리기가 나가(0.12초) 그림이 아직 — 따라오는 중
      const behindAt = isBehind();
      clickAt(1, 0.5, 0.5);                            // 거절
      const caught = await waitFor(() => !isBehind(), 3000);
      const details = burst ? [2, 3, 4, 5] : [2];
      for (const d of details) { clickAt(d, 0.5, 0.5); await sleep(150); }
      await settle(1500, 15000);
      F.delay.act = 600;
      R[burst ? "r27b" : "r27"] = { ok, behindAt, caught, acts: since(t, (c) => c.op === "act" && /click/.test(c.body.action)).map((c) => c.body.action) };
    } catch (e) { R[burst ? "errR27b" : "errR27"] = String(e && e.stack || e); F.delay.act = 600; }
  }

  // ── R13f · 굴리기가 실패해 그림이 아직일 때 누르면 — «멈춘 뒤» 가 아니라 «화면이 아직 안 와서» 라고 말한다 ───────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    F.actStatus = 500; F.actError = "굴리기 실패 — 시험";
    for (let i = 0; i < 3; i++) { wheel(20); await sleep(16); }
    const failed = await waitFor(() => remoteRoot().dataset.state === "error", 3000);
    const behindAt = isBehind();
    clickImg(1);
    const text = $(".pn-remote-note", cur.paneRoot)?.textContent || "";
    F.actStatus = 200; F.actError = "";
    await settle(1500, 15000);
    R.r13f = { ok, failed, behindAt, honest: /화면이 아직 오지 않아/.test(text), notCatching: !/따라오는 중/.test(text) };
  } catch (e) { R.errR13f = String(e && e.stack || e); F.actStatus = 200; F.actError = ""; }

  // ── R13h · 한 번 거절한 뒤 한참(3.5초) 지나 다시 굴리면 — 누르지 않았으니 거절 알림은 다시 안 뜬다 ─────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    for (let i = 0; i < 3; i++) { wheel(20); await sleep(16); }
    await sleep(200);
    const behind1 = isBehind();
    clickImg(1);                                       // 거절
    await waitFor(() => !isBehind(), 5000);
    await sleep(3500);
    //  느린 화면 받기(0.8초)가 날아가는 중에, 느린 원격(동작 2초)에서 다시 굴린다 — 그 화면은 굴리기 전에 찍은 것이라
    //   따라오는 중인 채로 상태가 «live» 로 갱신된다. 그 순간 아래 줄이 옛 거절 알림을 다시 꺼내면 안 된다.
    F.delay.act = 2000; F.shotDelayScript = [800];
    const tS = performance.now();
    const slowOf = () => F.calls.find((c) => c.t0 >= tS && c.op === "screenshot" && c.ms === 800);
    await waitFor(() => !!slowOf() && slowOf().t1 === null, 6000);
    for (let i = 0; i < 3; i++) { wheel(20); await sleep(16); }
    await waitFor(() => slowOf().t1 !== null, 3000);
    await sleep(30);
    const behind2 = isBehind();
    const text = $(".pn-remote-note", cur.paneRoot)?.textContent || "";
    await settle(1500, 15000);
    F.delay.act = 600; F.shotDelayScript = [];
    R.r13h = { ok, behind1, behind2, quiet: !/따라오는 중|오지 않아/.test(text), text: text.slice(0, 40) };
  } catch (e) { R.errR13h = String(e && e.stack || e); }

  // ── R13g · PageDown 으로 굴리고 곧바로 누르면 — 그것도 따라오는 중이다 ─────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    const t = performance.now();
    keyDown("PageDown");
    await sleep(120);                                  // 키가 나가(0.06초) 0.6초 걸린다 — 그림은 아직
    const behindAt = isBehind();
    clickImg(1);
    await settle(1500, 15000);
    R.r13g = { ok, sent: since(t, (c) => c.op === "act" && c.body.action === "key" && /PageDown/.test(c.body.keys)).length === 1, behindAt, refused: since(t, (c) => c.op === "act" && /click/.test(c.body.action)).length === 0 };
  } catch (e) { R.errR13g = String(e && e.stack || e); }

  // ── R7c · 데스크톱이 잠깐(한 번) «없음» 이었다가 돌아온다 ──────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    F.actStatus = 409; F.actError = "데스크톱 앱이 연결돼 있지 않습니다"; F.statusScript = [false, true];
    clickImg(1);
    await sleep(6000);
    R.r7c = { ok, remote: !!remoteRoot(), frame: frameShown(), statusAsked: 2 - F.statusScript.length };
    F.actStatus = 200; F.actError = ""; F.statusScript = [];
  } catch (e) { R.errR7c = String(e && e.stack || e); }

  // ── R14 · iframe 칸에서 세션을 바꾸면 곧바로 묻는다 ─────────────────────────────
  try {
    F.connected = false;
    mount("sA");
    const fr = await waitFor(frameShown, 6000);
    F.connected = true;
    const t = performance.now();
    cur.switchTo("sB");
    const back = await waitFor(() => !!remoteRoot(), 3000);
    R.r14 = { fr, back, after: Math.round(performance.now() - t) };
  } catch (e) { R.errR14 = String(e && e.stack || e); F.connected = true; }

  // ── R14b · 원격 화면에서 세션을 바꾸면 상태를 다시 묻지 않고 곧바로 ─────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    F.delay.status = 3000;
    const t = performance.now();
    cur.switchTo("sB");
    const shotB = await waitFor(() => since(t, (c) => c.op === "screenshot" && c.sess === "sB").length > 0, 1000);
    const statusAsked = since(t, (c) => c.op === "status").length;
    F.delay.status = 20;
    R.r14b = { ok, shotB, statusAsked };
  } catch (e) { R.errR14b = String(e && e.stack || e); F.delay.status = 20; }

  // ── R15 · 묻는 사이 세션 없는 자리로 간다 ─────────────────────────────────────
  try {
    F.connected = false;
    mount("sA");
    const fr = await waitFor(frameShown, 6000);
    F.connected = true; F.delay.status = 1000;
    const t = performance.now();
    cur.switchTo("sB");
    await sleep(200);
    cur.switchTo(null);
    await sleep(3000);
    F.delay.status = 20;
    R.r15 = { fr, remote: !!remoteRoot(), frame: frameShown(), shots: since(t, (c) => c.op === "screenshot").map((c) => c.sess) };
  } catch (e) { R.errR15 = String(e && e.stack || e); F.connected = true; F.delay.status = 20; }

  // ── R15b · 원격 화면에서 B 로 가는 중(묻기 1초) 세션 없는 자리로 간다(격리 리뷰가 잰 경로) ───────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    F.delay.status = 1000;
    const t = performance.now();
    cur.switchTo("sB");
    await sleep(200);
    cur.switchTo(null);
    await sleep(3000);
    F.delay.status = 20;
    R.r15b = { ok, remote: !!remoteRoot(), frame: frameShown(), shots: since(t + 300, (c) => c.op === "screenshot").map((c) => c.sess) };
  } catch (e) { R.errR15b = String(e && e.stack || e); F.delay.status = 20; }

  // ── R16 · A → B → A 로 곧바로 돌아온다(옛 A 가 남은 글을 보내는 중) ─────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    F.delay.act = 2500;
    const t = performance.now();
    clickImg(1);
    await sleep(450);                                  // 누르기가 나가 2.5초 동안 날아가는 중
    typeText("hello ");
    await sleep(50);
    cur.switchTo("sB");
    await sleep(50);
    cur.switchTo("sA");
    await sleep(50);
    typeText("world");
    await settle(2000, 60000);
    F.delay.act = 600;
    R.r16 = { ok, types: since(t, (c) => c.op === "act" && c.body.action === "type" && c.sess === "sA").sort((a, b) => a.t0 - b.t0).map((c) => c.body.text) };
  } catch (e) { R.errR16 = String(e && e.stack || e); F.delay.act = 600; }

  // ── R17 · 클립보드 API 가 없는 자리(https 아님)에서 ⌘C ─────────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const t = performance.now();
    const errs0 = pageErrors.length;
    keyDown("c", { metaKey: true, ctrlKey: true });
    await sleep(300);
    const toastText = document.getElementById("toasts").textContent || "";
    await settle(800, 5000);
    delete navigator.clipboard;
    R.r17 = { ok, toast: /https 아님/.test(toastText), evals: since(t, (c) => c.op === "eval").length, errs: pageErrors.slice(errs0) };
  } catch (e) { R.errR17 = String(e && e.stack || e); try { delete navigator.clipboard; } catch (_) { /* 이미 */ } }

  // ── R18 · 늦게 온 옛 «없음» 답이 방금 선 원격 화면을 되돌리지 않는다 ─────────────────
  try {
    F.statusScript = [false, true]; F.statusDelayScript = [1500, 20];   // 처음 묻기(늦은 «없음») · 다음 묻기(빠른 «있음»)
    mount("sA");
    await sleep(100);
    cur.switchTo("sB");
    await sleep(100);
    cur.switchTo("sA");
    const early = !!remoteRoot();
    await sleep(3000);                                  // 첫 묻기의 늦은 «없음»(1.5초)이 온 뒤
    R.r18 = { early, remote: !!remoteRoot(), frame: frameShown(), sess: remoteRoot() ? [...new Set(F.calls.filter((c) => c.op === "screenshot").slice(-2).map((c) => c.sess))] : null };
    F.statusScript = []; F.statusDelayScript = [];
  } catch (e) { R.errR18 = String(e && e.stack || e); F.statusScript = []; F.statusDelayScript = []; }

  // ── R19 · 데스크톱이 동작 하나에 끝내 답하지 않는다 ───────────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    F.hangNext = 1;
    const t = performance.now();
    clickImg(1);
    await sleep(500);
    typeText("x");
    await sleep(8000);
    const shotsWhileHung = since(t + 1500, (c) => c.op === "screenshot").length;
    await sleep(60000);
    await settle(1500, 10000);
    const ty = since(t, (c) => c.op === "act" && c.body.action === "type");
    R.r19 = { ok, shotsWhileHung, typeSent: ty.length === 1 && ty[0].body.text === "x", typeAfter: ty.length ? Math.round(ty[0].t0 - t) : null };
  } catch (e) { R.errR19 = String(e && e.stack || e); F.hangNext = 0; }

  // ── R21 · 섞어 친다(시드 고정 6번 × 40) — 데스크톱이 받은 차례 = 사람이 한 차례(인접한 같은 종류는 합쳐 본다) ─────
  //  격리 리뷰의 무작위 순서 점검을 옮겼다 — «휠 · 누르기 · 글 중 하나만 모인다» 를 부르는 자리마다 지키던 판에선 한 자리만
  //   빠뜨려도 이 비교가 8시드 중 5~8개에서 어긋났다. 누르기는 화면이 따라온 뒤에 누른다(따라오는 중엔 안 가는 것이 사양 — R13b).
  try {
    const mulberry = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const WORDS = ["a", "bc", "def", "hello ", "x y", "한글", "zz"];
    const KEYS = ["Backspace", "Enter", "Tab", "ArrowDown", "Escape"];
    const GAPS = [0, 0, 5, 20, 60, 130, 300, 450, 700];
    const out = [];
    for (let seed = 1; seed <= 6; seed++) {
      const rnd = mulberry(seed * 7919);
      const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
      mount("sA");
      const ok = await waitFor(live, 10000);
      F.delay.act = () => 150 + Math.floor(rnd() * 1300);
      const t = performance.now();
      const user = [];
      const caught = () => waitFor(() => !isBehind(), 15000);
      for (let i = 0; i < 40; i++) {
        const r = rnd();
        if (r < 0.28) { const w = pick(WORDS); typeText(w); user.push({ t: "text", s: w }); }
        else if (r < 0.42) { const k = pick(KEYS); keyDown(k); user.push({ t: "key", ks: [k] }); }
        else if (r < 0.55) { await caught(); clickAt(1, rnd(), rnd()); user.push({ t: "click", n: "click" }); }
        else if (r < 0.62) { await caught(); clickAt(1, 0.3, 0.3); await sleep(pick([20, 100, 250])); clickAt(2, 0.3, 0.3); user.push({ t: "click", n: "double_click" }); }
        else if (r < 0.80) {
          const sign = rnd() < 0.5 ? 1 : -1; const cnt = 1 + Math.floor(rnd() * 8); let sum = 0;
          for (let j = 0; j < cnt; j++) { const d = sign * (10 + Math.floor(rnd() * 30)); wheel(d); sum += d; await sleep(pick([0, 5, 16, 16, 40])); }
          user.push({ t: "scroll", v: sum });
        }
        else if (r < 0.85) { await caught(); ctxMenu(); user.push({ t: "click", n: "right_click" }); }
        else if (r < 0.90) { const a = $(".pn-web-in", cur.paneRoot); a.value = "example.com/p" + i; a.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); user.push({ t: "nav" }); }
        else if (r < 0.94) { keyDown("r", { metaKey: true, ctrlKey: true }); user.push({ t: "nav" }); }
        else { keyDown("c", { metaKey: true, ctrlKey: true }); user.push({ t: "eval" }); }
        await sleep(pick(GAPS));
      }
      const settled = await settle(3000, 180000);
      F.delay.act = 600;
      const host = [];
      for (const c of F.calls) {
        if (c.t0 < t) continue;
        if (c.op === "act") {
          const a = c.body.action;
          if (a === "type") host.push({ t: "text", s: c.body.text });
          else if (a === "key") host.push({ t: "key", ks: String(c.body.keys).split(" ") });
          else if (a === "scroll") host.push({ t: "scroll", v: (c.body.direction === "down" ? 1 : -1) * Number(c.body.amount) });
          else if (/click/.test(a)) host.push({ t: "click", n: a });
        } else if (c.op === "navigate") host.push({ t: "nav" });
        else if (c.op === "eval") host.push({ t: "eval" });
      }
      const k = 400 / img().getBoundingClientRect().width;
      const collapse = (xs, kk) => {
        const o = [];
        for (const e of xs) {
          const l = o[o.length - 1];
          if (l && l.t === "text" && e.t === "text") l.s += e.s;
          else if (l && l.t === "key" && e.t === "key") l.ks = l.ks.concat(e.ks);
          else if (l && l.t === "scroll" && e.t === "scroll") l.v += e.v * kk;
          else o.push({ ...e, v: e.t === "scroll" ? e.v * kk : undefined, ks: e.ks ? e.ks.slice() : undefined });
        }
        return o.filter((e) => !(e.t === "scroll" && Math.abs(e.v) < 1));
      };
      const A = collapse(user, k), B = collapse(host, 1);
      const norm = (xs) => xs.map((e) => e.t === "text" ? "T:" + e.s : e.t === "key" ? "K:" + e.ks.join(",") : e.t === "scroll" ? "S" + (e.v >= 0 ? "+" : "-") : e.t === "click" ? "C:" + e.n : e.t === "nav" ? "N" : "E");
      const na = norm(A), nb = norm(B);
      const same = JSON.stringify(na) === JSON.stringify(nb);
      const scrollOk = same && A.every((e, i) => e.t !== "scroll" || Math.abs(e.v - B[i].v) <= 2);
      out.push({ seed, ok, settled, n: user.length, same, scrollOk, ...(same ? {} : { a: na.slice(0, 30), b: nb.slice(0, 30) }) });
    }
    R.r21 = out;
  } catch (e) { R.errR21 = String(e && e.stack || e); F.delay.act = 600; }

  // ── R22 · 늦게 온 옛 그림이 새 그림을 덮지 않는다 ─────────────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    F.versioned = true; F.ver.sA = 0;
    const t22 = performance.now();
    F.shotDelayScript = [1500];                        // 다음 화면 받기 하나만 1.5초(옛 판을 찍은 채 늦게 온다)
    const slowOf = () => F.calls.find((c) => c.t0 >= t22 && c.op === "screenshot" && c.ms === 1500);   // 이 장면의 것만(앞 장면에도 1.5초 받기가 있었다)
    const slow = await waitFor(() => !!slowOf() && slowOf().t1 === null, 15000);
    const slowRec = slowOf();
    clickImg(1);                                       // 0.4초 뒤 누르기(0.6초) — 그 결과 그림(새 판)이 느린 화면(옛 판)보다 먼저 온다
    await waitFor(() => slowRec && slowRec.t1 !== null, 5000);
    await sleep(30);                                   // 늦은 응답이 그려질 틈
    const src = img().getAttribute("src");
    R.r22 = { ok, slow, newest: src === srcOf("sA@1"), stale: src === srcOf("sA@0"), shown: keyOfSrc(src),
      calls: F.calls.filter((c) => c.t0 >= slowRec.t0 - 1).slice(0, 8).map((c) => `${c.op}${c.body.screenshot ? "+shot" : ""}:${c.ms}:${Math.round(c.t0 - slowRec.t0)}-${c.t1 === null ? "…" : Math.round(c.t1 - slowRec.t0)}`) };
    F.versioned = false; F.shotDelayScript = [];
  } catch (e) { R.errR22 = String(e && e.stack || e); F.versioned = false; F.shotDelayScript = []; }

  // ── R23 · 느린 이동(4초) 중에도 주소줄이 옛 주소로 돌아가지 않는다 ─────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    F.trackUrl = true; F.urlOf.sA = ""; F.delay.navigate = 4000;
    const a = $(".pn-web-in", cur.paneRoot);
    a.focus(); a.value = "new.example/page";
    a.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const vals = [], titles0 = cur.st.titles.length;
    for (let i = 0; i < 35; i++) { await sleep(100); vals.push(a.value); }
    await settle(1500, 15000);
    F.delay.navigate = 300;
    const polled = F.calls.some((c) => c.op === "screenshot" && c.t1 !== null && c.t1 < performance.now() - 1000);
    R.r23 = { ok, polled, reverted: vals.some((v) => /site-sa/i.test(v)), titleReverted: cur.st.titles.slice(titles0).some((x) => /site-sa/i.test(x)), last: a.value };
    F.trackUrl = false;
  } catch (e) { R.errR23 = String(e && e.stack || e); F.trackUrl = false; F.delay.navigate = 300; }

  // ── R24 · 창에 초점이 돌아오면 곧바로 받는다 ────────────────────────────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    await sleep(12000);                                // 입력 없이 10초 넘게 — 화면 받기가 2초(초점 없으면 5초) 간격
    const n0 = F.calls.length;
    await waitFor(() => F.calls.slice(n0).some((c) => c.op === "screenshot" && c.t1 !== null), 8000);   // 방금 하나 받았다 — 다음은 2초 넘게 뒤
    await sleep(20);
    const t = performance.now();
    window.dispatchEvent(new Event("focus"));
    const quick = await waitFor(() => since(t, (c) => c.op === "screenshot").length > 0, 300);
    R.r24 = { ok, quick };
  } catch (e) { R.errR24 = String(e && e.stack || e); }

  // ── R26 · 409 뒤 상태 묻기가 끝내 안 온다 — 15초 상한으로 끊고 iframe 칸으로 ──────────
  try {
    mount("sA");
    const ok = await waitFor(live, 10000);
    F.actStatus = 409; F.actError = "데스크톱 앱이 연결돼 있지 않습니다"; F.statusHang = true;
    const t = performance.now();
    clickImg(1);
    const fr = await waitFor(frameShown, 45000);
    R.r26 = { ok, fr, after: Math.round(performance.now() - t) };
    F.actStatus = 200; F.actError = ""; F.statusHang = false;
  } catch (e) { R.errR26 = String(e && e.stack || e); F.actStatus = 200; F.actError = ""; F.statusHang = false; }

  try { cur.part.destroy(); } catch (_) { /* 이미 */ }
  R.pageErrors = pageErrors;
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const PAGE = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out" style="position:fixed;left:-9999px">PENDING</pre>
<script type="text/plain" id="pfsrc">${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;
const dom = await dumpDom(chrome, { html: PAGE, copy: CSS, prefix: "remote-web-", virtualTimeBudget: 3000000, timeoutMs: 240000, args: ["--window-size=1000,800"] });
const res = readOut(dom);
if (res.text === null) { console.error(`FAIL  페이지가 결과를 안 냈다(out=${JSON.stringify(res.out)})\n` + dom.slice(0, 1500)); process.exit(1); }
const R = JSON.parse(res.text);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const J = (v) => JSON.stringify(v);
const check = (cond, n, got) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} — 실제 ${J(got)}`); } };
for (const k of Object.keys(R)) if (k.startsWith("err") || k === "fatal") { fail++; console.error(`FAIL  장면이 던졌다(${k}) — ${String(R[k]).split("\n")[0]}`); }
const r3b = R.r3b || {}, r12 = R.r12 || {}, r12b = R.r12b || {};
const r1 = R.r1 || {}, r2 = R.r2 || {}, r3 = R.r3 || {}, r4 = R.r4 || {}, r5 = R.r5 || {}, r5b = R.r5b || {}, r6 = R.r6 || {}, r7 = R.r7 || {}, r7b = R.r7b || {}, r8 = R.r8 || {}, r9 = R.r9 || {}, r10 = R.r10 || {}, r11 = R.r11 || {};

//  배선 — 장면마다 원격 화면이 실제로 떴는가(아니면 아래 단언은 아무것도 안 본 채 초록일 수 있다)
check([r1, r2, r3, r3b, r5, r5b, r6, r7, r8, r9, r11, r12, r12b].every((x) => x.ok === true) && r3.flying === true && r3b.flying === true && r10.fr === true,
  "(배선) 장면마다 원격 화면이 떴다 · R3 · R3b 는 A 응답이 날아가는 중에 바꿨다 · R10 은 iframe 칸에서 시작했다",
  { r1: r1.ok, r2: r2.ok, r3: [r3.ok, r3.flying], r3b: [r3b.ok, r3b.flying], r5: r5.ok, r5b: r5b.ok, r6: r6.ok, r7: r7.ok, r8: r8.ok, r9: r9.ok, r10: r10.fr, r11: r11.ok, r12: r12.ok, r12b: r12b.ok });
check(J(r1.types) === J([{ s: "sA", text: "secret-for-A" }]), "R1 글을 치고 40ms 안에 세션을 바꿔도 그 글은 A 로 — B 로 가는 type 0건", r1.types);
check(J(r2.clicks) === J([{ s: "sA", a: "click" }]), "R2 누르고 100ms 안에 바꿔도 그 누르기는 A 로 — B 로 가는 click 0건", r2.clicks);
check(r3.seenA === 0 && r3.seenB >= 1 && r3.nowB === true && Array.isArray(r3.titlesAfter) && !r3.titlesAfter.some((x) => /site-sa/i.test(x)),   // 주소의 호스트는 소문자로 온다(site-sa.test)
  "R3 늦게 온 A 그림은 칸에 안 그려지고 칸 탭 이름도 A 것으로 안 바뀐다 · 칸엔 B 그림", r3);
check(Array.isArray(r3b.titlesAfter) && !r3b.titlesAfter.some((x) => /site-sa/i.test(x)) && !/site-sa/i.test(r3b.addr || ""), "R3b 늦게 온 A 의 이동 응답은 칸 탭 이름 · 주소줄을 A 것으로 안 바꾼다", r3b);
check(J(r4.sess) === J(["sB"]) && r4.bShots >= 1, "R4 바꾼 뒤 나가는 요청은 전부 B", r4);
check(r5.acts >= 1 && r5.acts <= 8 && r5.keys === 40 && r5.afterRelease <= 5000 && J(r5.sess) === J(["sA"]), "R5 느린 원격에서 꾹 누른 40번 — act 8번 이하 · 키 40개 다 · 놓은 뒤 5초 안에 끝", r5);
check(r5b.settled === true && r5b.keys >= 30 && r5b.keys <= 40 && r5b.firstSent === true, "R5b (경계) 아주 느리면 밀린 반복은 30개에서 끊는다 · 처음 누른 키는 곧바로 간다", r5b);
check(r6.n >= 1 && r6.n < 8 && r6.text === r6.want && J(r6.sess) === J(["sA"]), "R6 느린 원격에서 이어 친 단어는 모아 보낸다(8번보다 적게) · 순서대로 다", r6);
check(r7.said === true && r7.remote === true && r7.frame === false, "R7 409 인데 다시 물으니 연결돼 있으면 원격 화면 그대로 · 서버 문구를 보인다", r7);
check(r7b.frame === true, "R7b 409 이고 다시 물어도 끊겼으면 iframe 칸으로", r7b);
check(J(r8.navs) === J([{ s: "sA", url: "https://example.com/x", tab: "2" }]), "R8 pn:open-web 은 그 주소로 navigate(이 칸의 세션 · 탭 번호)", r8.navs);
check(r9.inside === 1 && r9.preventedIn === true && r9.after === 1 && r9.preventedOut === false, "R9 칸 안을 만진 뒤 ⌘R 은 원격 새로고침 · 칸 밖을 만진 뒤 ⌘R 은 손대지 않는다", r9);
check(r10.hiddenProbes === 0 && r10.back === true, "R10 숨은 iframe 칸은 연결을 안 묻고, 다시 보이면 30초 안에 원격 화면", r10);
check(r11.hiddenShots === 0 && r11.resumed === true, "R11 숨으면 화면 받기를 멈추고 다시 보이면 1.5초 안에 받는다", r11);
check(J(r12.acts) === J(["double_click"]), "R12 느린 두 번 누름(0.3초)은 double_click 하나 — 앞의 click 이 먼저 안 나간다", r12.acts);
check(J(r12b.order) === J(["click", "type"]), "R12b 누르고 곧바로 친 글은 누르기 뒤에 간다", r12b.order);
const r7c = R.r7c || {}, r13 = R.r13 || {}, r13b = R.r13b || {}, r14 = R.r14 || {}, r14b = R.r14b || {}, r15 = R.r15 || {}, r16 = R.r16 || {}, r17 = R.r17 || {}, r19 = R.r19 || {};
check([r7c, r13, r13b, r14b, r16, r17, r19].every((x) => x.ok === true) && r14.fr === true && r15.fr === true, "(배선) 2판 장면들도 원격 화면(또는 iframe 칸)에서 시작했다",
  { r7c: r7c.ok, r13: r13.ok, r13b: r13b.ok, r14: r14.fr, r14b: r14b.ok, r15: r15.fr, r16: r16.ok, r17: r17.ok, r19: r19.ok });
check(r7c.remote === true && r7c.frame === false && r7c.statusAsked === 2, "R7c 한 번 «없음» 이었다가 돌아오면 iframe 칸으로 안 바뀐다(두 번 물었다)", r7c);
check(r13.n > 100 && r13.acts >= 1 && r13.acts <= 6 && r13.total === r13.want && r13.afterEnd <= 2000 && r13.imgsDuring >= 2 && r13.withPoint === true, "R13 트랙패드 2초 — scroll act 6번 이하 · 굴린 만큼 다 · 끝난 뒤 2초 안 · 굴리는 동안에도 그림 · 굴린 자리(x, y)를 싣는다", r13);
check(r13b.behindAt === true && r13b.said === true && r13b.stillSaid === true && r13b.refused === true && r13b.caught === true && r13b.caughtAfter <= 2500 && r13b.clickAfter === true && r13b.scrollsAfterClick === 0,
  "R13b 굴리고 곧바로 누르면(화면이 따라오는 중) 안 보내고 알린다(0.6초 뒤에도 알림이 남는다) · 2.5초 안에 따라오고 · 그 뒤 누르면 간다(굴리기 뒤에)", r13b);
const r13c = R.r13c || {}, r13d = R.r13d || {};
check(r13c.ok === true && r13c.refused === true && r13c.total === r13c.want && r13c.scrollsAfterClick === 0 && (r13c.order || []).at(-1) === "click", "R13c 아주 느린 원격 — 따라오는 동안 누르기는 안 가고, 다 따라온 뒤 누르면 굴리기 다음에 간다 · 굴린 만큼 다", r13c);
check(r13d.ok === true && r13d.n > 10 && r13d.total === r13d.want, "R13d 굴리기가 끝날 때 원격이 바빠도 줄이 비면 남은 휠이 간다", r13d);
const r13e = R.r13e || {};
check(r13e.ok === true && r13e.sentNoImg === true && r13e.behindAt === true && r13e.refused === true, "R13e 굴리기는 나갔고 그 그림이 아직이면 누르기를 안 보낸다", r13e);
const r13f = R.r13f || {}, r13g = R.r13g || {}, r27 = R.r27 || {}, r27b = R.r27b || {};
check(r13f.ok === true && r13f.failed === true && r13f.behindAt === true && r13f.honest === true && r13f.notCatching === true, "R13f 그림이 안 오는 중의 거절은 그 사정대로 말한다", r13f);
const r13h = R.r13h || {};
check(r13h.ok === true && r13h.behind1 === true && r13h.behind2 === true && r13h.quiet === true, "R13h 한참 전에 거절했어도 누르지 않은 굴리기엔 거절 알림이 안 뜬다", r13h);
check(r13g.ok === true && r13g.sent === true && r13g.behindAt === true && r13g.refused === true, "R13g PageDown 으로 굴리고 곧바로 누르면 안 보낸다", r13g);
check(r27.ok === true && r27.behindAt === true && r27.caught === true && J(r27.acts) === J(["click"]), "R27 거절 뒤 다시 누르면(detail=2) 한 번 누름 하나만", r27);
check(r27b.ok === true && r27b.behindAt === true && r27b.caught === true && J(r27b.acts) === J(["click", "click", "click", "click"]), "R27b 거절 뒤 연달아 누르면 따라온 뒤 누른 넷이 다 간다(«세 번째» 로 버리지 않는다) · 두 번 누름은 없다", r27b);
check(r14.back === true && r14.after <= 3000, "R14 iframe 칸에서 세션을 바꾸면 곧바로 물어 3초 안에 원격 화면", r14);
check(r14b.shotB === true && r14b.statusAsked === 0, "R14b 원격 화면에서 세션을 바꾸면 상태를 다시 묻지 않고 1초 안에 새 세션 화면", r14b);
check(r15.remote === false && r15.frame === true && J(r15.shots) === "[]", "R15 묻는 사이 세션 없는 자리로 가면 원격 화면이 서지 않는다 · 화면도 안 받는다", r15);
const r15b = R.r15b || {};
check(r15b.ok === true && r15b.remote === false && r15b.frame === true && J(r15b.shots) === "[]", "R15b 원격 화면에서 B 로 가는 중 세션 없는 자리로 가도 원격 화면이 서지 않는다", r15b);
check(J(r16.types) === J(["hello ", "world"]), "R16 A → B → A 로 돌아와 이어 친 글은 친 순서대로", r16.types);
check(r17.toast === true && r17.evals === 0 && J(r17.errs) === "[]", "R17 클립보드 API 가 없는 자리의 ⌘C — 알림 · 원격 글 안 읽음 · 페이지 오류 0", r17);
const r18 = R.r18 || {};
check(r18.early === true && r18.remote === true && r18.frame === false && J(r18.sess) === J(["sA"]), "R18 늦게 온 옛 «없음» 답은 방금 선 원격 화면을 되돌리지 않는다", r18);
check(r19.shotsWhileHung >= 2 && r19.typeSent === true && r19.typeAfter >= 59000 && r19.typeAfter <= 66000, "R19 답 없는 동작 — 그동안에도 화면을 받고, 60초 뒤 끊고 뒤의 글을 보낸다", r19);
const r21 = R.r21 || [], r22 = R.r22 || {}, r23 = R.r23 || {}, r24 = R.r24 || {}, r26 = R.r26 || {};
check(r21.length === 6 && r21.every((x) => x.ok === true && x.settled === true && x.n === 40 && x.same === true && x.scrollOk === true), "R21 섞어 친 6시드 모두 — 데스크톱이 받은 차례 · 굴린 양 = 사람이 한 것", r21.filter((x) => !(x.ok && x.settled && x.same && x.scrollOk)));
check(r22.ok === true && r22.slow === true && r22.newest === true && r22.stale === false, "R22 늦게 온 옛 그림은 새 그림을 덮지 않는다", r22);
check(r23.ok === true && r23.polled === true && r23.reverted === false && r23.titleReverted === false && /new\.example\/page/.test(r23.last || ""), "R23 느린 이동 중에도 주소줄 · 칸 탭 이름이 옛 주소로 안 돌아간다 · 끝나면 새 주소", r23);
check(r24.ok === true && r24.quick === true, "R24 창에 초점이 돌아오면 곧바로 받는다", r24);
check(r26.ok === true && r26.fr === true && r26.after <= 40000, "R26 409 뒤 상태 묻기가 멈춰도 15초 상한으로 끊고 iframe 칸으로", r26);
check(Array.isArray(R.pageErrors) && R.pageErrors.length === 0, "P 페이지 오류 0", R.pageErrors);

console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
