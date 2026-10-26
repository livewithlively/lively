// 계정이 아직 없는 사람의 AI 목록(#5031, profiles.ts aiAccountStatus) — 게이트웨이 공용 홈의 자격이 그 사람 것처럼 «연결됨» 으로 새지 않는다.
//  왜: 격리 박스에서 그 사람의 OS 계정(box_<사람>)이 없으면 종전엔 프로필/공용 분기로 떨어져 게이트웨이 유저 홈의 자격을 읽었다. 그래서
//   처음 설정은 계정이 다 만들어질 때까지 목록을 숨겨야 했고, 계정을 미리(인사 장면에서) 만들었다. 이제 계정은 [연결] 때 만든다 —
//   그 전에 그리는 목록이 정직해야 한다(계정이 없으면 어느 AI 에도 로그인돼 있을 수 없다).
//  실제 함수를 샌드박스 HOME 으로 부른다 — 공용 홈에 세 AI 자격 파일을 놓아 두고 무엇이 «연결됨» 으로 나오는지 본다.
//  엣지 표:
//   A1 격리 장치 · 계정 없음 · 공용 홈에 자격 있음 → 모든 줄 isolated · loggedIn false · pending · 로그아웃 잠금
//   A2 격리 장치 · 계정 있음 → 종전(그 사람 홈에서 잰 값 · pending 없음)
//   A3 격리 장치 없음 → 종전(공용 홈을 본다 — 이 시험의 배선 확인이기도 하다: 공용 자격이 실제로 보인다)
//   A4 중계 배포(매니지드) · 계정 없음 → 종전(중계로 잰 값 · pending 없음)
//   A5 사람 id 가 없는 토큰 → pending 아님(계정을 만들 수 없는 주체 — memberOsState 의 none 과 같은 축)
//   A6 구성원이 아닌 주체(에이전트 토큰 등 — getMember 없음) → pending 아님 · 종전(공용) 판정 그대로
//   A7 홈만 남은 계정(orphanHome) → pending 이되 로그인은 «모름»(null) — 다시 만들면 그 홈의 자격을 이어받을 수 있다
//  실행: npm run build && node dist/terminal/ai-account-pending.test.js
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LivelyUser } from "../context.js";
import type { MemberOsStatus } from "./profiles.js";

const HOME = mkdtempSync(path.join(tmpdir(), "ai-acct-pending-"));
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
for (const rel of [".claude/.credentials.json", ".codex/auth.json", ".grok/auth.json"]) {
  mkdirSync(path.dirname(path.join(HOME, rel)), { recursive: true });
  writeFileSync(path.join(HOME, rel), "{}");
}
process.env.LIVELY_MULTIPROFILE = "0";   // claude 도 공용 홈을 보게(프로필 분기 대신) — 공용 자격 누출을 셋 다로 잰다
delete process.env.LIVELY_MEMBER_EXEC;

const { aiAccountStatus } = await import("./profiles.js");
const { unfreezeExecTopology } = await import("../exec-topology.js");
unfreezeExecTopology();

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const person = { userId: "mem-a", email: "a@example.com", scopes: [], projects: [] } as unknown as LivelyUser;
const os = (o: Partial<MemberOsStatus>) => ({ ready: true, provisioned: false, osUser: "box_mem-a", loggedInHarnesses: [], ...o }) as unknown as MemberOsStatus;
const MEMBER = { isMember: async () => true };
const byKey = (rows: Awaited<ReturnType<typeof aiAccountStatus>>) => Object.fromEntries(rows.map((r) => [r.key, r]));
const FILE_KEYS = ["claude", "codex", "grok"];
// 맥의 claude 는 공용 분기에서 키체인을 본다(이 기계 상태) — 공용 분기를 재는 A3 에서는 빼고 본다.
const SHARED_KEYS = process.platform === "darwin" ? ["codex", "grok"] : FILE_KEYS;

