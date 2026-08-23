// v6 project capability — 프로젝트(1급 엔티티) + 작업(task/subtask) CRUD·상태·팀원·카테고리/지식 연결.
//  레거시 org_project capability(projects.ts)와 병행(REST-only 로 시작 — 웹 v6 프로젝트 탭이 소비). MCP 노출은 컷오버에서 일괄.
//  scope='memory'(조직 공유 작업/지식 평면 — 레거시 project_* 와 동일). 경로 prefix=/api/ui/v6/projects. 감사는 store(project-store)가 처리.
import { z } from "zod";
import { canSeeProjectRow, visibleListIds, listVisible, projectRowListId } from "../v6/visibility.js";
import { HttpError, parseId } from "./rest-util.js";
import type { Capability, CapabilityCtx } from "./types.js";
import type { LivelyUser } from "../context.js";
import { listSessions } from "../terminal/terminal-sessions.js";
import { ensureAgentsMd } from "../v6/agents-md.js";
import { syncFolderAcls } from "../v6/folder-acl-sync.js";
// 워크스페이스 회수(#813 T3-2) — 프로젝트 마무리 시 '복구 가능한 것'만 되돌린다(파생물 + 푸시된 워크트리).
import { projectAbsPath } from "../project/project-fs.js";
// #905 C2a — 크로스멤버 신원(origin URL 정규화). 정규화는 이 서버 한 곳이 SoT(클라이언트 중복구현 금지 — 갈리면 중복 프로젝트).
import { originKey } from "../project/project-origin.js";
import { planReclaim, applyReclaim, baseRepoOf, reposIn } from "../ops/workspace-reclaim.js";

// 프로젝트 digest(AGENTS.md) 를 변경 직후 재생성 — 매니페스트/세션시작 pull 전에도 파일이 최신으로 존재하게.
//  폴더가 없으면(신규 생성 직후) ensureAgentsMd 내부에서 만든다. 비치명적(실패해도 본 작업은 성공).
const regenAgents = (id: number) => ensureAgentsMd(id).catch((e) => { console.error("[regenAgents] fail id=" + id + ":", e); });
// 리스트 카테고리 변경(#541 후속 F4) — 그 리스트의 모든 프로젝트가 카테고리를 상속하므로 형제 전부의 AGENTS.md 재생성. best-effort.
const regenAgentsForList = async (listId: number | null) => {
  if (listId == null) return;
  try { for (const pid of await projectIdsInList(listId)) await regenAgents(pid); } catch (e) { console.error("[regenAgentsForList] fail list=" + listId + ":", e); }
};
import {
  listProjects, getProject, getProjectRow, createProject, deleteProject, updateProjectStatus, updateProject, setProjectArchived, getBoardFields,
  upsertProjectFolderBinding, findProjectsByOriginKey,
  createTask, updateTaskStatus, updateTask, deleteTaskNode, reorderTasks, reorderProjects, rootProjectIdOfTaskNode, setProjectMembers, setProjectMemberStatus, isProjectMember,
  linkProjectCategory, unlinkProjectCategory, setProjectCategories,
  linkProjectKnowledge, unlinkProjectKnowledge, setProjectRepos,
  recommendKnowledgeForProject, projectsForKnowledge,
  linkProjectEdge, unlinkProjectEdge, getProjectListRow,
  projectIdsInList, listIdOfProject,
  searchProjects, countProjectGrep, hybridSearchProjects, // #631 프로젝트 검색(grep/hybrid)
  findSimilarProjects,                                  // #1762 유사 프로젝트(절대 코사인 — 게이팅 가능)
  listMyTasks, // #1232 대시보드 '내 할 일' — 사람 축 태스크 조회
  listTasksForProjects, // #1305 타임라인(간트) — 프로젝트 여러 개의 하위 작업 벌크 조회
  getNodeRow, listEdgesForNodes, rescheduleDependents, // #1308 의존선 — 노드(레벨 무관) 엣지·자동 재스케줄
} from "../v6/project-store.js";

const STATUSES = ["active", "done"] as const;
// 프로젝트도 태스크 리스트처럼 할 일/진행 중/완료로 그룹핑(웹 보드) — 상태 쓰기에서 todo|in_progress 도 허용.
//  레거시·기본값 'active' 는 프론트가 '진행 중'으로 흡수(표시만). 스키마 CHECK 는 이미 4종 허용.
const PROJECT_STATUSES = ["active", "done", "todo", "in_progress"] as const;
const RELATIONS = ["required", "produced"] as const;
// 태스크 전용 다단계 상태(프로젝트의 active|done 와 별개) — 리스트뷰 그룹핑 축. 우선순위 4단계(클릭업 동형).
const TASK_STATUSES = ["todo", "in_progress", "done"] as const;
const PRIORITIES = ["urgent", "high", "normal", "low"] as const;

function parseStatus(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!(STATUSES as readonly string[]).includes(s)) throw new HttpError(400, "status 는 active|done 중 하나여야 합니다");
  return s;
}
function parseProjectStatus(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!(PROJECT_STATUSES as readonly string[]).includes(s)) throw new HttpError(400, "status 는 todo|in_progress|done 중 하나여야 합니다");
  return s;
}
function parseRelation(v: unknown): string {
  const r = String(v ?? "").trim();
  if (!(RELATIONS as readonly string[]).includes(r)) throw new HttpError(400, "relation 은 required|produced 중 하나여야 합니다");
  return r;
}
// 프로젝트↔프로젝트 엣지 relation(project_edge) — 1차 노출 follow_up. 생략 시 follow_up 기본.
const EDGE_RELATIONS = ["follow_up", "supersedes", "depends_on", "related"] as const;
function parseEdgeRelation(v: unknown): string {
  const r = (String(v ?? "").trim() || "follow_up");
  if (!(EDGE_RELATIONS as readonly string[]).includes(r)) throw new HttpError(400, "relation 은 follow_up|supersedes|depends_on|related 중 하나여야 합니다");
  return r;
}
// 태스크 필드 파서 — 패치 시맨틱: 키 부재=변경 없음(undefined), 키 존재+빈값/null=해제(null). 따라서 null 반환 가능.
function parseTaskStatus(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!(TASK_STATUSES as readonly string[]).includes(s)) throw new HttpError(400, "status 는 todo|in_progress|done 중 하나여야 합니다");
  return s;
}
function parsePriorityOrNull(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!s) return null;
  if (!(PRIORITIES as readonly string[]).includes(s)) throw new HttpError(400, "priority 는 urgent|high|normal|low 또는 빈값이어야 합니다");
  return s;
}
function parseDateOrNull(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, "날짜는 YYYY-MM-DD 형식이어야 합니다");
  return s;
}
function parseAssigneeOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

// ── 공개범위 게이트(#1291) ────────────────────────────────────────────────
//  쓰기·상세 조작은 전부 이 한 줄을 지난다. "보이지 않는 것은 만질 수도 없다" 가 규칙이고,
//  거부는 403 이 아니라 **404** 다 — 403 은 "그 id 의 무언가가 있다"는 사실을 알려주기 때문이다.
//  (열려 있는 리스트라면 종전대로 전원 통과 — #452·#280 의 협업 동선은 그대로다.)
async function assertProjectVisible(rowId: number, ctx?: CapabilityCtx, label = "프로젝트"): Promise<void> {
  const viewer = ctx?.viewer ?? null;
  if (viewer === null) return;
  if (!(await canSeeProjectRow(Number(rowId), viewer))) throw new HttpError(404, `${label} #${rowId} 없음`);
}

// 핸들러가 읽는 이름(REST 는 query 'category'→categoryId 매핑).
const projectListV6Input = {
  space: z.string().optional(),
  categoryId: z.number().int().positive().optional(),
  status: z.enum(STATUSES).optional(),
  mine: z.boolean().optional(),
  // #1851 아카이브 — exclude(기본: 보관한 프로젝트 제외) · include(보관 포함 전체) · only(보관한 것만).
  archived: z.enum(["exclude", "include", "only"]).optional()
    .describe("아카이브(보관) 프로젝트 처리 — exclude(기본: 제외) · include(포함) · only(보관한 것만). 보관은 project_archive_v6."),
};
type ProjectListV6Input = z.infer<z.ZodObject<typeof projectListV6Input>>;
const projectListV6: Capability = {
  name: "project_list_v6",
  title: "프로젝트 목록(v6)",
  description: "프로젝트(level=project)를 space/카테고리/status 로 최신순 조회. 보관(아카이브)한 프로젝트는 기본 제외 — archived=include|only 로 본다. 웹 v6 프로젝트 탭 전용.",
  scope: "memory",
  input: projectListV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/v6/projects"],
      parse: (req) => {
        const query = (req.query ?? {}) as Record<string, unknown>;
        return {
          space: query.space ? String(query.space) : undefined,
          categoryId: query.category ? Number(query.category) : undefined,
          status: query.status ? String(query.status) : undefined,
          mine: query.mine === "1" || query.mine === "true",
          archived: query.archived === "include" || query.archived === "only" ? String(query.archived) as "include" | "only" : undefined,
        };
      } }],
  },
  // mine=1 이면 viewer(토큰 신원) 기준 '내 프로젝트'만(생성자·팀원). MCP 호출은 mine 미지정 → 전체.
  handler: async (input: ProjectListV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    // 공개범위 시행 신원(#475→#1291) — 어댑터가 채운 ctx.viewer 를 그대로 쓴다(admin 은 이미 null=특권으로 정규화됨).
    //  ⚠ 구 주석은 "MCP 는 신원 없이 전체 열람"이라고 했지만 사실이 아니었다 — MCP 도 bearer 신원이 항상 있어
    //   이미 필터되고 있었다(webOnly 분기는 도달 불가였다). 이제 웹·MCP 가 한 필드를 공유해 규칙이 하나로 모인다.
    const viewerVis = ctx?.viewer ?? null;
    const projects = await listProjects({
      space: input.space, categoryId: input.categoryId, status: input.status,
      viewer: input.mine ? (ctx?.actor ?? user?.userId ?? null) : undefined,
      viewerVis,
      archived: input.archived,
    });
    // 내 세션 수(프로젝트별) — 보드의 '내 세션' 칼럼을 '있으면 활성, 없으면 비활성'으로 칠하기 위한 신호.
    //  tmux 세션 목록 한 번 호출 → owned(@box_owner=나) 세션을 projectId(@box_project) 로 집계. 실패해도 목록은 그대로.
    if (input.mine && user) {
      try {
        const sessions = await listSessions(user);
        const byProj = new Map<number, number>();
        for (const s of sessions) {
          if (s.owned && s.projectId) byProj.set(s.projectId, (byProj.get(s.projectId) || 0) + 1);
        }
        for (const p of projects as any[]) p.my_session_count = byProj.get(Number(p.id)) || 0;
      } catch { /* 세션 조회 실패 → my_session_count 미부여(프론트는 0=비활성으로 처리) */ }
    }
    return { projects };
  },
};

