// GitLab 커넥터 (#2247) — 프로젝트의 **이슈·MR 대화**(본문 + 노트)와 **릴리스 노트**를 canonical RawItem 으로.
//  GitHub 커넥터(github.ts)와 같은 축·같은 착지(source). 다른 점:
//   · 인증은 개인 액세스 토큰(read_api)만 — [계정 로그인] 토큰(DCR, scope=mcp)은 REST 를 못 부른다.
//   · 호스트 축 — 회사 GitLab(self-managed)이 있어 `host` 를 갖는다(기본 gitlab.com).
//   · 노트(댓글)는 저장소 전체 엔드포인트가 없다 → 이번 창에서 갱신된 이슈·MR 에 대해서만 노트를 받는다
//     (노트가 달리면 이슈 updated_at 이 오르므로 증분에 잡힌다). 시스템 노트(라벨 변경 등)는 뺀다.
//   · 페이지네이션은 `x-next-page` 헤더.
import type { Connector, RawItem, BackfillOpts } from "./types.js";
import { resolveConnectorConfig } from "./config.js";

const PAGE_SIZE = 100;
export const MAX_PAGES = 30;

/** `projects` 설정 → 프로젝트 경로(group/sub/project) 목록. 주소를 그대로 붙여넣어도 된다. */
export function parseProjectList(v: string | undefined, host?: string): string[] {
  const out = new Map<string, string>();
  const h = String(host ?? "").trim().toLowerCase();
  for (const tok of String(v ?? "").split(/[\s,]+/)) {
    const s = tok.trim();
    if (!s) continue;
    let path = s;
    if (/^https?:\/\//i.test(s)) {
      try { const u = new URL(s); path = u.pathname; } catch { continue; }
    } else if (h && s.toLowerCase().startsWith(h + "/")) {
      path = s.slice(h.length);
    }
    path = path.replace(/^\/+|\/+$/g, "").replace(/\/-\/.*$/, "").replace(/\.git$/, "");
    // 세그먼트마다 글자·숫자가 하나는 있어야 한다 — '..' 같은 경로 조각은 프로젝트가 아니다.
    if (!/^[\w.-]+(\/[\w.-]+)+$/.test(path) || path.split("/").some((seg) => !/[A-Za-z0-9_]/.test(seg))) continue;
    if (!out.has(path.toLowerCase())) out.set(path.toLowerCase(), path);
  }
  return [...out.values()];
}

interface GlUser { id?: number; username?: string; name?: string; bot?: boolean }
export interface GlIssue {
  id?: number; iid: number; title?: string; description?: string | null; state?: string; web_url?: string;
  author?: GlUser | null; labels?: string[]; assignees?: GlUser[]; milestone?: { title?: string } | null;
  user_notes_count?: number; created_at?: string; updated_at?: string; closed_at?: string | null;
  merged_at?: string | null; draft?: boolean; source_branch?: string; target_branch?: string;
}
export interface GlNote { id: number; body?: string | null; author?: GlUser | null; system?: boolean; created_at?: string; updated_at?: string }
export interface GlRelease { tag_name: string; name?: string | null; description?: string | null; released_at?: string | null; created_at?: string; author?: GlUser | null; _links?: { self?: string } }

const actorOf = (u: GlUser | null | undefined): RawItem["actor"] =>
  u && (u.id != null || u.username) ? { external_id: u.id != null ? String(u.id) : undefined, display_name: u.username ?? u.name, is_bot: !!u.bot } : undefined;

export function issueItem(project: string, host: string, i: GlIssue, mr: boolean): RawItem {
  const mark = mr ? "!" : "#";
  const kind = mr ? "MR" : "이슈";
  const merged = mr && (i.state === "merged" || !!i.merged_at);
  const body = `${kind} ${mark}${i.iid} ${i.title ?? ""}`.trim() + (i.description ? `\n\n${i.description}` : "");
  return {
    type: "message",
    provenance: { category: "vcs", system: "gitlab", instance: host, external_id: `${project}${mark}${i.iid}`, external_url: i.web_url },
    actor: actorOf(i.author),
    container_ref: project, container_name: project,
    title: i.title ?? undefined, body,
    occurred_at: i.created_at, updated_at: i.updated_at ?? i.created_at,
    fields: {
      kind: mr ? "mr" : "issue", number: i.iid, state: i.state ?? null, draft: !!i.draft,
      labels: i.labels ?? [], assignees: (i.assignees ?? []).map((a) => a.username).filter(Boolean),
      milestone: i.milestone?.title ?? null, comments: i.user_notes_count ?? 0,
      closed_at: i.closed_at ?? null, merged_at: merged ? (i.merged_at ?? null) : null,
      source_branch: i.source_branch ?? null, target_branch: i.target_branch ?? null, project, host,
    },
    raw: i,
  };
}

export function noteItem(project: string, host: string, parentIid: number, mr: boolean, n: GlNote): RawItem | null {
  if (n.system) return null; // 라벨 변경·담당자 변경 같은 시스템 노트 — 사람의 말이 아니다
  const mark = mr ? "!" : "#";
  return {
    type: "message",
    provenance: { category: "vcs", system: "gitlab", instance: host, external_id: `${project}${mark}${parentIid}:n${n.id}` },
    actor: actorOf(n.author),
    container_ref: project, container_name: project,
    parent_external_id: `${project}${mark}${parentIid}`,
    body: n.body ?? "",
    occurred_at: n.created_at, updated_at: n.updated_at ?? n.created_at,
    fields: { kind: mr ? "mr_note" : "note", number: parentIid, note_id: n.id, project, host },
    raw: n,
  };
}

