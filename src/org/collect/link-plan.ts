// 링크 따라 읽기(#4213 T12 #4744) — 판정(순수). 글 속 주소 → 앱 링크 · 링크로 읽은 결과를 받아들이나 · 다음 판에 실을 링크의 지시 줄.
//  조회·저장은 link-store.ts, 거두기는 collect-plan.harvestUnits, 저장 단계는 run-ingest.
//
//  ── 확정(상민님 2026-10-15 «트리거 최종 확정» — 지식 connect-collect-tobe-claude-connector-4213 §6-2) ──
//   · 같은 앱의 아직 안 모은 문서 링크는 그 실행에서 바로 읽는다(처음 수집 기간보다 오래된 문서 · 단위 범위 밖 문서 — 링크됐다는 것이 중요도 신호).
//   · 다른 연결된 앱의 링크는 기록해 두고 그 앱 단위의 다음 수집 때 읽는다.
//   · 연결 안 된 앱의 링크는 세어 연결 제안에 쓴다(«노션 링크 412번 — 연결할까요?»).
//  ── 다온 판단(상민님 확인 전) ──
//   · 받아들이는 읽기는 «이번 판에 모은 글 속 링크가 가리키는 문서» 와 «계획에 실은 링크» 뿐이다 — 모델이 아무 문서나 읽어 저장하지 않게.
//   · 링크로 읽은 문서는 링크가 있던 단위가 아니라 **그 문서의 단위**에 저장한다(저장 단계) — 공개 채널이 비공개 페이지를 링크해도 채널을 보는
//     사람에게 그 페이지가 열리지 않게.

/** 글에서 찾은 앱 링크 하나. */
export interface AppLink {
  /** 앱 이름표 — 수집 단위 앱(slack · notion · gmail · gdrive)이거나 셈만 하는 앱(github · figma …). */
  app: string;
  /** 그 앱 안의 대상 — notion 페이지 uuid · slack «채널:ts» · gdrive 파일 id · 그 밖은 정규화한 주소(호스트 + 경로). */
  ref: string;
  /** 정규화한 주소(조각 · 추적 인자를 뗀 것) — 서버 안 표에만 둔다. */
  url: string;
  kind: "page" | "message" | "document" | "file" | "folder" | "other";
  /** slack — 그 메시지의 채널 · ts · 읽을 스레드(부모) ts(주소의 thread_ts, 없으면 ts). */
  channel?: string;
  ts?: string;
  thread?: string;
}

/** 글 하나에서 보는 링크 상한 — 링크만 수천 개인 글(목록 붙여 넣기)이 저장 단계를 붙잡지 않게. */
export const LINKS_PER_TEXT = 200;
/** 판마다 단위 하나에서 받아들이는 같은 앱 링크 읽기 상한(지시와 같은 값). */
export const SAME_APP_LINKS_PER_UNIT = 3;
/** 다음 판에 싣는 다른 앱 링크 상한. */
export const PLANNED_LINKS_PER_RUN = 5;

