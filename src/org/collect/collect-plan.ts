// 수집 실행의 계획과 뒷수습(#4213 T11 저장 단계) — **순수**. 무엇을 시킬지(고정 지시) · 끝난 뒤 원문을 단위별 자료로 나누기 ·
//  읽은 위치를 어디로 옮길지. DB 는 run-ingest.ts 가 만진다.
//
//  ── 실행 종류 ──
//   · listing — 그 사람 커넥터로 «무엇이 있나» 를 훑는다 → recordUnitListing(verified:true). 앱 하나.
//   · collect — 그 사람이 지금 담당인 단위(T10 listAssignedUnits)를 읽는다 → storeUnitItems + advanceUnitCursor.
//  지시는 서버가 고정해서 준다(모델은 도구를 부르기만 한다). 무엇이 자료가 되는지는 원문을 서버가 풀어 정한다(connector-parse).
//
//  ── 읽은 위치 규칙 ──
//   슬랙·지메일은 새 것부터 거꾸로 쪽을 넘긴다. 그래서 한 판이 맡은 구간을 끝까지 읽었을 때만(마지막 쪽에 다음 cursor 가 없고 ·
//   지메일은 찾은 스레드를 다 펼쳤을 때만) 위치를 옮긴다. 못 다 읽었으면 위치는 그대로 두고 읽은 것만 저장한다 — 다음 판이 같은
//   위치부터 다시 읽고, 같은 좌표라 행이 늘지 않는다(T10 mirrorSourceV6). 빠뜨리는 것보다 다시 읽는 게 낫다.
//   ⚠ 바쁜 채널·메일함은 «위치부터 지금까지» 가 한 판에 안 끝나 위치가 영영 못 움직인다. 그래서 구간을 자른다 — 슬랙 7일 ·
//    지메일 1일. 구간 끝이 지금보다 앞이면 그 구간만 읽고, 다 읽으면 위치를 구간 끝으로 옮긴다(조용한 구간도 넘어간다).
import type { RawItem } from "../../items/store.js";
import {
  type Capture, type ListedUnit, gmailItem, gmailMailbox, notionItem, parseGmailMessages, parseNotionFetch, parseNotionList,
  parseSlackChannelList, parseSlackChannelMessages, parseSlackThread, slackItem, slackTsIso,
} from "./connector-parse.js";

export type CollectMode = "probe" | "listing" | "collect";

/** 목록·수집을 아는 앱 — 앱 키(source.external_system) → claude.ai 커넥터 이름. */
export const CLAUDE_COLLECT_APPS: Readonly<Record<string, string>> = { slack: "Slack", gmail: "Gmail", notion: "Notion" };

/** 처음 읽는 단위(읽은 위치 없음)는 최근 이만큼만 — 처음 수집 기간은 나중에 리브가 대화로 정한다(확정판 §5). */
export const FIRST_READ_DAYS = 14;
/** 한 판이 읽는 구간 — 따라잡을 때 한 번에 이만큼씩(초). */
export const SLACK_WINDOW_SEC = 7 * 86400;
export const GMAIL_WINDOW_SEC = 86400;
/** 한 판에 단위 하나에서 넘길 쪽 · 펼칠 스레드 상한. */
export const PAGES_PER_UNIT = 10;
export const THREADS_PER_UNIT = 20;
/** 한 판에 담는 단위 상한 — 넘는 단위는 다음 판(주기, T12)이 읽는다. */
export const UNITS_PER_RUN = 12;

const FOOT = "보내기·만들기·고치기·지우기 도구는 부르지 않는다. 도구 결과를 고쳐 쓰거나 요약하지 않는다. 다 끝나면 «끝» 이라고만 답한다.";

