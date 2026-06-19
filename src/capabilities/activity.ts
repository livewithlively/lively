// 작업(Activity) capability (P3) — activity_log(기록) + activity_list(조회). scope='memory'(공유 조직 작업,
//  memory_*/ctx_* 와 동일). 핸들러는 thin — 입력 파싱 후 domainmap/core/activity 의 store 호출.
//  author_person=ctx.actor(토큰 신원=누가), author_agent='어떤 AI'(호출자가 명시 — 모델/하네스 id). 사람×AI 집계의 축.
import { z } from "zod";
import { logActivity, listActivities } from "../domainmap/core/activity.js";
import type { Capability } from "./types.js";

const activityLog: Capability = {
  name: "activity_log",
  title: "작업(activity) 기록",
  description:
    "과업(W ku)을 향해 한 작업(activity)을 기록한다 — type=commit/comment/decision/status_change/review. " +
    "commit 유형은 commit_sha+touches(건드린 code_unit/data_entity)로 is(코드구조) 갱신 근거가 되고, 모든 유형은 " +
    "should(도메인 의도) 점검 대상이다(점검했으나 변화 없으면 should_review='checked_no_change'로 명시). " +
    "실질 지식(의사결정·산출물)은 ctx_save 로 ku 에 따로 쓰고 ku_refs(produced/decided/references)로 연결한다 — 작업은 진척만 얇게. " +
    "author_agent='어떤 AI'(모델/하네스 id), session_id=세션 — 사람×AI 작업현황 집계의 축. " +
    "external(system+id) 지정 시 멱등 upsert(PM 코멘트 라운드트립 재호출 안전).",
  scope: "memory",
  input: {
    type: z.enum(["commit", "comment", "decision", "status_change", "review"]).describe("작업 유형"),
    title: z.string().min(1).max(500).describe("한 줄 진척 요약(얇게 — 실질 내용은 ku_refs 로 참조)"),
    body: z.string().max(20000).optional().describe("짧은 메모(선택)"),
    task_ku_names: z.array(z.string()).optional().describe("이 작업이 속한 과업(W ku) name 목록(n:n)"),
    ku_refs: z.array(z.object({
      name: z.string(),
      relation: z.enum(["produced", "references", "decided"]),
    })).optional().describe("산출/참조/결정한 지식 ku 연결"),
    touches: z.array(z.object({
      target_kind: z.enum(["code_unit", "data_entity"]),
      target_id: z.number().int(),
    })).optional().describe("commit 이 건드린 코드/엔티티(is 갱신 근거)"),
    commit_sha: z.string().max(64).optional(),
    repo: z.string().max(100).optional().describe("repo 이름(commit 유형)"),
    committed_at: z.string().max(40).optional().describe("ISO 시각"),
    author_agent: z.string().max(120).optional().describe("어떤 AI(모델/하네스 id). 사람 단독이면 생략"),
    session_id: z.string().max(200).optional(),
    external_system: z.string().max(60).optional().describe("PM 미러 시스템(예: clickup)"),
    external_id: z.string().max(200).optional(),
    external_url: z.string().max(500).optional(),
    external_instance: z.string().max(200).optional(),
    should_review: z.enum(["na", "checked_no_change", "changed"]).optional(),
    is_review: z.enum(["na", "checked_no_change", "changed"]).optional(),
  },
  expose: { mcp: true, rest: false },
  handler: async (input: any, user, ctx) => {
    const authorPerson = ctx?.actor ?? user?.userId ?? null;
    const res = await logActivity({
      type: input.type, title: input.title, body: input.body ?? null,
      taskKuNames: input.task_ku_names, kuRefs: input.ku_refs, touches: input.touches,
      commit_sha: input.commit_sha ?? null, repo: input.repo ?? null, committed_at: input.committed_at ?? null,
      author_agent: input.author_agent ?? null, session_id: input.session_id ?? null,
      external_system: input.external_system ?? null, external_id: input.external_id ?? null,
      external_url: input.external_url ?? null, external_instance: input.external_instance,
      should_review: input.should_review, is_review: input.is_review,
    }, authorPerson);
    return { ok: true, ...res };
  },
};

const activityList: Capability = {
  name: "activity_list",
  title: "작업(activity) 목록",
  description:
    "작업(activity)을 최신순으로 조회한다(commit/comment/decision 등). 필터: author_person(누가)·author_agent(어떤 AI)·" +
    "type·task_ku(과업 ku name)·repo. 사람×AI 작업현황의 원천.",
  scope: "memory",
  input: {
    author_person: z.string().optional().describe("작성자(사람) 식별자로 필터"),
    author_agent: z.string().optional().describe("어떤 AI(모델/하네스)로 필터"),
    type: z.string().optional(),
    task_ku: z.string().optional().describe("과업(W ku) name 으로 필터"),
    repo: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  expose: {
    mcp: true,
    rest: [{
      method: "GET",
      paths: ["/api/ui/activity/list"],
      parse: (req) => ({
        author_person: req.query.author_person ? String(req.query.author_person) : undefined,
        author_agent: req.query.author_agent ? String(req.query.author_agent) : undefined,
        type: req.query.type ? String(req.query.type) : undefined,
        task_ku: req.query.task_ku ? String(req.query.task_ku) : undefined,
        repo: req.query.repo ? String(req.query.repo) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    }],
  },
  handler: async (input: any) => listActivities({
    author_person: input.author_person, author_agent: input.author_agent, type: input.type,
    task_ku: input.task_ku, repo: input.repo, limit: input.limit,
  }),
};

export const activityCapabilities: Capability[] = [activityLog, activityList];