const URL_RE = /https?:\/\/[^\s<>"'`[\](){}|\\^]+/gi;
const TRAIL = /[.,;:!?»」』’”'*_~]+$/;
const HEX32 = /^[0-9a-f]{32}$/i;
const SLACK_CHAN = /^[CGD][A-Z0-9]{6,}$/;

/** 셈만 하는 앱 — 호스트(끝맞춤) → 이름표. 연결 제안 문구에 쓰는 이름표다(사람 말 이름은 화면이 붙인다). */
const HOST_APPS: ReadonlyArray<[RegExp, string]> = [
  [/(^|\.)github\.com$/, "github"], [/(^|\.)gitlab\.com$/, "gitlab"], [/(^|\.)figma\.com$/, "figma"], [/(^|\.)linear\.app$/, "linear"],
  [/(^|\.)atlassian\.net$/, "atlassian"], [/(^|\.)trello\.com$/, "trello"], [/(^|\.)asana\.com$/, "asana"], [/(^|\.)clickup\.com$/, "clickup"],
  [/(^|\.)monday\.com$/, "monday"], [/(^|\.)airtable\.com$/, "airtable"], [/(^|\.)miro\.com$/, "miro"], [/(^|\.)dropbox\.com$/, "dropbox"],
  [/(^|\.)sharepoint\.com$/, "microsoft365"], [/^onedrive\.live\.com$/, "microsoft365"], [/(^|\.)box\.com$/, "box"],
  [/(^|\.)jandi\.com$/, "jandi"], [/(^|\.)dooray\.com$/, "dooray"], [/(^|\.)worksmobile\.com$/, "naverworks"], [/^works\.naver\.com$/, "naverworks"],
  [/(^|\.)channel\.io$/, "channeltalk"], [/(^|\.)flex\.team$/, "flex"], [/(^|\.)zendesk\.com$/, "zendesk"], [/(^|\.)hubspot\.com$/, "hubspot"],
  [/(^|\.)intercom\.com$/, "intercom"], [/(^|\.)sentry\.io$/, "sentry"], [/(^|\.)canva\.com$/, "canva"], [/(^|\.)webflow\.com$/, "webflow"],
  [/(^|\.)zotero\.org$/, "zotero"],
];

/** 노션 페이지 id(32자리 → 대시 붙인 소문자 uuid). */
const dashed = (hex: string): string => {
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
/** 경로 조각 끝의 32자리(«제목-<32자리>» · «<32자리>» · 대시 붙인 uuid). */
const tailHex = (seg: string): string | null => {
  const s = seg.replace(/-/g, "");
  const m = /([0-9a-f]{32})$/i.exec(s);
  return m ? m[1] : null;
};
/** 슬랙 ts — «p» 뒤 16자리 → «앞 10.뒤 6», 이미 점이 있으면 그대로. */
const slackTs = (s: string | null): string | null => {
  if (!s) return null;
  if (/^\d{10}\.\d{6}$/.test(s)) return s;
  const d = /^p?(\d{16})$/.exec(s)?.[1];
  return d ? `${d.slice(0, 10)}.${d.slice(10)}` : null;
};

/** 주소 하나 → 앱 링크(앱 링크가 아니면 null). */
export function classifyUrl(raw: string): AppLink | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/\/+$/, "");
  const clean = `https://${host}${path}`;
  if (/(^|\.)notion\.(so|site)$/.test(host)) {
    const p = u.searchParams.get("p");
    const hex = p && HEX32.test(p.replace(/-/g, "")) ? p.replace(/-/g, "") : tailHex(path.split("/").filter(Boolean).pop() ?? "");
    if (!hex) return null;
    const ref = dashed(hex);
    return { app: "notion", ref, url: `https://www.notion.so/${hex.toLowerCase()}`, kind: "page" };
  }
  if (/(^|\.)slack\.com$/.test(host)) {
    const m = /^\/archives\/([A-Z0-9]+)\/(p\d{16})$/.exec(path);
    if (!m || !SLACK_CHAN.test(m[1])) return null;
    const ts = slackTs(m[2]);
    if (!ts) return null;
    const thread = slackTs(u.searchParams.get("thread_ts")) ?? ts;
    return { app: "slack", ref: `${m[1]}:${ts}`, url: `${clean}`, kind: "message", channel: m[1], ts, thread };
  }
  if (host === "docs.google.com") {
    const m = /^\/(document|spreadsheets|presentation|forms|drawings)\/d\/([A-Za-z0-9_-]{10,})/.exec(path);
    return m ? { app: "gdrive", ref: m[2], url: `https://docs.google.com/${m[1]}/d/${m[2]}`, kind: "document" } : null;
  }
  if (host === "drive.google.com") {
    const f = /^\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(path);
    if (f) return { app: "gdrive", ref: f[1], url: `https://drive.google.com/file/d/${f[1]}`, kind: "file" };
    const d = /^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})/.exec(path);
    if (d) return { app: "gdrive", ref: d[1], url: `https://drive.google.com/drive/folders/${d[1]}`, kind: "folder" };
    const id = u.searchParams.get("id");
    return id && /^[A-Za-z0-9_-]{10,}$/.test(id) ? { app: "gdrive", ref: id, url: `https://drive.google.com/open?id=${id}`, kind: "file" } : null;
  }
  if (host === "mail.google.com") return { app: "gmail", ref: clean, url: clean, kind: "message" };
  for (const [re, app] of HOST_APPS) {
    if (re.test(host)) return path ? { app, ref: `${host}${path}`.toLowerCase(), url: clean, kind: "other" } : null;
  }
  return null;
}

