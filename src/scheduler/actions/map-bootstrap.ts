// 크론 액션: 미매핑 코드 분류(map_unmapped·map_unmapped_headless)·레포 is 최초 부트스트랩(bootstrap_is) — R16 원문 이동.
import { resolveSessionTmux, injectToSession, headlessRequester, HEADLESS_REQUESTER_MISSING, headlessFlags, enqueueHeadlessTask } from "./_headless.js";

// LLM 판단주체 — 상시 LLM 세션(라이블리 시드, **팀플랜 과금 내**)에 분류 태스크를 주입한다.
//  ⚠ 원 결정("headless `claude -p`+토큰 = API 별도 과금이라 폐기")은 스테일 — F5 실측(2026-07-15)에서 headless claude -p 는
//   공유 ~/.claude OAuth(구독 크레딧)로 실행됨을 확인(ANTHROPIC_API_KEY 부재, 별도 API 과금 아님). 헤드리스 일반 액션은 agent_headless(#1058).
//   이 액션(map_unmapped)은 기존 상시세션 주입을 유지한다(도그푸드 경로) — 헤드리스 전환은 별도 판단(관성 이점/해악은 작업 성격에 따라).
//  메커니즘: tmux send-keys 로 타깃 세션 PTY 에 프롬프트+Enter → 세션의 claude 가 lively MCP(list_unmapped/category_get/map_code_unit)로 비동기 수행. 인박스 비면 주입 안 함.
//  세션 미설정/부재는 error(가시). fire-and-forget: 주입까지가 잡 책임(매핑은 세션이 수 분에 걸쳐) — 다음 주기에 인박스 0이면 skip.
export async function runMapInject(params: Record<string, unknown>): Promise<{ status: string; summary: unknown }> {
  const repo = String(params.repo ?? "context-ontology");
  const sessionRef = params.session ? String(params.session) : "";
  if (!sessionRef) return { status: "error", summary: { error: "타깃 상시 세션 미설정 — 관리탭 스케줄러에서 상시 세션을 선택하세요." } };
  const { listUnmappedCodeUnits } = await import("../../domainmap/core/mappings.js");
  let inbox: Array<{ path: string }>;
  try { inbox = await listUnmappedCodeUnits(repo); }
  catch (e) { return { status: "error", summary: { error: (e as Error)?.message ?? String(e) } }; }
  if (!inbox.length) return { status: "ok", summary: { skipped: "인박스 비어있음", unmapped: 0, session: sessionRef } };

  let tmuxSession: string;
  try { tmuxSession = await resolveSessionTmux(sessionRef); }
  catch (e) { return { status: "error", summary: { error: (e as Error)?.message ?? String(e), session: sessionRef } }; }

  const prompt = (typeof params.prompt === "string" && params.prompt.trim()) ? params.prompt.trim() : buildMapPrompt(repo, inbox.length);
  try { await injectToSession(tmuxSession, prompt); }
  catch (e) { return { status: "error", summary: { error: "세션 주입 실패(" + tmuxSession + "): " + ((e as Error)?.message ?? String(e)), session: sessionRef, tmux: tmuxSession } }; }
  return { status: "ok", summary: { injected: true, managed_session: sessionRef, tmux: tmuxSession, unmapped: inbox.length } };
}

