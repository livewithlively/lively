// «모아 두기» 범위 선택지 — 그 사람의 자격으로 **외부 앱에 들어가지 않고** 고를 수 있는 목록을 만든다(#2243).
//
// ── 왜 필요한가 ────────────────────────────────────────────────────────────────
//  범위를 정하는 최소 단위(저장소·프로젝트·팀·파일·리스트·채널)는 앱마다 다른데, 그중 **동의 화면에서 고르게
//  해 주는 앱은 셋뿐**이다(노션 페이지 선택기 · GitHub 저장소 선택기 · ClickUp OAuth 워크스페이스).
//  나머지는 «전부 아니면 전무»로 동의하므로 «어디까지 모을지»는 우리 화면이 책임진다 — 그런데 지금은
//  사용자가 `owner/repo`·`group/project`·팀 키를 **외워서 손으로 친다**(조사 knowledge collector-scope-personalization-per-app-2243).
//  그래서 그 사람의 토큰으로 목록을 조회해 **토글로 고르게** 한다. 앱을 열어 id 를 복사해 오는 왕복을 없앤다.
//
// ── 규약 ───────────────────────────────────────────────────────────────────────
//  · 조회는 **읽기 전용**이고 그 사람이 이미 연결한 자격만 쓴다(우리가 권한을 넓히지 않는다).
//  · 목록을 못 만들면 **에러가 아니라 `freeform: true` + note** 다 — 화면은 텍스트 입력으로 떨어져 계속 쓸 수 있다
//    (피그마 팀 id 미지정처럼 «원래 불가능한» 경우가 실제로 있다).
//  · 반환 `key` 는 수집기 config 의 스코프 키와 같은 이름이다 — 화면이 그대로 `scope` 로 되돌려 보낸다.
import { resolveFigmaTokenSource, figmaVaultReader } from "./credentials/figma-token-source.js";
import { resolvePlainTokenSource, plainVaultReader, CLICKUP_TOKEN_KIND, CLICKUP_TOKEN_SPEC } from "./credentials/plain-token-source.js";
import { resolveGithubTokenSource, githubVaultDeps } from "./credentials/github-token-source.js";
import { resolveGitlabTokenSource, gitlabVaultDeps } from "./credentials/gitlab-token-source.js";
import { resolveLinearTokenSource, linearVaultDeps } from "./credentials/linear-token-source.js";
import { resolveSlackTokenSource, vaultReader as slackVaultReader } from "./credentials/slack-token-source.js";
import { listGithub, listGitlab } from "./repo-discover.js";
import { listCollectors } from "./store/collectors.js";
import { LINEAR_GRAPHQL_URL } from "./credentials/linear-oauth.js";

/** 고를 수 있는 한 칸. id 가 곧 저장되는 값(그 앱의 최소 단위). */
export interface ScopeOption { id: string; label: string; hint?: string }
export interface ScopeOptionsResult {
  /** 수집기 config 의 스코프 키 — 화면이 그대로 scope 로 되돌려 보낸다. */
  key: string;
  /** 사람이 읽는 단위 이름(«저장소»·«팀»). 화면 문구가 이걸 쓴다. */
  unit: string;
  options: ScopeOption[];
  /** true = 목록을 못 만들었다 → 화면은 텍스트 입력으로. 이유는 note. */
  freeform: boolean;
  note?: string;
  /** 비우면 전체가 되는 앱인가(Linear 팀처럼). false 면 최소 하나를 골라야 한다. */
  emptyMeansAll: boolean;
}

const MEMBER = (id: string): string => `member:${id}`;

/** 그 앱의 수집기 인스턴스에 저장된 config(범위·호스트 등) — 조회에 필요한 값(피그마 team_ids 등)을 얻는다. */
async function collectorConfig(preset: string): Promise<Record<string, string>> {
  const all = await listCollectors().catch(() => []);
  const inst = all.find((c) => c.preset_key === preset && c.instance_key === "lively-member")
    ?? all.find((c) => c.preset_key === preset);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inst?.config ?? {})) if (typeof v === "string") out[k] = v;
  return out;
}

const free = (key: string, unit: string, note: string, emptyMeansAll = false): ScopeOptionsResult =>
  ({ key, unit, options: [], freeform: true, note, emptyMeansAll });

// ── GitHub — 그 사람이 볼 수 있는 저장소(설치로 열린 것 우선 표시). ──
async function githubOptions(memberId: string): Promise<ScopeOptionsResult> {
  const r = await resolveGithubTokenSource(MEMBER(memberId), "github.com", githubVaultDeps);
  if (!r?.token) return free("repos", "저장소", r?.warning ?? "GitHub 연결이 없습니다.");
  const { options } = await listGithub("github.com", r.token);
  return {
    key: "repos", unit: "저장소", emptyMeansAll: false, freeform: false,
    options: options.map((o) => ({ id: o.full_path, label: o.full_path, hint: o.private ? "비공개" : undefined })),
    note: options.length ? undefined : "볼 수 있는 저장소가 없습니다 — [계정으로 연결]에서 저장소를 고르셨는지 확인해 주세요.",
  };
}

