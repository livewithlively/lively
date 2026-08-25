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
  // ── web (2026-08-02 실측 40건 — #1404 착지로 54 → 40, **-14건 / -25.9%**. 그 전이 R36 의 117 → 60,
  //  #1405 의 500줄 2차 분할이 60 → 54) ──
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
  //  ⭐ #1404 착지(back-edge 5갈래 하강) — sidebar·filters·detail-meta·detail-body·taskmodal/fields 가 배럴을
  //   되짚을 이유를 없앴다(54 → 40).
  //   ⭐ 이 라운드가 R36 의 판정에 **한 줄을 더했다**: '읽는 쪽이 하나뿐인가' 는 하강의 **충분조건일 뿐**이고,
  //   진짜 기준은 **"그 심볼의 집이 되짚지 않는 리프인가"** 다. 읽는 쪽이 셋·넷이어도 소비자가 이미 그 리프를
  //   물고 있으면 간선이 하나도 안 늘어난다. 반대로 읽는 쪽이 하나여도 그 집이 되짚는 서브트리면 직결이
  //   순환을 새로 만든다 — selection 의 copyText·openLocalWorkModal 이 배럴에 남은 이유가 그것이다.
  //    · pjvFolderDrag·pjvSideDrag — 읽는 쪽 넷(board·sidebar·rows·selection)이지만 값이 보기 상태 싱글턴이라
  //      projects/state.ts 리프가 원래 집. 넷 다 이미 state.js 를 직결해 **새 간선 0**.
  //    · pjvSavedViewMenu(+전용 헬퍼 pjvMapClickUpSortField) — 읽는 곳은 filters 의 설정 팝오버뿐 → filters.ts.
  //    · pjvSwitchRow — 도메인을 모르는 표시 프리미티브(게터/세터만 받는다) → popover.ts 리프.
  //    · pjvSaveProjMembers — 읽는 쪽 셋인데 소유 모듈 board 가 **호출조차 안 했다**(정의·재수출만). 본문이
  //      api+toast 뿐이라 인라인 편집 저장 경로가 사는 task-controls.ts 로. → **'소유 모듈이 안 쓰는 심볼'은
  //      하강 후보의 강한 신호다.**
  //    · PJV_TAG_NONE(색 상수)·pjvtmComposerToolbar — selection·detail-meta·detail-body 가 taskmodal/
  //      {tags,composer}.js 를 **실체 직결**. 금지된 건 배럴 '../taskmodal.js' 직결(그건 projects↔taskmodal 에
  //      가지를 늘린다)이지 실체 모듈 직결이 아니다. 둘 다 projects 를 되짚지 않는 리프라 순환 0 —
  //      R56 이 반대 방향(tags→projects/popover)에 쓴 수와 같다.
  //    · pjvTaskModalStatusField — 읽는 쪽이 taskmodal/fields.ts 하나뿐이고 board 는 호출조차 안 했다. 그
  //      소비자로 내리자 **taskmodal/fields 가 배럴을 놓았다**(taskmodal→projects 되짚기 하나 소멸).
  //      ⚠ 이때 R56 이 배럴 경유를 택했던 근거("projects/fields→projects 역방향 엣지 pjvHeadSortable")가
  //       R36 의 하강으로 이미 **소멸해 있었다** — 옛 실측 근거는 반드시 지금 그래프로 재확인할 것.
  //  ⚠ 배럴 재수출의 함정 — 심볼을 내린 뒤 공개 표면을 지키려 재수출하면 배럴이 그 새 모듈을 물어야 하고,
  //   그 간선이 순환을 늘릴 수 있다. pjvSavedViewMenu 는 그래서 배럴 재수출에서 **뺐다**(projects→filters
  //   간선이 projects→filters→timeline→projects 를 새로 깐다. 외부 소비자 0 이라 표면 손실 없음).
  //   나머지는 배럴이 착지 모듈을 이미 물고 있어 재수출 자리만 옮겼다(표면 불변·간선 비용 0).
  //  남은 back-edge 4갈래(= 아래 40건 전부의 뿌리)와 각 갈래가 **왜 지금 방식으론 안 끊기는지**:
  //   · timeline    → projects : pjvOpenTaskModal                        ← 중계뿐.
  //   · detail-tasks→ projects : pjvOpenTaskModal(중계) · PJV_SUBTASK_BTNLABEL · pjvSubtaskMenu
  //        뒤 둘은 board 소유인데 board 가 detail-tasks 를 물지 않아 소비자 하강이 안 된다(리프로는 가능하나
  //        중계가 남아 실익 0 — 순환은 갈래가 **완전히** 끊길 때만 줄어든다).
  //   · rows        → projects : pjvOpenTaskModal(중계) · pjvSetProjStatusCustom(읽는 쪽 rows 뿐 → 하강
  //        가능하나 중계가 남아 실익 0) · openProjectSessionForm·pjvAddTask·pjvRowMore(상세 계열 소유)
  //   · selection   → projects : copyText·openLocalWorkModal (둘 다 상세 계열 소유)
  //        상세 서브트리는 detail.ts 로만 통하는 단일 입구고 detail 은 selection 을 문다 — 직결하면
  //        selection→detail-*→detail→selection 이 새로 생긴다. 배럴 경유가 정답인 자리다.
  //   + taskmodal/shell → projects(위 ① 1건) : 셸이 pjvTaskRow·renderProjectV2Detail·mountBodyEditor 를 받는다.
  //  ⚠⚠ #1404 가 **중계 걷어내기를 시도해 확인한 한계** — 남은 40건의 진짜 뿌리는 중계가 아니라 **두 쌍의
  //   구조적 상호 의존**이고, 심볼 하강으로는 풀 수 없다:
  //    ① taskmodal/shell ↔ projects/detail-tasks — 셸이 태스크 행(pjvTaskRow)을 그리고, 그 행이 다시 모달을
  //      연다(pjvOpenTaskModal). 진짜 양방향이라 어느 쪽을 내려도 반대쪽 간선이 남는다. pjvOpenTaskModal 은
  //      셸의 클로저(dirty·closeModal·pasteCtx·bodyEditor)를 쥐고 있어 리프로 분리조차 안 된다. 게다가
  //      pjvTaskRow 는 몽키패치 IIFE 대상이라 배럴의 `export … from` 체인이 **깨지면 안 된다**
  //      (scripts/pjv-taskrow-monkeypatch.test.mjs 가드).
  //    ② 상세 계열 ↔ rows/selection — 상세가 행·선택을 쓰고, 행·선택이 상세의 모달·폼을 연다. 이것도
  //      양방향이라 직결하면 경로가 곱해진다(위 ⚠ 834건 폭증의 그 구조).
  //   배럴은 이 얽힘을 **노드 하나로 흡수**해 경로 폭발을 막는 장치다 — 지금 40건은 그 대가이고, 그래서
  //   여기서 더 내리는 건 심볼 이동이 아니라 **상호 의존 자체를 끊는 재설계**(모달↔행 사이에 이벤트/등록
  //   레이어를 두는 등) 소관이다. 그건 런타임 동작을 바꾸므로 별도 항목으로 다룬다.
  //   (런타임 지연조회 `(PJ as any)` 는 답이 아니다 — R56 이 그 해킹을 정적 import 로 **환원**했다. 게이트에서
  //    순환을 숨길 뿐 모듈 의존은 그대로고 타입 안전성만 잃는다.)
  // ── ① 기저 2갈래 — dashboard(활동 피드 행)·taskmodal(모달 표면). R49 개명·taskmodal 후속 소관.
  "web/activity-view.ts -> web/projects.ts -> web/projects/detail.ts -> web/projects/detail-sections.ts",
  "web/projects.ts -> web/taskmodal.ts -> web/taskmodal/shell.ts",
  // ── ② projects/{columns,fields} 내부 결합 — 그리드 트랙이 필드 타입 폭(PJV_FIELD_BY_KEY)을, 필드 컬럼 헤더가
  //  폭 핸들·숨김 토글을 서로 필요로 하는 **양방향 도메인 결합**. 타입 정의를 리프로 더 내려야 끊긴다.
  "web/projects.ts -> web/projects/project-form.ts -> web/projects/rows.ts",
  "web/projects.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/filters.ts -> web/projects/timeline.ts",
  "web/projects.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/project-form.ts -> web/projects/selection.ts",
  "web/projects/columns.ts -> web/projects/fields.ts",
  // ── ③ R35 분해 ⑥(상세 계열)의 잔여 — 상세 4모듈이 rows/selection/project-form 을 거쳐 배럴로 되돌아온다.
  //  detail.ts 는 상세 서브트리의 단일 입구라 detail-{meta,sections}→detail 은 그 안의 정상 왕복이다.
  //  (#1405 착지: detail-body → project-form 5건 소멸 — '지식 흐름' 섹션이 쓰던 openKnowledgePicker 를
  //   projects/knowledge-picker.ts 잎으로 내렸다. project-form 안에서는 아무도 그걸 쓰지 않았고
  //   읽는 쪽이 detail-knowledge 하나뿐이라 §1 판정 기준에 그대로 맞았다.)
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-meta.ts -> web/projects/project-form.ts -> web/projects/rows.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-meta.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/filters.ts -> web/projects/timeline.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-meta.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-meta.ts -> web/projects/project-form.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-meta.ts -> web/projects/rows.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-meta.ts -> web/projects/rows.ts -> web/projects/filters.ts -> web/projects/timeline.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-meta.ts -> web/projects/rows.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-sections.ts -> web/projects/project-form.ts -> web/projects/rows.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-sections.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/filters.ts -> web/projects/timeline.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-sections.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-sections.ts -> web/projects/project-form.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-tasks.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-tasks.ts -> web/projects/rows.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-tasks.ts -> web/projects/rows.ts -> web/projects/filters.ts -> web/projects/timeline.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-tasks.ts -> web/projects/rows.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/detail-tasks.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/detail.ts -> web/projects/selection.ts",
  "web/projects/detail-meta.ts -> web/projects/detail.ts",
  //  (#1405 착지: detail-sections → detail 소멸 — 터미널 섹션이 쓰던 openProjectPreviewModal 을
  //   projects/detail-preview.ts 잎으로 내려 상세 입구를 되짚지 않게 했다.)
  // ── ④ R36 분해 ⑦(보드 조립)의 대가 — 배럴이 projects/board.ts 를 물면서 생긴 병렬 경로. board.ts 는
  //  projects.ts 를 되짚지 않는다(단방향) — 위 back-edge 가 걷히면 아래 20건도 함께 사라진다.
  "web/projects.ts -> web/projects/board.ts -> web/projects/filters.ts -> web/projects/timeline.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/project-form.ts -> web/projects/rows.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/filters.ts -> web/projects/timeline.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/project-form.ts -> web/projects/rows.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/project-form.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/rows.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/rows.ts -> web/projects/filters.ts -> web/projects/timeline.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/rows.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/selection.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/sidebar.ts -> web/projects/filters.ts -> web/projects/timeline.ts",
  "web/projects.ts -> web/projects/board.ts -> web/projects/sidebar.ts -> web/projects/rows.ts",
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
// 룰·allowlist는 OS 무관 POSIX 경로다. Windows path.relative() 결과(\\)를 그대로 쓰면
// 기존 허용 순환 전부를 신규 위반으로 오판하고 금지 엣지 정규식도 매칭되지 않는다.
const rel = (f) => path.relative(REPO, f).split(path.sep).join("/");

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
