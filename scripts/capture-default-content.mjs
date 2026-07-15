// 프로비저닝 디폴트 콘텐츠 캡처기 — 라이블리(canonical) 게이트웨이 DB 의 커스텀훅·하네스자산(스킬)을
//  읽고, '코드가 이름으로 전제하는' 지식은 src/org/seed-knowledge/ 의 각색 스냅샷에서 읽어
//  src/org/default-content.ts (신규 설치 시드 데이터)로 굳힌다. (#713)
//
//  배경: org 콘텐츠는 번들에 안 굽고 게이트웨이 DB 라이브 fetch 로 전달된다(2026-06-24 컷오버). 그래서
//   신규 고객 게이트웨이엔 이 콘텐츠가 0 이라, 코드가 이름으로 전제하는 런북(도메인맵 is-부트스트랩 2개) 등을
//   가리켜도 댕글링이 된다. 이 스크립트가 캡처한 데이터를 seed-content.ts 가 기동시 idempotent 시딩한다.
//
//  실행(canonical 게이트웨이 앱 루트, 빌드·.env 후):
//    node --env-file=.env scripts/capture-default-content.mjs
//  → src/org/default-content.ts 재생성. 커밋 전 `git diff` 로 의도한 변경만 들어갔는지 확인할 것.
//  (DB 없이 지식만 다시 굳히려면 `node scripts/sync-seed-knowledge.mjs` — seed-knowledge/*.md 편집 후.)
//
//  ⚠ 훅·스킬은 org_hook/org_harness_asset **전체**를 캡처한다 — 이 스크립트는 defaults 의 SoT 인
//    라이블리 게이트웨이에서만 돌린다는 전제(고객사·실험 자산이 섞인 DB 에서 돌리지 말 것).
//  ⚠ 지식 본문은 **DB 에서 캡처하지 않는다**(#846 재오염 차단). 우리 dev WIKI 의 지식 본문에는 내부 사고
//    이야기·`[[내부 링크]]`·사내 이슈번호·타 고객사 이름이 섞여 있어, DB 를 그대로 스냅샷하면 그게 고객
//    박스로 새어 나간다(실측: closeout 루틴 메타블록·타 고객사 도메인 구조가 v0.1.148~150 에 유출됐다).
//    → 시딩본은 고객 맥락으로 각색해 `src/org/seed-knowledge/<name>.md` 에 손으로 유지하고(SoT), 여기선
//    그 파일만 읽는다. 새 코드 참조가 생기면 `grep -rn "knowledge_get('" src/` 로 찾아 KNOWLEDGE_NAMES
//    에 더하고 seed-knowledge/manifest.json + <name>.md 를 함께 만든다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// pg 는 DB 캡처(main)에만 필요 — emit/read/parse 순수함수를 import 하는 sync·테스트는 pg 없이도 돌게
//  main() 안에서 동적 import 한다(회수된 워크트리처럼 node_modules 최소인 데서도 sync 가 동작).

