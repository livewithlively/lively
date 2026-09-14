// 프로비저닝 디폴트 콘텐츠(default-content.ts) 계약·불변식 — DB 없이 도는 순수 검증. (#713)
//  seedDefaultContent 의 idempotent 삽입은 DB 가 필요해 라이브 스모크로 따로 본다(scripts/…). 여기선
//  '시드 데이터 자체'의 무결성 + 코드가 전제하는 지식이 시드에 있는지(회귀 방지)만 본다.
//  실행: npm run build && node dist/org/delivery/seed-content.test.js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HOOKS, DEFAULT_SKILLS, DEFAULT_KNOWLEDGE } from "./default-content.js";

// 시딩 지식 본문 SoT — src/org/delivery/seed-knowledge/(#846: DB 캡처가 아니라 파일이 원본). dist 에서 도는 이
//  테스트가 소스 파일을 읽어 default-content.ts(baked) 와 대조한다. dist/org/delivery → ../../.. → repoRoot → src/org/delivery.
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SEED_DIR = path.join(REPO_ROOT, "src", "org", "delivery", "seed-knowledge");
// 시딩 훅 소스 SoT — kit/hooks/examples/<id>.org-hook.mjs (#905 P1-②: 지식과 같은 '파일이 원본' 모델).
const HOOK_EX_DIR = path.join(REPO_ROOT, "kit", "hooks", "examples");

let pass = 0;
const ok = (name: string) => { pass++; console.log(`ok  ${name}`); };

const HARNESSES = new Set(["claude", "codex", "openclaw", "opencode", "antigravity", "all"]);
const KINDS = new Set(["skill", "subagent", "command"]);
const INJECTIONS = new Set(["always", "recalled"]);

// ── 코드가 이름으로 knowledge_get 하는 지식이 시드에 반드시 있어야 한다(댕글링 방지의 핵심 회귀 가드). ──
//  근거: src/scheduler/index.ts(런북 2개 — 본문을 부트스트랩 프롬프트에 주입). 이 이름을 시드에서 빼면 고객
//  게이트웨이에서 그 포인터가 다시 댕글링이 된다 — 그때 이 테스트가 깨져 알려준다.
//  (project-closeout 은 #878 에서 지식→스킬로 이동해 여기서 빠졌다 — 스킬 무결성·유출가드는 위 스킬 섹션이 본다.)
{
  const CODE_REFERENCED = ["runbook-bootstrap-domains", "domainmap-is-bootstrap-runbook"];
  const names = new Set(DEFAULT_KNOWLEDGE.map((k) => k.name));
  for (const n of CODE_REFERENCED) assert.ok(names.has(n), `코드 참조 지식 '${n}' 이 시드에 없음 — 댕글링 포인터가 된다`);
  ok("코드가 전제하는 지식 2종이 모두 시드에 존재(도메인맵 is-부트스트랩 런북 2개)");
}

// ── 훅 무결성 ──
{
  const ids = new Set<string>();
  for (const h of DEFAULT_HOOKS) {
    assert.ok(h.id && !ids.has(h.id), `훅 id 누락/중복: ${h.id}`); ids.add(h.id);
    assert.ok(h.event, `훅 '${h.id}' event 누락`);
    assert.ok(h.source_code && h.source_code.trim().length > 0, `훅 '${h.id}' source_code 비어있음`);
    assert.ok(HARNESSES.has(h.harness), `훅 '${h.id}' harness 불량: ${h.harness}`);
    assert.equal(typeof h.enabled, "boolean", `훅 '${h.id}' enabled 타입`);
  }
  assert.ok(DEFAULT_HOOKS.length >= 6, `기대 훅 ≥6, 실제 ${DEFAULT_HOOKS.length}`);
  ok(`훅 ${DEFAULT_HOOKS.length}종 무결성(고유 id·event·source_code·harness)`);
}

