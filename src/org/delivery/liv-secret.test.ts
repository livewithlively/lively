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
import assert from "node:assert/strict";
import { askTargetVerdict, askStillOpen, type AskTargetCollector } from "./liv-secret.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

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

console.log(`\n${pass} passed`);
