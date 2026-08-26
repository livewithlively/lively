// 피그마 토큰 출처 해소 순수 단위 (#1881 F5) — 금고 리더를 주입해 DB 없이 표의 행을 전부 돈다.
// 실행: npm run build && node dist/org/credentials/figma-token-source.test.js
//
//  왜 warning 을 검사하나: 토큰 해소가 조용히 실패하면 수집기는 "토큰 없음"으로 죽는데 **왜** 죽었는지가
//  화면에 안 남는다(슬랙에서 실제로 겪은 실패 모드). 그래서 모든 실패 경로가 문장을 만드는지 본다.
import assert from "node:assert/strict";
import { resolveFigmaTokenSource, type FigmaVaultReader } from "./figma-token-source.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

const vault = (rows: Array<{ owner: string; token: string | null }>): FigmaVaultReader => ({
  tokens: async () => rows,
});

await t("미지정 → null(종전 경로: 수집기 폼에 붙여넣은 토큰을 쓴다)", async () => {
  assert.equal(await resolveFigmaTokenSource(undefined, vault([])), null);
  assert.equal(await resolveFigmaTokenSource("", vault([])), null);
  assert.equal(await resolveFigmaTokenSource("   ", vault([])), null);
});

await t("org → gateway 소유 토큰", async () => {
  const r = await resolveFigmaTokenSource("org", vault([
    { owner: "member:yoon", token: "figd_member" },
    { owner: "gateway", token: "figd_org" },
  ]));
  assert.equal(r?.token, "figd_org");
  assert.equal(r?.warning, undefined);
});

await t("member:<id> → 그 사람의 토큰(남의 것을 쓰지 않는다)", async () => {
  const r = await resolveFigmaTokenSource("member:yoon", vault([
    { owner: "gateway", token: "figd_org" },
    { owner: "member:yoon", token: "figd_yoon" },
    { owner: "member:jang", token: "figd_jang" },
  ]));
  assert.equal(r?.token, "figd_yoon");
});

await t("알 수 없는 출처 → 토큰 없이 warning(형식을 알려 준다)", async () => {
  const r = await resolveFigmaTokenSource("workspace:1", vault([{ owner: "gateway", token: "t" }]));
  assert.equal(r?.token, undefined);
  assert.match(String(r?.warning), /org 또는 member:/);
});

await t("member: 뒤가 비면 알 수 없는 출처로 본다", async () => {
  const r = await resolveFigmaTokenSource("member:", vault([{ owner: "gateway", token: "t" }]));
  assert.equal(r?.token, undefined);
  assert.ok(r?.warning);
});

await t("해당 소유자의 행이 없으면 warning — 어디서 등록하는지까지 말한다", async () => {
  const org = await resolveFigmaTokenSource("org", vault([{ owner: "member:yoon", token: "t" }]));
  assert.equal(org?.token, undefined);
  assert.match(String(org?.warning), /자격 금고|figma_token/);
  const mem = await resolveFigmaTokenSource("member:nobody", vault([{ owner: "gateway", token: "t" }]));
  assert.equal(mem?.token, undefined);
  assert.match(String(mem?.warning), /Figma/);
});

await t("행은 있는데 토큰을 못 읽으면(복호화 실패 등) 조용히 넘어가지 않는다", async () => {
  const r = await resolveFigmaTokenSource("org", vault([{ owner: "gateway", token: null }]));
  assert.equal(r?.token, undefined);
  assert.match(String(r?.warning), /읽지 못했습니다/);
});

console.log(`\nfigma token-source tests: ${pass} passed`);