// ── #905 P1-② 시딩 훅 SoT 동기화 가드 — default-content.ts 의 훅 소스 == kit/hooks/examples/<id>.org-hook.mjs. ──
//  왜: 훅 본문의 SoT 가 여태 **라이브 DB** 였다(capture-default-content.mjs 가 org_hook 을 스냅샷). 그래서 훅 로직이
//   코드리뷰·레포 diff 를 안 거치고 바뀌고, dev 박스에서 만진 상태가 고객 디폴트로 샜다(SEED_DISABLED 가 그 흉터).
//   예제 파일이 있는 훅은 **레포 파일을 SoT** 로 뒤집는다 — 여기서 바이트 일치를 강제하므로, 옛 capture 가 DB
//   본문으로 되돌리거나 default-content.ts 를 손으로 고치면 이 테스트가 깨져 알려준다.
//   고치는 법: kit/hooks/examples/<id>.org-hook.mjs 편집 후 `node scripts/sync-seed-hooks.mjs`.
//  예제 파일이 없는 훅(delegate-router 등)은 아직 DB 캡처본이 SoT — 대상 아님(파일을 만들면 자동 편입된다).
{
  let checked = 0;
  for (const h of DEFAULT_HOOKS) {
    const f = path.join(HOOK_EX_DIR, `${h.id}.org-hook.mjs`);
    if (!fs.existsSync(f)) continue;
    assert.equal(h.source_code, fs.readFileSync(f, "utf8"),
      `훅 '${h.id}' 소스가 kit/hooks/examples/${h.id}.org-hook.mjs 와 다름 — 'node scripts/sync-seed-hooks.mjs' 를 실행하세요(default-content.ts 를 직접 고치지 말 것)`);
    checked++;
  }
  assert.ok(checked >= 3, `예제 파일 기반 훅이 최소 3종이어야 함(project-pull·project-pull-turn·knowledge-recall), 실제 ${checked}`);
  ok(`시딩 훅 ${checked}종이 kit/hooks/examples/ SoT 와 바이트 일치(하드에딧·DB 재오염 가드)`);
}

