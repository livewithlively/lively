// «주인 잃은 수집기» 규칙 잠금. DB·네트워크 불요.
//   실행: npm run build && node dist/org/credentials/collector-orphans.test.js
//  겨누는 고장(2026-10-29): 금고에서 키를 지워도 그 키로 돌던 수집기가 켜진 채 남아 외부 앱 연결이 «모으는 중» 이라 했다.
import assert from "node:assert/strict";
import { orphanedCollectors, holdsCredential, tokenSourceOfOwner, COLLECTOR_CREDENTIAL_LINKS } from "./collector-orphans.js";
import { orphanNote, memberCollectProbe } from "../../capabilities/connect-status.js";
import type { Capability } from "../../capabilities/types.js";
import type { LivelyUser } from "../../context.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

const col = (id: number, preset_key: string, token_source: string, enabled = true) => ({ id, preset_key, enabled, config: { token_source } });

await t("1 조테로 키를 지우면 그 사람의 조테로 수집기가 꺼질 대상이다", () => {
  assert.deepEqual(orphanedCollectors([col(1, "zotero", "member:wonjoon")], "zotero_token", "member:wonjoon", []), [1]);
});
await t("2 다른 사람의 수집기·다른 앱 수집기·이미 꺼진 수집기는 건드리지 않는다", () => {
  const cs = [col(1, "zotero", "member:other"), col(2, "figma", "member:wonjoon"), col(3, "zotero", "member:wonjoon", false)];
  assert.deepEqual(orphanedCollectors(cs, "zotero_token", "member:wonjoon", []), []);
});
await t("3 연결표의 모든 토큰 앱이 같은 규칙을 따른다(다른 앱에도 같은 일이 없게)", () => {
  const presets = new Set(COLLECTOR_CREDENTIAL_LINKS.flatMap((l) => l.presets));
  for (const p of ["figma", "clickup", "zotero", "github", "gitlab", "linear", "outlook", "slack", "gdrive", "gmail"]) assert.ok(presets.has(p), `연결표에 ${p} 없음`);
  for (const link of COLLECTOR_CREDENTIAL_LINKS) for (const kind of link.kinds) for (const preset of link.presets) {
    assert.deepEqual(orphanedCollectors([col(7, preset, "member:m")], kind, "member:m", []), [7], `${kind} → ${preset}`);
  }
});
await t("4 호스트가 둘인 깃랩 — 한 칸만 지우고 다른 칸이 남으면 끄지 않는다(anyScope)", () => {
  const remaining = [{ kind: "gitlab_pat", scope_key: "gitlab.example.com", has_secret: true }];
  assert.deepEqual(orphanedCollectors([col(1, "gitlab", "member:m")], "gitlab_pat", "member:m", remaining), []);
});
await t("5 scope 를 가리는 앱은 '' 칸만 연결로 본다 — 다른 scope 칸이 남아도 끈다", () => {
  const remaining = [{ kind: "zotero_token", scope_key: "x", has_secret: true }];
  assert.deepEqual(orphanedCollectors([col(1, "zotero", "member:m")], "zotero_token", "member:m", remaining), [1]);
});
await t("6 구글 — 통합 칸을 지워도 옛 서비스별 칸이 남아 있으면 끄지 않는다", () => {
  const remaining = [{ kind: "google_gmail_oauth", scope_key: "", has_secret: true }];
  assert.deepEqual(orphanedCollectors([col(1, "gmail", "member:m")], "google_oauth", "member:m", remaining), []);
});
await t("7 연결표에 없는 kind(예 aws_role_arn)는 아무것도 끄지 않는다", () => {
  assert.deepEqual(orphanedCollectors([col(1, "zotero", "member:m")], "aws_role_arn", "member:m", []), []);
});
await t("8 조직 칸(gateway)이 지워지면 token_source=org 수집기만 대상이다", () => {
  assert.equal(tokenSourceOfOwner("gateway"), "org");
  assert.equal(tokenSourceOfOwner("member:m"), "member:m");
  assert.deepEqual(orphanedCollectors([col(1, "clickup", "org"), col(2, "clickup", "member:m")], "clickup_token", "org", []), [1]);
});
await t("9 값이 빈 칸(has_secret=false)은 연결로 보지 않는다", () => {
  const link = COLLECTOR_CREDENTIAL_LINKS.find((l) => l.presets.includes("figma"))!;
  assert.equal(holdsCredential([{ kind: "figma_token", scope_key: "", has_secret: false }], link), false);
  assert.equal(holdsCredential([{ kind: "figma_token", scope_key: "", has_secret: true }], link), true);
});

//  상태 — 앱의 상태 도구(org_<앱>_collect)를 가짜로 세워 probe 가 내는 collecting 을 본다.
let calls = 0;
const fakeCaps = (state: Record<string, unknown>): Capability[] => [{
  name: "org_zotero_collect", title: "", description: "", scope: "memory", input: {},
  handler: async () => { calls++; return state; },
} as unknown as Capability];
const me = { userId: "wonjoon" } as LivelyUser;

await t("10 켜져 있는데 켠 사람의 키가 없으면 «모으는 중» 이 아니고 안내가 붙는다", async () => {
  const before = calls;
  const p = await memberCollectProbe(fakeCaps({ enabled: true, member: "wonjoon", member_connected: false, me_connected: false }), "zotero")(me);
  assert.equal(calls, before + 1, "상태 도구가 실제로 불려야 한다");
  assert.equal(p.collecting, false);
  assert.ok(p.note);
});
await t("11 token_source 가 사람이 아니면(member_connected=null) 종전대로 모으는 중", async () => {
  const p = await memberCollectProbe(fakeCaps({ enabled: true, member: null, member_connected: null, me_connected: false }), "zotero")(me);
  assert.equal(p.collecting, true);
});
await t("12 켜져 있고 키도 있으면 모으는 중", async () => {
  const p = await memberCollectProbe(fakeCaps({ enabled: true, member: "wonjoon", member_connected: true, me_connected: true }), "zotero")(me);
  assert.equal(p.collecting, true);
  assert.equal(p.note, null);
});
await t("13 안내 — 내 것이면 «다시 연결», 남의 것이면 그 사람을 말한다", () => {
  assert.match(orphanNote("wonjoon", "wonjoon"), /다시 연결하면/);
  assert.match(orphanNote("other", "wonjoon"), /other/);
});

console.log(`\n${pass} passed`);
