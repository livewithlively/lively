// #1875 — 워크스페이스 구성원 초대. 사양·엣지 표: 세션 스크래치패드 spec.md
//  (spec-failfirst-test 1티어 — 각 단언을 mutation 으로 red 입증한 뒤 커밋).
//
// 여기서 잠그는 명제들은 전부 "빠지면 조용히 틀린 화면·잘못된 접근이 나오는" 종류다:
//  · 개인/팀 파생식이 **서버와 화면에서 같아야** 한다 — 갈리면 문패는 '개인'인데 게이트는 팀으로 연다.
//  · 이메일 정규화가 **초대 저장 때와 수락 때 같아야** 한다 — 갈리면 본인이 자기 초대를 못 받는다.
//  · 받는 사람 확인은 **fail-closed** 여야 한다 — "이메일이 없으니 통과"는 초대 id 만 아는 사람에게
//    남의 워크스페이스를 열어 주는 것과 같다.
//  · 초대 표가 테넌트 축 밖이어야 "나에게 온 초대" 조회가 성립한다(구조로 잠근다).
import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TENANT_COLUMN_EXEMPT } from "../../db/tenant-column.js";
import {
  kindEffective, normalizeInviteEmail,
  inviteResolvable, inviteDecisionActor, inviteNextState, inviteRecipientMatches,
} from "./registry.js";

// 소스를 읽는 단언이 몇 개 있다(두 곳이 같은 규칙을 쓰는지·구조가 유지되는지). 테스트는 dist 에서
//  돌기도 하고 tsx 로 소스에서 돌기도 하므로, **레포 뿌리를 찾아** 거기서부터 잡는다 — 상대경로를
//  고정하면 실행 방식 하나가 바뀔 때 파일을 못 찾아 red 가 아니라 ENOENT 로 죽는다(실측).
function repoRoot(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(d, "package.json")) && existsSync(path.join(d, "web"))) return d;
    d = path.dirname(d);
  }
  throw new Error("레포 뿌리를 찾지 못했다");
}
const readSrc = (rel: string): string => readFileSync(path.join(repoRoot(), rel), "utf8");

// ── A. 개인/팀 파생 (E1–E5) ─────────────────────────────────────────────────

test("E1·E2 개인: 명부가 비었거나 한 명이면 개인", () => {
  assert.equal(kindEffective(0), "personal");   // 명부가 비어도 '팀'은 아니다
  assert.equal(kindEffective(1), "personal");
});

test("E3·E4 팀: 두 명이 되는 **그 순간**부터 팀 (경계)", () => {
  assert.equal(kindEffective(2), "team");
  assert.equal(kindEffective(37), "team");
});

test("★ E5 화면 판정식이 서버와 **같은 식**이다 — 갈리면 문패와 게이트가 다른 말을 한다", () => {
  // 한쪽만 고치는 것이 이 기능의 대표 회귀라, '두 곳이 같다'를 사람 눈이 아니라 테스트가 지킨다.
  const web = readSrc("web/v2/switcher.ts");
  const m = web.match(/export function kindFromCount\(n: number\): 'personal' \| 'team' \{ return (.+?); \}/);
  assert.ok(m, "web/v2/switcher.ts 의 kindFromCount 를 찾지 못했다 — 형태가 바뀌었다면 이 테스트도 함께 고쳐라");
  // 식 자체를 문자열로 비교하는 대신, 그 식을 **실행해** 서버 판정과 전 구간에서 맞는지 본다.
  const webKind = new Function("n", `return ${m![1]};`) as (n: number) => string;
  for (const n of [0, 1, 2, 3, 10]) {
    assert.equal(webKind(n), kindEffective(n), `인원 ${n} 에서 화면과 서버 판정이 다르다`);
  }
});

// ── B. 초대 이메일 (E6–E9) ──────────────────────────────────────────────────

test("E6 이메일: 앞뒤 공백과 대소문자만 접는다", () => {
  assert.equal(normalizeInviteEmail("  Hana@LVLY.io "), "hana@lvly.io");
  assert.equal(normalizeInviteEmail("HANA@LVLY.IO"), "hana@lvly.io");
});

test("E7 이메일: 제공자별 규칙은 흉내 내지 않는다(플러스주소·점 보존)", () => {
  // 접어 버리면 '초대한 주소'와 '수락하는 주소'가 달라져 본인이 자기 초대를 못 받는다.
  assert.equal(normalizeInviteEmail("a.b+team@lvly.io"), "a.b+team@lvly.io");
});

test("E8 이메일: 빈 값·공백·부재는 거부", () => {
  for (const bad of ["", "   ", undefined, null]) {
    assert.throws(() => normalizeInviteEmail(bad), /이메일 형식/, `거부했어야 한다: ${JSON.stringify(bad)}`);
  }
});

test("E9 이메일: 형식이 아니면 거부", () => {
  for (const bad of ["hana", "hana@", "@lvly.io", "hana@lvly", "a b@lvly.io"]) {
    assert.throws(() => normalizeInviteEmail(bad), /이메일 형식/, `거부했어야 한다: '${bad}'`);
  }
});

