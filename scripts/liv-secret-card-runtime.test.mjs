#!/usr/bin/env node
// 리브 자격 입력칸의 저장 위치(#1610 격리 리뷰 B1, 런타임) — 실제 카드 코드(web/liv-cards.ts livAskCard)를 헤드리스 크롬에 띄워 잰다.
//
//  계약: 본인 금고 요청은 서버가 만든 저장 위치 문장(ask.dest — src/org/delivery/liv-secret.ts vaultAskDest)을 싣는다.
//   카드는 그것을 리브가 준 label·why 와 **다른 칸**에 보인다 — 리브가 고른 칸을 리브의 말로만 설명하면, 사람은 자기가 친 토큰이
//   어느 칸·어느 호스트로 가는지(이미 있던 값을 덮는지) 볼 길이 없다.
//
//  엣지 표(행마다 장면 하나):
//   C1  dest 있는 요청                       → .liv-ask-dest 의 글 = dest 그대로
//   C2  label·why 가 dest 와 다른 말          → head 에는 label 만 · dest 칸은 head 밖 · dest 가 why 보다 위(긴 why 에 밀리지 않게)
//   C3  dest 없는 요청(수집기 대상·옛 요청)    → .liv-ask-dest 가 없다 · 입력칸은 그대로 뜬다
//  fail-first: `SRC_ROOT=<옛 트리>`(a0188cd81 — dest 칸 이전의 web/·public/styles/)로 물리면 C1 · C2 가 빨갛다(실측).
//   크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 리브 자격 입력칸 런타임 검증 미실행"); process.exit(0); }

const CSS = ["01-base.css", "03-components.css", "35-liv.css"].map((f) => path.join(ROOT, "public/styles", f)).filter(existsSync);
const sc = buildSync({
  stdin: { contents: "export { livAskCard } from './web/liv-cards.ts';", resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "LC", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;

async function PAGE_MAIN() {
  const R = { errors: [] };
  window.addEventListener("error", (e) => R.errors.push(String(e.message || e)));
  window.fetch = async () => new Response("{}", { headers: { "content-type": "application/json" } });
  const hooks = { say() {}, refresh() {}, fill() {} };
  const DEST = "이 값은 내 개인 금고의 «GitLab 개인 토큰» 칸에 저장되고, gitlab.corp.example 에 접속할 때 쓰입니다. 이미 저장된 값을 바꿉니다.";
  const mount = (ask) => { const host = document.createElement("div"); document.body.append(host); host.append(LC.livAskCard(ask, hooks)); return host; };

  { const h = mount({ kind: "secret", target: "vault", vault_kind: "gitlab_pat", vault_scope: "gitlab.corp.example",
      label: "GitLab 토큰", why: "회사 GitLab 의 이슈를 모으려면 이 토큰이 필요합니다.", dest: DEST });
    const head = h.querySelector(".liv-ask-head"), dest = h.querySelector(".liv-ask-dest"), why = h.querySelector(".liv-ask-why");
    R.c1 = { dest: dest ? dest.textContent : null };
    R.c2 = { head: head ? head.textContent : null, destInHead: !!(head && dest && head.contains(dest)),
      destBeforeWhy: !!(dest && why && (dest.compareDocumentPosition(why) & Node.DOCUMENT_POSITION_FOLLOWING)) };
    h.remove(); }
  { const h = mount({ collector_id: 3, field: "token", label: "Notion 토큰", why: "노션 문서를 모으려면 이 토큰이 필요합니다." });
    R.c3 = { dest: !!h.querySelector(".liv-ask-dest"), input: !!h.querySelector(".liv-ask-input") };
    h.remove(); }

  document.getElementById("out").textContent = JSON.stringify({ ...R, DEST }) + "ENDRESULT";
}

const page = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><pre id="out" style="position:fixed;left:-9999px">PENDING</pre>
<script>${sc.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;

const dom = await dumpDom(chrome, { html: page, serve: true, prefix: "liv-secret-", virtualTimeBudget: 10000, timeoutMs: 120000, args: ["--window-size=1100,900"], copy: CSS });
const res = readOut(dom);
if (res.text === null) { console.error(`FAIL  페이지가 결과를 안 냈다(out=${JSON.stringify(res.out)}): ${dom.slice(0, 300)}`); process.exit(1); }
const R = JSON.parse(res.text);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const check = (cond, n, got) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} :: 실제 ${JSON.stringify(got)}`); } };
if (R.fatal) { fail++; console.error(`FAIL  페이지가 던졌다: ${String(R.fatal).split("\n").slice(0, 3).join(" | ")}`); }
check(!R.errors || R.errors.length === 0, "페이지 오류 0", R.errors);
check(R.c1?.dest === R.DEST, "C1 ★ 서버가 만든 저장 위치 문장이 제 칸(.liv-ask-dest)에 그대로 보인다", R.c1);
check(R.c2?.head === "GitLab 토큰" && R.c2.destInHead === false && R.c2.destBeforeWhy === true,
  "C2 ★ 리브의 label 은 head 에만 · 저장 위치는 head 밖 제 칸 · why 보다 위", R.c2);
check(R.c3?.dest === false && R.c3.input === true, "C3 저장 위치가 없는 요청(수집기·옛 요청)은 그 칸 없이 입력칸만", R.c3);
console.log(`\n${fail ? "✗" : "✓"} liv-secret-card-runtime: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
