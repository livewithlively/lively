// Linear 커넥터 (#2247) — 워크스페이스의 **이슈 + 댓글**과 **문서(Documents)** 를 canonical RawItem 으로. GraphQL.
//  GitHub·GitLab 과 같은 축·같은 착지(source). 다른 점:
//   · 인증은 라이블리 Linear 앱 토큰(linear_app, token_source=member:<id>) — MCP(DCR) 토큰과 슬롯이 다르다(linear-oauth.ts).
//   · 범위 = 워크스페이스 전체가 기본. `teams`(팀 키, 예 ENG PRD)로 좁힐 수 있다.
//   · 증분: issues(filter:{updatedAt:{gt:$since}}, orderBy: updatedAt). Linear 는 최신순으로 준다 — 페이지 상한에 걸리면
//     오래된 쪽이 잘리고 커서가 최신으로 앞서가 **유실**되므로, 상한에 닿으면 run 을 실패시켜 커서를 동결한다(다음 run 재수집).
//     상한은 100페이지×100건 — 그보다 큰 한 창은 실제로 드물다(첫 백필이 그 이상이면 teams 로 나눠 켠다).
import type { Connector, RawItem, BackfillOpts } from "./types.js";
import { resolveConnectorConfig } from "./config.js";
import { LINEAR_GRAPHQL_URL } from "../org/credentials/linear-oauth.js";
import { sinceFloor } from "./sync-cursor.js";

const PAGE = 100;
export const MAX_PAGES = 100;

interface LUser { id?: string; name?: string; displayName?: string; email?: string }
export interface LIssue {
  id: string; identifier: string; title?: string; description?: string | null; url?: string; priority?: number; priorityLabel?: string;
  createdAt?: string; updatedAt?: string; completedAt?: string | null; canceledAt?: string | null; archivedAt?: string | null;
  state?: { name?: string; type?: string } | null; team?: { key?: string; name?: string } | null; project?: { name?: string } | null;
  assignee?: LUser | null; creator?: LUser | null; labels?: { nodes?: Array<{ name?: string }> } | null;
  comments?: { nodes?: LComment[] } | null;
}
export interface LComment { id: string; body?: string | null; createdAt?: string; updatedAt?: string; user?: LUser | null; url?: string }
export interface LDocument { id: string; title?: string; content?: string | null; url?: string; createdAt?: string; updatedAt?: string; creator?: LUser | null; project?: { name?: string } | null }