// ── 검색(#631) — grep(정확 토큰/정규식) + hybrid(의미·벡터 RRF). UI 미정 → 백엔드 표면만. scope=memory(읽기). ──
//  ⚠ 라우트 순서: /projects/search·/projects/semantic 는 반드시 project_get_v6(/projects/:id) '앞에' 둔다
//   (web.ts 는 restMounts 순서대로 app.get 마운트 → Express first-match. 뒤에 두면 :id 가 'search' 를 삼킨다).
const SEARCH_LEVELS = ["project", "task", "subtask"] as const;
function parseSearchOpts(query: Record<string, unknown>): Record<string, unknown> {
  const level = query.level ? String(query.level) : undefined;
  return {
    q: String(query.q ?? ""),
    level: level && (SEARCH_LEVELS as readonly string[]).includes(level) ? level : undefined,
    list_id: query.list_id != null && query.list_id !== "" ? Number(query.list_id) : undefined,
    status: query.status ? String(query.status) : undefined,
    limit: query.limit != null && query.limit !== "" ? Number(query.limit) : undefined,
    mode: query.mode ? String(query.mode) : undefined,
    context: query.context != null && query.context !== "" ? Number(query.context) : undefined,
  };
}
// 핸들러 입력(project_grep/project_search 공통) → project-store 검색 opts(list_id→listId 매핑).
function toSearchOpts(input: any) {
  return { level: input.level, listId: input.list_id, status: input.status, limit: input.limit, mode: input.mode, context: input.context };
}

const projectGrepV6Input = {
  q: z.string().min(1),
  level: z.enum(SEARCH_LEVELS).optional(),
  list_id: z.number().int().positive().optional(),
  status: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  mode: z.enum(["snippets", "names", "count"]).optional(),
  context: z.number().int().min(0).max(3).optional(),
};
type ProjectGrepV6Input = z.infer<z.ZodObject<typeof projectGrepV6Input>>;
const projectGrepV6: Capability = {
  name: "project_grep",
  title: "프로젝트 grep(v6)",
  description: "프로젝트·태스크·서브태스크의 이름/설명을 grep — 한 토큰, 공백구분 다중토큰(AND), 또는 POSIX 정규식. 의미검색 아님(그건 project_search). 매치 줄 스니펫(L<n>:) 반환, 전문은 project_get_v6. level(project|task|subtask)·list_id·status 로 좁힘. mode=snippets(기본)|names|count.",
  scope: "memory",
  input: projectGrepV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/v6/projects/search"],
      parse: (req) => parseSearchOpts((req.query ?? {}) as Record<string, unknown>) }],
  },
  handler: async (input: ProjectGrepV6Input, _user: LivelyUser, ctx?: CapabilityCtx) => {
    // 검색도 목록과 같은 공개범위를 탄다(#1291) — 이 핸들러는 예전엔 뷰어 인자 자체를 안 받아, 목록에선 가려진
    //  프로젝트의 이름·본문 스니펫이 grep 으로 그대로 나왔다(표면 간 정책 불일치의 대표 사례).
    const opts = { ...toSearchOpts(input), viewer: ctx?.viewer ?? null };
    if (input.mode === "count") return { mode: "count", total: await countProjectGrep(input.q, opts) };
    return { mode: input.mode ?? "snippets", projects: await searchProjects(input.q, opts) };
  },
};

const projectSearchV6Input = {
  q: z.string().min(1),
  level: z.enum(SEARCH_LEVELS).optional(),
  list_id: z.number().int().positive().optional(),
  status: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  mode: z.enum(["snippets", "names"]).optional(),
  context: z.number().int().min(0).max(3).optional(),
};
type ProjectSearchV6Input = z.infer<z.ZodObject<typeof projectSearchV6Input>>;
const projectSearchV6: Capability = {
  name: "project_search",
  title: "프로젝트 검색(v6, 하이브리드)",
  description: "프로젝트·태스크·서브태스크를 의미 기반 하이브리드 검색(벡터 임베딩 + 렉시컬 grep 을 RRF 로 융합). 자연어 질문·다른 표현도 찾아냄(단어가 본문에 그대로 없어도). 임베딩 off 면 grep 폴백. 정확 토큰/정규식은 project_grep. level·list_id·status 로 좁힘. mode=snippets(기본)|names.",
  scope: "memory",
  input: projectSearchV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/v6/projects/semantic"],
      parse: (req) => parseSearchOpts((req.query ?? {}) as Record<string, unknown>) }],
  },
  handler: async (input: ProjectSearchV6Input, _user: LivelyUser, ctx?: CapabilityCtx) => {
    return { projects: await hybridSearchProjects(input.q, { ...toSearchOpts(input), viewer: ctx?.viewer ?? null }) };
  },
};

// ── 유사 프로젝트(절대 코사인, #1762) — project_search(RRF) 와 직교. 랭크가 아니라 **절대 유사도**라 임계 비교가 된다. ──
//  왜 필요한가: RRF 점수는 순위 역수(Σ 1/(k+rank))라 무관한 질의에도 상위 N 이 늘 나온다 — "관련 있을 때만 보여준다"는
//  게이팅을 세울 수 없다(실측 2026-08-18: 무관 질의 top5 가 0.0164·0.0161·0.0159… 로 촘촘). 훅(세션↔프로젝트 연결
//  후보 회수)처럼 **무관하면 아무것도 하지 않아야** 하는 표면이 이걸 쓴다. knowledge_similar 와 동형.
const projectSimilarV6Input = {
  text: z.string().min(1).max(8000).optional().describe("기준 텍스트(즉시 임베딩) — id 와 택일"),
  id: z.number().int().positive().optional().describe("기준 프로젝트 id(저장된 임베딩 재사용, 자기 제외) — text 와 택일"),
  level: z.enum(SEARCH_LEVELS).optional(),
  list_id: z.number().int().positive().optional(),
  status: z.string().optional(),
  include_done: z.boolean().optional().describe("완료·취소된 것도 포함(기본 false — 죽은 프로젝트를 후보로 권하지 않는다)"),
  limit: z.number().int().min(1).max(50).optional(),
  min_score: z.number().min(0).max(1).optional().describe("이 코사인 유사도(0~1) 이상만(기본 0)"),
};
type ProjectSimilarV6Input = z.infer<z.ZodObject<typeof projectSimilarV6Input>>;
const projectSimilarV6: Capability = {
  name: "project_similar",
  title: "유사 프로젝트",
  description:
    "주어진 텍스트(text) 또는 프로젝트(id)와 **의미적으로 가장 가까운** 프로젝트를 코사인 유사도(0~1)로 찾는다. " +
    "min_score(0~1) 이상만, 유사도 내림차순 — **랭크가 아니라 절대 유사도라 '관련 없으면 빈 결과'가 성립한다**(project_search 의 RRF 점수로는 불가). " +
    "지금 하는 일을 어느 프로젝트에 붙일지 고를 때, 새 프로젝트를 만들기 전 중복 확인할 때 쓴다. 기본으로 완료·취소 프로젝트는 제외(include_done 으로 포함). " +
    "**임베딩이 꺼져 있거나 대상에 임베딩이 없으면 빈 결과**(자연어 검색은 project_search, 정확매칭은 project_grep).",
  scope: "memory",
  input: projectSimilarV6Input,
  // REST 마운트는 project_get_v6(/projects/:id) **앞**에 둬야 'similar'가 :id 로 안 잡힌다(semantic 과 동형 — 아래 배열 순서).
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/v6/projects/similar"],
      parse: (req) => {
        const query = (req.query ?? {}) as Record<string, unknown>;
        const text = query.text ? String(query.text) : undefined;
        const id = query.id != null && query.id !== "" ? Number(query.id) : undefined;
        if (!text && id == null) throw new HttpError(400, "text 또는 id 가 필요합니다");
        const level = query.level ? String(query.level) : undefined;
        return {
          text, id,
          level: level && (SEARCH_LEVELS as readonly string[]).includes(level) ? level : undefined,
          list_id: query.list_id != null && query.list_id !== "" ? Number(query.list_id) : undefined,
          status: query.status ? String(query.status) : undefined,
          include_done: query.include_done === "1" || query.include_done === "true",
          limit: query.limit != null && query.limit !== "" ? Number(query.limit) : undefined,
          min_score: query.min_score != null && query.min_score !== "" ? Number(query.min_score) : undefined,
        };
      } }],
  },
  handler: async (input: ProjectSimilarV6Input, _user: LivelyUser, ctx?: CapabilityCtx) => {
    if (!input.text && input.id == null) throw new HttpError(400, "text 또는 id 중 하나가 필요합니다");
    return {
      projects: await findSimilarProjects({
        text: input.text, id: input.id, limit: input.limit, minScore: input.min_score,
        level: input.level, listId: input.list_id, status: input.status, includeDone: input.include_done,
        viewer: ctx?.viewer ?? null,
      }),
    };
  },
};

const projectGetV6Input = { id: z.number().int().positive() };
type ProjectGetV6Input = z.infer<z.ZodObject<typeof projectGetV6Input>>;
const projectGetV6: Capability = {
  name: "project_get_v6",
  title: "프로젝트 상세(v6)",
  description: "프로젝트 1건 + 팀원·작업위계(task▸subtask)·카테고리·필요/산출지식 + 프로젝트↔프로젝트 엣지(edges.outgoing=이 프로젝트가 후속하는 선행, edges.incoming=이 프로젝트를 후속하는 것). 상세 페이지 전용.",
  scope: "memory",
  input: projectGetV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/v6/projects/:id"],
      parse: (req) => ({ id: parseId(req.params?.id) }) }],
  },
  handler: async (input: ProjectGetV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    // 열람 전원 개방(#280)의 정신은 유지한다 — 공개 리스트의 프로젝트는 비참여자도 클릭해 열 수 있다.
    //  다만 공개범위가 걸린 리스트라면 그 대상만 본다(#1291). 비대상에겐 "없음" 과 같은 404 로 응답해 존재를 숨긴다.
    const project = await getProject(input.id, ctx?.viewer ?? null);
    if (!project) throw new HttpError(404, `프로젝트 #${input.id} 없음`);
    return { project };
  },
};

// 생성(project/task) 응답에 실리는 prior-art 안내(#639) — 에이전트가 새로 만들기 전 기존 자산을 확인·재사용하도록.
const PRIOR_ART_NOTE =
  "⚠ 이것과 의미적으로 겹칠 수 있는 기존 지식입니다(유사도순). 새로 설계·구현하기 전에 knowledge_get(name)으로 본문을 확인하세요 — 이미 있으면 중복해서 만들지 말고 재사용/보강하세요.";

