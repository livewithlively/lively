// GitHub 토큰 출처 해소 순수 단위(#2247) — 금고·갱신 부품을 주입해 DB·네트워크 없이 돈다.
import assert from "node:assert/strict";
import { pickGithubSlot, resolveGithubTokenSource, type GithubVaultDeps } from "./github-token-source.js";
import type { MemberSecretPublic, MemberSecretResolved } from "./member-secret-store.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const row = (scope_key: string, kind = "github_pat", has_secret = true): MemberSecretPublic =>
  ({ owner: "member:yoon", kind, scope_key, has_secret, meta: {}, label: null, created_at: null, updated_at: null, updated_by: null, last_used_at: null });

await t("슬롯 선택 — 호스트 일치(정적 PAT) > 빈 scope_key(OAuth 묶음) > 첫 것; 다른 kind·빈 슬롯은 안 본다", () => {
  assert.equal(pickGithubSlot([row("", "gitlab_pat"), row("GitHub.com"), row("")], "github.com")?.scope_key, "GitHub.com");
  assert.equal(pickGithubSlot([row("ghe.corp"), row("")], "github.com")?.scope_key, "");
  assert.equal(pickGithubSlot([row("ghe.corp")], "github.com")?.scope_key, "ghe.corp");
  assert.equal(pickGithubSlot([row("", "github_pat", false)], "github.com"), null);
});
await t("member:<id> → 그 사람 슬롯을 resolve 하고 bearer(묶음/정적·만료 갱신)가 준 값을 쓴다", async () => {
  const calls: string[] = [];
  const deps: GithubVaultDeps = {
    list: async (owner) => { calls.push(`list:${owner}`); return [row("")]; },
    resolve: async (m, sk, fb) => { calls.push(`resolve:${m}:${sk}:${fb}`); return { secret: '{"access_token":"gho_x"}', meta: {} } as unknown as MemberSecretResolved; },
    bearer: async () => { calls.push("bearer"); return "gho_fresh"; },
  };
  const r = await resolveGithubTokenSource("member:yoon", "github.com", deps);
  assert.equal(r?.token, "gho_fresh");
  assert.deepEqual(calls, ["list:member:yoon", "resolve:yoon::false", "bearer"]);
});
await t("연결이 없으면 토큰 없이 warning(저장 화면을 말한다) · 갱신 실패도 warning(옛 토큰으로 계속 긁지 않는다)", async () => {
  const none: GithubVaultDeps = { list: async () => [], resolve: async () => null, bearer: async () => "" };
  const r1 = await resolveGithubTokenSource("member:yoon", "github.com", none);
  assert.equal(r1?.token, undefined); assert.match(String(r1?.warning), /외부 앱 연결/);
  const fail: GithubVaultDeps = { list: async () => [row("")], resolve: async () => ({ secret: "x", meta: {} } as unknown as MemberSecretResolved), bearer: async () => { throw new Error("refresh 401"); } };
  const r2 = await resolveGithubTokenSource("member:yoon", "github.com", fail);
  assert.equal(r2?.token, undefined); assert.match(String(r2?.warning), /갱신에 실패/);
});
await t("미지정 → null · 알 수 없는 출처 → 형식 안내", async () => {
  const none: GithubVaultDeps = { list: async () => [], resolve: async () => null, bearer: async () => "" };
  assert.equal(await resolveGithubTokenSource("", "github.com", none), null);
  assert.match(String((await resolveGithubTokenSource("team:1", "github.com", none))?.warning), /member:<구성원 id>/);
});
console.log(`\n${pass} passed`);