// #1061 map_unmapped 의 헤드리스판 — 인박스(미매핑 코드유닛) 있을 때만 헤드리스 claude -p 로 분류. buildMapPrompt(세션판과 동일) 재사용.
//  repo 를 위탁에 넘겨 공유 base clone→worktree 를 작업 cwd 로 자동 준비 → 헤드리스 세션이 코드를 Read/Grep 할 수 있다(세션판보다 오히려 코드 접근이 확실).
export async function runMapHeadless(params: Record<string, unknown>, jobId: string, createdBy: string | null): Promise<{ status: string; summary: unknown }> {
  const repo = String(params.repo ?? "context-ontology");
  const requester = headlessRequester(params, createdBy);
  if (!requester) return HEADLESS_REQUESTER_MISSING;
  const { listUnmappedCodeUnits } = await import("../../domainmap/core/mappings.js");
  let inbox: Array<{ path: string }>;
  try { inbox = await listUnmappedCodeUnits(repo); }
  catch (e) { return { status: "error", summary: { error: (e as Error)?.message ?? String(e), repo } }; }
  if (!inbox.length) return { status: "ok", summary: { skipped: "인박스 비어있음", unmapped: 0, repo } };
  const prompt = (typeof params.prompt === "string" && params.prompt.trim()) ? params.prompt.trim() : buildMapPrompt(repo, inbox.length);
  return enqueueHeadlessTask({ prompt, requester, jobId, repo, flags: headlessFlags(params), extra: { unmapped: inbox.length, repo } });
}

// 최초 is 부트스트랩 주입 — 결정론 사실(collectFacts=dm scan)을 파일로 떨구고, runbook-bootstrap-domains 를 따라
//  유닛경계+매핑을 '판단'해 domainmap_ingest 로 쓰도록 상시세션에 주입. map_unmapped 와 동형(canned 프롬프트 + 공용 inject).
//  결정론(사실)/판단(유닛·매핑) 분리 — 엔진(ingest)·런북·주입 헬퍼 전부 재사용(중복 로직 없음). 클론 없으면 error.
export async function runBootstrapInject(params: Record<string, unknown>): Promise<{ status: string; summary: unknown }> {
  const repo = String(params.repo ?? "").trim();
  const sessionRef = params.session ? String(params.session) : "";
  if (!repo) return { status: "error", summary: { error: "params.repo 미설정 — 부트스트랩할 레포를 선택하세요." } };
  if (!sessionRef) return { status: "error", summary: { error: "타깃 상시 세션 미설정 — 관리탭 스케줄러에서 상시 세션을 선택하세요." } };

  const { existsSync } = await import("node:fs");
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { repoClonePath } = await import("../../domainmap/git-pull.js");
  const { collectFacts } = await import("../../domainmap/core/scan-fs.js");
  const { stateDir } = await import("../../ops/state-dir.js");

  let clonePath: string;
  try { clonePath = repoClonePath(repo); }
  catch (e) { return { status: "error", summary: { error: (e as Error)?.message ?? String(e), repo } }; }
  if (!existsSync(clonePath)) return { status: "error", summary: { error: `클론 없음(${clonePath}) — 먼저 refresh_repo/refresh_all 로 clone 하세요.`, repo } };

  let facts: Awaited<ReturnType<typeof collectFacts>>;
  try { facts = await collectFacts(repo, clonePath); }
  catch (e) { return { status: "error", summary: { error: "사실 수집 실패: " + ((e as Error)?.message ?? String(e)), repo } }; }

  let factsPath: string;
  try {
    const dir = stateDir("bootstrap");
    await mkdir(dir, { recursive: true });
    factsPath = join(dir, repo.replace(/[^A-Za-z0-9._-]/g, "_") + ".facts.json");
    await writeFile(factsPath, JSON.stringify(facts));
  } catch (e) { return { status: "error", summary: { error: "사실 파일 기록 실패: " + ((e as Error)?.message ?? String(e)), repo } }; }

  let tmuxSession: string;
  try { tmuxSession = await resolveSessionTmux(sessionRef); }
  catch (e) { return { status: "error", summary: { error: (e as Error)?.message ?? String(e), session: sessionRef } }; }

  const prompt = buildBootstrapPrompt(repo, clonePath, factsPath, facts.files.length, facts.module_hints.length);
  try { await injectToSession(tmuxSession, prompt); }
  catch (e) { return { status: "error", summary: { error: "세션 주입 실패(" + tmuxSession + "): " + ((e as Error)?.message ?? String(e)), session: sessionRef, tmux: tmuxSession } }; }
  return { status: "ok", summary: { injected: true, managed_session: sessionRef, tmux: tmuxSession, repo, facts_path: factsPath, files: facts.files.length, module_hints: facts.module_hints.length } };
}