const projectCreateV6Input = {
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  folder: z.string().max(256).optional(),
  members: z.array(z.string()).optional(),
  list_id: z.number().int().positive().describe("소속 리스트(영역) id — project_list_index_v6 로 조회. MCP 생성 시 필수."),
  follow_up: z.number().int().positive().optional().describe("이 프로젝트가 '후속'하는 선행 프로젝트 id(선택) — 생성 직후 follow_up 엣지 연결."),
};
type ProjectCreateV6Input = z.infer<z.ZodObject<typeof projectCreateV6Input>>;
const projectCreateV6: Capability = {
  name: "project_create_v6",
  title: "프로젝트 생성(v6)",
  description: "새 프로젝트 생성 + 팀원 초기 등록. **list_id(소속 리스트/영역)는 MCP 생성 시 필수**(project_list_index_v6 로 id 조회). follow_up=선행 프로젝트 id(선택) 주면 생성 직후 follow_up 엣지(이 프로젝트가 그 선행의 후속)도 연결.",
  scope: "memory",
  input: projectCreateV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const name = String(b.name ?? "").trim();
        if (!name) throw new HttpError(400, "name 이 필요합니다");
        return {
          name,
          description: b.description ? String(b.description) : undefined,
          folder: b.folder ? String(b.folder) : undefined,
          members: Array.isArray(b.members) ? b.members.map((x: unknown) => String(x)) : undefined,
          // 웹은 list_id 선택(미지정 허용 — 보드에서 나중에 분류). MCP 는 위 zod 로 필수.
          list_id: b.list_id != null ? parseId(b.list_id) : undefined,
          follow_up: b.follow_up != null ? parseId(b.follow_up) : undefined,
        };
      } }],
  },
  handler: async (input: ProjectCreateV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    // 유효성 먼저(생성 전) — 잘못된 folder/list_id/follow_up 으로 고아 프로젝트가 안 생기게. 순수검사(folder)를
    //  DB 왕복(list_id/follow_up) 앞에 둔다.
    // folder 는 여태 **쓸 때 검증이 없었다** — 범위 검사는 읽을 때(projectAbsPath)만 했다. 그런데 그 읽기 경로
    //  (regenAgents → ensureAgentsMd → resolveProjectBase → projectAbsPath)는 아래 regenAgents 의 .catch 가 삼켜서,
    //  범위 밖 folder(예: "/Users/me/code/myapp")로 만든 프로젝트는 **INSERT 만 성공**하고 AGENTS.md 는 영영 미생성,
    //  /shared/manifest 는 영구 400(work.mjs 즉사) 이 된다 — 전부 무음. 읽기와 **같은 자**로 생성 전에 차단한다.
    //  (folder 는 "게이트웨이 공유베이스 하위 project/<id>" 전용 — 로컬 절대경로는 .lively/project.json 마커의 몫.)
    if (input.folder != null) projectAbsPath(String(input.folder));
    // 대상 리스트도 '보이는 리스트'여야 한다(#1291) — 안 그러면 비대상자가 잠긴 리스트에 프로젝트를 꽂아 넣고,
    //  그 안의 내용을 대상자들이 모르는 채로 만들 수 있다. 존재하지 않는 것과 같은 문구로 답해 존재를 숨긴다.
    //  ⚠ 판정은 반드시 listVisible 로 — visibleListIds 는 '필터 없음'에 null 을 주므로 `!ids?.has(id)` 로 줄이면
    //   그 null 이 **전부 불가시**로 뒤집힌다(#1614: 프로젝트 축을 끈 조직에서 이 생성이 전부 400 이었다).
    if (input.list_id != null && ctx?.viewer != null
        && !listVisible(await visibleListIds(ctx.viewer), Number(input.list_id))) {
      throw new HttpError(400, `리스트(영역) #${input.list_id} 가 없습니다 — project_list_index_v6 로 확인하세요`);
    }
    if (input.list_id != null && !(await getProjectListRow(input.list_id))) {
      throw new HttpError(400, `리스트(영역) #${input.list_id} 가 없습니다 — project_list_index_v6 로 확인하세요`);
    }
    if (input.follow_up != null && !(await getProjectRow(input.follow_up))) {
      throw new HttpError(400, `선행 프로젝트 #${input.follow_up} 가 없습니다`);
    }
    const project = await createProject(input, writeCtx);
    if (input.follow_up != null) await linkProjectEdge(project.id, input.follow_up, "follow_up", writeCtx); // new --follow_up--> 선행
    await regenAgents(project.id);  // 생성 직후 AGENTS.md(+폴더) 생성 — 다음 pull 전에도 존재.
    // 잠긴 리스트 안에 만든 프로젝트면 그 폴더에도 즉시 ACL 을 건다(#1291 v2) — 폴더는 방금 생겼으므로
    //  리스트 잠금 시점의 동기화가 이 프로젝트를 보지 못했다. 안 걸면 셸에서 그대로 읽힌다.
    if (input.list_id != null) await syncFolderAcls(Number(input.list_id));
    // prior-art 앞단 표면화(#639) — 만들자마자 이 프로젝트와 겹칠 수 있는 기존 지식을 응답에 실어, 중복 재구현을
    //  '종점(knowledge_save 유사경고)'이 아니라 '시작'에서 차단. 추천 실패해도 생성은 성공(비차단·catch).
    const prior_art = await recommendKnowledgeForProject(project.id, { limit: 5, minScore: 0.55, viewer: ctx?.viewer ?? null }).catch(() => []);
    return prior_art.length ? { project, prior_art, prior_art_note: PRIOR_ART_NOTE } : { project };
  },
};

// status = CHECK 유효 네이티브 투영(todo|in_progress|done|active). status_raw = 리스트 커스텀 상태 키(개방 어휘, null=해제).
const projectSetStatusV6Input = { id: z.number().int().positive(), status: z.enum(PROJECT_STATUSES), status_raw: z.string().max(120).nullable().optional() };
type ProjectSetStatusV6Input = z.infer<z.ZodObject<typeof projectSetStatusV6Input>>;
const projectSetStatusV6: Capability = {
  name: "project_set_status_v6",
  title: "프로젝트 상태 변경(v6)",
  description: "프로젝트 상태를 할 일(todo)·진행 중(in_progress)·완료(done) 로 변경(레거시 active 도 허용). 완료 시 완료시각 기록. status_raw 로 리스트별 커스텀 상태명(개방 어휘)도 함께 저장(#475). 웹 전용.",
  scope: "memory",
  input: projectSetStatusV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/status"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const rawIn = b.status_raw;
        const status_raw = (rawIn == null || rawIn === "") ? null : String(rawIn).trim().slice(0, 120);
        return { id: parseId(req.params?.id), status: parseProjectStatus(b.status), status_raw };
      } }],
  },
  handler: async (input: ProjectSetStatusV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    await assertProjectVisible(input.id, ctx);
    const project = await updateProjectStatus(input.id, input.status, writeCtx, input.status_raw ?? null);
    await regenAgents(input.id);
    return { project };
  },
};

// ── 아카이브(#1851) — 프로젝트를 통째로 보관하거나 되돌린다. 삭제가 아니다(태스크·팀원·세션·지식 연결 전부 그대로). ──
//  보관하면 목록(project_list_v6 기본)·보드·새 셸 사이드바에서 빠지고 「아카이브」 화면에서만 보인다.
//  가시성 게이트는 다른 쓰기와 같다(보이지 않는 것은 만질 수 없다 — 404).
const projectArchiveV6Input = {
  id: z.number().int().positive(),
  archived: z.boolean().describe("true=아카이브로 보관 · false=보관 해제(평소 목록으로 복귀)"),
};
type ProjectArchiveV6Input = z.infer<z.ZodObject<typeof projectArchiveV6Input>>;
const projectArchiveV6: Capability = {
  name: "project_archive_v6",
  title: "프로젝트 아카이브(v6)",
  description: "프로젝트를 아카이브로 보관(archived=true)하거나 되돌린다(false). 삭제가 아니다 — 태스크·팀원·세션·지식 연결은 그대로 두고 평소 목록에서만 뺀다(project_list_v6 기본 제외, archived=include|only 로 조회). 감사 op=archive|unarchive.",
  scope: "memory",
  input: projectArchiveV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/archive"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { id: parseId(req.params?.id), archived: b.archived === undefined ? true : !!b.archived };
      } }],
  },
  handler: async (input: ProjectArchiveV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    await assertProjectVisible(input.id, ctx);
    const project = await setProjectArchived(input.id, input.archived, writeCtx);
    return { project };
  },
};

// 프로젝트 이름/설명 수정 — 주어진 키만 패치(name 비우기 불가, description 빈값=해제).
//  본문(description)은 전체 교체 외에 append_description 으로 원문 보존 후 끝에 이어쓰기(보강)도 가능 — 둘은 상호배타.
// ── 자동 재스케줄 전파(#1308) — 프로젝트·태스크 패치가 공유하는 한 경로. ──
//  Δ 는 **due 의 변화량을 우선**한다. 후행을 막는 것은 선행의 '종료'이기 때문 — 바를 리사이즈해 due 만
//  늘렸다면 그 늘어난 만큼 후행이 밀리는 것이 맞다. due 가 없거나 안 움직였으면 start 변화량으로 폴백한다.
//  날짜는 'YYYY-MM-DD' 라 UTC 자정으로 고정해 빼야 로컬 TZ 에서 하루가 밀리지 않는다.
const dayDiff = (a?: string | null, b?: string | null): number => {
  if (!a || !b) return 0;
  const ms = Date.parse(String(b) + "T00:00:00Z") - Date.parse(String(a) + "T00:00:00Z");
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : 0;
};
async function propagateReschedule(id: number, before: any, after: any, writeCtx: any) {
  if (!before || !after) return [];
  const delta = dayDiff(before.due_date, after.due_date) || dayDiff(before.start_date, after.start_date);
  if (!delta) return [];
  return rescheduleDependents(id, delta, writeCtx);
}

