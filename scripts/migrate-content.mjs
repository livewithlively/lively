// P5 — 기존 콘텐츠 → knowledge_unit 마이그레이션 (비파괴·멱등·additive).
//
//   대상: (1) 로컬 auto-memory(.claude .../memory/*.md, MEMORY.md 인덱스 제외)
//         (2) productivity/research/*.md + 전략 문서(SERVICE-OVERVIEW 등) — 단, 본 스크립트는 READ-ONLY 로
//             원본을 읽기만 한다(파일 무수정). 쓰기는 items DB knowledge_unit 한 곳뿐.
//
//   원칙:
//     · 비파괴 — 원본 .md 절대 수정 안 함. DB 는 upsertKnowledge(additive, ON CONFLICT version+1).
//     · 멱등 — 같은 name 은 동일 내용 재upsert(재실행 시 신규 0, 오염 0). slug 충돌 시 -2.. 증가.
//     · source='migration' → confidenceFor() 가 'rule' 로 서버강제(human 자칭 불가).
//     · R-격리 — 섹션(R) 예약명(managed-policy/org-defaults)과 안 겹치게(모두 K/M/D/F 로만 쓰며, 이미 존재하는
//       R name 과 충돌하면 upsertKnowledge 가 throw — 가드에 걸리면 그 단위는 skip 하고 보고).
//
//   실행: node --env-file=/tmp/co-p1a-worktree/.env /tmp/co-p1a-worktree/scripts/migrate-content.mjs
//         --dry  : DB 미쓰기, 분류만 출력(검증/사전점검용).

import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { itemsPool } from "../dist/items/store.js";
import { upsertKnowledge, getKnowledge } from "../dist/org/knowledge.js";
import { assertNoHardSecrets } from "../dist/org/redact.js";

const DRY = process.argv.includes("--dry");
const ACTOR = "migration:P5";
const SOURCE = "migration";

const LOCAL_MEM_DIR =
  "/Users/lively/.claude/projects/-Users-lively--openclaw-workspace-productivity/memory";
const PROD_DIR = "/Users/lively/.openclaw/workspace/productivity";
const RESEARCH_DIR = join(PROD_DIR, "research");

// ── 슬러그화 — 파일명(확장자 제거) 그대로를 name 으로. 한글 보존(name PK 는 자유 텍스트 슬러그).
//    공백→'-', 슬래시 제거 정도만. 충돌 시 호출측에서 -2.. 부여.
function slugify(s) {
  return s
    .replace(/\.md$/i, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[\/\\]/g, "-");
}

