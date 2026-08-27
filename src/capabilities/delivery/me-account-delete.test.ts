// #1876 회원 탈퇴 — 두 배포(매니지드·셀프호스트)의 갈림과, **빠지면 탈퇴가 조용히 무효가 되는 자리**.
//
//  두 종류가 섞여 있다:
//   · 마지막 관리자 판정은 **순수 함수**라 실제 입력을 넣어 결과로 단언한다.
//   · 나머지는 DB·HTTP 바운드라 유닛으로 못 잡으므로 소스에서 못박는다(account-delete.test.ts 선례).
//     이 잠금이 없으면 누군가 게이트 한 줄을 지워도 테스트는 초록불이고, 탈퇴는 "화면에서만 된 것"이 된다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { wouldOrphanAdmins } from "./me-account-delete.js";

const src = readFileSync("src/capabilities/delivery/me-account-delete.ts", "utf8");
const modal = readFileSync("web/v2/me-modal.ts", "utf8");
const local = readFileSync("src/auth/local-accounts.ts", "utf8");

const m = (id: string, scopes: string[], state = "active", kind = "human") => ({ id, kind, state, scopes });

// ── 마지막 관리자 판정 — 실제 입력으로 ────────────────────────────────────────
test("★★ 내가 마지막 활성 관리자면 막는다 — 관리자 0인 박스를 남기지 않는다", () => {
  assert.equal(wouldOrphanAdmins("me", ["admin"], [m("me", ["admin"]), m("bob", ["items"])]), true);
});

test("다른 활성 관리자가 있으면 막지 않는다", () => {
  assert.equal(wouldOrphanAdmins("me", ["admin"], [m("me", ["admin"]), m("bob", ["admin"])]), false);
});

test("★★ 다른 관리자가 **비활성**이면 관리자가 없는 것이다 — 막는다", () => {
  // 이미 탈퇴한 사람을 관리자로 세어 주면, 두 번째 사람이 나가는 순간 박스가 잠긴다.
  assert.equal(wouldOrphanAdmins("me", ["admin"], [m("me", ["admin"]), m("bob", ["admin"], "inactive")]), true);
});

test("★★★ admin 을 든 **에이전트**는 관리자로 세지 않는다 — 토큰이 끊기면 되돌릴 사람이 없다", () => {
  // dev 의 `daon` 이 정확히 이 모양이다(kind=agent, scopes 에 admin). 세어 주면 마지막 사람 관리자가
  //  그냥 나가지고, 그 뒤엔 웹으로 들어가 복구할 사람이 아무도 없다.
  assert.equal(wouldOrphanAdmins("me", ["admin"],
    [m("me", ["admin"]), m("daon", ["admin"], "active", "agent")]), true);
});

test("★ 시스템 구성원도 마찬가지다", () => {
  assert.equal(wouldOrphanAdmins("me", ["admin"],
    [m("me", ["admin"]), m("sync", ["admin"], "active", "system")]), true);
});

test("내가 관리자가 아니면 언제나 통과한다 — 줄어들 관리자가 없다", () => {
  assert.equal(wouldOrphanAdmins("me", ["items"], [m("me", ["items"])]), false);
});

test("★ 나 자신은 '다른 관리자'로 세지 않는다(id 로 제외)", () => {
  // 자기를 세면 마지막 관리자가 늘 통과해 버린다 — 이 가드가 통째로 무력해지는 자리다.
  assert.equal(wouldOrphanAdmins("me", ["admin"], [m("me", ["admin"])]), true);
});

