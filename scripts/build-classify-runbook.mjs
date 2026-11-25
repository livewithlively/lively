// 분류 런북 빌더 — ground-truth(kind_registry + data_source)에서 runbooks/knowledge-types.md 를 *렌더*.
//
//   원칙(D-GT): 지식유형/분류기준/저장방식/전달방식의 단일 출처는 DB(kind_registry·data_source)다.
//     지식 분류(type 6종)의 정의는 knowledge_save 의 type 입력 선언이 단일 출처라 거기서 읽어 렌더한다
//     (런북에 type 목록을 따로 적으면 그 선언과 갈라진다 — kind 와 type 두 분류 안내가 공존했던 원인).
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
import { knowledgeSave } from "../dist/capabilities/knowledge/authoring.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "runbooks", "knowledge-types.md");
const CHECK = process.argv.includes("--check");
const STDOUT = process.argv.includes("--stdout");

// 마크다운 셀 안전화 — 본문에 들어가는 자유텍스트의 파이프/개행이 표/단락을 깨지 않게.
const cell = (s) => String(s ?? "").replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
const inline = (s) => String(s ?? "").replace(/\r?\n+/g, " ").trim();

// knowledge_save 의 type 입력(z.enum(...).optional().describe(...))에서 값 목록과 설명을 꺼낸다.
function knowledgeTypeDecl() {
  const field = knowledgeSave.input.type;
  const values = field?.unwrap?.().options;
  if (!Array.isArray(values) || !values.length) throw new Error("knowledge_save 의 type 입력 선언을 읽지 못했다 — 선언 모양이 바뀌었으면 이 함수를 맞춰라");
  // 선언 설명 앞의 「page-type(#이슈, …):」 머리는 도구 호출자용이라 런북에선 뗀다(선언 문구는 그대로 둔다).
  const description = String(field.description ?? "").replace(/^page-type\([^)]*\):\s*/, "");
  return { values, description };
}

