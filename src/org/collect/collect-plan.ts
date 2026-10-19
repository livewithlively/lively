// 수집 실행의 계획과 뒷수습(#4213 T11 저장 단계) — **순수**. 무엇을 시킬지(고정 지시) · 끝난 뒤 원문을 단위별 자료로 나누기 ·
//  읽은 위치를 어디로 옮길지. DB 는 run-ingest.ts 가 만진다.
//
//  ── 실행 종류 ──
//   · listing — 그 사람 커넥터로 «무엇이 있나» 를 훑는다 → recordUnitListing(verified:true). 앱 하나.
//   · collect — 그 사람이 지금 담당인 단위(T10 listAssignedUnits)를 읽는다 → storeUnitItems + advanceUnitCursor.
//  지시는 서버가 고정해서 준다(모델은 도구를 부르기만 한다). 무엇이 자료가 되는지는 원문을 서버가 풀어 정한다(connector-parse).
//
//  ── 읽은 위치 규칙 — «다 읽었다» 는 증거가 다 있을 때만 옮긴다 ──
//   위치가 한 번 넘어가면 그 구간은 다시 안 읽는다(조용한 영구 누락). 그래서 «반증이 없으면 옮긴다» 가 아니라 아래가 **다** 있을 때만 옮긴다:
//    ① 그 단위의 결과가 전부 제 모양이다 — 오류 문구 · 형식이 바뀐 글이 하나라도 있으면 아니다
//    ② 계획한 구간 그대로(입력 oldest·latest · query 가 계획과 같다) 첫 쪽부터 «더 없음» 까지 쪽 사슬이 이어진다(cursor · pageToken)
//    ③ 슬랙: 그 사슬에서 답글이 있는 부모마다 스레드를 끝까지 읽었다 · 지메일: 찾은 스레드를 하나도 빼지 않고 펼쳤다
//   하나라도 모자라면 읽은 항목은 저장하되(같은 좌표라 다시 읽어도 행이 안 는다) 시작점은 그대로 두고 다음 판의 구간을 반으로 줄인다
//   (span — 바쁜 대화는 작은 구간으로 따라잡는다, 1시간까지). 다 읽은 판은 구간을 다시 두 배로 늘린다.
//   구간 끝이 «지금» 인 판은 위치를 계획 시각 − 60초로 옮긴다 — 글의 시각(특히 메일의 Date 머리)은 보낸 쪽이 정하므로 위치로 쓰지 않는다.
import type { RawItem } from "../../items/store.js";
import { ACTIVITY_WINDOW_SEC, type ActivitySample, type ReadNote } from "./schedule-plan.js";
import {
  PLANNED_LINKS_PER_RUN, SAME_APP_LINKS_PER_UNIT, extractAppLinks, matchLinkedRead, plannedLinkInstruction, sameAppLinkInstruction,
  type AppLink, type LinkLike, type LinkedTarget,
} from "./link-plan.js";
import {
  type Capture, type ListedUnit, type SlackMsg, gmailItem, gmailMailbox, isGmailFetch, isGmailSearch, notionId, notionItem,
  parseGmailMessages, parseNotionFetch, parseNotionList, parseSlackChannelList, parseSlackChannelMessages, parseSlackThread, slackItem,
  type NotionPage,
} from "./connector-parse.js";

export type CollectMode = "probe" | "listing" | "collect";

/** 목록·수집을 아는 앱 — 앱 키(source.external_system) → claude.ai 커넥터 이름. */
export const CLAUDE_COLLECT_APPS: Readonly<Record<string, string>> = { slack: "Slack", gmail: "Gmail", notion: "Notion" };

/** 처음 읽는 단위(읽은 위치 없음)는 최근 이만큼만 — 단위의 `meta.first_days` 가 있으면 그 값(리브가 대화로 정한다, 확정판 §5 · T13). */
export const FIRST_READ_DAYS = 14;
/** 단위가 정할 수 있는 처음 기간의 상한(일). 넘는 값·정수가 아닌 값은 무시하고 기본값으로 읽는다. */
export const FIRST_READ_DAYS_MAX = 365;

/** (순수) 단위 메타데이터의 처음 기간 — 1~FIRST_READ_DAYS_MAX 의 정수만, 아니면 null(기본값을 쓴다). */
export function firstReadDaysOf(meta: unknown): number | null {
  const v = meta && typeof meta === "object" ? (meta as Record<string, unknown>).first_days : undefined;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= FIRST_READ_DAYS_MAX ? v : null;
}
/**
 * (순수) 쓰는 자리의 검사 — meta 에 first_days 를 넣었는데 쓸 수 없는 값이면 그 사유. 없거나 null(지우기)이면 null.
 *  읽는 자리(firstReadDaysOf)는 못 쓰는 값을 조용히 기본값으로 읽는다 — 쓰는 쪽이 모델이라, 거절하지 않으면 리브는
 *  «90일로 정했다» 고 믿는데 실제로는 14일을 읽는다(격리 리뷰 2026-10-17). 그래서 쓸 때 400 으로 돌려준다.
 */
export function firstDaysError(meta: unknown): string | null {
  if (!meta || typeof meta !== "object" || !Object.prototype.hasOwnProperty.call(meta, "first_days")) return null;
  const v = (meta as Record<string, unknown>).first_days;
  if (v === null) return null;
  if (firstReadDaysOf(meta) !== null) return null;
  return `meta.first_days 는 1~${FIRST_READ_DAYS_MAX} 사이의 정수(일)여야 합니다 — 받은 값 ${String(JSON.stringify(v) ?? v).slice(0, 40)}`;
}
/** 한 판이 읽는 구간의 최대(초) — 따라잡을 때 한 번에 이만큼씩. 못 다 읽으면 반씩 줄어 MIN_WINDOW_SEC 까지. */
export const SLACK_WINDOW_SEC = 7 * 86400;
export const GMAIL_WINDOW_SEC = 86400;
export const MIN_WINDOW_SEC = 3600;
/** 구간 끝이 «지금» 인 판은 계획 시각보다 이만큼 앞에서 멈춘다 — 늦게 색인된 글을 다음 판이 다시 본다(같은 좌표라 행은 안 는다). */
export const NOW_MARGIN_SEC = 60;
/** 한 판에 단위 하나에서 넘길 쪽 · 펼칠 스레드 상한(지시에 적는다 — 넘는 단위는 못 다 읽은 것으로 보고 구간을 줄인다). */
export const PAGES_PER_UNIT = 10;
export const THREADS_PER_UNIT = 20;
/** 한 판에 담는 단위 상한 — 오래 안 읽은 단위부터. 넘는 단위는 다음 판(주기, T12)이 읽는다. */
export const UNITS_PER_RUN = 6;
/**
 * 확인 읽기(보호 단위의 «확인 대기» 를 푸는 작은 읽기) — 한 판에 몇 개 · 몇 번까지 · 몇 개의 가장 새 글로 확인하나.
 *  보호 단위 = 공개범위가 «모두» 가 아니고 이미 저장된 자료가 있는 단위(unit-proof.ts). 거기서 아직 확인되지 않은 사람은 그 사람 커넥터로
 *  읽은 글이 저장된 글과 좌표·본문이 같을 때만 확인된다 — 접근 못 하는 사람은 비공개 대화의 본문을 만들어 낼 수 없다.
 */
