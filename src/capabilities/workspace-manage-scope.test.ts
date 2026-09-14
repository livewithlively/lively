// 워크스페이스 관리는 구성원이, 인원 관리는 관리자가 (#3872, 대표 결정 2026-09-12)
//
//  지시: *"팀 워크스페이스에서 관리자만 가능하도록 워크스페이스 관리하는데에 있어서 특정 기능을 제한할
//   필요는 없어(단, 워크스페이스 내 사람 초대 내보내기 등 인원관리 제외)."*
//
//  판정 재료는 **표면 스냅샷**(registry 전 op 의 이름·scope)이다 — 제품 코드를 다시 읽지 않고 계약만 본다.
//  ⚠ 이 검사가 지키는 것은 두 방향이다: 열어야 할 것이 열렸나 **그리고** 닫아야 할 것이 닫혔나.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SNAP = JSON.parse(readFileSync(
  new URL("./surface-snapshot.json", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8")) as
  Array<{ name: string; scope: string | null }>;
const scopeOf = (name: string): string | null | undefined => SNAP.find((o) => o.name === name)?.scope;

// 워크스페이스를 «어떻게 굴릴까» — 구성원이 한다.
const MEMBER_OPS = [
  "org_collector_upsert", "org_collector_sync_run", "org_connector_upsert",
  "org_slack_collect_set", "org_notion_collect_set", "org_google_collect_set",
  "org_github_collect_set", "org_clickup_collect_set", "org_figma_collect_set", "org_linear_collect_set", "org_gitlab_collect_set",
  "org_mcp_upsert", "org_app_tools_set_write", "org_app_set_enabled",
  "cron_set", "feed_target_create", "org_alert_set", "org_ingest_policy_upsert",
  "org_update_section", "org_update_profile", "org_embeddings_backfill",
];
// 사람을 들이고 빼고 권한을 바꾸는 것 — 관리자만.
const ADMIN_OPS = [
  "org_member_upsert", "org_member_remove", "org_member_reset_password",
  "org_tokens", "org_token_mint", "org_token_revoke", "org_session_mint",
];
// 잘못 열면 보안·비용 사고가 나는 것 — 관리자만(이번 결정의 범위 밖).
const INFRA_OPS = [
  "org_credentials", "org_credential_set", "org_db_source_upsert", "org_db_sources",
  "org_runtime_update", "org_audit_list", "vis_axis_set", "org_app_install", "stack_profile_set",
  "org_git_credential_set", "org_oauth_client_upsert", "managed_session_set",
];

test("① 워크스페이스 관리 op 은 구성원 권한(memory)이다", () => {
  for (const n of MEMBER_OPS) {
    assert.notEqual(scopeOf(n), undefined, `${n} 이 표면에 없다 — 이름이 바뀌었으면 이 표를 고쳐라`);
    assert.equal(scopeOf(n), "memory", `${n} 이 아직 구성원에게 안 열렸다`);
  }
});

test("② 인원 관리 op 은 관리자(admin)로 남는다", () => {
  for (const n of ADMIN_OPS) assert.equal(scopeOf(n), "admin", `${n} 이 구성원에게 열렸다 — 인원 관리는 제외다`);
});

test("③ 인프라·위험 op 도 관리자로 남는다", () => {
  for (const n of INFRA_OPS) assert.equal(scopeOf(n), "admin", `${n} 이 구성원에게 열렸다 — 이번 결정의 범위 밖이다`);
});

test("④ 워크스페이스 초대·내보내기는 scope 가 아니라 owner 축으로 막힌다 (무회귀)", () => {
  //  이 넷은 원래부터 memory 이고, 게이트는 owner 판정이다(delivery/workspace-registry.ts).
  //  여기서 scope 만 보고 «열렸다» 고 오독하지 않도록 그 사실을 검사로 못박는다.
  for (const n of ["workspace_invite", "workspace_member_add", "workspace_member_remove", "workspace_invite_resolve"]) {
    assert.equal(scopeOf(n), "memory", `${n} 의 scope 가 바뀌었다 — owner 게이트 전제가 흔들린다`);
  }
  const src = readFileSync(
    new URL("./delivery/workspace-registry.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
  assert.match(src, /async function requireOwner\(/, "owner 게이트가 사라졌다");
  const inviteBlock = src.slice(src.indexOf('restWork("workspace_invite"'), src.indexOf('restWork("workspace_invite_resend"'));
  assert.match(inviteBlock, /requireOwner\(ws, id\)/, "셀프호스트 초대에서 owner 게이트가 빠졌다");
});
