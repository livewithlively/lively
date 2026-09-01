// #1875 D5″ — **나가기의 세 갈래는 «지금 어드민이 몇 명인가»가 정한다.** (2026-08-28 장원준)
//
// ── 결정 원문 ───────────────────────────────────────────────────────────────
//  「팀워크스페이슨데 내가 어드민 아닌 구성원인 경우 → 나갈 때 그냥 나가면 됨.
//    팀워크스페이슨데 내가 유일한 어드민인 경우 → 나갈 때 어드민 권한 양도하는 과정 필요.
//    팀워크스페이슨데 내가 여러 어드민 권한 중 하나일 경우 → 그냥 나가지면 됨.」
//
// 이 결정이 8/27 D5' 의 한 줄을 바꾼다: 그때는 유일 주인을 **막고** "준비 중"이라 말했다(이양은 #1971).
//  이제 막지 않고 **넘길 사람을 물어서** 내보낸다.
//
// ── 왜 순수 함수로 뽑았나 ───────────────────────────────────────────────────
// 주인은 **두 곳**에 적혀 있다 — 등록부 `gw_workspace.owner_member`(만든 사람)와 명부 role='owner'.
//  requireOwner 가 둘을 OR 로 보므로, 판정을 핸들러 안에 흩어 두면 «권한은 넘겼는데 나는 여전히 주인»
//  같은 반쪽 상태가 조용히 난다. 갈래를 한 벌로 두고 그 한 벌을 여기서 고정한다(레포 선례:
//  registry.sessionInWorkspace + session-workspace-isolation.test.ts).
//
// ── 엣지 표(입력 × 기대) ────────────────────────────────────────────────────
//   E1  일반 구성원                        → 그냥 나간다(넘길 것 없음)
//   E2  어드민 둘 중 하나(나는 만든 사람 아님) → 그냥 나간다
//   E3  ★유일 어드민 · 넘길 사람 안 줌       → 막고 **후보를 준다**(물어볼 재료를 화면에 준다)
//   E4  ★유일 어드민 · 넘길 사람 줌          → 넘기고 나간다
//   E5  유일 어드민 · 나 자신에게 넘김        → 거절(넘긴 게 아니다)
//   E6  유일 어드민 · 구성원 아닌 사람에게 넘김 → 거절(밖의 사람을 주인으로 세울 수 없다)
//   E7  ★만든 사람인데 공동 어드민이 있다     → 그냥 나가되 **owner_member 를 자동 승계**시킨다
//        ← 안 하면 등록부의 «만든 사람» 이 나간 사람을 계속 가리킨다(유령 주인)
//   E8  혼자                               → 나가기가 아니라 삭제다
//   E9  구성원이 아님                       → 거절
//   E10 primary                            → 명부가 없다(박스 로그인 = 접근)
//   E11 승계 대상은 **결정적**이다           → 같은 입력이면 늘 같은 사람(목록 순서에 안 흔들린다)
//   E12 ★등록부 주인인데 명부 role 은 member  → 그래도 어드민이다(두 출처가 어긋난 행이 실재한다)
//        ← 돌연변이로 잡았다: 어드민 판정에서 `id === ownerMember ||` 를 빼도 E1~E11 이 전부 통과했다.
//          그 상태에선 «만든 사람» 이 어드민으로 안 세어져 유일 주인이 그냥 나가고 주인 없는 팀이 남는다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { planWorkspaceLeave } from "./registry.js";

const M = (id: string, role = "member") => ({ member_id: id, role });

