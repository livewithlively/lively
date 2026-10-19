#!/usr/bin/env node
// 꺼진 세션을 열면 마지막 답이 바닥 아래 숨고 마지막으로 보이는 줄이 내 질문이던 것 (2026-10-19, 런타임) — 대화창 바닥 따라가기.
//
//  신고(원준님 2026-10-19): «AI 를 꺼 두었어요 … 너가 나한테 대답한 내용들은 보여주지 않고, 마지막에 보이는게 내 질문인 상태».
//  실측(매니지드 box-wonjoon-jang-febbca30 · …86a360ca, 헤드리스 크롬): 박스 대화 파일·중앙 기록 둘 다 마지막 답을 돌려주는데,
//   화면은 처음 열며 바닥으로 내린 **뒤에** «꺼 두었어요» 안내 줄(36px)과 입력칸(75px)이 서서 목록 칸이 줄고, 늦게 그려진 내용이 더
//   자라 마지막 답이 90~244px 아래에 숨었다. 브라우저는 칸이 줄어도 scrollTop 을 그대로 두어 scroll 사건이 없고, 폴링이 멈춘 세션이라
//   scroll() 이 다시 불리지 않아 영영 그 자리였다. `Jump to bottom (click) ↓` 만 떴다.
//
//  엣지 표(행마다 장면 하나 · tui · desktop 두 문법):
//   S1  바닥으로 내린 직후 — 틈 0
//   S2  입력칸이 다시 서고(setFooter(null)) 안내 줄이 선다(setNote) · 칸이 111px(>48) 준다 → **그대로 바닥**(틈 ≤ 1)
//   S2b 안내 줄만 선다(36px < NEAR_BOTTOM 48 · 경계값) → 틈 ≤ 1 · [최신 대화로] 안 섬
//   S3  끝 덩이가 늦게 자란다(표·그림이 그려지듯 마지막 턴 안에 200px 이 더 붙는다) → 그대로 바닥(크기 관찰자)
//   S4  사람이 올려 둔 상태(휠 뒤 stick 거짓)에서 같은 일이 나면 → 자리를 **안 옮긴다**(scrollTop 그대로) · [최신 대화로] 단추가 선다
//   S4b 사람 입력 없이 자리만 바뀐 스크롤(브라우저 고정 · 글꼴 도착) → stick 그대로 · 다음 크기 변화에서 바닥
//   S5  새로 도입한 ResizeObserver 가 **없는** 브라우저 → S2 는 여전히 틈 ≤ 1(틱 뒤 재고정 경로)
//  fail-first: `SRC_ROOT=<옛 트리>`(web/ · public/styles 가 있는 곳)로 옛 코드를 물리면 S2 · S2b · S5 가 빨갛다(두 문법 모두).
//   크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0). 헤드리스(가상 시간)는 화면을 안 그려 ResizeObserver 배달이 보장되지 않는다 —
//   S3 은 관찰자가 배달됐을 때만 단언하고(ro 플래그), 배달이 안 됐으면 그 사실을 적고 넘어간다.
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 대화창 바닥 따라가기 런타임 검증 미실행"); process.exit(0); }

