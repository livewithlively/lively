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
//
// 호스트 kind(scope 가 그 값이 실려 나갈 접속 호스트 — gitlab_pat·lively_workspace)는 칸을 고른 쪽(리브)이 값이 갈 곳을 고른다.
//  사람은 입력칸에 값만 친다 — 그래서 리브가 고른 scope 는 이미 등록된 호스트일 때만 받는다(격리 리뷰 B1).
//  | S1  | gitlab_pat · 처음 보는 호스트                   | unknown-host                             |
//  | S2  | gitlab_pat · 빈 scope                           | 허용(기본 칸)                            |
//  | S3  | 내 칸과 대소문자만 다른 호스트                    | 허용 — 내 칸의 표기로(칸이 하나 더 생기지 않게) |
//  | S4  | 조직이 같은 kind 로 등록한 호스트                 | 허용(대소문자 무시 · 조직 칸 표기)        |
//  | S5  | 내 칸이 있지만 **다른 kind** 의 칸               | unknown-host                             |
//  | S6  | lively_workspace · 빈 scope                     | unknown-host(기본 칸이 없다)             |
//  | S7  | lively_workspace · 내 칸의 호스트                | 허용                                     |
//  | S8  | 호스트 kind 가 아님                              | 아무 scope 나 그대로                     |
//  | S9  | 조직 목록 인자 생략(새 인자 부재)                | 비어 있지 않은 호스트 거절 · 빈 scope 허용 |
//  | S10 | 내 칸에 GitLab.com·gitlab.com 둘 다               | 정확히 같은 표기를 먼저 고른다            |
// 저장 위치 문장(dest) — 서버가 만들어 카드가 label 과 따로 보인다. 화면 문구라 끝맺는 문장이다.
//  | D1~D4 | 새 칸 — 빈 scope / 구분값 / 호스트 / 호스트 기본 칸 | 정확한 문장                            |
//  | D5  | 그 칸에 이미 값이 있다                           | « 이미 저장된 값을 바꿉니다.» 가 붙는다    |
//  | D6  | 모르는 kind · 원형 속성 이름(constructor)        | kind 그대로                              |
//  | D7  | 모든 dest                                       | «다.» 로 끝난다(명사 종결 없음)           |
// 배선 — 요청(livVaultAsk)·넣기(livSecretPut)를 가짜 의존으로 돌려 «무엇이 불렸나» 를 잰다(DB 없이).
//  | WA1 | 처음 보는 호스트                                 | 400 · 요청 저장 0회                       |
//  | WA2 | 리브가 label·dest 를 실어 보냄                   | dest 는 서버 문장 · label 은 따로 그대로   |
//  | WA3 | 그 칸에 이미 값이 있다                           | 저장된 dest 에 교체 문장                  |
//  | WA4 | 조회·저장 대상                                   | 요청자 id · 내 칸 표기의 scope            |
//  | WA5 | 조직 조회가 던짐                                 | 조직 호스트 없음으로 본다(400 — 500 아님) |
//  | WP1 | 넣기 — 입력에 다른 vault_kind·scope·collector_id | 저장된 요청의 칸으로 · 요청자 id · 기존 meta·label |
//  | WP2 | 넣기 성공                                        | 저장 **다음에** 요청자 요청을 지운다       |
//  | WP3 | 응답·로그                                        | 값이 어디에도 없다                        |
//  | WP4 | 저장이 던짐                                      | 요청을 지우지 않는다(사람이 다시 넣는다)   |
//  | WP5 | 저장된 요청 없음                                 | 409 · 저장 0회                            |
//  | WP6 | 수집기 요청                                      | 수집기 저장만 · 본인 금고 저장 0회         |
import assert from "node:assert/strict";
import {
  askTargetVerdict, askStillOpen, askTargetChoice, vaultAskVerdict, vaultAskLabel, askTargetOf, livSecretPutPlan,
  vaultScopeVerdict, vaultAskDest, vaultKindName,
  type AskTargetCollector,
} from "./liv-secret.js";

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

t("[V9] scope 만 주고 kind 를 빠뜨리면 형식 오류가 아니라 «kind 없음» 이다", () => {
  assert.deepEqual(vaultAskVerdict("", "T1", true), { ok: false, reason: "no-kind" });
});

// ── 호스트 kind 의 scope — 리브가 고른 호스트로 사람의 토큰이 나가지 않게(B1) ────────────────
const slotOf = (kind: string, scope_key: string) => ({ kind, scope_key });
const NO_HOST = { ok: false, reason: "unknown-host" } as const;