export const PROOF_PER_RUN = 4;
/** 맡은 단위 없이 확인 읽기만 싣는 판 — 한 번에 더 많이(읽기 한 번씩이라 가볍다). */
export const PROOF_ONLY_PER_RUN = 12;
export const PROOF_MAX_ATTEMPTS = 3;
export const PROOF_RECENT = 5;
/** 시도가 상한에 닿은 대기도 마지막 시도에서 이만큼 지나면 다시 싣는다 — 정당한 구성원이 영영 잠기지 않게. */
export const PROOF_RETRY_SEC = 86_400;
/** 같은 대기를 다시 싣는 간격 — 계획·주기 판 모두(마지막 시도에서 이만큼 지난 것만). 시도를 몇 분 사이에 다 쓰지 않게. */
export const PROOF_RECHECK_SEC = 3_600;
/** #4744 주기 판이 확인 대기만 있는 구성원을 스스로 띄우는 기간 — 대기를 건(또는 다시 건) 때부터. 그 뒤는 다시 목록을 올릴 때까지 안 띄운다. */
export const PROOF_TTL_SEC = 14 * 86_400;
/** 못 푼 결과(unreadable)가 이만큼 이어지면 시도 한 번으로 센다 — 읽을 수 없는 사람의 대기가 시도 없이 영영 되풀이되지 않게. */
export const PROOF_MISS_AS_ATTEMPT = 3;
/** 노션 본문의 증거 줄 하한 — 이보다 짧은(꾸밈 줄을 뺀) 페이지는 본문을 몰라도 맞힐 수 있어 증거가 안 된다(«증명 불가»). */
export const PROOF_NOTION_MIN_LINES = 3;

/** 확인 읽기 판정 — pass · no_match(창 안 글이 있는데 안 맞음) · empty(맞춰 볼 창 안 글 없음) · unprovable(노션 본문이 너무 짧음). */
export type ProofOutcome = "pass" | "no_match" | "empty" | "unprovable";

const FOOT = "보내기·만들기·고치기·지우기 도구는 부르지 않는다. 도구 결과를 고쳐 쓰거나 요약하지 않는다. 다 끝나면 «끝» 이라고만 답한다.";
/** 목록 실행의 슬랙 대화 종류 — 하나라도 빠진 목록은 «전부» 가 아니다(볼 수 있는 구성원을 지우는 판정이라 엄격하게). */
export const SLACK_LIST_TYPES = ["public_channel", "private_channel", "mpim", "im"] as const;

/** 목록 실행 지시 — 목록 도구만 부르고 다음 쪽이 없을 때까지 넘긴다. */
export function listingPrompt(app: string): string {
  if (app === "slack") return [
    "목록 실행이다. 이 사람이 볼 수 있는 슬랙 대화의 목록을 빠짐없이 모은다.",
    `1. slack_list_user_channels 를 types="${SLACK_LIST_TYPES.join(",")}", limit=200, exclude_archived=true 로 부른다.`,
    "2. 결과 끝에 다음 쪽 cursor 가 있으면 같은 types·limit·exclude_archived 에 그 cursor 를 더해 같은 도구를 다시 부른다. cursor 가 없을 때까지 되풀이한다(최대 20번).",
    "3. 다른 도구는 부르지 않는다.", FOOT,
  ].join("\n");
  if (app === "notion") return [
    "목록 실행이다. 이 사람이 볼 수 있는 노션 페이지의 목록을 모은다.",
    "1. notion-list-shared-pages 를 limit=200 으로 부르고, 결과에 다음 쪽 cursor 가 있으면 이어서 부른다(최대 10번).",
    "2. notion-list-private-pages 도 같은 방법으로 부른다.",
    "3. notion-list-recent-pages 도 같은 방법으로 부른다.",
    "4. 다른 도구는 부르지 않는다.", FOOT,
  ].join("\n");
  if (app === "gmail") return [
    "목록 실행이다. 이 사람의 지메일 메일함을 확인한다.",
    "1. search_threads 를 pageSize=1 로 한 번 부른다.",
    "2. 다른 도구는 부르지 않는다.", FOOT,
  ].join("\n");
  throw new Error(`목록 실행을 모르는 앱: ${app}`);
}

/**
 * 수집 실행에 싣는 단위 한 줄(T10 AssignedUnit 에서 필요한 칸만). 실행 기록(collect_run.plan)에 그대로 남으므로 **이름은 싣지 않는다** —
 *  비공개 채널·DM 의 이름은 collect_unit(열람 금지 표)에만 둔다. 자료의 그릇 이름은 저장 단계가 단위에서 채운다.
 */
export interface PlannedUnit {
  id: number; app: string; instance: string; ref: string; kind: string; connector: string;
  /** 이번에 읽기 시작할 곳 — 슬랙 ts(«1786345368.603919») · 지메일 epoch 초 · 노션은 null. */
  since: string | null;
  /** 이번 구간의 끝(같은 꼴) — 지금까지면 null. 다 읽으면 위치가 여기로 간다. */
  until?: string | null;
  /** 저장돼 있던 구간 길이(초) — 못 다 읽어 줄여 둔 값. 없으면 앱의 최대. */
  span?: number | null;
  /** #4744 빈도 표본 재료 — 계획 때 이 단위를 마지막으로 읽은 시각 · 노션은 그때까지 본 마지막 고친 시각(이번 판에 새로 고쳐졌나). */
  read_at?: string | null;
  edited_at?: string | null;
  /** 확인 읽기 단위 — 저장된 글과 맞춰 보기만 한다(저장·위치 이동 없음). */
  proof?: boolean;
}

/** 실행 계획(collect_run.plan 에 남는다) — 수집 실행은 단위들과 계획 시각을 싣는다. */
export interface CollectPlan {
  mode: "listing" | "collect"; app?: string; units?: PlannedUnit[]; planned_at?: number;
  /** #4744 누가 띄웠나 — schedule = 기본 주기(collect-schedule 틱) · 없으면 사람·리브가 직접(collect_claude_run). */
  trigger?: "schedule";
  /** #4744 링크 따라 읽기 — 지난 판들이 기록해 둔 «다른 앱 링크» 가운데 이 판에 실은 것(collect_link 행). */
  links?: PlannedLink[];
}