const projectUpdateV6Input = {
  id: z.number().int().positive(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
  // append 모드 — 본문 끝에 이어붙일 텍스트(원문 보존, 빈 줄로 문단 구분). description(전체 교체)과 동시 지정 불가.
  append_description: z.string().min(1).max(4000)
    .describe("본문(description) 끝에 이어붙일 텍스트. 원문을 보존한 채 빈 줄로 구분해 append 한다(전체 교체 없이 보강). description 과 동시 지정 불가.")
    .optional(),
  priority: z.enum(PRIORITIES).nullable().optional(),
  assignee: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  // #1308 — 날짜가 움직였으면 depends_on 후행 체인도 같은 Δ 로 민다. 명시 opt-in(간트가 켠다).
  reschedule_dependents: z.boolean().optional(),
};
type ProjectUpdateV6Input = z.infer<z.ZodObject<typeof projectUpdateV6Input>>;
const projectUpdateV6: Capability = {
  name: "project_update_v6",
  title: "프로젝트 수정(v6)",
  description: "프로젝트 이름·설명 등을 수정한다. 주어진 키만 변경. 본문은 description(전체 교체) 또는 append_description(원문 보존·끝에 이어쓰기) 중 하나로.",
  scope: "memory",
  input: projectUpdateV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = { id: parseId(req.params?.id) };
        if ("name" in b) {
          const name = String(b.name ?? "").trim();
          if (!name) throw new HttpError(400, "이름은 비울 수 없습니다");
          patch.name = name;
        }
        if ("description" in b) patch.description = b.description == null ? null : String(b.description);
        if ("append_description" in b) patch.append_description = String(b.append_description ?? "");
        if ("priority" in b) patch.priority = parsePriorityOrNull(b.priority);
        if ("assignee" in b) patch.assignee = parseAssigneeOrNull(b.assignee);
        if ("start_date" in b) patch.start_date = parseDateOrNull(b.start_date);
        if ("due_date" in b) patch.due_date = parseDateOrNull(b.due_date);
        if (b.reschedule_dependents === true) patch.reschedule_dependents = true;
        return patch;
      } }],
  },
  handler: async (input: ProjectUpdateV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertProjectVisible(input.id, ctx, "프로젝트");
    const { id, reschedule_dependents, ...patch } = input;
    // 본문은 교체(description)와 이어쓰기(append_description) 중 하나만 — 함께 오면 의도 모호(교체 후 append?)라 거부.
    if (patch.description !== undefined && patch.append_description !== undefined)
      throw new HttpError(400, "description(전체 교체)과 append_description(이어쓰기)은 함께 쓸 수 없습니다");
    if (patch.append_description !== undefined && !String(patch.append_description).trim())
      throw new HttpError(400, "append_description 는 비울 수 없습니다");
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    // Δ 를 재려면 **바뀌기 전** 날짜가 필요하다 — updateProject 는 이전 행을 돌려주지 않는다(#1308).
    const before = reschedule_dependents ? await getNodeRow(id) : null;
    const project = await updateProject(id, patch, writeCtx);
    const rescheduled = before ? await propagateReschedule(id, before, project, writeCtx) : [];
    await regenAgents(id);
    return { project, rescheduled };
  },
};

// 관련 레포 설정(전체 교체) — repo 레지스트리 이름 배열. AGENTS.md '관련 레포' + '내 컴퓨터에서 작업' 모달 기본값.
const projectSetReposV6Input = { id: z.number().int().positive(), repos: z.array(z.string()).max(50) };
type ProjectSetReposV6Input = z.infer<z.ZodObject<typeof projectSetReposV6Input>>;
const projectSetReposV6: Capability = {
  name: "project_set_repos_v6",
  title: "프로젝트 관련 레포 설정(v6)",
  description: "프로젝트의 관련 레포(코드 레포 이름 배열)를 설정한다(전체 교체). repo 레지스트리(관리탭 ▸ 레포 관리) 이름 참조. 웹 전용.",
  scope: "memory",
  input: projectSetReposV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/repos"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const repos = Array.isArray(b.repos) ? b.repos.map((x: unknown) => String(x)) : [];
        return { id: parseId(req.params?.id), repos };
      } }],
  },
  handler: async (input: ProjectSetReposV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertProjectVisible(input.id, ctx, "프로젝트");
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    const repos = await setProjectRepos(input.id, input.repos, writeCtx);
    await regenAgents(input.id);
    return { repos };
  },
};

// 카테고리 설정 — 이제 **소속 리스트의 카테고리(도메인)**를 정한다(#541 후속). 카테고리는 리스트 소유·프로젝트 상속(단일).
const projectSetCategoriesV6Input = { id: z.number().int().positive(), categoryIds: z.array(z.number().int().positive()).max(50) };
type ProjectSetCategoriesV6Input = z.infer<z.ZodObject<typeof projectSetCategoriesV6Input>>;
const projectSetCategoriesV6: Capability = {
  name: "project_set_categories_v6",
  title: "프로젝트 카테고리 설정(v6)",
  description: "프로젝트가 **속한 리스트의 카테고리(도메인, 사업/제품/시스템)**를 설정한다 — 카테고리는 리스트가 소유하고 소속 프로젝트가 상속(단일). categoryIds 는 하위호환 배열이나 첫 항목만 반영, 빈 배열=해제. 형제 프로젝트가 카테고리를 공유하게 된다. 미분류(리스트 없는) 프로젝트엔 no-op — 먼저 리스트에 넣어야 함. category_list 의 id 참조.",
  scope: "memory",
  input: projectSetCategoriesV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/categories"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const categoryIds = Array.isArray(b.category_ids) ? b.category_ids.map((x: unknown) => Number(x)).filter((n) => Number.isInteger(n) && n > 0) : [];
        return { id: parseId(req.params?.id), categoryIds };
      } }],
  },
  handler: async (input: ProjectSetCategoriesV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertProjectVisible(input.id, ctx, "프로젝트");
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    const categoryIds = await setProjectCategories(input.id, input.categoryIds, writeCtx);
    await regenAgentsForList(await listIdOfProject(input.id)); // 형제 전부 상속 반영(F4)
    return { categoryIds };
  },
};

const projectDeleteV6Input = { id: z.number().int().positive() };
type ProjectDeleteV6Input = z.infer<z.ZodObject<typeof projectDeleteV6Input>>;
const projectDeleteV6: Capability = {
  name: "project_delete_v6",
  title: "프로젝트 삭제(v6)",
  description: "프로젝트를 삭제한다(작성자 본인만). 자식 작업·팀원·카테고리/지식 연결은 FK CASCADE 로 정리되고, 작업 이벤트(activity)는 링크만 해제(SET NULL)된다. 진행중/완료 상태 무관. 웹 전용.",
  scope: "memory",
  input: projectDeleteV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/delete"],
      parse: (req) => ({ id: parseId(req.params?.id) }) }],
  },
  handler: async (input: ProjectDeleteV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertProjectVisible(input.id, ctx, "프로젝트");
    const actor = ctx?.actor ?? user?.userId ?? null;
    const before = await getProjectRow(input.id);
    if (!before) throw new HttpError(404, `프로젝트 #${input.id} 없음`);
    // 삭제 전원 개방(#280) — 인증만 요구(작성자 제한 해제, 채널·토큰 무관). 삭제는 감사로그 기반으로 #/trash 에서 복원 가능.
    if (!actor) throw new HttpError(401, "로그인이 필요합니다");
    await deleteProject(input.id, { actor, source: ctx?.source ?? "web" });
    return { deleted: true, id: input.id };
  },
};

const projectSetMembersV6Input = { id: z.number().int().positive(), members: z.array(z.string()).default([]) };
type ProjectSetMembersV6Input = z.infer<z.ZodObject<typeof projectSetMembersV6Input>>;
const projectSetMembersV6: Capability = {
  name: "project_set_members_v6",
  title: "프로젝트 팀원 변경(v6)",
  description: "프로젝트 팀원(project_member)을 member_id 배열로 통째 교체. 웹 전용.",
  scope: "memory",
  input: projectSetMembersV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/members"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return {
          id: parseId(req.params?.id),
          members: Array.isArray(b.members) ? b.members.map((x: unknown) => String(x)) : [],
        };
      } }],
  },
  handler: async (input: ProjectSetMembersV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertProjectVisible(input.id, ctx, "프로젝트");
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    const member_ids = await setProjectMembers(input.id, input.members, writeCtx);
    await regenAgents(input.id);
    return { member_ids };
  },
};

// 내 상태 메시지(이 프로젝트 한정) — (프로젝트,사람) 단위. 다른 프로젝트엔 안 보임.
// #1232 대시보드 '내 할 일' — 내가 담당인 미완료 태스크를 프로젝트 가로질러 마감 임박순으로.
//  프로젝트 보드의 '내 할당만' 필터는 이미 보고 있는 프로젝트를 거르는 축이라, "내 일 전부"를 볼 표면이 없었다.
//  MCP 미노출 — 에이전트는 project_list_v6{mine} + project_get_v6 로 충분하고, 툴 표면을 늘리지 않는다(review_queue_summary 와 같은 판단).
const myTasksV6Input = { limit: z.number().int().positive().optional() };
type MyTasksV6Input = z.infer<z.ZodObject<typeof myTasksV6Input>>;
const myTasksV6: Capability = {
  name: "my_tasks_v6",
  title: "내 할 일(v6)",
  description: "내가 담당인 미완료 태스크/서브태스크를 프로젝트 가로질러 조회 — 마감 임박순, 소속 프로젝트 이름 포함. 대시보드 위젯 전용.",
  scope: "memory",
  input: myTasksV6Input,
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/v6/my-tasks"],
      parse: (req) => ({ limit: req.query?.limit ? Number(req.query.limit) : undefined }) }],
  },
  // input 스키마가 비어 있고 REST parse 는 limit 을 싣는다 — mcp:false 라 **정상**이다(#1403): input 은 MCP 전용
  //  표면이고(types.ts), REST 는 mount.parse 가 검증한다. isToolExposed 가 expose.mcp:false 를 org_tool override
  //  로도 못 켜게 fail-closed 로 막으므로 zod 를 태우는 경로 자체가 없다. mcp:true 로 바꾸는 순간 #923 R1 이 red.
  handler: async (input: MyTasksV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    const me = ctx?.actor ?? user?.userId ?? null;
    if (!me) throw new HttpError(401, "로그인이 필요합니다");
    return { tasks: await listMyTasks(String(me), Number(input.limit) || 200, ctx?.viewer ?? null) };
  },
};