t("[S1] gitlab_pat 을 처음 보는 호스트로 요청하면 거절한다 — 수집·레포 목록 조회가 그 호스트로 토큰을 싣는다", () => {
  assert.deepEqual(vaultScopeVerdict("gitlab_pat", "evil.example.com", [], []), NO_HOST);
});

t("[S2] gitlab_pat 의 빈 scope 는 기본 칸이라 받는다", () => {
  assert.deepEqual(vaultScopeVerdict("gitlab_pat", "", [], []), { ok: true, vault_scope: "" });
});

t("[S3] 내 칸과 대소문자만 다른 호스트는 받되, 내 칸의 표기로 바꾼다 — 금고 키는 대소문자를 지켜서 그대로 두면 칸이 하나 더 생긴다", () => {
  assert.deepEqual(vaultScopeVerdict("gitlab_pat", "GitLab.Corp.com", [slotOf("gitlab_pat", "gitlab.corp.com")], []),
    { ok: true, vault_scope: "gitlab.corp.com" });
});

t("[S4] 조직이 같은 kind 로 등록한 호스트는 받는다(대소문자 무시 · 조직 칸의 표기)", () => {
  assert.deepEqual(vaultScopeVerdict("gitlab_pat", "gitlab.corp.com", [], ["gitlab.corp.com"]), { ok: true, vault_scope: "gitlab.corp.com" });
  assert.deepEqual(vaultScopeVerdict("gitlab_pat", "GITLAB.corp.com", [], ["gitlab.corp.com"]), { ok: true, vault_scope: "gitlab.corp.com" });
  // 조직의 빈 칸이 «아무 호스트나» 로 읽히지 않는다.
  assert.deepEqual(vaultScopeVerdict("gitlab_pat", "evil.example.com", [], [""]), NO_HOST);
});

t("[S5] 같은 호스트의 칸이 있어도 **다른 kind** 면 근거가 아니다", () => {
  assert.deepEqual(vaultScopeVerdict("gitlab_pat", "evil.example.com", [slotOf("github_pat", "evil.example.com")], ["gitlab.corp.com"]), NO_HOST);
});

t("[S6] lively_workspace 는 빈 scope 를 받지 않는다 — 주소 없는 연결은 뜻이 없다", () => {
  assert.deepEqual(vaultScopeVerdict("lively_workspace", "", [], []), NO_HOST);
  assert.deepEqual(vaultScopeVerdict("lively_workspace", "evil.example.com", [], []), NO_HOST);
});

t("[S7] lively_workspace 도 내 칸의 호스트면 받는다(토큰 교체)", () => {
  assert.deepEqual(vaultScopeVerdict("lively_workspace", "team.example.com", [slotOf("lively_workspace", "team.example.com")], []),
    { ok: true, vault_scope: "team.example.com" });
});

t("[S8] 호스트 kind 가 아니면 scope 는 구분값일 뿐이라 그대로 받는다", () => {
  assert.deepEqual(vaultScopeVerdict("slack_user_token", "T01", [], []), { ok: true, vault_scope: "T01" });
  assert.deepEqual(vaultScopeVerdict("github_pat", "evil.example.com", [], []), { ok: true, vault_scope: "evil.example.com" });
});

t("[S9] 조직 목록을 안 넘겨도(기본값) 처음 보는 호스트는 거절 · 빈 scope 는 허용", () => {
  assert.deepEqual(vaultScopeVerdict("gitlab_pat", "gitlab.corp.com", []), NO_HOST);
  assert.deepEqual(vaultScopeVerdict("gitlab_pat", "", []), { ok: true, vault_scope: "" });
});

t("[S10] 대소문자만 다른 내 칸이 둘이면 정확히 같은 표기를 먼저 고른다", () => {
  const mine = [slotOf("gitlab_pat", "GitLab.com"), slotOf("gitlab_pat", "gitlab.com")];
  assert.deepEqual(vaultScopeVerdict("gitlab_pat", "gitlab.com", mine, []), { ok: true, vault_scope: "gitlab.com" });
  assert.deepEqual(vaultScopeVerdict("gitlab_pat", "GitLab.com", mine, []), { ok: true, vault_scope: "GitLab.com" });
});

