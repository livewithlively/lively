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
import {
  type Capture, type ListedUnit, type SlackMsg, gmailItem, gmailMailbox, isGmailFetch, isGmailSearch, notionId, notionItem,
  parseGmailMessages, parseNotionFetch, parseNotionList, parseSlackChannelList, parseSlackChannelMessages, parseSlackThread, slackItem,
} from "./connector-parse.js";

export type CollectMode = "probe" | "listing" | "collect";

/** 목록·수집을 아는 앱 — 앱 키(source.external_system) → claude.ai 커넥터 이름. */
export const CLAUDE_COLLECT_APPS: Readonly<Record<string, string>> = { slack: "Slack", gmail: "Gmail", notion: "Notion" };

/** 처음 읽는 단위(읽은 위치 없음)는 최근 이만큼만 — 처음 수집 기간은 나중에 리브가 대화로 정한다(확정판 §5). */
export const FIRST_READ_DAYS = 14;
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
}

/** 실행 계획(collect_run.plan 에 남는다) — 수집 실행은 단위들과 계획 시각을 싣는다. */
export interface CollectPlan { mode: "listing" | "collect"; app?: string; units?: PlannedUnit[]; planned_at?: number }

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

/** 단위의 읽기 시작점 — 읽은 위치(cursor) → 수집기에서 넘어온 단위면 last_item_at → 처음이면 최근 FIRST_READ_DAYS 일. */
export function unitSince(u: { app: string; cursor: Record<string, unknown> | null; last_item_at: string | null; from_collector: boolean }, now: number): string | null {
  const c = u.cursor ?? {};
  const first = Math.floor(now / 1000) - FIRST_READ_DAYS * 86400;
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
export function unitWindow(u: { app: string; cursor: Record<string, unknown> | null; last_item_at: string | null; from_collector: boolean }, now: number): { since: string | null; until: string | null; span: number | null } {
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

/** 한 단위의 지시 줄 — 앱마다 정확한 도구·인자를 적는다(모델이 고르지 않게). 모르는 앱 · 모양 밖의 ref 는 null(싣지 않는다). */
export function unitInstruction(u: PlannedUnit): string | null {
  if (!validUnitRef(u.app, u.ref)) return null;
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
}

/**
 * 한 판에 실을 단위 — 아는 앱 · ref 가 앱 모양(본인 신고로 들어온 임의의 글이 지시에 섞이지 않게) · 앱을 정했으면 그 앱만 ·
 *  오래 안 읽은 것부터(처음 읽는 단위가 맨 앞, 같으면 id 순 — 맡은 단위가 한 판보다 많아도 돌아가며 다 읽힌다) · UNITS_PER_RUN 개.
 *  커넥터 이름은 앱 키에서 고정한다(저장된 칸을 믿지 않는다 — 비면 러너가 «연결된 것 전부» 를 허락한다).
 */
export function pickUnitsForRun(assigned: readonly AssignedLike[], opts: { now: number; app?: string | null }): PlannedUnit[] {
  return assigned
    .filter((u) => !!CLAUDE_COLLECT_APPS[u.app] && (!opts.app || u.app === opts.app) && validUnitRef(u.app, u.ref))
    .slice()
    .sort((a, b) => (a.read_at ? Date.parse(a.read_at) : 0) - (b.read_at ? Date.parse(b.read_at) : 0) || a.id - b.id)
    .slice(0, UNITS_PER_RUN)
    .map((u) => ({ id: u.id, app: u.app, instance: u.instance, ref: u.ref, kind: u.kind, connector: CLAUDE_COLLECT_APPS[u.app], ...unitWindow(u, opts.now) }));
}

/** 수집 실행 지시 — 단위마다 한 줄. 지시를 못 만드는 단위는 빼고 돌려준다. */
export function collectPrompt(units: readonly PlannedUnit[]): { prompt: string; units: PlannedUnit[] } {
  const kept: PlannedUnit[] = [];
  const lines: string[] = [];
  for (const u of units) {
    const l = unitInstruction(u);
    if (l) { kept.push(u); lines.push(l); }
  }
  return {
    prompt: ["수집 실행이다. 아래 대화·메일함·페이지를 차례로 읽는다. 적힌 도구와 인자 그대로 부른다.", ...lines, FOOT].join("\n"),
    units: kept,
  };
}

/** 턴 상한 — 단위가 많을수록 넉넉히(쪽 넘김 · 스레드 펼침). 지메일은 스레드마다 한 번씩 펼쳐야 해서 더 준다. */
export function collectMaxTurns(units: number, gmailUnits = 0): number {
  return Math.min(60, Math.max(12, 6 + units * 8 + gmailUnits * 40));
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
}

export interface HarvestOpts {
  /** 계획 시각(epoch 초) — 구간 끝이 «지금» 인 판의 위치 · 마지막 글 시각의 상한. 없으면 그런 판의 위치는 안 옮긴다. */
  plannedAt?: number | null;
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
export function harvestUnits(caps: readonly Capture[], units: readonly PlannedUnit[], opts: HarvestOpts = {}): { byUnit: Map<number, UnitHarvest>; stray: number } {
  const plannedAt = typeof opts.plannedAt === "number" && Number.isFinite(opts.plannedAt) ? Math.floor(opts.plannedAt) : null;
  const byUnit = new Map<number, UnitHarvest>();
  //  같은 좌표가 여러 번 나오면 rank 가 큰 쪽(같으면 먼저 본 것)이 남는다.
  const seen = new Map<number, Map<string, { it: RawItem; rank: number }>>();
  for (const u of units) {
    byUnit.set(u.id, { items: [], reads: 0, complete: false, why: null, nextCursor: null, advanced: false, lastItemAt: null, unparsed: 0, stuck: false });
    seen.set(u.id, new Map());
  }
  let stray = 0;
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
      if (!u) { stray++; continue; }
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
      if (!u) { stray++; continue; }
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
  return { byUnit, stray };
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
