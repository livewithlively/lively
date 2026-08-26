// Figma 커넥터 (#1881 F5) — 디자인 파일의 **코멘트**를 canonical RawItem 으로.
//
// ── 왜 코멘트인가 ─────────────────────────────────────────────────────────────
//  피그마에서 조직의 맥락(무엇을 왜 이렇게 정했나 · 무엇이 반려됐나 · QA 가 뭘 지적했나)은 캔버스가 아니라
//  **코멘트**에 쌓인다. 특히 B2C 제품 조직은 기획·디자인 왕복을 코멘트로 한다.
//  그리고 이 경로는 MCP 로 대체할 수 없다 — 피그마 공식 MCP 가 노출하는 도구 25개에 **코멘트가 0개**다
//  (파일 열거도 0개). 그래서 수집은 REST 로만 성립한다.
//
// ── 왜 '어느 파일이냐' 가 이 커넥터의 전부인가 ───────────────────────────────
//  슬랙은 conversations.list 로 채널을 열거하고, 노션은 동의 화면의 페이지 선택기가 범위를 선언한다.
//  **피그마에는 둘 다 없다.** 파일 열거 엔드포인트(teams/projects·folders)는 공개 OAuth 앱에서 금지돼 있고
//  ("The projects endpoints cannot be used with public OAuth apps"), team_id 는 API 로 얻을 수조차 없다
//  ("It is not possible to programmatically obtain team IDs" — 사람이 팀 주소에서 복사해야 한다).
//  그래서 범위 선언을 사람이 **이미 하는 행동**에 얹는다:
//   · file_keys — 피그마 링크를 붙여넣는다(디자이너와 소통하는 기본 문법이라 컴맹도 한다). URL 그대로 넣어도 된다.
//   · team_ids  — 팀 주소에서 id 를 한 번 복사하면 그 팀 전체가 들어온다(관리자 1회).
//  둘은 배타가 아니라 합집합이다.
//
// ── 인증 ─────────────────────────────────────────────────────────────────────
//  개인 액세스 토큰(PAT, figd_…)을 X-Figma-Token 헤더로. 붙여넣기(token) 또는 금고(token_source).
//  ⚠ OAuth 가 아닌 이유: 라이블리 공개 OAuth 앱은 Figma 심사 대기이고(F3), 승인돼도 위 열거 제약을 받는다.
//   PAT 는 그 제약이 없어 **팀 전체 수집은 당분간 PAT 로만 성립한다.**
//  필요한 허용범위: file_comments:read · file_content:read · file_metadata:read · folders:read · current_user:read
//
// ── 증분 ─────────────────────────────────────────────────────────────────────
//  코멘트 created_at 기준. run-sync 가 max(occurred_at) 로 커서를 전진시킨다.
//  ⚠ 코멘트 본문은 불변이지만 **resolved_at 은 나중에 붙는다** — 증분 창 밖에서 해결된 스레드의 '해결됨'은
//   그 run 에서 못 잡는다. full 스윕(주기 재수집, 멱등 upsert)이 치유한다 — 슬랙 edited·노션 full 과 같은 패턴.
//  ⚠ 페이지네이션이 없다(피그마 comments API 는 커서를 주지 않는다) — 파일 하나의 코멘트를 통째로 받는다.
import type { Connector, RawItem, BackfillOpts } from "./types.js";
import { resolveConnectorConfig } from "./config.js";

const API = "https://api.figma.com/v1";