// ── 저장 위치 문장 — 카드가 리브의 label 과 따로 보이는 서버 문장 ──────────────────────
t("[D7] 저장 위치는 언제나 끝맺는 문장이다(명사 종결 없음)", () => {
  for (const [k, s] of [["figma_token", ""], ["slack_user_token", "T01"], ["gitlab_pat", "h.example.com"], ["gitlab_pat", ""], ["lively_workspace", "t.example.com"], ["foo_token", "x"]]) {
    for (const r of [false, true]) assert.match(vaultAskDest(k, s, r), /다\.$/, `${k}@${s} replaces=${r}`);
  }
});

t("[D1~D4] 새 칸의 저장 위치 — 빈 scope · 구분값 · 호스트 · 호스트 기본 칸", () => {
  assert.equal(vaultAskDest("figma_token", "", false), "이 값은 내 개인 금고의 «Figma 토큰» 칸에 저장됩니다.");
  assert.equal(vaultAskDest("slack_user_token", "T01", false), "이 값은 내 개인 금고의 «Slack 사용자 토큰» 칸(구분값 T01)에 저장됩니다.");
  assert.equal(vaultAskDest("gitlab_pat", "gitlab.corp.com", false),
    "이 값은 내 개인 금고의 «GitLab 개인 토큰» 칸에 저장되고, gitlab.corp.com 에 접속할 때 쓰입니다.");
  assert.equal(vaultAskDest("gitlab_pat", "", false), "이 값은 내 개인 금고의 «GitLab 개인 토큰» 기본 칸에 저장됩니다.");
});

t("[D5] 이미 값이 있는 칸이면 «이미 저장된 값을 바꿉니다.» 가 붙는다", () => {
  assert.equal(vaultAskDest("gitlab_pat", "gitlab.corp.com", true),
    "이 값은 내 개인 금고의 «GitLab 개인 토큰» 칸에 저장되고, gitlab.corp.com 에 접속할 때 쓰입니다. 이미 저장된 값을 바꿉니다.");
  assert.equal(vaultAskDest("figma_token", "", true), "이 값은 내 개인 금고의 «Figma 토큰» 칸에 저장됩니다. 이미 저장된 값을 바꿉니다.");
});

t("[D6] 모르는 kind 는 kind 그대로 — 원형 속성 이름(constructor)도 이름표로 둔갑하지 않는다", () => {
  assert.equal(vaultKindName("foo_token"), "foo_token");
  assert.equal(vaultKindName("constructor"), "constructor");
  assert.equal(vaultAskDest("constructor", "", false), "이 값은 내 개인 금고의 «constructor» 칸에 저장됩니다.");
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

  await ta("[H1] 요청 거절의 상태코드 — 대상 배타 400 · 형식 400 · 관리자 전용 403 · 마스터키 미설정 409", async () => {
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ collector_id: 1, field: "token", vault_kind: "slack_bot_token" }, 400, "둘 다"],
      [{ label: "x" }, 400, "둘 다 없음"],
      [{ vault_scope: "T1" }, 400, "kind 없음"],
      [{ vault_kind: "bad kind!" }, 400, "kind 형식"],
      [{ vault_kind: "github_pat", vault_scope: "a b" }, 400, "scope 형식"],
      [{ vault_kind: "aws_role_arn" }, 403, "관리자 전용"],
      [{ vault_kind: "slack_bot_token" }, 409, "마스터키(수집기 대상과 같은 답)"],
    ];
    for (const [input, status, label] of cases) await rejects(ask, input, status, label);
  });
  await ta("[H4] me_credential_set 도 같은 판정으로 거절한다 — 공백 낀 관리자 전용 kind 포함", async () => {
    await rejects(meSet, { kind: " aws_role_arn", secret: "x" }, 403, "공백 우회");
    await rejects(meSet, { kind: "bad kind!", secret: "x" }, 400, "kind 형식");
    await rejects(meSet, { kind: "", secret: "x" }, 400, "kind 없음");
  });
}