// ── GitLab — 멤버십 있는 프로젝트(Reporter 이상 = 읽을 수 있는 것). ──
async function gitlabOptions(memberId: string): Promise<ScopeOptionsResult> {
  const cfg = await collectorConfig("gitlab");
  const r = await resolveGitlabTokenSource(MEMBER(memberId), cfg.host, gitlabVaultDeps);
  if (!r?.token) return free("projects", "프로젝트", r?.warning ?? "GitLab 개인 토큰이 없습니다.");
  const { options } = await listGitlab(r.host ?? "gitlab.com", r.token);
  return {
    key: "projects", unit: "프로젝트", emptyMeansAll: false, freeform: false,
    options: options.map((o) => ({ id: o.full_path, label: o.full_path, hint: o.private ? "비공개" : undefined })),
    note: options.length ? undefined : "볼 수 있는 프로젝트가 없습니다 — 토큰 범위(read_api)를 확인해 주세요.",
  };
}

// ── Linear — 내가 속한 팀(비공개 팀은 애초에 토큰에 안 보인다). ──
async function linearOptions(memberId: string): Promise<ScopeOptionsResult> {
  const r = await resolveLinearTokenSource(MEMBER(memberId), linearVaultDeps);
  if (!r?.token) return free("teams", "팀", r?.warning ?? "Linear 연결이 없습니다.", true);
  const res = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${r.token}` },
    body: JSON.stringify({ query: "query Teams { teams(first: 250) { nodes { key name } } }" }),
  });
  if (!res.ok) return free("teams", "팀", `Linear 목록을 불러오지 못했습니다(${res.status}).`, true);
  const j = (await res.json()) as { data?: { teams?: { nodes?: Array<{ key?: string; name?: string }> } } };
  const nodes = j.data?.teams?.nodes ?? [];
  return {
    key: "teams", unit: "팀", emptyMeansAll: true, freeform: false,
    options: nodes.filter((t) => t.key).map((t) => ({ id: String(t.key), label: t.name ? `${t.name} (${t.key})` : String(t.key) })),
    note: nodes.length ? undefined : "속한 팀이 없습니다.",
  };
}

// ── Figma — 팀 id 를 아는 경우에만 그 팀의 파일을 나열할 수 있다(공개 OAuth 는 열거 자체가 금지, team_id 는 API 로 못 얻는다). ──
async function figmaOptions(memberId: string): Promise<ScopeOptionsResult> {
  const r = await resolveFigmaTokenSource(MEMBER(memberId), figmaVaultReader);
  if (!r?.token) return free("file_keys", "파일", r?.warning ?? "Figma 토큰이 없습니다.");
  const cfg = await collectorConfig("figma");
  const teamIds = String(cfg.team_ids ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (teamIds.length === 0) {
    return free("file_keys", "파일",
      "피그마는 팀 목록을 API 로 주지 않아요 — 팀 주소(figma.com/files/team/<id>/…)의 id 를 한 번 넣으면 그 팀의 파일을 여기서 고를 수 있어요. 그 전엔 파일 링크를 붙여넣으세요.");
  }
  const get = async <T>(path: string): Promise<T | null> => {
    const res = await fetch(`https://api.figma.com${path}`, { headers: { "X-Figma-Token": r.token as string } });
    return res.ok ? ((await res.json()) as T) : null;
  };
  const options: ScopeOption[] = [];
  for (const teamId of teamIds.slice(0, 5)) {
    const folders = await get<Record<string, unknown>>(`/v2/teams/${encodeURIComponent(teamId)}/folders`);
    const list = (folders?.folders ?? (folders?.meta as Record<string, unknown> | undefined)?.folders ?? []) as Array<Record<string, unknown>>;
    for (const f of Array.isArray(list) ? list.slice(0, 30) : []) {
      const fid = String(f.id ?? "");
      if (!fid) continue;
      const files = await get<Record<string, unknown>>(`/v2/folders/${encodeURIComponent(fid)}/files`);
      const fl = (files?.files ?? (files?.meta as Record<string, unknown> | undefined)?.files ?? []) as Array<Record<string, unknown>>;
      for (const file of Array.isArray(fl) ? fl : []) {
        const key = String(file.key ?? "");
        if (!key) continue;
        options.push({ id: key, label: String(file.name ?? key), hint: String(f.name ?? "") || undefined });
      }
    }
  }
  return {
    key: "file_keys", unit: "파일", emptyMeansAll: false, freeform: false, options,
    note: options.length ? undefined : "그 팀에서 파일을 찾지 못했습니다 — 토큰에 folders:read 허용범위가 있는지 확인해 주세요.",
  };
}