// ── 하위 작업 벌크 조회(#1305) — 타임라인(간트)이 프로젝트▸태스크▸서브태스크 계층을 그리는 유일한 경로. ──
//  프로젝트마다 /projects/:id(상세)를 부르면 화면 하나에 수백 요청이 나간다(그 응답엔 간트가 안 쓰는 팀원·지식·
//  엣지·첨부까지 들어 있다). 여기서는 id 목록을 한 번에 받아 간트가 쓰는 컬럼만 돌려준다. REST-only —
//  MCP 쪽은 project_get_v6(프로젝트 1건 전체)가 이미 담당한다.
const projectTasksV6Input = { ids: z.array(z.number().int().positive()).min(1).max(500) };
type ProjectTasksV6Input = z.infer<z.ZodObject<typeof projectTasksV6Input>>;
const projectTasksV6: Capability = {
  name: "project_tasks_v6",
  title: "프로젝트 하위 작업 벌크 조회(v6)",
  description: "여러 프로젝트의 하위 작업(task/subtask)을 한 번에 조회. 타임라인(간트) 계층 렌더 전용 — 프로젝트마다 상세를 부르는 N+1 을 대체한다.",
  scope: "memory",
  input: projectTasksV6Input,
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/v6/project-tasks"],
      parse: (req) => {
        const ids = String((req.query ?? ({} as any)).ids ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => parseId(s));
        // ⚠ `.map(parseId)` 로 쓰지 말 것(#1313 R46) — 공용 parseId 는 2번째 인자가 문구용 name 이라
        //  Array#map 의 index 가 그대로 들어가 "0 가 올바르지 않습니다" 처럼 문구가 바뀐다.
        if (!ids.length) throw new HttpError(400, "ids 가 필요합니다");
        return { ids: [...new Set(ids)].slice(0, 500) };
      } }],
  },
  //  #1308 — 의존선(depends_on)도 같은 응답에 싣는다. 타임라인은 어차피 이 한 번의 요청으로 화면을 채우고,
  //   엣지는 프로젝트·태스크 어느 층에나 걸릴 수 있어 노드 집합이 확정된 여기서 한 번에 거르는 게 정확하다.
  handler: async (input: ProjectTasksV6Input, _user: LivelyUser, ctx?: CapabilityCtx) => {
    const viewer = ctx?.viewer ?? null;
    const tasks = await listTasksForProjects(input.ids, viewer);
    const nodeIds = [...input.ids, ...tasks.map((t: any) => Number(t.id))];
    return { tasks, edges: await listEdgesForNodes(nodeIds, viewer) };
  },
};

const projectMyStatusV6Input = { id: z.number().int().positive(), message: z.string().max(200).optional() };
type ProjectMyStatusV6Input = z.infer<z.ZodObject<typeof projectMyStatusV6Input>>;
const projectMyStatusV6: Capability = {
  name: "project_my_status_v6",
  title: "내 상태 메시지(프로젝트별, v6)",
  description: "이 프로젝트에서의 내 상태 메시지를 저장(project_member.status_message). (프로젝트,사람) 단위 — 다른 프로젝트엔 영향 없음. 웹 전용.",
  scope: "memory",
  input: projectMyStatusV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/my-status"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { id: parseId(req.params?.id), message: b.message != null ? String(b.message) : "" };
      } }],
  },
  handler: async (input: ProjectMyStatusV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    const me = ctx?.actor ?? user?.userId ?? null;
    if (!me) throw new HttpError(401, "로그인이 필요합니다");
    if (!(await isProjectMember(input.id, me))) throw new HttpError(403, "이 프로젝트의 팀원만 상태를 남길 수 있습니다");
    // message 생략(MCP 는 optional → undefined)은 빈 문자열과 같은 뜻 = 상태 해제다. REST parse 는 늘 ""로 채워
    //  보내므로 두 표면이 같은 지점으로 수렴한다(store 도 `message ?? ''` 로 흡수). 캐스팅 대신 여기서 정규화한다.
    return { status_message: await setProjectMemberStatus(input.id, me, input.message ?? null) };
  },
};

// 핸들러가 읽는 이름(REST 는 :id 경로 + body 'category_id'→categoryId 매핑).
const projectLinkCategoryV6Input = {
  id: z.number().int().positive(),
  categoryId: z.number().int().positive(),
  unlink: z.boolean().optional(),
};
type ProjectLinkCategoryV6Input = z.infer<z.ZodObject<typeof projectLinkCategoryV6Input>>;
const projectLinkCategoryV6: Capability = {
  name: "project_link_category_v6",
  title: "프로젝트↔카테고리(v6)",
  description: "프로젝트를 카테고리에 연결(또는 unlink=true 로 해제). 웹 전용.",
  scope: "memory",
  input: projectLinkCategoryV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/category"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const categoryId = Number(b.category_id);
        if (!Number.isInteger(categoryId) || categoryId <= 0) throw new HttpError(400, "category_id 가 필요합니다");
        return { id: parseId(req.params?.id), categoryId, unlink: b.unlink === true };
      } }],
  },
  handler: async (input: ProjectLinkCategoryV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    if (input.unlink) { const r = await unlinkProjectCategory(input.id, input.categoryId, writeCtx); await regenAgentsForList(r.listId); return { unlinked: true }; }
    const r = await linkProjectCategory(input.id, input.categoryId, writeCtx);
    await regenAgentsForList(r.listId); // 형제 전부 상속 반영(F4)
    return { linked: true };
  },
};

const projectLinkKnowledgeV6Input = {
  id: z.number().int().positive(),
  name: z.string().min(1).max(64),
  relation: z.enum(RELATIONS),
  unlink: z.boolean().optional(),
};
type ProjectLinkKnowledgeV6Input = z.infer<z.ZodObject<typeof projectLinkKnowledgeV6Input>>;
const projectLinkKnowledgeV6: Capability = {
  name: "project_link_knowledge_v6",
  title: "프로젝트↔지식(v6)",
  description: "프로젝트의 필요(required)/산출(produced) 지식을 연결(또는 unlink=true 로 해제). 웹 전용.",
  scope: "memory",
  input: projectLinkKnowledgeV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/knowledge"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const name = String(b.name ?? "").trim();
        if (!name) throw new HttpError(400, "name 이 필요합니다");
        return { id: parseId(req.params?.id), name, relation: parseRelation(b.relation), unlink: b.unlink === true };
      } }],
  },
  handler: async (input: ProjectLinkKnowledgeV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertProjectVisible(input.id, ctx, "프로젝트");
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    if (input.unlink) { await unlinkProjectKnowledge(input.id, input.name, input.relation, writeCtx); await regenAgents(input.id); return { unlinked: true }; }
    await linkProjectKnowledge(input.id, input.name, input.relation, writeCtx);
    await regenAgents(input.id);  // 필요지식 섹션이 AGENTS.md 에 반영되도록 재생성(#317).
    return { linked: true };
  },
};

// 필요지식 추천(벡터검색 #172) — 프로젝트 이름·설명과 의미적으로 가까운 지식을 코사인 유사도로 추천. 이미 연결된 건 제외.
//  웹 '✨ 자동으로 고르기' + 에이전트(프로젝트 셋업 시 필요지식 후보). 추천을 project_link_knowledge_v6(required)로 연결.
const projectRecommendKnowledgeV6Input = {
  id: z.number().int().positive(),
  limit: z.number().int().min(1).max(50).optional(),
  min_score: z.number().min(0).max(1).optional(),
};
type ProjectRecommendKnowledgeV6Input = z.infer<z.ZodObject<typeof projectRecommendKnowledgeV6Input>>;
const projectRecommendKnowledgeV6: Capability = {
  name: "project_recommend_knowledge_v6",
  title: "프로젝트 필요지식 추천(v6)",
  description:
    "프로젝트 이름·설명과 **의미적으로 가까운 지식** + **프로젝트와 같은 카테고리 지식(가산점·구제)** 을 함께 추천한다(벡터검색 #172). 이미 연결된 지식은 제외. " +
    "각 항목은 similarity(코사인 0~1)·shares_category(같은 분류 여부)·score(정렬값)를 갖는다. 추천을 project_link_knowledge_v6(relation=required)로 연결하면 된다. " +
    "**임베딩이 꺼져 있어도 카테고리만으로 추천**(graceful); 설명·카테고리 둘 다 없으면 빈 결과. min_score(기본 0.4)는 벡터 임계(같은 카테고리는 미달도 포함), 관련도 내림차순.",
  scope: "memory",
  input: projectRecommendKnowledgeV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/v6/projects/:id/recommend-knowledge"],
      parse: (req) => {
        const query = (req.query ?? {}) as Record<string, unknown>;
        return {
          id: parseId(req.params?.id),
          limit: query.limit ? Number(query.limit) : undefined,
          min_score: query.min_score != null && query.min_score !== "" ? Number(query.min_score) : undefined,
        };
      } }],
  },
  handler: async (input: ProjectRecommendKnowledgeV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    // 열람 전원 개방(#280) — 상세 페이지와 동일(구 팀원-only 403 제거).
    return { entries: await recommendKnowledgeForProject(input.id, { limit: input.limit, minScore: input.min_score, viewer: ctx?.viewer ?? null }) };
  },
};

// 역방향 — 이 지식이 연결된 프로젝트(필요/산출). 위키 상세 '연결된 프로젝트' 표시·관리(GET /api/ui/knowledge/:name/projects).
const knowledgeProjectsV6Input = { name: z.string().min(1).max(64) };
type KnowledgeProjectsV6Input = z.infer<z.ZodObject<typeof knowledgeProjectsV6Input>>;
const knowledgeProjectsV6: Capability = {
  name: "knowledge_projects_v6",
  title: "지식↔프로젝트 역조회(v6)",
  description: "이 지식을 필요(required)/산출(produced)로 연결한 프로젝트 목록(project_id·project_name·status·relation). 위키 상세 '연결된 프로젝트' 표시용.",
  scope: "memory",
  input: knowledgeProjectsV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/knowledge/:name/projects"],
      parse: (req) => {
        const name = decodeURIComponent(String(req.params?.name ?? "")).trim();
        if (!name) throw new HttpError(400, "name 이 필요합니다");
        return { name };
      } }],
  },
  handler: async (input: KnowledgeProjectsV6Input) => ({ projects: await projectsForKnowledge(input.name) }),
};