// ── 공유폴더 pull 훅의 '쓰기 자격 게이트' 존재 강제 — 이게 빠지면 사용자 폴더가 조용히 파괴된다(#905 P1-②). ──
//  배경: pull 훅은 **찾은 폴더에 서버 파일을 덮어쓰고 stdout 을 안 낸다**(무음). 그래서 '여기 써도 되는가' 판정이
//   생명이다. #3787 에서 그 판정의 **권위가 로컬 마커 → 서버**로 옮겨졌다(마커는 오프라인 폴백 캐시로 강등):
//   종전 폴백(경로 모양 추측 livelyOwnedDir)은 노드의 자리 `<shared root>/project/<id>` 에서 **항상 거짓**이라
//   로컬 세션의 동기화가 통째로 죽어 있었다. 여기서 강제하는 것은 **게이트의 존재**이지 그 구현이 아니다.
//  누가 게이트를 지우면 여기서 걸린다. 실제 동작 증명은 project-pull-gate.test.mjs 가 훅을 돌려서 한다.
{
  for (const id of ["project-pull", "project-pull-turn"]) {
    const h = DEFAULT_HOOKS.find((x) => x.id === id);
    assert.ok(h, `pull 훅 '${id}' 이 시드에 없음`);
    const src = h!.source_code;
    // ① 권위 조회 — 서버에 '이 노드에서 어디에 무슨 모드로' 를 묻는다.
    assert.ok(/async function askServer\(/.test(src) && /await askServer\(/.test(src),
      `훅 '${id}' 이 서버 권위(askServer)를 묻지 않음 — 판정 근거가 사라지면 아무 폴더에나 쓰게 된다(#3787)`);
    // ② 오프라인 폴백 — 마커 캐시. 서버가 안 잡힐 때도 **추측이 아니라 서버가 저술한 값**으로만 판정한다.
    assert.ok(/function fromCache\(/.test(src) && /\?\?\s*fromCache\(/.test(src),
      `훅 '${id}' 에 마커 캐시 폴백(fromCache)이 없음 — 서버가 안 잡히면 판정 근거가 없어진다`);
    // ③ 실제로 걸리나 — 모드가 none·미지이면 조기 return.
    assert.ok(/mode === "none"\)\s*return/.test(src),
      `훅 '${id}' 이 모드 none 에서 조기 return 하지 않음 — 게이트가 선언만 되고 안 걸림`);
    // ④ 구 work.mjs 마커 무회귀 폴백 — 그 설치의 동기화가 조용히 끊기면 안 된다.
    assert.ok(/function legacyWorkDir\(/.test(src),
      `훅 '${id}' 에 구 work.mjs 마커 폴백(legacyWorkDir)이 없음 — sync 키 없는 기존 설치의 동기화가 끊긴다`);
  }
  ok("pull 훅 2종에 쓰기 자격 게이트(서버 권위 + 캐시 폴백 + none 조기return + 구 마커 무회귀) 존재");
}

// ── #3787 — cwd 싱크 3종은 **기본 설치에서 켜져 있어야** 한다. ──
//  「프로젝트 세션이면 그 프로젝트 자료가 cwd 에 있다」는 실행 위치와 무관하게 성립해야 하는 계약이고,
//  기본 꺼짐이면 로컬 노드 세션에선 그 계약이 거짓이 된다(자료도 안 오고, 만든 것도 안 올라간다).
//  매니지드(colocated)는 셋 다 즉시 no-op 이라 비용이 안 붙는다 — 켜 두는 쪽의 손해가 없다.
{
  for (const id of ["project-pull", "project-pull-turn", "project-pull-tool", "project-push", "project-push-tool"]) {
    const h = DEFAULT_HOOKS.find((x) => x.id === id);
    assert.ok(h, `동기화 훅 '${id}' 이 시드에 없음`);
    assert.equal(h!.enabled, true, `동기화 훅 '${id}' 이 기본 꺼짐 — 로컬 노드 세션에서 cwd 싱크 계약이 깨진다(#3787)`);
  }
  // push 는 두 이벤트에 걸린다 — Stop 만이면 턴 하나가 통째로 싱크 지연이고, PostToolUse 만이면 Bash 밖 변경을 놓친다.
  // #3787 — pull 계기가 SessionStart·UserPromptSubmit 뿐이면 **사람 지시 없이 오래 도는 세션**은 턴 내내 새
  //  자료를 못 받는다. 그 구멍을 PostToolUse 판이 막는다(같은 소스, 최소 간격만 다름).
  const pullTool = DEFAULT_HOOKS.find((x) => x.id === "project-pull-tool")!;
  const pullTurn = DEFAULT_HOOKS.find((x) => x.id === "project-pull-turn")!;
  assert.equal(pullTool.event, "PostToolUse", "project-pull-tool 은 PostToolUse 여야 한다");
  assert.equal(pullTool.source_code, pullTurn.source_code, "pull 두 판은 **같은 소스**여야 한다(복제하면 반드시 갈라진다)");
  assert.ok(/PULL_MIN_INTERVAL_MS/.test(pullTool.source_code), "PostToolUse 판의 자기제한이 소스에 없다 — 도구마다 네트워크를 탄다");

  const tool = DEFAULT_HOOKS.find((x) => x.id === "project-push-tool")!;
  assert.equal(tool.event, "PostToolUse", "project-push-tool 은 PostToolUse 여야 한다");
  assert.ok(/Bash/.test(tool.matcher ?? ""), "project-push-tool 매처에 Bash 가 없음 — 파일 변경의 상당수가 sed·리다이렉트·git 으로 일어난다");
  assert.equal(DEFAULT_HOOKS.find((x) => x.id === "project-push")!.event, "Stop", "project-push 는 Stop 이어야 한다(놓친 것 쓸어담는 그물)");
  ok("cwd 싱크 훅 4종이 기본 켜짐 + push 가 Stop·PostToolUse 양쪽에 걸림(#3787)");
}

// ── 스킬 무결성 + 짝훅 참조 해결(paired_hook_id → 실제 시드 훅) ──
{
  const ids = new Set<string>();
  const hookIds = new Set(DEFAULT_HOOKS.map((h) => h.id));
  for (const s of DEFAULT_SKILLS) {
    assert.ok(s.id && !ids.has(s.id), `스킬 id 누락/중복: ${s.id}`); ids.add(s.id);
    assert.ok(KINDS.has(s.kind), `스킬 '${s.id}' kind 불량: ${s.kind}`);
    assert.ok(s.body && s.body.trim().length > 0, `스킬 '${s.id}' body 비어있음`);
    assert.ok(HARNESSES.has(s.harness), `스킬 '${s.id}' harness 불량: ${s.harness}`);
    if (s.paired_hook_id) {
      assert.ok(hookIds.has(s.paired_hook_id), `스킬 '${s.id}' 짝훅 '${s.paired_hook_id}' 이 시드 훅에 없음 — enforcement 훅 유실`);
    }
  }
  assert.ok(DEFAULT_SKILLS.length >= 12, `기대 스킬 ≥12, 실제 ${DEFAULT_SKILLS.length}`);
  ok(`스킬 ${DEFAULT_SKILLS.length}종 무결성(고유 id·kind·body·짝훅 참조 해결)`);
}

// ── 지식 무결성 ──
{
  const names = new Set<string>();
  for (const k of DEFAULT_KNOWLEDGE) {
    assert.ok(k.name && !names.has(k.name), `지식 name 누락/중복: ${k.name}`); names.add(k.name);
    assert.ok(k.body_md && k.body_md.trim().length > 0, `지식 '${k.name}' body_md 비어있음`);
    assert.ok(INJECTIONS.has(k.injection), `지식 '${k.name}' injection 불량: ${k.injection}`);
    assert.equal(k.lifecycle, "active", `지식 '${k.name}' lifecycle 은 active 여야 시드된다`);
  }
  ok(`지식 ${DEFAULT_KNOWLEDGE.length}종 무결성(고유 name·body·injection·active)`);
}

// ── 배포 안전성 회귀 가드 — 훅·스킬 본문에 하드코딩 시크릿·라이블리 내부 호스트·절대경로가 새지 않았는지. ──
//  디폴트는 모든 고객 박스에 배포되므로, 라이블리 전용 자산이 섞이면 유출·파손. 게이트웨이 주소·토큰은
//  멤버 env(LIVELY_TOKEN/gateway-url)에서 읽어야 하며 본문에 리터럴로 박히면 안 된다.
{
  const LEAK = [
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: "개인키" },
    { re: /\bAKIA[0-9A-Z]{16}\b/, why: "AWS 액세스키" },
    { re: /\bsk-[A-Za-z0-9]{20,}\b/, why: "API 시크릿키" },
    { re: /lvly\.io/, why: "라이블리 내부 호스트" },
    { re: /@snu\.ac\.kr/, why: "개인 이메일" },
    { re: /\/Users\/[a-z]/, why: "맥 절대경로" },
    { re: /\/home\/[a-z][a-z0-9]+\//, why: "리눅스 홈 절대경로" },
  ];
  // #878 스킬(고객이 보는 마크다운 본문·설명)에 지식 KN_LEAK 과 동형의 구조적 트립와이어 — 내부 링크·시딩
  //  자기참조·메타블록. closeout 이 지식→스킬로 이동하며 스킬 본문 SoT 가 DB 캡처가 됐는데(각색 파일 레이어
  //  없음), 종전 스킬 스캔은 시크릿·경로만 봐서 [[내부링크]]·메타블록을 놓쳤다(지식은 KN_LEAK 이 봤다). 그
  //  구멍을 메운다. 훅(JS 소스)은 별개라 미적용([[·"고객 박스" 가 코드엔 정당히 나올 수 있다).
  //  ⚠ exempt: llm-wiki-init-* 스킬은 위키링크 문법([[…]]) 자체를 가르치는 게 목적이라 [[ 는 정당한 교육
  //   콘텐츠다(고객이 자기 위키에서 쓸 문법 예시 — 우리 내부 지식으로의 댕글링이 아니다). 그 스킬에서만 [[ 룰을
  //   면제한다. 자기참조·메타블록 룰은 그 스킬에도 그대로 적용된다.
  const MD_ASSET_LEAK: Array<{ re: RegExp; why: string; exempt?: (id: string) => boolean }> = [
    { re: /\[\[/, why: "위키 내부 링크([[…]]) — 고객 박스엔 대상이 없어 댕글링", exempt: (id) => /^llm-wiki-/.test(id) },
    { re: /src\/org\/delivery\/(seed-knowledge|default-content)/, why: "시딩 메커니즘 자기참조(내부 경로)" },
    { re: /고객 박스에도 시딩|이 (루틴|지식|스킬)은 .*고객 박스/, why: "시딩 메타블록(우리 내부 운영 설명)" },
  ];
  const scan = (label: string, id: string, text: string) => {
    for (const { re, why } of LEAK) assert.ok(!re.test(text), `${label} '${id}' 에 ${why} 로 보이는 리터럴이 있음 — 디폴트 배포 부적합`);
  };
  for (const h of DEFAULT_HOOKS) scan("훅", h.id, h.source_code);
  for (const s of DEFAULT_SKILLS) {
    const text = s.body + " " + (s.description ?? "") + " " + JSON.stringify(s.frontmatter);
    scan("스킬", s.id, text);
    for (const { re, why, exempt } of MD_ASSET_LEAK) {
      if (exempt && exempt(s.id)) continue;
      assert.ok(!re.test(text), `스킬 '${s.id}' 에 ${why} 로 보이는 것이 있음 — 고객 배포 부적합(스킬 본문·설명은 고객 맥락으로 각색)`);
    }
  }
  ok("배포 안전성 — 훅·스킬 본문에 시크릿·내부호스트·절대경로 없음 + 스킬 구조 트립와이어([[·자기참조·메타블록)");
}

// ── #846 시딩 지식 SoT 동기화 가드 — default-content.ts 의 지식 본문·메타 == seed-knowledge/ 파일. ──
//  왜: 지식 시딩본은 dev WIKI DB 를 그대로 캡처하면 내부 사고·[[링크]]·타 고객사명이 새어 나가(v0.1.148~150
//  실측 유출) 고객 맥락으로 각색해야 한다. 그 각색본의 SoT 를 seed-knowledge/<name>.md 로 옮겨 capture(DB)가
//  덮지 못하게 했다. default-content.ts(baked·런타임 시드)는 그 파일에서 재생성되며, 여기서 둘이 바이트
//  일치함을 강제한다 — default-content.ts 를 손으로 고치거나 옛 capture 로 DB 본문을 도로 굳히면 이 테스트가
//  깨진다. 고치는 법: seed-knowledge/<name>.md 편집 후 `node scripts/sync-seed-knowledge.mjs`.
{
  const meta: Array<Record<string, any>> = JSON.parse(fs.readFileSync(path.join(SEED_DIR, "manifest.json"), "utf8"));
  const seedNames = meta.map((m) => m.name).sort();
  const dcNames = DEFAULT_KNOWLEDGE.map((k) => k.name).sort();
  assert.deepEqual(seedNames, dcNames, "manifest.json 의 지식 이름이 DEFAULT_KNOWLEDGE 와 불일치 — 한쪽만 추가/삭제됨");
  for (const m of meta) {
    const k = DEFAULT_KNOWLEDGE.find((x) => x.name === m.name)!;
    const body = fs.readFileSync(path.join(SEED_DIR, `${m.name}.md`), "utf8");
    assert.equal(k.body_md, body, `'${m.name}' 본문이 seed-knowledge/${m.name}.md 와 다름 — 'node scripts/sync-seed-knowledge.mjs' 를 실행하세요(default-content.ts 를 직접 고치지 말 것)`);
    for (const f of ["title", "injection", "provenance", "lifecycle", "is_wiki", "type"] as const) {
      assert.equal((k as any)[f], m[f], `'${m.name}' 의 ${f} 가 manifest.json 과 다름 — sync 필요`);
    }
  }
  ok(`시딩 지식 ${meta.length}종이 seed-knowledge/ SoT 와 일치(본문·메타 바이트 대조 — 하드에딧·DB 재오염 가드)`);
}

// ── #846 배포 안전성 — 시딩 지식 본문·제목에 '고객 박스로 새면 안 되는 내부 흔적'이 없는지. ──
//  구조적 트립와이어: [[내부 링크]](고객 박스엔 대상 지식이 없어 댕글링) · 시딩 메커니즘 자기참조 ·
//  메타블록 · 시크릿/내부호스트/절대경로. (closeout 회귀는 [[]]+메타블록으로, domainmap 유출은 [[]]로
//  여기서 걸렸을 것이다.) ⚠ 한계: 타 고객사명·사내 인물 같은 '평문 이름' 유출은 정규식으로 못 잡는다 —
//  그건 seed-knowledge/*.md 를 사람이 각색할 때 + knowledge_save 의 seed_warning 리마인더가 막는 몫이다.
{
  const KN_LEAK = [
    { re: /\[\[/, why: "위키 내부 링크([[…]]) — 고객 박스엔 대상이 없어 댕글링" },
    { re: /src\/org\/delivery\/(seed-knowledge|default-content)/, why: "시딩 메커니즘 자기참조(내부 경로)" },
    { re: /고객 박스에도 시딩|이 (루틴|지식)은 .*고객 박스/, why: "시딩 메타블록(우리 내부 운영 설명)" },
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: "개인키" },
    { re: /\bAKIA[0-9A-Z]{16}\b/, why: "AWS 액세스키" },
    { re: /lvly\.io/, why: "라이블리 내부 호스트" },
    { re: /@snu\.ac\.kr/, why: "개인 이메일" },
    { re: /\/Users\/[a-z]/, why: "맥 절대경로" },
  ];
  for (const k of DEFAULT_KNOWLEDGE) {
    for (const { re, why } of KN_LEAK) {
      assert.ok(!re.test(k.body_md), `시딩 지식 '${k.name}' 본문에 ${why} 로 보이는 것이 있음 — 고객 배포 부적합(seed-knowledge/${k.name}.md 각색)`);
      assert.ok(!re.test(k.title ?? ""), `시딩 지식 '${k.name}' 제목에 ${why} 로 보이는 것이 있음`);
    }
  }
  ok("배포 안전성 — 시딩 지식 본문·제목에 내부 링크·시딩메타·시크릿·내부호스트·절대경로 없음");
}

console.log(`\n${pass} passed`);
