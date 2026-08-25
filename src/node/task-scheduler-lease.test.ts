// 위탁 스케줄러 자격 리스(#1289 회귀 가드) — 등록한 셋업토큰이 실제로 태스크에 실리는가.
//
// 왜 이 테스트가 있나: member_secret 은 **owner 문자열**로 키가 잡힌다(`member:<id>`). 멤버 id 를 그대로 넘기면
// 저장 키와 안 맞아 SELECT 가 0행이고, getMemberSecret 은 오류 없이 null 을 준다 → 리스는 "자격 없음"으로 강등된다.
// 강등 경로가 정상 동작이라(central 배치) 아무 증상이 없다: 사용자는 등록을 마쳤는데 그 계정의 크레딧이 안 닳고,
// 워커 디스크에 /login 된 다른 계정이 대신 소모된다. 고객사 A 실측에서 last_used_at 이 계속 null 이었다(#1289).
// kind 축은 task-scheduler-kind.test.ts 가 막고 있었지만 owner 축은 비어 있어서 통과된 결함이다.
import { strict as assert } from "node:assert";
import { memberOwner } from "../org/credentials/member-secret-store.js";
import { SECRET_KIND, LEASE_SECRET, leaseEnvFor } from "./task-scheduler.js";
// 후보 판정은 #1540 에서 node-access 로 옮겼다(리스는 '자격', 소유·공유는 '권한' — 축이 다르다).
//  진리표는 node-access.test.ts 가 맡고, 여기선 **리스가 후보 범위에 미치는 영향**만 이어서 본다.
import { remoteDelegateAllowed } from "./node-access.js";

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
// 멤버 상태 조회기(#1780 v2 §7-1) — 기본값은 DB(getMember)라 테스트는 명시 주입한다.
const ACTIVE = async (): Promise<string | null> => "active";
// 리스는 **태스크 행**(의뢰자+하네스)으로 찾는다(#1884) — 셋업토큰은 claude 것이라 하네스가 축이다.
const REQ = { requester: "lively1", harness: "claude" };

// L1 — 등록된 의뢰자는 토큰이 env 로 실린다.
{
  const { lookup } = store({ [memberOwner("lively1")]: "sk-ant-oat-TEST" });
  assert.deepEqual(await leaseEnvFor(REQ, lookup, ACTIVE), { [ENV_KEY]: "sk-ant-oat-TEST" },
    "등록된 셋업토큰이 env 리스로 실려야 한다");
}

// L2 — 조회 키가 저장 키와 같다(raw 멤버 id 로 찾지 않는다). 이번 결함의 급소.
{
  const { lookup, calls } = store({ [memberOwner("lively1")]: "sk-ant-oat-TEST" });
  await leaseEnvFor(REQ, lookup, ACTIVE);
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
  assert.equal(await leaseEnvFor({ requester: "nobody", harness: "claude" }, lookup, ACTIVE), undefined, "자격이 없으면 env 없이 진행한다");
  assert.equal(remoteDelegateAllowed({ owner_member: "someone_else", shared: false }, "nobody", false), false,
    "리스 없으면 남의 노드는 후보 제외");
  assert.equal(remoteDelegateAllowed({ owner_member: "nobody", shared: false }, "nobody", false), true,
    "리스 없어도 본인 소유 노드는 후보");
}