// ── 작업(task/subtask) — :id 는 프로젝트. parent_task_id 주면 하위작업(subtask). ──
// 핸들러가 읽는 이름(REST 는 :id→projectId, body 'parent_task_id'→parentTaskId 매핑).
const taskCreateV6Input = {
  projectId: z.number().int().positive(),
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  parentTaskId: z.number().int().positive().optional(),
};
type TaskCreateV6Input = z.infer<z.ZodObject<typeof taskCreateV6Input>>;
const taskCreateV6: Capability = {
  name: "task_create_v6",
  title: "작업 생성(v6)",
  description: "프로젝트에 작업(task)을 만든다. parentTaskId 를 주면 하위작업(subtask). 웹 전용.",
  scope: "memory",
  input: taskCreateV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/tasks"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const name = String(b.name ?? "").trim();
        if (!name) throw new HttpError(400, "name 이 필요합니다");
        return {
          projectId: parseId(req.params?.id),
          name,
          description: b.description ? String(b.description) : undefined,
          parentTaskId: b.parent_task_id != null && b.parent_task_id !== "" ? parseId(b.parent_task_id) : undefined,
        };
      } }],
  },
  handler: async (input: TaskCreateV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    // 부모가 안 보이면 그 밑에 태스크를 만들 수도 없다(#1291).
    //  ⚠ parentTaskId 를 먼저 본다 — createTask 는 그게 있으면 **그것만으로** 부모를 해소하고 projectId 는 무시한다.
    //   projectId 만 검사하면 "보이는 프로젝트 id + 안 보이는 부모 태스크" 조합으로 남의 프로젝트에 글을 심을 수 있다.
    await assertProjectVisible(input.parentTaskId ?? input.projectId, ctx);
    const task = await createTask(input, writeCtx);
    const rootId = await rootProjectIdOfTaskNode(task); // 하위태스크면 부모 task→프로젝트로 거슬러 해석.
    if (rootId) await regenAgents(rootId);              // 태스크/하위태스크 추가 → AGENTS.md 태스크 인덱스 갱신.
    // prior-art 앞단 표면화(#639) — task 이름+설명(의미) + 부모 프로젝트 카테고리(상속)로 기존 지식을 응답에.
    const prior_art = await recommendKnowledgeForProject(task.id, { limit: 5, minScore: 0.55 }).catch(() => []);
    return prior_art.length ? { task, prior_art, prior_art_note: PRIOR_ART_NOTE } : { task };
  },
};

const taskSetStatusV6Input = { id: z.number().int().positive(), status: z.enum(STATUSES) };
type TaskSetStatusV6Input = z.infer<z.ZodObject<typeof taskSetStatusV6Input>>;
const taskSetStatusV6: Capability = {
  name: "task_set_status_v6",
  title: "작업 상태 변경(v6)",
  description: "작업(task/subtask)을 진행중(active)↔완료(done)로 토글. 완료 시 완료시각 기록. 웹 전용.",
  scope: "memory",
  input: taskSetStatusV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/tasks/:id/status"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { id: parseId(req.params?.id), status: parseStatus(b.status) };
      } }],
  },
  handler: async (input: TaskSetStatusV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertProjectVisible(input.id, ctx, "태스크");
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    const task = await updateTaskStatus(input.id, input.status, writeCtx);
    const rootId = await rootProjectIdOfTaskNode(task);
    if (rootId) await regenAgents(rootId);  // 상태 변경 → AGENTS.md 태스크 인덱스 상태 갱신.
    return { task };
  },
};

// ── 작업 필드 패치 — 상태(다단계)·우선순위·담당자·기간·이름·설명. 리스트뷰 인라인 편집의 단일 엔드포인트. ──
//  패치 시맨틱: body 에 있는 키만 변경(부재=무변경, null/빈값=해제). status 전용 /tasks/:id/status(active|done,
//  MCP·미러용)와 병존 — 새 웹 UI 는 상태도 이 엔드포인트(todo|in_progress|done)로 보낸다. REST-only(mcp:false).
const taskUpdateV6Input = {
  id: z.number().int().positive(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
  // append 모드 — 본문 끝에 이어붙일 텍스트(원문 보존, 빈 줄로 문단 구분). description(전체 교체)과 동시 지정 불가.
  append_description: z.string().min(1).max(4000)
    .describe("본문(description) 끝에 이어붙일 텍스트. 원문을 보존한 채 빈 줄로 구분해 append 한다(전체 교체 없이 보강). description 과 동시 지정 불가.")
    .optional(),
  status: z.enum(TASK_STATUSES).optional(),
  // #731 리스트별 커스텀 상태 키(개방 어휘, null=해제) — 태스크도 프로젝트처럼 커스텀 상태 저장. status(네이티브 투영)와 함께 온다.
  status_raw: z.string().max(120).nullable().optional(),
  priority: z.enum(PRIORITIES).nullable().optional(),
  assignee: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  // #1308 — 날짜가 움직였으면 depends_on 후행 체인도 같은 Δ 로 민다. 명시 opt-in(간트가 켠다).
  reschedule_dependents: z.boolean().optional(),
};
type TaskUpdateV6Input = z.infer<z.ZodObject<typeof taskUpdateV6Input>>;
const taskUpdateV6: Capability = {
  name: "task_update_v6",
  title: "작업 필드 수정(v6)",
  description: "작업(task/subtask)의 상태·우선순위·담당자·기간·이름·설명을 패치. 주어진 키만 변경. 본문은 description(전체 교체) 또는 append_description(원문 보존·끝에 이어쓰기) 중 하나로.",
  scope: "memory",
  input: taskUpdateV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/tasks/:id"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = { id: parseId(req.params?.id) };
        if ("name" in b) {
          const name = String(b.name ?? "").trim();
          if (!name) throw new HttpError(400, "name 은 비울 수 없습니다");
          patch.name = name;
        }
        if ("description" in b) patch.description = b.description == null ? null : String(b.description);
        if ("append_description" in b) patch.append_description = String(b.append_description ?? "");
        if ("status" in b) patch.status = parseTaskStatus(b.status);
        if ("status_raw" in b) { const rw = b.status_raw; patch.status_raw = (rw == null || rw === "") ? null : String(rw).trim().slice(0, 120); }
        if ("priority" in b) patch.priority = parsePriorityOrNull(b.priority);
        if ("assignee" in b) patch.assignee = parseAssigneeOrNull(b.assignee);
        if ("start_date" in b) patch.start_date = parseDateOrNull(b.start_date);
        if ("due_date" in b) patch.due_date = parseDateOrNull(b.due_date);
        if (b.reschedule_dependents === true) patch.reschedule_dependents = true;
        return patch;
      } }],
  },
  handler: async (input: TaskUpdateV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertProjectVisible(input.id, ctx, "태스크");
    const { id, reschedule_dependents, ...patch } = input;
    // 본문은 교체(description)와 이어쓰기(append_description) 중 하나만 — 함께 오면 의도 모호(교체 후 append?)라 거부.
    if (patch.description !== undefined && patch.append_description !== undefined)
      throw new HttpError(400, "description(전체 교체)과 append_description(이어쓰기)은 함께 쓸 수 없습니다");
    if (patch.append_description !== undefined && !String(patch.append_description).trim())
      throw new HttpError(400, "append_description 는 비울 수 없습니다");
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    // Δ 를 재려면 **바뀌기 전** 날짜가 필요하다 — updateTask 는 이전 행을 돌려주지 않는다(#1308).
    const before = reschedule_dependents ? await getNodeRow(id) : null;
    const task = await updateTask(id, patch, writeCtx);
    const rescheduled = before ? await propagateReschedule(id, before, task, writeCtx) : [];
    const rootId = await rootProjectIdOfTaskNode(task);
    if (rootId) await regenAgents(rootId);  // 이름/상태 등 변경 → AGENTS.md 태스크 인덱스 갱신.
    return { task, rescheduled };
  },
};

// ── 작업 재정렬(#366) — 형제 작업(task/subtask)의 표시 순서를 주어진 id 배열 순서대로 저장(sort 재부여). 목록 드래그 재정렬용. ──
//  REST-only(웹 드래그 전용). 인증 사용자면 가능(task_update_v6 와 동형 scope).
const taskReorderV6Input = { ids: z.array(z.number().int().positive()).min(2).max(500) };
type TaskReorderV6Input = z.infer<z.ZodObject<typeof taskReorderV6Input>>;
const taskReorderV6: Capability = {
  name: "task_reorder_v6",
  title: "작업 순서 변경(v6)",
  description: "형제 작업(task/subtask)의 표시 순서를 주어진 id 배열 순서대로 저장한다(sort 를 0,1,2… 로 재부여). 목록 드래그 재정렬용.",
  scope: "memory",
  input: taskReorderV6Input,
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/v6/tasks-reorder"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const ids = Array.isArray(b.ids) ? b.ids.map((x) => parseId(x)) : [];
        if (ids.length < 2) throw new HttpError(400, "ids 는 2개 이상이어야 합니다");
        return { ids };
      } }],
  },
  handler: async (input: TaskReorderV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    // 이 capability 의 입력은 id 가 아니라 ids 배열이다 — 재정렬 대상 **전부**를 본다.
    //  최대 500개라 단건 헬퍼를 반복 호출하면 그만큼 조회가 나간다 → 가시 집합을 한 번 뽑아 대조한다.
    if (ctx?.viewer != null) {
      const visIds = await visibleListIds(ctx.viewer);
      for (const id of (input.ids ?? [])) {
        const listId = await projectRowListId(Number(id));
        if (listId != null && visIds && !visIds.has(listId)) throw new HttpError(404, `태스크 #${id} 없음`);
      }
    }
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return await reorderTasks(input.ids, writeCtx);
  },
};

// ── 프로젝트 행 재정렬(#541 수동 정렬) — 그룹 내 드래그가 화면 순서(형제 프로젝트 id 배열)를 저장. task_reorder_v6 동형. ──
const projectReorderV6Input = { ids: z.array(z.number().int().positive()).min(2).max(1000) };
type ProjectReorderV6Input = z.infer<z.ZodObject<typeof projectReorderV6Input>>;
const projectReorderV6: Capability = {
  name: "project_reorder_v6",
  title: "프로젝트 순서 변경(v6)",
  description: "프로젝트 행의 표시 순서를 주어진 id 배열 순서대로 저장한다(sort 를 1,2,… 로 재부여). 보드 그룹 내 드래그 재정렬용.",
  scope: "memory",
  input: projectReorderV6Input,
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects-reorder"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const ids = Array.isArray(b.ids) ? b.ids.map((x) => parseId(x)) : [];
        if (ids.length < 2) throw new HttpError(400, "ids 는 2개 이상이어야 합니다");
        return { ids };
      } }],
  },
  handler: async (input: ProjectReorderV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return await reorderProjects(input.ids, writeCtx);
  },
};

// ── 작업 삭제 — task/subtask 삭제(삭제+감사 스냅샷 → #/trash 복원). 하위·태그·체크리스트·의존성은 FK CASCADE 정리. ──
//  소유권 게이트는 task_update_v6 와 동형(인증 사용자=가능). REST-only. status 전용 엔드포인트와 경로 충돌 없음(/delete 접미).
const taskDeleteV6Input = { id: z.number().int().positive() };
type TaskDeleteV6Input = z.infer<z.ZodObject<typeof taskDeleteV6Input>>;
const taskDeleteV6: Capability = {
  name: "task_delete_v6",
  title: "작업 삭제(v6)",
  description: "작업(task/subtask)을 삭제한다. 하위·태그·체크리스트·의존성은 FK CASCADE 로 정리되고, 감사 스냅샷으로 #/trash 에서 본체를 복원할 수 있다.",
  scope: "memory",
  input: taskDeleteV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/tasks/:id/delete"],
      parse: (req) => ({ id: parseId(req.params?.id) }) }],
  },
  handler: async (input: TaskDeleteV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    await assertProjectVisible(input.id, ctx, "태스크");
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    const task = await deleteTaskNode(input.id, writeCtx); // 반환 = 삭제 전 스냅샷(level/parent_id 보유).
    const rootId = await rootProjectIdOfTaskNode(task);
    if (rootId) await regenAgents(rootId);  // 삭제 → AGENTS.md 태스크 인덱스에서 제거.
    return { deleted: true, id: input.id, task };
  },
};

