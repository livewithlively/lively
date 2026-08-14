// 자료 미러 upsert 의 updated_at 의미(#1289 회귀 가드) — '내용이 바뀐 시각'이지 '동기화한 시각'이 아니다.
//
// 왜 이 테스트가 있나: 증류 인박스가 재판정 판단에 source.updated_at 을 쓴다(판정 시각보다 나중이면 다시 본다).
// 그런데 미러 upsert 가 동기화마다 무조건 updated_at=now() 로 밀면, 슬랙 커넥터의 **일일 full 스윕**이
// 전 자료의 updated_at 을 매일 전진시켜 **매일 전량이 다시 증류된다**(비용 폭발 + 지식 중복).
// "마지막으로 동기화한 시각"은 last_synced_at 이 이미 맡으므로 둘의 의미가 갈려야 한다.
//
// SQL 문자열을 검사한다 — 이 파일은 DB 없이 도는 계층이고, 결함이 정확히 이 한 절에 있기 때문이다.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

// ⚠ 컴파일된 테스트는 dist/ 에서 돈다 — 소스는 레포 루트 기준으로 읽는다(러너가 루트에서 실행).
const src = readFileSync(path.join(process.cwd(), "src/v6/mirror/mirror-source.ts"), "utf8");
// 앵커는 컬럼 목록에 의존하지 않게 둔다 — 멀티테넌트로 가며 `(tenant_id, external_system…)` 이 됐고,
//  그때 이 테스트가 "아무것도 안 보는" 상태로 조용히 통과하면 안 된다(실제로 시끄럽게 실패해서 잡았다).
const upsert = src.slice(src.indexOf("ON CONFLICT ("), src.indexOf("RETURNING id"));
assert.ok(upsert.length > 50, "upsert 절을 못 찾았다 — 이 테스트가 아무것도 안 보고 있다(배선 확인)");

// U1 — updated_at 은 무조건 now() 가 아니다.
assert.ok(!/updated_at\s*=\s*now\(\)/.test(upsert),
  "updated_at=now() 무조건 갱신 — 일일 full 스윕이 전 자료를 '수정됨'으로 만들어 매일 전량 재증류된다");

// U2 — 내용 변경 여부로 갈린다(변경 없으면 기존 값 보존).
assert.match(upsert, /updated_at\s*=\s*CASE WHEN .*THEN now\(\) ELSE source\.updated_at END/s,
  "내용이 그대로면 updated_at 을 보존해야 한다");

// U3 — 동기화 시각은 별도로 계속 기록한다(관측 손실 방지).
assert.match(upsert, /last_synced_at\s*=\s*now\(\)/,
  "last_synced_at 까지 멈추면 '언제 마지막으로 봤나'를 잃는다");

// U4 — 판정 기준이 제목·본문 둘 다를 본다(제목만 고친 수정도 잡아야 한다).
const changed = src.slice(src.indexOf("const contentChanged"), src.indexOf("const r = await client.query"));
assert.match(changed, /title/, "제목 변경을 안 보면 제목만 고친 수정이 영원히 반영 안 된다");
assert.match(changed, /body_md/, "본문 변경을 안 보면 재판정의 핵심이 빠진다");

console.log("source-updated-at.test: ok");
