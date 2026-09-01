// GitHub 커넥터 (#2247) — 저장소의 **이슈·PR 대화**(본문 + 댓글 + 리뷰 댓글)와 **릴리스 노트**를 canonical RawItem 으로.
//
// ── 왜 이슈·PR 대화인가 ────────────────────────────────────────────────────────
//  코드 자체는 위키 수집기(domain-wiki)와 clone 이 다룬다. 조직의 **결정과 이유**는 코드가 아니라 이슈·PR 의
//  말(왜 이렇게 고쳤나 · 어떤 안이 반려됐나 · 어느 버그의 원인이 무엇이었나)에 쌓인다. 그래서 자료(source)로
//  들이고 증류기가 지식으로 올린다 — 슬랙·피그마 코멘트와 같은 축이다.
//
// ── 범위 선언 ─────────────────────────────────────────────────────────────────
//  `repos`: owner/repo 목록(공백·쉼표·줄바꿈 구분, GitHub 주소 그대로 붙여넣어도 된다). 토글이 켤 때 비어 있으면
//  [GitHub 연결] 화면에서 고른 저장소(설치에 열린 것, open_repositories)를 기본값으로 채운다 — 그 선택이 곧 범위다.
//
// ── 인증 ─────────────────────────────────────────────────────────────────────
//  붙여넣기(token) 또는 금고(token_source → github_pat 슬롯: 정적 PAT 또는 OAuth 묶음). 묶음/만료 갱신은
//  github-token-source.ts 가 http_proxy 와 같은 부품으로 다룬다. 이 파일은 Bearer 한 줄만 안다.
//
// ── 증분 ─────────────────────────────────────────────────────────────────────
//  이슈·댓글은 GitHub 이 `since`(updated_at 기준)·`sort=updated&direction=asc` 를 준다 — 커서는 관측한
//  updated_at 의 최대. 오름차순이라 페이지 상한에 걸려 잘려도 다음 run 이 그 자리부터 이어간다(유실 없음).
//  릴리스는 since 가 없어 최근 100개를 받고 created/published 로 걸러낸다.
import type { Connector, RawItem, BackfillOpts } from "./types.js";
import { resolveConnectorConfig } from "./config.js";
import { GITHUB_USER_AGENT } from "../org/credentials/github-app.js";
import { sinceFloor } from "./sync-cursor.js";

const PAGE_SIZE = 100;
/** 엔드포인트·저장소당 한 run 에 받는 최대 페이지 — 오름차순 커서라 잘려도 다음 run 이 이어간다. */
export const MAX_PAGES = 30;

export interface GithubRepoRef { owner: string; repo: string; full: string }

/** `repos` 설정 → owner/repo 목록. 주소(https://github.com/o/r/issues/3)·`o/r.git`·`o/r` 을 다 받는다. 못 알아보면 버린다. */
export function parseRepoList(v: string | undefined): GithubRepoRef[] {
  const out = new Map<string, GithubRepoRef>();
  for (const tok of String(v ?? "").split(/[\s,]+/)) {
    const s = tok.trim();
    if (!s) continue;
    let path = s;
    if (/^https?:\/\//i.test(s)) {
      try { path = new URL(s).pathname; } catch { continue; }
    } else if (/^(www\.)?github\.com\//i.test(s)) {
      path = s.replace(/^(www\.)?github\.com/i, "");
    }
    // owner 는 영숫자·하이픈(GitHub 규칙), repo 는 점·밑줄도 되지만 점만으로 된 이름(../x 같은 경로 조각)은 아니다.
    const m = path.replace(/^\/+/, "").match(/^([A-Za-z0-9][A-Za-z0-9-]*)\/([\w.-]+?)(?:\.git)?(?:\/|$)/);
    if (!m || !/[A-Za-z0-9_]/.test(m[2])) continue;
    const full = `${m[1]}/${m[2]}`;
    if (!out.has(full.toLowerCase())) out.set(full.toLowerCase(), { owner: m[1], repo: m[2], full });
  }
  return [...out.values()];
}

