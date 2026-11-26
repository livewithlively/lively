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
//   W9 배선 — 구성원 폼은 저장할 값을 accessPayload 로 정하고(역할 방식이면 role · grants 만), 옛 방식일 때만 scopes 를 보낸다 · 새 셸 메뉴는 역할 구성원을 역할로 올리고 내린다
//   W11 새 구성원 폼의 기본 역할이 서버와 같다
//   W12 accessChoiceOf — 역할 없음 → 옛 방식 · 역할 → 그 역할 · 게스트 + 개별 권한 → 직접 고르기 · 게스트만 → 게스트 · 모르는 역할 → 옛 방식
//   W13 accessChoices — 새 구성원 · 역할 구성원에게는 옛 방식이 없다 · 옛 구성원을 고칠 때만 옛 방식이 맨 앞에 있다 · 직접 고르기는 늘 있다
//   W14 accessPayload — 역할 → {role, grants} · 직접 고르기 → 게스트 + 고른 권한 · 옛 방식 → null · 역할이 이미 주는 개별 권한은 버린다
//   W15 직접 고르기로 저장한 값은 다시 열면 직접 고르기다(왕복) · 아무것도 안 고른 직접 고르기는 게스트다
//   W16 planTargetText — 역할 이름 · 역할 + 개별 권한 n개 · 직접 고른 권한 · 옮기지 않음(권한 없음)
//   W17 gainText · lossText — «하네스 설정 보기» · «코드 고치기 → 보기» · 다 잃으면 «→ 없음» · DB 는 «조회» · 세션은 «있음»
//   W18 migrationSummary — 0 인 것은 빼고 소유자 → 관리자 → 구성원 → 직접 고른 권한 → 옮기지 않음 순서 · 빈 값은 빈 줄
//   W19 legacyCount — 역할 없는 구성원 수 · 빈 목록 0
//   W20 배선 — 명부는 옛 방식 구성원이 있을 때만 안내를 보이고 · 이관 창은 계획을 읽어 고른 id 만 보낸다 · 두 번 눌러야 옮긴다
//   W21 effectiveGrants — 서버 memberGrants 와 같은 값(역할 4 × 개별 권한 × 팀 조합) · 옛 방식(역할 없음)은 빈 것 · 팀은 올리기만
//   W22 sourceTexts — 지금 수준을 주는 출처만 · «구성원 역할» · «개별 권한» · «팀 이름»(이름 없으면 #id) · 권한이 없으면 빈 배열 — 서버 grantSources 와 같은 출처 수
//   W23 teamAccessText — «관리자 역할 · 코드 고치기 · DB 조회» · 주는 것이 없으면 빈 줄 · 모르는 역할 · 수준은 뺀다
//   W24 teamLevelChoices — 보기/고치기 · DB 는 조회뿐 · 세션 · 원격 실행은 있음뿐
//   W25 배선 — 구성원 읽기 화면은 출처가 붙은 표를 쓴다 · 팀 폼은 관리자일 때만 권한을 보낸다 · 팀 읽기 화면이 팀이 주는 권한을 보인다
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
  assert.match(form, /\.\.\.\(accessPayload\(roleSel\.value, extras\) \?\? \{/, "역할 방식이면 role · grants 만, 옛 방식일 때만 scopes");
  assert.match(form, /for \(const ck of accessChoices\(m, isNew\)\)/, "고를 수 있는 방식은 accessChoices 가 정한다(새 구성원에게 옛 방식 없음)");
  assert.match(form, /roleSel\.value = isNew && !m\.role \? MEMBER_DEFAULT_ROLE : accessChoiceOf\(m\);/, "새 구성원은 기본 역할이 골라져 있다");
  assert.match(form, /scopeWrap\.hidden = !!rk;/, "역할 방식이면 옛 체크박스를 감춘다");
  const people = code("web/v2/ws-people.ts");
  assert.match(people, /p\.newRole \? \{ id: p\.id, role: isAdmin \? 'member' : 'admin' \} : \{ id: p\.id, scopes \}/, "역할 구성원은 역할로 올리고 내린다");
});

t("W11 새 구성원 폼의 기본 역할이 서버와 같다", () => {
  assert.equal(W.MEMBER_DEFAULT_ROLE, S.DEFAULT_MEMBER_ROLE);
});

