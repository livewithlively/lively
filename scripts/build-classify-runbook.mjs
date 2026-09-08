// 분류 런북 빌더 — ground-truth(kind_registry + data_source)에서 runbooks/knowledge-types.md 를 *렌더*.
//
//   원칙(D-GT): 지식유형/분류기준/저장방식/전달방식의 단일 출처는 DB(kind_registry·data_source)다.
//     이 스크립트는 그 ground-truth 를 읽어 사람·LLM 이 함께 읽는 마크다운으로 렌더할 뿐, 정의를 여기 적지 않는다
//     (코드 상수 = stale 원천이므로 금지). 웹 #/learn(GET /api/ui/learn)과 **동일 데이터**(learnGroundTruth) →
//     양 표면이 항상 일치(non-stale).
//
//   용도: LLM 이 마이그/증류 시 읽는 분류 지침 + 사람도 읽음. 멱등(같은 DB 상태 → byte-identical 출력).
//
//   실행: npm run build && node --env-file-if-exists=.env scripts/build-classify-runbook.mjs
//         --check : 파일을 쓰지 않고 현재 파일이 ground-truth 와 일치하는지만 확인(불일치 시 exit 1, CI/검증용).
//         --stdout: 파일 대신 stdout 으로(파이프/실증용).
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { learnGroundTruth } from "../dist/org/knowledge.js";
import { itemsPool } from "../dist/items/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "runbooks", "knowledge-types.md");
const CHECK = process.argv.includes("--check");
const STDOUT = process.argv.includes("--stdout");

// 마크다운 셀 안전화 — 본문에 들어가는 자유텍스트의 파이프/개행이 표/단락을 깨지 않게.
const cell = (s) => String(s ?? "").replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
const inline = (s) => String(s ?? "").replace(/\r?\n+/g, " ").trim();