export function apiBaseOf(host: string | undefined): string {
  const h = String(host ?? "").trim().toLowerCase() || "github.com";
  return h === "github.com" ? "https://api.github.com" : `https://${h}/api/v3`;
}

interface GhUser { id?: number | string; login?: string; type?: string; html_url?: string }
interface GhLabel { name?: string }
export interface GhIssue {
  id?: number; number: number; title?: string; body?: string | null; state?: string; html_url?: string;
  user?: GhUser | null; labels?: Array<GhLabel | string>; assignees?: GhUser[]; milestone?: { title?: string } | null;
  comments?: number; created_at?: string; updated_at?: string; closed_at?: string | null;
  pull_request?: { url?: string; merged_at?: string | null } | null; draft?: boolean;
}
export interface GhComment {
  id: number; body?: string | null; html_url?: string; user?: GhUser | null;
  created_at?: string; updated_at?: string; issue_url?: string; pull_request_url?: string;
  path?: string; line?: number | null; original_line?: number | null; diff_hunk?: string;
}
export interface GhRelease {
  id: number; tag_name?: string; name?: string | null; body?: string | null; html_url?: string; draft?: boolean; prerelease?: boolean;
  author?: GhUser | null; created_at?: string; published_at?: string | null;
}

const actorOf = (u: GhUser | null | undefined): RawItem["actor"] =>
  u && (u.id != null || u.login)
    ? { external_id: u.id != null ? String(u.id) : undefined, display_name: u.login, is_bot: u.type === "Bot" }
    : undefined;
const labelNames = (labels: GhIssue["labels"]): string[] =>
  (labels ?? []).map((l) => (typeof l === "string" ? l : l?.name ?? "")).filter(Boolean);
/** 댓글의 issue_url/pull_request_url 끝 숫자 = 이슈·PR 번호. */
export function issueNumberOf(c: Pick<GhComment, "issue_url" | "pull_request_url">): number | null {
  const u = c.issue_url || c.pull_request_url || "";
  const m = u.match(/\/(\d+)$/);
  return m ? Number(m[1]) : null;
}

export function issueItem(repo: GithubRepoRef, host: string, i: GhIssue): RawItem {
  const isPr = !!i.pull_request;
  const kind = isPr ? "PR" : "이슈";
  const body = `${kind} #${i.number} ${i.title ?? ""}`.trim() + (i.body ? `\n\n${i.body}` : "");
  return {
    type: "message",
    provenance: { category: "vcs", system: "github", instance: host, external_id: `${repo.full}#${i.number}`, external_url: i.html_url },
    actor: actorOf(i.user),
    container_ref: repo.full, container_name: repo.full,
    title: i.title ?? undefined,
    body,
    occurred_at: i.created_at, updated_at: i.updated_at ?? i.created_at,
    fields: {
      kind: isPr ? "pr" : "issue", number: i.number, state: i.state ?? null, draft: !!i.draft,
      labels: labelNames(i.labels), assignees: (i.assignees ?? []).map((a) => a.login).filter(Boolean),
      milestone: i.milestone?.title ?? null, comments: i.comments ?? 0,
      closed_at: i.closed_at ?? null, merged_at: i.pull_request?.merged_at ?? null,
      repo: repo.full,
    },
    raw: i,
  };
}

export function commentItem(repo: GithubRepoRef, host: string, c: GhComment, review: boolean): RawItem | null {
  const n = issueNumberOf(c);
  if (n == null) return null;
  return {
    type: "message",
    provenance: { category: "vcs", system: "github", instance: host, external_id: `${repo.full}#${n}:c${c.id}`, external_url: c.html_url },
    actor: actorOf(c.user),
    container_ref: repo.full, container_name: repo.full,
    parent_external_id: `${repo.full}#${n}`,
    body: (c.body ?? "") + (review && c.path ? `\n\n(파일 ${c.path}${c.line != null ? `:${c.line}` : ""})` : ""),
    occurred_at: c.created_at, updated_at: c.updated_at ?? c.created_at,
    fields: { kind: review ? "review_comment" : "comment", number: n, comment_id: c.id, path: c.path ?? null, line: c.line ?? c.original_line ?? null, repo: repo.full },
    raw: c,
  };
}

