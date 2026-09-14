// #1631 결정(원준 2026-09-13: «그 운영계정은 실제 사람 아니고 사용자한테 필요 없다») — **사람이 아닌 구성원은 로그인할 수 없다.**
//
//  계정 서버가 테넌트마다 심는 운영 구성원(admin, ops@lvly.io)이 kind=human + 이메일로 만들어져
//   org_member_upsert 의 «새 human + 이메일 → 초기 비밀번호 자동 발급»(capabilities/delivery/members.ts)을 타고
//   로그인 자격을 얻었다. 계정 서버가 그 구성원을 system 으로 다시 심어도 **이미 생긴 자격·세션은 남는다** —
//   그래서 종류가 사람이 아니게 저장되는 순간 저장 계층이 치우고, 로그인 판정도 사람만 찾는다(두 겹).
//
//  DB 바운드라 유닛으로 끝까지 못 몬다 — 구조를 소스에서 못박는다(me-account-delete.test.ts 선례).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const MEMBERS = readFileSync("src/org/store/members.ts", "utf8");
const LOCAL = readFileSync("src/auth/local-accounts.ts", "utf8");

/** 함수 하나의 본문만 떼어 낸다(다음 최상위 export 전까지). */
function fnBody(src: string, sig: string): string {
  const at = src.indexOf(sig);
  assert.ok(at >= 0, `함수를 찾지 못했다: ${sig}`);
  const next = src.slice(at + sig.length).search(/\nexport /);
  return next > 0 ? src.slice(at, at + sig.length + next) : src.slice(at);
}

test("★★ 사람이 아닌 구성원으로 저장되면 로그인 자격(비밀번호)을 지운다", () => {
  const body = fnBody(MEMBERS, "export async function upsertMember(");
  assert.match(body, /kind !== "human"[\s\S]{0,600}DELETE FROM member_credential WHERE member_id=\$1/,
    "★ 종류가 system·agent 로 바뀌어도 비밀번호가 남는다 — 운영 계정이 계속 로그인할 수 있다");
});

test("★★ 사람이 아닌 구성원의 웹 로그인 세션도 거둔다", () => {
  const body = fnBody(MEMBERS, "export async function upsertMember(");
  assert.match(body, /kind !== "human"[\s\S]{0,800}UPDATE web_session SET revoked_at=now\(\) WHERE member_id=\$1 AND revoked_at IS NULL/,
    "종류를 바꿔도 이미 열린 세션이 30일 동안 살아 있다");
});

test("★ 로그인 판정이 사람만 찾는다 — 자격이 어떤 경로로 남아 있어도 system·agent 는 못 들어온다", () => {
  const body = fnBody(LOCAL, "export async function verifyLogin(");
  assert.match(body, /FROM org_member WHERE lower\(email\)=\$1 AND state='active' AND kind='human'/,
    "로그인 조회가 구성원 종류를 안 본다 — 사람이 아닌 계정도 비밀번호만 있으면 들어온다");
});

const SESSIONS = readFileSync("src/auth/sessions.ts", "utf8");

test("★ 웹 로그인 세션도 사람만 통과한다 — 종류가 바뀌기 전에 열린 세션이 남아 있어도 막힌다", () => {
  //  계정 서버가 운영 구성원을 system 으로 바꾸는 시점이 이 코어보다 먼저면(옛 코어에서 전환) upsertMember 의 회수가
  //   안 돌아 옛 세션이 30일 동안 남는다. 세션 → 사람 판정 자리에서도 종류를 본다(세 번째 겹).
  const body = fnBody(SESSIONS, "export async function userFromSession(");
  assert.match(body,
    /FROM web_session s JOIN org_member m ON m\.id = s\.member_id\s+WHERE s\.session_hash=\$1 AND s\.revoked_at IS NULL AND s\.expires_at > now\(\) AND m\.kind='human'/,
    "세션 판정이 구성원 종류를 안 본다 — 사람이 아닌 구성원의 옛 세션이 계속 통과한다");
});
