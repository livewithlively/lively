// http_proxy 도구 프리셋 검증 (#1655). 사양 = spec-1655 '도구 프리셋'.
//
//  이 테스트가 막는 것: 프리셋은 **손으로 쓴 데이터**라 오타가 조용히 프로덕션까지 간다. 특히 두 가지는
//  저장 시엔 아무 문제가 없다가 **호출 때마다** 죽는다:
//   ① 경로 자리표시 키가 input_schema 에 없거나 required 가 아님 → 매 호출 "경로 인자가 필요합니다"
//   ② url 호스트가 묶음 hosts 에 없음 → url_allowlist(deny-all 기본)에 못 올라가 전부 차단
//  그래서 '전 프리셋을 순회하며 자기검증을 태운다'가 이 파일의 본체다.
import assert from "node:assert/strict";
import {
  HTTP_TOOL_PRESETS, assertHttpToolPreset, httpToolPresetToInput, httpToolPresetHosts,
  type HttpToolPresetGroup, type HttpToolPreset,
} from "./http-tool-presets.js";
import { urlTemplateKeys, buildProxyRequest } from "../../mcp/dynamic-tools.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const all: Array<[HttpToolPresetGroup, HttpToolPreset]> = HTTP_TOOL_PRESETS.flatMap((g) => g.tools.map((x) => [g, x] as [HttpToolPresetGroup, HttpToolPreset]));

t("프리셋이 비어 있지 않다(배선 단언 — 비면 아래 순회가 통째로 vacuous)", () => {
  assert.ok(all.length >= 8, `도구가 너무 적다(${all.length})`);
  assert.deepEqual(HTTP_TOOL_PRESETS.map((g) => g.key).sort(), ["google-calendar", "google-drive", "google-gmail"]);
});

t("전 프리셋이 자기검증을 통과한다(스키마 위생·scope·https·호스트·경로 인자)", () => {
  for (const [g, tool] of all) assertHttpToolPreset(g, tool);
});

t("도구 이름이 조직 안에서 유일하다", () => {
  const names = all.map(([, x]) => x.name);
  assert.equal(new Set(names).size, names.length, `이름 중복: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
});

t("A 어댑터가 만드는 이름과 겹치지 않는다 — 전환기에 공존해야 한다", () => {
  // mcp-proxy 는 ext__<서버>__<툴> 로 등록한다. 그 네임스페이스를 쓰면 같은 이름이 두 번 등록될 수 있다.
  for (const [, tool] of all) assert.ok(!tool.name.startsWith("ext__"), `${tool.name} 이 프록시 네임스페이스를 침범한다`);
});

t("금고 슬롯이 A 어댑터와 같다 — 이미 연결한 멤버는 재로그인이 필요 없다", () => {
  const kinds = HTTP_TOOL_PRESETS.map((g) => g.auth_kind).sort();
  assert.deepEqual(kinds, ["google_calendar_oauth", "google_drive_oauth", "google_gmail_oauth"]);
  for (const [g] of all) assert.equal(httpToolPresetToInput(g, g.tools[0]).auth_scope_key, "", "scope_key 가 다르면 다른 금고 행을 본다");
});

t("메일·드라이브는 PII 스크럽이 켜져 있다", () => {
  for (const [g, tool] of all) {
    if (g.key === "google-drive" || g.key === "google-gmail") {
      assert.equal(tool.pii_scrub, true, `${tool.name} 의 pii_scrub 가 꺼져 있다 — 메일·드라이브는 PII 덩어리다`);
    }
  }
});

t("전부 읽기 등급(L0)이고 호출 가능 scope 다", () => {
  for (const g of HTTP_TOOL_PRESETS) {
    assert.equal(g.level, "L0", `${g.key} 가 읽기 등급이 아니다`);
    assert.equal(g.scope, "items");
  }
});

t("인자 값은 감사로그에 남기지 않는다(#1082)", () => {
  for (const [g, tool] of all) assert.equal(httpToolPresetToInput(g, tool).log_args, false, `${tool.name} 이 인자 값을 남긴다`);
});

t("응답 크기 방어 — 목록 계열은 개수 상한이나 필드 제한을 URL 에 박아 둔다", () => {
  // 256KiB 상한이라 기본값 없이 내보내면 첫 호출부터 잘린다. input_schema 의 default 는 아무도 안 읽으므로 URL 에 있어야 한다.
  for (const [, tool] of all) {
    const q = new URL(tool.url.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, "x")).searchParams;
    const listish = /search|list|events/.test(tool.name);
    if (listish) {
      assert.ok(q.has("pageSize") || q.has("maxResults") || q.has("fields"), `${tool.name} 에 개수·필드 상한이 없다`);
    }
  }
});

t("경로 자리표시가 있는 도구는 실제로 조립된다 — 인자를 주면 그 자리가 채워진다", () => {
  for (const [, tool] of all) {
    const keys = urlTemplateKeys(tool.url);
    if (keys.length === 0) continue;
    const args = Object.fromEntries(keys.map((k) => [k, "ID-1"]));
    const { url } = buildProxyRequest(tool.url, tool.method ?? "GET", args);
    assert.ok(url.pathname.includes("ID-1"), `${tool.name}: 경로가 안 채워졌다(${url.pathname})`);
    assert.ok(!url.pathname.includes("{"), `${tool.name}: 자리표시가 남았다(${url.pathname})`);
    for (const k of keys) assert.equal(url.searchParams.get(k), null, `${tool.name}: 경로 키 ${k} 가 query 에도 실렸다`);
  }
});

t("URL 기본값은 인자가 덮어쓴다 — 안 주면 기본값이 산다", () => {
  const search = HTTP_TOOL_PRESETS.find((g) => g.key === "google-drive")!.tools.find((x) => x.name === "google_drive_search")!;
  assert.equal(buildProxyRequest(search.url, "GET", {}).url.searchParams.get("pageSize"), "20", "기본값이 사라졌다");
  assert.equal(buildProxyRequest(search.url, "GET", { pageSize: 3 }).url.searchParams.get("pageSize"), "3", "인자가 기본값을 못 덮었다");
});

t("허용 호스트 목록 — 이게 url_allowlist 에 들어가야 도구가 동작한다", () => {
  assert.deepEqual(httpToolPresetHosts(), ["gmail.googleapis.com", "www.googleapis.com"]);
});

t("자기검증이 실제로 잡는다 — 경로 인자가 required 가 아니면 거부", () => {
  const g = HTTP_TOOL_PRESETS[0];
  assert.throws(() => assertHttpToolPreset(g, {
    name: "x", title: "x", description: "x", pii_scrub: true,
    url: "https://www.googleapis.com/drive/v3/files/{fileId}",
    input_schema: { type: "object", properties: { fileId: { type: "string" } }, required: [] },
  }));
  assert.throws(() => assertHttpToolPreset(g, {
    name: "x", title: "x", description: "x", pii_scrub: true,
    url: "https://evil.example.com/x", input_schema: { type: "object", properties: {} },
  }), "묶음 hosts 밖 호스트를 통과시켰다");
  assert.throws(() => assertHttpToolPreset(g, {
    name: "x", title: "x", description: "x", pii_scrub: true,
    url: "http://www.googleapis.com/x", input_schema: { type: "object", properties: {} },
  }), "http 를 통과시켰다");
});

console.log(`\nhttp-tool-presets: ${pass} passed`);
