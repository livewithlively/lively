// ── 액션 레지스트리(단일 진실원천) — 각 액션의 label + 필요 params 를 데이터로 선언. ──
//  프론트(크론 폼)가 이걸 읽어 드롭다운·파라미터 필드를 동적 생성(하드코딩 syncVis 제거). cron_set 검증도 여기서.
//  R16: 선언(메타)과 디스패치(run)를 한 몸으로 — 새 액션 추가 = actions/ 에 구현 1개 + 여기 1줄(if-체인 없음). 스키마 CHECK 도 갱신.
//  키·label·params 메타는 외부 표면(capabilities/cron.ts 가 노출 — 웹 크론 폼이 소비)이라 직렬화 불변 유지, run 은 JSON.stringify 에서 자연 탈락.
//  액션 구현(actions/*)의 무거운 의존은 각 파일 안 동적 import 그대로 — 이 모듈 정적 로드는 부팅 비용에 무영향.
//  param kind: 'session'(상시 세션 피커) · 'repo'/'system'/'text'(텍스트) · 'textarea' · 'select'(choices 드롭다운)
//   · 'distiller'(#1289 자료 증류기 피커 — [자료 증류기] 섹션에서 등록한 것). 비-필수는 비워도 됨.
import { runRefreshAll, runRefreshRepo, runRefreshBases } from "./actions/repo-refresh.js";
import { runConnectorSync, runConnectorPush, runWikiPush } from "./actions/connector.js";
import { runWikilinkSweep, runEvalDomainDebt, runEnsureManagedSessions, runPreviewReconcile } from "./actions/maintenance.js";
import { runManagers } from "./actions/manage.js"; // #1419 T5 관리기
import { runMapInject, runMapHeadless, runBootstrapInject } from "./actions/map-bootstrap.js";
import { runClassifyKnowledgeInject, runClassifyKnowledgeHeadless } from "./actions/classify.js";
import { runDistillInject, runDistillHeadless } from "./actions/distill.js";
import { runAgentInject, runAgentHeadless } from "./actions/agent.js";
import { runCanaryJob } from "./actions/canary.js"; // #1657 상류 회귀 탐지
import { HEADLESS_KEYS } from "../node/headless-harness.js"; // #1884 헤드리스 하네스 선택지(표에서 파생)

export interface CronActionParam { name: string; label: string; kind: "session" | "repo" | "system" | "text" | "textarea" | "select" | "distiller" | "classifier" | "manager"; choices?: string[]; hint?: string }
export interface CronActionDef { key: string; label: string; params: CronActionParam[]; run: CronActionRun }

export interface CronJob {
  id: string;
  action: string;
  params?: Record<string, unknown>;
  interval_sec: number;
  cron_expr?: string | null;
  run_once?: boolean;
  last_run_at?: string | null;
  created_by?: string | null; // #1058 agent_headless 의 의뢰자 폴백(params.requester 미설정 시).
}

// 실행 시그니처 — runJob(engine.ts)이 (job.params ?? {}, job) 를 넘긴다. 헤드리스판 어댑터가 job.id·created_by 를 뽑아 쓴다.
export type CronActionRun = (params: Record<string, unknown>, job: CronJob) => Promise<{ status: string; summary: unknown }>;