// ── 배선 — 요청·넣기를 가짜 의존으로 돌려 «무엇이 어떤 인자로 불렸나» 를 잰다(DB 없이) ─────────
{
  const { livVaultAsk, livSecretPut } = await import("../../capabilities/delivery/liv.js");
  type AskDeps = Parameters<typeof livVaultAsk>[2];
  type PutDeps = Parameters<typeof livSecretPut>[2];
  const status = (e: unknown): number | undefined => (e as { status?: number })?.status;

  const askDeps = (o: { mine?: Array<{ kind: string; scope_key: string }>; org?: string[]; orgThrows?: boolean; filled?: boolean } = {}) => {
    const calls = { mine: [] as string[], slot: [] as string[][], org: [] as string[], setAsk: [] as Array<[string, Record<string, unknown>]> };
    const d: AskDeps = {
      secretsEnabled: async () => true,
      mine: async (u) => { calls.mine.push(u); return o.mine ?? []; },
      slot: async (u, k, s) => { calls.slot.push([u, k, s]); return o.filled ? { has_secret: true } : null; },
      orgScopes: async (k) => { calls.org.push(k); if (o.orgThrows) throw new Error("db down"); return o.org ?? []; },
      setAsk: async (u, a) => { calls.setAsk.push([u, a as unknown as Record<string, unknown>]); },
    };
    return { d, calls };
  };

  await ta("[WA1] 처음 보는 호스트의 gitlab_pat 요청은 400 이고 요청이 저장되지 않는다(사람 화면에 칸이 안 뜬다)", async () => {
    const { d, calls } = askDeps();
    await assert.rejects(() => livVaultAsk("u1", { vault_kind: "gitlab_pat", vault_scope: "evil.example.com", label: "GitLab 토큰" }, d),
      (e: unknown) => status(e) === 400);
    assert.equal(calls.setAsk.length, 0);
  });

  await ta("[WA2] 저장 위치는 서버 문장이다 — 리브가 dest 를 실어 보내도 쓰지 않고, label 은 따로 그대로 남는다", async () => {
    const { d, calls } = askDeps();
    const ask = await livVaultAsk("u1", { vault_kind: "gitlab_pat", label: "GitLab 토큰", dest: "gitlab.com 에 저장됩니다." }, d);
    assert.equal(ask.dest, vaultAskDest("gitlab_pat", "", false));
    assert.equal(ask.label, "GitLab 토큰");
    assert.equal(calls.setAsk.length, 1);
    assert.deepEqual(calls.setAsk[0][1], ask as unknown as Record<string, unknown>, "저장한 요청 = 돌려준 요청");
  });

  await ta("[WA3] 그 칸에 이미 값이 있으면 저장된 요청의 dest 가 교체를 말한다", async () => {
    const { d, calls } = askDeps({ mine: [{ kind: "gitlab_pat", scope_key: "gitlab.corp.com" }], filled: true });
    await livVaultAsk("u1", { vault_kind: "gitlab_pat", vault_scope: "gitlab.corp.com" }, d);
    assert.equal(calls.setAsk[0][1].dest, vaultAskDest("gitlab_pat", "gitlab.corp.com", true));
  });

  await ta("[WA4] 칸 조회·요청 저장은 요청자 id 로 · 저장된 scope 는 내 칸의 표기다", async () => {
    const { d, calls } = askDeps({ mine: [{ kind: "gitlab_pat", scope_key: "gitlab.corp.com" }] });
    await livVaultAsk("u7", { vault_kind: "gitlab_pat", vault_scope: "GitLab.Corp.com" }, d);
    assert.deepEqual(calls.mine, ["u7"]);
    assert.deepEqual(calls.slot, [["u7", "gitlab_pat", "gitlab.corp.com"]]);
    assert.equal(calls.setAsk[0][0], "u7");
    assert.equal(calls.setAsk[0][1].vault_scope, "gitlab.corp.com");
  });

  await ta("[WA5] 조직 칸 조회가 실패하면 조직 호스트가 없는 것으로 본다 — 400(500 아님) · 빈 scope 는 그대로 받는다", async () => {
    const a = askDeps({ orgThrows: true });
    await assert.rejects(() => livVaultAsk("u1", { vault_kind: "gitlab_pat", vault_scope: "gitlab.corp.com" }, a.d), (e: unknown) => status(e) === 400);
    assert.deepEqual(a.calls.org, ["gitlab_pat"], "조직 조회가 실제로 불렸다");
    assert.equal(a.calls.setAsk.length, 0);
    const b = askDeps({ orgThrows: true });
    await livVaultAsk("u1", { vault_kind: "gitlab_pat", vault_scope: "" }, b.d);
    assert.equal(b.calls.setAsk.length, 1);
  });

  const VALUE = "glpat-REAL-VALUE-1610";
  const putDeps = (ask: unknown, o: { saveThrows?: boolean } = {}) => {
    const calls = {
      order: [] as string[], save: [] as Array<[string, Record<string, unknown>]>, clear: [] as string[],
      collector: [] as unknown[][], vaultSlot: [] as string[][], getAsk: [] as string[], log: [] as unknown[],
    };
    const d: PutDeps = {
      getAsk: async (u) => { calls.getAsk.push(u); return ask as never; },
      clearAsk: async (u) => { calls.order.push("clear"); calls.clear.push(u); },
      vaultSlot: async (u, k, s) => { calls.vaultSlot.push([u, k, s]); return { meta: { auth_header: "PRIVATE-TOKEN", token_prefix: "" }, label: "회사 GitLab" }; },
      saveOwnCredential: async (m, i) => {
        calls.order.push("save");
        if (o.saveThrows) throw Object.assign(new Error("암호화 키 없음"), { status: 400 });
        calls.save.push([m, i as unknown as Record<string, unknown>]);
      },
      saveCollectorSecret: async (...a) => { calls.order.push("collector"); calls.collector.push(a); },
      log: (...a) => { calls.log.push(a); },
    };
    return { d, calls };
  };
  const vaultAsk = { at: "2026-11-06T00:00:00.000Z", kind: "secret", target: "vault", vault_kind: "gitlab_pat", vault_scope: "gitlab.corp.com", label: "GitLab 토큰" };
  const forged = { value: VALUE, vault_kind: "github_pat", vault_scope: "evil.example.com", collector_id: 9, field: "token", target: "collector" };

  await ta("[WP1] 넣기는 저장된 요청의 칸으로만 — 입력의 vault_kind·scope·collector_id 는 무시 · 요청자 id · 기존 meta·label 유지", async () => {
    const { d, calls } = putDeps(vaultAsk);
    await livSecretPut("u1", forged, d);
    assert.deepEqual(calls.getAsk, ["u1"]);
    assert.deepEqual(calls.vaultSlot, [["u1", "gitlab_pat", "gitlab.corp.com"]]);
    assert.deepEqual(calls.save, [["u1", {
      kind: "gitlab_pat", scope_key: "gitlab.corp.com", secret: VALUE,
      meta: { auth_header: "PRIVATE-TOKEN", token_prefix: "" }, label: "회사 GitLab",
    }]]);
    assert.equal(calls.collector.length, 0);
  });

  await ta("[WP2] 저장이 끝난 **다음에** 요청자 요청을 지운다", async () => {
    const { d, calls } = putDeps(vaultAsk);
    await livSecretPut("u1", forged, d);
    assert.deepEqual(calls.order, ["save", "clear"]);
    assert.deepEqual(calls.clear, ["u1"]);
  });

  await ta("[WP3] 응답에도 로그에도 값이 없다", async () => {
    const { d, calls } = putDeps(vaultAsk);
    const res = await livSecretPut("u1", forged, d);
    assert.equal(JSON.stringify(res).includes(VALUE), false, JSON.stringify(res));
    assert.ok(calls.log.length > 0, "로그 의존이 실제로 불렸다(관측 장치가 살아 있다)");
    assert.equal(JSON.stringify(calls.log).includes(VALUE), false);
  });

  await ta("[WP4] 저장이 실패하면 요청을 지우지 않는다 — 칸이 남아 사람이 다시 넣을 수 있다", async () => {
    const { d, calls } = putDeps(vaultAsk, { saveThrows: true });
    await assert.rejects(() => livSecretPut("u1", forged, d), (e: unknown) => status(e) === 400);
    assert.deepEqual(calls.order, ["save"]);
    assert.equal(calls.clear.length, 0);
  });

  await ta("[WP5] 저장된 요청이 없으면 409 이고 아무것도 저장하지 않는다", async () => {
    const { d, calls } = putDeps(null);
    await assert.rejects(() => livSecretPut("u1", forged, d), (e: unknown) => status(e) === 409);
    assert.deepEqual(calls.order, []);
  });

  await ta("[WP6] 수집기 요청이면 수집기 칸에만 넣는다 — 본인 금고 저장은 0회", async () => {
    const { d, calls } = putDeps({ at: "2026-11-06T00:00:00.000Z", collector_id: 3, field: "token", label: "Notion 토큰" });
    const res = await livSecretPut("u1", forged, d);
    assert.deepEqual(calls.collector, [[3, "token", VALUE, "u1"]]);
    assert.equal(calls.save.length, 0);
    assert.deepEqual(calls.order, ["collector", "clear"]);
    assert.equal(JSON.stringify(res).includes(VALUE), false);
  });
}

console.log(`\n${pass} passed`);
