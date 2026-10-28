// 외부 앱 연결 스킬(connect-skills.ts) 계약 — 원본 동기화 · 길 상태(판 없음) · 앱 등록 안내 · 잠금 · 배포 병합 · 유출 가드(#4970).
//  사양: 정책 P1~P11 · 엣지 E1~E18(아래 각 블록 머리에 표기). DB 없이 도는 순수 검증 —
//  잠금 거절(E11)은 핸들러가 DB 를 건드리기 **전에** 409 를 던지는지로 본다(DB 가 없어 그 뒤로 가면 다른 에러가 난다).
//  실행: npm run build && node dist/org/delivery/connect-skills.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONNECT_SKILL_SOURCES } from "./connect-skills.sources.js";
import {
  CONNECT_COMMON_SOURCE, CONNECT_SKILL_SPECS, REGISTRATION_SLOT, assembleConnectBody, connectSkills, connectSource, connectVariant,
  effectiveAsset, isLockedSkill, lockedSkillIds, withLockedAssets,
} from "./connect-skills.js";
import { APP_REGISTRATIONS, registrationMarkdown } from "../connect-registration.js";
import { DEFAULT_SKILLS } from "./default-content.js";
import { assetContentHash } from "../store/harness-assets.js";
import { registry } from "../../capabilities/index.js";

// dist/org/delivery → ../../.. → repoRoot → src/org/delivery/connect-skills (seed-content.test.ts 와 같은 길)
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC_DIR = path.join(REPO_ROOT, "src", "org", "delivery", "connect-skills");

let pass = 0;
const ok = (name: string) => { pass++; console.log(`ok  ${name}`); };

// ── E13 / P9 원본 동기화 — connect-skills.sources.ts == connect-skills/*.md (키·바이트) ──
{
  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith(".md")).sort();
  const fromFiles: Record<string, string> = {};
  for (const f of files) fromFiles[f.slice(0, -3)] = fs.readFileSync(path.join(SRC_DIR, f), "utf8");
  assert.ok(files.length > 0, "원본 폴더를 못 읽었다(경로 배선 확인)");
  assert.deepEqual(Object.keys(CONNECT_SKILL_SOURCES).sort(), Object.keys(fromFiles).sort(),
    "connect-skills.sources.ts 의 원본 목록이 connect-skills/*.md 와 다름 — 'node scripts/sync-connect-skills.mjs' 를 실행하세요");
  for (const k of Object.keys(fromFiles)) {
    assert.equal(CONNECT_SKILL_SOURCES[k], fromFiles[k], `원본 '${k}.md' 가 sources.ts 와 다름 — 'node scripts/sync-connect-skills.mjs' 를 실행하세요`);
  }
  ok(`E13 원본 ${files.length}개 == connect-skills.sources.ts`);
}

// ── E14 / P9 지시문 파일 이름 충돌 — claude.md·agents.md 는 대소문자를 안 가리는 파일시스템(macOS)에서 CLAUDE.md·AGENTS.md 로
//  읽혀, 이 폴더를 만지는 AI 세션에 스킬 본문이 지시문으로 주입된다(이 스킬을 쓰는 중 실제로 그렇게 읽혔다). ──
{
  const bad = fs.readdirSync(SRC_DIR).filter((f) => /^(claude|agents|gemini)\.md$/i.test(f));
  assert.deepEqual(bad, [], `지시문 파일과 이름이 겹치는 원본: ${bad.join(", ")} — 다른 키로 바꾸세요(예: claude-connector.md)`);
  ok("E14 원본 이름이 CLAUDE.md·AGENTS.md·GEMINI.md 와 겹치지 않음");
}

