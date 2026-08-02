// 노드 사용 가능 게이트(#905 C4) — assertNodeUsable 사양 기반 테스트(구현 블라인드).
//  "이 요청자가 이 원격 노드로 프로젝트 작업(프로비저닝/세션생성)을 시켜도 되나"의 단일 권한.
//  보안 핵심: member 노드 = 개인(소유자 전용) · worker 노드 = 조직 공용(전원 개방).
//  deps(online/supports/getNode)를 주입해 각 시나리오를 결정론적으로 몰아넣는다(실 레지스트리/DB 불요).
import assert from "node:assert/strict";
import { assertNodeUsable, type NodeUsableDeps } from "./provision-remote.js";
import type { OrgNode } from "./store.js";
import { HttpError } from "../http-error.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };

// HttpError 던짐 + 특정 .status 만 검증(메시지 텍스트는 안 봄 — brittle).
const isHttp = (status: number) => (e: unknown) => e instanceof HttpError && e.status === status;

// 게이트 관련 필드만 의미 있음 — 나머지는 캐스트로 덮는다. 기본은 '전부 통과하는' 유효 노드.
const node = (over: Partial<OrgNode> = {}): OrgNode =>
  ({ id: "n1", name: "node-one", kind: "worker", owner_member: "bob", enabled: true, ...over }) as OrgNode;

// deps 주입 팩토리 — 기본은 online·supports 참, getNode 는 주어진 노드. 시나리오별로 override.
const depsFor = (n: OrgNode | null | undefined, over: Partial<NodeUsableDeps> = {}): NodeUsableDeps => ({
  online: () => true,
  supports: () => true,
  getNode: async () => n,
  ...over,
});

async function main() {
  // 1) 오프라인 → 409. 노드는 유효(worker·bob 소유·enabled·cap 보유)이고 online 만 false.
  await assert.rejects(
    () => assertNodeUsable(depsFor(node(), { online: () => false }), "n1", "bob", { requireProvision: true }),
    isHttp(409),
  );
  ok("offline node → 409");

  // 2) requireProvision=true 인데 provision capability 미선언(구 에이전트 번들) → 409. 다른 조건은 전부 통과.
  await assert.rejects(
    () => assertNodeUsable(depsFor(node(), { supports: () => false }), "n1", "bob", { requireProvision: true }),
    isHttp(409),
  );
  ok("requireProvision=true + node lacks provision capability → 409");

  // 3) requireProvision 없음(생략) → capability 아예 안 봄. provision cap 없는 노드에서도 통과(세션생성은 아무 노드에서나).
  //    member·소유자 매칭이라 소유권도 통과 → 통과 사유가 오직 'cap 미검사'임을 격리.
  {
    const n = node({ kind: "member", owner_member: "bob" });
    const got = await assertNodeUsable(depsFor(n, { supports: () => false }), "n1", "bob");
    assert.equal(got, n);
    ok("requireProvision absent → capability not checked, passes on node without provision cap");
  }

  // 4) 노드 없음(getNode → null/undefined) → 409. online 은 true 로 둬 유일 실패 사유가 '없음'이도록 격리.
  for (const missing of [null, undefined]) {
    await assert.rejects(
      () => assertNodeUsable(depsFor(missing), "n1", "bob"),
      isHttp(409),
    );
  }
  ok("missing node (getNode → null/undefined) → 409");

  // 5) 비활성(enabled=false) → 409. worker·bob 소유·online·cap 보유라 유일 실패 사유가 '비활성'이도록 격리.
  await assert.rejects(
    () => assertNodeUsable(depsFor(node({ enabled: false })), "n1", "bob", { requireProvision: true }),
    isHttp(409),
  );
  ok("disabled node (enabled=false) → 409");

  // 6) member 노드 + 요청자 ≠ owner_member → 403. 나머지(online·enabled·cap·존재)는 전부 통과 → 유일 실패 사유가 소유권.
  await assert.rejects(
    () => assertNodeUsable(depsFor(node({ kind: "member", owner_member: "alice" })), "n1", "bob", { requireProvision: true }),
    isHttp(403),
  );
  ok("member node + non-owner requester → 403");

  // 7) worker 노드 → 소유권 검사 미적용. 요청자(bob) ≠ owner(alice) 여도 통과(조직 공용 · 전원 개방). 6)의 보안 역상.
  {
    const n = node({ kind: "worker", owner_member: "alice" });
    const got = await assertNodeUsable(depsFor(n), "n1", "bob", { requireProvision: true });
    assert.equal(got, n);
    ok("worker node + non-owner requester → passes (org-shared, ownership not enforced)");
  }

  // 8) 전부 통과(member + 소유자 매칭, online, provision cap 보유) → 노드 객체를 그대로 반환. member+owner 분기도 커버.
  {
    const n = node({ kind: "member", owner_member: "bob" });
    const got = await assertNodeUsable(depsFor(n), "n1", "bob", { requireProvision: true });
    assert.equal(got, n);
    ok("member node + owner requester, all checks pass → returns the node object");
  }
}

main().then(
  () => { console.log(`\n${pass} passed`); },
  (err) => { console.error(err); process.exit(1); },
);
