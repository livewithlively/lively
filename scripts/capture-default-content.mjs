// 프로비저닝 디폴트 콘텐츠 캡처기 — 라이블리(canonical) 게이트웨이 DB 의 커스텀훅·하네스자산(스킬)을
//  읽고, '코드가 이름으로 전제하는' 지식은 src/org/seed-knowledge/ 의 각색 스냅샷에서 읽어
//  src/org/default-content.ts (신규 설치 시드 데이터)로 굳힌다. (#713)
//
//  배경: org 콘텐츠는 번들에 안 굽고 게이트웨이 DB 라이브 fetch 로 전달된다(2026-06-24 컷오버). 그래서
//   신규 고객 게이트웨이엔 이 콘텐츠가 0 이라, 코드가 이름으로 전제하는 런북(도메인맵 is-부트스트랩 2개) 등을
//   가리켜도 댕글링이 된다. 이 스크립트가 캡처한 데이터를 seed-content.ts 가 기동시 idempotent 시딩한다.
//
//  실행(canonical 게이트웨이 앱 루트, 빌드·.env 후):
//    node --env-file=.env scripts/capture-default-content.mjs                  # 전체 캡처(종전 동작)
//    node --env-file=.env scripts/capture-default-content.mjs --dry-run --diff # 안 쓰고 '바뀔 것'만(+본문 라인 diff)
//    node --env-file=.env scripts/capture-default-content.mjs --only id1,id2   # 그 id 변경만 반영, 나머지 시드 보존
//  → 항상 항목별 diff(추가/변경/제거)를 찍는다. src/org/default-content.ts 재생성 후 커밋 전 `git diff` 로 재확인.
//  (DB 없이 지식만 다시 굳히려면 `node scripts/sync-seed-knowledge.mjs` — seed-knowledge/*.md 편집 후.)
//
//  ⚠ 훅·스킬은 org_hook/org_harness_asset **전체**를 캡처한다 — 이 스크립트는 defaults 의 SoT 인
//    라이블리 게이트웨이에서만 돌린다는 전제(고객사·실험 자산이 섞인 DB 에서 돌리지 말 것).
//  ⚠ **내부 전용 자산은 `frontmatter.internal_only = true` 로 표시하면 시드에서 통째로 빠진다**(excludeInternalOnly).
//    우리 박스 특유의 경로(`workspace/productivity/...`)·포트(:8080)·사내 히스토리가 본문에 박힌 자산은 고객
//    박스에서 무의미하거나 오해를 부른다. SEED_DISABLED(=포함하되 기본 off)와 **다르다** — 그건 '기능은 주되
//    꺼서' 주는 것이고, 이건 **아예 주지 않는** 것이다(본문도 안 나간다). 지식이 #846 에서 DB 캡처를 끊은 것과 같은 취지.
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
  "project-push",        // #905 C3 — 턴 끝 up-sync. 팀 공유문서를 덮어쓸 수 있고 sync="both" 옵트인이 전제라 각 고객이 판단해 켠다.
  "session-log-capture", // #905 C1 — 턴 끝 트랜스크립트 캡처. 대화 전문이 중앙에 저장되므로 관리탭 ▸ 세션 공유로 조직이 명시 opt-in.
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