// ── 보드(프로젝트 목록) 커스텀 컬럼 — 정의(숨김 앵커의 task_field) + 프로젝트별 값. GET 전용, 웹 보드가 머지. ──
const boardFieldsV6: Capability = {
  name: "board_fields_v6",
  title: "보드 커스텀 컬럼(v6)",
  description: "프로젝트 목록(보드)의 커스텀 컬럼 정의와 프로젝트별 값을 돌려준다. 웹 전용.",
  scope: "memory",
  input: {},
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/v6/board-fields"], parse: () => ({}) }],
  },
  handler: async () => await getBoardFields(),
};

// ── 프로젝트↔프로젝트 엣지 — from(:id) --relation--> to. follow_up: from 이 to 의 후속(from=후속, to=선행). 단건 link/unlink 토글. ──
const projectLinkProjectV6Input = {
  id: z.number().int().positive(),
  to: z.number().int().positive(),
  relation: z.enum(EDGE_RELATIONS).optional(),
  unlink: z.boolean().optional(),
};
type ProjectLinkProjectV6Input = z.infer<z.ZodObject<typeof projectLinkProjectV6Input>>;
const projectLinkProjectV6: Capability = {
  name: "project_link_project_v6",
  title: "프로젝트↔프로젝트(v6)",
  description: "프로젝트·작업 노드끼리 연결(또는 unlink=true 로 해제) — from(:id) --relation--> to. relation=follow_up(기본; from 이 to 의 후속)|supersedes|depends_on|related. project_get_v6 의 edges(outgoing=선행/incoming=후속)로 양방향 조회. 예) 새 후속 프로젝트 #B 가 #A 를 잇는다 → project_link_project_v6(id=B, to=A). ⚠ 끝점은 프로젝트뿐 아니라 **태스크·서브태스크 id 도 된다**(#1308 — 타임라인 의존선이 depends_on 을 태스크 간에 건다). depends_on 은 'from 이 to 에 의존' = to 가 선행·from 이 후행이며, 간트의 자동 재스케줄이 이 방향을 따른다.",
  scope: "memory",
  input: projectLinkProjectV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/link"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { id: parseId(req.params?.id), to: parseId(b.to), relation: parseEdgeRelation(b.relation), unlink: b.unlink === true };
      } }],
  },
  handler: async (input: ProjectLinkProjectV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    const relation = input.relation || "follow_up";
    if (input.id === input.to) throw new HttpError(400, "같은 프로젝트끼리는 연결할 수 없습니다");
    if (input.unlink) { await unlinkProjectEdge(input.id, input.to, relation, writeCtx); return { unlinked: true }; }
    // 양쪽 다 존재해야 — 없는 프로젝트면 FK 500 대신 깨끗한 400.
    //  ⚠ 가시성도 **양쪽 끝** 모두 본다(#1291): 한쪽만 보면 "내 프로젝트 → 잠긴 프로젝트" 엣지를 걸어 놓고
    //   내 프로젝트 상세의 edges 에서 상대 이름·상태를 읽는 우회로가 열린다. 안 보이는 쪽은 **없는 것과 같은 문구**로
    //   답해야 한다 — 메시지가 갈리면 그 자체가 존재 여부를 알려주는 신호가 된다.
    //  #1308 — 끝점은 레벨을 가리지 않는다(getProjectRow 는 level='project' 고정이라 태스크를 거부했다).
    //   의존(depends_on)은 태스크 간에도 걸리고, project_edge 의 FK 는 어차피 같은 project 테이블을 가리킨다.
    const [fromOk, toOk] = await Promise.all([getNodeRow(input.id), getNodeRow(input.to)]);
    if (!fromOk) throw new HttpError(400, `프로젝트 #${input.id} 가 없습니다`);
    if (!toOk) throw new HttpError(400, `대상 프로젝트 #${input.to} 가 없습니다`);
    if (ctx?.viewer != null) {
      if (!(await canSeeProjectRow(input.id, ctx.viewer))) throw new HttpError(400, `프로젝트 #${input.id} 가 없습니다`);
      if (!(await canSeeProjectRow(input.to, ctx.viewer))) throw new HttpError(400, `대상 프로젝트 #${input.to} 가 없습니다`);
    }
    await linkProjectEdge(input.id, input.to, relation, writeCtx);
    return { linked: true };
  },
};

// ── 워크스페이스 회수(#813 T3-2) — 프로젝트 마무리 시 '복구 가능한 것'만 되돌린다 ──
//
// 왜 도구인가(무인 데몬이 아니라): 되돌릴 수 없는 삭제를 자동 프로세스에 맡기지 않는다. **맥락을 아는 주체**
//  (프로젝트를 마무리하는 에이전트/사람)가 생애주기 경계에서 호출한다 — project-closeout 스킬의 한 스텝.
//  단 **삭제 규칙은 코드가 강제**한다(LLM 이 rm -rf 를 즉흥적으로 치는 것보다 안전): gitignored ∩ 알려진 파생물만,
//  시크릿·로컬데이터는 보호, 미푸시·더티·활성세션이면 거부. 자세한 근거는 src/ops/workspace-reclaim.ts 머리주석.
const workspaceReclaimInput = {
  project_id: z.number().int().positive().describe("v6 프로젝트 id"),
  apply: z.boolean().optional().describe("true 면 실제 삭제(기본 false = dry-run: 계획만 반환)"),
  remove_worktree: z.boolean().optional().describe("워크트리까지 제거(푸시 완료·클린일 때만 — 아니면 거부하고 이유 반환)"),
};
const workspaceReclaim: Capability = {
  name: "workspace_reclaim",
  title: "워크스페이스 정리 (프로젝트 마무리)",
  description:
    "프로젝트 폴더에서 **재생성 가능한 것만** 지운다 — 빌드 산출물·의존성(node_modules·build·target·.gradle·Pods…). " +
    "**기본은 dry-run**(아무것도 안 지우고 무엇을 지울지만 보고). apply=true 로 실제 실행. " +
    "remove_worktree=true 면 워크트리도 제거하되 **푸시 완료 + 미커밋 변경 없음**일 때만(아니면 이유를 말하고 거부). " +
    "활성 세션이 붙어 있으면 아무것도 하지 않는다. 시크릿(.env)·로컬 데이터(data/)·미분류 항목은 절대 지우지 않는다. " +
    "프로젝트 마무리(close-out) 루틴에서 호출한다 — 워크트리는 push 돼 있으면 provision 으로 언제든 복구된다.",
  scope: "memory",
  input: workspaceReclaimInput,
  expose: {
    mcp: true,
    rest: [{
      method: "POST",
      paths: ["/api/ui/v6/projects/:id/reclaim"],
      parse: (req) => ({ ...(req.body ?? {}), project_id: Number((req.params as Record<string, string>).id) }),
    }],
  },
  handler: async (input: { project_id: number; apply?: boolean; remove_worktree?: boolean }, user, ctx?: CapabilityCtx) => {
    const project = await getProject(input.project_id, ctx?.viewer ?? null);
    if (!project) throw new HttpError(404, "프로젝트를 찾을 수 없습니다");
    if (!project.folder) throw new HttpError(400, "이 프로젝트에는 워크스페이스 폴더가 없습니다(정리할 것이 없습니다)");
    const dir = projectAbsPath(project.folder); // project/<id> 또는 legacy-project/<id> 범위 밖이면 여기서 차단

    // 지금 살아있는 세션들의 작업 디렉터리 — 이 폴더 안에서 작업 중이면 회수를 통째로 막는다(빌드 중일 수 있다).
    let activeSessionDirs: string[] = [];
    try {
      activeSessionDirs = (await listSessions(user)).map((s) => s.dir).filter(Boolean) as string[];
    } catch { /* 세션 조회 실패 → 보수적으로 '활성 없음'이 아니라, 아래 planReclaim 이 못 막으므로 차단한다 */
      throw new HttpError(503, "세션 목록을 확인할 수 없어 정리를 중단합니다(작업 중인 세션을 덮어쓸 위험)");
    }

    // 프로젝트 폴더 안의 git 레포(워크트리)들을 각각 계획한다 — 한 프로젝트에 여러 레포가 붙을 수 있다.
    // ⚠ 레포가 없는 건 **에러가 아니라 '회수할 것이 없음'** 이다(#845). 레포를 provision 하지 않은 프로젝트 폴더는
    //  `.lively`·AGENTS.md 만 있는 12KB 껍데기이고, dev 박스 실측 307개 중 **184개**가 그랬다.
    //  예전엔 여기서 400 을 던져서 ① 관리탭이 정상 상태를 '실패'로 표시했고 ② 마무리 루틴이 레포 없는 프로젝트에서
    //  에러로 멈췄다. 회수할 게 없는 것과 회수에 실패한 것은 다르다.
    const repos = await reposIn(dir);
    const results = [];
    for (const wt of repos) {
      const plan = await planReclaim(wt, { activeSessionDirs });
      const applied = input.apply
        ? await applyReclaim(plan, { removeWorktree: !!input.remove_worktree, repoRoot: await baseRepoOf(wt) })
        : null;
      results.push({
        worktree: wt,
        // 무엇을 지울지/지웠는지 + 지우지 않은 것과 그 이유까지 그대로 보여준다(에이전트가 사용자에게 설명할 수 있게).
        reclaimable_bytes: plan.reclaimableBytes,
        derived: plan.entries.filter((e) => e.kind === "derived").map((e) => ({ path: e.rel, bytes: e.bytes })),
        unclassified: plan.entries.filter((e) => e.kind === "unclassified").map((e) => ({ path: e.rel, bytes: e.bytes })),
        protected_kept: plan.entries.filter((e) => e.kind === "protected").map((e) => e.rel),
        active_session: plan.active_session,
        worktree_removable: plan.worktree_check.removable,
        worktree_reason: plan.worktree_check.reason,
        applied,
      });
    }
    return {
      dry_run: !input.apply,
      project: { id: project.id, name: project.name, folder: project.folder },
      results,
      note: !repos.length
        ? "이 프로젝트 폴더에는 git 레포(워크트리)가 없어 정리할 파생물이 없습니다 — 정상입니다(레포를 provision 하지 않은 프로젝트)."
        : input.apply
          ? "정리 완료. 워크트리를 지웠다면 다시 필요할 때 provision(레포 클론/워크트리 생성)으로 복구된다."
          : "dry-run 입니다 — 아무것도 지우지 않았습니다. 실제로 정리하려면 apply=true 로 다시 호출하세요.",
    };
  },
};