function render({ kinds, sources }, types) {
  const L = [];
  L.push("# 지식유형 분류 런북 (knowledge-types)");
  L.push("");
  L.push("> **자동 생성물 — 직접 수정 금지.** 출처(ground-truth)는 DB 의 `kind_registry`·`data_source` 이며,");
  L.push("> `scripts/build-classify-runbook.mjs` 가 렌더한다. 정의를 바꾸려면 DB(또는 시드 `src/org/schema/registry.ts`)를 고치고");
  L.push("> 재빌드한다. 웹 `#/learn`(GET `/api/ui/learn`)이 같은 데이터를 렌더하므로 두 표면은 항상 일치한다.");
  L.push("> 지식 분류(type)의 목록·설명은 `knowledge_save` 의 `type` 입력 선언(`src/capabilities/knowledge/authoring.ts`)에서 렌더한다.");
  L.push("");
  L.push("이 문서는 (1) LLM 이 지식을 마이그/증류·분류할 때 읽는 **분류 지침**이자 (2) 사람이 읽는 안내다.");
  L.push("");
  L.push("## 0. 분류 모델 — 지식은 type 하나로 분류하고, kind 는 저장 자리다");
  L.push("");
  L.push(`- **지식의 분류 = \`type\` ${types.values.length}종: ${types.values.map((v) => "`" + v + "`").join("·")}.** 지식 하나에 하나만 단다(신규 저장 시 필수).`);
  L.push(`  - 정의(\`knowledge_save\` 의 \`type\` 설명에서): ${inline(types.description)}`);
  L.push("- **종류(kind) R·K·H·W = 맥락이 저장되는 자리**이고 지식의 두 번째 분류가 아니다.");
  L.push("  - **R**(규칙/정책/페르소나) = 세션 주입 섹션 문서. 지식이 아니라 type 을 달지 않는다. **항상 주입.**");
  L.push(`  - **K**(지식) = type 이 how-to 가 아닌 지식(${types.values.filter((v) => v !== "how-to").join("·")}).`);
  L.push("  - **H**(하우투/런북) = type=how-to 인 지식.");
  L.push("  - **W**(과업) = 프로젝트·태스크. 지식이 아니라 type 을 달지 않는다.");
  L.push("- **주제 = 종류가 아니라 별도 축**: 분류축(category) `key` 하나. 위에 얹힌 고정 서랍장은 없다(#1631 — 축은 조직이 자기 일에서 뽑아낸다). 지식은 카테고리 1개(단일 home)에 속하고, 교차 주제는 `knowledge_link` 로 잇는다.");
  L.push("- **출처(provenance) = 종류가 아니라 기계적 사실**: `authored`(저작) · `observed`(외부 시스템 살아있는 미러). 외부 미러는 type 을 비운 채 들어올 수 있어 type 축 밖이다 — type 이 비었다고 미분류 지식으로 세지 않는다.");
  L.push("- **`confidence` 는 칸이 둘이고 뜻이 다르다**(컬럼명은 `confidence` 유지): 지식의 `confidence` = 마지막으로 저장한 채널(`human` 사람 웹 · `ai` 에이전트 MCP · `observed` 외부 미러 · `rule` 시스템 결정론 파생)이고 서버가 채운다(되돌리기와 이미 반영된 수정 제안의 반려는 이전 값을, 가져오기로 새로 들이는 지식은 꾸러미에 실린 원본의 값을 유지하고, 수정 제안 승인은 제안자의 채널을 따른다). 지식↔카테고리 연결의 `confidence` = 분류 신뢰도(0~1). 어느 쪽도 가치·주입을 결정하지 않는다.");
  L.push("- **S(구조)·G(용어집/그래프) 는 ku 종류가 아니다** — 모양이 글이 아니라 노드+엣지라 domainmap 파생 그래프(**federated 뷰**)로 다룬다. 도메인 부채도 ku 아님(domainmap `debt_finding`).");
  L.push("- 옛 kind 코드 D·F·A·M·S·G·L·Z 는 시드에서 지워졌다(부팅마다 DELETE). D/F/A/M/L/Z 는 지식(type 으로 분류)으로, S/G 는 domainmap 파생(federated)으로 본다.");
  L.push("");

  // ── 1. 저장 자리(kind) 정의 ──
  L.push("## 1. 저장 자리(kind) — 정의·분류기준·저장·전달 (R·K·H·W)");
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
  L.push("## 2. 빠른 참조표 (저장 자리)");
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
  L.push("외부 시스템에서 무엇이 어떻게 수집되어 어느 자리(kind)로 적재되는지. status=dropped 는 현재 수집 중단(커넥터 코드는 유지).");
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
  L.push("- **지식으로 저장할 것이면 kind 가 아니라 type 을 고른다** — 위 §0 의 type 중 하나. 재현 가능한 단계별 절차는 `how-to`, 그 밖에는 내용에 맞는 type.");
  L.push("  - 세션마다 강제할 규범·페르소나(R)는 지식이 아니라 세션 주입 섹션 문서다(`knowledge_save` 로 만들지 않는다).");
  L.push("  - 상태·담당을 가진 일(W)은 지식이 아니라 프로젝트·태스크다(`project_*_v6`·`task_*_v6`).");
  L.push("- **주제는 type 과 별개 축**: 어느 분류축에 속하면 그 축의 key 를 단다(카테고리 1개). 교차 주제는 카테고리를 늘리지 않고 `knowledge_link` 로 잇는다.");
  L.push("- **provenance 와 지식의 `confidence` 는 기계가 채널로 박는 사실**이라 LLM 이 *판단*하지 않는다. 카테고리 연결의 `confidence`(0~1)는 분류를 제안하는 쪽이 매기는 분류 신뢰도다.");
  L.push("- **D·F·A·M·S·G·L·Z 를 kind 로 부여하지 않는다.** 도메인 부채는 ku 가 아니라 domainmap `debt_finding`.");
  L.push("- type 은 칸이 하나다. 한 기록이 둘 이상 성격에 걸치면 주된 성격 하나를 고른다.");
  L.push("");

  return L.join("\n") + "\n";
}

try {
  const gt = await learnGroundTruth();
  if (!gt.kinds.length) {
    console.error("FATAL: kind_registry 가 비어 있음 — 게이트웨이를 한 번 부팅(initOrgSchema)해 시드하세요.");
    process.exit(2);
  }
  const out = render(gt, knowledgeTypeDecl());

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
