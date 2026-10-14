// 앱 주소의 앱 문서 조립(#4480 v2-1) — 사양 표 D. 실행: npm run build && node dist/apps/app-front-page.test.js
//  이게 틀리면: 앱 주소에서 뜬 v1 앱이 SDK(window.lively) 없이 떠 아무것도 못 하거나, 같은 주소의 /_lively/me 를 못 부르거나(connect 'self'),
//   매니페스트의 이상한 도메인이 CSP 헤더에 지시문을 끼워 넣거나, 탐침이 검토하지 않는 앱에도 들어간다.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { appErrorHtml, appPageCsp, buildAppPageHtml, loadAppScripts } from "./app-front-page.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };
const directives = (csp: string): Map<string, string> => new Map(csp.split(";").map((d) => d.trim()).filter(Boolean).map((d) => { const i = d.indexOf(" "); return [d.slice(0, i), d.slice(i + 1)] as [string, string]; }));

// ── D1 선언 없음 — 네트워크는 같은 주소만, 이미지·글꼴은 data: 만 ──
{
  const d = directives(appPageCsp(null));
  assert.equal(d.get("default-src"), "'none'");
  assert.equal(d.get("script-src"), "'unsafe-inline'", "외부 스크립트 없음");
  assert.equal(d.get("connect-src"), "'self'", "같은 주소(/_lively/me)는 늘 된다");
  assert.equal(d.get("img-src"), "data:");
  assert.equal(d.get("font-src"), "data:");
  assert.equal(d.get("media-src"), "'none'");
  assert.equal(d.get("frame-src"), "'none'");
  assert.equal(d.get("form-action"), "'none'");
  assert.equal(d.get("base-uri"), "'none'");
  ok("D1 선언 없음 — connect 'self' · data: · 나머지 none");
}

// ── D2 선언 도메인 · * · 이상한 값 버림 ──
{
  const d = directives(appPageCsp({ connect_domains: ["api.example.com", "Bad Domain", "x.com; script-src *"], resource_domains: ["*.cdn.example.com"], frame_domains: ["*"] }));
  assert.equal(d.get("connect-src"), "'self' https://api.example.com", "이상한 값은 버린다(지시문이 늘지 않는다)");
  assert.equal(d.get("img-src"), "data: https://*.cdn.example.com");
  assert.equal(d.get("media-src"), "https://*.cdn.example.com");
  assert.equal(d.get("frame-src"), "https:", "* 는 https: 전체");
  assert.equal(d.get("script-src"), "'unsafe-inline'", "어떤 선언으로도 스크립트는 안 넓어진다");
  assert.equal(appPageCsp({ connect_domains: ["x.com; script-src *"] }).split(";").length, 10, "지시문 수가 그대로");
  ok("D2 선언 도메인 · * · 이상한 값 버림");
}

// ── D3 HTML 조립 — doctype 뒤 · 없으면 맨 앞 · 탐침은 줄 때만 · </script 끊기 ──
{
  const rt = "window.lively={}";
  const a = buildAppPageHtml("<!DOCTYPE html><html><body>x</body></html>", { runtime: rt });
  assert.ok(a.startsWith("<!DOCTYPE html><script>window.lively={}</script><html>"), a.slice(0, 80));
  const b = buildAppPageHtml("<div>x</div>", { runtime: rt, probe: "PROBE()" });
  assert.equal(b, "<script>window.lively={}</script><script>PROBE()</script><div>x</div>");
  const c = buildAppPageHtml("<div>x</div>", { runtime: rt, probe: null });
  assert.ok(!c.includes("PROBE"), "탐침이 없으면 안 넣는다");
  const d = buildAppPageHtml("<p>", { runtime: "var s='</script><img src=x onerror=alert(1)>'" });
  assert.equal((d.match(/<\/script>/g) || []).length, 1, "넣는 스크립트 안의 </script 는 끊는다(닫는 태그는 우리 것 하나)");
  ok("D3 HTML — 자리 · 탐침 · </script 끊기");
}

// ── D4 오류 문서 — 이스케이프 ──
{
  const h = appErrorHtml("<b>제목</b>", `"a" & 'b' <script>`);
  assert.ok(!h.includes("<b>제목</b>") && h.includes("&lt;b&gt;제목&lt;/b&gt;"));
  assert.ok(h.includes("&quot;a&quot; &amp; &#39;b&#39; &lt;script&gt;"));
  ok("D4 오류 문서 — 이스케이프");
}

// ── D5 준비물 읽기 — 두 원본을 읽고 · 틀리면 실패 · 실패를 굳히지 않는다 ──
{
  const dir = mkdtempSync(join(tmpdir(), "app-front-page-"));
  try {
    mkdirSync(join(dir, "v2"), { recursive: true });
    mkdirSync(join(dir, "lib"), { recursive: true });
    const base = pathToFileURL(dir + "/");
    // 먼저 틀린 런타임(window.lively 없음) — 실패해야 한다
    writeFileSync(join(dir, "v2", "app-ui-runtime.js"), "export const APP_RUNTIME_JS = 'nope';\n");
    writeFileSync(join(dir, "lib", "studio-flow.js"), "export const PROBE_JS = 'probe()';\n");
    await assert.rejects(loadAppScripts(base), "런타임에 window.lively 가 없으면 실패");
    // 고친 뒤(새 파일 이름 — ESM 은 같은 URL 을 다시 읽지 않는다) 다음 호출은 다시 시도해 성공해야 한다(실패를 굳히지 않는다)
    const dir2 = join(dir, "next");
    mkdirSync(join(dir2, "v2"), { recursive: true });
    mkdirSync(join(dir2, "lib"), { recursive: true });
    writeFileSync(join(dir2, "v2", "app-ui-runtime.js"), "export const APP_RUNTIME_JS = '(function(){ window.lively = {}; })()';\n");
    writeFileSync(join(dir2, "lib", "studio-flow.js"), "export const PROBE_JS = 'probe()';\n");
    const s = await loadAppScripts(pathToFileURL(dir2 + "/"));
    assert.equal(s.probe, "probe()");
    assert.ok(s.runtime.includes("window.lively"));
    ok("D5 준비물 — 틀리면 실패 · 다음 호출에 다시 읽어 성공");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(`\n${pass} passed`);