// ── C. 초대 상태·권한 (E10–E15) ─────────────────────────────────────────────

test("E10·E11 보류인 초대만 처리된다 — 끝난 초대를 되살리는 경로는 없다", () => {
  assert.equal(inviteResolvable("pending"), true);
  for (const st of ["accepted", "declined", "revoked"] as const) {
    assert.equal(inviteResolvable(st), false, `${st} 인 초대가 다시 처리 가능하다`);
  }
});

test("E12·E13 결정하는 사람이 갈린다 — 수락·거절은 받는 사람, 취소는 보낸 owner", () => {
  assert.equal(inviteDecisionActor("accept"), "recipient");
  assert.equal(inviteDecisionActor("decline"), "recipient");
  assert.equal(inviteDecisionActor("revoke"), "owner");
});

test("E10 결정 → 다음 상태", () => {
  assert.equal(inviteNextState("accept"), "accepted");
  assert.equal(inviteNextState("decline"), "declined");
  assert.equal(inviteNextState("revoke"), "revoked");
});

test("E14 받는 사람 확인: 대소문자·공백만 다른 건 같은 사람이다", () => {
  // 저장은 정규화된 소문자로 되지만, 처리자 이메일은 어디서 오든(프로필 편집·IdP) 손대지 않은 값일 수 있다.
  assert.equal(inviteRecipientMatches("hana@lvly.io", "  Hana@LVLY.io "), true);
  assert.equal(inviteRecipientMatches("hana@lvly.io", "hana@lvly.io"), true);
});

test("★ E15 받는 사람 확인은 fail-closed — 이메일이 없으면 통과시키지 않는다", () => {
  // "이메일이 없으니 통과"면 초대 id 만 아는 사람이 남의 워크스페이스에 들어온다.
  for (const actor of [null, undefined, "", "   "]) {
    assert.equal(inviteRecipientMatches("hana@lvly.io", actor), false, `통과시키면 안 된다: ${JSON.stringify(actor)}`);
  }
  assert.equal(inviteRecipientMatches("hana@lvly.io", "won@lvly.io"), false);
});

// ── D. 구조 (E16–E18) ───────────────────────────────────────────────────────

test("★ E16 초대 표는 테넌트 축 **밖**이다 — 받는 사람은 남의 워크스페이스 초대를 자기 자리에서 본다", () => {
  assert.ok(TENANT_COLUMN_EXEMPT.has("gw_workspace_invite"),
    "gw_workspace_invite 가 TENANT_COLUMN_EXEMPT 에 없다 — tenant_id 가 붙으면 '나에게 온 초대' 조회가 성립하지 않는다");
});

test("★ E16 보류 유니크는 **부분**이다 — 거절·취소 뒤 다시 부를 수 있어야 한다", () => {
  const ddl = readSrc("src/org/schema/workspace-registry.ts");
  const m = ddl.match(/CREATE UNIQUE INDEX IF NOT EXISTS gw_workspace_invite_pending_uq[\s\S]*?;/);
  assert.ok(m, "보류 중복을 막는 유니크 인덱스가 없다 — 같은 사람을 두 번 부를 수 있다");
  assert.match(m![0], /WHERE\s+state\s*=\s*'pending'/,
    "유니크가 전체 범위다 — 한 번 거절하면 그 사람은 다시는 못 부른다");
});

test("★ E17 매니지드 공용 DB 게이트에도 같은 표가 등재돼 있다(쌍) — 없으면 프로비저닝이 fail-closed 로 막힌다", () => {
  // 그 레포가 옆에 없는 환경(고객 박스·CI)에서는 건너뛴다 — 없는 파일로 빌드를 깨지 않는다.
  let src: string;
  try {
    src = readFileSync(path.join(repoRoot(), "..", "lvly-cloud", "control", "src", "tenantrls.ts"), "utf8");
  } catch { return; }
  assert.match(src, /"gw_workspace_invite"/,
    "lvly-cloud tenantrls.RLS_EXEMPT_TABLES 에 gw_workspace_invite 가 없다 — 매니지드 프로비저닝이 막힌다");
});

test("★ E18 개인 워크스페이스를 막던 벽이 없다 — 그 벽이 곧 개인→팀 경로였다", () => {
  const src = readSrc("src/capabilities/delivery/workspace-registry.ts");
  assert.doesNotMatch(src, /throw new HttpError\(400, "개인 워크스페이스에는 멤버를 넣을 수 없습니다"\)/,
    "종전의 차단이 남아 있다 — 사람이 들어오는 것이 곧 전환이므로 이 벽은 없어야 한다");
  assert.match(src, /workspace_invite_resolve/, "초대 처리(accept/decline/revoke) capability 가 없다");
});