// 헤드리스 실행 하네스(#1884) — 비우면 자동: 의뢰자가 로그인한 하네스 ∩ 헤드리스 가능(둘 이상이면 claude 우선) → claude.
//  종전엔 이 축이 없어 모든 헤드리스 잡이 claude 고정이었고, codex 로만 로그인한 매니지드 테넌트의 파이프라인이 통째로 죽었다.
//  choices 는 tasks.ts HEADLESS 표(헤드리스 규약을 실측한 하네스)에서 파생 — 표에 없는 하네스는 여기 안 보인다.
const HEADLESS_HARNESS_PARAM: CronActionParam = { name: "harness", label: "하네스", kind: "select", choices: ["", ...HEADLESS_KEYS], hint: "비우면 자동(의뢰자가 로그인한 하네스 기준 — 둘 이상이면 claude). 아래 모델·effort 는 claude 에만 적용된다." };
// 헤드리스(claude -p) 실행 모델·추론강도 — claude 하네스 플래그(--model/--effort)와 동일 choices(terminal-sessions.ts HARNESSES).
//  비우면 계정 기본 모델(관리세션의 sonnet/xhigh 같은 설정이 헤드리스엔 전달 안 돼 기본으로 떨어지던 #1101 갭을 메움).
//  런타임 값은 tasks.ts FLAG_WHITELIST 가 **그 하네스의 표**로 한 번 더 검증하므로 여기 choices 가 UI 가드, 그쪽이 실행 가드다
//  (claude 별칭은 codex 표에 없어 codex 실행에선 자연히 탈락 — 그래서 'claude 에만 적용').
const HEADLESS_MODEL_PARAM: CronActionParam = { name: "model", label: "모델 (claude)", kind: "select", choices: ["", "fable", "opus", "sonnet", "haiku"], hint: "헤드리스 claude -p 실행 모델(claude 에만 적용). 비우면 계정 기본. 분류·판단 무거운 배치는 sonnet+ 권장." };
const HEADLESS_EFFORT_PARAM: CronActionParam = { name: "effort", label: "effort(추론 강도, claude)", kind: "select", choices: ["", "low", "medium", "high", "xhigh", "max"], hint: "claude 에만 적용. 비우면 기본. 분류·부트스트랩 등 판단 무거운 배치는 high+ 권장." };
export const CRON_ACTIONS: CronActionDef[] = [
  { key: "refresh_all", label: "전 repo is 신선화", params: [], run: runRefreshAll },
  { key: "refresh_repo", label: "한 repo is 신선화", params: [{ name: "repo", label: "repo", kind: "repo", hint: "context-ontology" }], run: runRefreshRepo },
  { key: "refresh_bases", label: "작업 base 레포 확보·최신화 (워크트리 원본)", params: [], run: runRefreshBases },
  { key: "connector_sync", label: "커넥터 sync (외부→우리)", params: [{ name: "system", label: "커넥터 system", kind: "system", hint: "비우면 active 전체" }], run: runConnectorSync },
  { key: "connector_push", label: "커넥터 push (우리→외부)", params: [{ name: "system", label: "커넥터 system", kind: "system", hint: "비우면 active 전체(run-push 는 clickup 전용)" }], run: runConnectorPush },
  // #976 위키 아웃바운드 — 등록 노션 feed_target(카테고리 N:M 매핑)로 정본 지식을 피드 카드로 투영. connector_push(프로젝트)의 위키판. 옵트인(매핑 없으면 무동작).
  { key: "wiki_push", label: "위키 push (산출 지식 → 노션 피드)", params: [], run: runWikiPush },
  { key: "eval_domain_debt", label: "도메인 부채 평가", params: [], run: runEvalDomainDebt },
  // #1419 T5 관리기 — 쌓인 지식을 계속 옳게 유지(분류 어긋남·아웃데이티드·모순·지식↔코드).
  //  결정적 종류(어긋남·아웃데이티드)는 이 틱 안에서 끝나고(LLM 비용 0), 판단이 필요한 종류만 배치로 나간다.
  { key: "run_managers", label: "관리기 실행 (지식 유지보수 — 어긋남·아웃데이티드·모순·코드괴리)", params: [
    { name: "manager", label: "관리기 (선택)", kind: "manager", hint: "[맥락 관리 ▸ 관리기]에서 등록한 관리기. 비우면 **켜진 관리기 전부**를 순서대로 실행." },
    { name: "requester", label: "의뢰자 (멤버 id/이메일)", kind: "text", hint: "모순·코드괴리 판정에만 필요(그 멤버의 AI 계정으로 실행·과금). 어긋남·아웃데이티드만 쓰면 비워도 된다." },
    HEADLESS_HARNESS_PARAM, HEADLESS_MODEL_PARAM, HEADLESS_EFFORT_PARAM,
  ], run: (p, job) => runManagers(p, job.id, job.created_by ?? null) },
  // #907 본문 [[위키링크]] → 지식 엣지 수렴. 저장 시 그 문서는 이미 수렴하니 이 잡의 값어치는 **시간이 푸는 것들**이다:
  //  붕 뜬 링크의 대상이 나중에 생기거나(그때 저장을 다시 하지 않는다), 대상이 지워졌다 되살아나거나, 저장 중
  //  best-effort 로 흘린 실패를 되잡는다. 전수 재계산(수렴형)이라 몇 번을 돌려도 같은 결과다.
  { key: "wikilink_sweep", label: "지식 본문 [[위키링크]] → 엣지 수렴", params: [], run: runWikilinkSweep },
  // #1657 상류 회귀 자동탐지 — 실자격으로 실호출하고 응답 내용을 단언한다(스키마 diff 로는 이 계열 고장을 못 잡는다).
  //  ⚠ 잡 생성자의 자격으로 상류에 실제 요청이 나간다 — 라이블리 카나리 계정으로 만들 것.
  { key: "run_canary", label: "상류 회귀 탐지(카나리) 1회전 — 커넥터가 조용히 막혔는지", params: [], run: runCanaryJob },
  { key: "map_unmapped", label: "미매핑 코드 LLM 분류 (세션 주입)", params: [{ name: "session", label: "타깃 상시 세션", kind: "session", hint: "‘상시 세션’ 탭에서 등록한 관리 세션. 죽어도 재생성·현재 세션으로 자동 해소." }], run: runMapInject },
  // #1061 map_unmapped 의 헤드리스판 — 상시세션 대신 매 배치 새 claude -p(fresh 컨텍스트)로 분류(관성 없음). agent_headless 파이프라인 재사용. 인박스 있을 때만 접수.
  { key: "map_unmapped_headless", label: "미매핑 코드 LLM 분류 (헤드리스 — 매 배치 새 세션)", params: [
    { name: "repo", label: "repo", kind: "repo", hint: "분류 대상 레포(비우면 context-ontology). 지정 레포의 base clone→worktree 를 작업 cwd 로 자동 준비 → 코드를 Read/Grep 할 수 있다." },
    { name: "requester", label: "의뢰자 (멤버 id/이메일)", kind: "text", hint: "헤드리스 실행 신원·과금 귀속(그 멤버의 클로드 로그인/프로필). 비우면 잡 생성자(created_by)." },
    { name: "prompt", label: "프롬프트 (선택 오버라이드)", kind: "textarea", hint: "비우면 기본 분류 프롬프트. 인박스 비면 접수 안 함." },
    HEADLESS_HARNESS_PARAM, HEADLESS_MODEL_PARAM, HEADLESS_EFFORT_PARAM,
  ], run: (p, job) => runMapHeadless(p, job.id, job.created_by ?? null) },
  // #982 미분류 지식 분류 — map_unmapped 의 지식판. 카테고리 0건 지식(노션 미러 등)을 상시세션에 주입해 분류. 인박스 있을 때만 주입.
  { key: "classify_knowledge", label: "미분류 지식 LLM 분류 (세션 주입)", params: [{ name: "session", label: "타깃 상시 세션", kind: "session", hint: "‘상시 세션’ 탭에서 등록한 관리 세션(map_unmapped 와 공용 가능)." }], run: runClassifyKnowledgeInject },
  // #1061 classify_knowledge 의 헤드리스판 — 상시세션 관성(옛 should 로 판단 — classify-knowledge-stale-session-inertia)을 매 배치 fresh 컨텍스트로 근본 회피. 인박스 있을 때만 접수.
  { key: "classify_knowledge_headless", label: "미분류 지식 LLM 분류 (헤드리스 — 매 배치 새 세션)", params: [
    { name: "classifier", label: "분류기 (선택)", kind: "classifier", hint: "[맥락 관리 ▸ 분류기]에서 등록한 분류기. 비우면 **켜져 있는 분류기 전부**를 각각 접수(병렬). 분류기가 하나도 없으면 종전 전역 분류로 동작." },
    { name: "requester", label: "의뢰자 (멤버 id/이메일)", kind: "text", hint: "헤드리스 실행 신원·과금 귀속(그 멤버의 클로드 로그인/프로필). 비우면 잡 생성자(created_by)." },
    { name: "prompt", label: "프롬프트 (선택 오버라이드)", kind: "textarea", hint: "비우면 기본 분류 프롬프트(관성 대응 — 매 배치 should 재조회·근거 인용 강제 포함). 인박스 비면 접수 안 함." },
    HEADLESS_HARNESS_PARAM, HEADLESS_MODEL_PARAM, HEADLESS_EFFORT_PARAM,
  ], run: (p, job) => runClassifyKnowledgeHeadless(p, job.id, job.created_by ?? null) },
  // 최초 is 부트스트랩 — 결정론 사실(dm scan)을 파일로 뽑고 runbook-bootstrap-domains 를 세션에 주입(map_unmapped 동형). 유닛 0 인 신규 레포 콜드스타트용.
  { key: "bootstrap_is", label: "레포 is 최초 부트스트랩 (세션 주입)", params: [
    { name: "repo", label: "repo", kind: "repo", hint: "부트스트랩할 레포 — 클론이 있어야 함(먼저 refresh_repo/refresh_all 로 clone)." },
    { name: "session", label: "타깃 상시 세션", kind: "session", hint: "부트스트랩 수행 관리 세션 — runbook-bootstrap-domains 따라 사실 grep→유닛/매핑 판단→domainmap_ingest 로 기록." },
  ], run: runBootstrapInject },
  // 자료 distill(#541) — 미증류 source(slack/gmail 등 raw)를 상시세션 LLM 이 지식으로 자동증류. 미증류 자료 있을 때만 주입.
  //  #1289 증류기 연동: distiller 를 고르면 그 증류기의 스코프·기준·형식으로, 비우면 잔량 있는 최우선 증류기 하나를
  //  자동 선택(세션은 한 번에 한 작업이라 N개 동시 주입은 쌓이기만 한다). 증류기가 0개면 구 전역 동작으로 폴백.
  { key: "distill_sources", label: "자료 distill (source→지식 자동증류)", params: [
    { name: "session", label: "타깃 상시 세션", kind: "session", hint: "distill 을 수행할 관리 세션 — 자료(source)를 읽어 지식으로 증류(knowledge_save+source_link)." },
    { name: "distiller", label: "증류기 (선택)", kind: "distiller", hint: "[AI 맥락 ▸ 자료 증류기]에서 등록한 증류기. 비우면 잔량이 있는 최우선 증류기를 매 틱 하나씩 자동 선택." },
    { name: "prompt", label: "프롬프트 (선택 오버라이드)", kind: "textarea", hint: "비우면 증류기 설정(기준·형식)으로 조립된 프롬프트. 직접 쓰면 기준·형식 문구만 이걸로 갈리고, 대상 자료 지정(이 증류기 몫의 id 목록)은 서버가 앞에 유지한다 — 커스텀 프롬프트가 스코프 해제가 되지 않게." },
  ], run: runDistillInject },
  // #1289 distill_sources 의 헤드리스판 — 매 배치 새 claude -p(fresh 컨텍스트). 증류기별로 **각각** 접수해 병렬로 돈다
  //  (세션판과 달리 한 세션에 쌓이지 않는다). 프로젝트 #1289 의 기본 운전 모드.
  { key: "distill_sources_headless", label: "자료 distill (헤드리스 — 증류기별 매 배치 새 세션)", params: [
    { name: "distiller", label: "증류기 (선택)", kind: "distiller", hint: "비우면 **켜져 있는 증류기 전부**를 각각 접수(병렬). 하나만 고르면 그것만." },
    { name: "node", label: "실행 노드 (선택)", kind: "text", hint: "비우면 스케줄러가 램 여유가 큰 노드를 고른다(중앙 후순위). 'central' = 게이트웨이 박스에서, 또는 특정 노드 id. 그 노드가 꺼져 있으면 배치가 큐에 대기한다." },
    { name: "requester", label: "의뢰자 (멤버 id/이메일)", kind: "text", hint: "헤드리스 실행 신원·과금 귀속(그 멤버의 클로드 로그인/프로필). 비우면 증류기 설정값 → 잡 생성자(created_by)." },
    { name: "prompt", label: "프롬프트 (선택 오버라이드)", kind: "textarea", hint: "비우면 증류기 설정으로 조립. 직접 쓰면 기준·형식만 갈린다 — 대상 자료 지정(스코프)은 서버가 앞에 붙여 유지한다." },
    HEADLESS_HARNESS_PARAM, HEADLESS_MODEL_PARAM, HEADLESS_EFFORT_PARAM,
  ], run: (p, job) => runDistillHeadless(p, job.id, job.created_by ?? null) },
  // 일반 에이전트 태스크 — (세션=환경·맥락·계정) × (프롬프트=작업)으로 잡마다 임의 작업. recurring 에이전트 잡을 코드 없이 데이터로.
  { key: "agent_inject", label: "에이전트 태스크 (상시 세션에 프롬프트 주입)", params: [
    { name: "session", label: "타깃 상시 세션", kind: "session", hint: "작업을 수행할 관리 세션 — 그 세션의 워크스페이스 맥락·계정(클로드 로그인)이 작업 환경을 정한다." },
    { name: "prompt", label: "프롬프트 (작업 지시)", kind: "textarea", hint: "이 세션에 주입할 작업. 세션 워크스페이스 + lively MCP 로 수행. (개행은 주입 시 공백으로 합쳐짐 — 한 단락 권장.)" },
  ], run: runAgentInject },
  // #1058 agent_inject 의 헤드리스판 — 상시세션에 주입하는 대신 매 실행 새 `claude -p` one-shot(빈 컨텍스트)을 위탁(delegate)
  //  파이프라인으로 배치·실행한다. 상시세션의 컨텍스트 관성(옛 should 로 판단 — classify-knowledge-stale-session-inertia)이 없어
  //  분류·재판단류 배치에 정합. 과금은 구독 크레딧(F5 실측 2026-07-15 — claude -p 가 공유 ~/.claude OAuth 로 실행, 별도 API 과금 아님).
  { key: "agent_headless", label: "에이전트 태스크 (헤드리스 claude -p — 매 실행 새 세션)", params: [
    { name: "prompt", label: "프롬프트 (작업 지시)", kind: "textarea", hint: "매 실행 새 헤드리스 세션(빈 컨텍스트)에서 lively MCP 로 수행. 상시세션 주입과 달리 관성이 없어 매번 최신 SoT 를 다시 읽는다(개행 허용 — 파일로 전달)." },
    { name: "requester", label: "의뢰자 (멤버 id/이메일)", kind: "text", hint: "이 헤드리스 실행의 신원·과금 귀속(그 멤버의 클로드 로그인/프로필). 비우면 잡 생성자(created_by)로 실행." },
    { name: "repo", label: "레포 (선택)", kind: "repo", hint: "지정하면 공유 base clone→worktree 를 자동 준비해 작업 cwd 로 삼는다(프롬프트에 클론 지시 불필요). 비우면 빈 워크스페이스." },
    HEADLESS_HARNESS_PARAM, HEADLESS_MODEL_PARAM, HEADLESS_EFFORT_PARAM,
  ], run: (p, job) => runAgentHeadless(p, job.id, job.created_by ?? null) },
  { key: "ensure_managed_sessions", label: "상시 세션 keep-alive", params: [], run: runEnsureManagedSessions },
  // #1036 프리뷰 환경 — 유휴 TTL 회수 + auto 트리거 stage 재-merge(작업 브랜치 갱신 반영). 정지된 건 안 켬(온디맨드).
  { key: "preview_reconcile", label: "프리뷰 환경 reconcile (유휴 회수 + auto stage 재-merge)", params: [], run: runPreviewReconcile },
];
export const CRON_ACTION_KEYS: string[] = CRON_ACTIONS.map((a) => a.key);
