// #5650 — 대화 화면(chat-view)의 답 글에도 터미널과 **같은 규칙**으로 파일 경로·지식 이름 링크를 단다 · 터미널은 링크에 늘 옅은 밑줄.
//  원준 2026-11-24: 회수·오류로 끝난 세션은 세션 화면이 터미널을 걷고 대화 화면으로 내려앉는데, 거기선 경로가 그냥 글자였다.
//   «왜 어떤건 파랗고 어떤건 안파란거야» — 파란 글자는 하네스가 칠한 코드 색이라 링크 표시가 아니다 → 밑줄로 알린다.
//
//  | #   | 입력                                                     | 기대                                                      |
//  |-----|----------------------------------------------------------|-----------------------------------------------------------|
//  | C1  | 문장 속 프로젝트 경로(조사 붙음)                            | 경로만 <a data-path href="#/f?…">, 앞뒤 글 그대로           |
//  | C2  | 인라인 코드(<code>) 속 경로                                 | code 안에서 링크                                           |
//  | C3  | 세션 폴더 경로 `docs/a.md`                                  | 세션 화면(hasSession)에서만 링크 · href 없음(role=link)     |
//  | C4  | 이미 링크인 것(<a>) 속 경로 · 프로젝트 밖 경로 · 파일 이름만  | 건드리지 않는다                                            |
//  | C5  | 지식 이름 후보 — 서버 200 / 404                              | 200 만 <a href="#/k/이름"> · 404 는 글자 그대로            |
//  | C6  | 링크 요소 → 곁칸이 받을 모양(pathLinkOf)                     | path · target · cands(앞 낱말 후보 먼저, 화면 경로 끝)      |
//  | C7  | 윈도우 드라이브 경로                                        | 프로젝트 경로로 링크                                       |
//  | D1  | 판정 사본 둘(standalone/path-link.ts · lib/path-link.ts)    | 글자까지 같다                                              |
//  | U1~U4 | 터미널 밑줄 조각(underlineSegs)                           | 링크에만 · 여러 행 링크는 행마다 · 링크 없는 파란 코드는 없음 |
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";
import { importTerminalModule } from "./standalone-terminal-env.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${String(e.message).split("\n")[0]}`); }
};

// ── D1 사본 ──────────────────────────────────────────────────────────
t("D1 판정 사본 둘이 글자까지 같다(한쪽만 고치면 터미널과 대화 화면의 링크가 갈린다)", () => {
  assert.equal(readFileSync(path.join(ROOT, "web/lib/path-link.ts"), "utf8"), readFileSync(path.join(ROOT, "web/standalone/path-link.ts"), "utf8"));
});

