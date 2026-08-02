// 위탁 스케줄러 자격 리스(#1289 회귀 가드) — 등록한 셋업토큰이 실제로 태스크에 실리는가.
//
// 왜 이 테스트가 있나: member_secret 은 **owner 문자열**로 키가 잡힌다(`member:<id>`). 멤버 id 를 그대로 넘기면
// 저장 키와 안 맞아 SELECT 가 0행이고, getMemberSecret 은 오류 없이 null 을 준다 → 리스는 "자격 없음"으로 강등된다.
// 강등 경로가 정상 동작이라(central 배치) 아무 증상이 없다: 사용자는 등록을 마쳤는데 그 계정의 크레딧이 안 닳고,
// 워커 디스크에 /login 된 다른 계정이 대신 소모된다. 고객사 A 실측에서 last_used_at 이 계속 null 이었다(#1289).
// kind 축은 task-scheduler-kind.test.ts 가 막고 있었지만 owner 축은 비어 있어서 통과된 결함이다.
import { strict as assert } from "node:assert";
import { memberOwner } from "../org/credentials/member-secret-store.js";
import { SECRET_KIND, leaseEnvFor, remoteAllowed } from "./task-scheduler.js";

const ENV_KEY = "CLAUDE_CODE_OAUTH_TOKEN";
type Call = { owner: string; kind: string; scope: string };

// 저장소 대역 — 저장된 owner 키에서만 값을 내주고, 조회 인자를 기록한다(무엇으로 찾았는지가 이 결함의 전부).
function store(rows: Record<string, string | null>): {
  lookup: (o: string, k: string, s: string) => Promise<{ secret: string | null } | null>; calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    lookup: async (owner, kind, scope) => {
      calls.push({ owner, kind, scope });
      return owner in rows ? { secret: rows[owner] } : null;
    },
  };
}

const fail = async (): Promise<never> => { throw new Error("저장소 장애"); };

// L1 — 등록된 의뢰자는 토큰이 env 로 실린다.
{
  const { lookup } = store({ [memberOwner("lively1")]: "sk-ant-oat-TEST" });
  assert.deepEqual(await leaseEnvFor("lively1", lookup), { [ENV_KEY]: "sk-ant-oat-TEST" },
    "등록된 셋업토큰이 env 리스로 실려야 한다");
}

// L2 — 조회 키가 저장 키와 같다(raw 멤버 id 로 찾지 않는다). 이번 결함의 급소.
{
  const { lookup, calls } = store({ [memberOwner("lively1")]: "sk-ant-oat-TEST" });
  await leaseEnvFor("lively1", lookup);
  assert.equal(calls.length, 1, "저장소를 한 번은 실제로 조회해야 한다(관측 장치 배선 확인)");
  assert.equal(calls[0].owner, memberOwner("lively1"),
    `owner 키가 저장 키와 달라 조회가 0행이 된다 — 실제로 넘긴 값: ${calls[0].owner}`);
  assert.notEqual(calls[0].owner, "lively1", "멤버 id 를 그대로 넘기면 저장 키와 안 맞는다(무증상 null)");
  assert.equal(calls[0].kind, SECRET_KIND);
  assert.equal(calls[0].scope, "", "단일 자격이므로 scope_key 는 빈 문자열");
}

// L3 — 자격 없는 의뢰자는 정상 동작한다(리스 없음). 자격은 선택이다.
{
  const { lookup } = store({});
  assert.equal(await leaseEnvFor("nobody", lookup), undefined, "자격이 없으면 env 없이 진행한다");
  assert.equal(remoteAllowed(false, "someone_else", "nobody"), false, "리스 없으면 남의 노드는 후보 제외");
  assert.equal(remoteAllowed(false, "nobody", "nobody"), true, "리스 없어도 본인 소유 노드는 후보");
}

// L4 — 자격이 있으면 소유자가 다른 원격 노드도 후보에 든다(리스가 배치 분산까지 바꾼다).
{
  assert.equal(remoteAllowed(true, "someone_else", "lively1"), true, "리스가 있으면 아무 노드나 배치 가능");
  assert.equal(remoteAllowed(true, null, "lively1"), true, "소유자 미상 노드도 리스가 있으면 후보");
}

// L5 — 저장소가 던져도 태스크를 죽이지 않는다(자격 없음으로 강등).
assert.equal(await leaseEnvFor("lively1", fail), undefined, "저장소 장애는 삼켜서 자격 없음으로 강등해야 한다");

// L6 — 행은 있으나 값이 비면 env 를 붙이지 않는다(빈 토큰 전송은 더 나쁜 실패).
for (const [label, v] of [["빈 문자열", ""], ["null", null]] as const) {
  const { lookup } = store({ [memberOwner("lively1")]: v });
  assert.equal(await leaseEnvFor("lively1", lookup), undefined, `시크릿이 ${label}이면 env 를 붙이지 않는다`);
}

console.log("task-scheduler-lease.test: ok");