// 코드가 이름으로 전제하는 지식(댕글링 방지 대상). 근거: src/scheduler.ts (런북 2개를 부트스트랩 프롬프트에 주입).
//  (project-closeout 은 #878 에서 지식→스킬로 이동 — 스킬은 org_harness_asset 로 캡처된다.)
const KNOWLEDGE_NAMES = [
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
const SEED_DIR = path.join(here, "..", "src", "org", "seed-knowledge");

// 시딩 지식 = seed-knowledge/manifest.json(메타) + <name>.md(본문). DB 아님(#846 재오염 차단).
//  emit 은 name 순 정렬을 전제하므로 여기서 정렬해 결정론 출력(캡처/오프라인 sync 가 동일 바이트).
export function readSeedKnowledge() {
  const meta = JSON.parse(fs.readFileSync(path.join(SEED_DIR, "manifest.json"), "utf8"));
  return meta
    .map((m) => ({
      name: m.name, title: m.title, injection: m.injection, provenance: m.provenance,
      lifecycle: m.lifecycle, is_wiki: m.is_wiki, type: m.type,
      body_md: fs.readFileSync(path.join(SEED_DIR, `${m.name}.md`), "utf8"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// 기존 default-content.ts 에서 export 배열(DEFAULT_HOOKS/…) 하나를 뽑는다 — 오프라인 sync 가 훅·스킬을
//  DB 없이 그대로 재사용하기 위함. 문자열-인식 괄호매칭으로 `= [ … ]` 리터럴만 슬라이스해 JSON.parse.
export function parseModuleArray(src, exportName) {
  const anchor = src.indexOf(`export const ${exportName}`);
  if (anchor < 0) throw new Error(`${exportName} 를 찾지 못함`);
  const start = src.indexOf("[", src.indexOf("=", anchor));   // '=' 뒤 첫 '[' = 타입주석 '[]' 아닌 진짜 배열
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return JSON.parse(src.slice(start, i + 1));
  }
  throw new Error(`${exportName} 배열 끝을 찾지 못함`);
}

// 순수 emit — 행 배열 → TS 모듈 문자열. (캡처/테스트가 공유하는 단일 포맷.)
export function emitDefaultContentModule({ hooks, skills, knowledge }) {
  const j = (v) => JSON.stringify(v, null, 2);
  return `// ─────────────────────────────────────────────────────────────────────────────
// 프로비저닝 디폴트 콘텐츠 — 신규 게이트웨이가 '코드가 전제하는 지식·훅·스킬' 없이 뜨지 않게 한다(#713).
//  seed-content.ts 가 기동시(org+v6 스키마 뒤) idempotent 시딩한다: 없을 때만 삽입(ON CONFLICT DO NOTHING /
//  존재가드) — 운영자 토글·편집은 절대 안 덮는다(신규 설치 기본값일 뿐, off 는 delete 가 아니라 disable).
//
// ⚠ 자동 생성물 — 손으로 고치지 말 것.
//   · 훅·스킬: canonical(라이블리) 게이트웨이에서 바꾼 뒤 \`node --env-file=.env scripts/capture-default-content.mjs\`.
//   · 지식 본문: \`src/org/seed-knowledge/<name>.md\` 가 SoT(고객 맥락 각색본). 그 파일을 고친 뒤
//     \`node scripts/sync-seed-knowledge.mjs\`(DB 불필요) 또는 위 capture 로 이 파일을 재생성한다.
//     ⚠ 이 파일의 지식 본문을 직접 고치지 말 것 — 다음 재생성에 덮여 사라진다(#846 이 그렇게 재오염됐다).
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
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.ITEMS_DATABASE_URL, max: 2 });
  const hooks = (await pool.query(
    `SELECT id, label, harness, event, matcher, timeout_sec, note, enabled, sort, source_code
       FROM org_hook ORDER BY sort, id`)).rows;
  const skills = (await pool.query(
    `SELECT id, kind, label, harness, description, frontmatter, paired_hook_id, enabled, sort, body
       FROM org_harness_asset ORDER BY kind, sort, id`)).rows;
  await pool.end();

  // 지식 본문은 DB 가 아니라 seed-knowledge/ 각색 스냅샷에서(위 헤더 참조 — #846 재오염 차단).
  const knowledge = readSeedKnowledge();
  // 코드 참조(KNOWLEDGE_NAMES) ↔ 시드(manifest) 정합 — 한쪽만 늘면 댕글링이거나 시드 누락이다.
  const seededNames = new Set(knowledge.map((k) => k.name));
  const missing = KNOWLEDGE_NAMES.filter((n) => !seededNames.has(n));
  if (missing.length) throw new Error(`코드 참조 지식이 seed-knowledge/ 에 없음: ${missing.join(", ")} — manifest.json + <name>.md 를 추가하세요`);
  const extra = [...seededNames].filter((n) => !KNOWLEDGE_NAMES.includes(n));
  if (extra.length) console.warn(`⚠ seed-knowledge 에 코드가 참조하지 않는 지식: ${extra.join(", ")}`);

  // 신규 설치 기본값 강제(위 SEED_DISABLED) — 우리 dev 토글이 고객 디폴트로 새지 않게.
  const forced = [...hooks, ...skills].filter((r) => SEED_DISABLED.has(r.id) && r.enabled);
  for (const r of forced) r.enabled = false;
  if (forced.length) console.warn(`⚠ 시드 기본값 강제 off(dev 에선 켜져 있음): ${forced.map((r) => r.id).join(", ")}`);

  fs.writeFileSync(OUT, emitDefaultContentModule({ hooks, skills, knowledge }));
  console.log(`✓ ${path.relative(path.join(here, ".."), OUT)} — hooks=${hooks.length} skills=${skills.length} knowledge=${knowledge.length}`);
}

// import 전용(테스트·genfromjson)일 땐 main 을 안 돈다. 직접 실행 판정은 경로 정규화로(상대/절대 혼용 footgun 회피).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
