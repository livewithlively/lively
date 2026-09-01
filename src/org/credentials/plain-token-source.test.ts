// 평문 토큰 출처 해소 순수 단위(#2247) — 금고 리더를 주입해 DB 없이 표의 행을 전부 돈다.
// 실행: npm run build && node dist/org/credentials/plain-token-source.test.js
import assert from "node:assert/strict";
import { resolvePlainTokenSource, CLICKUP_TOKEN_SPEC, type PlainVaultReader } from "./plain-token-source.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const vault = (rows: Array<{ owner: string; token: string | null }>): PlainVaultReader => ({ tokens: async () => rows });
const S = CLICKUP_TOKEN_SPEC;

await t("미지정 → null(종전 경로: 수집기 폼에 붙여넣은 토큰)", async () => {
  assert.equal(await resolvePlainTokenSource(undefined, vault([]), S), null);
  assert.equal(await resolvePlainTokenSource("  ", vault([]), S), null);
});
await t("member:<id> → 그 사람의 토큰만(남의 것·조직 것을 쓰지 않는다)", async () => {
  const r = await resolvePlainTokenSource("member:yoon", vault([
    { owner: "gateway", token: "pk_org" }, { owner: "member:jang", token: "pk_jang" }, { owner: "member:yoon", token: "pk_yoon" },
  ]), S);
  assert.equal(r?.token, "pk_yoon"); assert.equal(r?.warning, undefined);
});
await t("org → gateway 소유", async () => {
  const r = await resolvePlainTokenSource("org", vault([{ owner: "member:yoon", token: "pk_yoon" }, { owner: "gateway", token: "pk_org" }]), S);
  assert.equal(r?.token, "pk_org");
});
await t("그 사람 토큰이 없으면 토큰 없이 warning — 문장에 앱 이름과 저장 화면이 들어간다", async () => {
  const r = await resolvePlainTokenSource("member:yoon", vault([{ owner: "member:jang", token: "pk_jang" }]), S);
  assert.equal(r?.token, undefined);
  assert.match(String(r?.warning), /ClickUp/); assert.match(String(r?.warning), /외부 앱 연결/);
});
await t("복호화 실패(null) → warning(옛 값으로 조용히 계속 긁지 않는다)", async () => {
  const r = await resolvePlainTokenSource("member:yoon", vault([{ owner: "member:yoon", token: null }]), S);
  assert.equal(r?.token, undefined); assert.match(String(r?.warning), /읽지 못했습니다/);
});
await t("알 수 없는 출처 → 형식을 알려 주는 warning", async () => {
  const r = await resolvePlainTokenSource("team:x", vault([]), S);
  assert.match(String(r?.warning), /member:<구성원 id>/);
});
console.log(`\n${pass} passed`);
