#!/usr/bin/env node
// import 경계 상주 게이트(#1313 R55) — phase 2 재편이 세운 의존 경계를 CI 에서 지킨다.
//  대상: src/·web/ 의 **런타임** 정적 ESM import 그래프(동적 import()·`import type` 제외 — 지연/소거).
//  *.test.ts 는 룰 검사에서 제외(테스트는 검증 대상을 자유로이 import).
//
//  게이트 3종:
//   ① 순환 0 — ALLOWED_CYCLES(알려진 잔존, 소관 항목 명시)에 없는 새 elementary cycle 발견 시 실패.
//   ② 금지 엣지 — FORBIDDEN 선언(from→to 프리픽스 + 예외 목록) 위반 시 실패.
//   ③ 파일 크기 — 500줄 초과 파일이 KNOWN_BIG(로드맵 해체 대상) 밖에서 새로 생기면 **경고**(실패 아님).
//
//  실행: node scripts/check-imports.mjs  (러너 편입: scripts/check-imports.test.mjs 래퍼 — CI 자동 게이트)
//  룰 추가 관례: 경계를 세우는 리팩토링 항목이 착지할 때 그 acceptance grep 을 여기 룰로 흡수한다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["src", "web"];

// ── 알려진 잔존 순환(런타임) — 소관 리팩토링 항목이 제거하면 여기서도 지운다(스테일이면 경고). ──
const ALLOWED_CYCLES = new Set([
  // ── src (2026-08-01 실측 1건) ──
  // domainmap 엔진 내부 상호참조 — R23 소관
  "src/domainmap/core/changelog.ts -> src/domainmap/core/repos.ts",
  //  (R25 착지: capabilities 조립자 역-import 허브 4건 소멸 — index↔lists-v6·trash·projects-v6·tools/db.
  //   3줄 신원 판정 viewerOf/isAdmin 을 capabilities/principal.ts[import 0 leaf]로 분리해 소비자를 직결시켰다.)
  // ── web (2026-08-01 실측 60건 — R36 착지로 117 → 60, **-57건 / -48.7%**) ──
  //  (R40 착지: admin↔learn 계열 4건 소멸 — admin.ts 가 재수출 배럴이 되고 learn 이 copyButton·deployCommands·
  //   installCmd·loadAdmin 을 실체 모듈(ui-primitives·admin-install·admin-rerender)에서 직접 받으면서
  //   learn -> admin -> review/visibility-axes -> learn 되돌이가 끊겼다.)
  //  (R29b 착지: core↔lib/markdown 소멸 — core.ts 를 '게이트 + 배럴'로 축소하며 markdown 이 쓰던 프리미티브가
  //   lib/(net·dom·format·uitext)로 마저 내려왔다. 이제 markdown 은 core 를 거치지 않고 lib 안에서 끝난다.)
  //  ⭐ R36 착지(보드 조립 이동·배럴 확정) — projects.ts 가 **소유 심볼 0개**인 재수출 배럴이 되면서 R32 분해 ③의
  //   8건과 R33/R34 재배선 파생분이 통째로 소멸했다. 결정적이었던 건 파일 이동 자체가 아니라 **읽는 쪽이 하나뿐이던**
  //   두 심볼을 그 소비자에게 내려보낸 것이다:
  //    · pjvBoardFieldsCur(+setBoardFieldsCur) — 읽는 곳은 projects/columns.ts 뿐. 보드는 세터로만 값을 세운다.
  //    · 컬럼 정렬 저장·헤더 바인딩(PJV_CU_SORT_MAP·pjvColSortStoreKey·pjvGetColSort·pjvSetColSort·pjvHeadSortable)
  //      — 읽는 곳은 columns/fields 뿐이라 projects/rows.ts 에서 projects/columns.ts 로 내렸다(비교자는 rows 잔류).
  //   이 둘로 columns→projects · fields→projects 두 back-edge 가 통째로 사라졌다(실측 117 → 64 → 최종 60).
  //  ⚠ 반대 방향(남은 back-edge 를 실체 모듈 직결로 바꾸기)은 **하면 안 된다** — 실측 834건으로 폭증한다.
  //   배럴 경유는 되짚는 모듈이 하나의 노드(projects.ts)만 보게 하지만, 직결은 되짚는 모듈마다 실체 모듈로 가는
  //   간선을 새로 깔아 경로 수가 곱해진다. R35 의 '문 하나로만 통한다'(detail.ts 단일 입구)와 같은 원리다.
  //  남은 back-edge 6갈래(= 아래 60건 전부의 뿌리)와 각각을 끊었을 때의 실측 잔여치:
  //   · filters   → projects : pjvSavedViewMenu · pjvSwitchRow            (끊으면 49건)
  //   · timeline  → projects : pjvOpenTaskModal(taskmodal 중계)           (끊으면 48건)
  //   · sidebar   → projects : pjvSideDrag · pjvFolderDrag                (끊으면 59건)
  //   · rows      → projects : openProjectSessionForm·pjvAddTask·pjvRowMore·pjvFolderDrag·pjvSaveProjMembers·
  //                            pjvSetProjStatusCustom·pjvOpenTaskModal
  //   · selection → projects : PJV_TAG_NONE·copyText·openLocalWorkModal·pjvFolderDrag·pjvSaveProjMembers
  //   · detail-{meta,tasks,body} → projects : PJV_TAG_NONE·pjvSaveProjMembers·PJV_SUBTASK_BTNLABEL·
  //                            pjvSubtaskMenu·pjvOpenTaskModal·pjvtmComposerToolbar
  //   후속 소관: taskmodal 중계 3종(PJV_TAG_NONE·pjvOpenTaskModal·pjvtmComposerToolbar)은 projects↔taskmodal
  //   순환을 늘리지 않으려 일부러 배럴을 거친다 — 이건 유지한다. 나머지는 '읽는 쪽이 하나뿐인가'로 판정해
  //   위와 같은 방식(소비자에게 내려보내기)으로만 끊는다.
  // ── ① 기저 2갈래 — dashboard(활동 피드 행)·taskmodal(모달 표면). R49 개명·taskmodal 후속 소관.
  "web/activity-view.ts -> web/projects.ts -> web/projects/detail.ts -> web/projects/detail-sections.ts",
  "web/projects.ts -> web/taskmodal.ts -> web/taskmodal/shell.ts",
  "web/projects.ts -> web/taskmodal.ts -> web/taskmodal/shell.ts -> web/taskmodal/fields.ts",
  // ── ② projects/{columns,fields} 내부 결합 — 그리드 트랙이 필드 타입 폭(PJV_FIELD_BY_KEY)을, 필드 컬럼 헤더가
  //  폭 핸들·숨김 토글을 서로 필요로 하는 **양방향 도메인 결합**. 타입 정의를 리프로 더 내려야 끊긴다.
  "web/projects.ts -> web/projects/project-form.ts -> web/projects/rows.ts",
  "web/projects.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/filters.ts",
  "web/projects.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/filters.ts -> web/projects/timeline.ts",
  "web/projects.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/project-form.ts -> web/projects/selection.ts",
  "web/projects/columns.ts -> web/projects/fields.ts",
  // ── ③ R35 분해 ⑥(상세 계열)의 잔여 — 상세 4모듈이 rows/selection/project-form 을 거쳐 배럴로 되돌아온다.
  //  detail.ts 는 상세 서브트리의 단일 입구라 detail-{meta,sections}→detail 은 그 안의 정상 왕복이다.
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-body.ts",
  //  (#1405 착지: detail-body → project-form 5건 소멸 — '지식 흐름' 섹션이 쓰던 openKnowledgePicker 를
  //   projects/knowledge-picker.ts 잎으로 내렸다. project-form 안에서는 아무도 그걸 쓰지 않았고
  //   읽는 쪽이 detail-knowledge 하나뿐이라 §1 판정 기준에 그대로 맞았다.)
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-meta.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-meta.ts -> web/projects/project-form.ts -> web/projects/rows.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-meta.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/filters.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-meta.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/filters.ts -> web/projects/timeline.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-meta.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-meta.ts -> web/projects/project-form.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-meta.ts -> web/projects/rows.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-meta.ts -> web/projects/rows.ts -> web/projects/filters.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-meta.ts -> web/projects/rows.ts -> web/projects/filters.ts -> web/projects/timeline.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-meta.ts -> web/projects/rows.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-sections.ts -> web/projects/project-form.ts -> web/projects/rows.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-sections.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/filters.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-sections.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/filters.ts -> web/projects/timeline.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-sections.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-sections.ts -> web/projects/project-form.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-tasks.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-tasks.ts -> web/projects/rows.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-tasks.ts -> web/projects/rows.ts -> web/projects/filters.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-tasks.ts -> web/projects/rows.ts -> web/projects/filters.ts -> web/projects/timeline.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-tasks.ts -> web/projects/rows.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-tasks.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/selection.ts",
  "web/projects/detail-meta.ts -> web/projects/detail.ts",
  //  (#1405 착지: detail-sections → detail 소멸 — 터미널 섹션이 쓰던 openProjectPreviewModal 을
  //   projects/detail-preview.ts 잎으로 내려 상세 입구를 되짚지 않게 했다.)
  // ── ④ R36 분해 ⑦(보드 조립)의 대가 — 배럴이 projects/board.ts 를 물면서 생긴 병렬 경로. board.ts 는
  //  projects.ts 를 되짚지 않는다(단방향) — 위 back-edge 가 걷히면 아래 20건도 함께 사라진다.
  "web/projects.ts -> web/projects/board.ts -> web/projects/filters.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/filters.ts -> web/projects/timeline.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/project-form.ts -> web/projects/rows.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/filters.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/filters.ts -> web/projects/timeline.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/project-form.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/rows.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/rows.ts -> web/projects/filters.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/rows.ts -> web/projects/filters.ts -> web/projects/timeline.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/rows.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/sidebar.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/sidebar.ts -> web/projects/filters.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/sidebar.ts -> web/projects/filters.ts -> web/projects/timeline.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/sidebar.ts -> web/projects/rows.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/sidebar.ts -> web/projects/rows.ts -> web/projects/filters.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/sidebar.ts -> web/projects/rows.ts -> web/projects/filters.ts -> web/projects/timeline.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/sidebar.ts -> web/projects/rows.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/timeline.ts",
]);

