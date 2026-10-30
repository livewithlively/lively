// 순수 단위 체크(node:assert) — 리브가 자격을 받는 자리의 안전 경계(#1631).
//
// 이 파일이 지키는 것은 **"리브가 아무 데나 겨눌 수 없다"** 와 **"끝난 일을 다시 묻지 않는다"** 둘이다.
//  값 자체는 여기를 지나가지 않으므로 테스트에도 값이 없다 — 대상과 상태만 잰다.
//
// 사양 엣지표(행마다 시나리오 1개 이상):
//  | #  | 상태                                          | 기대                                    |
//  |----|-----------------------------------------------|-----------------------------------------|
//  | 1  | 시크릿 필드 + 마스터키 있음                     | 허용                                    |
//  | 2  | 수집기가 없음(null/undefined)                  | no-collector                            |
//  | 3  | 그 수집기에 없는 필드                           | not-a-secret-field                      |
//  | 4  | 있지만 **시크릿이 아닌** 필드(설정 칸)           | not-a-secret-field                      |
//  | 5  | secret 플래그가 아예 없는 필드                   | not-a-secret-field (undefined 를 참으로 읽지 않는다) |
//  | 6  | 마스터키 미설정                                 | no-master-key                           |
//  | 7  | fields 가 비었음(프리셋 조회 실패 등)            | not-a-secret-field                      |
//  | 8  | 요청 없음(null)                                 | 안 띄운다                                |
//  | 9  | 요청 있고 아직 안 채워짐                         | 띄운다                                  |
//  | 10 | 요청 있는데 이미 채워짐                          | 안 띄운다(다른 경로로 들어왔다)           |
//  | 11 | 요청이 가리키는 수집기가 사라짐                   | 안 띄운다                                |
//  | 12 | 수집기 여러 개 중 **다른 것**이 채워짐            | 여전히 띄운다(id 로 정확히 고른다)        |
//  | 13 | secretsSet 자체가 없음                          | 띄운다(미설정으로 읽는다)                 |
//
// 개인 금고 대상(vault_kind·vault_scope) — 사람이 자기 자격(봇 토큰 등)을 넣을 때도 값이 대화를 거치지 않게.
//  | V1 | 수집기·금고 대상을 둘 다 / 둘 다 없이           | both / none (400)                        |
//  | V2 | 금고 kind 형식·scope 형식 위반                  | bad-kind / bad-scope (400)               |
//  | V3 | 관리자 전용 kind(aws_role_arn — 대소문자·공백 무관) | admin-only (403)                     |
//  | V4 | 형식 맞고 마스터키 없음                          | no-master-key (409)                      |
//  | V5 | 형식 맞고 마스터키 있음                          | 허용 — kind 는 소문자·trim, scope 는 trim |
//  | V6 | 저장된 요청 → 넣을 자리                          | target 없는 옛 요청은 수집기 · vault 면 금고 |
//  | V7 | put 에 브라우저가 다른 대상을 실어 보냄            | 무시 — 저장된 요청의 대상만               |
//  | V8 | 금고 칸이 이미 차 있음(요청 전 / 요청 뒤 채움)     | 요청 뒤에 채워졌을 때만 닫는다(교체 요청이 바로 사라지지 않게) |
//  | V9 | me_credential_set 과 같은 판정                   | 같은 순수 함수가 같은 답                   |
import assert from "node:assert/strict";
import {
  askTargetVerdict, askStillOpen, askTargetChoice, vaultAskVerdict, vaultAskLabel, askTargetOf, livSecretPutPlan,
  type AskTargetCollector,
} from "./liv-secret.js";
import { selfCredentialTargetVerdict } from "../credentials/member-secret-rules.js";

// 마스터키 없는 게이트웨이로 고정한다 — 핸들러 시험(V4)이 409 를 기대한다.
delete process.env.CONNECTOR_SECRET_KEY;

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const ta = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

const col = (over: Partial<AskTargetCollector> = {}): AskTargetCollector => ({
  id: 1,
  secretsSet: { token: false },
  fields: [{ key: "token", secret: true }, { key: "root_pages" }],
  secrets_enabled: true,
  ...over,
});

t("[1] 시크릿 필드 + 마스터키 → 허용", () => {
  assert.deepEqual(askTargetVerdict(col(), "token"), { ok: true });
});

t("[2] 수집기가 없으면 겨눌 수 없다", () => {
  assert.equal(askTargetVerdict(null, "token").ok, false);
  assert.equal((askTargetVerdict(undefined, "token") as { reason: string }).reason, "no-collector");
});