// 폴더 싱크 모드 어휘 — DB CHECK(project_folder_binding_sync_chk)·마커·pull 훅과 같은 3값. REST parse 가 이걸로 막는다.
const FOLDER_SYNC_MODES: readonly string[] = ["none", "pull", "both"];

// ── #905 C2a — `project_init`(로컬 MCP 툴)이 필요로 하는 서버 이음매 2종. ──
//  왜 서버에 있나: init 은 멤버 머신에서 돌지만(로컬 git origin 을 읽고 로컬 마커를 써야 하므로),
//   "이 origin 을 쓰는 프로젝트가 이미 있나"·"내 폴더 위치를 중앙에 기록" 은 중앙만 안다.

// origin URL → 기존 프로젝트 후보. **판정하지 않는다 — 후보만 준다**(설계 §4-P2 ⑥: 애매하면 사람에게 묻기).
//  정규화(originKey)는 **여기 한 곳에만** 둔다 — 클라이언트가 자기 키를 만들어 보내면 두 구현이 갈리는 순간
//  같은 레포가 다른 키가 되어 중복 프로젝트가 생긴다. 클라이언트는 URL 만 보낸다(자격은 보내기 전에 벗긴다).
const projectFindByOriginV6Input = {
  git_url: z.string().min(1).max(500)
    .describe("레포의 origin URL(`git remote get-url origin`). 자격(토큰)이 박힌 URL 은 보내기 전에 벗길 것 — 키에는 어차피 안 들어간다."),
};
type ProjectFindByOriginV6Input = z.infer<z.ZodObject<typeof projectFindByOriginV6Input>>;
const projectFindByOriginV6: Capability = {
  name: "project_find_by_origin_v6",
  mutates: false, // 읽기전용(#1007): POST 지만 읽기 — git origin 으로 기존 프로젝트 후보 조회(생성 아님). project_init 판정에 쓰이므로 열어둔다.
  title: "git origin 으로 기존 프로젝트 찾기(v6)",
  description: "git origin URL 로 그 레포를 쓰는 **기존 프로젝트 후보**를 찾는다(크로스멤버 신원 — #905 P1-③). "
    + "프로토콜·자격·포트·.git 표기 차이를 흡수해 같은 레포면 같은 키로 본다. `project_init` 이 '새로 만들까 기존에 붙일까'를 "
    + "가르는 근거. **후보만 반환하고 판정은 하지 않는다** — 여럿이거나 애매하면 사람에게 물어라. "
    + "done 프로젝트도 후보에 포함하되 status 를 실어 주니 호출자가 거른다.",
  scope: "memory",
  input: projectFindByOriginV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/find-by-origin"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const gitUrl = String(b.git_url ?? "").trim();
        if (!gitUrl) throw new HttpError(400, "git_url 이 필요합니다");
        return { git_url: gitUrl };
      } }],
  },
  handler: async (input: ProjectFindByOriginV6Input) => {
    const key = originKey(input.git_url);
    if (!key) {
      // fail-closed — 해석 못 한 URL 로 남의 프로젝트에 붙이지 않는다. 후보 0 이 '새로 만들라'는 뜻은 아니다.
      return { origin_key: null, candidates: [], total: 0, active_total: 0, discriminating: false,
        note: "git origin URL 을 해석할 수 없습니다 — 이 신원으로는 기존 프로젝트를 찾을 수 없습니다(후보 없음 ≠ 새로 만들어도 됨)." };
    }
    const all = await findProjectsByOriginKey(key);
    const active = all.filter((c) => c.status !== "done");
    // ⚠ **origin 은 '멤버 간 합의 가능한 값'이지 '프로젝트를 특정하는 값'이 아니다** — 레포↔프로젝트는 N:M 이다.
    //  실측(2026-07-16, 라이블리 박스): `context-ontology` 한 레포에 프로젝트 156개(활성 37개)가 달려 있다(모노레포).
    //  그래서 활성 후보가 1개일 때만 '결정적'이라 말할 수 있고, 많으면 origin 은 **판별력이 없다**고 정직하게 알린다.
    //  (그 경우 후보 목록을 통째로 뱉으면 사람도 LLM 도 못 읽으므로 최근 갱신순으로 자른다 — 자른 사실을 명시한다.)
    const CAP = 20;
    const discriminating = active.length === 1;
    return {
      origin_key: key,
      total: all.length,
      active_total: active.length,
      discriminating,
      truncated: all.length > CAP,
      candidates: all.slice(0, CAP),
      note: !all.length
        ? "이 origin 을 쓰는 기존 프로젝트가 없습니다. 다만 **마커는 설계상 동기화되지 않으므로** '못 찾음'이 '없음'을 뜻하진 않습니다 — 애매하면 물어보세요."
        : discriminating
          ? "이 레포를 쓰는 진행 중 프로젝트가 정확히 1개입니다 — origin 이 판별력을 가진 경우입니다."
          : `이 레포를 ${all.length}개 프로젝트(진행 중 ${active.length}개)가 공유합니다 — **origin 으로는 어느 프로젝트인지 특정할 수 없습니다**(모노레포). `
            + "후보는 최근 갱신순 일부만 실었습니다. 반드시 사람에게 물어 고르게 하세요.",
    };
  },
};

// 폴더 바인딩 등록 — "이 프로젝트가 내 환경의 이 절대경로에 산다"(#905 P1-①).
//  member_id 는 **입력이 아니라 인증 주체**로 정한다 — 남의 이름으로 바인딩을 심지 못하게.
const projectBindFolderV6Input = {
  id: z.number().int().positive(),
  node_id: z.string().min(1).max(120).describe("환경 식별자 — 멤버 노트북은 호스트 슬러그, 게이트웨이 박스는 'central', 워커노드는 그 노드 id."),
  abs_path: z.string().min(1).max(1000).describe("그 환경에서의 절대경로."),
  sync: z.enum(["none", "pull", "both"]).optional().describe("공유폴더 동기화 모드(기본 none — 사용자 폴더 안전값)."),
  git_url: z.string().max(500).optional().describe("그 폴더의 git origin URL(선택) — 크로스멤버 신원 키로 정규화해 저장한다. 자격은 벗기고 보낼 것."),
};
type ProjectBindFolderV6Input = z.infer<z.ZodObject<typeof projectBindFolderV6Input>>;
const projectBindFolderV6: Capability = {
  name: "project_bind_folder_v6",
  title: "프로젝트 폴더 바인딩 등록(v6)",
  description: "이 프로젝트가 **내 환경의 어느 절대경로에 사는지** 중앙에 기록한다(1 프로젝트 × N 멤버 × N 환경 인벤토리). "
    + "`project_init` 이 로컬 마커를 심은 뒤 호출. 같은 (프로젝트·나·환경·경로)면 멱등 갱신. "
    + "sync 는 그 폴더의 공유폴더 동기화 모드 — **사용자 자기 폴더는 반드시 'none'**(서버 파일이 사용자 파일을 덮어쓰지 않게).",
  scope: "memory",
  input: projectBindFolderV6Input,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/v6/projects/:id/folder-binding"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        // ⚠ REST 는 zod input 을 안 태운다(parse 가 유일한 게이트) — 여기서 안 막으면 잘못된 값이 그대로 내려가
        //  DB CHECK 에서 터진다(400 이어야 할 게 500 + SQL 메시지 노출). 기존 parseProjectStatus 관례와 동형.
        const node_id = String(b.node_id ?? "").trim();
        if (!node_id) throw new HttpError(400, "node_id 가 필요합니다(환경 식별자 — 노트북은 호스트 슬러그, 박스는 'central')");
        const abs_path = String(b.abs_path ?? "").trim();
        if (!abs_path) throw new HttpError(400, "abs_path 가 필요합니다(그 환경에서의 절대경로)");
        let sync: string | undefined;
        if (b.sync != null && b.sync !== "") {
          sync = String(b.sync).trim();
          if (!FOLDER_SYNC_MODES.includes(sync)) throw new HttpError(400, "sync 는 none|pull|both 중 하나여야 합니다");
        }
        return { id: parseId(req.params?.id), node_id, abs_path, sync, git_url: b.git_url != null ? String(b.git_url) : undefined };
      } }],
  },
  handler: async (input: ProjectBindFolderV6Input, user: LivelyUser, ctx?: CapabilityCtx) => {
    if (!(await getProjectRow(input.id))) throw new HttpError(404, `프로젝트 #${input.id} 가 없습니다`);
    const me = ctx?.actor ?? user?.userId ?? null;
    if (!me) throw new HttpError(401, "바인딩은 인증된 멤버만 등록할 수 있습니다");
    await upsertProjectFolderBinding({
      projectId: input.id, memberId: me, nodeId: input.node_id, absPath: input.abs_path,
      sync: input.sync ?? "none",
      originKey: input.git_url ? originKey(input.git_url) : null,
    });
    return { bound: { project_id: input.id, member_id: me, node_id: input.node_id, abs_path: input.abs_path, sync: input.sync ?? "none" } };
  },
};

export const projectV6Capabilities: Capability[] = [
  workspaceReclaim,
  projectFindByOriginV6, projectBindFolderV6,
  // ⚠ 검색(정적 경로)은 projectGetV6(/projects/:id) '앞에' — Express first-match 가 :id 로 삼키지 않게(#631).
  myTasksV6,   // #1232 정적 경로(/v6/my-tasks) — /projects/:id 계열과 세그먼트가 달라 무충돌이지만 순서 규칙대로 앞에
  projectTasksV6, // #1305 정적 경로(/v6/project-tasks) — 위와 같은 이유로 앞에
  projectListV6, projectGrepV6, projectSearchV6, projectSimilarV6, projectGetV6, projectCreateV6, projectUpdateV6, projectSetReposV6, projectSetCategoriesV6, projectDeleteV6, projectSetStatusV6, projectArchiveV6, projectSetMembersV6,
  projectMyStatusV6,
  projectLinkCategoryV6, projectLinkKnowledgeV6, projectLinkProjectV6, projectRecommendKnowledgeV6, knowledgeProjectsV6, taskCreateV6, taskSetStatusV6, taskUpdateV6, taskReorderV6, projectReorderV6, taskDeleteV6, boardFieldsV6,
];