// ── 금지 엣지: [룰 이름, from 프리픽스 정규식, to 프리픽스 정규식, 예외(from→to 정확 쌍)] ──
const FORBIDDEN = [
  {
    name: "스토어 계층(org/·v6/)의 MCP 표면(capabilities/) 상향 import 금지 (R9)",
    from: /^src\/(org|v6)\//, to: /^src\/capabilities\//,
    except: new Set(), // R25 에서 mcp-surface 를 src/mcp/ 로 이관 — 유일한 예외였던 asset-id→mcp-surface 소멸(예외 0)
  },
  {
    name: "비-domainmap 의 domainmap/db 경유 금지 — DB 헬퍼는 db/client (R10)",
    from: /^src\/(?!domainmap\/)/, to: /^src\/domainmap\/db\.ts$/, except: new Set(),
  },
  {
    name: "스토어 계층(org/·v6/)의 express 층(http/) import 금지 — HttpError 는 leaf(http-error) (R9)",
    from: /^src\/(org|v6)\//, to: /^src\/http\//, except: new Set(),
  },
  {
    name: "v6 스키마 init 의 org/store import 금지 — embedding config 는 직접 SELECT+resolveEmbeddingConfig (R19c)",
    from: /^src\/v6\/schema(\.ts$|\/)/, to: /^src\/org\/store(\.ts$|\/)/, except: new Set(),
  },
  {
    // R48 — db_query 스택은 아무 고객 DB에나 붙는 **범용 게이트**다. SQL 방화벽·테이블 정책·컬럼 마스킹·
    //  소스 레지스트리가 "여기가 우리 items DB 인지"를 알기 시작하면 방화벽이 온톨로지(공개범위 모델)에
    //  결합된다. self 소스만 v6 를 알아야 하고, 그 앎은 src/db/self/ 안에 가둔다(계약: src/db/self/index.ts).
    name: "범용 db 스택(firewall·policy·mask·sources)의 v6 import 금지 — 온톨로지는 db/self/ 만 안다 (R48)",
    from: /^src\/db\/(?!self\/)/, to: /^src\/v6\//, except: new Set(),
  },
  {
    name: "web 공용층(lib/)의 페이지 역방향 import 금지 (R28/R29)",
    from: /^web\/lib\//, to: /^web\/(?!lib\/)[^/]+\.ts$/,
    except: new Set(), // R29b: markdown→core 직결 정리 완료 — lib/ 는 페이지를 전혀 모른다(예외 0)
  },
];