// ── P3·P4 카탈로그 — 스킬마다 원본 하나 · 판 파일(.managed·.selfhost)이 없다 · 고아 원본 없음 ──
//  (#4970 길) 스킬은 배포 방식으로 갈리지 않는다 — 갈림은 org_connect_status 의 길 상태다(상민님 2026-10-23).
{
  const ids = new Set<string>();
  const keys = [...CONNECT_SKILL_SPECS.map((s) => s.source), CONNECT_COMMON_SOURCE];
  for (const spec of CONNECT_SKILL_SPECS) { assert.ok(!ids.has(spec.id), `스킬 id 중복: ${spec.id}`); ids.add(spec.id); }
  for (const key of keys) assert.ok(CONNECT_SKILL_SOURCES[key] !== undefined, `'${key}' 의 원본(${key}.md)이 없음`);
  const variants = Object.keys(CONNECT_SKILL_SOURCES).filter((k) => /\.(managed|selfhost)$/.test(k));
  assert.deepEqual(variants, [], `★ 판 파일이 남아 있다 — 배포 방식으로 가르지 않는다: ${variants.join(", ")}`);
  const orphan = Object.keys(CONNECT_SKILL_SOURCES).filter((k) => !keys.includes(k));
  assert.deepEqual(orphan, [], `어느 스킬도 쓰지 않는 원본: ${orphan.join(", ")}`);
  ok(`P3 카탈로그 ${CONNECT_SKILL_SPECS.length}종 — 원본 하나씩 · 판 파일 없음 · 고아 원본 없음`);
}

// ── E8 원본 해석 — 없으면 던진다(조용히 빈 본문을 내지 않는다) ──
{
  assert.throws(() => connectSource("no-such-app"), /no-such-app/);
  assert.equal(connectSource("a", { a: "A" }), "A");
  ok("E8 원본 해석 — 있으면 그것 · 없으면 던짐");
}

// ── E15 / P8 id 규칙 = 캡처 제외 규칙(capture-default-content.mjs isLockedConnectSkillId) · DEFAULT_SKILLS 와 겹치지 않음 ──
{
  const { isLockedConnectSkillId } = await import(pathToFileURL(path.join(REPO_ROOT, "scripts", "capture-default-content.mjs")).href) as { isLockedConnectSkillId: (id: string) => boolean };
  for (const id of lockedSkillIds()) {
    assert.ok(isLockedConnectSkillId(id), `잠긴 스킬 id '${id}' 를 캡처 스크립트가 제외하지 않음 — DEFAULT_SKILLS 로 되돌아온다`);
  }
  assert.ok(!isLockedConnectSkillId("liv"), "리브 점검 스킬은 잠긴 연결 스킬이 아니다");
  assert.ok(!isLockedConnectSkillId("liv-distill"), "liv-distill 은 잠긴 연결 스킬이 아니다");
  const leaked = DEFAULT_SKILLS.filter((s) => isLockedSkill(s.id)).map((s) => s.id);
  assert.deepEqual(leaked, [], `잠긴 스킬이 DEFAULT_SKILLS 에도 있음(이중 출처): ${leaked.join(", ")}`);
  ok("E15 잠긴 id 전부 캡처 제외 · 이웃 리브 스킬은 제외 안 됨 · DEFAULT_SKILLS 에 없음");
}

// ── E16 / P10 설명 길이 예산 — 스킬 설명은 모든 세션에 늘 깔린다 ──
{
  for (const s of CONNECT_SKILL_SPECS) {
    assert.ok(s.description.length <= 260, `'${s.id}' 설명이 ${s.description.length}자 — 260자 이하로`);
    assert.ok(s.summary.length > 0 && s.summary.length <= 60, `'${s.id}' summary 는 1~60자`);
  }
  const total = CONNECT_SKILL_SPECS.reduce((n, s) => n + s.description.length, 0);
  assert.ok(total <= 2200, `연결 스킬 설명 합계 ${total}자 — 2,200자 이하로(모든 세션 상시 비용)`);
  ok(`E16 설명 예산 — 스킬별 ≤260자 · 합계 ${total}자`);
}

// ── E6 / P2 판 선택 — managedMode 와 같은 술어 ──
{
  assert.equal(connectVariant({ LIVELY_TENANT_HEADER_SECRET: "x" } as NodeJS.ProcessEnv), "managed");
  assert.equal(connectVariant({} as NodeJS.ProcessEnv), "selfhost");
  assert.equal(connectVariant({ LIVELY_TENANT_HEADER_SECRET: "  " } as NodeJS.ProcessEnv), "selfhost", "공백 비밀은 매니지드가 아니다");
  ok("E6 판 선택 — 비밀 있음=managed · 없음/공백=selfhost");
}

