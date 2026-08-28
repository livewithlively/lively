import assert from "node:assert/strict";
import { pickGitlabSlot, resolveGitlabTokenSource, type GitlabVaultDeps } from "./gitlab-token-source.js";
import type { MemberSecretPublic } from "./member-secret-store.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const row = (scope_key: string, kind = "gitlab_pat", has_secret = true): MemberSecretPublic =>
  ({ owner: "member:yoon", kind, scope_key, has_secret, meta: {}, label: null, created_at: null, updated_at: null, updated_by: null, last_used_at: null });

await t("슬롯 — 수집기 host 와 맞는 것 > '' > 첫 것; github_pat 은 안 본다", () => {
  assert.equal(pickGitlabSlot([row("gitlab.com"), row("Git.Corp.com")], "git.corp.com")?.scope_key, "Git.Corp.com");
  assert.equal(pickGitlabSlot([row("gitlab.com"), row("")], "other.host")?.scope_key, "");
  assert.equal(pickGitlabSlot([row("", "github_pat"), row("gitlab.com")], undefined)?.scope_key, "gitlab.com");
  assert.equal(pickGitlabSlot([], "gitlab.com"), null);
});
await t("host 가 비면 슬롯의 호스트가 수집기 host 가 된다(회사 GitLab 을 두 번 적지 않는다)", async () => {
  const deps: GitlabVaultDeps = { list: async () => [row("Git.Corp.com")], secret: async () => "glpat-x", bearer: async (s) => s };
  const r = await resolveGitlabTokenSource("member:yoon", "", deps);
  assert.equal(r?.token, "glpat-x"); assert.equal(r?.host, "git.corp.com");
});
await t("토큰이 없으면 warning 에 저장 화면·read_api 를 말한다", async () => {
  const deps: GitlabVaultDeps = { list: async () => [], secret: async () => null, bearer: async (s) => s };
  const r = await resolveGitlabTokenSource("member:yoon", "gitlab.com", deps);
  assert.equal(r?.token, undefined); assert.match(String(r?.warning), /read_api/);
});
await t("미지정 → null", async () => {
  assert.equal(await resolveGitlabTokenSource(undefined, "gitlab.com", { list: async () => [], secret: async () => null, bearer: async (s) => s }), null);
});
console.log(`\n${pass} passed`);