// ── 아주 작은 YAML frontmatter 파서(--- ... --- 1블록, 우리 메모리 포맷 전용). 본문은 frontmatter 제거 후 전체.
//    중첩(metadata:) 의 type/node_type 만 평면 키로 끌어올린다. 파싱 실패해도 본문은 안전하게 통째 반환.
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: raw };
  const block = m[1];
  const body = raw.slice(m[0].length);
  const fm = {};
  for (const line of block.split(/\r?\n/)) {
    // 평면 키: "key: value" (들여쓰기 있는 줄도 key 만 취해 평탄화)
    const kv = line.match(/^\s*([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      let val = kv[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (val !== "") fm[key] = val; // 빈 값(중첩 헤더 'metadata:')은 무시 → 자식 줄이 평탄화됨
    }
  }
  return { fm, body };
}

function mtimeISO(path) {
  return statSync(path).mtime.toISOString().slice(0, 10); // YYYY-MM-DD
}

// 파일명 앞 YYYY-MM-DD 추출(research 파일 as_of). 없으면 null.
function dateFromName(name) {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// ── 멱등 upsert + slug 충돌 핸들링. 같은 source_ref 면 동일 단위로 보고 그 name 재사용(중복 생성 방지).
//    다른 source_ref 인데 name 충돌이면 -2.. 증가. R-flip 가드 throw 는 잡아서 skip 로 보고.
async function importUnit(base, unit, log) {
  let name = base;
  for (let i = 0; i < 50; i++) {
    const existing = await getKnowledge(name);
    if (existing) {
      // 같은 출처(=같은 논리 단위)면 그 name 으로 재upsert(멱등). 다른 출처면 다음 후보로.
      if (existing.source_ref && existing.source_ref === unit.source_ref) break;
      // source_ref 가 비어있던 기존 단위(예: 시드 K)와 우연히 이름이 같으면 충돌로 보고 회피.
      name = `${base}-${i + 2}`;
      continue;
    }
    break; // 빈 슬롯
  }
  // 시크릿 차단 — ctx_save 와 동일 choke-point. 하드 시크릿 포함 콘텐츠는 마이그 거부(skip+보고). DRY 에서도 적용.
  //  제품 원칙 "시크릿은 어떤 콘텐츠에도 안 들어간다" — 마이그가 upsertKnowledge 직접 호출이라 여기서 명시 강제.
  try {
    assertNoHardSecrets(unit.body_md ?? "", name);
  } catch (err) {
    log.push({ name, kind: unit.kind, action: "SKIP(secret)", error: String(err?.message ?? err) });
    return { status: "skip", name, error: String(err?.message ?? err) };
  }
  if (DRY) {
    log.push({ name, kind: unit.kind, kinds: unit.kinds, action: "DRY", source_ref: unit.source_ref });
    return { status: "dry", name };
  }
  try {
    const before = await getKnowledge(name);
    await upsertKnowledge({ ...unit, name }, ACTOR, SOURCE);
    const action = before ? (before.source_ref === unit.source_ref ? "reupsert(idempotent)" : "update") : "insert";
    log.push({ name, kind: unit.kind, action });
    return { status: before ? "existing" : "new", name };
  } catch (err) {
    log.push({ name, kind: unit.kind, action: "SKIP(guard)", error: String(err?.message ?? err) });
    return { status: "skip", name, error: String(err?.message ?? err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) 로컬 auto-memory
// ─────────────────────────────────────────────────────────────────────────────
async function migrateLocalMemory(log) {
  const files = readdirSync(LOCAL_MEM_DIR)
    .filter((f) => f.endsWith(".md") && f !== "MEMORY.md") // 인덱스 제외
    .sort();
  let nNew = 0,
    nExisting = 0,
    nSkip = 0;
  for (const f of files) {
    const path = join(LOCAL_MEM_DIR, f);
    const raw = readFileSync(path, "utf8");
    const { fm, body } = parseFrontmatter(raw);
    const slug = slugify(fm.name || f);
    // kind 휴리스틱: frontmatter type=feedback(스크래치/피드백류) → M(Memo), else K(지식노트).
    const isMemo = (fm.type || "").toLowerCase() === "feedback";
    const kind = isMemo ? "M" : "K";
    const title = fm.name || fm.title || slugify(f);
    const as_of = dateFromName(f) || mtimeISO(path);
    const unit = {
      kind,
      kinds: [], // 로컬 메모리는 단일분류
      title,
      body_md: body,
      source_ref: path,
      as_of,
      lifecycle: "active",
    };
    const r = await importUnit(slug, unit, log);
    if (r.status === "new") nNew++;
    else if (r.status === "existing") nExisting++;
    else if (r.status === "skip") nSkip++;
  }
  return { group: "local-memory", files: files.length, nNew, nExisting, nSkip };
}

// ─────────────────────────────────────────────────────────────────────────────
// (2) research / 전략 문서
//   결정적 분류표(파일명 키). 주kind + kinds[] 멀티태그. domain_key 추론 가능시 부여(현재 전부 null — 도메인
//   특정이 아니라 제품/전략/조직 차원).  decompose 안 함(통째 import) — 혼합 심한 건 manualDecompose 로만 보고.
// ─────────────────────────────────────────────────────────────────────────────
const RESEARCH_CLASS = {
  "2026-06-04-유사-플레이어-경쟁-랜드스케이프.md": { kind: "F", kinds: ["F", "K"], note: "외부 경쟁 리서치 + 우리 해자 결론(K) 혼합" },
  "2026-06-09-컨텍스트-온톨로지-저장소-배포-유형화.md": { kind: "D", kinds: ["D", "F"], note: "배포 유형화 설계 + 규제/업계 근거(F)" },
  "2026-06-09-파일럿-파트너-타깃-세그멘테이션.md": { kind: "F", kinds: ["F", "M"], note: "외부 시장 세그 리서치 + 세일즈 페르소나(M)" },
  "2026-06-11-PM툴-신원-훅-통합-설계결정.md": { kind: "K", kinds: ["K", "D"], note: "합의된 설계결정(ADR) + 설계 스펙(D)" },
  "2026-06-12-고객배포-리팩터-설계결정.md": { kind: "K", kinds: ["K", "D"], note: "설계결정(ADR) + 리팩터 스펙(D)" },
  "2026-06-16-delivery-web-ui-설계구현.md": { kind: "D", kinds: ["D", "K"], note: "설계·구현(D) + 결정 기록(K)" },
  "2026-06-16-hook-tool-crud-구현.md": { kind: "D", kinds: ["D", "K"], note: "설계·구현(D) + 보안 스탠스 결정(K)" },
  "2026-06-16-memory-save-flow.md": { kind: "D", kinds: ["D", "K"], note: "memory_save flow 설계(D, 부분 superseded) + 결정(K)" },
  "2026-06-16-멀티db읽기-설계.md": { kind: "D", kinds: ["D", "K"], note: "멀티 DB 읽기 설계(D) + 결정 기록(K)" },
  "2026-06-17-ddd-2026-담론-옹호-비판.md": { kind: "F", kinds: ["F"], note: "외부 DDD 담론 리서치(검증)" },
  "2026-06-17-ddd-구현도구-경쟁비교.md": { kind: "F", kinds: ["F", "K"], note: "외부 경쟁 리서치 + 우리 해자축 결론(K)" },
  "2026-06-17-gtm-bm-자금조달-전략.md": { kind: "K", kinds: ["K", "M"], note: "GTM/BM/자금조달 전략 결정 기록(K) + 세일즈 재사용(M)" },
  "2026-06-17-harness-vs-remote-memory.md": { kind: "F", kinds: ["F", "K"], note: "하네스 메모리 비교 리서치(F) + 우리 우위 결론(K)" },
  "2026-06-17-org-content-카테고리-일반화-설계.md": { kind: "D", kinds: ["D"], note: "카테고리 일반화 설계(미구현)" },
  "2026-06-17-port-corestory-프로파일.md": { kind: "F", kinds: ["F"], note: "경쟁사 프로파일(외부 리서치)" },
  "2026-06-17-shared-agent-memory-redesign.md": { kind: "K", kinds: ["K", "D"], note: "단순화 재설계 결정(ADR) + 설계(D)" },
  "2026-06-17-오픈코어-경계-1차가설.md": { kind: "K", kinds: ["K", "M"], note: "오픈코어 경계 1차 가설(결정/가설 K) + 세일즈 함의(M)" },
};

// 첫 # 제목 추출(없으면 파일명).
function firstHeading(body, fallback) {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : fallback;
}

async function migrateResearch(log) {
  if (!existsSync(RESEARCH_DIR)) return { group: "research", files: 0, nNew: 0, nExisting: 0, nSkip: 0, unclassified: [] };
  const files = readdirSync(RESEARCH_DIR).filter((f) => f.endsWith(".md")).sort();
  let nNew = 0,
    nExisting = 0,
    nSkip = 0;
  const unclassified = [];
  for (const f of files) {
    const path = join(RESEARCH_DIR, f);
    const raw = readFileSync(path, "utf8");
    const cls = RESEARCH_CLASS[f];
    if (!cls) {
      unclassified.push(f);
      continue; // 분류표에 없는 신규 파일은 보수적으로 skip(보고만)
    }
    const slug = slugify(f);
    const title = firstHeading(raw, slug);
    const as_of = dateFromName(f) || mtimeISO(path);
    const unit = {
      kind: cls.kind,
      kinds: cls.kinds,
      title,
      body_md: raw, // 통째 import(frontmatter 없음 — 원문 전체 보존)
      source_ref: path,
      as_of,
      domain_key: null, // 제품/전략/조직 차원 — 도메인 특정 아님
      lifecycle: "active",
    };
    const r = await importUnit(slug, unit, log);
    if (r.status === "new") nNew++;
    else if (r.status === "existing") nExisting++;
    else if (r.status === "skip") nSkip++;
  }
  return { group: "research", files: files.length, nNew, nExisting, nSkip, unclassified };
}

async function main() {
  console.log(`[P5 migrate] dry=${DRY} source=${SOURCE} actor=${ACTOR}`);
  const log = [];

  const before = await itemsPool.query(`SELECT kind, count(*)::int AS n FROM knowledge_unit GROUP BY kind ORDER BY kind`);
  console.log("BEFORE by kind:", JSON.stringify(before.rows));

  const r1 = await migrateLocalMemory(log);
  const r2 = await migrateResearch(log);

  if (!DRY) {
    const after = await itemsPool.query(`SELECT kind, count(*)::int AS n FROM knowledge_unit GROUP BY kind ORDER BY kind`);
    console.log("AFTER by kind:", JSON.stringify(after.rows));
  }

  console.log("\n── per-unit log ──");
  for (const e of log) console.log("  " + JSON.stringify(e));

  console.log("\n── summary ──");
  console.log(JSON.stringify({ localMemory: r1, research: r2 }, null, 2));
  if (r2.unclassified?.length) console.log("UNCLASSIFIED(skipped, report-only):", r2.unclassified);

  await itemsPool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("migrate 오류:", err?.stack ?? err);
  process.exit(1);
});