try {
  await t("A3 배선 — 격리 장치가 없으면 공용 홈의 자격이 보인다(아래 A1 의 «안 보임» 이 공허하지 않다는 근거)", async () => {
    const r = byKey(await aiAccountStatus(person, os({ ready: false })));
    for (const k of SHARED_KEYS) {
      assert.equal(r[k]?.loggedIn, true, `${k}: 공용 자격 파일을 못 봤다 — 샌드박스 배선이 틀렸다`);
      assert.equal(r[k]?.scope, "shared", `${k}: 공용 분기가 아니다`);
      assert.equal(r[k]?.pending, undefined, `${k}: 격리 장치가 없는데 pending 이다`);
    }
  });

  await t("A1 ★ 격리 장치 · 계정 없음 → 공용 자격이 새지 않는다 · 모든 줄 «연결 전»(pending) · 로그아웃 잠금", async () => {
    const rows = await aiAccountStatus(person, os({ ready: true, provisioned: false }), MEMBER);
    const r = byKey(rows);
    for (const k of FILE_KEYS) {
      assert.ok(r[k], `${k}: 줄이 없다`);
      assert.equal(r[k].loggedIn, false, `★ ${k}: 계정이 없는 사람에게 게이트웨이 공용 자격이 «연결됨» 으로 보인다`);
      assert.equal(r[k].scope, "isolated", `${k}: «이 서버 공용 계정» 으로 그려진다`);
      assert.equal(r[k].pending, true, `${k}: pending 이 없다 — 화면이 [연결]에서 계정을 먼저 만들지 못한다`);
      assert.equal(r[k].canLogout, false, `${k}: 없는 계정의 로그아웃이 열려 있다`);
    }
    for (const row of rows) assert.notEqual(row.scope, "shared", `${row.key}: 공용 줄이 남았다`);
  });

  await t("A2 격리 장치 · 계정 있음 → 그 사람 홈에서 잰 값 · pending 없음", async () => {
    const r = byKey(await aiAccountStatus(person, os({ ready: true, provisioned: true, loggedInHarnesses: ["codex"] })));
    assert.equal(r.codex.loggedIn, true);
    assert.equal(r.claude.loggedIn, false, "그 사람 홈에 없는 자격을 공용에서 가져왔다");
    for (const k of FILE_KEYS) { assert.equal(r[k].scope, "isolated"); assert.equal(r[k].pending, undefined, `${k}: 계정이 있는데 pending 이다`); }
  });

  await t("A4 중계 배포(매니지드) · 계정 없음 → 중계로 잰 값 · pending 없음(매니지드는 계정 개념이 없다)", async () => {
    process.env.LIVELY_MEMBER_EXEC = "/bin/true"; unfreezeExecTopology();
    try {
      const r = byKey(await aiAccountStatus(person, os({ ready: true, provisioned: false, loggedInHarnesses: ["grok"] })));
      assert.equal(r.grok.loggedIn, true, "★ 매니지드에서 중계로 잰 로그인이 지워졌다");
      for (const k of FILE_KEYS) { assert.equal(r[k].scope, "isolated"); assert.equal(r[k].pending, undefined, `${k}: 매니지드에서 pending 이 됐다`); }
    } finally { delete process.env.LIVELY_MEMBER_EXEC; unfreezeExecTopology(); }
  });

  await t("A5 사람 id 가 없는 토큰 → pending 아님(계정을 만들 수 없는 주체)", async () => {
    const nobody = { userId: "", email: "", scopes: [], projects: [] } as unknown as LivelyUser;
    const rows = await aiAccountStatus(nobody, os({ ready: true, provisioned: false }), MEMBER);
    for (const row of rows) assert.equal(row.pending, undefined, `${row.key}: 사람 id 없이 pending 이 됐다`);
  });

  await t("A6 구성원이 아닌 주체 → pending 아님 · 종전(공용) 판정 그대로", async () => {
    let asked = "";
    const r = byKey(await aiAccountStatus(person, os({ ready: true, provisioned: false }), { isMember: async (id) => { asked = id; return false; } }));
    assert.equal(asked, "mem-a", "배선 — 구성원인지 묻지 않았다");
    for (const k of SHARED_KEYS) {
      assert.equal(r[k].pending, undefined, `${k}: 구성원이 아닌데 pending 이 됐다(계정이 만들어지지 않는 주체다)`);
      assert.equal(r[k].scope, "shared", `${k}: 공용으로 도는 주체의 판정이 바뀌었다`);
    }
  });

  await t("A7 홈만 남은 계정 → pending · 로그인은 «모름»(null)", async () => {
    const r = byKey(await aiAccountStatus(person, os({ ready: true, provisioned: false, orphanHome: true }), MEMBER));
    for (const k of FILE_KEYS) {
      assert.equal(r[k].pending, true, `${k}: pending 이 아니다`);
      assert.equal(r[k].loggedIn, null, `${k}: 홈만 남은 계정을 «미로그인» 으로 접었다(모르면 false 로 접지 않는다)`);
    }
  });
} finally {
  rmSync(HOME, { recursive: true, force: true });
}

console.log(`ai-account-pending.test: ${pass} ok`);
