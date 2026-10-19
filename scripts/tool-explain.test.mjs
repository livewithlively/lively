#!/usr/bin/env node
// 앱 동의 창 «도구» 칩의 쉬운 설명(#4632, 원준 2026-10-19 «일반인 입장에서 저 도구가 각각 뭐하는건지 모르겠음 … 위에 호버하면 고등학생도 이해할 수 있는 수준으로 내용을 좀 뜨게 해줘»).
//  T — 설명 표(web/lib/tool-explain.ts · 컴파일된 public/app/lib/tool-explain.js) · R — 동의 창에서 실제로 뜨나(헤드리스 크롬 · v2/app-session.ts ensureAppGrant).
//  엣지 표: 스크래치패드 spec-side-foot-phone.md 사양 3.
//  fail-first: TOOL_EXPLAIN_JS=<다른 빌드> · SRC_ROOT=<다른 트리>(이 변경 전 origin/main 에서 T · R 이 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "") => (cond ? ok(n) : bad(n, why));
const same = (got, want, n) => { const a = JSON.stringify(got), b = JSON.stringify(want); return a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };

//  2026-10-19 실측 — 워크스페이스(lively-46e3) 앱과 기본 앱 매니페스트가 선언한 도구 28 + 자주 쓸 것(위키 · AI).
//  link_preview 는 앱이 선언했지만 코어에 그 도구가 없다(격리 리뷰 실측) — 표에 넣지 않고 일반 문장으로 둔다(T4).
const SEEN = ["app_chat_send", "app_notify", "app_project_files", "app_workspace_files", "category_create", "category_delete", "category_group_list", "category_group_remove",
  "category_group_upsert", "category_list", "category_update", "file_url", "knowledge_list", "me_notifications", "me_notifications_read", "project_list_index_v6",
  "repo_list", "source_get", "source_list", "source_tree", "store_delete", "store_insert", "store_query", "store_sql", "store_tables", "store_update", "whoami"];
const MORE = ["knowledge_search", "knowledge_get", "knowledge_save", "agent_job_run", "app_ai_run"];