t("[3] 그 수집기에 없는 필드는 거부", () => {
  assert.equal((askTargetVerdict(col(), "nope") as { reason: string }).reason, "not-a-secret-field");
});

t("[4] 있어도 **시크릿이 아닌** 칸이면 거부 — 평문 설정에 자격이 박히면 안 된다", () => {
  assert.equal((askTargetVerdict(col(), "root_pages") as { reason: string }).reason, "not-a-secret-field");
});

t("[5] secret 플래그가 없는 필드를 참으로 읽지 않는다", () => {
  const c = col({ fields: [{ key: "token" }] }); // secret 미표기
  assert.equal((askTargetVerdict(c, "token") as { reason: string }).reason, "not-a-secret-field");
});

t("[6] 마스터키가 없으면 받지 않는다 — 안전하게 못 넣는데 시키면 거짓말이다", () => {
  assert.equal((askTargetVerdict(col({ secrets_enabled: false }), "token") as { reason: string }).reason, "no-master-key");
});

t("[7] fields 가 비어도 터지지 않고 거부한다", () => {
  assert.equal((askTargetVerdict(col({ fields: [] }), "token") as { reason: string }).reason, "not-a-secret-field");
});

t("[8] 요청이 없으면 칸을 띄우지 않는다", () => {
  assert.equal(askStillOpen(null, [col()]), false);
  assert.equal(askStillOpen(undefined, [col()]), false);
});

t("[9] 아직 안 채워졌으면 띄운다", () => {
  assert.equal(askStillOpen({ collector_id: 1, field: "token" }, [col()]), true);
});

t("[10] 이미 채워졌으면 안 띄운다 — 다른 경로로 들어왔을 수 있다", () => {
  assert.equal(askStillOpen({ collector_id: 1, field: "token" }, [col({ secretsSet: { token: true } })]), false);
});

t("[11] 가리키는 수집기가 사라졌으면 안 띄운다", () => {
  assert.equal(askStillOpen({ collector_id: 9, field: "token" }, [col()]), false);
  assert.equal(askStillOpen({ collector_id: 1, field: "token" }, []), false);
});

t("[12] 다른 수집기가 채워진 것과 헷갈리지 않는다", () => {
  const others = [col({ id: 2, secretsSet: { token: true } }), col({ id: 1, secretsSet: { token: false } })];
  assert.equal(askStillOpen({ collector_id: 1, field: "token" }, others), true);
});

t("[13] secretsSet 이 아예 없으면 미설정으로 읽는다", () => {
  assert.equal(askStillOpen({ collector_id: 1, field: "token" }, [col({ secretsSet: undefined as never })]), true);
});

// ── 개인 금고 대상 ─────────────────────────────────────────────────────────

t("[V1] 수집기 대상과 금고 대상은 정확히 하나만", () => {
  assert.deepEqual(askTargetChoice({ collector_id: 1, field: "token" }), { ok: true, target: "collector" });
  assert.deepEqual(askTargetChoice({ vault_kind: "slack_bot_token" }), { ok: true, target: "vault" });
  assert.deepEqual(askTargetChoice({ vault_kind: "slack_bot_token", vault_scope: "T1" }), { ok: true, target: "vault" });
  assert.deepEqual(askTargetChoice({ collector_id: 1, field: "token", vault_kind: "slack_bot_token" }), { ok: false, reason: "both" });
  assert.deepEqual(askTargetChoice({ field: "token", vault_kind: "slack_bot_token" }), { ok: false, reason: "both" });
  assert.deepEqual(askTargetChoice({}), { ok: false, reason: "none" });
  assert.deepEqual(askTargetChoice({ vault_kind: "  ", label: "x" }), { ok: false, reason: "none" });
});

t("[V2] 금고 kind·scope 형식은 금고 저장소와 같은 규칙", () => {
  assert.deepEqual(vaultAskVerdict("bad kind!", "", true), { ok: false, reason: "bad-kind" });
  assert.deepEqual(vaultAskVerdict("x".repeat(41), "", true), { ok: false, reason: "bad-kind" });
  assert.deepEqual(vaultAskVerdict("slack_bot_token", "has space", true), { ok: false, reason: "bad-scope" });
});

t("[V3] 관리자 전용 kind 는 개인 금고 대상이 될 수 없다 — 대소문자·공백으로 우회되지 않는다", () => {
  for (const k of ["aws_role_arn", "AWS_ROLE_ARN", " aws_role_arn "]) {
    assert.deepEqual(vaultAskVerdict(k, "", true), { ok: false, reason: "admin-only" }, k);
  }
});