/** 다음 판에 실은 링크 한 줄 — collect_link 행 id(읽음 표시) + 대상. */
export interface PlannedLink extends Pick<AppLink, "app" | "ref" | "kind" | "channel" | "ts" | "thread"> {
  id: number;
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const SLACK_TS = /^\d{9,11}\.\d{1,6}$/;
const SLACK_REF = /^[CDG][A-Z0-9]{6,}$/;
const NOTION_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAIL_REF = /^[^@\s"]+@[^@\s"]+$/;

/** 단위 ref 가 그 앱의 모양인가 — 지시에 그대로 들어가므로(모양 밖의 글은 싣지 않는다). */
export function validUnitRef(app: string, ref: string): boolean {
  if (app === "slack") return SLACK_REF.test(ref);
  if (app === "notion") return NOTION_REF.test(ref);
  if (app === "gmail") return MAIL_REF.test(ref) && ref.length <= 254;
  return false;
}

const windowMax = (app: string): number => (app === "slack" ? SLACK_WINDOW_SEC : app === "gmail" ? GMAIL_WINDOW_SEC : 0);

/** 저장된 구간 길이 — 1시간 이상 · 앱의 최대 미만의 정수만(최대면 칸을 안 쓴다). 아니면 null. */
export function storedSpan(app: string, cursor: Record<string, unknown> | null): number | null {
  const s = cursor?.span;
  return typeof s === "number" && Number.isInteger(s) && s >= MIN_WINDOW_SEC && s < windowMax(app) ? s : null;
}

const epochSec = (iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

/** 단위의 읽기 시작점 — 읽은 위치(cursor) → 수집기에서 넘어온 단위면 last_item_at → 처음이면 최근 first_days(없으면 FIRST_READ_DAYS) 일. */
export function unitSince(u: { app: string; cursor: Record<string, unknown> | null; last_item_at: string | null; from_collector: boolean; first_days?: number | null }, now: number): string | null {
  const c = u.cursor ?? {};
  const days = firstReadDaysOf({ first_days: u.first_days }) ?? FIRST_READ_DAYS;
  const first = Math.floor(now / 1000) - days * 86400;
  if (u.app === "slack") {
    if (typeof c.ts === "string" && SLACK_TS.test(c.ts)) return c.ts;
    const lia = u.from_collector ? epochSec(u.last_item_at) : null;
    return `${lia ?? first}.000000`;
  }
  if (u.app === "gmail") {
    if (typeof c.after === "number" && Number.isInteger(c.after) && c.after > 0) return String(c.after);
    return String((u.from_collector ? epochSec(u.last_item_at) : null) ?? first);
  }
  return null;
}

/** 이번 판의 구간 — 시작에서 구간 길이(저장된 span 또는 앱의 최대)만큼, 그 끝이 지금 이후면 끝 없음(null). 노션은 구간이 없다. */
export function unitWindow(u: { app: string; cursor: Record<string, unknown> | null; last_item_at: string | null; from_collector: boolean; first_days?: number | null }, now: number): { since: string | null; until: string | null; span: number | null } {
  const since = unitSince(u, now);
  if (since == null) return { since, until: null, span: null };
  const nowSec = Math.floor(now / 1000);
  const span = storedSpan(u.app, u.cursor);
  const end = Math.floor(Number(since)) + (span ?? windowMax(u.app));
  if (u.app === "slack") return { since, until: end < nowSec ? `${end}.000000` : null, span };
  if (u.app === "gmail") return { since, until: end < nowSec ? String(end) : null, span };
  return { since, until: null, span: null };
}

/** 지메일 검색어 — 지시에 쓰고, 끝난 뒤 입력과 맞춰 본다(같아야 «계획한 구간을 읽었다»). */
export function gmailQuery(u: Pick<PlannedUnit, "since" | "until">): string {
  return `after:${u.since}${u.until ? ` before:${u.until}` : ""}`;
}

/**
 * (순수) 확인 읽기 단위 — 가장 새로 저장된 글 몇 개를 덮는 작은 구간(첫 ts − 1초 ~ 마지막 ts + 1초). 노션은 페이지 하나.
 *  저장된 글의 ts 를 모르면(슬랙) 확인할 것이 없으니 null.
 */
export function proofUnit(u: { id: number; app: string; instance: string; ref: string; kind: string }, newestTs: readonly string[]): PlannedUnit | null {
  if (!validUnitRef(u.app, u.ref)) return null;
  const base = { id: u.id, app: u.app, instance: u.instance, ref: u.ref, kind: u.kind, connector: CLAUDE_COLLECT_APPS[u.app], proof: true as const };
  if (u.app === "notion") return { ...base, since: null, until: null };
  if (u.app !== "slack") return null;
  const ts = newestTs.filter((t) => SLACK_TS.test(t)).map(Number).sort((a, b) => a - b).slice(-PROOF_RECENT);
  if (!ts.length) return null;
  return { ...base, since: `${Math.floor(ts[0]) - 1}.000000`, until: `${Math.floor(ts[ts.length - 1]) + 1}.000000` };
}

/** (순수) 이 판에 실을 확인 읽기 — 이미 맡은 단위로 실린 것은 빼고 · 앱을 정했으면 그 앱만 · max 개(기본 PROOF_PER_RUN). */
export function planProofUnits(
  pending: ReadonlyArray<{ unit_id: number; app: string; instance: string; ref: string; kind: string; newest_ts: readonly string[] }>,
  planned: readonly PlannedUnit[], opts: { app?: string | null; max?: number } = {},
): PlannedUnit[] {
  const out: PlannedUnit[] = [];
  const max = opts.max ?? PROOF_PER_RUN;
  for (const p of pending) {
    if (out.length >= max) break;
    if (planned.some((u) => u.id === p.unit_id) || (opts.app && p.app !== opts.app)) continue;
    const u = proofUnit({ id: p.unit_id, app: p.app, instance: p.instance, ref: p.ref, kind: p.kind }, p.newest_ts);
    if (u) out.push(u);
  }
  return out;
}

/**
 * (순수) #4744 수집 실행이 붙잡을(임대) 단위 — 수집 판의 맡은 단위만. 확인 읽기 단위는 뺀다: 그 단위의 담당은 다른 사람이고 이 판은
 *  그 단위의 다음 확인을 적지 않으므로, 붙잡으면 담당의 수집만 판 마감까지 늦어진다.
 */
export function unitsToLease(plan: Pick<CollectPlan, "mode" | "units"> | null | undefined): number[] {
  if (plan?.mode !== "collect") return [];
  return (plan.units ?? []).filter((u) => !u.proof).map((u) => u.id);
}

/** 한 단위의 지시 줄 — 앱마다 정확한 도구·인자를 적는다(모델이 고르지 않게). 모르는 앱 · 모양 밖의 ref 는 null(싣지 않는다). */
export function unitInstruction(u: PlannedUnit): string | null {
  if (!validUnitRef(u.app, u.ref)) return null;
  if (u.proof) {
    //  확인 읽기는 한 번만 작게 — 쪽 넘김·스레드 없이.
    if (u.app === "slack") return `· 슬랙 대화 ${u.ref}(확인 읽기): slack_read_channel 을 channel_id="${u.ref}", oldest="${u.since}", latest="${u.until}", limit=20 으로 한 번 부른다.`;
    if (u.app === "notion") return `· 노션 ${u.kind === "database" ? "데이터베이스" : "페이지"} ${u.ref}(확인 읽기): notion-fetch 를 id="${u.ref}" 로 한 번 부른다.`;
    return null;
  }
  if (u.app === "slack") return [
    `· 슬랙 대화 ${u.ref}: slack_read_channel 을 channel_id="${u.ref}", oldest="${u.since}"${u.until ? `, latest="${u.until}"` : ""}, limit=100 으로 부른다.`,
    `  결과 끝에 다음 쪽 cursor 가 있으면 같은 channel_id·oldest${u.until ? "·latest" : ""} 에 cursor 를 더해 다시 부른다(최대 ${PAGES_PER_UNIT}쪽).`,
    `  읽은 메시지 가운데 «Thread: N replies» 가 붙은 것마다 slack_read_thread 를 channel_id="${u.ref}", message_ts=<그 메시지의 Message TS>, limit=200 으로 부른다(최대 ${THREADS_PER_UNIT}개). 스레드 결과에 다음 쪽 cursor 가 있으면 cursor 를 더해 이어서 부른다.`,
  ].join("\n");
  if (u.app === "gmail") return [
    `· 지메일 메일함: search_threads 를 query="${gmailQuery(u)}", pageSize=50 으로 부른다. 결과에 nextPageToken 이 있으면 같은 query 에 pageToken 을 더해 다시 부른다(최대 ${PAGES_PER_UNIT}쪽).`,
    `  찾은 스레드마다 하나도 빼지 말고 get_thread 를 threadId=<그 id>, messageFormat="PLAIN_TEXT" 로 부른다.`,
  ].join("\n");
  if (u.app === "notion") return `· 노션 ${u.kind === "database" ? "데이터베이스" : "페이지"} ${u.ref}: notion-fetch 를 id="${u.ref}" 로 한 번 부른다.`;
  return null;
}

/** 맡은 단위 한 줄(T10 AssignedUnit 에서 고르는 데 필요한 칸만). */
export interface AssignedLike {
  id: number; app: string; instance: string; ref: string; kind: string; read_at: string | null;
  cursor: Record<string, unknown> | null; last_item_at: string | null; from_collector: boolean;
  /** #4744 지금 읽을 때가 됐나 — 때가 된 단위가 먼저 실린다(주기 판에 곧 때가 될 단위를 함께 실어도 때가 된 것이 밀려나지 않게). 없으면 때가 된 것으로 본다. */
  due?: boolean;
  /** 처음 기간(일) — 단위 meta.first_days(T13). 없으면 FIRST_READ_DAYS. */
  first_days?: number | null;
}

/**
 * 한 판에 실을 단위 — 아는 앱 · ref 가 앱 모양(본인 신고로 들어온 임의의 글이 지시에 섞이지 않게) · 앱을 정했으면 그 앱만 ·
 *  때가 된 단위 먼저(#4744 — 주기 판은 곧 때가 될 단위도 함께 싣는다) · 그 안에서 오래 안 읽은 것부터(처음 읽는 단위가 맨 앞, 같으면 id 순 —
 *  맡은 단위가 한 판보다 많아도 돌아가며 다 읽힌다) · UNITS_PER_RUN 개.
 *  커넥터 이름은 앱 키에서 고정한다(저장된 칸을 믿지 않는다 — 비면 러너가 «연결된 것 전부» 를 허락한다).
 */
export function pickUnitsForRun(assigned: readonly AssignedLike[], opts: { now: number; app?: string | null }): PlannedUnit[] {
  return assigned
    .filter((u) => !!CLAUDE_COLLECT_APPS[u.app] && (!opts.app || u.app === opts.app) && validUnitRef(u.app, u.ref))
    .slice()
    .sort((a, b) => Number(a.due === false) - Number(b.due === false)
      || (a.read_at ? Date.parse(a.read_at) : 0) - (b.read_at ? Date.parse(b.read_at) : 0) || a.id - b.id)
    .slice(0, UNITS_PER_RUN)
    .map((u) => ({
      id: u.id, app: u.app, instance: u.instance, ref: u.ref, kind: u.kind, connector: CLAUDE_COLLECT_APPS[u.app], ...unitWindow(u, opts.now),
      read_at: u.read_at ?? null,
      ...(u.app === "notion" ? { edited_at: typeof u.cursor?.edited_at === "string" ? u.cursor.edited_at : null } : {}),
    }));
}

/** 수집 실행 지시 — 단위마다 한 줄. 지시를 못 만드는 단위는 빼고 돌려준다. */
export function collectPrompt(units: readonly PlannedUnit[], links: readonly PlannedLink[] = []): { prompt: string; units: PlannedUnit[]; links: PlannedLink[] } {
  const kept: PlannedUnit[] = [];
  const lines: string[] = [];
  for (const u of units) {
    const l = unitInstruction(u);
    if (l) { kept.push(u); lines.push(l); }
  }
  //  #4744 링크 따라 읽기 — 지난 판들이 기록해 둔 링크(이 판에 실은 앱만 · 상한) 다음에, 이번 판 글 속 같은 앱 링크(마지막에).
  //   모으는 단위가 하나도 없으면 링크도 안 싣는다(링크만으로 · 확인 읽기만으로 된 판에 링크 읽기를 얹지 않는다).
  const collecting = kept.filter((u) => !u.proof);
  const apps = [...new Set(collecting.map((u) => u.app))];
  const keptLinks: PlannedLink[] = [];
  if (collecting.length) {
    for (const l of links) {
      if (keptLinks.length >= PLANNED_LINKS_PER_RUN || !apps.includes(l.app)) continue;
      const line = plannedLinkInstruction(l);
      if (line) { keptLinks.push(l); lines.push(line); }
    }
    //  같은 판 링크 따라 읽기는 «이번 판에 처음 보는 글» 이 있는 단위만 — 슬랙(읽은 위치 뒤 새 글) · 처음 읽는 노션 단위. 다시 읽는 노션 페이지는
    //   판마다 전체가 다시 오므로 같은 링크를 판마다 다시 열게 된다 — 그 링크는 저장 단계가 적어 계획 길(이미 읽은 것 · 쉬는 것을 거른다)로 넘긴다.
    const tail = sameAppLinkInstruction(sameRunLinkApps(kept), {
      notionPages: kept.filter((u) => u.app === "notion" && sameRunLinkUnit(u)).map((u) => u.ref),
    });
    if (tail) lines.push(tail);
  }
  return {
    prompt: ["수집 실행이다. 아래 대화·메일함·페이지를 차례로 읽는다. 적힌 도구와 인자 그대로 부른다.", ...lines, FOOT].join("\n"),
    units: kept,
    links: keptLinks,
  };
}

/** 턴 상한 — 단위가 많을수록 넉넉히(쪽 넘김 · 스레드 펼침). 지메일은 스레드마다 한 번씩 펼쳐야 해서 더 준다. 확인 읽기는 한 번씩이라 둘. */
export function collectMaxTurns(units: number, gmailUnits = 0, proofUnits = 0, linkReads = 0): number {
  //  #4744 링크 읽기 몫(최대 12턴)을 더하되 러너의 상한 60 안에서 — 넘는 몫은 없다. 지시에서 링크 읽기가 맨 끝이라 턴이 모자라면 링크가 먼저 빠진다.
  return Math.min(60, Math.max(12, 6 + units * 8 + gmailUnits * 40 + proofUnits * 2) + Math.min(12, Math.max(0, Math.floor(linkReads))));
}

// ── 확인 읽기의 판정(순수) ───────────────────────────────────────────────────

/**
 * 노션 본문의 증거 줄 — 빈 줄 · 네 글자 미만 · 꾸밈 줄(구분선 · 빈 블록 같은 태그 한 개) · 머리글(템플릿이 같아 본문을 몰라도 맞힌다)을
 *  빼고 같은 줄은 한 번.
 */
export function notionProofLines(body: string): Set<string> {
  const out = new Set<string>();
  for (const raw of body.split("\n")) {
    const l = raw.trim();
    if (l.length < 4 || /^[-–—=*_#>|`~.·•\s]+$/.test(l) || /^<\/?[a-z][a-z0-9-]*\s*\/?>$/i.test(l) || /^#{1,6}\s/.test(l)) continue;
    out.add(l);
  }
  return out;
}

/**
 * (순수) 확인 읽기 판정 — 읽은 항목 가운데 «이미 저장된 글과 좌표가 같고 본문이 같은 것» 이 있나. 저장 본문은 저장 단계가 가린 뒤의
 *  글이라 같은 함수(redact)를 거쳐 맞춘다.
 *  · 슬랙: **계획한 창 안**(가장 새로 저장된 최상위 글을 덮는 구간)의 글만 센다 — 원문의 구간 표시(tool_input)는 그 사람 홈에서 오니 믿지
 *    않는다. 창 밖의 옛 글은 예전에 본 사람이면 알 수 있어 증거가 못 된다. 저장 본문이 빈 글(파일만 등)도 증거가 아니다.
 *  · 노션: 저장 본문의 증거 줄 가운데 서로 다른 줄 PROOF_NOTION_MIN_LINES 개 이상 · 절반 이상(경계: 정확히 절반 = 통과)이 읽은 본문에 있나.
 *    증거 줄이 하한보다 적은 페이지는 unprovable.
 */
export function judgeProof(
  u: Pick<PlannedUnit, "app" | "since" | "until">, items: readonly RawItem[], stored: ReadonlyMap<string, string>, redact: (s: string) => string,
): { outcome: ProofOutcome; hits: number; compared: number } {
  let hits = 0, compared = 0, unprovable = 0;
  if (u.app === "slack") {
    const lo = Number(u.since), hi = Number(u.until);
    if (!u.since || !u.until || !Number.isFinite(lo) || !Number.isFinite(hi)) return { outcome: "empty", hits: 0, compared: 0 };
    for (const it of items) {
      const ts = Number((it.fields as Record<string, unknown> | undefined)?.ts);
      if (!Number.isFinite(ts) || ts < lo || ts > hi) continue;
      const prev = stored.get(it.provenance.external_id);
      if (prev == null || !prev.trim()) continue;
      compared++;
      if (prev === redact(String(it.body ?? ""))) hits++;
    }
  } else if (u.app === "notion") {
    for (const it of items) {
      const prev = stored.get(it.provenance.external_id);
      if (prev == null) continue;
      compared++;
      const want = notionProofLines(prev);
      if (want.size < PROOF_NOTION_MIN_LINES) { unprovable++; continue; }
      const have = notionProofLines(redact(String(it.body ?? "")));
      let hit = 0;
      for (const l of want) if (have.has(l)) hit++;
      if (hit >= PROOF_NOTION_MIN_LINES && hit * 2 >= want.size) hits++;
    }
  }
  const outcome: ProofOutcome = hits > 0 ? "pass" : compared === 0 ? "empty" : unprovable === compared ? "unprovable" : "no_match";
  return { outcome, hits, compared };
}

/**
 * (#4744) 같은 판 링크 따라 읽기를 하는 단위 — 이번 판에 처음 보는 글이 있는 단위: 슬랙(읽은 위치 뒤 새 글) · 처음 읽는(읽은 시각이 없는) 노션.
 *  지시(collectPrompt) · 거두기(harvestLinkedReads) · 턴 몫(collect-run) 이 같은 거름을 쓴다.
 */
export function sameRunLinkUnit(u: Pick<PlannedUnit, "app" | "read_at" | "proof">): boolean {
  //  확인 읽기 단위는 모으는 판이 아니다(이미 저장된 글과 맞춰 볼 뿐) — 그 글 속 링크는 따라가지 않는다.
  if (u.proof === true) return false;
  return u.app === "slack" || (u.app === "notion" && !u.read_at);
}

/** (#4744) 같은 판 링크 따라 읽기를 할 앱 — sameRunLinkUnit 인 단위의 앱. */
export function sameRunLinkApps(units: readonly Pick<PlannedUnit, "app" | "read_at" | "proof">[]): string[] {
  const apps: string[] = [];
  if (units.some((u) => u.app === "slack" && sameRunLinkUnit(u))) apps.push("slack");
  if (units.some((u) => u.app === "notion" && sameRunLinkUnit(u))) apps.push("notion");
  return apps;
}

// ── 끝난 뒤: 원문 → 단위별 자료 ──────────────────────────────────────────────

export interface UnitHarvest {
  /** 이 단위의 자료(같은 좌표는 한 번). */
  items: RawItem[];
  /** 이 단위의 결과(도구 호출) 수 — 0 이면 이 판은 이 단위를 안 읽었다(위치·읽은 시각을 옮기지 않는다). */
  reads: number;
  /** 계획한 구간을 끝까지 읽었다는 증거가 다 있나(머리말 ①~③). */
  complete: boolean;
  /** 끝까지가 아니면 첫 이유(기록·지표용). */
  why: string | null;
  /** 저장할 위치 — 다 읽었으면 옮긴 위치(+ 늘린 구간) · 못 다 읽었으면 그대로인 시작점 + 줄인 구간 · 안 읽었으면 null. */
  nextCursor: Record<string, unknown> | null;
  /** 위치가 실제로 앞으로 갔나. */
  advanced: boolean;
  /** 이 판에 본 가장 새 항목의 시각(계획 시각을 넘지 않는다). */
  lastItemAt: string | null;
  /** 제 모양이 아닌 결과 수(오류 문구 · 형식이 바뀐 글) — 하나라도 있으면 끝까지 읽은 것이 아니다. 같은 인자로 다시 불러 제 모양을 받은 것은 빼고 센다. */
  unparsed: number;
  /** 못 다 읽었는데 구간을 더 줄일 수 없다(이미 1시간) — 같은 자리에 머문다. 화면·기록이 사람에게 보이게 센다. */
  stuck: boolean;
  /**
   * #4744 글 빈도 표본 — 다 읽은 판에서 «계획 구간(시작 ~ 끝)에 올라온 글 수 · 구간 길이 · 구간 끝»(epoch 초). 못 다 읽었으면 null
   *  (모자란 판의 글 수는 빈도를 낮춰 잡는다). 노션은 구간 대신 «지난번 읽은 뒤 새로 고쳐졌나»(0 · 1)를 지난번 읽은 시각부터 계획 시각까지로 센다.
   */
  sample: ActivitySample | null;
}

export interface HarvestOpts {
  /** 계획 시각(epoch 초) — 구간 끝이 «지금» 인 판의 위치 · 마지막 글 시각의 상한. 없으면 그런 판의 위치는 안 옮긴다. */
  plannedAt?: number | null;
  /** #4744 이 판에 실은 링크 — 그 대상을 읽은 결과는 «링크 읽기» 로 받는다. */
  links?: readonly PlannedLink[];
}

/**
 * #4744 링크로 읽은 문서 하나 — 계획 밖 읽기 가운데 «이번 판 글 속 같은 앱 링크» 또는 «계획에 실은 링크» 가 가리키는 것. 저장 단계가
 *  링크가 있던 단위가 아니라 **그 문서의 단위**에 넣는다(노션 페이지는 없으면 만든다 · 슬랙은 그 채널이 단위일 때만).
 */
export interface LinkedRead {
  app: "notion" | "slack";
  /** 노션 페이지 uuid · 슬랙 채널 id. */
  ref: string;
  /** 노션 page · database. 슬랙은 채널 종류를 모른다(null). */
  kind: string | null;
  name: string | null;
  /** 링크가 나온 단위의 instance(같은 앱 · 같은 워크스페이스) — 계획에 실은 링크면 같은 앱 단위의 것(저장 단계가 다시 맞춘다). */
  instance: string;
  /** 슬랙 — 읽은 스레드(부모) ts. */
  thread?: string;
  items: RawItem[];
  via: "planned" | "same-run";
  /** 맞은 링크(planned 면 collect_link 행 id 가 있다). */
  link: LinkLike & { id?: number };
  /** same-run 이면 그 링크가 나온 단위. */
  from_unit_id: number | null;
  /** 결과가 제 모양인가 — 아니면 저장하지 않는다. */
  ok: boolean;
}

interface Page { inCursor: string | null; outCursor: string | null; end: boolean }

/** 쪽 사슬 — 첫 쪽(입력 cursor 없음)부터 «출력 cursor = 다음 쪽의 입력 cursor» 로 이어 «더 없음» 에 닿나. 순서와 무관하게 잇는다. */
function walkChain<T extends Page>(pages: readonly T[]): { done: boolean; used: T[] } {
  const used: T[] = [];
  let cur = pages.find((p) => !p.inCursor);
  while (cur && !used.includes(cur)) {
    used.push(cur);
    if (cur.end) return { done: true, used };
    const next = cur.outCursor;
    if (!next) return { done: false, used };
    cur = pages.find((p) => p.inCursor === next && !used.includes(p));
  }
  return { done: false, used };
}

/** 입력 값이 계획과 같은가 — 둘 다 비었거나, 같은 수(«1787000000» = «1787000000.000000»). */
const sameNum = (got: unknown, want: string | null | undefined): boolean => {
  const empty = got == null || got === "";
  if (want == null || want === "") return empty;
  return !empty && Number(got) === Number(want);
};
const sameText = (got: unknown, want: string): boolean => typeof got === "string" && got.replace(/\s+/g, " ").trim() === want;

/** 수집 실행의 원문 → 단위별 자료와 위치. 요청하지 않은 그릇(채널·메일함·페이지)의 항목은 버린다(stray). */
export function harvestUnits(caps: readonly Capture[], units: readonly PlannedUnit[], opts: HarvestOpts = {}):
  { byUnit: Map<number, UnitHarvest>; stray: number; linked: LinkedRead[]; linkStray: number } {
  const plannedAt = typeof opts.plannedAt === "number" && Number.isFinite(opts.plannedAt) ? Math.floor(opts.plannedAt) : null;
  const byUnit = new Map<number, UnitHarvest>();
  //  같은 좌표가 여러 번 나오면 rank 가 큰 쪽(같으면 먼저 본 것)이 남는다.
  const seen = new Map<number, Map<string, { it: RawItem; rank: number }>>();
  for (const u of units) {
    byUnit.set(u.id, { items: [], reads: 0, complete: false, why: null, nextCursor: null, advanced: false, lastItemAt: null, unparsed: 0, stuck: false, sample: null });
    seen.set(u.id, new Map());
  }
  let stray = 0;
  //  #4744 계획 밖 노션 페이지 · 슬랙 스레드 읽기 — 단위 자료를 다 모은 뒤 링크로 읽은 것인지 가린다(아니면 stray).
  const strayCaps: Capture[] = [];
  const put = (u: PlannedUnit, it: RawItem, rank = 0) => {
    const m = seen.get(u.id)!;
    const k = it.provenance.external_id;
    const prev = m.get(k);
    if (!prev || rank > prev.rank) m.set(k, { it, rank });
  };
  const slackUnit = (ch: string | null) => (ch ? units.find((u) => u.app === "slack" && u.ref === ch) ?? null : null);
  const gmailUnits = units.filter((u) => u.app === "gmail");
  const chanPages = new Map<number, Array<Page & { inWindow: boolean; msgs: SlackMsg[] }>>();
  const threadPages = new Map<number, Array<Page & { ts: string }>>();
  const searchPages = new Map<number, Array<Page & { inPlan: boolean; threads: Array<{ id: string; msgs: string[] }> }>>();
  //  지메일 «펼침» 의 증거는 메시지 단위 — 검색이 준 스레드의 메시지 id 를 펼친 결과가 다 덮어야 그 스레드를 펼친 것이다.
  const fetchedMsgs = new Map<number, Set<string>>();
  const notionOk = new Set<number>();
  const push = <T>(m: Map<number, T[]>, id: number, v: T) => { if (!m.has(id)) m.set(id, []); m.get(id)!.push(v); };
  //  같은 인자로 다시 부른 호출이 제 모양을 받았으면 앞의 실패(속도 제한 등)는 «못 풂» 으로 세지 않는다.
  const badKeys = new Map<number, Set<string>>(), okKeys = new Map<number, Set<string>>();
  const callKey = (c: Capture) => `${c.tool}\u0001${JSON.stringify(Object.keys(c.input).sort().map((k) => [k, c.input[k]]))}`;
  const mark = (m: Map<number, Set<string>>, id: number, c: Capture) => { if (!m.has(id)) m.set(id, new Set()); m.get(id)!.add(callKey(c)); };
  const bad = (u: PlannedUnit, c: Capture) => { mark(badKeys, u.id, c); };
  const good = (u: PlannedUnit, c: Capture) => { mark(okKeys, u.id, c); };

  for (const c of caps) {
    if (c.tool === "slack_read_channel") {
      const r = parseSlackChannelMessages(c);
      const u = slackUnit(r.channel?.id ?? str(c.input.channel_id));
      if (!u) { stray++; continue; }
      const h = byUnit.get(u.id)!;
      h.reads++;
      if (!r.wellFormed) { bad(u, c); continue; }
      good(u, c);
      for (const m of r.messages) put(u, slackItem(m, { instance: u.instance, channel: u.ref, channelName: r.channel?.name }), 1);
      push(chanPages, u.id, {
        inCursor: str(c.input.cursor), outCursor: r.cursor, end: r.end, msgs: r.messages,
        inWindow: sameNum(c.input.oldest, u.since) && sameNum(c.input.latest, u.until ?? null),
      });
    } else if (c.tool === "slack_read_thread") {
      const r = parseSlackThread(c);
      const u = slackUnit(r.channelId);
      if (!u) { strayCaps.push(c); continue; }
      const h = byUnit.get(u.id)!;
      h.reads++;
      const asked = typeof c.input.message_ts === "string" && SLACK_TS.test(c.input.message_ts) ? c.input.message_ts : null;
      //  이어 읽은 쪽(입력 cursor 있음)은 부모 머리가 다시 안 올 수 있다 — 쪽 안내만 분명하면 제 모양으로 본다.
      const shaped = r.wellFormed || (!!str(c.input.cursor) && (r.end || !!r.cursor));
      //  부모는 결과가 먼저(모델이 답글 ts 를 넘겨도 좌표가 안 틀어진다) · 이어 읽은 쪽은 결과에 부모가 없어 입력으로.
      const parentTs = r.parent?.ts ?? asked;
      if (!shaped || !parentTs) { bad(u, c); continue; }
      good(u, c);
      if (r.parent) put(u, slackItem({ ...r.parent, reply_count: r.parent.reply_count ?? (r.replies.length || null) }, { instance: u.instance, channel: u.ref }), 1);
      //  답글은 부모보다 뒤 · 계획 시각(+5분)보다 앞이어야 한다 — 본문이 «--- Reply» 머리를 흉내 낸 가짜 답글을 거른다.
      for (const m of r.replies) {
        const t = Number(m.ts);
        if (!(t > Number(parentTs)) || (plannedAt != null && t > plannedAt + 300)) continue;
        put(u, slackItem(m, { instance: u.instance, channel: u.ref, threadParentTs: parentTs }), 1);
      }
      push(threadPages, u.id, { ts: parentTs, inCursor: str(c.input.cursor), outCursor: r.cursor, end: r.end });
    } else if (c.tool === "search_threads" || c.tool === "get_thread" || c.tool === "get_message") {
      const msgs = parseGmailMessages(c);
      const box = gmailMailbox(msgs);
      //  메일함이 둘 이상이면 주소로 맞춘다. 하나뿐이면 주소를 못 읽은 결과(빈 검색 · 오류)도 그 메일함 것이다.
      const u = box ? gmailUnits.find((x) => x.ref === box) ?? null : (gmailUnits.length === 1 ? gmailUnits[0] : null);
      if (!u) { stray++; continue; }
      const h = byUnit.get(u.id)!;
      h.reads++;
      if (c.tool === "search_threads") {
        if (!isGmailSearch(c)) { bad(u, c); continue; }
        good(u, c);
        const j = c.json as Record<string, unknown>;
        const threads = (Array.isArray(j.threads) ? j.threads : []).map((t) => {
          if (!isRec(t) || !str(t.id)) return null;
          const msgs = Array.isArray(t.messages) ? t.messages.map((m) => (isRec(m) ? str(m.id) : null)).filter((x): x is string => !!x) : [];
          return { id: String(t.id), msgs };
        }).filter((t): t is { id: string; msgs: string[] } => !!t);
        const next = str(j.nextPageToken);
        //  검색 결과의 메시지는 한 줄 요약이라 자료로 넣지 않는다(본문 전체가 있던 자료를 요약으로 덮지 않게) — 펼친 스레드에서만 넣는다.
        push(searchPages, u.id, { inCursor: str(c.input.pageToken), outCursor: next, end: !next, inPlan: sameText(c.input.query, gmailQuery(u)), threads });
      } else {
        if (!isGmailFetch(c)) { bad(u, c); continue; }
        good(u, c);
        if (!fetchedMsgs.has(u.id)) fetchedMsgs.set(u.id, new Set());
        for (const m of msgs) {
          fetchedMsgs.get(u.id)!.add(m.id);
          put(u, gmailItem(m, { instance: u.instance || "default", mailbox: u.ref }), m.full ? 2 : 1);
        }
      }
    } else if (c.tool === "notion-fetch") {
      const p = parseNotionFetch(c);
      const id = p?.id ?? notionId(str(c.input.id));
      const u = id ? units.find((x) => x.app === "notion" && x.ref === id) ?? null : null;
      if (!u) { strayCaps.push(c); continue; }
      const h = byUnit.get(u.id)!;
      h.reads++;
      if (!p) { bad(u, c); continue; }
      good(u, c);
      put(u, notionItem(p, { instance: u.instance }), 1);
      notionOk.add(u.id);
    }
  }

  const capIso = plannedAt != null ? new Date(plannedAt * 1000).toISOString() : null;
  for (const u of units) {
    const h = byUnit.get(u.id)!;
    h.items = [...seen.get(u.id)!.values()].map((v) => v.it);
    const times = h.items.map((i) => i.updated_at ?? i.occurred_at).filter((t): t is string => !!t).sort();
    const newest = times.length ? times[times.length - 1] : null;
    //  마지막 글 시각도 계획 시각을 넘지 않는다(시계가 앞선 발신자 한 명이 단위의 «마지막 글» 을 미래로 밀지 못하게).
    h.lastItemAt = newest && capIso && newest > capIso ? capIso : newest;
    const okSet = okKeys.get(u.id) ?? new Set<string>();
    h.unparsed = [...(badKeys.get(u.id) ?? [])].filter((k) => !okSet.has(k)).length;
    if (!h.reads) continue;

    //  ① ~ ③ — 앱마다 «다 읽었다» 의 증거를 모은다.
    if (u.app === "slack") {
      const pages = chanPages.get(u.id) ?? [];
      const ch = walkChain(pages.filter((p) => p.inWindow));
      const parents = [...new Set(ch.used.flatMap((p) => p.msgs.filter((m) => (m.reply_count ?? 0) > 0).map((m) => m.ts)))];
      const tp = threadPages.get(u.id) ?? [];
      const missing = parents.filter((ts) => !walkChain(tp.filter((p) => p.ts === ts)).done);
      h.why = h.unparsed ? "풀지 못한 결과" : !pages.some((p) => p.inWindow) ? (pages.length ? "계획과 다른 구간을 읽음" : "채널을 안 읽음")
        : !ch.done ? "쪽을 끝까지 못 읽음" : missing.length ? `스레드 ${missing.length}개를 못 읽음` : null;
    } else if (u.app === "gmail") {
      const pages = searchPages.get(u.id) ?? [];
      const ch = walkChain(pages.filter((p) => p.inPlan));
      const done = fetchedMsgs.get(u.id) ?? new Set<string>();
      //  스레드마다 검색이 준 메시지 id 가 펼친 결과에 다 있어야 한다(메시지 id 를 안 준 스레드는 그 스레드 id 의 메시지라도 와야 한다).
      const missing = ch.used.flatMap((p) => p.threads).filter((t) => (t.msgs.length ? t.msgs.some((m) => !done.has(m)) : !done.has(t.id)));
      h.why = h.unparsed ? "풀지 못한 결과" : !pages.some((p) => p.inPlan) ? (pages.length ? "계획과 다른 검색어" : "검색을 안 함")
        : !ch.done ? "쪽을 끝까지 못 읽음" : missing.length ? `스레드 ${missing.length}개를 못 펼침` : null;
    } else if (u.app === "notion") {
      h.why = h.unparsed ? "풀지 못한 결과" : !notionOk.has(u.id) ? "페이지를 못 읽음" : null;
    } else {
      h.why = "모르는 앱";
    }
    h.complete = h.why == null;
    h.sample = harvestSample(u, h, plannedAt);

    //  위치 — 다 읽었으면 앞으로, 못 다 읽었으면 그 자리에 구간만 줄여서.
    if (u.app === "notion") {
      h.nextCursor = h.complete && h.lastItemAt ? { edited_at: h.lastItemAt } : null;
      h.advanced = !!h.nextCursor;
      continue;
    }
    if (u.since == null || (u.app !== "slack" && u.app !== "gmail")) continue;
    const key = u.app === "slack" ? "ts" : "after";
    const start = Math.floor(Number(u.since));
    const here = u.app === "slack" ? u.since : start;
    const max = windowMax(u.app);
    if (h.complete) {
      const end = u.until != null ? Math.floor(Number(u.until)) : plannedAt != null ? plannedAt - NOW_MARGIN_SEC : null;
      const grown = u.span ? (u.span * 2 >= max ? null : u.span * 2) : null;
      const pos = end != null && end > start ? (u.app === "slack" ? `${end}.000000` : end) : here;
      h.nextCursor = { [key]: pos, ...(grown ? { span: grown } : {}) };
      h.advanced = pos !== here;
    } else {
      const cur = (u.until != null ? Math.floor(Number(u.until)) : plannedAt ?? start + max) - start;
      h.nextCursor = { [key]: here, span: Math.max(MIN_WINDOW_SEC, Math.floor(Math.min(cur, max) / 2)) };
      h.advanced = false;
      h.stuck = cur <= MIN_WINDOW_SEC;
    }
  }
  const lk = harvestLinkedReads(strayCaps, units, byUnit, opts.links ?? [], plannedAt);
  //  링크와 맞았지만 상한을 넘어 버린 읽기는 따로 센다(«지시를 벗어남» 이 아니다) — 링크 근거가 없는 계획 밖 읽기는 그대로 stray.
  return { byUnit, stray: stray + lk.stray, linked: lk.linked, linkStray: lk.overQuota };
}

/**
 * #4744 계획 밖 읽기 → 링크 읽기 — 이번 판 글 속 같은 앱 링크(단위마다 SAME_APP_LINKS_PER_UNIT 개까지) · 계획에 실은 링크가 가리키는 것만.
 *  같은 문서의 여러 쪽(스레드 이어 읽기)은 한 줄로 합친다. 나머지는 stray.
 */
function harvestLinkedReads(caps: readonly Capture[], units: readonly PlannedUnit[], byUnit: Map<number, UnitHarvest>,
  planned: readonly PlannedLink[], plannedAt: number | null): { linked: LinkedRead[]; stray: number; overQuota: number } {
  const sameRun: Array<AppLink & { from: number; instance: string }> = [];
  //  따라가지 않는 단위(다시 읽는 노션 페이지)의 같은 앱 링크 — 모델이 그래도 열었으면 받지 않되 «지시를 벗어남» 이 아니라 링크 쪽으로 센다.
  const notFollowed: AppLink[] = [];
  for (const u of units) {
    //  지시와 같은 거름(sameRunLinkUnit) — 슬랙 · 처음 읽는 노션 단위의 글 속 링크만.
    const follow = sameRunLinkUnit(u);
    for (const it of byUnit.get(u.id)?.items ?? []) {
      for (const l of extractAppLinks(`${it.title ?? ""}\n${it.body ?? ""}`)) {
        if (l.app !== u.app) continue;
        if (follow) sameRun.push({ ...l, from: u.id, instance: u.instance });
        else notFollowed.push(l);
      }
    }
  }
  let stray = 0, overQuota = 0;
  const quota = new Map<number, number>();
  const got = new Map<string, LinkedRead & { keys: Set<string> }>();
  for (const c of caps) {
    let target: LinkedTarget | null = null;
    let page: NotionPage | null = null;
    let th: ReturnType<typeof parseSlackThread> | null = null;
    if (c.tool === "notion-fetch") {
      page = parseNotionFetch(c);
      const ref = page?.id ?? notionId(str(c.input.id));
      if (ref) target = { app: "notion", ref };
    } else if (c.tool === "slack_read_thread") {
      th = parseSlackThread(c);
      const channel = th.channelId ?? str(c.input.channel_id);
      const asked = typeof c.input.message_ts === "string" && SLACK_TS.test(c.input.message_ts) ? c.input.message_ts : null;
      const ts = th.parent?.ts ?? asked;
      const tss = [...(th.parent ? [th.parent.ts] : []), ...th.replies.map((m) => m.ts)];
      if (channel && SLACK_REF.test(channel) && ts) target = { app: "slack", channel, thread: ts, tss };
    }
    const m = target ? matchLinkedRead(target, { sameRun, planned }) : null;
    if (!target || !m) {
      if (target && notFollowed.length && matchLinkedRead(target, { sameRun: notFollowed, planned: [] })) overQuota++;
      else stray++;
      continue;
    }
    const key = target.app === "notion" ? `n\u0001${target.ref}` : `s\u0001${target.channel}\u0001${target.thread}`;
    let r = got.get(key);
    if (!r) {
      const from = m.via === "same-run" ? (m.link as AppLink & { from?: number }).from ?? null : null;
      if (from != null) {
        const q = quota.get(from) ?? 0;
        if (q >= SAME_APP_LINKS_PER_UNIT) { overQuota++; continue; }
        quota.set(from, q + 1);
      }
      const instance = (m.link as { instance?: string }).instance ?? units.find((u) => u.app === target!.app)?.instance ?? "";
      r = {
        app: target.app, ref: target.app === "notion" ? target.ref : target.channel, kind: null, name: null, instance,
        ...(target.app === "slack" ? { thread: target.thread } : {}),
        items: [], via: m.via, link: m.link, from_unit_id: from, ok: false, keys: new Set<string>(),
      };
      got.set(key, r);
    }
    const add = (it: RawItem) => {
      const k = it.provenance.external_id;
      if (!r!.keys.has(k)) { r!.keys.add(k); r!.items.push(it); }
    };
    if (target.app === "notion") {
      if (!page) continue;
      r.ok = true; r.kind = page.kind; r.name = page.title;
      add(notionItem(page, { instance: r.instance }));
    } else if (th) {
      const shaped = th.wellFormed || (!!str(c.input.cursor) && (th.end || !!th.cursor));
      if (!shaped) continue;
      r.ok = true;
      const parentTs = target.thread;
      if (th.parent) add(slackItem({ ...th.parent, reply_count: th.parent.reply_count ?? (th.replies.length || null) }, { instance: r.instance, channel: target.channel }));
      for (const msg of th.replies) {
        const t = Number(msg.ts);
        if (!(t > Number(parentTs)) || (plannedAt != null && t > plannedAt + 300)) continue;
        add(slackItem(msg, { instance: r.instance, channel: target.channel, threadParentTs: parentTs }));
      }
    }
  }
  return { linked: [...got.values()].map(({ keys: _k, ...x }) => x), stray, overQuota };
}

const secOf = (v: string | null | undefined): number | null => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

/** (#4744) 다 읽은 판의 글 빈도 표본 — UnitHarvest.sample 머리말. 계획 시각을 모르면(옛 계획) 만들지 않는다. */
function harvestSample(u: PlannedUnit, h: UnitHarvest, plannedAt: number | null): ActivitySample | null {
  if (!h.complete || plannedAt == null) return null;
  if (u.app === "notion") {
    const start = secOf(u.read_at) ?? plannedAt - ACTIVITY_WINDOW_SEC;
    if (!(plannedAt > start)) return null;
    const edited = h.items.map((i) => secOf(i.updated_at)).find((t) => t != null) ?? null;
    const before = secOf(u.edited_at);
    const changed = edited != null && edited > start && (before == null || edited > before);
    return { e: plannedAt, s: plannedAt - start, n: changed ? 1 : 0 };
  }
  if (u.since == null || (u.app !== "slack" && u.app !== "gmail")) return null;
  const start = Math.floor(Number(u.since));
  const end = u.until != null ? Math.floor(Number(u.until)) : plannedAt - NOW_MARGIN_SEC;
  if (!(end > start)) return null;
  const n = h.items.filter((i) => {
    const t = secOf(i.occurred_at ?? i.updated_at);
    return t != null && t >= start && t <= end;
  }).length;
  return { e: end, s: end - start, n };
}

/**
 * (#4744) 다 읽은 뒤에도 «지금» 까지 못 왔나 — 새 위치에서 시작하는 다음 구간의 끝이 지금보다 앞이면 밀린 것이다(처음 수집 14일을
 *  7일·1일 구간으로 따라잡는 중). 주기 판정이 «곧바로 다음 판» 을 고르는 근거다. 노션·모르는 위치는 밀리지 않은 것으로 본다.
 */
export function behindAfter(app: string, nextCursor: Record<string, unknown> | null, nowMs: number): boolean {
  if (!nextCursor || (app !== "slack" && app !== "gmail")) return false;
  const key = app === "slack" ? "ts" : "after";
  if (nextCursor[key] == null) return false;
  return unitWindow({ app, cursor: nextCursor, last_item_at: null, from_collector: false }, nowMs).until != null;
}

/**
 * (#4744) 저장 단계가 단위 하나의 결과를 주기 판정에 넘기는 모양 — 이 판이 안 읽었다(unread) · 원문이 잘렸거나 저장이 실패했다(blocked) ·
 *  다 읽었다(complete — 밀림·표본) · 못 다 읽었다(incomplete — 구간을 줄였나 · 더 못 줄이나). 노션처럼 다음 위치가 없는(구간을 안 줄인)
 *  «못 다 읽음» 은 shrunk:false 다 — 주기 판정이 곧바로가 아니라 물러서기로 보낸다(곧바로 다시 읽어도 같은 결과다).
 */
export function readNoteOf(u: Pick<PlannedUnit, "app">, h: Pick<UnitHarvest, "reads" | "complete" | "nextCursor" | "stuck" | "sample">,
  opts: { blocked: boolean; nowMs: number }): ReadNote {
  if (!h.reads) return { outcome: "unread" };
  if (opts.blocked) return { outcome: "blocked" };
  if (h.complete) return { outcome: "complete", behind: behindAfter(u.app, h.nextCursor, opts.nowMs), sample: h.sample };
  return { outcome: "incomplete", shrunk: h.nextCursor != null, stuck: h.stuck };
}

/** 목록 실행의 원문 → 단위 목록 · 전부인가. «전부» 는 그 사람의 via-listing 자리를 정리하는 판정이라 증거가 다 있을 때만. */
export function harvestListing(caps: readonly Capture[], app: string): { units: ListedUnit[]; complete: boolean; calls: number; unparsed: number } {
  const units = new Map<string, ListedUnit>();
  let calls = 0, unparsed = 0;
  const pages: Array<Page & { allTypes: boolean }> = [];
  for (const c of caps) {
    if (app === "slack" && c.tool === "slack_list_user_channels") {
      calls++;
      const r = parseSlackChannelList(c);
      //  대화가 하나도 없는 목록은 제 모양이 아니다(오류 문구 · 형식이 바뀐 글) — 이 판을 «전부» 로 보면 그 사람이 다 빠진다.
      if (!r.units.length) { unparsed++; continue; }
      const archived = new Set(r.archived);
      for (const u of r.units) if (!archived.has(u.ref) && !units.has(u.ref)) units.set(u.ref, u);
      const types = String(c.input.types ?? "").split(",").map((t) => t.trim());
      pages.push({ inCursor: str(c.input.cursor), outCursor: r.cursor, end: !r.cursor, allTypes: SLACK_LIST_TYPES.every((t) => types.includes(t)) });
    } else if (app === "notion" && /^notion-(list-(shared|private|recent)-pages|search)$/.test(c.tool)) {
      calls++;
      const r = parseNotionList(c);
      if (!isRec(c.json) || !Array.isArray(c.json.results)) unparsed++;
      for (const u of r.units) if (!units.has(u.ref)) units.set(u.ref, u);
    } else if (app === "gmail" && c.tool === "search_threads") {
      calls++;
      const box = gmailMailbox(parseGmailMessages(c));
      if (box && !units.has(box)) units.set(box, { ref: box, name: box, kind: "mailbox" });
    }
  }
  //  «전부» 는 슬랙만 — 모든 종류(공개·비공개·그룹 DM·DM)를 청한 쪽들이 첫 쪽부터 «더 없음» 까지 이어지고 못 푼 쪽이 없을 때.
  //   노션 목록 도구는 볼 수 있는 페이지 전부를 주지 않고, 지메일은 메일함 하나다(전부라고 하면 이 사람이 다른 메일함에서 빠진다).
  const complete = app === "slack" && unparsed === 0 && walkChain(pages.filter((p) => p.allTypes)).done;
  return { units: [...units.values()], complete, calls, unparsed };
}