export function releaseItem(project: string, host: string, r: GlRelease): RawItem {
  const title = `릴리스 ${r.tag_name}${r.name && r.name !== r.tag_name ? ` — ${r.name}` : ""}`.trim();
  return {
    type: "note",
    provenance: { category: "vcs", system: "gitlab", instance: host, external_id: `${project}:release:${r.tag_name}`, external_url: r._links?.self },
    actor: actorOf(r.author),
    container_ref: project, container_name: project,
    title, body: title + (r.description ? `\n\n${r.description}` : ""),
    occurred_at: r.released_at ?? r.created_at, updated_at: r.released_at ?? r.created_at,
    fields: { kind: "release", tag: r.tag_name, project, host },
    raw: r,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function glGet<T>(token: string, url: string): Promise<{ data: T; nextPage: string | null }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
    if (res.status === 429 && attempt < 3) {
      const wait = Math.min(Number(res.headers.get("retry-after") ?? 5) * 1000, 90_000);
      await res.text().catch(() => ""); await sleep(wait > 0 ? wait : 5000); continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`GitLab ${res.status} ${url.replace(/^https?:\/\/[^/]+/, "")}${text ? ` — ${text.slice(0, 200)}` : ""}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    const nextPage = res.headers.get("x-next-page");
    return { data: (await res.json()) as T, nextPage: nextPage && nextPage.trim() ? nextPage.trim() : null };
  }
  throw new Error(`GitLab 속도 제한이 풀리지 않습니다 — ${url}`);
}

async function* pages<T>(token: string, base: string, label: string): AsyncGenerator<T[]> {
  let page: string | null = "1";
  for (let n = 0; page && n < MAX_PAGES; n++) {
    const r: { data: T[]; nextPage: string | null } = await glGet<T[]>(token, `${base}&page=${page}`);
    yield Array.isArray(r.data) ? r.data : [];
    page = r.nextPage;
    if (page && n === MAX_PAGES - 1) console.warn(`gitlab: ${label} — 페이지 상한(${MAX_PAGES}) 도달, 나머지는 다음 run 이 이어갑니다`);
  }
}

const statusOf = (e: unknown): number | undefined => (e as { status?: number })?.status;
const on = (v: string | undefined, dflt: boolean): boolean => { const s = String(v ?? "").trim().toLowerCase(); return s ? !["off", "false", "0", "no"].includes(s) : dflt; };

export const gitlabConnector: Connector = {
  name: "gitlab",

  async *backfill(opts?: BackfillOpts): AsyncIterable<RawItem> {
    const cfg = await resolveConnectorConfig("gitlab");
    const token = cfg.token;
    if (!token) {
      throw new Error("GitLab 토큰이 없습니다 — '토큰 출처'를 member:<구성원 id> 로 지정하거나(그 사람의 개인 액세스 토큰 read_api) 토큰 칸에 저장하세요.");
    }
    const host = String(cfg.host ?? "").trim().toLowerCase() || "gitlab.com";
    const api = `https://${host}/api/v4`;
    const projects = parseProjectList(cfg.projects, host);
    if (projects.length === 0) throw new Error("수집할 프로젝트가 없습니다 — '프로젝트'에 group/project 경로를 넣으세요.");
    const includeMrs = on(cfg.include_mrs, true);
    const includeReleases = on(cfg.include_releases, true);
    const since = opts?.since ? `&updated_after=${encodeURIComponent(opts.since)}` : "";
    const sinceMs = opts?.since ? Date.parse(opts.since) : NaN;

    for (const project of projects) {
      const pp = `${api}/projects/${encodeURIComponent(project)}`;
      try {
        const kinds: Array<{ mr: boolean; path: string }> = [{ mr: false, path: "issues" }, ...(includeMrs ? [{ mr: true, path: "merge_requests" }] : [])];
        for (const k of kinds) {
          for await (const page of pages<GlIssue>(token, `${pp}/${k.path}?scope=all&order_by=updated_at&sort=asc&per_page=${PAGE_SIZE}${since}`, `${project} ${k.path}`)) {
            for (const i of page) {
              yield issueItem(project, host, i, k.mr);
              if ((i.user_notes_count ?? 0) > 0) {
                for await (const notes of pages<GlNote>(token, `${pp}/${k.path}/${i.iid}/notes?order_by=updated_at&sort=asc&per_page=${PAGE_SIZE}`, `${project} ${k.path}/${i.iid} notes`)) {
                  for (const n of notes) { const it = noteItem(project, host, i.iid, k.mr, n); if (it) yield it; }
                }
              }
            }
          }
        }
        if (includeReleases) {
          const r = await glGet<GlRelease[]>(token, `${pp}/releases?per_page=${PAGE_SIZE}`);
          for (const rel of Array.isArray(r.data) ? r.data : []) {
            const t = Date.parse(rel.released_at ?? rel.created_at ?? "");
            if (Number.isFinite(sinceMs) && Number.isFinite(t) && t < sinceMs) continue;
            yield releaseItem(project, host, rel);
          }
        }
      } catch (e) {
        const st = statusOf(e);
        if (st === 401) throw e;
        if (st === 404 || st === 403) { console.warn(`gitlab: ${project} 건너뜀 — ${(e as Error).message}`); continue; }
        throw e;
      }
    }
  },
};