t("W12 accessChoiceOf — 지금 어느 방식인가", () => {
  assert.equal(W.accessChoiceOf({ role: null, scopes: ["items"] }), W.LEGACY_CHOICE);
  assert.equal(W.accessChoiceOf(null), W.LEGACY_CHOICE);
  assert.equal(W.accessChoiceOf({ role: "nope", grants: { code: "read" } }), W.LEGACY_CHOICE);
  for (const r of W.ROLE_KEYS) assert.equal(W.accessChoiceOf({ role: r, grants: {} }), r);
  assert.equal(W.accessChoiceOf({ role: "guest", grants: null }), "guest");
  assert.equal(W.accessChoiceOf({ role: "guest", grants: { code: "read" } }), W.CUSTOM_CHOICE);
  assert.equal(W.accessChoiceOf({ role: "member", grants: { code: "write" } }), "member", "구성원 + 개별 권한은 구성원이다");
});

t("W13 accessChoices — 옛 방식은 옛 구성원을 고칠 때만", () => {
  const all = [...W.ROLE_KEYS, W.CUSTOM_CHOICE];
  assert.deepEqual(W.accessChoices({ role: null }, true), all, "새 구성원");
  assert.deepEqual(W.accessChoices({ role: "member" }, true), all);
  assert.deepEqual(W.accessChoices({ role: "admin" }, false), all, "역할 구성원");
  assert.deepEqual(W.accessChoices({ role: null }, false), [W.LEGACY_CHOICE, ...all], "옛 구성원");
  assert.deepEqual(W.accessChoices(null, false), [W.LEGACY_CHOICE, ...all]);
});

t("W14 accessPayload — 저장할 값", () => {
  assert.deepEqual(W.accessPayload("member", {}), { role: "member", grants: {} });
  assert.deepEqual(W.accessPayload("member", { code: "write", content: "write", db: "read" }), { role: "member", grants: { code: "write" } }, "역할이 이미 주는 것은 버린다");
  assert.deepEqual(W.accessPayload(W.CUSTOM_CHOICE, { code: "read", session: "write" }), { role: "guest", grants: { code: "read", session: "write" } });
  assert.deepEqual(W.accessPayload(W.CUSTOM_CHOICE, { content: "read" }), { role: "guest", grants: {} }, "맥락 보기는 바탕이라 개별 권한이 아니다");
  assert.deepEqual(W.accessPayload(W.CUSTOM_CHOICE, { content: "write" }), { role: "guest", grants: { content: "write" } });
  assert.equal(W.accessPayload(W.LEGACY_CHOICE, { code: "write" }), null);
  assert.equal(W.accessPayload("nope", {}), null);
  assert.deepEqual(W.accessPayload("owner", { code: "write", db: "read" }), { role: "owner", grants: {} }, "소유자에게는 얹을 것이 없다");
  assert.equal(W.roleOfChoice(W.CUSTOM_CHOICE), "guest");
  assert.deepEqual(W.extrasForChoice(W.LEGACY_CHOICE, { code: "write" }), {});
});

t("W15 직접 고르기는 저장했다 다시 열어도 직접 고르기다", () => {
  const saved = W.accessPayload(W.CUSTOM_CHOICE, { code: "read", db: "read" });
  assert.equal(W.accessChoiceOf(saved), W.CUSTOM_CHOICE);
  assert.deepEqual(W.accessPayload(W.accessChoiceOf(saved), saved.grants), saved);
  assert.equal(W.accessChoiceOf(W.accessPayload(W.CUSTOM_CHOICE, {})), "guest", "아무것도 안 고르면 게스트와 같다");
  for (const r of W.ROLE_KEYS) {
    const g = r === "guest" ? {} : (W.extraChoices(r, "code")[0] ? { code: W.extraChoices(r, "code")[0] } : {});
    const p = W.accessPayload(r, g);
    if (r !== "guest") assert.equal(W.accessChoiceOf(p), r);
  }
});