/** 글 → 앱 링크(같은 링크는 한 번 · 글 하나에 LINKS_PER_TEXT 개까지). 슬랙 «<주소|글>» · 마크다운 «[글](주소)» · 끝 문장부호를 다룬다. */
export function extractAppLinks(text: string | null | undefined): AppLink[] {
  const s = String(text ?? "");
  if (!s) return [];
  const out: AppLink[] = [];
  const seen = new Set<string>();
  let n = 0;
  for (const m of s.matchAll(URL_RE)) {
    if (++n > LINKS_PER_TEXT) break;
    const l = classifyUrl(m[0].replace(TRAIL, ""));
    if (!l) continue;
    const k = linkKey(l);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

/** 링크의 열쇠(앱 + 대상). */
export const linkKey = (l: Pick<AppLink, "app" | "ref">): string => `${l.app}\u0001${l.ref}`;

/**
 * 링크로 읽은 결과의 대상 — 노션 페이지 uuid · 슬랙 «채널 + 스레드(부모) ts + 그 스레드에서 본 글 ts 들». 받아들일지는 matchLinkedRead 가 정한다.
 *  tss 는 thread_ts 없이 답글을 가리킨 링크(그 링크의 ts 는 답글 ts 다)도 맞추려고 싣는다.
 */
export type LinkedTarget = { app: "notion"; ref: string } | { app: "slack"; channel: string; thread: string; tss?: readonly string[] };

/**
 * 계획 밖 읽기 하나가 «링크로 읽은 것» 인가 — 이번 판 글 속 링크(sameRun) 또는 계획에 실은 링크(planned) 가운데 그 대상을 가리키는 링크가
 *  있어야 한다. 슬랙은 링크의 스레드(부모 ts) 또는 메시지 ts 가 읽은 스레드와 같으면 맞다(링크가 답글을 가리켜도 스레드를 읽는다).
 *  돌려주는 것: 맞은 링크와 어디서 왔나(planned 가 먼저).
 */
/** 맞추기에 쓰는 칸만 — 글에서 찾은 링크(AppLink)와 계획에 실은 링크(주소 없음) 둘 다 받는다. */
export type LinkLike = Pick<AppLink, "app" | "ref" | "channel" | "ts" | "thread">;

export function matchLinkedRead<S extends LinkLike, P extends LinkLike>(target: LinkedTarget, links: { sameRun: readonly S[]; planned: readonly P[] }):
  { link: S | P; via: "planned" | "same-run" } | null {
  const hit = (l: LinkLike) => target.app === "notion"
    ? l.app === "notion" && l.ref === target.ref
    : l.app === "slack" && l.channel === target.channel
      && (l.thread === target.thread || l.ts === target.thread || (!!l.ts && !!target.tss?.includes(l.ts)));
  const p = links.planned.find(hit);
  if (p) return { link: p, via: "planned" };
  const s = links.sameRun.find(hit);
  return s ? { link: s, via: "same-run" } : null;
}

/** 다음 판에 싣는 링크 한 줄(서버가 고른다) — 앱마다 정확한 도구·인자. 모르는 앱이면 null(싣지 않는다). */
export function plannedLinkInstruction(l: Pick<AppLink, "app" | "ref" | "channel" | "thread">): string | null {
  if (l.app === "notion" && /^[0-9a-f-]{36}$/.test(l.ref)) return `· 링크로 찾은 노션 페이지: notion-fetch 를 id="${l.ref}" 로 한 번 부른다.`;
  if (l.app === "slack" && l.channel && SLACK_CHAN.test(l.channel) && l.thread && /^\d{10}\.\d{6}$/.test(l.thread)) {
    return `· 링크로 찾은 슬랙 메시지: slack_read_thread 를 channel_id="${l.channel}", message_ts="${l.thread}", limit=200 으로 한 번 부른다.`;
  }
  return null;
}

/** 노션 단위 ref 의 꼴(collect-plan 의 NOTION_REF 와 같다 — 단위 표에 들어간 페이지 uuid). 지시에 그대로 적으므로 이 꼴만 받는다. */
const NOTION_UNIT_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 지시 끝에 붙이는 «같은 앱 링크 따라 읽기» — 이번 판에 실은 앱 가운데 링크를 따라 읽을 줄 아는 앱(노션 · 슬랙)만. **모든 단위를 다 읽은 뒤**
 *  마지막에 한다(턴이 모자라 뒤 단위를 못 읽는 일이 없게 — 단위 읽기가 먼저다). 실을 앱이 없으면 null. 노션은 따라갈 페이지(처음 읽는 단위)를 적는다.
 */
export function sameAppLinkInstruction(apps: readonly string[], opts: { notionPages?: readonly string[] } = {}): string | null {
  const lines: string[] = [];
  if (apps.includes("notion")) {
    //  어느 페이지의 링크를 따라가나 — 이번 판에 처음 읽는 페이지만(다시 읽는 페이지의 링크는 계획 길의 몫 · 섞인 판에서 다시 열지 않게).
    const from = (opts.notionPages ?? []).filter((id) => NOTION_UNIT_REF.test(id));
    lines.push(`  - 노션 페이지 링크(notion.so · notion.site)${from.length ? ` — 이 페이지들의 본문 속 링크만: ${from.map((id) => `id="${id}"`).join(", ")}` : ""}: ` +
      "notion-fetch 를 id=<그 링크 주소> 로 부른다. 위 목록에 이미 있는 페이지는 열지 않는다.");
  }
  if (apps.includes("slack")) {
    lines.push("  - 슬랙 메시지 링크(…slack.com/archives/<채널>/p<숫자 16자리>): slack_read_thread 를 channel_id=<링크의 채널>, " +
      "message_ts=<링크에 thread_ts 가 있으면 그 값, 없으면 p 뒤 숫자 16자리를 «앞 10자리.뒤 6자리» 로>, limit=200 으로 부른다.");
  }
  if (!lines.length) return null;
  return [`· 마지막으로 — 위 단위를 다 읽은 뒤, 읽은 글 속에 같은 앱의 다른 문서 링크가 있으면 단위마다 최대 ${SAME_APP_LINKS_PER_UNIT}개를 연다(없으면 건너뛴다).`, ...lines].join("\n");
}