// ── ClickUp — 워크스페이스 → 스페이스 → (폴더) → 리스트. ──
async function clickupOptions(memberId: string): Promise<ScopeOptionsResult> {
  const r = await resolvePlainTokenSource(MEMBER(memberId), plainVaultReader(CLICKUP_TOKEN_KIND), CLICKUP_TOKEN_SPEC);
  if (!r?.token) return free("include_list_ids", "리스트", r?.warning ?? "ClickUp 토큰이 없습니다.", true);
  const api = async <T>(path: string): Promise<T | null> => {
    const res = await fetch(`https://api.clickup.com/api/v2${path}`, { headers: { Authorization: r.token as string } });
    return res.ok ? ((await res.json()) as T) : null;
  };
  const teams = await api<{ teams?: Array<{ id?: string; name?: string }> }>("/team");
  const team = teams?.teams?.[0];
  if (!team?.id) return free("include_list_ids", "리스트", "ClickUp 워크스페이스를 찾지 못했습니다.", true);
  const spaces = await api<{ spaces?: Array<{ id?: string; name?: string }> }>(`/team/${team.id}/space?archived=false`);
  const options: ScopeOption[] = [];
  for (const sp of (spaces?.spaces ?? []).slice(0, 20)) {
    if (!sp.id) continue;
    const direct = await api<{ lists?: Array<{ id?: string; name?: string }> }>(`/space/${sp.id}/list?archived=false`);
    for (const l of direct?.lists ?? []) if (l.id) options.push({ id: String(l.id), label: String(l.name ?? l.id), hint: sp.name ?? undefined });
    const folders = await api<{ folders?: Array<{ id?: string; name?: string; lists?: Array<{ id?: string; name?: string }> }> }>(`/space/${sp.id}/folder?archived=false`);
    for (const fo of folders?.folders ?? []) {
      for (const l of fo.lists ?? []) if (l.id) options.push({ id: String(l.id), label: String(l.name ?? l.id), hint: `${sp.name ?? ""} / ${fo.name ?? ""}`.trim() });
    }
  }
  return { key: "include_list_ids", unit: "리스트", emptyMeansAll: true, freeform: false, options,
    note: options.length ? undefined : "리스트가 없거나 토큰 권한이 부족합니다." };
}

// ── Slack — 그 사람이 볼 수 있는 공개 채널(수집은 공개 채널만 한다 — DM·비공개는 코드가 배제). ──
async function slackOptions(memberId: string): Promise<ScopeOptionsResult> {
  const r = await resolveSlackTokenSource(MEMBER(memberId), slackVaultReader);
  const token = r?.user_token;
  if (!token) return free("channels", "채널", r?.warning ?? "Slack 연결이 없습니다.", true);
  const options: ScopeOption[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const u = new URL("https://slack.com/api/conversations.list");
    u.searchParams.set("types", "public_channel");
    u.searchParams.set("exclude_archived", "true");
    u.searchParams.set("limit", "200");
    if (cursor) u.searchParams.set("cursor", cursor);
    const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    const j = (await res.json().catch(() => null)) as
      { ok?: boolean; error?: string; channels?: Array<{ id?: string; name?: string; num_members?: number }>; response_metadata?: { next_cursor?: string } } | null;
    if (!j?.ok) return free("channels", "채널", `슬랙 채널 목록을 불러오지 못했습니다(${j?.error ?? "알 수 없음"}).`, true);
    for (const c of j.channels ?? []) {
      if (!c.name) continue;
      options.push({ id: c.name, label: `#${c.name}`, hint: c.num_members ? `${c.num_members}명` : undefined });
    }
    cursor = j.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  options.sort((a, b) => a.label.localeCompare(b.label));
  return { key: "channels", unit: "채널", emptyMeansAll: true, freeform: false, options };
}

const PROVIDERS: Record<string, (memberId: string) => Promise<ScopeOptionsResult>> = {
  github: githubOptions, gitlab: gitlabOptions, linear: linearOptions,
  figma: figmaOptions, clickup: clickupOptions, slack: slackOptions,
};

export function scopeOptionsSupported(system: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, String(system ?? "").toLowerCase());
}

/**
 * 그 사람의 자격으로 이 앱의 «고를 수 있는 것» 목록을 만든다.
 *  ⚠ 조회 실패는 던지지 않는다 — freeform 으로 떨어뜨려 화면이 텍스트 입력으로 계속 동작하게 한다
 *   (목록이 안 뜬다고 «범위를 못 정하는» 막다른 길이 되면 안 된다).
 */
export async function collectScopeOptions(system: string, memberId: string): Promise<ScopeOptionsResult> {
  const key = String(system ?? "").toLowerCase();
  const fn = PROVIDERS[key];
  if (!fn) return free("", "", "이 앱은 목록 조회를 지원하지 않습니다.");
  try {
    return await fn(memberId);
  } catch (e) {
    const unit = key === "slack" ? "채널" : key === "linear" ? "팀" : key === "clickup" ? "리스트" : key === "figma" ? "파일" : key === "gitlab" ? "프로젝트" : "저장소";
    return free("", unit, `목록을 불러오지 못했습니다 — ${(e as Error).message}`);
  }
}
