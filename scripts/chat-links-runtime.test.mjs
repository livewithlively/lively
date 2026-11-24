// #5650 — 대화 화면(chat-view)의 답 글에도 터미널과 **같은 규칙**으로 파일 경로·지식 이름 링크를 단다 · 터미널은 링크에 늘 옅은 밑줄.
//  2026-11-24 «경로를 파일 이름으로 감싸서 picture.png 이렇게 · 우클릭하면 링크 · 지식은 이름만».
//  2026-11-24: 회수·오류로 끝난 세션은 세션 화면이 터미널을 걷고 대화 화면으로 내려앉는데, 거기선 경로가 그냥 글자였다.
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
//  | C8  | 우리 화면 지식 주소를 그대로 적은 링크(autolink)               | 지식 이름만 보이고 data-kn                                  |
//  | C9  | 자료 주소 링크 — 주소 그대로 / 사람이 붙인 라벨               | 주소면 파일 이름만 · 라벨이면 라벨 그대로 · 둘 다 data-path  |
//  | C10 | 모든 링크에 우클릭 표지(data-ctx=chat-link) · 마우스를 올리면 실제 경로(title) |                                 |
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
t("W2 대화창 클릭 — 경로 링크는 곁칸에 kind 'path' 로 묻고, 기본 이동은 늘 막고, 곁칸이 없으면 자료 보기를 새 탭으로", () => {
  const cv = src("web/chat-view.ts");
  assert.match(cv, /closest\?\.\('a\[data-path\]'\)/);
  assert.match(cv, /kind: 'path' as const/);
  assert.match(cv, /e\.preventDefault\(\);\n\s+if \(detail\.handled\) return;\n[^\n]*\n\s+if \(pa\.getAttribute\('href'\)\) window\.open\(pa\.href, '_blank', 'noopener'\);/);
});
t("W3 세션 화면은 세션 id 를 준다 · 곁칸은 경로를 planPathOpen 으로", () => {
  assert.match(src("web/session-chat.ts"), /pathSession: \(\) => target\.id,/);
  assert.match(src("web/v2/panes.ts"), /if \(link\.kind === 'path'\) \{\n\s+const run = planPathOpen\(\{ path: link\.path, target: link\.target, sid: link\.sid, cands: link\.cands \}\);/);
});
t("W4 터미널 — 열면 밑줄 배선을 건다 · 밑줄 칸 꾸밈이 있다", () => {
  assert.match(src("web/standalone/terminal.ts"), /term\.open\(host\);\n\s+wireLinkUnderlines\(\);/);
  assert.match(src("public/terminal.html"), /\.term-link-ul \{ position: absolute; pointer-events: none;[^}]*border-bottom: 1px solid;/);
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

t("U5 밑줄 색 — 밝은 바탕엔 진한 파랑, 어두운 바탕엔 밝은 파랑", () => {
  assert.equal(m.linkBlue("#ffffff"), "#2563eb");
  assert.equal(m.linkBlue("#1e1e1e"), "#60a5fa");
  assert.equal(m.linkBlue(""), "#3b82f6");
});
t("W5 지식은 [지식] 칸에서 — 곁칸이 답 글·터미널의 지식 주소를 openKnowledgeAt 으로, [지식] 칸이 신호를 듣는다", () => {
  const pn = src("web/v2/panes.ts");
  assert.match(pn, /const kn = link\.kind === 'web' \? knNameOfUrl\(link\.url\) : null;\n\s+if \(kn && openKnowledgeAt\(kn\)\) \{ d\.handled = true; return; \}/);
  assert.match(pn, /const kn = knNameOfUrl\(d\.url\);\n\s+if \(kn && !loose\) \{/);
  const pk = src("web/v2/panes-knowledge.ts");
  assert.match(pk, /ctx\.paneRoot\(\)\.addEventListener\(KN_OPEN_EVT, onKnOpen\);/);
  assert.match(pk, /const pending = knPending\.get\(ctx\.paneRoot\(\)\);/);
});
t("W6 답 글 링크 우클릭 — 경로·파일 이름·지식 이름·링크 복사", () => {
  const cv = src("web/chat-view.ts");
  assert.match(cv, /registerCtx\('chat-link',/);
  for (const l of ["경로 복사", "파일 이름 복사", "지식 이름 복사", "링크 복사"]) assert.ok(cv.includes(`label: '${l}'`), l);
});

t("W7 늘 긋는 밑줄이 실패한 지식 확인을 0.25초마다 다시 묻지 않는다(실패 뒤 잠깐 쉼) · 글이 그대로면 다시 계산하지 않는다", () => {
  const tm = src("web/standalone/terminal.ts");
  assert.match(tm, /if \(v === undefined\) return Date\.now\(\) - \(knowledgeFailAt\.get\(n\) \|\| 0\) > KN_FAIL_REST;/);
  assert.match(tm, /if \(v === null\) \{ knowledgeKnown\.delete\(n\); knowledgeFailAt\.set\(n, Date\.now\(\)\);/);
  assert.match(tm, /if \(sig === linkUlSig\) return;/);
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
    const ui = location.href.replace(/[^/]*$/, "");
    d = box('<a href="' + ui + '#/k/terminal-path-link-4562">' + ui + '#/k/terminal-path-link-4562</a>');
    CL.linkifyChat(d, false); R.c8 = Array.from(d.querySelectorAll("a")).map((a) => ({ text: a.textContent, kn: a.getAttribute("data-kn"), ctx: a.getAttribute("data-ctx") }));
    d = box('<a href="#/f?root=shared&amp;path=project/12/out/picture.png">#/f?root=shared&amp;path=project/12/out/picture.png</a> · <a href="#/f?root=shared&amp;path=project/12/r.md">보고서</a>');
    CL.linkifyChat(d, false); R.c9 = Array.from(d.querySelectorAll("a")).map((a) => ({ text: a.textContent, path: a.getAttribute("data-path"), title: a.title }));
    d = box('보세요 /work/shared/project/12/데모 데이/발표 자료.html 그리고 <a href="https://example.com/x">https://example.com/x</a>');
    CL.linkifyChat(d, false); R.c10 = Array.from(d.querySelectorAll("a")).map((a) => ({ text: a.textContent, ctx: a.getAttribute("data-ctx"), title: a.title }));
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
  assert.ok(!R.fatal, R.fatal); if (process.env.DUMP) console.log(JSON.stringify({ c9: R.c9, c10: R.c10 }, null, 1));
  const enc = encodeURIComponent;

  t("C1 문장 속 프로젝트 경로 — 조사를 뗀 경로만 링크 · 보이는 글은 파일 이름 · href 는 자료 보기", () => {
    assert.deepEqual(R.c1.links, [{ text: "보고서.md", path: "/work/shared/project/12/보고서.md", href: "#/f?root=shared&path=" + enc("project/12/보고서.md"), role: null, inCode: false }]);
    assert.equal(R.c1.text, "파일은 보고서.md에 저장했습니다.");
  });
  t("C2 인라인 코드 속 경로도 링크(Claude 가 백틱으로 준 경로)", () => {
    assert.equal(R.c2.length, 1); assert.equal(R.c2[0].inCode, true); assert.equal(R.c2[0].path, "/Users/a/workspace/project/12/out/a.png");
  });
  t("C3 세션 폴더 경로는 세션 화면에서만 · href 없이 role=link", () => {
    assert.deepEqual(R.c3no, []);
    assert.deepEqual(R.c3yes, [{ text: "report.md", path: "docs/report.md", href: null, role: "link", inCode: false }]);
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
  t("C8 지식 주소 그대로인 링크 — 지식 이름만 보인다", () => {
    assert.deepEqual(R.c8, [{ text: "terminal-path-link-4562", kn: "terminal-path-link-4562", ctx: "chat-link" }]);
  });
  t("C9 자료 주소 링크 — 주소 그대로면 파일 이름만, 사람이 붙인 라벨은 그대로 · 둘 다 경로 링크", () => {
    assert.deepEqual(R.c9, [
      { text: "picture.png", path: "project/12/out/picture.png", title: "project/12/out/picture.png" },
      { text: "보고서", path: "project/12/r.md", title: "project/12/r.md" },
    ]);
  });
  t("C10 빈칸 든 폴더의 경로도 파일 이름만 · 모든 링크에 우클릭 표지와 실제 주소(title)", () => {
    assert.deepEqual(R.c10, [
      { text: "발표 자료.html", ctx: "chat-link", title: "/work/shared/project/12/데모 데이/발표 자료.html" },
      { text: "https://example.com/x", ctx: "chat-link", title: "https://example.com/x" },
    ]);
  });
  t("C7 윈도우 드라이브 경로 — 프로젝트 자료로", () => {
    assert.equal(R.c7.length, 1);
    assert.equal(R.c7[0].text, "보고서.md");
    assert.equal(R.c7[0].path, "C:\\Users\\a\\workspace\\project\\12\\보고서.md");
    assert.equal(R.c7[0].href, "#/f?root=shared&path=" + enc("project/12/보고서.md"));
  });
}
console.log(`chat-links: ${pass} passed${fail ? `, ${fail} failed` : ""}`);
if (fail) process.exit(1);