/** 목록 실행 지시 — 목록 도구만 부르고 다음 쪽이 없을 때까지 넘긴다. */
export function listingPrompt(app: string): string {
  if (app === "slack") return [
    "목록 실행이다. 이 사람이 볼 수 있는 슬랙 대화의 목록을 빠짐없이 모은다.",
    '1. slack_list_user_channels 를 types="public_channel,private_channel,mpim,im", limit=200, exclude_archived=true 로 부른다.',
    "2. 결과 끝에 다음 쪽 cursor 가 있으면 그 cursor 를 넣어 같은 도구를 다시 부른다. cursor 가 없을 때까지 되풀이한다(최대 20번).",
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

/** 수집 실행에 싣는 단위 한 줄(T10 AssignedUnit 에서 필요한 칸만). */
export interface PlannedUnit {
  id: number; app: string; instance: string; ref: string; kind: string; name: string | null; connector: string;
  /** 이번에 읽기 시작할 곳 — 슬랙 ts(«1786345368.603919») · 지메일 epoch 초 · 노션은 null. */
  since: string | null;
  /** 이번 구간의 끝(같은 꼴) — 지금까지면 null. 다 읽으면 위치가 여기로 간다. */
  until?: string | null;
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
    if (typeof c.ts === "string" && /^\d{9,11}\.\d{1,6}$/.test(c.ts)) return c.ts;
    const lia = u.from_collector ? epochSec(u.last_item_at) : null;
    return `${lia ?? first}.000000`;
  }
  if (u.app === "gmail") {
    if (typeof c.after === "number" && Number.isInteger(c.after) && c.after > 0) return String(c.after);
    return String((u.from_collector ? epochSec(u.last_item_at) : null) ?? first);
  }
  return null;
}

/** 이번 판의 구간 — 시작에서 구간 길이만큼, 그 끝이 지금 이후면 끝 없음(null). 노션은 구간이 없다. */
export function unitWindow(u: { app: string; cursor: Record<string, unknown> | null; last_item_at: string | null; from_collector: boolean }, now: number): { since: string | null; until: string | null } {
  const since = unitSince(u, now);
  if (since == null) return { since, until: null };
  const nowSec = Math.floor(now / 1000);
  if (u.app === "slack") {
    const end = Math.floor(Number(since)) + SLACK_WINDOW_SEC;
    return { since, until: end < nowSec ? `${end}.000000` : null };
  }
  if (u.app === "gmail") {
    const end = Number(since) + GMAIL_WINDOW_SEC;
    return { since, until: end < nowSec ? String(end) : null };
  }
  return { since, until: null };
}

/** 한 단위의 지시 줄 — 앱마다 정확한 도구·인자를 적는다(모델이 고르지 않게). 모르는 앱은 null(싣지 않는다). */
export function unitInstruction(u: PlannedUnit): string | null {
  const label = u.name ? `${u.ref}(${u.name.replace(/[\n\r"]/g, " ").slice(0, 60)})` : u.ref;
  if (u.app === "slack") return [
    `· 슬랙 대화 ${label}: slack_read_channel 을 channel_id="${u.ref}", oldest="${u.since}"${u.until ? `, latest="${u.until}"` : ""}, limit=100 으로 부른다.`,
    `  결과에 다음 쪽 cursor 가 있으면 cursor 를 넣어 다시 부른다(최대 ${PAGES_PER_UNIT}쪽).`,
    `  읽은 메시지 가운데 «Thread: N replies» 가 붙은 것마다 slack_read_thread 를 channel_id="${u.ref}", message_ts=<그 메시지의 Message TS>, limit=200 으로 부른다(최대 ${THREADS_PER_UNIT}개).`,
  ].join("\n");
  if (u.app === "gmail") return [
    `· 지메일 메일함: search_threads 를 query="after:${u.since}${u.until ? ` before:${u.until}` : ""}", pageSize=50 으로 부른다. 결과에 nextPageToken 이 있으면 pageToken 으로 이어서 부른다(최대 ${PAGES_PER_UNIT}쪽).`,
    `  찾은 스레드마다 하나도 빼지 말고 get_thread 를 threadId=<그 id>, messageFormat="PLAIN_TEXT" 로 부른다.`,
  ].join("\n");
  if (u.app === "notion") return `· 노션 ${u.kind === "database" ? "데이터베이스" : "페이지"} ${label}: notion-fetch 를 id="${u.ref}" 로 한 번 부른다.`;
  return null;
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
  /** 이 단위의 자료(같은 좌표는 한 번 — 본문이 있는 쪽). */
  items: RawItem[];
  /** 이 단위를 실제로 읽은 도구 호출 수(0 이면 이 판은 이 단위를 안 읽었다 — 위치·읽은 시각을 옮기지 않는다). */
  reads: number;
  /** oldest 이후를 끝까지 읽었나(마지막 쪽에 다음이 없었나). */
  complete: boolean;
  /** 옮길 읽은 위치 — 끝까지 읽었고 새 것이 있을 때만. */
  nextCursor: Record<string, unknown> | null;
  /** 이 판에 본 가장 새 항목의 시각. */
  lastItemAt: string | null;
  /** 이 단위의 도구 결과인데 풀린 항목이 없던 호출 수(형식이 바뀌었을 수 있다 — 실패로 본다). */
  unparsed: number;
}

/** 수집 실행의 원문 → 단위별 자료. 요청하지 않은 그릇(채널·메일함·페이지)의 항목은 버린다. */
export function harvestUnits(caps: readonly Capture[], units: readonly PlannedUnit[]): { byUnit: Map<number, UnitHarvest>; stray: number } {
  const byUnit = new Map<number, UnitHarvest>();
  //  같은 좌표가 여러 번 나오면 «더 온전한 쪽» 이 남는다(rank 가 큰 쪽 · 같으면 먼저 본 것).
  //   지메일은 search_threads 의 한 줄 요약(rank 1)보다 get_thread 의 본문 전체(rank 2)가 이긴다 — 요약도 본문 칸에 들어가므로
  //   «본문이 있나» 로 가르면 요약이 먼저 와서 본문을 막는다(맥 실측 2026-10-16: 4건 모두 요약만 저장됐다).
  const seen = new Map<number, Map<string, { it: RawItem; rank: number }>>();
  const fresh = (): UnitHarvest => ({ items: [], reads: 0, complete: true, nextCursor: null, lastItemAt: null, unparsed: 0 });
  for (const u of units) { byUnit.set(u.id, fresh()); seen.set(u.id, new Map()); }
  let stray = 0;
  const slackUnit = (ch: string | null) => (ch ? units.find((u) => u.app === "slack" && u.ref === ch) ?? null : null);
  const gmailUnits = units.filter((u) => u.app === "gmail");
  const put = (u: PlannedUnit, it: RawItem, rank = 0) => {
    const m = seen.get(u.id)!;
    const k = it.provenance.external_id;
    const prev = m.get(k);
    if (!prev || rank > prev.rank) m.set(k, { it, rank });
  };
  const slackMax = new Map<number, string>();
  //  지메일 — 찾은 스레드 · 펼친 스레드(구간을 다 읽었나 = 찾은 것을 다 펼쳤나).
  const searched = new Map<number, Set<string>>(), fetched = new Map<number, Set<string>>();
  const addTo = (m: Map<number, Set<string>>, id: number, v: string | null) => { if (!v) return; if (!m.has(id)) m.set(id, new Set()); m.get(id)!.add(v); };
  for (const c of caps) {
    if (c.tool === "slack_read_channel") {
      const r = parseSlackChannelMessages(c);
      const u = slackUnit(r.channel?.id ?? null);
      if (!u) { stray++; continue; }
      const h = byUnit.get(u.id)!;
      h.reads++;
      if (r.more) h.complete = false;
      if (!r.messages.length && c.text.length > 400 && !/no (more )?messages/i.test(c.text)) h.unparsed++;
      for (const m of r.messages) {
        put(u, slackItem(m, { instance: u.instance, channel: u.ref, channelName: r.channel?.name ?? u.name }));
        const cur = slackMax.get(u.id);
        if (!cur || Number(m.ts) > Number(cur)) slackMax.set(u.id, m.ts);
      }
    } else if (c.tool === "slack_read_thread") {
      const r = parseSlackThread(c);
      const u = slackUnit(r.channelId);
      if (!u) { stray++; continue; }
      const h = byUnit.get(u.id)!;
      h.reads++;
      if (!r.parent && !r.replies.length) { h.unparsed++; continue; }
      const parentTs = r.parent?.ts ?? (typeof c.input.message_ts === "string" ? c.input.message_ts : null);
      if (r.parent) put(u, slackItem({ ...r.parent, reply_count: r.parent.reply_count ?? (r.replies.length || null) }, { instance: u.instance, channel: u.ref, channelName: u.name }));
      for (const m of r.replies) put(u, slackItem(m, { instance: u.instance, channel: u.ref, channelName: u.name, threadParentTs: parentTs }));
    } else if (c.tool === "search_threads" || c.tool === "get_thread" || c.tool === "get_message") {
      const msgs = parseGmailMessages(c);
      const box = gmailMailbox(msgs);
      //  메일함이 둘 이상이면 주소로 맞춘다. 하나뿐이면 주소를 못 읽은 결과도 그 메일함 것이다(그 사람 커넥터는 메일함 하나).
      const u = box ? gmailUnits.find((x) => x.ref === box) ?? null : (gmailUnits.length === 1 ? gmailUnits[0] : null);
      if (!u) { stray++; continue; }
      const h = byUnit.get(u.id)!;
      h.reads++;
      if (c.tool === "search_threads" && typeof (c.json as Record<string, unknown> | null)?.nextPageToken === "string") h.complete = false;
      if (!msgs.length && c.text.length > 400) h.unparsed++;
      for (const m of msgs) {
        put(u, gmailItem(m, { instance: u.instance || "default", mailbox: u.ref }), m.full ? 2 : 1);
        addTo(c.tool === "search_threads" ? searched : fetched, u.id, m.threadId ?? m.id);
      }
    } else if (c.tool === "notion-fetch") {
      const p = parseNotionFetch(c);
      const u = p ? units.find((x) => x.app === "notion" && x.ref === p.id) ?? null : null;
      if (!u) { stray++; continue; }
      const h = byUnit.get(u.id)!;
      h.reads++;
      put(u, notionItem(p!, { instance: u.instance }));
    }
  }
  for (const u of units) {
    const h = byUnit.get(u.id)!;
    h.items = [...seen.get(u.id)!.values()].map((v) => v.it);
    const times = h.items.map((i) => i.updated_at ?? i.occurred_at).filter((t): t is string => !!t).sort();
    h.lastItemAt = times.length ? times[times.length - 1] : null;
    if (u.app === "gmail" && h.complete) {
      const done = fetched.get(u.id) ?? new Set<string>();
      if ([...(searched.get(u.id) ?? [])].some((t) => !done.has(t))) h.complete = false;
    }
    if (!h.reads || !h.complete) { h.nextCursor = null; continue; }
    if (u.app === "slack") {
      //  구간을 끝까지 읽었으면 구간 끝으로(조용한 구간도 넘어간다), 지금까지 읽었으면 가장 새 메시지로.
      const ts = u.until ?? slackMax.get(u.id);
      h.nextCursor = ts ? { ts } : null;
    } else if (u.app === "gmail") {
      const ep = u.until != null ? Number(u.until) : epochSec(h.lastItemAt);
      h.nextCursor = ep ? { after: ep } : null;
    } else if (u.app === "notion") {
      h.nextCursor = h.lastItemAt ? { edited_at: h.lastItemAt } : null;
    }
  }
  return { byUnit, stray };
}

/** 목록 실행의 원문 → 단위 목록 · 전부인가 · (지메일) 메일함. */
export function harvestListing(caps: readonly Capture[], app: string): { units: ListedUnit[]; complete: boolean; calls: number; unparsed: number } {
  const units = new Map<string, ListedUnit>();
  let calls = 0, unparsed = 0;
  let lastMore: boolean | null = null;
  for (const c of caps) {
    if (app === "slack" && c.tool === "slack_list_user_channels") {
      calls++;
      const r = parseSlackChannelList(c);
      if (!r.units.length && c.text.length > 200) unparsed++;
      const archived = new Set(r.archived);
      for (const u of r.units) if (!archived.has(u.ref) && !units.has(u.ref)) units.set(u.ref, u);
      lastMore = r.more;
    } else if (app === "notion" && /^notion-(list-(shared|private|recent)-pages|search)$/.test(c.tool)) {
      calls++;
      const r = parseNotionList(c);
      if (!r.units.length && c.text.length > 200) unparsed++;
      for (const u of r.units) if (!units.has(u.ref)) units.set(u.ref, u);
    } else if (app === "gmail" && c.tool === "search_threads") {
      calls++;
      const box = gmailMailbox(parseGmailMessages(c));
      if (box && !units.has(box)) units.set(box, { ref: box, name: box, kind: "mailbox" });
    }
  }
  //  «전부» 는 슬랙만, 마지막 목록 쪽에 다음이 없었을 때만 — 노션 목록 도구는 볼 수 있는 페이지 전부를 주지 않고,
  //   지메일은 메일함 하나다(전부라고 하면 이 사람이 다른 메일함에서 빠진다).
  const complete = app === "slack" && calls > 0 && lastMore === false && unparsed === 0;
  return { units: [...units.values()], complete, calls, unparsed };
}

/** 슬랙 ts 를 ISO 로(화면·기록용 재수출). */
export { slackTsIso };