function render({ kinds, sources }) {
  const L = [];
  L.push("# 지식유형 분류 런북 (knowledge-types)");
  L.push("");
  L.push("> **자동 생성물 — 직접 수정 금지.** 출처(ground-truth)는 DB 의 `kind_registry`·`data_source` 이며,");
  L.push("> `scripts/build-classify-runbook.mjs` 가 렌더한다. 정의를 바꾸려면 DB(또는 시드 `src/org/schema.ts`)를 고치고");
  L.push("> 재빌드한다. 웹 `#/learn`(GET `/api/ui/learn`)이 같은 데이터를 렌더하므로 두 표면은 항상 일치한다.");
  L.push("");
  L.push("이 문서는 (1) LLM 이 지식을 마이그/증류·분류할 때 읽는 **분류 지침**이자 (2) 사람이 읽는 안내다.");
  L.push("");
  L.push("## 0. V4 분류 모델 — 본질 종류 4종 × 주제(area) × 출처(provenance)");
  L.push("");
  L.push("- **종류(kind) = 본질만, 4종: R·K·H·W.**");
  L.push("  - **R**(규칙/정책/페르소나) = 모든 세션에 강제하는 규범·말투. **항상 주입.**");
  L.push("  - **K**(지식 노트) = 거의 모든 저작 지식(배경·사실·도메인 지식·메모·링크를 다 흡수). 가장 큰 기본값.");
  L.push("  - **H**(하우투/런북) = 재현 가능한 단계별 절차.");
  L.push("  - **W**(작업/태스크) = 상태·담당을 가진 일.");
  L.push("- **주제(area) = 종류가 아니라 별도 축**: 분류축(category) `key` 하나. 위에 얹힌 고정 서랍장은 없다(#1631 — 축은 조직이 자기 일에서 뽑아낸다). 한 단위가 area 에 안 묶이거나(전사) 여럿에 묶일 수 있다.");
  L.push("- **출처(provenance) = 종류가 아니라 기계적 사실**(컬럼명은 `confidence` 유지): `observed`(외부 시스템 살아있는 미러) · `human`(사람 저작/승인) · `ai`(AI 생성) · `rule`(시스템 결정론 파생). 출처는 가치·주입을 결정하지 않는다.");
  L.push("- **S(구조)·G(용어집/그래프) 는 ku 종류가 아니다** — 모양이 글이 아니라 노드+엣지라 domainmap 파생 그래프(**federated 뷰**)로 다룬다. 도메인 부채도 ku 아님(domainmap `debt_finding`).");
  L.push("- ⚠ 아래 표의 **D·F·A·M·S·G·L·Z 는 통합 예정 legacy 종류**다(P1 무중단 유지 — 라이브 유닛이 아직 그 종류라 정상 렌더). **신규 분류에선 쓰지 말고** D/F/A/M/L/Z→K, S/G→domainmap federate 로 보낸다(데이터 흡수는 P2).");
  L.push("");

  // ── 1. 지식 종류 정의(4 본질 + legacy 보존) ──
  L.push("## 1. 지식 종류 — 정의·분류기준·저장·전달 (본질 4종 R·K·H·W + 통합 예정 legacy)");
  L.push("");
  for (const k of kinds) {
    L.push(`### ${k.kind} — ${k.label}`);
    L.push("");
    if (k.description) L.push(`**정의.** ${inline(k.description)}`);
    if (k.criteria) { L.push(""); L.push(`**언제 이 종류인가(분류기준).** ${inline(k.criteria)}`); }
    L.push("");
    L.push(`- 저장방식: ${inline(k.storage) || "—"}`);
    L.push(`- 전달방식: ${inline(k.delivery) || "—"} (injection_mode=\`${k.injection_mode}\`)`);
    L.push(`- 도메인 귀속: ${k.domain_scoped ? "예(domainmap 도메인에 묶임)" : "아니오"} · 다중: ${k.cardinality}`);
    L.push("");
  }

  // ── 2. 요약표(빠른 참조) ──
  L.push("## 2. 빠른 참조표");
  L.push("");
  L.push("| 종류 | 이름 | 분류기준(요약) | 전달방식 |");
  L.push("|---|---|---|---|");
  const brief = (s) => { const t = inline(s); return t.length > 90 ? t.slice(0, 88).trimEnd() + "…" : t; };
  for (const k of kinds) {
    L.push(`| ${k.kind} | ${cell(k.label)} | ${cell(brief(k.criteria))} | ${cell(k.delivery)} |`);
  }
  L.push("");

  // ── 3. 데이터소스별 수집방식 ──
  L.push("## 3. 데이터소스별 수집방식");
  L.push("");
  L.push("외부 시스템에서 무엇이 어떻게 수집되어 어느 종류로 적재되는지. status=dropped 는 현재 수집 중단(커넥터 코드는 유지).");
  L.push("");
  L.push("| 소스 | 상태 | 수집방식 | 주기 | 적재 종류 |");
  L.push("|---|---|---|---|---|");
  for (const s of sources) {
    const st = s.status === "dropped" ? "중단(dropped)" : "수집중(active)";
    L.push(`| ${cell(s.label)} | ${st} | ${cell(s.collection_method)} | ${cell(s.cadence) || "—"} | ${cell((s.into_kinds || []).join(", "))} |`);
  }
  L.push("");

  // ── 4. 증류·분류 지침(LLM) ──
  L.push("## 4. 증류·마이그레이션 분류 지침 (LLM)");
  L.push("");
  L.push("- **종류(kind)는 R·K·H·W 4종 중에서만 고른다.** 기본값은 K — 강제 규범(R)·절차(H)·작업(W)이 아니면 거의 다 K.");
  L.push("  - 강제 규범(반드시/금지)·페르소나 → **R**. 재현 가능한 단계별 절차 → **H**. 상태·담당을 가진 일 → **W**.");
  L.push("  - 배경·사실·도메인 지식·메모·링크는 모두 → **K**(주제는 area, 출처는 provenance 로 따로 단다).");
  L.push("- **주제(area)는 종류와 별개 축**: 어느 분류축에 속하면 그 축의 key 를 단다. 전사면 null.");
  L.push("- **출처(provenance, 컬럼 confidence)는 기계가 채널로 박는 사실**이라 LLM 이 *판단*하지 않는다: 외부 미러=observed, 사람=human, AI=ai, 결정론 파생=rule.");
  L.push("- **D·F·A·M·S·G·L·Z 는 통합 예정 legacy** — 신규로 부여하지 말 것. D/F/A/M/L/Z 는 K 로, S/G 는 domainmap 파생(federated)으로 본다. 도메인 부채는 ku 가 아니라 domainmap `debt_finding`.");
  L.push("- 한 단위가 둘 이상 종류에 걸치면 주분류(kind) 하나 + 다중분류(kinds[])로 보조 종류를 단다.");
  L.push("");

  return L.join("\n") + "\n";
}

try {
  const gt = await learnGroundTruth();
  if (!gt.kinds.length) {
    console.error("FATAL: kind_registry 가 비어 있음 — 게이트웨이를 한 번 부팅(initOrgSchema)해 시드하세요.");
    process.exit(2);
  }
  const out = render(gt);

  if (STDOUT) {
    process.stdout.write(out);
  } else if (CHECK) {
    const cur = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (cur !== out) {
      console.error("MISMATCH: runbooks/knowledge-types.md 가 ground-truth 와 다름 — `node scripts/build-classify-runbook.mjs` 로 재생성하세요.");
      process.exit(1);
    }
    console.log("OK: knowledge-types.md 가 ground-truth 와 일치");
  } else {
    writeFileSync(OUT, out);
    console.log(`wrote ${OUT} (${gt.kinds.length} kinds, ${gt.sources.length} sources)`);
  }
} finally {
  await itemsPool.end().catch(() => {});
}
