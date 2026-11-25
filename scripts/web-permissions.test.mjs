// 화면용 권한 · 역할 값(web/lib/permissions.ts) — 서버 값(src/auth/permissions.ts)과 갈라지지 않는가, 그리고 화면 헬퍼.
//  컴파일된 모듈 둘(public/app/lib/permissions.js · dist/auth/permissions.js)을 맞댄다. 빌드가 없으면 건너뛴다.
//
//  엣지 표:
//   W1 권한 10개 · 역할 4개의 이름과 순서가 서버와 같다
//   W2 역할이 주는 권한이 서버와 글자까지 같다(역할 4 × 권한 10)
//   W3 화면 이름 · 정의 · 수준 고르는 방식이 서버와 같다 · 역할 이름이 서버와 같다
//   W4 «할 수 있는 일» 글이 권한마다 있다(보기/고치기 권한은 둘 다 · 있다/없다 권한은 하나 · DB 는 조회)
//   W5 grantsFor — 역할 + 개별 추가는 올리기만 · 모르는 역할은 개별 추가만 · 모르는 수준은 버린다
//   W6 levelText — 없음 · 보기 · 고치기 · 있음(세션 · 원격 실행) · 조회(DB)
//   W7 extraChoices — 역할이 이미 주는 것보다 높은 수준만 · 소유자는 얹을 것이 없다 · DB 는 조회뿐
//   W8 suggestRole — admin+runtime → 소유자 · admin → 관리자 · 그 밖 → 구성원 · 권한 없음 → 게스트
//   W10 배선 — DB 소스 화면이 조회 대상(구성원 · 팀)을 읽고 통째로 저장한다 · 팀 폼이 종류를 보낸다
//   W9 배선 — 구성원 폼은 역할을 고르면 role · grants 만 보내고 scopes 를 보내지 않는다 · 옛 방식으로 되돌리면 role:null · 새 셸 메뉴는 역할 구성원을 역할로 올리고 내린다
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webMod = join(root, "public/app/lib/permissions.js");
const srvMod = join(root, "dist/auth/permissions.js");
if (!existsSync(webMod) || !existsSync(srvMod)) { console.log("web-permissions: 빌드 없음(public/app/lib/permissions.js · dist/auth/permissions.js) — 건너뜀"); process.exit(0); }
const W = await import(pathToFileURL(webMod).href);
const S = await import(pathToFileURL(srvMod).href);

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };
const code = (rel) => readFileSync(join(root, rel), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

t("W1 권한 · 역할의 이름과 순서가 서버와 같다", () => {
  assert.deepEqual(W.PERMISSION_KEYS, [...S.PERMISSIONS]);
  assert.deepEqual(W.ROLE_KEYS, [...S.ROLES]);
  assert.equal(W.PERMISSION_KEYS.length, 10);
});

t("W2 역할이 주는 권한이 서버와 같다", () => {
  assert.deepEqual(Object.keys(W.ROLE_GRANTS).sort(), [...S.ROLES].sort());
  for (const r of S.ROLES) {
    for (const p of S.PERMISSIONS) assert.equal(W.ROLE_GRANTS[r][p], S.ROLE_GRANTS[r][p], `${r} · ${p}`);
    assert.deepEqual(Object.keys(W.ROLE_GRANTS[r]).sort(), Object.keys(S.ROLE_GRANTS[r]).sort(), `${r} 의 권한 목록`);
  }
});

t("W3 화면 이름 · 정의 · 수준 방식이 서버와 같다", () => {
  assert.deepEqual(Object.keys(W.PERMISSION_INFO).sort(), [...S.PERMISSIONS].sort());
  for (const p of S.PERMISSIONS) {
    assert.equal(W.PERMISSION_INFO[p].label, S.PERMISSION_INFO[p].label, `${p} 이름`);
    assert.equal(W.PERMISSION_INFO[p].definition, S.PERMISSION_INFO[p].definition, `${p} 정의`);
    assert.equal(W.PERMISSION_INFO[p].levels, S.PERMISSION_INFO[p].levels, `${p} 수준 방식`);
  }
  for (const r of S.ROLES) assert.equal(W.ROLE_INFO[r].label, S.ROLE_INFO[r].label, `${r} 이름`);
});

t("W4 «할 수 있는 일» 글이 권한마다 있다", () => {
  for (const p of W.PERMISSION_KEYS) {
    const info = W.PERMISSION_INFO[p];
    if (info.levels === "read-write") assert.ok(info.read && info.write && info.read !== info.write, `${p} — 보기와 고치기가 다른 글이어야 한다`);
    if (info.levels === "on-off") assert.ok(info.write, `${p} — 있음의 글`);
    if (info.levels === "read-only") assert.ok(info.read, `${p} — 조회의 글`);
    assert.ok(W.abilityText(p, "read").length > 0 && W.abilityText(p, "write").length > 0, `${p} — 어느 수준이든 빈 글이 아니다`);
    assert.equal(W.abilityText(p, undefined), "", "권한이 없으면 글도 없다");
  }
  assert.equal(W.abilityText("nope", "write"), "");
});

t("W5 grantsFor — 역할 + 개별 추가는 올리기만 한다", () => {
  assert.deepEqual(W.grantsFor("guest"), { content: "read" });
  assert.deepEqual(W.grantsFor("guest", { content: "write", session: "write" }), { content: "write", session: "write" });
  assert.equal(W.grantsFor("member", { content: "read" }).content, "write", "낮추지 못한다");
  assert.equal(W.grantsFor("member", { code: "write" }).code, "write");
  assert.deepEqual(W.grantsFor("member", { code: "all", nope: "write", db: null }), W.ROLE_GRANTS.member, "모르는 수준 · 권한은 버린다");
  assert.deepEqual(W.grantsFor(null, { content: "read" }), { content: "read" });
  assert.deepEqual(W.grantsFor("superuser"), {});
  assert.deepEqual(W.grantsFor("member", null), W.ROLE_GRANTS.member);
  // 서버의 합치기와 같은 결과(역할 4 × 개별 추가 표본)
  for (const r of S.ROLES) for (const ex of [{}, { code: "write" }, { harness: "write", secrets: "read" }, { content: "read" }]) {
    assert.deepEqual(W.grantsFor(r, ex), { ...S.mergeGrants(S.ROLE_GRANTS[r], ex) }, `${r} + ${JSON.stringify(ex)}`);
  }
  // 원본 역할 표를 건드리지 않는다
  W.grantsFor("guest", { admin: "write" });
  assert.deepEqual(W.ROLE_GRANTS.guest, { content: "read" });
});

t("W6 levelText — 수준을 사람 말로", () => {
  assert.equal(W.levelText("content", undefined), "없음");
  assert.equal(W.levelText("content", "read"), "보기");
  assert.equal(W.levelText("content", "write"), "고치기");
  assert.equal(W.levelText("session", "write"), "있음");
  assert.equal(W.levelText("run", "read"), "있음");
  assert.equal(W.levelText("db", "read"), "조회");
  assert.equal(W.levelText("session", undefined), "없음");
});

t("W7 extraChoices — 역할이 주는 것보다 높은 수준만", () => {
  assert.deepEqual(W.extraChoices("member", "code"), ["write"]);
  assert.deepEqual(W.extraChoices("member", "content"), []);
  assert.deepEqual(W.extraChoices("member", "db"), []);
  assert.deepEqual(W.extraChoices("member", "admin"), ["read", "write"]);
  assert.deepEqual(W.extraChoices("member", "harness"), ["write"]);
  assert.deepEqual(W.extraChoices("guest", "session"), ["write"]);
  assert.deepEqual(W.extraChoices("guest", "db"), ["read"]);
  assert.deepEqual(W.extraChoices("guest", "content"), ["write"]);
  assert.deepEqual(W.extraChoices("admin", "secrets"), ["write"]);
  for (const p of W.PERMISSION_KEYS) assert.deepEqual(W.extraChoices("owner", p), [], `소유자 · ${p}`);
  // 얹을 수 있다고 한 수준은 실제로 권한을 올린다
  for (const r of W.ROLE_KEYS) for (const p of W.PERMISSION_KEYS) for (const lv of W.extraChoices(r, p)) {
    assert.equal(W.grantsFor(r, { [p]: lv })[p], lv, `${r} · ${p} · ${lv}`);
  }
});

t("W8 suggestRole — 지금 권한과 가장 가까운 역할", () => {
  assert.equal(W.suggestRole(["items", "context", "memory", "db", "code"]), "member");
  assert.equal(W.suggestRole(["items", "context", "memory", "admin"]), "admin");
  assert.equal(W.suggestRole(["admin", "runtime", "memory"]), "owner");
  assert.equal(W.suggestRole(["runtime", "memory"]), "member", "runtime 만으로는 관리자가 아니다");
  assert.equal(W.suggestRole(["memory"]), "member");
  assert.equal(W.suggestRole([]), "guest");
  assert.equal(W.suggestRole(null), "guest");
  for (const s of [["memory"], ["admin"], ["admin", "runtime"], []]) assert.ok(W.ROLE_KEYS.includes(W.suggestRole(s)));
});

t("W9 배선 — 폼과 새 셸 메뉴가 역할로 저장한다", () => {
  const form = code("web/admin-members.ts");
  assert.match(form, /\? \{ role: roleSel\.value, grants: \{ \.\.\.extras \} \}/, "역할을 고르면 role · grants 만 보낸다");
  assert.match(form, /\.\.\.\(m\.role \? \{ role: null \} : \{\}\),/, "옛 방식으로 되돌리면 역할을 걷는다");
  assert.match(form, /scopeWrap\.hidden = !!rk;/, "역할을 고르면 옛 체크박스를 감춘다");
  const people = code("web/v2/ws-people.ts");
  assert.match(people, /p\.newRole \? \{ id: p\.id, role: isAdmin \? 'member' : 'admin' \} : \{ id: p\.id, scopes \}/, "역할 구성원은 역할로 올리고 내린다");
});

t("W10 배선 — DB 소스의 조회 대상 · 팀 종류를 화면에서 정한다", () => {
  const db = code("web/admin-db-sources.ts");
  assert.match(db, /void renderDbAccessPanel\(apanel, sel, data\);/, "소스를 고르면 조회 대상 패널이 붙는다");
  assert.match(db, /api\('\/api\/ui\/org\/db-source\/access', \{ method: 'POST', body: JSON\.stringify\(\{ name: source, members: \[\.\.\.chosen\], teams: teamChks\.filter\(\(x\) => x\.chk\.checked\)\.map\(\(x\) => x\.id\) \}\) \}\)/, "구성원 · 팀을 통째로 보낸다");
  assert.match(db, /api\('\/api\/ui\/org\/db-source\/access\?name=' \+ encodeURIComponent\(source\)\)/, "그 소스의 지정을 읽는다");
  const teams = code("web/admin-teams.ts");
  assert.match(teams, /lead_member_id: leadM \? leadM\.member_id : null, kind: kindSel\.value \}/, "팀 저장이 종류를 보낸다");
  assert.match(teams, /field\('종류', kindSel\)/, "팀 폼에 종류 칸이 있다");
});

console.log(`\nweb-permissions: ${pass} 통과`);