// db/client 는 pg 외 우리 모듈 import 0 (R10 leaf 계약)
const LEAF_FILES = ["src/db/client.ts", "src/http-error.ts"];

// 500줄 초과 알려진 대형 파일(로드맵 해체 대상 — 줄어드는 방향만 허용, 새 진입은 경고)
const KNOWN_BIG_RE = /^(web\/(projects|admin|dashboard-home|terminal|core|learn|wiki-data|wiki-doc|review|wiki-category|graph)\.ts|src\/(capabilities\/(delivery|knowledge|projects-v6|categories|context|preview-env|source|task-detail-v6|managed-session|delegate|db-grant)\.ts|org\/(store|distill\/distiller|auth\/device-auth|credentials\/secret-box|channels\/slack-channels|delivery\/(publish|onboarding|default-content|seed-content|mcp-client-bundle|local-mcp-import))\.ts|v6\/(connector-mirror|knowledge-store|project-store|session-log-store|view-store|source-store|task-detail-store)\.ts|connectors\/(notion|clickup|run-sync|gdrive|slack|domain-wiki)\.ts|domainmap\/(core\/(reconcile|refresh|queries|domains|repos)|webhook|cli)\.ts|node\/(agent|registry|routes|tasks|provision-remote|task-scheduler)\.ts|db\/firewall\.ts|ops\/box-watch\.ts|connectors\/notion-md\.ts|terminal\/(terminal-sessions|routes|terminal-transcript|terminal-files|upload-file)\.ts|sessions\/(session-log-routes|session-state|managed-sessions)\.ts|preview\/(preview-envs|routes)\.ts|project\/project-provision\.ts|scheduler\/index\.ts|(web|index|server|audit-export-routes|mcp-sessions)\.ts))$/;