// L4 — 리스가 넓히는 범위는 **공유 노드까지**다(#1540). 종전엔 리스 하나로 남의 개인 노드까지 열렸다.
//  즉 리스는 '자격이 그 머신에 실리는가'만 정하고, '그 노드를 써도 되는가'는 소유·공유가 정한다.
{
  assert.equal(remoteDelegateAllowed({ owner_member: "someone_else", shared: true }, "lively1", true), true,
    "리스가 있으면 관리자가 공유로 지정한 남의 노드는 후보");
  assert.equal(remoteDelegateAllowed({ owner_member: "someone_else", shared: true }, "lively1", false), false,
    "공유 노드라도 리스가 없으면 후보 제외(그 박스엔 의뢰자 자격이 없다)");
  assert.equal(remoteDelegateAllowed({ owner_member: "someone_else", shared: false }, "lively1", true), false,
    "🔴 리스가 있어도 남의 비공유 노드는 후보가 아니다(#1540)");
  assert.equal(remoteDelegateAllowed({ owner_member: null, shared: true }, "lively1", true), true,
    "소유자 미상이어도 공유 노드 + 리스면 후보");
}

// L5 — 저장소가 던져도 태스크를 죽이지 않는다(자격 없음으로 강등).
assert.equal(await leaseEnvFor(REQ, fail, ACTIVE), undefined, "저장소 장애는 삼켜서 자격 없음으로 강등해야 한다");

// L6 — 행은 있으나 값이 비면 env 를 붙이지 않는다(빈 토큰 전송은 더 나쁜 실패).
for (const [label, v] of [["빈 문자열", ""], ["null", null]] as const) {
  const { lookup } = store({ [memberOwner("lively1")]: v });
  assert.equal(await leaseEnvFor(REQ, lookup, ACTIVE), undefined, `시크릿이 ${label}이면 env 를 붙이지 않는다`);
}

// L7 — #1780 v2 §7-1(사양 H3): 의뢰자가 active 멤버가 아니면 시크릿이 있어도 **리스하지 않는다**.
//  토큰은 verifyDbToken 이 막지만 벤더 자격 리스는 별도 축 — 안 보면 퇴사자의 setup-token 으로 새 런이 계속 배치된다.
{
  const rows = { [memberOwner("lively1")]: "sk-ant-oat-TEST" };
  for (const [label, stateOf] of [
    ["inactive", async (): Promise<string | null> => "inactive"],
    ["삭제(null)", async (): Promise<string | null> => null],
    ["조회 실패(예외)", async (): Promise<string | null> => { throw new Error("db down"); }],
  ] as const) {
    const { lookup, calls } = store(rows);
    assert.equal(await leaseEnvFor(REQ, lookup, stateOf), undefined, `멤버 ${label} 이면 리스 없음(fail-closed)`);
    assert.equal(calls.length, 0, `멤버 ${label} 이면 시크릿 저장소를 아예 조회하지 않는다`);
  }
  // 배선 확인 — 상태 조회기가 실제로 의뢰자 id 로 불린다.
  const seen: string[] = [];
  const { lookup } = store(rows);
  await leaseEnvFor(REQ, lookup, async (id) => { seen.push(id); return "active"; });
  assert.deepEqual(seen, ["lively1"], "상태 조회는 의뢰자 멤버 id 로 1회");
}

// L8 — #1884 하네스 축: 리스 시크릿은 **claude 셋업토큰**뿐이다. codex 위탁엔 실을 자격이 없으므로 env 없음이고,
//  저장소도 조회하지 않는다(claude 토큰을 codex 워커에 싣는 건 무의미하고, 그걸로 공유 노드가 열리면 안 된다).
{
  const { lookup, calls } = store({ [memberOwner("lively1")]: "sk-ant-oat-TEST" });
  assert.equal(await leaseEnvFor({ requester: "lively1", harness: "codex" }, lookup, ACTIVE), undefined, "codex 는 리스 시크릿이 없다");
  assert.equal(calls.length, 0, "리스 없는 하네스는 저장소를 조회하지 않는다");
  assert.deepEqual(Object.keys(LEASE_SECRET), ["claude"], "리스 표에 하네스를 더하면 그 env·kind 를 실측해 여기 명시할 것");
  assert.equal(LEASE_SECRET.claude.env, ENV_KEY);
  assert.equal(LEASE_SECRET.claude.kind, SECRET_KIND);
}

console.log("task-scheduler-lease.test: ok");