// ── W 배선 ──────────────────────────────────────────────────────────
const src = (f) => readFileSync(path.join(ROOT, f), "utf8");
t("W1 대화창 — 답 글(renderBody)과 다시 그린 표 둘 다 linkifyChat 을 지난다", () => {
  const cv = src("web/chat-view.ts");
  assert.match(cv, /const renderBody = \(s: string\): HTMLElement => linkifyChat\(renderBodyRaw\(s\), !!opts\.pathSession\);/);
  assert.match(cv, /const next = linkifyChat\(tuiMarkdown\(src, cols\), !!opts\.pathSession\);/);
});
t("W2 대화창 클릭 — 경로 링크는 곁칸에 kind 'path' 로 묻고, 받거나 href 가 없으면 기본 이동을 막는다", () => {
  const cv = src("web/chat-view.ts");
  assert.match(cv, /closest\?\.\('a\[data-path\]'\)/);
  assert.match(cv, /kind: 'path' as const/);
  assert.match(cv, /if \(detail\.handled \|\| !pa\.getAttribute\('href'\)\) e\.preventDefault\(\);/);
});
t("W3 세션 화면은 세션 id 를 준다 · 곁칸은 경로를 planPathOpen 으로", () => {
  assert.match(src("web/session-chat.ts"), /pathSession: \(\) => target\.id,/);
  assert.match(src("web/v2/panes.ts"), /if \(link\.kind === 'path'\) \{\n\s+const run = planPathOpen\(\{ path: link\.path, target: link\.target, sid: link\.sid, cands: link\.cands \}\);/);
});
t("W4 터미널 — 열면 밑줄 배선을 건다 · 밑줄 칸 꾸밈이 있다", () => {
  assert.match(src("web/standalone/terminal.ts"), /term\.open\(host\);\n\s+wireLinkUnderlines\(\);/);
  assert.match(src("public/terminal.html"), /\.term-link-ul \{ position: absolute; pointer-events: none;[^}]*border-bottom: 1px dotted;/);
});

// ── U 터미널 밑줄(순수) ───────────────────────────────────────────────
const m = await importTerminalModule();
t("U1 한 행의 프로젝트 경로 — 경로 칸만 밑줄", () => {
  const row = "저장: /work/shared/project/12/a.md 확인";
  const segs = m.underlineSegs([row], [false], 0, 1, 80);
  const s = row.indexOf("/work");
  assert.deepEqual(segs, [{ row: 0, c0: s, c1: s + "/work/shared/project/12/a.md".length }]);
});
t("U2 파란 코드 글자라도 링크가 아니면 밑줄 없음(`project/번호/` · 프로젝트 밖 경로 · 파일 이름만)", () => {
  const rows = ["  project/번호/ 가 들어간 경로", "  /private/tmp/x/el-setup.png", "  setup-after.png 저장"];
  assert.deepEqual(m.underlineSegs(rows, [false, false, false], 0, 3, 80), []);
});
t("U3 폭을 넘겨 두 행으로 잘린 URL — 행마다 한 조각(둘째 행은 들여쓰기 뒤부터)", () => {
  const cols = 30;
  const url = "https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const r0 = "  " + url.slice(0, cols - 2), r1 = "  " + url.slice(cols - 2);
  const segs = m.underlineSegs([r0, r1], [false, false], 0, 2, cols);
  assert.deepEqual(segs, [{ row: 0, c0: 2, c1: cols }, { row: 1, c0: 2, c1: r1.length }]);
});
t("U4 보이는 행만(first·count) — 위 여유 행의 링크는 안 긋는다", () => {
  const rows = ["https://a.io/x", "글", "https://b.io/y"];
  const segs = m.underlineSegs(rows, [false, false, false], 1, 2, 80);
  assert.deepEqual(segs, [{ row: 1, c0: 0, c1: "https://b.io/y".length }]);
});

// ── C 대화 화면(크롬) ─────────────────────────────────────────────────
const chrome = findChrome();
if (!chrome) {
  console.log("skip  크롬을 못 찾아 대화 화면 런타임 검증(C1~C7)은 건너뜁니다(CHROME_BIN 으로 지정)");
} else {
  const bundle = buildSync({
    stdin: { contents: "export * from './web/lib/chat-links.ts';", resolveDir: ROOT, loader: "ts" },
    bundle: true, format: "iife", globalName: "CL", write: false, platform: "browser", target: "es2020", logLevel: "silent",
  }).outputFiles[0].text;

  function PAGE_PREP() {
    window.__asked = [];
    window.fetch = (u) => {
      const name = decodeURIComponent(String(u).split("/api/ui/knowledge/")[1].split("?")[0]);
      window.__asked.push(name);
      return Promise.resolve({ ok: name === "terminal-path-link-4562", status: name === "terminal-path-link-4562" ? 200 : 404 });
    };
  }
  async function PAGE_MAIN() {
    const R = {};
    const box = (html) => { const d = document.createElement("div"); d.innerHTML = html; document.body.append(d); return d; };
    const links = (d) => Array.from(d.querySelectorAll("a")).map((a) => ({ text: a.textContent, path: a.getAttribute("data-path"), href: a.getAttribute("href"), role: a.getAttribute("role"), inCode: !!a.closest("code") }));
    let d = box("파일은 /work/shared/project/12/보고서.md에 저장했습니다.");
    CL.linkifyPaths(d, false); R.c1 = { links: links(d), text: d.textContent };
    d = box("열기 <code>/Users/a/workspace/project/12/out/a.png</code> 끝");
    CL.linkifyPaths(d, false); R.c2 = links(d);
    d = box("docs/report.md 를 고쳤습니다");
    CL.linkifyPaths(d, false); R.c3no = links(d);
    d = box("docs/report.md 를 고쳤습니다");
    CL.linkifyPaths(d, true); R.c3yes = links(d);
    d = box('<a href="https://x.io/project/12/a.md">https://x.io/project/12/a.md</a> /private/tmp/x/a.png setup-after.png');
    CL.linkifyPaths(d, true); R.c4 = links(d);
    d = box("산출 지식 terminal-path-link-4562 와 diff-reviewer-agent-x 참고");
    await CL.linkifyKnowledge(d); R.c5 = { links: links(d), asked: window.__asked.slice() };
    d = box("데모데이 발표덱/x.html 열기");
    CL.linkifyPaths(d, true);
    const a6 = d.querySelector("a[data-path]");
    R.c6 = a6 ? CL.pathLinkOf(a6) : null;
    d = box("저장: C:\\Users\\a\\workspace\\project\\12\\보고서.md");
    CL.linkifyPaths(d, false); R.c7 = links(d);
    document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
  }
  const page = `<!doctype html><html><meta charset="utf-8"><body><pre id="out" style="position:fixed;left:-9999px">PENDING</pre>
<script>(${PAGE_PREP.toString()})();</script>
<script>${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;
  const dom = await dumpDom(chrome, { html: page, prefix: "chatlinks-" });
  const res = readOut(dom);
  assert.ok(res.text !== null, `결과를 못 받았다 — ${res.out}`);
  const R = JSON.parse(res.text);
  assert.ok(!R.fatal, R.fatal);
  const enc = encodeURIComponent;

  t("C1 문장 속 프로젝트 경로 — 조사를 뗀 경로만 링크 · href 는 자료 보기 · 글은 그대로", () => {
    assert.deepEqual(R.c1.links, [{ text: "/work/shared/project/12/보고서.md", path: "/work/shared/project/12/보고서.md", href: "#/f?root=shared&path=" + enc("project/12/보고서.md"), role: null, inCode: false }]);
    assert.equal(R.c1.text, "파일은 /work/shared/project/12/보고서.md에 저장했습니다.");
  });
  t("C2 인라인 코드 속 경로도 링크(Claude 가 백틱으로 준 경로)", () => {
    assert.equal(R.c2.length, 1); assert.equal(R.c2[0].inCode, true); assert.equal(R.c2[0].path, "/Users/a/workspace/project/12/out/a.png");
  });
  t("C3 세션 폴더 경로는 세션 화면에서만 · href 없이 role=link", () => {
    assert.deepEqual(R.c3no, []);
    assert.deepEqual(R.c3yes, [{ text: "docs/report.md", path: "docs/report.md", href: null, role: "link", inCode: false }]);
  });
  t("C4 이미 링크인 것 · 프로젝트 밖 경로 · 파일 이름만은 그대로", () => {
    assert.equal(R.c4.length, 1); assert.equal(R.c4[0].path, null);
  });
  t("C5 지식 이름 — 서버가 있다고 한 것만 #/k/ 링크, 없는 것은 글자", () => {
    assert.deepEqual(R.c5.links.map((x) => [x.text, x.href]), [["terminal-path-link-4562", "#/k/terminal-path-link-4562"]]);
    assert.ok(R.c5.asked.includes("diff-reviewer-agent-x"), "후보를 물어야 한다");
  });
  t("C6 곁칸이 받을 모양 — 앞 낱말 붙인 후보 먼저, 화면 경로 끝", () => {
    assert.equal(R.c6.path, "발표덱/x.html");
    assert.deepEqual(R.c6.target, { kind: "session", rel: "발표덱/x.html" });
    assert.deepEqual(R.c6.cands.map((c) => c.path), ["데모데이 발표덱/x.html", "발표덱/x.html"]);
  });
  t("C7 윈도우 드라이브 경로 — 프로젝트 자료로", () => {
    assert.equal(R.c7.length, 1);
    assert.equal(R.c7[0].path, "C:\\Users\\a\\workspace\\project\\12\\보고서.md");
    assert.equal(R.c7[0].href, "#/f?root=shared&path=" + enc("project/12/보고서.md"));
  });
}
console.log(`chat-links: ${pass} passed${fail ? `, ${fail} failed` : ""}`);
if (fail) process.exit(1);