// ── E7 / P3·P4 합치기 — 본문 = 원본(앱 등록 자리를 안내로 채워) + 공통, 제목 하나로 시작 ──
{
  let withReg = 0;
  for (const spec of CONNECT_SKILL_SPECS) {
    const body = assembleConnectBody(spec);
    assert.ok(body.startsWith("# "), `'${spec.id}' 본문은 제목(# )으로 시작해야 함`);
    assert.equal((body.match(/^# /gm) ?? []).length, 1, `'${spec.id}' 본문에 제목(# )이 하나여야 함 — 공통 부분·안내가 제목을 또 달았는지 확인`);
    assert.ok(body.trimEnd().endsWith(connectSource(CONNECT_COMMON_SOURCE).trim()), `'${spec.id}' 본문 끝에 공통 부분이 없음`);
    assert.ok(!body.includes(REGISTRATION_SLOT), `'${spec.id}' 본문에 앱 등록 자리가 그대로 남았다`);
    if (APP_REGISTRATIONS[spec.source]) {
      withReg++;
      assert.ok(body.includes(registrationMarkdown(spec.source)), `★ '${spec.id}' 본문에 앱 등록 안내(화면과 같은 글)가 없다`);
    }
  }
  assert.equal(withReg, Object.keys(APP_REGISTRATIONS).length, "앱 등록 안내가 있는 앱마다 그 스킬에 들어갔다");
  //  자리와 안내가 어긋나면 내려보내기 전에 던진다(조용히 안내 없는 본문을 내지 않는다).
  const fakeSpec = { ...CONNECT_SKILL_SPECS.find((s) => s.source === "gitlab")! };
  assert.throws(() => assembleConnectBody(fakeSpec, { gitlab: `# g\n${REGISTRATION_SLOT}`, _common: "c" }), /앱 등록 자리/, "안내 없는 앱에 자리");
  const slackSpec = CONNECT_SKILL_SPECS.find((s) => s.source === "slack")!;
  assert.throws(() => assembleConnectBody(slackSpec, { slack: "# s\n자리 없음", _common: "c" }), /앱 등록 자리/, "안내 있는 앱에 자리 없음");
  ok(`E7 합치기 — 원본+공통 · 앱 등록 안내 ${withReg}종이 자리에 들어감 · 어긋나면 던짐`);
}

// ── E19 (#4970 길) 앱 스킬은 길 상태로 고른다 — «길 고르기» · recommended · 옛 next= 갈림 없음 ──
{
  for (const spec of CONNECT_SKILL_SPECS) {
    if (!/^liv-connect-/.test(spec.id) || spec.id === "liv-connect-claude") continue;
    const body = assembleConnectBody(spec);
    assert.match(body, /^## 길 고르기$/m, `'${spec.id}' 에 «길 고르기» 절이 없다`);
    assert.ok(body.includes("`routes`") || body.includes("길은 개인 토큰(`token`) 하나"), `'${spec.id}' 가 길 목록을 안 읽는다`);
    assert.doesNotMatch(body, /`next=/, `★ '${spec.id}' 에 옛 next= 갈림이 남았다`);
    assert.doesNotMatch(body, /라이블리 클라우드라|회사가 직접 설치한 라이블리라/, `'${spec.id}' 가 배포 방식으로 안내를 가른다`);
  }
  const router = assembleConnectBody(CONNECT_SKILL_SPECS.find((s) => s.id === "liv-connect")!);
  assert.match(router, /`recommended`/, "입구 스킬이 권하는 길을 읽는다");
  assert.match(router, /driver:"http"/, "목록에 없는 앱 — 범용 수집기(키로 읽기)");
  assert.match(router, /driver:"webhook"/, "목록에 없는 앱 — 밀어 넣기(웹훅)");
  assert.match(router, /\/hooks\/collector\//, "웹훅 받는 주소");
  const claude = assembleConnectBody(CONNECT_SKILL_SPECS.find((s) => s.id === "liv-connect-claude")!);
  assert.match(claude, /## 0\. 길 상태/, "Claude 커넥터 스킬이 ai 길 상태로 시작한다");
  ok("E19 길 상태 — 앱 스킬 «길 고르기» · 옛 next= 없음 · 입구 스킬 범용 HTTP·웹훅 · Claude 커넥터 0절");
}

// ── E20 (#4970 리뷰) 스킬 본문이 부르라는 도구는 레지스트리에 있다 — 산문을 고쳐도 없는 도구를 부르게 하지 않는다 ──
{
  const names = new Set<string>();
  for (const sk of connectSkills()) {
    for (const m of sk.body.matchAll(/`([a-z][a-z0-9_]+) \{/g)) names.add(m[1]!);   // 부르는 모양: `org_x_set { … }`
    for (const m of sk.body.matchAll(/`(org_[a-z0-9_]+)`/g)) names.add(m[1]!);      // 이름만: `org_connect_status`
  }
  const missing = [...names].filter((n) => !registry.get(n));
  assert.deepEqual(missing, [], `연결 스킬이 없는 도구를 부르라고 한다: ${missing.join(", ")}`);
  assert.ok(names.size >= 20, `도구 이름을 충분히 찾았다(배선) — ${names.size}개`);
  ok(`E20 스킬이 부르는 도구 ${names.size}개 전부 레지스트리에 있다`);
}

// ── E18 / P11 content_hash — 내려가는 필드의 해시와 같다 ──
{
  for (const s of connectSkills()) {
    assert.equal(s.content_hash, assetContentHash({ kind: s.kind, harness: s.harness, description: s.description, body: s.body, frontmatter: s.frontmatter }),
      `'${s.id}' content_hash 가 assetContentHash 와 다름 — materializer 변경감지가 어긋난다`);
  }
  ok("E18 content_hash == assetContentHash");
}

// ── E17 / P10 유출 가드 — 모든 고객 박스에 배포된다(seed-content.test.ts 의 LEAK·MD_ASSET_LEAK 과 같은 잣대 + 이슈 번호) ──
{
  const LEAK: Array<{ re: RegExp; why: string }> = [
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: "개인키" },
    { re: /\bAKIA[0-9A-Z]{16}\b/, why: "AWS 액세스키" },
    { re: /\bsk-[A-Za-z0-9]{20,}\b/, why: "API 시크릿키" },
    { re: /lvly\.io/, why: "라이블리 내부 호스트" },
    { re: /\/Users\/[a-z]/, why: "맥 절대경로" },
    { re: /\/home\/[a-z][a-z0-9]+\//, why: "리눅스 홈 절대경로" },
    { re: /\[\[/, why: "위키 내부 링크([[…]])" },
    { re: /src\/org\/delivery/, why: "배포 메커니즘 자기참조(내부 경로)" },
    { re: /#\d{3,5}\b/, why: "내부 이슈 번호" },
  ];
  for (const s of connectSkills()) {
    const text = `${s.body}\n${s.description}\n${s.summary}\n${s.label}`;
    for (const { re, why } of LEAK) assert.ok(!re.test(text), `연결 스킬 '${s.id}' 에 ${why} 로 보이는 것이 있음`);
  }
  ok("E17 유출 가드 — 0건");
}

// ── E1~E5 / P1·P7 배포 병합 — DB 의 잠긴 행은 빼고 코드 판을 항상, 정확히 한 번 싣는다 ──
{
  const expectBody = (id: string) => connectSkills().find((s) => s.id === id)!.body;
  // E1 DB 행 0건(시딩 실패)
  const e1 = withLockedAssets([], {});
  assert.deepEqual(e1.map((a) => a.id).sort(), lockedSkillIds().sort(), "E1 DB 가 비어도 잠긴 스킬 전부");
  // E2 고친 본문이 든 잠긴 행 · E3 조직 스킬과 섞임
  const dbRows = [
    { id: "my-skill", kind: "skill", harness: "all", body: "조직 스킬" },
    { id: "liv-connect-slack", kind: "skill", harness: "all", body: "누가 SQL 로 고친 본문" },
  ];
  const merged = withLockedAssets(dbRows, {});
  assert.equal(merged.filter((a) => a.id === "my-skill").length, 1, "E3 조직 스킬은 그대로 한 번");
  assert.equal((merged.find((a) => a.id === "my-skill") as { body: string }).body, "조직 스킬");
  for (const id of lockedSkillIds()) assert.equal(merged.filter((a) => a.id === id).length, 1, `E2 잠긴 스킬 '${id}' 는 정확히 한 번`);
  assert.equal((merged.find((a) => a.id === "liv-connect-slack") as { body: string }).body, expectBody("liv-connect-slack"), "E2 코드 판 본문이 나간다");
  // E4 kind 필터 · E5 harness 필터
  assert.equal(withLockedAssets([], { kind: "subagent" }).length, 0, "E4 kind=subagent 에는 싣지 않음");
  assert.equal(withLockedAssets([], { kind: "skill" }).length, lockedSkillIds().length, "E4 kind=skill 에는 전부");
  assert.equal(withLockedAssets([], { harness: "codex" }).length, lockedSkillIds().length, "E5 harness=codex 에도 전부(all 스킬)");
  assert.equal(withLockedAssets([], { harness: "all" }).length, lockedSkillIds().length, "E5 harness=all 경계");
  ok("E1~E5 배포 병합 — DB 없어도 · 고친 행 교체 · 중복 없음 · 필터");
}

// ── E9·E10·E12 / P5 유효 행 ──
{
  const tampered = { id: "liv-connect", body: "옛 본문", description: "옛 설명", content_hash: "x", enabled: false, target_members: ["a"] };
  const eff = effectiveAsset(tampered) as typeof tampered & { summary: string; label: string };
  assert.notEqual(eff.body, "옛 본문", "E9 코드 본문으로 보인다");
  assert.equal(eff.enabled, true, "E9 항상 켜짐");
  assert.equal(eff.target_members, null, "E9 대상 전원");
  assert.ok(eff.summary.length > 0 && eff.label.length > 0);
  assert.equal(tampered.body, "옛 본문", "E9 입력 행 자체는 바꾸지 않는다(비파괴)");
  const plain = { id: "my-skill", body: "b", description: "d", content_hash: "h" };
  assert.equal(effectiveAsset(plain), plain, "E10 잠기지 않은 행은 같은 객체");
  for (const id of [null, undefined, ""]) assert.equal(isLockedSkill(id), false, `E12 ${JSON.stringify(id)} 는 잠긴 것이 아니다`);
  ok("E9·E10·E12 유효 행 — 잠긴 스킬은 코드 본문·켜짐·전원, 나머지·빈 id 는 그대로");
}

// ── E11 / P6 잠금 거절 — 다섯 경로 모두 DB 를 건드리기 전에 409 ──
{
  const admin = { userId: "__connect_skills_test__", email: "t@example.invalid", scopes: ["admin", "runtime", "memory"], projects: ["*"], tokenSource: "db" } as never;
  const call = async (name: string, input: Record<string, unknown>) => {
    const cap = registry.get(name);
    assert.ok(cap, `capability '${name}' 가 registry 에 없다(배선 확인)`);
    return cap!.handler(input, admin, { source: "mcp" } as never);
  };
  const is409 = (e: unknown) => (e as { status?: number })?.status === 409 && /외부 앱 연결 스킬/.test(String((e as Error).message));
  await assert.rejects(call("org_harness_asset_upsert", { id: "liv-connect-slack", body: "고친 본문" }), is409, "upsert");
  await assert.rejects(call("org_harness_asset_upsert", { id: "liv-connect", enabled: false }), is409, "upsert(끄기만)");
  await assert.rejects(call("org_harness_asset_remove", { id: "liv-connect-notion" }), is409, "remove");
  await assert.rejects(call("org_harness_asset_adopt", { draft_id: "draft-abc-x", new_id: "liv-connect-github" }), is409, "adopt new_id");
  await assert.rejects(call("org_asset_pref_set", { target_kind: "harness_asset", ref_id: "liv-connect-figma", member_id: "someone", state: false }), is409, "관리자 개인설정");
  await assert.rejects(call("me_asset_pref_set", { target_kind: "harness_asset", ref_id: "liv-connect-google", state: false }), is409, "구성원 개인설정");
  ok("E11 잠금 거절 — upsert·끄기·remove·adopt·관리자/구성원 개인설정 전부 409");
}

console.log(`\n${pass} passed`);