/** 공백·쉼표로 구분된 설정값 → 토큰 배열(빈 값 제거). */
export function splitList(v: string | undefined): string[] {
  return String(v ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * 피그마 링크(또는 raw key) → file key. **이 커넥터의 범위 선언 장치**라 순수 함수로 떼어 테스트한다.
 *  받아들이는 형태: /design/<key>/… · /file/<key>/… · /board/<key>/…(FigJam) · /slides/<key>/… · /proto/<key>/…
 *  그리고 key 자체(피그마 key 는 영숫자 22자 안팎 — 길이는 고정으로 보지 않는다).
 *  못 알아보면 null — 호출자가 경고하고 건너뛴다(조용한 무수집 방지).
 */
export function parseFigmaFileKey(input: string): string | null {
  const s = String(input ?? "").trim();
  if (!s) return null;
  if (/^[A-Za-z0-9]{10,64}$/.test(s)) return s; // raw key
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (!/(^|\.)figma\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/\/(?:design|file|board|slides|proto)\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

/** 사람이 열 수 있는 파일 주소 — 코멘트 앵커 형식은 피그마가 문서화하지 않아 파일까지만 만든다. */
export function figmaFileUrl(fileKey: string): string {
  return `https://www.figma.com/design/${fileKey}/`;
}

interface FigmaUser { id?: string; handle?: string; email?: string; img_url?: string }
interface FigmaCommentFragment { text?: string; mention?: string }
export interface FigmaComment {
  id: string;
  file_key?: string;
  parent_id?: string;
  user?: FigmaUser;
  created_at?: string;
  resolved_at?: string | null;
  message?: string;
  message_meta?: FigmaCommentFragment[];
  order_id?: string | number | null;
  client_meta?: unknown;
}

/** 코멘트 본문 — message 가 정본이고, 조각 배열(message_meta)만 오는 응답도 관용한다. */
export function figmaCommentText(c: FigmaComment): string {
  if (typeof c.message === "string" && c.message.trim()) return c.message;
  const frags = Array.isArray(c.message_meta) ? c.message_meta : [];
  return frags.map((f) => (typeof f?.text === "string" ? f.text : f?.mention ? "@" + f.mention : "")).join("").trim();
}

/**
 * 코멘트 1건 → RawItem. 순수(네트워크 불요)라 테스트가 매핑 규약을 직접 본다.
 *  자료의 단위는 **코멘트 1건**이고, 스레드는 parent_external_id 로 이어진다(피그마 답글은 1단이라 트리가 얕다).
 */
export function figmaCommentToItem(
  fileKey: string, fileName: string | undefined, c: FigmaComment, instance?: string,
): RawItem {
  const body = figmaCommentText(c);
  return {
    // ⚠ "comment" 가 아니다 — RawItem.type 은 **적재 라우팅 축**이고 그 이름은 이미 PM 이 점유했다:
    //  routeIngestV6 의 `if (type === "comment") return "pm_comment"` 는 ClickUp **태스크 코멘트** 전용이라,
    //  피그마 코멘트를 그 이름으로 뱉으면 부모 태스크를 못 찾아 **조용히 버려진다**(2026-08-26 실측:
    //  수집 run 은 status=ok·ingested=4 인데 source 0건). 자료로 남을 것은 message/note 다.
    //  피그마 코멘트는 실제로도 message 류다 — 사람이 남긴 자유 텍스트 + 작성자 + 스레드.
    type: "message",
    provenance: {
      category: "collab_tool",
      system: "figma",
      instance: instance || undefined,
      external_id: `${fileKey}:${c.id}`,
      external_url: figmaFileUrl(fileKey),
    },
    actor: c.user?.id || c.user?.handle
      ? { external_id: c.user?.id, display_name: c.user?.handle, email: c.user?.email }
      : undefined,
    container_ref: fileKey,
    container_name: fileName || undefined,
    parent_external_id: c.parent_id ? `${fileKey}:${c.parent_id}` : undefined,
    body,
    occurred_at: c.created_at || undefined,
    updated_at: c.resolved_at || c.created_at || undefined,
    fields: {
      comment_id: c.id,
      file_key: fileKey,
      file_name: fileName ?? null,
      // 해결됨 = 결론이 난 스레드. 증류기가 '결정'을 고를 때 쓰는 가장 강한 신호다.
      resolved: !!c.resolved_at,
      resolved_at: c.resolved_at ?? null,
      order_id: c.order_id ?? null,
      is_reply: !!c.parent_id,
    },
    raw: c,
  };
}

/** 이름 패턴 제외(대소문자 무시 부분일치) — 'archive' 처럼 훑고 싶지 않은 파일을 뺀다. */
export function isExcludedFile(name: string | undefined, patterns: string[]): boolean {
  if (!patterns.length) return false;
  const n = String(name ?? "").toLowerCase();
  return patterns.some((p) => n.includes(p.toLowerCase()));
}

const strOf = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * 응답에서 배열을 찾는다 — 후보 키를 순서대로, 없으면 `meta` 한 겹 아래까지.
 *  왜 관용적인가: 피그마 v2 folders 응답 스키마가 **문서에 없다**(2026-08-26 확인). 키를 하나로 단정하면
 *  상류가 `{meta:{folders}}` 같은 형태일 때 조용히 '0개'가 되고, 그건 이 트랙에서 이미 한 번 물린 실패 모드다.
 *  못 찾으면 호출부가 응답 키 목록을 경고에 실어 사람이 바로 원인을 본다.
 */
function pickArray(r: Record<string, unknown>, keys: string[]): Array<Record<string, unknown>> {
  const meta = (r.meta && typeof r.meta === "object" ? r.meta : null) as Record<string, unknown> | null;
  for (const k of keys) {
    for (const src of [r, meta]) {
      const v = src?.[k];
      if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    }
  }
  return [];
}

async function figmaGet<T>(token: string, path: string): Promise<T> {
  // path 가 /v2 로 시작하면 버전 접두를 갈아 끼운다(API 상수는 /v1). 피그마는 엔드포인트마다 버전이 다르다.
  const url = path.startsWith("/v2/") ? `https://api.figma.com${path}` : `${API}${path}`;
  const res = await fetch(url, { headers: { "X-Figma-Token": token } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Figma ${res.status} ${path}${text ? ` — ${text.slice(0, 200)}` : ""}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

const statusOf = (e: unknown): number | undefined => (e as { status?: number })?.status;

export const figmaConnector: Connector = {
  name: "figma",

  async *backfill(opts?: BackfillOpts): AsyncIterable<RawItem> {
    const cfg = await resolveConnectorConfig("figma");
    const token = cfg.token;
    if (!token) {
      throw new Error(
        "Figma 토큰이 없습니다 — 관리탭 ▸ 외부 자료 수집 ▸ Figma 에 개인 액세스 토큰(figd_…)을 저장하거나, " +
        "'토큰 출처'를 org / member:<구성원 id> 로 지정하세요(자격 금고의 figma_token 을 씁니다).",
      );
    }
    const sinceMs = opts?.since && Number.isFinite(Date.parse(opts.since)) ? Date.parse(opts.since) : undefined;
    const exclude = splitList(cfg.exclude_files);

    // ── ① 범위 수집 — 링크(직접 지정) ∪ 팀 전체 ─────────────────────────────
    const files = new Map<string, string | undefined>(); // fileKey → fileName(모르면 undefined)

    for (const raw of splitList(cfg.file_keys)) {
      const k = parseFigmaFileKey(raw);
      if (k) files.set(k, files.get(k));
      else console.warn(`figma: 파일 링크를 알아볼 수 없습니다 — ${raw}`);
    }

    const teamIds = splitList(cfg.team_ids);
    for (const teamId of teamIds) {
      // ⚠ v1 `/teams/:id/projects` 가 아니다 — 그 엔드포인트는 **구 스코프 `projects:read` 를 요구**한다.
      //  granular scope(folders:read 등)만 켠 PAT 로 부르면 403 이고, 응답이 그 사실을 정확히 말해 준다(2026-08-26 실측):
      //   "Invalid scope(s): …folders:read… This endpoint requires the projects:read scope"
      //  문서는 folders:read 가 projects:read 를 '대체한다'고 하지만 그건 **v2 folders 엔드포인트 이야기**다.
      //  그래서 열거는 v2 로만 한다 — 우리가 안내하는 스코프 5종과 짝이 맞는 유일한 경로.
      let projects: Array<{ id: string; name?: string }> = [];
      try {
        const r = await figmaGet<Record<string, unknown>>(token, `/v2/teams/${encodeURIComponent(teamId)}/folders`);
        projects = pickArray(r, ["folders", "projects"]).map((f) => ({ id: String(f.id ?? ""), name: strOf(f.name) })).filter((f) => f.id);
        if (!projects.length) console.warn(`figma: 팀 ${teamId} 에서 폴더를 못 찾았습니다 — 응답 키: ${Object.keys(r).join(",") || "(없음)"}`);
      } catch (e) {
        // 팀 하나가 막혀도 나머지는 계속 — 단 401 은 토큰 자체가 죽은 것이라 전체를 세운다(조용한 무수집 방지).
        if (statusOf(e) === 401 || statusOf(e) === 403) {
          throw new Error(`Figma 토큰이 팀 ${teamId} 에 접근할 수 없습니다(${statusOf(e)}) — 토큰 허용범위에 folders:read 가 있는지, 그 팀의 멤버인지 확인하세요. 원문: ${(e as Error).message}`);
        }
        console.warn(`figma: 팀 ${teamId} 프로젝트 목록 실패 — ${(e as Error).message}`);
        continue;
      }
      for (const p of projects) {
        try {
          const r = await figmaGet<Record<string, unknown>>(token, `/v2/folders/${encodeURIComponent(p.id)}/files`);
          const got = pickArray(r, ["files"]);
          if (!got.length) console.warn(`figma: 폴더 ${p.id}(${p.name ?? ""})에서 파일을 못 찾았습니다 — 응답 키: ${Object.keys(r).join(",") || "(없음)"}`);
          for (const f of got) {
            const key = strOf(f.key) ?? strOf(f.file_key);
            if (!key) continue;
            const name = strOf(f.name);
            if (isExcludedFile(name, exclude)) continue;
            files.set(key, name);
          }
        } catch (e) {
          console.warn(`figma: 폴더 ${p.id}(${p.name ?? ""}) 파일 목록 실패 — ${(e as Error).message}`);
        }
      }
    }

    if (files.size === 0) {
      throw new Error(
        "수집할 피그마 파일이 없습니다 — '파일 링크'에 피그마 주소를 붙여넣거나 '팀 id'를 지정하세요. " +
        "팀 id 는 피그마에서 팀을 연 주소(figma.com/files/team/<여기>/…)에서 복사합니다.",
      );
    }

    // ── ② 파일별 코멘트 ────────────────────────────────────────────────────
    const instance = teamIds[0] || undefined; // 워크스페이스 축(팀이 여럿이면 첫 팀 — 수집기를 팀당 하나 두는 것을 권장)
    for (const [fileKey, known] of files) {
      let fileName = known;
      if (!fileName) {
        // 링크로만 지정된 파일은 이름을 모른다 — 채널명(container_name)이 비면 지식화 맥락이 준다(#735).
        try {
          const meta = await figmaGet<{ name?: string }>(token, `/files/${encodeURIComponent(fileKey)}?depth=1`);
          fileName = meta.name;
        } catch { /* 이름은 있으면 좋은 것 — 실패해도 코멘트는 받는다 */ }
      }
      if (isExcludedFile(fileName, exclude)) continue;

      let comments: FigmaComment[] = [];
      try {
        const r = await figmaGet<{ comments?: FigmaComment[] }>(token, `/files/${encodeURIComponent(fileKey)}/comments`);
        comments = r.comments ?? [];
      } catch (e) {
        const st = statusOf(e);
        if (st === 401) throw new Error(`Figma 토큰이 거부됐습니다(401) — 토큰이 만료·삭제됐을 수 있습니다. 다시 발급해 저장하세요.`);
        // 404/403 = 삭제됐거나 권한이 없는 파일. 그 파일만 건너뛴다(전체 run 을 죽이지 않는다).
        console.warn(`figma: 파일 ${fileKey}${fileName ? `(${fileName})` : ""} 코멘트 실패 — ${(e as Error).message}`);
        continue;
      }

      for (const c of comments) {
        if (!c?.id) continue;
        if (sinceMs && c.created_at && Date.parse(c.created_at) <= sinceMs) continue;
        const item = figmaCommentToItem(fileKey, fileName, c, instance);
        if (!item.body) continue; // 본문이 빈 코멘트(스티커·이모지만)는 지식이 되지 않는다
        yield item;
      }
    }
  },
};