t("W10 배선 — DB 소스의 조회 대상 · 팀 종류를 화면에서 정한다", () => {
  const db = code("web/admin-db-sources.ts");
  assert.match(db, /void renderDbAccessPanel\(apanel, sel, data\);/, "소스를 고르면 조회 대상 패널이 붙는다");
  assert.match(db, /api\('\/api\/ui\/org\/db-source\/access', \{ method: 'POST', body: JSON\.stringify\(\{ name: source, members: \[\.\.\.chosen\], teams: teamChks\.filter\(\(x\) => x\.chk\.checked\)\.map\(\(x\) => x\.id\) \}\) \}\)/, "구성원 · 팀을 통째로 보낸다");
  assert.match(db, /api\('\/api\/ui\/org\/db-source\/access\?name=' \+ encodeURIComponent\(source\)\)/, "그 소스의 지정을 읽는다");
  const teams = code("web/admin-teams.ts");
  assert.match(teams, /lead_member_id: leadM \? leadM\.member_id : null, kind: kindSel\.value,/, "팀 저장이 종류를 보낸다");
  assert.match(teams, /field\('종류', kindSel\)/, "팀 폼에 종류 칸이 있다");
});


t("W16 planTargetText — 갈 곳을 사람 말로", () => {
  assert.equal(W.planTargetText({ id: "a", role: "member", grants: {} }), "구성원");
  assert.equal(W.planTargetText({ id: "a", role: "owner" }), "소유자");
  assert.equal(W.planTargetText({ id: "a", role: "admin", grants: { secrets: "write" } }), "관리자 + 개별 권한 1개");
  assert.equal(W.planTargetText({ id: "a", role: "guest", custom: true, grants: { code: "write" } }), "직접 고른 권한");
  assert.equal(W.planTargetText({ id: "a", role: null, skip: "no-permissions" }), "옮기지 않음 (권한 없음)");
  assert.equal(W.planTargetText({ id: "a", role: null }), "옮기지 않음");
});

t("W17 gainText · lossText — 달라지는 것을 사람 말로", () => {
  assert.equal(W.gainText({ perm: "harness", from: null, to: "read" }), "하네스 설정 보기");
  assert.equal(W.gainText({ perm: "db", from: null, to: "read" }), "DB 조회");
  assert.equal(W.gainText({ perm: "session", from: null, to: "write" }), "세션 있음");
  assert.equal(W.lossText({ perm: "code", from: "write", to: "read" }), "코드 고치기 → 보기");
  assert.equal(W.lossText({ perm: "secrets", from: "write", to: null }), "자격 고치기 → 없음");
  assert.equal(W.lossText({ perm: "zzz", from: "write", to: "read" }), "zzz 고치기 → 보기", "모르는 권한은 키 그대로");
});

t("W18 migrationSummary — 역할별 수 한 줄", () => {
  assert.equal(W.migrationSummary({ owner: 82, admin: 0, member: 8, custom: 1, skipped: 3 }), "소유자 82명 · 구성원 8명 · 직접 고른 권한 1명 · 옮기지 않음 3명");
  assert.equal(W.migrationSummary({ admin: 2 }), "관리자 2명");
  assert.equal(W.migrationSummary({}), "");
  assert.equal(W.migrationSummary(null), "");
});

t("W19 legacyCount — 옛 방식 구성원 수", () => {
  assert.equal(W.legacyCount([{ role: null }, { role: "member" }, {}, { role: "" }]), 3);
  assert.equal(W.legacyCount([]), 0);
  assert.equal(W.legacyCount(null), 0);
});

t("W20 배선 — 명부의 안내와 이관 창", () => {
  const form = code("web/admin-members.ts");
  assert.match(form, /const legacy = canEdit \? legacyCount\(members\) : 0;/, "관리자에게만, 옛 방식 구성원 수로");
  assert.match(form, /const legacyNote = legacy \? /, "0명이면 안내가 없다");
  assert.match(form, /api\('\/api\/ui\/org\/members\/role-plan\?keep=' \+ \(keep \? '1' : '0'\)\)/, "계획은 서버에서 읽는다");
  assert.match(form, /body: JSON\.stringify\(\{ ids: \[\.\.\.picked\], keep \}\)/, "고른 id 만 보낸다(all 을 쓰지 않는다)");
  assert.match(form, /if \(!armed\) \{ armed = true; syncBtn\(\); return; \}/, "두 번 눌러야 옮긴다");
  assert.match(form, /chk\.disabled = !r\.role;/, "옮기지 않을 구성원은 고를 수 없다");
  assert.match(form, /el\('div', \{ class: 'admin-actions' \}, goBtn\)\]\.filter\(Boolean\)\);/, "없는 조각(null)을 그리지 않는다");
});