t("[V4] 마스터키가 없으면 받지 않는다(형식 검사 다음)", () => {
  assert.deepEqual(vaultAskVerdict("slack_bot_token", "", false), { ok: false, reason: "no-master-key" });
  assert.deepEqual(vaultAskVerdict("bad kind!", "", false), { ok: false, reason: "bad-kind" });
});

t("[V5] 형식 맞고 마스터키 있으면 허용 — 저장소가 쓸 모양으로 정규화해 돌려준다", () => {
  assert.deepEqual(vaultAskVerdict(" Slack_Bot_Token ", " T01:ab ", true), { ok: true, vault_kind: "slack_bot_token", vault_scope: "T01:ab" });
  assert.deepEqual(vaultAskVerdict("github_pat", undefined, true), { ok: true, vault_kind: "github_pat", vault_scope: "" });
  assert.equal(vaultAskLabel("github_pat", ""), "github_pat");
  assert.equal(vaultAskLabel("gitlab_pat", "gitlab.example.com"), "gitlab_pat (gitlab.example.com)");
});

t("[V6] 저장된 요청에서 넣을 자리를 읽는다 — target 없는 옛 요청은 수집기", () => {
  assert.deepEqual(askTargetOf({ collector_id: 3, field: "token" }), { target: "collector", collector_id: 3, field: "token" });
  assert.deepEqual(askTargetOf({ kind: "secret", target: "collector", collector_id: 3, field: "token" }), { target: "collector", collector_id: 3, field: "token" });
  assert.deepEqual(askTargetOf({ kind: "secret", target: "vault", vault_kind: "slack_bot_token", vault_scope: "T1" }),
    { target: "vault", vault_kind: "slack_bot_token", vault_scope: "T1" });
  assert.deepEqual(askTargetOf({ target: "vault", vault_kind: "github_pat" }), { target: "vault", vault_kind: "github_pat", vault_scope: "" });
  // 객관식·업로드·깨진 요청은 넣을 자리가 아니다.
  const choiceAsk = { kind: "choice", key: "x" };
  assert.equal(askTargetOf(choiceAsk), null);
  assert.equal(askTargetOf({ kind: "upload" }), null);
  assert.equal(askTargetOf({ target: "vault" }), null);
  assert.equal(askTargetOf({ field: "token" }), null);
  assert.equal(askTargetOf(null), null);
});

t("[V7] put 은 저장된 요청의 대상만 쓴다 — 브라우저가 보낸 대상은 무시", () => {
  const vaultAsk = { kind: "secret" as const, target: "vault" as const, vault_kind: "slack_bot_token", vault_scope: "T1" };
  const forged = { value: "xoxb-1", collector_id: 9, field: "token", target: "collector", vault_kind: "github_pat", vault_scope: "evil" };
  assert.deepEqual(livSecretPutPlan(vaultAsk, forged), { ok: true, target: { target: "vault", vault_kind: "slack_bot_token", vault_scope: "T1" } });
  const colAsk = { collector_id: 3, field: "token" };
  assert.deepEqual(livSecretPutPlan(colAsk, { ...forged, target: "vault" }), { ok: true, target: { target: "collector", collector_id: 3, field: "token" } });
  assert.deepEqual(livSecretPutPlan(null, { value: "x", vault_kind: "github_pat" }), { ok: false, reason: "no-ask" });
  const choiceAsk = { kind: "choice", key: "k" };
  assert.deepEqual(livSecretPutPlan(choiceAsk, { value: "x" }), { ok: false, reason: "no-ask" });
  assert.deepEqual(livSecretPutPlan(vaultAsk, { value: "   " }), { ok: false, reason: "empty" });
  // 수집기 칸은 종전 상한(8192) 그대로, 금고는 금고 쪽 검사(validateMemberSecret)에 맡긴다 — codex 로그인 파일은 8KB 를 넘는다.
  assert.deepEqual(livSecretPutPlan(colAsk, { value: "x".repeat(8193) }), { ok: false, reason: "too-long" });
  assert.equal(livSecretPutPlan(vaultAsk, { value: "x".repeat(9000) }).ok, true);
});

