import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { filesCspSourceFor, declaresAppFolder, FILE_URL_PATH } from "./app-screen-csp.js";
import { appPageCsp, appPageCspMulti } from "../apps/app-front-page.js";
import { parseAppManifest, FILE_URL_TOOL } from "../apps/manifest.js";

// 앱 화면 CSP 의 서명 주소 자리(#4673) — 사양 표 H1~H5 · 매니페스트 I1~I3.
const FILES = "https://lively-46e3.app.lvly.io/api/files/s/";
const directive = (csp: string, name: string): string => csp.split("; ").find((d) => d.startsWith(name + " ")) ?? "";

test("H1 files 가 있으면 connect · img · media 에 붙고 font 에는 없다(앱 주소 v1 · 여러 파일)", () => {
  for (const build of [appPageCsp, appPageCspMulti]) {
    const csp = build({ connect_domains: ["api.example.com"], files: FILES });
    assert.ok(directive(csp, "connect-src").split(" ").includes(FILES), `${build.name} connect`);
    assert.ok(directive(csp, "img-src").split(" ").includes(FILES), `${build.name} img`);
    assert.ok(directive(csp, "media-src").split(" ").includes(FILES), `${build.name} media`);
    assert.ok(!directive(csp, "font-src").includes(FILES), `${build.name} font`);
    assert.ok(!directive(csp, "script-src").includes(FILES), `${build.name} script — 서명 주소에서 스크립트를 싣게 하면 안 된다`);
    assert.ok(directive(csp, "connect-src").includes("https://api.example.com"), "선언한 연결은 그대로");
  }
});

test("H2 files 모양이 아니면 버린다 — ; · 다른 경로 · 공백", () => {
  for (const evil of ["https://x.io/api/files/s/; script-src *", "https://x.io/api/ui/", "https://x.io/api/files/s/ https://evil.io", "javascript:alert(1)//api/files/s/"]) {
    const csp = appPageCsp({ files: evil });
    assert.ok(!csp.includes("evil.io") && !csp.includes("script-src *") && !csp.includes("/api/ui/") && !csp.includes("javascript:"), evil);
  }
});

test("H3 files 가 없으면 종전과 같은 문자열", () => {
  assert.equal(appPageCsp({ connect_domains: ["a.io"] }), appPageCsp({ connect_domains: ["a.io"], files: null }));
  assert.equal(directive(appPageCsp({}), "connect-src"), "connect-src 'self'");
  assert.equal(directive(appPageCsp({}), "media-src"), "media-src 'none'");
});

test("H4 'none' 이던 지시문은 그 자리로 바뀐다(media) · srcdoc 빌더도 같은 규칙", () => {
  assert.equal(directive(appPageCsp({ files: FILES }), "media-src"), "media-src " + FILES);
  const web = readFileSync("web/v2/app-ui.ts", "utf8");
  for (const d of ["img-src", "media-src", "connect-src"]) {
    assert.match(web, new RegExp(`'${d} ' \\+ withFiles\\(`), `srcdoc CSP 의 ${d} 에 서명 주소 자리가 없다`);
  }
  assert.match(web, /return list === "'none'" \? files : list \+ ' ' \+ files;/);
});

test("H5 출처 식 — 선언 + 주소 · 선언 없음 · 주소 모양 아님", () => {
  const m = { permissions: { app_folder: true } };
  assert.equal(filesCspSourceFor(m, "https://lively-46e3.app.lvly.io"), "https://lively-46e3.app.lvly.io" + FILE_URL_PATH);
  assert.equal(filesCspSourceFor({ permissions: { app_folder: false } }, "https://w.io"), null);
  assert.equal(filesCspSourceFor({}, "https://w.io"), null);
  assert.equal(filesCspSourceFor(m, null), null);
  assert.equal(filesCspSourceFor(m, "https://w.io/x"), null, "경로가 붙은 주소는 게이트웨이 주소가 아니다");
  assert.equal(declaresAppFolder({ permissions: { app_folder: "yes" } }), false);
});

const base = { id: "crm", title: "CRM", version: "1.0.0" };
test("I1 app_folder:true 는 file_url 도구를 함의한다", () => {
  const m = parseAppManifest({ ...base, permissions: { app_folder: true } });
  assert.equal(m.permissions.app_folder, true);
  assert.ok(m.permissions.tools.includes(FILE_URL_TOOL));
  assert.equal(FILE_URL_TOOL, "file_url");
});
test("I2 선언이 없으면 기본 false · 도구도 없다", () => {
  const m = parseAppManifest({ ...base });
  assert.equal(m.permissions.app_folder, false);
  assert.ok(!m.permissions.tools.includes(FILE_URL_TOOL));
});
test("I3 불리언이 아니면 400", () => {
  assert.throws(() => parseAppManifest({ ...base, permissions: { app_folder: "yes" } }), (e: { status?: number; message?: string }) => e.status === 400 && /app_folder/.test(String(e.message)));
});