test("★ E1~E10 나가기 갈래 — 어드민 수가 문을 정한다", () => {
  // E1 일반 구성원
  assert.deepEqual(
    planWorkspaceLeave({ me: "haru", ownerMember: "mike", isPrimary: false, members: [M("mike", "owner"), M("haru")] }),
    { ok: true, transferTo: null }, "E1 일반 구성원은 그냥 나간다");

  // E2 어드민이 둘 — 나는 만든 사람이 아니다
  assert.deepEqual(
    planWorkspaceLeave({ me: "haru", ownerMember: "mike", isPrimary: false, members: [M("mike", "owner"), M("haru", "owner")] }),
    { ok: true, transferTo: null }, "E2 공동 어드민은 그냥 나간다");

  // E3 ★유일 어드민 · 넘길 사람 없음 — 막되 후보를 준다
  const need = planWorkspaceLeave({ me: "mike", ownerMember: "mike", isPrimary: false, members: [M("mike", "owner"), M("haru"), M("dana")] });
  assert.equal((need as any).ok, false, "E3 유일 어드민이 그냥 나가졌다 — 주인 없는 팀이 남는다");
  assert.equal((need as any).reason, "needs-transfer", "E3 이유가 '넘겨야 한다'가 아니다");
  assert.deepEqual((need as any).candidates, ["dana", "haru"], "E3 후보가 없거나 나를 포함한다 — 화면이 물어볼 재료가 없다");

  // E4 ★유일 어드민 · 넘김
  assert.deepEqual(
    planWorkspaceLeave({ me: "mike", ownerMember: "mike", isPrimary: false, members: [M("mike", "owner"), M("haru")], transferTo: "haru" }),
    { ok: true, transferTo: "haru" }, "E4 넘기고 나가지 못한다");

  // E5 나 자신에게
  assert.equal(
    (planWorkspaceLeave({ me: "mike", ownerMember: "mike", isPrimary: false, members: [M("mike", "owner"), M("haru")], transferTo: "mike" }) as any).reason,
    "bad-transfer", "E5 자기 자신에게 넘기는 것이 통과했다 — 넘긴 게 아니다");

  // E6 밖의 사람에게
  assert.equal(
    (planWorkspaceLeave({ me: "mike", ownerMember: "mike", isPrimary: false, members: [M("mike", "owner"), M("haru")], transferTo: "nobody" }) as any).reason,
    "bad-transfer", "E6 구성원 아닌 사람을 주인으로 세웠다");

  // E7 ★만든 사람이 나가는데 공동 어드민이 있다 — 자동 승계
  assert.deepEqual(
    planWorkspaceLeave({ me: "mike", ownerMember: "mike", isPrimary: false, members: [M("mike", "owner"), M("haru", "owner"), M("dana")] }),
    { ok: true, transferTo: "haru" },
    "E7 ★owner_member 를 승계시키지 않는다 — 등록부의 «만든 사람» 이 나간 사람을 계속 가리킨다");

  // E8 혼자
  assert.equal((planWorkspaceLeave({ me: "mike", ownerMember: "mike", isPrimary: false, members: [M("mike", "owner")] }) as any).reason,
    "alone", "E8 혼자인데 나가기가 열렸다 — 그건 삭제다");

  // E9 구성원 아님
  assert.equal((planWorkspaceLeave({ me: "zoe", ownerMember: "mike", isPrimary: false, members: [M("mike", "owner"), M("haru")] }) as any).reason,
    "not-member", "E9 구성원이 아닌 사람이 나갈 수 있다");

  // E10 primary
  assert.equal((planWorkspaceLeave({ me: "mike", ownerMember: "mike", isPrimary: true, members: [M("mike", "owner"), M("haru")] }) as any).reason,
    "primary", "E10 primary 에서 나가진다 — 거긴 명부가 없다(박스 로그인 = 접근)");
});

test("★★ E12 등록부의 «만든 사람»은 명부 role 이 member 여도 어드민이다", () => {
  //  두 출처(gw_workspace.owner_member / gw_workspace_member.role)는 어긋날 수 있다 —
  //   workspace_member_add 로 role 을 member 로 덮어쓸 수 있고, 옛 행도 있다. requireOwner 는 둘을
  //   OR 로 보므로 여기서 더 좁게 세면 «게이트는 통과하는데 나갈 땐 어드민이 아닌» 사람이 생긴다.
  const r = planWorkspaceLeave({ me: "mike", ownerMember: "mike", isPrimary: false, members: [M("mike"), M("haru")] });
  assert.equal((r as any).ok, false,
    "★만든 사람인데 명부 role 이 member 라고 그냥 나가졌다 — 주인 없는 팀이 남는다");
  assert.equal((r as any).reason, "needs-transfer", "넘기라고 하지 않는다");

  // 반대로 남은 쪽에서도 같아야 한다: 만든 사람이 role=member 라도 승계 대상 어드민으로 세어진다.
  assert.deepEqual(
    planWorkspaceLeave({ me: "haru", ownerMember: "mike", isPrimary: false, members: [M("mike"), M("haru", "owner")] }),
    { ok: true, transferTo: null },
    "공동 어드민 상황인데 그냥 나가지 못한다");
});

test("★ E11 승계 대상은 결정적이다 — 목록 순서가 주인을 바꾸지 않는다", () => {
  const members = [M("mike", "owner"), M("haru", "owner"), M("dana", "owner")];
  const a = planWorkspaceLeave({ me: "mike", ownerMember: "mike", isPrimary: false, members });
  const b = planWorkspaceLeave({ me: "mike", ownerMember: "mike", isPrimary: false, members: [...members].reverse() });
  assert.deepEqual(a, b, "★같은 명부인데 순서만 다른 입력이 서로 다른 주인을 세웠다");
  assert.equal((a as any).transferTo, "dana", "결정적 선택(사전순 첫 번째)이 아니다");
});