// ── 그래프 구축 ──
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const files = ROOTS.flatMap((r) => walk(path.join(REPO, r)));
const fileSet = new Set(files);
const rel = (f) => path.relative(REPO, f);

function staticSpecs(src) {
  const specs = [];
  const re = /(?:^|\n)\s*((?:import|export)\s[^;]*?)from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[3] != null) { specs.push(m[3]); continue; }
    if (/^(?:import|export)\s+type\s/.test(m[1].trim())) continue; // 타입 전용 = 컴파일 소거
    specs.push(m[2]);
  }
  return specs;
}
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base.replace(/\.js$/, ".ts"), base + ".ts", path.join(base.replace(/\.js$/, ""), "index.ts"), path.join(base, "index.ts")])
    if (fileSet.has(c)) return c;
  return null;
}
const graph = new Map();
for (const f of files) {
  const targets = new Set();
  for (const s of staticSpecs(fs.readFileSync(f, "utf8"))) {
    const t = resolveSpec(f, s);
    if (t && t !== f) targets.add(t);
  }
  graph.set(f, targets);
}

const problems = [];
const warnings = [];

// ── ① 순환(Tarjan SCC + Johnson) ──
{
  let idx = 0;
  const index = new Map(), low = new Map(), onStack = new Map(), stack = [], sccs = [];
  function strongconnect(v) {
    index.set(v, idx); low.set(v, idx); idx++;
    stack.push(v); onStack.set(v, true);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.get(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = []; let w;
      do { w = stack.pop(); onStack.set(w, false); comp.push(w); } while (w !== v);
      sccs.push(comp);
    }
  }
  for (const f of files) if (!index.has(f)) strongconnect(f);

  const cycles = [];
  for (const comp of sccs) {
    if (comp.length < 2) { if ((graph.get(comp[0]) ?? new Set()).has(comp[0])) cycles.push([comp[0]]); continue; }
    const nodes = comp.slice().sort();
    const blocked = new Map(), B = new Map(), st = [];
    function unblock(u) { blocked.set(u, false); for (const w of B.get(u) ?? []) if (blocked.get(w)) unblock(w); B.set(u, new Set()); }
    function circuit(v, s, allowed) {
      let found = false;
      st.push(v); blocked.set(v, true);
      for (const w of graph.get(v) ?? []) {
        if (!allowed.has(w)) continue;
        if (w === s) { cycles.push(st.slice()); found = true; }
        else if (!blocked.get(w)) { if (circuit(w, s, allowed)) found = true; }
      }
      if (found) unblock(v);
      else for (const w of graph.get(v) ?? []) { if (!allowed.has(w)) continue; if (!B.has(w)) B.set(w, new Set()); B.get(w).add(v); }
      st.pop();
      return found;
    }
    for (let i = 0; i < nodes.length; i++) {
      const s = nodes[i];
      const allowed = new Set(nodes.slice(i));
      for (const n of allowed) { blocked.set(n, false); B.set(n, new Set()); }
      circuit(s, s, allowed);
    }
  }
  // 정규화: 최소 노드로 회전한 시그니처
  const sig = (c) => {
    const r = c.map(rel);
    let k = 0;
    for (let i = 1; i < r.length; i++) if (r[i] < r[k]) k = i;
    return r.slice(k).concat(r.slice(0, k)).join(" -> ");
  };
  const found = new Set(cycles.map(sig));
  for (const s of found) if (!ALLOWED_CYCLES.has(s)) problems.push(`새 import 순환: ${s}`);
  for (const s of ALLOWED_CYCLES) if (!found.has(s)) warnings.push(`ALLOWED_CYCLES 스테일(해소됨 — 목록에서 제거하라): ${s}`);
}