// ── 항목별 diff / 선택 캡처 헬퍼(#988) — dev DB 를 통째로 쓸어오지 않고, 무엇이 바뀌는지 보고 골라 반영한다. ──
export function parseCaptureArgs(argv) {
  const a = { dryRun: false, diff: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--dry-run" || t === "-n") a.dryRun = true;
    else if (t === "--diff") a.diff = true;
    else if (t === "--only") a.only = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (t.startsWith("--only=")) a.only = t.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean);
    else if (t === "--help" || t === "-h") {
      console.log("사용법: capture-default-content.mjs [--dry-run] [--diff] [--only id1,id2]\n" +
        "  --dry-run  파일 안 쓰고 바뀔 것만 보여줌\n" +
        "  --diff     변경 항목의 본문 라인 diff 까지\n" +
        "  --only     지정한 id 의 변경만 반영(나머지 시드는 현행 유지). 없으면 전체 캡처(종전 동작).");
      process.exit(0);
    }
  }
  if (a.only) a.only = new Set(a.only);
  return a;
}
const byId = (rows) => new Map(rows.map((r) => [r.id, r]));
// 내부 전용 자산 분리 — `frontmatter.internal_only === true` 면 고객 시드에서 **제외**(포함하되 off 가 아니라 미포함).
//  본문에 우리 박스 특유 경로·포트·사내 히스토리가 박힌 자산이 고객 박스로 새지 않게 한다(#846 지식 재오염 차단과 같은 취지).
export function excludeInternalOnly(rows) {
  const kept = [], excluded = [];
  for (const r of rows) ((r && r.frontmatter && r.frontmatter.internal_only === true) ? excluded : kept).push(r);
  return { kept, excluded };
}
// 현재 시드 vs DB 캡처 항목별 판정(추가/변경/제거) — id 기준, JSON 동등성으로 변경 감지.
export function diffRows(current, next) {
  const c = byId(current), n = byId(next), added = [], changed = [], removed = [];
  for (const id of new Set([...c.keys(), ...n.keys()])) {
    if (n.has(id) && !c.has(id)) added.push(id);
    else if (!n.has(id) && c.has(id)) removed.push(id);
    else if (JSON.stringify(c.get(id)) !== JSON.stringify(n.get(id))) changed.push(id);
  }
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}
// 선택 반영 — only 없으면 next 전체(종전 동작). 있으면 현행에서 only id 만 next 로 교체(추가/제거 포함), 나머지 보존.
export function mergeSelective(current, next, only) {
  if (!only) return next;
  const c = byId(current), n = byId(next), out = [];
  for (const id of new Set([...c.keys(), ...n.keys()])) {
    if (only.has(id)) { if (n.has(id)) out.push(n.get(id)); }   // 선택 = next 반영(next 에 없으면 제거)
    else if (c.has(id)) out.push(c.get(id));                    // 비선택 = 현행 시드 보존
  }
  return out;
}
// 본문 라인 diff — 공통 접두/접미 뺀 가운데 블록만(-옛/+새). 리뷰 가독 우선(정밀 LCS 아님).
export function lineDiff(a, b) {
  const A = String(a ?? "").split("\n"), B = String(b ?? "").split("\n");
  let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let ea = A.length, eb = B.length; while (ea > p && eb > p && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const out = [];
  for (let i = p; i < ea; i++) out.push("      - " + A[i]);
  for (let i = p; i < eb; i++) out.push("      + " + B[i]);
  return out.length ? out.join("\n") : "      (본문 동일 — 메타만 변경)";
}
function reportRows(label, d, current, next, showBody, only) {
  const parts = [];
  if (d.added.length) parts.push(`+${d.added.length}`);
  if (d.changed.length) parts.push(`~${d.changed.length}`);
  if (d.removed.length) parts.push(`-${d.removed.length}`);
  console.log(`\n[${label}] ${parts.length ? parts.join(" ") + "  (추가/변경/제거)" : "변경 없음"}`);
  const c = byId(current), n = byId(next);
  const mark = (id) => !only ? "" : (only.has(id) ? "  ✓적용" : "  ·유지(현행 시드)");
  const willApply = (id) => !only || only.has(id);
  for (const id of d.added) console.log(`  + ${id}${mark(id)}`);
  for (const id of d.changed) {
    console.log(`  ~ ${id}${mark(id)}`);
    if (showBody && willApply(id)) console.log(lineDiff(c.get(id).body ?? c.get(id).source_code, n.get(id).body ?? n.get(id).source_code));
  }
  for (const id of d.removed) console.log(`  - ${id}${mark(id)}`);
}
const sortHooks = (rows) => rows.slice().sort((x, y) => (x.sort - y.sort) || String(x.id).localeCompare(y.id));
const sortSkills = (rows) => rows.slice().sort((x, y) => String(x.kind).localeCompare(y.kind) || (x.sort - y.sort) || String(x.id).localeCompare(y.id));

async function main() {
  const args = parseCaptureArgs(process.argv.slice(2));
  if (!process.env.ITEMS_DATABASE_URL) {
    console.error("ITEMS_DATABASE_URL 미설정 — canonical 게이트웨이 앱 루트에서 `node --env-file=.env` 로 실행하세요.");
    process.exit(1);
  }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.ITEMS_DATABASE_URL, max: 2 });
  const nextHooks = (await pool.query(
    `SELECT id, label, harness, event, matcher, timeout_sec, note, enabled, sort, source_code
       FROM org_hook ORDER BY sort, id`)).rows;
  const capturedSkills = (await pool.query(
    `SELECT id, kind, label, harness, description, frontmatter, paired_hook_id, enabled, sort, body
       FROM org_harness_asset ORDER BY kind, sort, id`)).rows;
  await pool.end();

  // 내부 전용(frontmatter.internal_only) 자산은 고객 시드에서 통째로 제외 — 본문도 안 나간다(위 헤더 ⚠ 참조).
  const { kept: nextSkills, excluded: internalSkills } = excludeInternalOnly(capturedSkills);
  if (internalSkills.length) console.warn(`ⓘ 내부 전용이라 시드에서 제외(frontmatter.internal_only): ${internalSkills.map((r) => r.id).join(", ")}`);

  // 신규 설치 기본값 강제(SEED_DISABLED) — 우리 dev 토글이 고객 디폴트로 새지 않게. diff 가 '실제 쓰일 값'을 반영하도록 먼저.
  const forced = [...nextHooks, ...nextSkills].filter((r) => SEED_DISABLED.has(r.id) && r.enabled);
  for (const r of forced) r.enabled = false;
  if (forced.length) console.warn(`⚠ 시드 기본값 강제 off(dev 에선 켜짐): ${forced.map((r) => r.id).join(", ")}`);

  // 현재 시드에서 훅·스킬 배열 파싱 — 항목별 diff·선택 반영의 기준.
  const currentSrc = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;
  const currentHooks = currentSrc ? parseModuleArray(currentSrc, "DEFAULT_HOOKS") : [];
  const currentSkills = currentSrc ? parseModuleArray(currentSrc, "DEFAULT_SKILLS") : [];

  const hookD = diffRows(currentHooks, nextHooks), skillD = diffRows(currentSkills, nextSkills);
  if (args.only) {
    const allIds = new Set([...currentHooks, ...nextHooks, ...currentSkills, ...nextSkills].map((r) => r.id));
    const unknown = [...args.only].filter((id) => !allIds.has(id));
    if (unknown.length) console.warn(`⚠ --only 에 없는 id(오타?): ${unknown.join(", ")}`);
    const changedIds = new Set([...hookD.added, ...hookD.changed, ...hookD.removed, ...skillD.added, ...skillD.changed, ...skillD.removed]);
    const noop = [...args.only].filter((id) => allIds.has(id) && !changedIds.has(id));
    if (noop.length) console.warn(`ⓘ --only 인데 변경 없음(무시됨): ${noop.join(", ")}`);
  }

  reportRows("hooks", hookD, currentHooks, nextHooks, args.diff, args.only);
  reportRows("skills", skillD, currentSkills, nextSkills, args.diff, args.only);
  if (args.only) console.log(`\n선택 반영(--only): ${[...args.only].join(", ")}  (나머지 시드는 현행 유지)`);

  const outHooks = sortHooks(mergeSelective(currentHooks, nextHooks, args.only));
  const outSkills = sortSkills(mergeSelective(currentSkills, nextSkills, args.only));

  // 지식: 전체모드=seed-knowledge/ 각색본에서 재생성(파일 SoT). 선택모드=현행 보존(지식은 DB 캡처 대상이 아니다).
  let knowledge;
  if (args.only) {
    knowledge = currentSrc ? parseModuleArray(currentSrc, "DEFAULT_KNOWLEDGE") : [];
  } else {
    knowledge = readSeedKnowledge();
    const seededNames = new Set(knowledge.map((k) => k.name));
    const missing = KNOWLEDGE_NAMES.filter((n) => !seededNames.has(n));
    if (missing.length) throw new Error(`코드 참조 지식이 seed-knowledge/ 에 없음: ${missing.join(", ")} — manifest.json + <name>.md 를 추가하세요`);
    const extra = [...seededNames].filter((n) => !KNOWLEDGE_NAMES.includes(n));
    if (extra.length) console.warn(`⚠ seed-knowledge 에 코드가 참조하지 않는 지식: ${extra.join(", ")}`);
  }

  const emitted = emitDefaultContentModule({ hooks: outHooks, skills: outSkills, knowledge });
  const rel = path.relative(path.join(here, ".."), OUT);
  if (args.dryRun) {
    console.log(`\n(dry-run — ${rel} 안 씀)  최종 예정: hooks=${outHooks.length} skills=${outSkills.length} knowledge=${knowledge.length}`);
    return;
  }
  fs.writeFileSync(OUT, emitted);
  console.log(`\n✓ ${rel} 씀 — hooks=${outHooks.length} skills=${outSkills.length} knowledge=${knowledge.length}`);
}

// import 전용(테스트·genfromjson)일 땐 main 을 안 돈다. 직접 실행 판정은 경로 정규화로(상대/절대 혼용 footgun 회피).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
