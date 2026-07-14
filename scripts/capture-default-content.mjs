// 프로비저닝 디폴트 콘텐츠 캡처기 — 라이블리(canonical) 게이트웨이 DB 의 커스텀훅·하네스자산(스킬)과
//  '코드가 이름으로 전제하는' 지식을 읽어 src/org/default-content.ts (신규 설치 시드 데이터)로 굳힌다. (#713)
//
//  배경: org 콘텐츠는 번들에 안 굽고 게이트웨이 DB 라이브 fetch 로 전달된다(2026-06-24 컷오버). 그래서
//   신규 고객 게이트웨이엔 이 콘텐츠가 0 이라, 코드가 knowledge_get('project-closeout-routine') 등을
//   가리켜도 댕글링이 된다. 이 스크립트가 캡처한 데이터를 seed-content.ts 가 기동시 idempotent 시딩한다.
//
//  실행(canonical 게이트웨이 앱 루트, 빌드·.env 후):
//    node --env-file=.env scripts/capture-default-content.mjs
//  → src/org/default-content.ts 재생성. 커밋 전 `git diff` 로 의도한 변경만 들어갔는지 확인할 것.
//
//  ⚠ 훅·스킬은 org_hook/org_harness_asset **전체**를 캡처한다 — 이 스크립트는 defaults 의 SoT 인
//    라이블리 게이트웨이에서만 돌린다는 전제(고객사·실험 자산이 섞인 DB 에서 돌리지 말 것).
//  ⚠ 지식은 아무거나 다 담지 않는다 — '코드가 하드코딩된 이름으로 knowledge_get 하는' 것만(아래 allowlist).
//    새 코드 참조가 생기면 `grep -rn "knowledge_get('" src/` 로 찾아 KNOWLEDGE_NAMES 에 추가한다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// 코드가 이름으로 전제하는 지식(댕글링 방지 대상). 근거: src/v6/agents-md.ts, src/scheduler.ts.
const KNOWLEDGE_NAMES = [
  "project-closeout-routine",        // src/v6/agents-md.ts — 모든 프로젝트 AGENTS.md digest
  "runbook-bootstrap-domains",       // src/scheduler.ts — 도메인맵 is 부트스트랩 프롬프트
  "domainmap-is-bootstrap-runbook",  // src/scheduler.ts — 〃 (도구 델타)
];

// ⚠ 신규 설치 기본값 오버라이드 — canonical 게이트웨이에서 **시험 삼아 켜 둔 것**이 그대로
//  '신규 고객 기본 켜짐'으로 굳는 것을 막는다. capture 는 DB 를 스냅샷하므로 우리 dev 토글이
//  디폴트를 오염시킨다(2026-07-14 실측: project-pull-turn 이 false→true 로 뒤집힐 뻔했다 —
//  #828 은 "기본 꺼짐, 각 고객이 관리탭에서 켠다"로 결정했는데 우리가 dev 에서 켜 뒀을 뿐이다).
//  여기 등재된 id 는 DB 상태와 무관하게 enabled=false 로 시딩된다. 운영자가 켜면 그 상태는
//  보존된다(seed-content 는 '없을 때만 삽입' — 기존 행을 안 덮는다).
const SEED_DISABLED = new Set([
  "project-pull-turn",   // #828 — 턴마다 shared pull. 매니페스트 축소(#829)가 전제라 각 고객이 판단해 켠다.
]);

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "src", "org", "default-content.ts");