// ══ T 설명 표 ══
const modPath = process.env.TOOL_EXPLAIN_JS || path.join(ROOT, "public/app/lib/tool-explain.js");
if (!existsSync(modPath)) bad("T0 설명 표가 있다(public/app/lib/tool-explain.js)", "빌드 없음 — npm run build:web 뒤에 돌린다");
else {
  const T = await import(modPath);
  const miss = [...SEEN, ...MORE].filter((n) => !Object.prototype.hasOwnProperty.call(T.TOOL_EXPLAIN, n));
  check(miss.length === 0, "T1 앱들이 실제로 선언한 도구 · 자주 쓸 도구는 전부 제 설명이 있다(갈래 글로 떨어지지 않는다)", JSON.stringify(miss));
  const E = T.toolExplain;
  //  표의 글 + 갈래 글 · 바깥 서비스 글 · 일반 문장도 같은 잣대로(격리 리뷰 — 표 밖의 글은 안 재고 있었다).
  const all = [...Object.entries(T.TOOL_EXPLAIN), ...["store_x", "knowledge_x", "category_x", "category_group_x", "source_x", "project_x", "task_x", "session_x", "me_x", "app_x", "slack_x", "ext__notion_x", "figma_x", "zzz"].map((n) => [n, E(n)])];
  const off = all.filter(([k, v]) => !v || !/요\.$/.test(v) || /—|·/.test(v) || v.length > 90 || /[a-z]+_[a-z_]+/.test(v) || v.includes(k)).map(([k, v]) => k + ": " + v);
  check(off.length === 0, "T2 설명은 서비스 말투 한두 문장(~요.) · 「—」 「·」 없이 · 90자 이하 · 도구 이름 같은 영문 없이(표 · 갈래 · 바깥 서비스 · 일반 문장 모두)", JSON.stringify(off));
  //  동의 창은 권한을 알리는 자리 — 실제 권한보다 좁게 말하지 않는다(격리 리뷰: src/capabilities app-store · whoami · files).
  check(/지울/.test(T.TOOL_EXPLAIN.store_sql) && /더하/.test(T.TOOL_EXPLAIN.store_sql) && /이메일/.test(T.TOOL_EXPLAIN.whoami) && /올리/.test(T.TOOL_EXPLAIN.file_url),
    "T2 권한을 좁게 말하지 않는다 — store_sql 은 더하기 · 지우기까지 · whoami 는 이메일까지 · file_url 은 올리기까지", JSON.stringify([T.TOOL_EXPLAIN.store_sql, T.TOOL_EXPLAIN.whoami, T.TOOL_EXPLAIN.file_url]));
  check(E("store_export") === E("store_zzz") && /이 앱의 기록/.test(E("store_export")) && E("category_group_x") !== E("category_x") && /묶음/.test(E("category_group_x")) && /분류/.test(E("category_x")),
    "T3 표에 없는 도구 — 앞머리로 갈래(긴 앞머리 먼저: 분류 묶음 ≠ 분류)", JSON.stringify([E("store_export"), E("category_group_x"), E("category_x")]));
  check(/^슬랙을 /.test(E("slack_send_message")) && /^노션을 /.test(E("ext__notion_search")) && /^피그마를 /.test(E("figma_get_file")) && /^깃허브를 /.test(E("github_list_prs")) && /^구글을 /.test(E("google_drive_search")),
    "T3 바깥 서비스 — 서비스 이름과 맞는 조사(을 · 를) · 내 계정으로", JSON.stringify([E("slack_send_message"), E("ext__notion_search"), E("figma_get_file")]));
  const U = T.TOOL_EXPLAIN_UNKNOWN;
  check(typeof U === "string" && U.length > 0 && [E(""), E(null), E(undefined), E("   "), E("zzz"), E("__proto__"), E("constructor"), E("toString"), E("link_preview")].every((x) => x === U),
    "T4 빈 이름 · 모르는 이름 · 객체 속 이름(__proto__ · constructor · toString)은 일반 문장(빈 칸 · 함수 글이 뜨지 않는다)", JSON.stringify([E("__proto__"), E("constructor")]));
}