t("W21 effectiveGrants — 서버와 같은 값", () => {
  const teamSets = [[], [{ team_id: 1, name: "a", role: "member", grants: {} }], [{ team_id: 1, name: "a", role: null, grants: { code: "write", db: "read" } }, { team_id: 2, name: "b", role: "admin", grants: { harness: "write" } }],
    [{ team_id: 3, name: "c", role: null, grants: { content: "read", code: "read" } }]];
  const ownSets = [{}, { code: "write" }, { secrets: "write", session: "write" }];
  for (const role of W.ROLE_KEYS) for (const grants of ownSets) for (const team_access of teamSets) {
    const row = { role, grants, team_access };
    assert.deepEqual(W.effectiveGrants(row), S.memberGrants(row), JSON.stringify(row));
  }
  assert.deepEqual(W.effectiveGrants({ role: null, grants: { code: "write" }, team_access: teamSets[1] }), {}, "옛 방식 구성원은 팀이 넓히지 않는다");
  assert.deepEqual(W.effectiveGrants(null), {});
  assert.deepEqual(W.teamGrantsOf({ role: "guest", grants: { code: "write" } }), S.teamGrants({ role: "guest", grants: { code: "write" } }));
  assert.deepEqual(W.teamGrantsOf(null), {});
});

t("W22 sourceTexts — 어디서 왔나", () => {
  const m = { role: "member", grants: { code: "write" }, team_access: [{ team_id: 1, name: "개발", role: null, grants: { code: "write", admin: "read" } }, { team_id: 2, name: null, role: "member", grants: {} }, { team_id: 3, name: "읽기", role: null, grants: { code: "read" } }] };
  assert.deepEqual(W.sourceTexts(m, "code"), ["개별 권한", "팀 개발"]);
  assert.deepEqual(W.sourceTexts(m, "content"), ["구성원 역할", "팀 #2"]);
  assert.deepEqual(W.sourceTexts(m, "admin"), ["팀 개발"]);
  assert.deepEqual(W.sourceTexts(m, "secrets"), []);
  assert.deepEqual(W.sourceTexts({ role: null, grants: { code: "write" } }, "code"), []);
  const srv = S.grantSources(m);
  for (const p of W.PERMISSION_KEYS) assert.equal(W.sourceTexts(m, p).length, (srv[p] || []).length, p);
});

t("W23 teamAccessText — 팀이 주는 권한 한 줄", () => {
  assert.equal(W.teamAccessText({ role: "admin", grants: { code: "write", db: "read" } }), "관리자 역할 · 코드 고치기 · DB 조회");
  assert.equal(W.teamAccessText({ role: null, grants: { session: "write" } }), "세션 있음");
  assert.equal(W.teamAccessText({ role: "nope", grants: { code: "zzz" } }), "");
  assert.equal(W.teamAccessText({ role: null, grants: null }), "");
  assert.equal(W.teamAccessText(null), "");
});

t("W24 teamLevelChoices — 권한 종류대로", () => {
  assert.deepEqual(W.teamLevelChoices("code"), ["read", "write"]);
  assert.deepEqual(W.teamLevelChoices("db"), ["read"]);
  assert.deepEqual(W.teamLevelChoices("session"), ["write"]);
  assert.deepEqual(W.teamLevelChoices("run"), ["write"]);
});

t("W25 배선 — 출처 표 · 팀 권한 폼", () => {
  const form = code("web/admin-members.ts");
  assert.match(form, /effectiveTable\(m\)\)\)/, "읽기 화면은 출처가 붙은 표");
  assert.match(form, /text: sourceTexts\(m, pk\)\.join\(', '\) \|\| '—'/, "권한마다 어디서 왔나");
  const teams = code("web/admin-teams.ts");
  assert.match(teams, /const canAccess = !!state\.admin\.canEdit;/, "팀 권한은 관리자만 바꾼다");
  assert.match(teams, /\.\.\.\(canAccess \? \{ access_role: accessRoleSel\.value \|\| null, access_grants: \{ \.\.\.accessGrants \} \} : \{\}\)/, "관리자가 아니면 권한 칸을 보내지 않는다");
  assert.match(teams, /roRow\('팀이 주는 권한', teamAccessText\(\{ role: team\.access_role, grants: team\.access_grants \}\) \|\| '없음'\)/, "읽기 화면이 팀이 주는 권한을 보인다");
});

console.log(`\nweb-permissions: ${pass} 통과`);