// 순수 emit — 행 배열 → TS 모듈 문자열. (캡처/테스트가 공유하는 단일 포맷.)
export function emitDefaultContentModule({ hooks, skills, knowledge }) {
  const j = (v) => JSON.stringify(v, null, 2);
  return `// ─────────────────────────────────────────────────────────────────────────────
// 프로비저닝 디폴트 콘텐츠 — 신규 게이트웨이가 '코드가 전제하는 지식·훅·스킬' 없이 뜨지 않게 한다(#713).
//  seed-content.ts 가 기동시(org+v6 스키마 뒤) idempotent 시딩한다: 없을 때만 삽입(ON CONFLICT DO NOTHING /
//  존재가드) — 운영자 토글·편집은 절대 안 덮는다(신규 설치 기본값일 뿐, off 는 delete 가 아니라 disable).
//
// ⚠ 자동 생성물 — 손으로 고치지 말 것. canonical(라이블리) 게이트웨이에서 디폴트를 바꾼 뒤
//    \`node --env-file=.env scripts/capture-default-content.mjs\` 로 재생성한다.
// ─────────────────────────────────────────────────────────────────────────────

export interface DefaultHook {
  id: string; label: string | null; harness: string; event: string; matcher: string | null;
  timeout_sec: number; note: string | null; enabled: boolean; sort: number; source_code: string;
}
export interface DefaultSkill {
  id: string; kind: string; label: string | null; harness: string; description: string;
  frontmatter: Record<string, unknown>; paired_hook_id: string | null; enabled: boolean; sort: number; body: string;
}
export interface DefaultKnowledge {
  name: string; title: string | null; injection: string; provenance: string; lifecycle: string;
  is_wiki: boolean; type: string | null; body_md: string;
}

// 커스텀 훅(org_hook) — 멤버 세션 하네스에서 실행. 런너(run-custom.mjs)가 content_hash 무결성으로 게이팅.
export const DEFAULT_HOOKS: DefaultHook[] = ${j(hooks)};

// 하네스 자산(org_harness_asset) — 스킬·서브에이전트·슬래시커맨드. materializer 가 멤버 하네스로 굳힌다.
export const DEFAULT_SKILLS: DefaultSkill[] = ${j(skills)};

// 코드가 이름으로 knowledge_get 하는 런북·루틴 — 신규 설치에 없으면 댕글링 포인터가 된다.
export const DEFAULT_KNOWLEDGE: DefaultKnowledge[] = ${j(knowledge)};
`;
}

async function main() {
  if (!process.env.ITEMS_DATABASE_URL) {
    console.error("ITEMS_DATABASE_URL 미설정 — canonical 게이트웨이 앱 루트에서 `node --env-file=.env` 로 실행하세요.");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: process.env.ITEMS_DATABASE_URL, max: 2 });
  const hooks = (await pool.query(
    `SELECT id, label, harness, event, matcher, timeout_sec, note, enabled, sort, source_code
       FROM org_hook ORDER BY sort, id`)).rows;
  const skills = (await pool.query(
    `SELECT id, kind, label, harness, description, frontmatter, paired_hook_id, enabled, sort, body
       FROM org_harness_asset ORDER BY kind, sort, id`)).rows;
  const knowledge = (await pool.query(
    `SELECT name, title, injection, provenance, lifecycle, is_wiki, type, body_md
       FROM knowledge WHERE name = ANY($1) AND lifecycle='active' ORDER BY name`, [KNOWLEDGE_NAMES])).rows;
  await pool.end();

  const missing = KNOWLEDGE_NAMES.filter((n) => !knowledge.some((k) => k.name === n));
  if (missing.length) console.warn(`⚠ 코드 참조 지식 누락(이 게이트웨이에 없음): ${missing.join(", ")}`);

  // 신규 설치 기본값 강제(위 SEED_DISABLED) — 우리 dev 토글이 고객 디폴트로 새지 않게.
  const forced = [...hooks, ...skills].filter((r) => SEED_DISABLED.has(r.id) && r.enabled);
  for (const r of forced) r.enabled = false;
  if (forced.length) console.warn(`⚠ 시드 기본값 강제 off(dev 에선 켜져 있음): ${forced.map((r) => r.id).join(", ")}`);

  fs.writeFileSync(OUT, emitDefaultContentModule({ hooks, skills, knowledge }));
  console.log(`✓ ${path.relative(path.join(here, ".."), OUT)} — hooks=${hooks.length} skills=${skills.length} knowledge=${knowledge.length}`);
}

// import 전용(테스트·genfromjson)일 땐 main 을 안 돈다. 직접 실행 판정은 경로 정규화로(상대/절대 혼용 footgun 회피).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
