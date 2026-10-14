// v6/search-log-store.ts — 통합검색(⌘K) 기록(#4530 검색 품질 «재는 장치», 원준 2026-10-05).
//
//  왜 — 검색 품질을 고치려는데 «사람들이 실제로 무엇을 치고, 어떤 검색이 0건이고, 몇 째 줄을 여는지» 를 잴 길이 없었다. 진단은
//   기계로 만든 변형 질의로만 했다(매니지드 실측 2026-10-05). 실제 쓰임을 남겨야 다음 판을 수치로 견줄 수 있다.
//  무엇을 — 한 번의 찾기(검색 창을 열어 닫을 때까지)에 한 줄. 결과를 열었으면 그 결과의 종류·자리·층, 안 열고 닫았으면 그 사실.
//   친 글자마다 남기지 않는다(화면이 마지막 검색어로 한 번 보낸다).
//  누가 보나 — 요약(searchLogSummary)은 관리자만. 검색어는 그 사람이 찾던 것이라 남의 것을 그대로 보이지 않는다(라우트가 막는다).
import { itemsPool } from "../db/client.js";

export const SEARCH_LOG_KEEP_DAYS = 180;
const TABS: ReadonlySet<string> = new Set(["all", "sess", "proj", "know", "src"]);
const KINDS: ReadonlySet<string> = new Set(["sess", "proj", "know", "src", "app"]);

export interface SearchLogInput {
  member: string;
  q: string;
  tab?: string;
  sort?: string | null;
  period?: string | null;
  counts?: { sess?: number | null; weak?: number | null; proj?: number | null; know?: number | null; src?: number | null };
  action: "open" | "close";
  opened?: { kind?: string | null; key?: string | null; rank?: number | null; tier?: string | null } | null;
  settleMs?: number | null;
  loosened?: string[] | null;
}

const int = (v: unknown, max: number): number | null => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(max, Math.floor(n)) : null; };
const short = (v: unknown, max: number): string | null => { const s = typeof v === "string" ? v.trim() : ""; return s ? s.slice(0, max) : null; };