// ── E. #1875 D5' (2026-08-27 장원준) — 「팀원이 있으면 삭제(보관) 금지, 나가기만」 ────
//
//  「팀원들이 있는 경우에는 워크스페이스를 내가 삭제하는건 안 되고, 마지막 남아있는(=나 혼자인) 때만
//   가능하게. 팀 스페이스에서는 나가는 것밖에 안 되게.」
//
//  코어의 «삭제»는 보관(archive)이지만 등록부 state 를 내리는 것이라 **모두의 접근이 끊긴다** —
//  «되돌릴 수 있으니 괜찮다»가 이 결정을 비껴가지 못하는 이유다. 아래 잠금이 빠지면 owner 한 명이
//  남의 자료를 남의 동의 없이 닫을 수 있는 상태로 조용히 되돌아간다.

test("E30 보관은 인원수 게이트를 지난다 — 판정 기준은 2명, 역할·kind 컬럼이 아니다", () => {
  const src = readSrc("src/capabilities/delivery/workspace-registry.ts");
  const at = src.indexOf('restWork("workspace_delete"');
  assert.ok(at > 0, "workspace_delete 가 없다");
  const body = src.slice(at, src.indexOf('restWork("workspace_member_add"', at));
  const gate = body.indexOf("countWorkspaceMembers(ws.id)");
  const act = body.indexOf("archiveWorkspace(ws.id)");
  assert.ok(gate > 0, "인원을 세지 않는다 — owner 가 팀 워크스페이스를 통째로 닫을 수 있다");
  assert.ok(act > gate, "보관이 인원수 게이트보다 앞이다");
  assert.match(body.slice(gate, act), /n\s*>=\s*2/, "판정 임계가 2명이 아니다");
});

test("E31 나가기가 있다 — 삭제를 막았으면 나갈 문이 있어야 한다(없으면 갇힘이다)", () => {
  const src = readSrc("src/capabilities/delivery/workspace-registry.ts");
  const at = src.indexOf('restWork("workspace_leave"');
  assert.ok(at > 0, "workspace_leave 가 없다 — 팀에서 나갈 문이 없으면 보관 금지는 갇힘이 된다");
  const body = src.slice(at, src.indexOf('restRead("workspace_people"', at));
  assert.match(body, /"\/api\/ui\/me\/workspaces\/leave"/, "REST 경로가 없다");
  //  #1875 D5″ — 갈래(혼자냐 · 어드민이 나뿐이냐 · 아니냐)는 이제 핸들러가 세지 않고
  //   registry.planWorkspaceLeave **한 벌**이 정한다. 규칙 자체의 엣지는 그쪽 테스트가 잡는다
  //   (workspace-leave-transfer.test.ts E1~E12). 여기서는 **핸들러가 그 한 벌을 따르는지**만 본다 —
  //   핸들러가 자기 판정을 되살리면 화면·서버·MCP 가 서로 다른 말을 하기 시작한다.
  assert.match(body, /const plan = planWorkspaceLeave\(\{[\s\S]{0,400}ownerMember: ws\.owner_member/,
    "★ 나가기 갈래를 한 벌(planWorkspaceLeave)로 안 정한다 — 핸들러가 규칙을 따로 세면 갈린다");
  assert.match(body, /if \(!plan\.ok\) throw leaveRefusal\(/, "거절을 사람 말로 옮기는 자리가 없다");
  assert.ok(body.indexOf("transferWorkspaceOwner") < body.indexOf("removeWorkspaceMember(ws.id, id)"),
    "★ 주인을 넘기기 전에 먼저 나가진다 — 넘기기가 실패하면 주인 없는 팀이 남는다");
  assert.match(body, /removeWorkspaceMember\(ws\.id, id\)/, "명부에서 안 빠진다");
  assert.ok(!body.includes("requireOwner"), "구성원이 자기 발로 나갈 수 없다 — 나가기는 owner 전용이 아니다");
});

test("E32 화면도 같은 규칙을 쓴다 — 갈래를 인원·어드민 수로 가른다", () => {
  //  #1875 D5″ — 떠나는 문이 «설정 판의 한 줄»(exitRow)에서 «목록 행의 ✕»로 옮겨 갔다.
  //   화면 구조의 엣지는 workspace-exit-ui.test.ts 가 전담한다(E1~E11 + 돌연변이 확인).
  //   여기서는 그 한 가지만 본다 — **화면의 임계가 서버와 같은 축인가.** 축이 갈리면 눌러도 400 만 난다.
  const rail = readSrc("web/v2/rail.ts");
  const at = rail.indexOf("function openExitInline(");
  assert.ok(at > 0, "떠나는 문을 고르는 자리가 없다 — 화면과 서버가 갈리면 눌러도 400 만 난다");
  const body = rail.slice(at, at + 1400);
  assert.match(body, /\(w\.member_count \?\? 1\) < 2/, "화면의 '혼자' 임계가 서버(2명)와 다르다");
  assert.match(body, /\(w\.owner_count \?\? 1\) < 2/, "화면이 어드민 수를 안 본다 — 서버는 그걸로 갈린다");
});