const CSS = ["01-base.css", "03-components.css", "35-liv.css", "36-chat.css", "38-chat-tui.css"].map((f) => path.join(ROOT, "public/styles", f)).filter(existsSync);
const sc = buildSync({
  stdin: { contents: "export { createChatView } from './web/chat-view.ts';", resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "CV", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;

async function PAGE_MAIN() {
  const R = { errors: [] };
  window.addEventListener("error", (e) => R.errors.push(String(e.message || e)));
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const gap = (list) => Math.round(list.scrollHeight - list.scrollTop - list.clientHeight);
  const RO = window.ResizeObserver;
  //  scene: 25턴짜리 대화를 420px 칸에 세우고 바닥으로 내린다. noRo 면 관찰자 없는 브라우저를 흉내 낸다(S5).
  const mount = (style, noRo) => {
    if (noRo) window.ResizeObserver = undefined; else window.ResizeObserver = RO;
    //  세션 화면과 같은 틀(.sc-wrap › .sc-chat › .livc-wrap — 36-chat.css · 35-liv.css 가 목록을 스크롤 상자로 만든다)
    const wrap = document.createElement("div"); wrap.className = "sc-wrap";
    wrap.style.cssText = "height:420px;width:720px;display:flex;flex-direction:column;overflow:hidden;position:relative";
    const host = document.createElement("div"); host.className = "sc-chat";
    wrap.append(host); document.body.append(wrap);
    const view = CV.createChatView(host, {
      who: { me: "나", ai: "AI" }, placeholder: "이 세션에 보내기", toolLabel: (n) => ({ label: n }), thinking: "fold", sendWhileBusy: true,
      onSend: () => {}, style,
    });
    let last = null;
    for (let i = 1; i <= 25; i++) {
      const t = view.turn(`질문 ${i} — 이 줄이 내 말이다`);
      const ans = document.createElement("div"); ans.style.cssText = "height:60px"; ans.textContent = `답 ${i}`;
      t.work.append(ans);
      view.settle(t);
      last = t;
    }
    view.scrollToBottom();
    return { host: wrap, view, last, scrollable: view.list.scrollHeight > view.list.clientHeight + 100 };
  };
  const bar = () => { const b = document.createElement("div"); b.style.cssText = "height:40px"; b.textContent = "이어서 대화하기"; return b; };
  for (const style of ["tui", "desktop"]) {
    const r = { style };
    {
      const { host, view, last, scrollable } = mount(style, false);
      const list = view.list;
      await sleep(30);
      r.scrollable = scrollable;
      r.s1 = gap(list);
      //  S2 — 꺼진 세션의 길(paintDeadFooter 와 같은 순서): 발 줄을 세웠다가(입력칸 숨김) 되살릴 수 있어 다시 입력칸을 세우고 안내 줄을 적는다.
      view.setFooter(bar());
      await sleep(30);
      view.scrollToBottom();
      await sleep(30);
      const before = list.clientHeight;
      view.setFooter(null);
      view.setNote("작업이 끝나고 아무도 보지 않아 AI 를 꺼 두었어요 — 아래에 말을 걸면 다시 띄워 이어서 답합니다.");
      await sleep(60);
      r.s2 = gap(list);
      r.s2shrink = before - list.clientHeight;
      r.s2form = view.form.hidden;
      r.s2note = Math.round(view.noteEl.getBoundingClientRect().height);
      //  S3 — 끝 덩이가 늦게 자란다(표·그림). 관찰자 배달 여부를 함께 적는다.
      let roFired = false;
      try { new RO(() => { roFired = true; }).observe(last.root); } catch (_) { /* */ }
      const grow = document.createElement("div"); grow.style.cssText = "height:200px"; grow.textContent = "늦게 그려진 표";
      last.work.append(grow);
      await sleep(120);
      r.s3 = gap(list); r.s3ro = roFired;
      //  S4 — 사람이 올려 둔 상태
      await sleep(200);
      list.dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true }));   // 사람의 휠 — 이것 없이 스크롤 자리만 바뀌면 사람이 아니다(S4b)
      list.scrollTop = 0; list.dispatchEvent(new Event("scroll"));
      await sleep(200);
      const trace = [list.scrollTop];
      view.setNote("x2"); await sleep(30); trace.push(list.scrollTop);
      view.setFooter(bar()); await sleep(30); trace.push(list.scrollTop);
      view.setFooter(null); await sleep(30); trace.push(list.scrollTop);
      const grow2 = document.createElement("div"); grow2.style.cssText = "height:200px"; last.work.append(grow2);
      view.scroll();   // 새 것이 붙으면 화면이 부르는 것(event · stream 이 부른다)
      await sleep(120);
      trace.push(list.scrollTop);
      r.s4trace = trace;
      r.s4top = list.scrollTop;
      const jump = host.querySelector(".livc-jump");
      r.s4jump = jump ? !jump.hidden : null;
      //  S4b — 사람 입력 없는 스크롤(브라우저 고정 · 글꼴 도착 흉내): 자리만 위로 바뀐 뒤 끝 덩이가 자라면 다시 바닥
      await sleep(1700);
      view.scrollToBottom(); await sleep(30);
      list.scrollTop = list.scrollTop - 120; list.dispatchEvent(new Event("scroll"));
      await sleep(60);
      const grow3 = document.createElement("div"); grow3.style.cssText = "height:120px"; last.work.append(grow3);
      view.scroll();
      await sleep(120);
      r.s4b = gap(list);
      view.destroy(); host.remove();
    }
    {
      //  S2b — 안내 줄만(경계값: 36px < 48)
      const { host, view } = mount(style, false);
      const list = view.list;
      await sleep(30);
      view.setNote("답을 기다리는 동안 아무도 보지 않아 AI 를 꺼 두었어요");
      await sleep(60);
      r.s2b = gap(list);
      r.s2bshrink = Math.round(view.noteEl.getBoundingClientRect().height);
      const jump = host.querySelector(".livc-jump");
      r.s2bjump = jump ? !jump.hidden : null;
      view.destroy(); host.remove();
    }
    {
      //  S5 — 관찰자 없는 브라우저
      const { host, view } = mount(style, true);
      const list = view.list;
      await sleep(30);
      view.setFooter(bar()); await sleep(30); view.scrollToBottom(); await sleep(30);
      view.setFooter(null); view.setNote("꺼 두었어요 — 관찰자 없는 브라우저");
      await sleep(60);
      r.s5 = gap(list);
      view.destroy(); host.remove();
      window.ResizeObserver = RO;
    }
    R[style] = r;
  }
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const page = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out" style="position:fixed;left:-9999px">PENDING</pre>
<script>${sc.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;

const dom = await dumpDom(chrome, { html: page, serve: true, prefix: "chat-stick-", virtualTimeBudget: 20000, timeoutMs: 120000, args: ["--window-size=1200,900"], copy: CSS });
const res = readOut(dom);
if (res.text === null) { console.error(`FAIL  페이지가 결과를 안 냈다(out=${JSON.stringify(res.out)}): ${dom.slice(0, 300)}`); process.exit(1); }
const R = JSON.parse(res.text);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const check = (cond, n, got) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} :: 실제 ${JSON.stringify(got)}`); } };
if (R.fatal) { fail++; console.error(`FAIL  페이지가 던졌다: ${String(R.fatal).split("\n").slice(0, 3).join(" | ")}`); }
check(!R.errors || R.errors.length === 0, "페이지 오류 0", R.errors);
for (const style of ["tui", "desktop"]) {
  const r = R[style] || {};
  check(r.scrollable === true, `S0 ${style} — 전제(배선): 목록이 스크롤 상자이고 내용이 칸보다 길다`, r.scrollable);
  check(r.s1 <= 1, `S1 ${style} — 바닥으로 내린 직후 틈 0`, r.s1);
  check(r.s2form === false && r.s2note > 0 && r.s2shrink > 48, `S2 ${style} — 전제: 입력칸이 다시 서고 안내 줄이 서서 칸이 48px 넘게 줄었다`, { form: r.s2form, note: r.s2note, shrink: r.s2shrink });
  check(r.s2 <= 1, `S2 ${style} — 칸이 줄어도 그대로 바닥(틈 ≤ 1)`, r.s2);
  check(r.s2bshrink > 0 && r.s2bshrink < 48, `S2b ${style} — 전제: 안내 줄 하나는 48px 보다 작다(경계값)`, r.s2bshrink);
  check(r.s2b <= 1 && r.s2bjump === false, `S2b ${style} — 안내 줄만 서도 바닥 · [최신 대화로] 안 섬`, { gap: r.s2b, jump: r.s2bjump });
  if (r.s3ro) check(r.s3 <= 1, `S3 ${style} — 끝 덩이가 늦게 자라도 그대로 바닥(크기 관찰자)`, r.s3);
  else console.log(`skip  S3 ${style} — 헤드리스가 ResizeObserver 를 배달하지 않았다 · 실제 크롬에서만 재는 행`);
  check(r.s4top === 0, `S4 ${style} — 사람이 올려 둔 동안엔 자리를 안 옮긴다`, r.s4trace);
  check(r.s4jump === true, `S4 ${style} — 올려 둔 동안 새 것이 붙으면 [최신 대화로] 단추가 선다`, r.s4jump);
  check(r.s4b <= 1, `S4b ${style} — 사람 입력 없이 자리가 바뀐 스크롤(브라우저 고정 · 글꼴 도착)은 바닥 따라가기를 풀지 않는다`, r.s4b);
  check(r.s5 <= 1, `S5 ${style} — ResizeObserver 가 없는 브라우저에서도 S2 가 바닥`, r.s5);
}
console.log(`\n${fail ? "✗" : "✓"} chat-stick-bottom-runtime: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