/** 팀 키 목록(공백·쉼표 구분, 대문자화). */
export function parseTeamKeys(v: string | undefined): string[] {
  return [...new Set(String(v ?? "").split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];
}

const actorOf = (u: LUser | null | undefined): RawItem["actor"] =>
  u && (u.id || u.name) ? { external_id: u.id, display_name: u.displayName ?? u.name, email: u.email } : undefined;

export function issueItem(instance: string, i: LIssue): RawItem {
  const team = i.team?.key ?? i.identifier.split("-")[0];
  const stateType = i.state?.type ?? null; // triage | backlog | unstarted | started | completed | canceled
  const closed = stateType === "completed" || stateType === "canceled";
  const body = `이슈 ${i.identifier} ${i.title ?? ""}`.trim() + (i.description ? `\n\n${i.description}` : "");
  return {
    type: "message",
    provenance: { category: "collab_tool", system: "linear", instance, external_id: i.identifier, external_url: i.url },
    actor: actorOf(i.creator),
    container_ref: team, container_name: i.team?.name ? `${i.team.name} (${team})` : team,
    title: i.title ?? undefined, body,
    occurred_at: i.createdAt, updated_at: i.updatedAt ?? i.createdAt,
    fields: {
      kind: "issue", number: i.identifier, state: i.state?.name ?? null, state_type: stateType, closed,
      priority: i.priorityLabel ?? i.priority ?? null, labels: (i.labels?.nodes ?? []).map((l) => l.name).filter(Boolean),
      assignee: i.assignee?.name ?? null, project: i.project?.name ?? null, team, comments: i.comments?.nodes?.length ?? 0,
      completed_at: i.completedAt ?? null, canceled_at: i.canceledAt ?? null,
    },
    raw: { ...i, comments: undefined },
  };
}

export function commentItem(instance: string, issue: LIssue, c: LComment): RawItem {
  const team = issue.team?.key ?? issue.identifier.split("-")[0];
  return {
    type: "message",
    provenance: { category: "collab_tool", system: "linear", instance, external_id: `${issue.identifier}:c${c.id}`, external_url: c.url ?? issue.url },
    actor: actorOf(c.user),
    container_ref: team, container_name: issue.team?.name ? `${issue.team.name} (${team})` : team,
    parent_external_id: issue.identifier,
    body: c.body ?? "",
    occurred_at: c.createdAt, updated_at: c.updatedAt ?? c.createdAt,
    fields: { kind: "comment", number: issue.identifier, comment_id: c.id, team },
    raw: c,
  };
}

export function documentItem(instance: string, d: LDocument): RawItem {
  return {
    type: "note",
    provenance: { category: "collab_tool", system: "linear", instance, external_id: `doc:${d.id}`, external_url: d.url },
    actor: actorOf(d.creator),
    container_ref: d.project?.name ?? "documents", container_name: d.project?.name ?? "문서",
    title: d.title ?? undefined, body: `${d.title ?? ""}`.trim() + (d.content ? `\n\n${d.content}` : ""),
    occurred_at: d.createdAt, updated_at: d.updatedAt ?? d.createdAt,
    fields: { kind: "document", project: d.project?.name ?? null },
    raw: { ...d, content: undefined },
  };
}

export const ISSUES_QUERY = `query Issues($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt, includeArchived: true) {
    nodes {
      id identifier title description url priority priorityLabel createdAt updatedAt completedAt canceledAt archivedAt
      state { name type } team { key name } project { name }
      assignee { id name displayName email } creator { id name displayName email }
      labels { nodes { name } }
      comments(first: 100) { nodes { id body createdAt updatedAt url user { id name displayName email } } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
export const DOCUMENTS_QUERY = `query Documents($first: Int!, $after: String, $filter: DocumentFilter) {
  documents(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
    nodes { id title content url createdAt updatedAt creator { id name displayName email } project { name } }
    pageInfo { hasNextPage endCursor }
  }
}`;
export const VIEWER_QUERY = `query Viewer { viewer { id name email organization { id urlKey name } } }`;

/** 이슈 필터 — since 와 팀 키를 GraphQL IssueFilter 로. 순수. */
export function issueFilter(since: string | undefined, teams: string[]): Record<string, unknown> | undefined {
  const f: Record<string, unknown> = {};
  if (since) f.updatedAt = { gt: since };
  if (teams.length === 1) f.team = { key: { eq: teams[0] } };
  else if (teams.length > 1) f.team = { key: { in: teams } };
  return Object.keys(f).length ? f : undefined;
}

async function gql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(LINEAR_GRAPHQL_URL, {
      method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429 && attempt < 3) {
      const wait = Math.min(Number(res.headers.get("retry-after") ?? 10) * 1000, 90_000);
      await res.text().catch(() => ""); await new Promise((r) => setTimeout(r, wait > 0 ? wait : 10_000)); continue;
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const err = new Error(`Linear ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`);
      (err as Error & { status?: number }).status = res.status; throw err;
    }
    const j = JSON.parse(text) as { data?: T; errors?: Array<{ message?: string }> };
    if (j.errors?.length) throw new Error(`Linear GraphQL 오류 — ${j.errors.map((e) => e.message).join("; ").slice(0, 300)}`);
    return j.data as T;
  }
  throw new Error("Linear 속도 제한이 풀리지 않습니다");
}

export const linearConnector: Connector = {
  name: "linear",

  async *backfill(opts?: BackfillOpts): AsyncIterable<RawItem> {
    const cfg = await resolveConnectorConfig("linear");
    const token = cfg.token;
    if (!token) throw new Error("Linear 토큰이 없습니다 — '토큰 출처'를 member:<구성원 id> 로 지정하세요(그 사람이 [Linear 자료 가져오기]에서 연결한 라이블리 앱 토큰을 씁니다).");
    const teams = parseTeamKeys(cfg.teams);
    const includeDocs = String(cfg.include_documents ?? "").toLowerCase() !== "off";
    const viewer = await gql<{ viewer?: { organization?: { urlKey?: string; id?: string } } }>(token, VIEWER_QUERY, {});
    const instance = viewer.viewer?.organization?.urlKey || viewer.viewer?.organization?.id || "linear";

    const sinceIso = sinceFloor(opts?.since, cfg.backfill_since);
    const filter = issueFilter(sinceIso, teams);
    let after: string | null = null;
    for (let n = 0; ; n++) {
      if (n >= MAX_PAGES) {
        // 최신순이라 여기서 멈추면 오래된 쪽이 유실된다 — 커서를 동결시키는 것이 옳다(run 실패 → 다음 run 재수집).
        throw new Error(`Linear 이슈가 한 run 상한(${MAX_PAGES * PAGE}건)을 넘습니다 — 'teams' 로 팀을 나눠 켜거나 다시 실행하세요.`);
      }
      const d: { issues: { nodes: LIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await gql(
        token, ISSUES_QUERY, { first: PAGE, after, filter });
      for (const i of d.issues.nodes) {
        yield issueItem(instance, i);
        for (const c of i.comments?.nodes ?? []) yield commentItem(instance, i, c);
      }
      if (!d.issues.pageInfo.hasNextPage) break;
      after = d.issues.pageInfo.endCursor;
    }

    if (includeDocs) {
      const dfilter = sinceIso ? { updatedAt: { gt: sinceIso } } : undefined;
      let dafter: string | null = null;
      for (let n = 0; n < MAX_PAGES; n++) {
        const d: { documents: { nodes: LDocument[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await gql(
          token, DOCUMENTS_QUERY, { first: PAGE, after: dafter, filter: dfilter });
        for (const doc of d.documents.nodes) yield documentItem(instance, doc);
        if (!d.documents.pageInfo.hasNextPage) break;
        dafter = d.documents.pageInfo.endCursor;
      }
    }
  },
};
