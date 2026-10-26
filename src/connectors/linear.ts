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
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stateDir } from "../ops/state-dir.js";

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
export interface LComment {
  id: string; body?: string | null; createdAt?: string; updatedAt?: string; user?: LUser | null; url?: string;
  // 연동이 단 댓글(#5012 실측) — 슬랙 연동이 슬랙 스레드를 옮겨 오면 user 는 비고 botActor(=Slack) · externalUser(=그 슬랙 작성자)가 찬다.
  //  externalUser 는 사람일 수도 봇(Sentry 등)일 수도 있어 «연동 = 봇» 으로 접지 않는다.
  botActor?: { name?: string | null; type?: string | null; subType?: string | null } | null;
  externalUser?: { name?: string | null } | null;
}
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

/** 댓글 작성자 — 사람(user) → 연동이 옮겨 온 외부 작성자(externalUser) → 연동 자체(botActor). 봇 표시는 사람도 외부 작성자도
 *  없는 **순수 연동 댓글**에만 단다(외부 작성자는 사람일 수 있다 — 슬랙 스레드의 사람 답글). */
export function commentActor(c: LComment): RawItem["actor"] {
  if (c.user && (c.user.id || c.user.name)) return actorOf(c.user);
  const ext = c.externalUser?.name?.trim();
  if (ext) return { display_name: ext };
  const bot = c.botActor?.name?.trim();
  return bot ? { display_name: bot, is_bot: true } : undefined;
}

export function commentItem(instance: string, issue: LIssue, c: LComment): RawItem {
  const team = issue.team?.key ?? issue.identifier.split("-")[0];
  return {
    type: "message",
    provenance: { category: "collab_tool", system: "linear", instance, external_id: `${issue.identifier}:c${c.id}`, external_url: c.url ?? issue.url },
    actor: commentActor(c),
    container_ref: team, container_name: issue.team?.name ? `${issue.team.name} (${team})` : team,
    parent_external_id: issue.identifier,
    body: c.body ?? "",
    occurred_at: c.createdAt, updated_at: c.updatedAt ?? c.createdAt,
    fields: { kind: "comment", number: issue.identifier, comment_id: c.id, team, ...(c.botActor ? { via: c.botActor.subType || c.botActor.name || "integration" } : {}) },
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

// ── 업로드 첨부(#5012) ───────────────────────────────────────────────────────
//  리니어 본문의 이미지·파일은 `uploads.linear.app` 에 있고 **인증 없이는 401** 이다(위시스트 실측: 리니어 자료 4,351건 중
//  1,493건 · 링크 2,227개). 링크만 저장하면 화면엔 대체 텍스트(«image.png»)만 보이고 증류도 캡처를 못 본다.
//  수집 때 연결 토큰(Bearer — 실측 200)으로 받아 게이트웨이 디스크에 두고, 본문 링크를 `/api/ui/linear-assets/<파일>` 로 바꾼다.
//  파일명 = 업로드 경로 해시 + 확장자 — 같은 업로드는 다시 받지 않는다(재수집·full 스윕에도 결정적).
//  실패·상한 초과는 **원래 링크를 그대로 둔다**(본문을 잃지 않는다 — 다음 full 스윕이 원문에서 다시 시도한다).
export const LINEAR_ASSET_ROUTE = "/api/ui/linear-assets/";
export const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const UPLOAD_RE = /(!?\[([^\]]*)\])\((https:\/\/uploads\.linear\.app\/[^)\s]+)\)/g;
const EXT_BY_TYPE: Readonly<Record<string, string>> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/bmp": "bmp",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "audio/mpeg": "mp3", "application/pdf": "pdf",
};

/** 본문에 든 리니어 업로드 링크(중복 제거, 등장 순). */
export function linearUploadLinks(md: string | null | undefined): Array<{ url: string; text: string }> {
  const out = new Map<string, string>();
  for (const m of String(md ?? "").matchAll(UPLOAD_RE)) if (!out.has(m[3])) out.set(m[3], m[2]);
  return [...out].map(([url, text]) => ({ url, text }));
}

/** 파일 키(확장자 없이) — 업로드 경로만 본다(쿼리·서명은 버린다). */
export function linearAssetKey(url: string): string {
  let p = url;
  try { p = new URL(url).pathname; } catch { /* 그대로 */ }
  return crypto.createHash("sha1").update(p).digest("hex").slice(0, 24);
}

/** 확장자 — 링크 글자(«image.png»·«영상.mp4»)가 먼저, 없으면 응답 타입. 모르면 bin(화면은 내려받기로만 준다). */
export function linearAssetExt(text: string, contentType: string | null | undefined): string {
  const fromText = text.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase();
  if (fromText) return fromText === "jpeg" ? "jpg" : fromText;
  return EXT_BY_TYPE[String(contentType ?? "").split(";")[0].trim().toLowerCase()] ?? "bin";
}

/** 본문의 업로드 링크를 받은 파일 경로로 바꾼다(순수). 표에 없는 링크는 그대로. */
export function rewriteLinearUploads(md: string, files: ReadonlyMap<string, string>): string {
  return md.replace(UPLOAD_RE, (all, label: string, _text: string, url: string) => {
    const f = files.get(url);
    return f ? `${label}(${LINEAR_ASSET_ROUTE}${f})` : all;
  });
}

