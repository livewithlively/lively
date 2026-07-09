// 프로비저닝 디폴트 콘텐츠(default-content.ts) 계약·불변식 — DB 없이 도는 순수 검증. (#713)
//  seedDefaultContent 의 idempotent 삽입은 DB 가 필요해 라이브 스모크로 따로 본다(scripts/…). 여기선
//  '시드 데이터 자체'의 무결성 + 코드가 전제하는 지식이 시드에 있는지(회귀 방지)만 본다.
//  실행: npm run build && node dist/org/seed-content.test.js
import assert from "node:assert/strict";
import { DEFAULT_HOOKS, DEFAULT_SKILLS, DEFAULT_KNOWLEDGE } from "./default-content.js";

let pass = 0;
const ok = (name: string) => { pass++; console.log(`ok  ${name}`); };

const HARNESSES = new Set(["claude", "codex", "openclaw", "all"]);
const KINDS = new Set(["skill", "subagent", "command"]);
const INJECTIONS = new Set(["always", "recalled"]);

// ── 코드가 이름으로 knowledge_get 하는 지식이 시드에 반드시 있어야 한다(댕글링 방지의 핵심 회귀 가드). ──
//  근거: src/v6/agents-md.ts(project-closeout-routine), src/scheduler.ts(런북 2개). 이 이름을 시드에서 빼면
//  고객 게이트웨이에서 그 포인터가 다시 댕글링이 된다 — 그때 이 테스트가 깨져 알려준다.
{
  const CODE_REFERENCED = ["project-closeout-routine", "runbook-bootstrap-domains", "domainmap-is-bootstrap-runbook"];
  const names = new Set(DEFAULT_KNOWLEDGE.map((k) => k.name));
  for (const n of CODE_REFERENCED) assert.ok(names.has(n), `코드 참조 지식 '${n}' 이 시드에 없음 — 댕글링 포인터가 된다`);
  ok("코드가 전제하는 지식 3종이 모두 시드에 존재(project-closeout-routine·런북 2개)");
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
  const scan = (label: string, id: string, text: string) => {
    for (const { re, why } of LEAK) assert.ok(!re.test(text), `${label} '${id}' 에 ${why} 로 보이는 리터럴이 있음 — 디폴트 배포 부적합`);
  };
  for (const h of DEFAULT_HOOKS) scan("훅", h.id, h.source_code);
  for (const s of DEFAULT_SKILLS) scan("스킬", s.id, s.body + " " + JSON.stringify(s.frontmatter));
  ok("배포 안전성 — 훅·스킬 본문에 하드코딩 시크릿·내부호스트·절대경로 없음");
}

console.log(`\n${pass} passed`);