/** 한 줄 남긴다. 검색어가 비었으면 남기지 않는다(false). 값은 여기서 깎는다 — 화면이 보낸 것을 그대로 믿지 않는다. */
export async function logSearch(input: SearchLogInput): Promise<boolean> {
  const q = String(input.q ?? "").replace(/\u0000/g, "").trim().slice(0, 200);
  if (!q || !input.member) return false;
  const c = input.counts ?? {};
  const o = input.action === "open" ? (input.opened ?? {}) : {};
  const kind = short(o.kind, 16);
  await itemsPool.query(
    `INSERT INTO search_log(member, q, tab, sort, period, n_sess, n_weak, n_proj, n_know, n_src, action, opened_kind, opened_key, opened_rank, opened_tier, settle_ms, loosened)
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [input.member, q, TABS.has(String(input.tab)) ? String(input.tab) : "all", short(input.sort, 16), short(input.period, 16),
      int(c.sess, 100000), int(c.weak, 100000), int(c.proj, 100000), int(c.know, 100000), int(c.src, 100000),
      input.action === "open" ? "open" : "close",
      kind && KINDS.has(kind) ? kind : null, short(o.key, 200), int(o.rank, 10000), short(o.tier, 16),
      int(input.settleMs, 600000),
      Array.isArray(input.loosened) ? input.loosened.filter((x) => typeof x === "string" && x).slice(0, 8).map((x) => x.slice(0, 60)) : null]);
  return true;
}

/**
 * 묵은 검색 기록을 지운다(SEARCH_LOG_KEEP_DAYS 넘은 줄) — 세션 기록 보존 정리(session-log-reap, 6시간)에 얹혀 돈다.
 *  쓰는 길에서 «가끔» 지우면 검색이 멈춘 워크스페이스는 검색어를 영영 들고 있게 된다(가이드의 «180일 뒤 지웁니다» 가 거짓이 된다, 격리 리뷰).
 */
export async function reapSearchLog(days: number = SEARCH_LOG_KEEP_DAYS): Promise<number> {
  const r = await itemsPool.query(`DELETE FROM search_log WHERE ts < now() - ($1 || ' days')::interval`, [String(Math.max(1, Math.round(days)))]);
  return r.rowCount ?? 0;
}

export interface SearchLogSummary {
  days: number;
  /** 찾기 횟수 · 그중 결과를 연 횟수 · 세션 결과가 하나도 없던 횟수(맞는 것도 덜 맞는 것도). */
  total: number; opened: number; zeroSess: number;
  /** 연 결과의 종류별 수. */
  byKind: Record<string, number>;
  /** 세션을 열었을 때 그 줄의 자리(1부터) — 1 · 2~3 · 4~10 · 그 밖. */
  sessRank: { first: number; top3: number; top10: number; beyond: number };
  /** 연 세션의 층 — 맞는 결과 · 덜 맞는 결과. */
  sessTier: Record<string, number>;
  /** 느슨하게 찾은 낱말이 있던 찾기 수. */
  loosened: number;
  /** 결과를 안 열고 닫은 검색어(자주 나온 것부터) — 무엇이 안 찾아지는지의 실마리. */
  abandoned: Array<{ q: string; n: number; zero: boolean }>;
}

/** 최근 days 일의 요약. 워크스페이스 전체를 센다 — 부르는 쪽이 관리자인지 본다. */
export async function searchLogSummary(days = 14): Promise<SearchLogSummary> {
  const d = Math.min(Math.max(Math.floor(days) || 14, 1), SEARCH_LOG_KEEP_DAYS);
  const since = `now() - ($1 || ' days')::interval`;
  const head = (await itemsPool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE action = 'open')::int AS opened,
            count(*) FILTER (WHERE n_sess IS NOT NULL AND n_sess + COALESCE(n_weak, 0) = 0)::int AS zero_sess,   -- 수를 모르는 줄(NULL)은 0건이 아니다
            count(*) FILTER (WHERE loosened IS NOT NULL AND array_length(loosened, 1) > 0)::int AS loosened,
            count(*) FILTER (WHERE action = 'open' AND opened_kind = 'sess' AND opened_rank = 1)::int AS r1,
            count(*) FILTER (WHERE action = 'open' AND opened_kind = 'sess' AND opened_rank BETWEEN 2 AND 3)::int AS r3,
            count(*) FILTER (WHERE action = 'open' AND opened_kind = 'sess' AND opened_rank BETWEEN 4 AND 10)::int AS r10,
            count(*) FILTER (WHERE action = 'open' AND opened_kind = 'sess' AND opened_rank > 10)::int AS rx
       FROM search_log WHERE ts >= ${since}`, [String(d)])).rows[0] ?? {};
  const kinds = await itemsPool.query(
    `SELECT opened_kind AS k, count(*)::int AS n FROM search_log WHERE ts >= ${since} AND action = 'open' AND opened_kind IS NOT NULL GROUP BY 1`, [String(d)]);
  const tiers = await itemsPool.query(
    `SELECT COALESCE(opened_tier, 'match') AS t, count(*)::int AS n FROM search_log WHERE ts >= ${since} AND action = 'open' AND opened_kind = 'sess' GROUP BY 1`, [String(d)]);
  const ab = await itemsPool.query(
    `SELECT lower(q) AS q, count(*)::int AS n, bool_and(n_sess IS NOT NULL AND n_sess + COALESCE(n_weak, 0) = 0) AS zero
       FROM search_log WHERE ts >= ${since} AND action = 'close'
      GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 40`, [String(d)]);
  const num = (v: unknown): number => Number(v) || 0;
  return {
    days: d, total: num(head.total), opened: num(head.opened), zeroSess: num(head.zero_sess), loosened: num(head.loosened),
    byKind: Object.fromEntries(kinds.rows.map((r) => [String(r.k), num(r.n)])),
    sessRank: { first: num(head.r1), top3: num(head.r3), top10: num(head.r10), beyond: num(head.rx) },
    sessTier: Object.fromEntries(tiers.rows.map((r) => [String(r.t), num(r.n)])),
    abandoned: ab.rows.map((r) => ({ q: String(r.q), n: num(r.n), zero: r.zero === true || r.zero === "t" })),
  };
}