// ── 갈림은 노브 하나 ────────────────────────────────────────────────────────
test("★★ 매니지드/셀프호스트 갈림은 workspace_hub_url 하나다 — 축을 둘로 늘리지 않는다", () => {
  assert.match(src, /const hub = \(cfg\.workspace_hub_url \|\| ""\)\.trim\(\)/, "노브를 안 본다");
  // 주소가 깨졌으면 셀프호스트로 **떨어뜨리면 안 된다** — 엉뚱한 대상을 지운다.
  const at = src.indexOf("async function hubOrigin");
  const body = src.slice(at, src.indexOf("\n}", at));
  assert.ok(!/catch \{ return null/.test(body),
    "hub_url 파싱 실패를 셀프호스트로 떨어뜨린다 — 매니지드 계정 대신 코어 구성원을 지우게 된다");
  assert.match(body, /throw new HttpError\(400/, "깨진 주소를 끊지 않는다");
});

// ── 셀프호스트 실행 — 순서가 곧 안전이다 ────────────────────────────────────
test("★★ 셀프호스트 실행은 (확인 → 차단검사 → 쓰기) 순서다", () => {
  const at = src.indexOf('restRead("me_account_delete"');
  assert.ok(at > 0, "실행 표면이 없다");
  const body = src.slice(at);
  const confirm = body.search(/confirm\.trim\(\)\.toLowerCase\(\) !== email\.toLowerCase\(\)/);
  const guard = body.indexOf("wouldOrphanAdmins(me.id, me.scopes, all)");
  const write = body.indexOf('upsertMember({ id: me.id, kind: "human", state: "inactive" }');
  assert.ok(confirm > 0, "확인 문구 대조가 없거나 대소문자를 구분한다");
  assert.ok(guard > confirm, "차단 검사가 확인보다 앞이다");
  assert.ok(write > guard, "쓰기가 차단 검사보다 앞이다 — 반쯤 실행된 탈퇴가 남는다");
});

test("★★ 비활성으로 내리고 비밀번호 자격을 지운다", () => {
  assert.match(src, /state: "inactive"/, "구성원을 비활성으로 내리지 않는다 — 세션도 로그인도 안 끊긴다");
  assert.match(src, /clearMemberPassword\(me\.id\)/, "비밀번호 해시가 남는다");
  assert.match(local, /DELETE FROM member_credential WHERE member_id=\$1/, "자격 삭제 SQL 이 없다");
});

test("★★★ 셀프호스트 탈퇴가 이메일을 지우지 않는다 — 그게 재입장을 막는 자물쇠다", () => {
  // oidc-login 의 ② 갈래는 memberIdByEmail(state 필터 없음)로 비활성 행을 찾아 거절한다.
  //  이메일을 지우면 그 조회가 빗나가고 allowed_domains 조직에서 ③ 자동가입이 같은 사람을 다시 들인다.
  const at = src.indexOf('restRead("me_account_delete"');
  const body = src.slice(at);
  assert.ok(!/email:\s*(null|"")/.test(body), "탈퇴가 구성원 이메일을 비운다 — 자동가입으로 되돌아올 수 있다");
});

test("★ 그 자물쇠가 실제로 걸려 있는지 — 이메일 조회는 state 로 거르지 않아야 한다", () => {
  // 위 테스트의 전제. 여기가 state='active' 로 바뀌면 이메일을 안 지워도 자물쇠가 풀린다.
  const members = readFileSync("src/org/store/members.ts", "utf8");
  const at = members.indexOf("export async function memberIdByEmail");
  const body = members.slice(at, at + 320);
  assert.ok(!/state\s*=\s*'active'/.test(body),
    "memberIdByEmail 이 활성만 찾는다 — 탈퇴자가 자동가입으로 새 구성원이 되어 되돌아온다");
});

// ── 화면 ────────────────────────────────────────────────────────────────────
test("★★ 설정 창은 배포 종류로 항목을 숨기지 않는다 — '탈퇴가 없는데?' 가 여기서 났다", () => {
  const at = modal.indexOf("회원 탈퇴(#1876)");
  assert.ok(at > 0, "탈퇴 항목이 없다");
  const body = modal.slice(at, at + 1400);
  assert.ok(!/if \(hubUrl\)/.test(body),
    "hub_url 로 항목을 가린다 — 셀프호스트에서 탈퇴가 통째로 사라진다(실측 회귀)");
  assert.match(body, /accountDeleteModal\(\)/, "항목이 창을 열지 않는다");
});

test("★ 무엇을 뜻하는지는 서버 판정(plan.mode)으로 갈린다 — 화면이 알아맞히지 않는다", () => {
  assert.match(modal, /plan\.mode === 'selfhost'/, "화면이 배포 종류를 서버에서 받지 않는다");
  assert.match(modal, /plan\.last_admin/, "마지막 관리자 차단을 화면이 그리지 않는다");
});