// 부트스트랩 가이드 프롬프트(단일 라인 주입 — injectToSession 이 개행 평탄화). 런북 참조 + 사실파일 경로 + 판단(유닛경계·매핑) + domainmap_ingest 배치.
function buildBootstrapPrompt(repo: string, clonePath: string, factsPath: string, files: number, hints: number): string {
  return `레포 '${repo}'의 도메인맵 is 최초 부트스트랩 작업이야. 먼저 knowledge_get 으로 'runbook-bootstrap-domains'(프로세스)와 'domainmap-is-bootstrap-runbook'(도구 델타)를 읽고 그대로 따라. ` +
    `① 결정론 사실은 이미 뽑아 뒀어: ${factsPath} (files ${files}개·module_hints ${hints}개·stack 포함). 통째 읽지 말고 grep/슬라이스로 참고(사실 바닥, 파일 환각 금지). ` +
    `② category_list(space=product)로 도메인 후보 + 각 should(코드 SoT 앵커)를 1회 확보. ` +
    `③ 유닛 경계는 판단이야(결정론 아님): module_hints 를 출발점으로, 한 모듈이 두 도메인에 걸치면 하위 디렉터리로 쪼개. code_unit.path 는 디렉터리 경로(파일 개별 유닛 지양). ` +
    `④ 각 유닛→domain_key 매핑 + 신뢰도(should 앵커 + 모듈명/패키지/대표 서비스 신호). 확신 낮으면 매핑을 빼서 unmapped 로 남겨(억지 매핑 금지). ` +
    `⑤ payload({repo:{name:'${repo}',root_path:'${clonePath}'}, run:{runbook:'bootstrap-domains'}, code_units, mappings, imports?})를 조립해 domainmap_ingest 를 '한 번' 호출(대량이면 서브트리별로 나눠 여러 콜; 건별 map_code_unit 반복 금지). ` +
    `⑥ 끝나면 code_unit/mapping 카운트 요약. 남은 unmapped 는 이후 map_unmapped 가 이어받아.`;
}

// 가이드 프롬프트 — **단일 라인**(send-keys -l 주입용; 개행 금지). DDD + 라이브 도메인 should fetch 지시(하드코딩 X → 자기갱신) + propose/근거/confidence 규약.
//  params.prompt 로 관리탭에서 덮어쓸 수 있음(웹 편집). count·repo 만 보간.
function buildMapPrompt(repo: string, count: number): string {
  return `미매핑 코드유닛(${count}건)을 제품 도메인에 분류하는 배치 작업이야. ` +
    `① category_list(space=product)+각 category_get으로 도메인 should(정의·범위)를 읽어 분류 기준으로 삼아. ` +
    `② list_unmapped(repo=${repo})로 인박스 가져와. ` +
    `③ 각 유닛 path·label 보고 필요하면 Read/Grep으로 헤더·내용·import 확인해 어떤 비즈니스 능력인지 파악. ` +
    `④ DDD(도메인=비즈니스 능력 경계, 기술레이어 아님)로 map_code_unit 호출: target=경로, category=도메인 key, origin=llm, ` +
    `evidence=근거(should의 어느 부분↔코드의 어느 신호, 필수), 확신이면 status=confirmed(confidence≥0.8) 아니면 proposed, ` +
    `제품 도메인 아닌 것(비즈니스문서·세일즈덱·stale산출물·너무 coarse한 디렉토리유닛)은 status=rejected+evidence에 이유. ` +
    `확신없으면 추측말고 proposed. 끝나면 confirmed/proposed/rejected 카운트 요약.`;
}