// ══ R 동의 창 ══
const chrome = findChrome();
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!chrome || !existsSync(ESBUILD)) console.log("skip  R — 크롬 · esbuild 가 없어 동의 창 런타임 검증 미실행");
else {
  const WEB = path.join(SRC_ROOT, "web"), STYLES = path.join(SRC_ROOT, "public/styles");
  const bundle = execFileSync(ESBUILD, ["--bundle", "--format=iife", "--global-name=AS", "--platform=browser", "--loader=ts", "--sourcefile=consent-entry.ts", "--define:import.meta.url=\"file:///x.js\"", "--log-level=error"],
    { cwd: WEB, input: "export { ensureAppGrant } from './v2/app-session.ts';", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/<\/script/gi, "<\\/script");
  const css = ["01-base.css", "40-v2.css"].map((f) => readFileSync(path.join(STYLES, f), "utf8")).join("\n").replace(/<\/style/gi, "<\\/style");
  const TOOLS = ["store_query", "store_insert", "store_update", "store_delete", "store_tables", "store_sql", "whoami", "app_notify", "link_preview", "file_url"];
  const APPS = [{ id: "talk", title: "팀 채널", status: "active", enabled: true, manifest: { permissions: { tools: TOOLS, scopes: ["items"] } } }];
  async function PAGE() {
    const R = {}; const errors = [];
    window.addEventListener("error", (e) => errors.push(String(e.message || e)));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    void AS.ensureAppGrant("talk", "팀 채널");
    await sleep(400);
    const tip = () => document.querySelector(".v2-consent-tip");
    const shown = () => { const t = tip(); return !!t && !t.hidden && t.getClientRects().length > 0; };
    const chipsOf = (label) => { const g = [...document.querySelectorAll(".v2-consent-grp")].find((x) => (x.querySelector("b") || {}).textContent === label); return g ? [...g.querySelectorAll(".v2-consent-chip")] : []; };
    const tools = chipsOf("도구");
    R.r1 = { n: tools.length, tips: tools.map((c) => c.getAttribute("data-tip")), focusable: tools.every((c) => c.tabIndex === 0) };
    const first = tools[0], last = tools[tools.length - 1];
    const pe = (c, type, pointerType) => c && c.dispatchEvent(new PointerEvent(type, { bubbles: type === "pointerdown", pointerType }));
    pe(first, "pointerenter", "mouse"); await sleep(30);
    R.r1.hover = { shown: shown(), text: tip() && tip().textContent, desc: first && first.getAttribute("aria-describedby"), w: tip() ? Math.round(tip().getBoundingClientRect().width) : 0 };
    pe(first, "pointerleave", "mouse"); await sleep(30);
    R.r1.leave = shown();
    if (last) last.focus(); await sleep(30);
    R.r1.focus = { shown: shown(), text: tip() && tip().textContent };
    if (last) last.blur(); await sleep(30);
    R.r1.blur = shown();
    pe(first, "pointerenter", "touch"); await sleep(30);
    R.r1.touchEnter = shown();   // 손가락의 «들어옴» 으로는 안 뜬다 — 누를 때 뜬다
    pe(first, "pointerdown", "touch"); await sleep(30);
    R.r1.tap1 = shown();
    pe(first, "pointerdown", "touch"); await sleep(30);
    R.r1.tap2 = shown();
    // R2 — 오른쪽 끝 칩 · 좁은 창
    pe(last, "pointerenter", "mouse"); await sleep(30);
    const r = tip() ? tip().getBoundingClientRect() : null;
    R.r2 = r ? { left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight } : null;
    pe(last, "pointerleave", "mouse");
    R.r3 = { scope: chipsOf("권한").map((c) => [c.textContent, c.classList.contains("has-tip"), c.getAttribute("data-tip")]) };
    // R4 — 칩을 바꿔 누르면 앞 칩의 연결이 끊긴다(격리 리뷰 재현) · 오른쪽 끝에서 뜬 뒤 왼쪽 칩에서 다시 뜨면 폭이 눌리지 않는다
    pe(last, "pointerdown", "touch"); await sleep(30);
    const wRight = tip() ? Math.round(tip().getBoundingClientRect().width) : 0;
    pe(first, "pointerdown", "touch"); await sleep(30);
    pe(tools[1], "pointerdown", "touch"); await sleep(30);
    R.r4 = { described: tools.map((c) => c.getAttribute("aria-describedby")), text: tip() && tip().textContent };
    //  눌림은 오른쪽 끝에 짧은 설명이 뜬 뒤 그 근처 칩에 긴 설명이 뜰 때 남는다(격리 리뷰 재현 — 왼쪽 칩이면 자리를 새로 잡아 안 보인다).
    last.setAttribute("data-tip", "짧아요."); pe(last, "pointerdown", "touch"); await sleep(30);
    tools[2].setAttribute("data-tip", first.getAttribute("data-tip")); pe(tools[2], "pointerdown", "touch"); await sleep(30);
    const t1 = tip().getBoundingClientRect();   // 단언 대상은 tools[2] 의 긴 설명(첫 칩과 같은 글 — 처음 잰 폭과 같아야 한다)
    R.r4.firstAfterRight = { w: Math.round(t1.width), h: Math.round(t1.height), wRight, fresh: R.r1.hover.w, vw: window.innerWidth, right: Math.round(t1.right) };
    // R5 — 창 안 다른 곳을 누르면 닫힌다 · 창을 닫으면(취소) 설명도 함께 사라진다
    document.querySelector(".v2-consent-t").click(); await sleep(30);
    R.r5 = { outside: shown() };
    pe(first, "pointerdown", "touch"); await sleep(30);
    const cancel = [...document.querySelectorAll(".v2-consent-acts button")].find((b) => b.textContent === "취소");
    if (cancel) cancel.click(); await sleep(30);
    R.r5.closed = { tip: !!document.querySelector(".v2-consent-tip"), ov: !!document.querySelector(".v2-consent-ov") };
    // R3 — 권한 칩 · 빈 칩
    R.errors = errors;
    document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
  }
  const FETCH = `<script>window.fetch = async (u) => { const url = String(u && u.url ? u.url : u); const j = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
    if (/\\/api\\/ui\\/apps(\\?|$)/.test(url.replace(/^.*?(\\/api\\/)/, "/api/"))) return j({ apps: ${JSON.stringify(APPS)} }); return j({}); };</script>`;
  const html = `<!doctype html><html data-theme="light" lang="ko"><meta charset="utf-8"><style>${css} html,body{margin:0}</style><pre id="out">PENDING</pre>${FETCH}<script>${bundle}</script><script>(${PAGE.toString()})();</script>`;
  const dom = await dumpDom(chrome, { html, prefix: "consent-tip-", virtualTimeBudget: 20000, args: ["--window-size=400,860"] });
  const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  if (!m) bad("R  동의 창 결과를 못 받았다", dom.slice(-600));
  else {
    const R = JSON.parse(m[1]);
    if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));
    const T = existsSync(modPath) ? await import(modPath) : null;
    same(R.r1 && [R.r1.n, R.r1.focusable], [10, true], "R1 도구 칩 열 개 · 키보드로 갈 수 있다");
    check(!!T && R.r1 && JSON.stringify(R.r1.tips) === JSON.stringify(TOOLS.map((t) => T.toolExplain(t))), "R1 칩마다 그 도구의 쉬운 설명이 붙어 있다", JSON.stringify(R.r1 && R.r1.tips && R.r1.tips.slice(0, 2)));
    same(R.r1 && [R.r1.hover.shown, R.r1.hover.text === (T && T.toolExplain("store_query")), R.r1.hover.desc, R.r1.leave], [true, true, "v2-consent-tip", false], "R1 마우스를 올리면 뜨고(읽어 주는 프로그램도 그 설명을 칩에 잇는다) 벗어나면 숨는다");
    same(R.r1 && [R.r1.focus.shown, R.r1.focus.text === (T && T.toolExplain("file_url")), R.r1.blur], [true, true, false], "R1 키보드 초점이 가면 뜨고 떠나면 숨는다");
    same(R.r1 && [R.r1.touchEnter, R.r1.tap1, R.r1.tap2], [false, true, false], "R1 손가락 — 누르면 뜨고 다시 누르면 숨는다(폰엔 호버가 없다)");
    check(R.r2 && R.r2.vw <= 520 && R.r2.left >= 12 && R.r2.right <= R.r2.vw - 12 && R.r2.top >= 0 && R.r2.bottom <= R.r2.vh, "R2 좁은 창(헤드리스 최소 폭) · 끝 칩의 설명도 화면 안에 선다(좌우 12px 안쪽)", JSON.stringify(R.r2));
    same(R.r4 && [R.r4.described.filter(Boolean).length, R.r4.described[1], R.r4.text === (T && T.toolExplain(TOOLS[1]))], [1, "v2-consent-tip", true], "R4 칩을 바꿔 누르면 앞 칩의 연결이 끊기고 새 칩만 설명과 이어진다");
    check(R.r4 && R.r4.firstAfterRight.fresh > 0 && Math.abs(R.r4.firstAfterRight.w - R.r4.firstAfterRight.fresh) <= 2 && R.r4.firstAfterRight.right <= R.r4.firstAfterRight.vw - 12,
      "R4 오른쪽 끝에서 짧은 설명이 뜬 뒤 옆 칩에 긴 설명이 떠도 처음과 같은 폭 · 오른쪽 12px 안쪽(지난 자리를 지우고 잰다 · 눌려 좁고 길어지지 않는다)", JSON.stringify(R.r4 && R.r4.firstAfterRight));
    same(R.r5 && [R.r5.outside, R.r5.closed.tip, R.r5.closed.ov], [false, false, false], "R5 창 안 다른 곳을 누르면 닫히고 · 창을 닫으면 설명도 함께 사라진다");
    same(R.r3 && R.r3.scope, [["items", false, null]], "R3 권한 칩에는 도구 설명을 붙이지 않는다");
    same(R.errors, [], "R  페이지 예외 없음");
  }
}

console.log(`\n#4632 동의 창 도구 설명: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);