t("[V8] 금고 칸은 요청 뒤에 채워졌을 때만 닫는다", () => {
  const ask = { at: "2026-10-30T10:00:00.000Z", target: "vault" as const, vault_kind: "slack_bot_token", vault_scope: "" };
  const row = (o: Record<string, unknown>) => ({ kind: "slack_bot_token", scope_key: "", has_secret: true, updated_at: "2026-10-30T10:05:00.000Z", ...o });
  assert.equal(askStillOpen(ask, [], []), true, "칸 없음 → 연다");
  assert.equal(askStillOpen(ask, [], [row({ has_secret: false })]), true, "값 없음 → 연다");
  assert.equal(askStillOpen(ask, [], [row({})]), false, "요청 뒤에 채워짐 → 닫는다");
  assert.equal(askStillOpen(ask, [], [row({ updated_at: "2026-10-30T09:00:00.000Z" })]), true, "요청 전부터 있던 값 → 교체 요청이라 연다");
  assert.equal(askStillOpen(ask, [], [row({ scope_key: "T9" })]), true, "다른 scope 와 헷갈리지 않는다");
  assert.equal(askStillOpen(ask, [], [row({ kind: "github_pat" })]), true, "다른 kind 와 헷갈리지 않는다");
  assert.equal(askStillOpen({ ...ask, at: undefined }, [], [row({})]), false, "요청 시각 모름 + 채워짐 → 닫는다");
  assert.equal(askStillOpen(ask, [], [row({ updated_at: null })]), false, "갱신 시각 모름 + 채워짐 → 닫는다");
  // 수집기 요청은 금고 칸과 무관하다.
  assert.equal(askStillOpen({ collector_id: 1, field: "token" }, [col()], [row({})]), true);
});

t("[V9] me_credential_set 의 대상 판정과 같은 함수다", () => {
  assert.deepEqual(selfCredentialTargetVerdict("", ""), { ok: false, reason: "no-kind" });
  assert.deepEqual(selfCredentialTargetVerdict(" AWS_ROLE_ARN", ""), { ok: false, reason: "admin-only" });
  assert.deepEqual(selfCredentialTargetVerdict("Slack_Bot_Token", " T1 "), { ok: true, kind: "slack_bot_token", scope_key: "T1" });
  for (const [k, sc] of [["aws_role_arn", ""], ["bad kind!", ""], ["github_pat", "a b"], ["github_pat", "h.example.com"]] as const) {
    const a = selfCredentialTargetVerdict(k, sc);
    const b = vaultAskVerdict(k, sc, true);
    assert.equal(a.ok, b.ok, `${k}/${sc}`);
    if (!a.ok && !b.ok) assert.equal(a.reason, b.reason, `${k}/${sc}`);
  }
});

// ── 핸들러 — 거절은 DB 에 닿기 전에 난다(그래서 DB 없이 잰다) ─────────────────
{
  const { livCapabilities } = await import("../../capabilities/delivery/liv.js");
  const { memberSecretCapabilities } = await import("../../capabilities/member-secret.js");
  const ask = livCapabilities.find((c) => c.name === "me_liv_ask_secret")!;
  const meSet = memberSecretCapabilities.find((c) => c.name === "me_credential_set")!;
  const user = { userId: "u1", email: "u1@example.invalid", scopes: [], projects: ["*"] } as never;
  const rejects = (cap: typeof ask, input: Record<string, unknown>, status: number, label: string) =>
    assert.rejects(() => cap.handler(input, user) as Promise<unknown>, (e: any) => e?.status === status, label);

  await ta("[H1] 둘 다 / 둘 다 없음 → 400", async () => {
    await rejects(ask, { collector_id: 1, field: "token", vault_kind: "slack_bot_token" }, 400, "둘 다");
    await rejects(ask, { label: "x" }, 400, "둘 다 없음");
  });
  await ta("[H2] 금고 대상 형식 위반 → 400 · 관리자 전용 kind → 403", async () => {
    await rejects(ask, { vault_kind: "bad kind!" }, 400, "kind 형식");
    await rejects(ask, { vault_kind: "github_pat", vault_scope: "a b" }, 400, "scope 형식");
    await rejects(ask, { vault_kind: "aws_role_arn" }, 403, "관리자 전용");
  });
  await ta("[H3] 마스터키 미설정 → 409(수집기 대상과 같은 답)", async () => {
    await rejects(ask, { vault_kind: "slack_bot_token" }, 409, "마스터키");
  });
  await ta("[H4] me_credential_set 도 같은 판정으로 거절한다 — 공백 낀 관리자 전용 kind 포함", async () => {
    await rejects(meSet, { kind: " aws_role_arn", secret: "x" }, 403, "공백 우회");
    await rejects(meSet, { kind: "bad kind!", secret: "x" }, 400, "kind 형식");
    await rejects(meSet, { kind: "", secret: "x" }, 400, "kind 없음");
  });
}

console.log(`\n${pass} passed`);