// ── ② 금지 엣지 ──
for (const [f, targets] of graph) {
  const from = rel(f);
  if (/\.test\.ts$/.test(from)) continue;
  for (const t of targets) {
    const to = rel(t);
    const edge = `${from} -> ${to}`;
    for (const rule of FORBIDDEN) {
      if (rule.from.test(from) && rule.to.test(to) && !rule.except.has(edge)) problems.push(`금지 엣지 [${rule.name}]: ${edge}`);
    }
  }
}
for (const leaf of LEAF_FILES) {
  const abs = path.join(REPO, leaf);
  if (!fileSet.has(abs)) { warnings.push(`leaf 파일 부재: ${leaf}`); continue; }
  const ours = [...(graph.get(abs) ?? [])];
  if (ours.length) problems.push(`leaf 위반 [${leaf}]: 우리 모듈 import ${ours.map(rel).join(", ")}`);
}

// ── ③ 파일 크기(경고 전용) ──
for (const f of files) {
  const r = rel(f);
  if (/\.test\.ts$/.test(r)) continue;
  const lines = fs.readFileSync(f, "utf8").split("\n").length;
  if (lines > 500 && !KNOWN_BIG_RE.test(r)) warnings.push(`500줄 초과 신규 대형 파일(분할 검토): ${r} (${lines}줄)`);
}

for (const w of warnings) console.warn(`⚠ ${w}`);
if (problems.length) {
  console.error(`✗ import 경계 위반 ${problems.length}건:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`✓ import 경계 게이트 — ${files.length}파일, 순환 allowlist ${ALLOWED_CYCLES.size}건 외 신규 0, 금지 엣지 0 (경고 ${warnings.length})`);