export function releaseItem(repo: GithubRepoRef, host: string, r: GhRelease): RawItem {
  const title = `릴리스 ${r.tag_name ?? ""}${r.name && r.name !== r.tag_name ? ` — ${r.name}` : ""}`.trim();
  return {
    type: "note",
    provenance: { category: "vcs", system: "github", instance: host, external_id: `${repo.full}:release:${r.id}`, external_url: r.html_url },
    actor: actorOf(r.author),
    container_ref: repo.full, container_name: repo.full,
    title,
    body: title + (r.body ? `\n\n${r.body}` : ""),
    occurred_at: r.published_at ?? r.created_at, updated_at: r.published_at ?? r.created_at,
    fields: { kind: "release", tag: r.tag_name ?? null, prerelease: !!r.prerelease, draft: !!r.draft, repo: repo.full },
    raw: r,
  };
}

/** Link 헤더의 rel="next" 주소. */
export function nextLinkOf(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function ghGet<T>(token: string, url: string): Promise<{ data: T; next: string | null; status: number }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": GITHUB_USER_AGENT },
    });
    // 속도 제한 — 남은 호출 0 이면 reset 까지(최대 90초), 아니면 retry-after 만큼 기다렸다 다시.
    if ((res.status === 403 || res.status === 429) && attempt < 3) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000;
      const retryAfter = Number(res.headers.get("retry-after") ?? 0) * 1000;
      const wait = retryAfter > 0 ? retryAfter : (remaining === "0" && reset > Date.now() ? Math.min(reset - Date.now() + 1000, 90_000) : 0);
      if (wait > 0) { await res.text().catch(() => ""); await sleep(wait); continue; }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`GitHub ${res.status} ${url.replace(/^https?:\/\/[^/]+/, "")}${text ? ` — ${text.slice(0, 200)}` : ""}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return { data: (await res.json()) as T, next: nextLinkOf(res.headers.get("link")), status: res.status };
  }
  throw new Error(`GitHub 속도 제한이 풀리지 않습니다 — ${url}`);
}

const statusOf = (e: unknown): number | undefined => (e as { status?: number })?.status;
const on = (v: string | undefined, dflt: boolean): boolean => { const s = String(v ?? "").trim().toLowerCase(); return s ? !["off", "false", "0", "no"].includes(s) : dflt; };

async function* pages<T>(token: string, first: string, label: string): AsyncGenerator<T[]> {
  let url: string | null = first;
  for (let n = 0; url && n < MAX_PAGES; n++) {
    const r: { data: T[]; next: string | null } = await ghGet<T[]>(token, url);
    yield Array.isArray(r.data) ? r.data : [];
    url = r.next;
    if (url && n === MAX_PAGES - 1) console.warn(`github: ${label} — 페이지 상한(${MAX_PAGES}) 도달, 나머지는 다음 run 이 이어갑니다`);
  }
}

export const githubConnector: Connector = {
  name: "github",

  async *backfill(opts?: BackfillOpts): AsyncIterable<RawItem> {
    const cfg = await resolveConnectorConfig("github");
    const token = cfg.token;
    if (!token) {
      throw new Error(
        "GitHub 토큰이 없습니다 — '토큰 출처'를 member:<구성원 id> 로 지정하거나(그 사람의 [GitHub 연결]/PAT 를 씁니다) 토큰 칸에 PAT 를 저장하세요.",
      );
    }
    const host = String(cfg.host ?? "").trim().toLowerCase() || "github.com";
    const base = apiBaseOf(host);
    const repos = parseRepoList(cfg.repos);
    if (repos.length === 0) {
      // #2232 — 범위가 비면 «전체»다(비공개 포함): 이 토큰이 볼 수 있는 저장소를 전부 훑는다.
      //  종전엔 여기서 죽었는데, 그 게이트는 «고르라»는 걸음을 모두에게 강요했다. 결정(원준님 2026-08-31):
      //  기본은 전부, 고르기는 옵션. 가시성의 울타리는 토큰 자체다 — 이 토큰이 못 보는 저장소는 목록에 안 나온다.
      for await (const page of pages<{ full_name?: string }>(
        token, `${base}/user/repos?per_page=${PAGE_SIZE}&affiliation=owner,collaborator,organization_member&sort=pushed`, "저장소 전체 열거")) {
        for (const r of page) {
          const seg = String(r.full_name ?? "").split("/");
          if (seg.length === 2 && seg[0] && seg[1]) repos.push({ owner: seg[0], repo: seg[1], full: String(r.full_name) });
        }
      }
      if (repos.length === 0) {
        throw new Error("이 토큰으로 볼 수 있는 저장소가 하나도 없습니다 — 토큰 허용범위(repo)를 확인하거나 '저장소'에 owner/repo 를 넣으세요.");
      }
    }
    const includePrs = on(cfg.include_prs, true);
    const includeReleases = on(cfg.include_releases, true);
    //  #2243 3차 — 설정한 «언제부터»가 커서보다 과거면 커서가 이긴다(sinceFloor).
    const sinceIso = sinceFloor(opts?.since, cfg.backfill_since);
    const since = sinceIso ? `&since=${encodeURIComponent(sinceIso)}` : "";
    const sinceMs = sinceIso ? Date.parse(sinceIso) : NaN;

    for (const repo of repos) {
      const rp = `${base}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
      try {
        // ① 이슈 + PR(이슈 API 는 PR 도 준다 — pull_request 필드로 가른다)
        for await (const page of pages<GhIssue>(token, `${rp}/issues?state=all&sort=updated&direction=asc&per_page=${PAGE_SIZE}${since}`, `${repo.full} issues`)) {
          for (const i of page) {
            if (!includePrs && i.pull_request) continue;
            yield issueItem(repo, host, i);
          }
        }
        // ② 이슈·PR 댓글(저장소 전체 한 번에 — 이슈마다 돌지 않는다)
        for await (const page of pages<GhComment>(token, `${rp}/issues/comments?sort=updated&direction=asc&per_page=${PAGE_SIZE}${since}`, `${repo.full} comments`)) {
          for (const c of page) { const it = commentItem(repo, host, c, false); if (it) yield it; }
        }
        // ③ PR 리뷰 댓글(코드 줄에 붙는 것)
        if (includePrs) {
          for await (const page of pages<GhComment>(token, `${rp}/pulls/comments?sort=updated&direction=asc&per_page=${PAGE_SIZE}${since}`, `${repo.full} review comments`)) {
            for (const c of page) { const it = commentItem(repo, host, c, true); if (it) yield it; }
          }
        }
        // ④ 릴리스 — since 가 없어 최근 100개를 받고 걸러낸다
        if (includeReleases) {
          const r = await ghGet<GhRelease[]>(token, `${rp}/releases?per_page=${PAGE_SIZE}`);
          for (const rel of Array.isArray(r.data) ? r.data : []) {
            if (rel.draft) continue;
            const t = Date.parse(rel.published_at ?? rel.created_at ?? "");
            if (Number.isFinite(sinceMs) && Number.isFinite(t) && t < sinceMs) continue;
            yield releaseItem(repo, host, rel);
          }
        }
      } catch (e) {
        // 저장소 하나가 없거나(404) 권한이 없어도(403/401) run 전체를 죽이지 않는다 — 나머지 저장소는 계속 받는다.
        //  ⚠ 단, 인증 자체가 틀린 401 은 모든 저장소가 같이 실패하므로 첫 저장소에서 바로 던진다(옛 토큰으로 조용히 0건 방지).
        const st = statusOf(e);
        if (st === 401) throw e;
        if (st === 404 || st === 403) { console.warn(`github: ${repo.full} 건너뜀 — ${(e as Error).message}`); continue; }
        throw e;
      }
    }
  },
};