export interface AssetStats { fetched: number; existing: number; failed: number; tooLarge: number }
export interface AssetCtx {
  token: string; dir: string;
  /** 업로드 키 → 저장된 파일명(시작 때 폴더를 한 번 읽어 채운다 — 이미 받은 것은 요청하지 않는다). */
  known: Map<string, string>;
  stats: AssetStats;
  fetchImpl?: typeof fetch;
  /** 새로 받거나 못 받은 첨부가 ASSET_PROGRESS_EVERY 개 쌓일 때마다 부른다 — 수집 추적기는 15분 무출력이면 run 을 죽인다
   *  (첫 판에서 위시스트 첨부 2,227개를 받다 16분째 «정체 감지» 로 끊겼다). 이미 있는 파일은 요청이 없어 세지 않는다. */
  onProgress?: (s: AssetStats) => void;
}
export const ASSET_PROGRESS_EVERY = 25;

export function assetCtx(token: string, dir: string, fetchImpl?: typeof fetch, onProgress?: (s: AssetStats) => void): AssetCtx {
  fs.mkdirSync(dir, { recursive: true });
  const known = new Map<string, string>();
  for (const f of fs.readdirSync(dir)) { const m = f.match(/^([0-9a-f]{24})\.[a-z0-9]{1,8}$/); if (m) known.set(m[1], f); }
  return { token, dir, known, stats: { fetched: 0, existing: 0, failed: 0, tooLarge: 0 }, fetchImpl, onProgress };
}

async function fetchAsset(ctx: AssetCtx, url: string, text: string): Promise<string | null> {
  const key = linearAssetKey(url);
  const have = ctx.known.get(key);
  if (have) { ctx.stats.existing++; return have; }
  const file = await downloadAsset(ctx, key, url, text);
  const s = ctx.stats;
  if ((s.fetched + s.failed + s.tooLarge) % ASSET_PROGRESS_EVERY === 0) ctx.onProgress?.(s);
  return file;
}

async function downloadAsset(ctx: AssetCtx, key: string, url: string, text: string): Promise<string | null> {
  const f = ctx.fetchImpl ?? fetch;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try { res = await f(url, { headers: { Authorization: `Bearer ${ctx.token}` }, redirect: "follow" }); }
    catch { ctx.stats.failed++; return null; }
    if (res.status === 429 && attempt === 0) {
      await res.arrayBuffer().catch(() => null);
      await new Promise((r) => setTimeout(r, Math.min(Number(res.headers.get("retry-after") ?? 5) * 1000, 30_000)));
      continue;
    }
    if (!res.ok) { await res.arrayBuffer().catch(() => null); ctx.stats.failed++; return null; }
    if (Number(res.headers.get("content-length") ?? 0) > MAX_ASSET_BYTES) {
      await res.body?.cancel().catch(() => undefined); ctx.stats.tooLarge++; return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ASSET_BYTES) { ctx.stats.tooLarge++; return null; }
    const file = `${key}.${linearAssetExt(text, res.headers.get("content-type"))}`;
    const tmp = path.join(ctx.dir, `.${file}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, path.join(ctx.dir, file));
    ctx.known.set(key, file);
    ctx.stats.fetched++;
    return file;
  }
  ctx.stats.failed++;
  return null;
}

/** 본문의 업로드를 받아 두고 링크를 바꾼 본문을 돌려준다. 업로드가 없으면 원문 그대로. */
export async function localizeLinearUploads(md: string | null | undefined, ctx: AssetCtx): Promise<string | null | undefined> {
  const links = linearUploadLinks(md);
  if (!links.length) return md;
  const files = new Map<string, string>();
  for (const l of links) { const f = await fetchAsset(ctx, l.url, l.text); if (f) files.set(l.url, f); }
  return rewriteLinearUploads(String(md), files);
}

export const ISSUES_QUERY = `query Issues($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt, includeArchived: true) {
    nodes {
      id identifier title description url priority priorityLabel createdAt updatedAt completedAt canceledAt archivedAt
      state { name type } team { key name } project { name }
      assignee { id name displayName email } creator { id name displayName email }
      labels { nodes { name } }
      comments(first: 100) { nodes { id body createdAt updatedAt url user { id name displayName email } botActor { name type subType } externalUser { name } } }
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

    const assets = assetCtx(token, stateDir("linear-assets"), undefined, (a) =>
      console.error(`[linear] 첨부 받는 중 — 새로 받음 ${a.fetched} · 이미 있음 ${a.existing} · 실패 ${a.failed} · 상한 초과 ${a.tooLarge}`));
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
        const issue = { ...i, description: await localizeLinearUploads(i.description, assets) };
        yield issueItem(instance, issue);
        for (const c of i.comments?.nodes ?? []) yield commentItem(instance, issue, { ...c, body: await localizeLinearUploads(c.body, assets) });
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
        for (const doc of d.documents.nodes) yield documentItem(instance, { ...doc, content: await localizeLinearUploads(doc.content, assets) });
        if (!d.documents.pageInfo.hasNextPage) break;
        dafter = d.documents.pageInfo.endCursor;
      }
    }
    const a = assets.stats;
    if (a.fetched + a.existing + a.failed + a.tooLarge) {
      console.error(`[linear] 첨부 — 새로 받음 ${a.fetched} · 이미 있음 ${a.existing} · 실패 ${a.failed} · 상한(${MAX_ASSET_BYTES / 1048576}MB) 초과 ${a.tooLarge} — 실패·초과는 원래 링크로 남는다`);
    }
  },
  // 첨부를 게이트웨이 디스크(data/linear-assets)에 둔다 — 매니지드의 판(일시 유닛)은 그 디스크를 못 본다(노션과 같다).
  needsGatewayDisk: true,
};
