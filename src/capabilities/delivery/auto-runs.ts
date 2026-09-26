// delivery ▸ auto-runs — [맥락 관리 ▸ 현황] 「자동 실행」 패널의 데이터(#4172 · #4135 2판 A안, 원준 2026-09-25 확정).
//
//  원준·상민(2026-09-21 회의): "수집이 1시 50분·2시·2시 10분 … 눌렀을 때 새로 몇 건이 들어왔고 기존 거 몇 건이 수정됐다
//   이 정도는 볼 수 있으면 … 증류도 마찬가지고 분류도 마찬가지고, 자동으로 도는 거는 그 기록을 볼 수 있었으면".
//
//  새 기록 표를 만들지 않는다 — 이미 쌓이는 셋에서 조립한다:
//   · 수집 = connector_run(실행 한 번) × org_content_audit(그 실행 구간에 커넥터가 실제로 넣은/바꾼 행 — 미러의 감사 노이즈
//     게이트가 «내용이 바뀐 때만» 적으므로 insert = 새로 들어옴 · update = 바뀜 이 그대로 성립한다). 같은 system 의 두 수집기가
//     같은 시각에 돌면 둘을 가르지 못한다(감사 actor 가 `connector:<system>` 까지라서) — 드물고, 합계는 맞는다.
//   · 증류 = org_task(레인마다 한 배치 = 한 번의 실행, requester_session = `cron:<잡>#<레인 key>`) ×
//     org_distiller_seen(그 배치가 읽은 자료) × knowledge_source(그 자료에서 그 배치 구간에 나온 지식).
//     카테고리 붙이기 레인은 org_classifier_seen × knowledge_category(mapped_by='llm').
//  목록(org_auto_runs)은 **수치만** 준다 — 제목을 싣지 않으니 가시성 판정이 필요 없다(org_connector_runs 가 이미 주는 수준).
//  제목은 한 건을 펼칠 때(org_auto_run_detail) 자료·지식 가시성 술어를 **그대로** 태워서만 준다(#1291 — 잠긴 것은 세지도 않는다).
import type { Capability } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { itemsPool } from "../../db/client.js";
import { isAdmin, viewerOf } from "../principal.js";
import { sourceVisWhere } from "../../v6/source-store.js";
import { knowledgeVisWhere } from "../../v6/knowledge-store.js";
import { restWork } from "./shared.js";

/** 하루치로 충분하다 — 10분 주기 수집기 열 개면 하루 1,440회. 그 이상은 화면이 읽지 못한다. */
const MAX_COLLECT = 5000;
const MAX_TASKS = 3000;
const CLASSIFY_JOB_RE = /classify/;

type AutoRunRow = {
  key: string; kind: "c" | "d"; id: number; machine_id: string; name: string; system: string | null; lane: "source" | "category" | null;
  started_at: string; finished_at: string | null; status: string; error: string | null;
  inserted: number; updated: number; read: number | null;
  /** 걸린 시간(초) — 끝나지 않았으면 null. */
  duration_sec: number | null;
};
const durSec = (a: unknown, b: unknown): number | null => (a && b ? Math.max(0, Math.round((new Date(b as string).getTime() - new Date(a as string).getTime()) / 1000)) : null);
const isChanged = (r: AutoRunRow): boolean => r.status === "error" || r.status === "canceled" || r.inserted + r.updated > 0;

/** 조회 창 — since(기본 24시간 전) ~ until(기본 지금). 창은 maxDays 를 넘지 않는다(표 전체를 긁는 조회가 되지 않게). */
function windowOf(since: unknown, until: unknown, maxDays: number): { since: Date; until: Date } {
  const u = until ? new Date(String(until)) : new Date();
  if (Number.isNaN(u.getTime())) throw new HttpError(400, "until 은 ISO 시각이어야 합니다");
  const s0 = since ? new Date(String(since)) : new Date(u.getTime() - 24 * 3600_000);
  if (Number.isNaN(s0.getTime())) throw new HttpError(400, "since 는 ISO 시각이어야 합니다");
  if (s0.getTime() >= u.getTime()) throw new HttpError(400, "since 는 until 보다 앞이어야 합니다");
  //  기록 보관(자동 실행 화면이 보여 주는 범위)은 최근 31일 — 그보다 먼 과거·너무 넓은 창은 잘라 받는다.
  const floor = Date.now() - 31 * 24 * 3600_000;
  const s = new Date(Math.max(s0.getTime(), floor, u.getTime() - maxDays * 24 * 3600_000));
  return { since: s, until: u };
}

/** 날짜 묶기의 시간대 — 보는 사람의 IANA 이름(예 Asia/Seoul). 모르는 값이면 UTC. */
function tzOf(v: unknown): string {
  const t = String(v || "").trim();
  if (!t || t.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/.test(t)) return "UTC";
  try { new Intl.DateTimeFormat("en-CA", { timeZone: t }); return t; } catch { return "UTC"; }
}

/** 실패한 수집 실행의 사정 — 로그 마지막 줄(사람이 읽을 한 줄). */
function lastLine(log: string | null): string | null {
  const lines = String(log || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const l = lines.length ? lines[lines.length - 1] : "";
  return l ? l.slice(0, 300) : null;
}

async function collectorRuns(since: Date, until: Date, limit = MAX_COLLECT): Promise<AutoRunRow[]> {
  const r = await itemsPool.query(
    `WITH r AS (
       SELECT r.id, r.system, r.collector_id, r.status, r.started_at, r.finished_at,
              CASE WHEN r.status IN ('error','canceled') THEN right(r.log, 2000) END AS log_tail,
              c.label, c.key AS ckey
         FROM connector_run r LEFT JOIN org_collector c ON c.id = r.collector_id
        WHERE r.started_at >= $1 AND r.started_at < $2
        ORDER BY r.started_at DESC LIMIT ${Math.max(1, Math.min(limit, MAX_COLLECT))})
     SELECT r.*,
            (SELECT count(*) FROM org_content_audit a WHERE a.actor = 'connector:' || r.system AND a.op = 'insert'
               AND a.entity IN ('source','knowledge') AND a.at >= r.started_at AND a.at <= COALESCE(r.finished_at, now()))::int AS inserted,
            (SELECT count(*) FROM org_content_audit a WHERE a.actor = 'connector:' || r.system AND a.op = 'update'
               AND a.entity IN ('source','knowledge') AND a.at >= r.started_at AND a.at <= COALESCE(r.finished_at, now()))::int AS updated
       FROM r ORDER BY r.started_at DESC`, [since, until]);
  return (r.rows as any[]).map((x) => ({
    key: "c" + x.id, kind: "c", id: Number(x.id),
    machine_id: x.collector_id ? String(x.collector_id) : "sys:" + x.system,
    name: String(x.label || x.ckey || x.system), system: String(x.system), lane: null,
    started_at: new Date(x.started_at).toISOString(), finished_at: x.finished_at ? new Date(x.finished_at).toISOString() : null,
    status: String(x.status), error: x.status === "error" || x.status === "canceled" ? (x.status === "canceled" ? "중지됨" : lastLine(x.log_tail) || "실패") : null,
    inserted: Number(x.inserted || 0), updated: Number(x.updated || 0), read: null,
    duration_sec: durSec(x.started_at, x.finished_at),
  }));
}

/** 증류 배치(작업 상자) — 레인 key 로 증류기·카테고리 붙이기 증류기를 찾는다. 점검·지도 등 다른 크론 작업은 뺀다. */
async function distillRuns(since: Date, until: Date): Promise<AutoRunRow[]> {
  const t = await itemsPool.query(
    `SELECT id, requester_session, status, created_at, started_at, finished_at, error
       FROM org_task
      WHERE created_at >= $1 AND created_at < $2 AND requester_session LIKE 'cron:%#%'
      ORDER BY created_at DESC LIMIT ${MAX_TASKS}`, [since, until]);
  if (!t.rows.length) return [];
  const [ds, cs] = await Promise.all([
    itemsPool.query(`SELECT id, key, label FROM org_distiller`),
    itemsPool.query(`SELECT id, key, label FROM org_classifier`),
  ]);
  const dByKey = new Map((ds.rows as any[]).map((x) => [String(x.key), x]));
  const cByKey = new Map((cs.rows as any[]).map((x) => [String(x.key), x]));
  const tasks: Array<{ row: any; lane: "source" | "category"; m: any }> = [];
  for (const row of t.rows as any[]) {
    const marker = String(row.requester_session || "");
    const hash = marker.indexOf("#");
    const job = marker.slice(5, hash), key = marker.slice(hash + 1);
    const isCat = CLASSIFY_JOB_RE.test(job);
    const m = isCat ? cByKey.get(key) : dByKey.get(key);
    if (m) tasks.push({ row, lane: isCat ? "category" : "source", m });
  }
  if (!tasks.length) return [];
  const srcIds = tasks.filter((x) => x.lane === "source").map((x) => Number(x.row.id));
  const catIds = tasks.filter((x) => x.lane === "category").map((x) => Number(x.row.id));
  const [srcRead, srcMade, catRead, catMade] = await Promise.all([
    srcIds.length ? itemsPool.query(`SELECT task_id, count(*)::int AS n FROM org_distiller_seen WHERE task_id = ANY($1::bigint[]) GROUP BY task_id`, [srcIds]) : null,
    //  그 배치가 읽은 자료에서 **그 배치 구간에** 이어진 지식 — 새로 생긴 것(knowledge.created_at 이 구간 안)과 고친 것(그 전부터 있던 것).
    srcIds.length ? itemsPool.query(
      `SELECT ds.task_id,
              count(DISTINCT ks.name) FILTER (WHERE k.created_at >= COALESCE(t.started_at, t.created_at))::int AS inserted,
              count(DISTINCT ks.name) FILTER (WHERE k.created_at <  COALESCE(t.started_at, t.created_at))::int AS updated
         FROM org_distiller_seen ds
         JOIN org_task t ON t.id = ds.task_id
         JOIN knowledge_source ks ON ks.source_id = ds.source_id AND ks.relation = 'derived_from'
          AND ks.created_at >= COALESCE(t.started_at, t.created_at) AND ks.created_at <= COALESCE(t.finished_at, now()) + interval '2 minutes'
         JOIN knowledge k ON k.name = ks.name
        WHERE ds.task_id = ANY($1::bigint[])
        GROUP BY ds.task_id`, [srcIds]) : null,
    catIds.length ? itemsPool.query(`SELECT task_id, count(*)::int AS n FROM org_classifier_seen WHERE task_id = ANY($1::bigint[]) GROUP BY task_id`, [catIds]) : null,
    catIds.length ? itemsPool.query(
      `SELECT cs.task_id, count(DISTINCT kc.name)::int AS n
         FROM org_classifier_seen cs
         JOIN org_task t ON t.id = cs.task_id
         JOIN knowledge_category kc ON kc.name = cs.knowledge_name AND kc.mapped_by = 'llm'
          AND kc.created_at >= COALESCE(t.started_at, t.created_at) AND kc.created_at <= COALESCE(t.finished_at, now()) + interval '2 minutes'
        WHERE cs.task_id = ANY($1::bigint[])
        GROUP BY cs.task_id`, [catIds]) : null,
  ]);
  const byTask = (q: any, col = "n") => new Map(((q?.rows || []) as any[]).map((x) => [Number(x.task_id), x[col] ?? x]));
  const sRead = byTask(srcRead), cRead = byTask(catRead), cMade = byTask(catMade);
  const sMade = new Map(((srcMade?.rows || []) as any[]).map((x) => [Number(x.task_id), x]));
  return tasks.map(({ row, lane, m }) => {
    const id = Number(row.id);
    const made = sMade.get(id) as any;
    const st = String(row.status);
    return {
      key: "d" + id, kind: "d" as const, id, machine_id: (lane === "category" ? "cat:" : "src:") + m.id,
      name: lane === "category" ? "카테고리 붙이기 · " + String(m.label || m.key) : String(m.label || m.key),
      system: null, lane,
      started_at: new Date(row.started_at || row.created_at).toISOString(), finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      status: st === "done" ? "ok" : st === "failed" ? "error" : st,
      error: st === "failed" ? String(row.error || "실패").slice(0, 300) : st === "canceled" ? "중지됨" : null,
      inserted: lane === "category" ? 0 : Number(made?.inserted || 0),
      //  카테고리 붙이기는 지식을 새로 만들지 않는다 — 칸을 붙인 수를 «고친 지식» 으로 센다.
      updated: lane === "category" ? Number(cMade.get(id) || 0) : Number(made?.updated || 0),
      read: Number((lane === "category" ? cRead : sRead).get(id) || 0),
      duration_sec: durSec(row.started_at, row.finished_at),
    };
  });
}

/** 한 건 펼치기 — 수집: 그 실행이 넣은/바꾼 자료·지식 / 증류: 그 배치가 만든·고친 지식(가시성 술어 그대로). */
type RunItem = { tag: "new" | "mod"; title: string; where: string | null; href: string | null };
type RunDetail = { items: RunItem[]; log?: string | null; summary?: string | null };
async function runDetail(kind: string, id: number, user: LivelyUser): Promise<RunDetail> {
  const viewer = viewerOf(user);
  const items: RunItem[] = [];
  if (kind === "c") {
    //  로그 끝부분 — org_connector_run_log 가 이미 구성원에게 주는 것과 같은 원문(수·오류 문장).
    const lg = await itemsPool.query(`SELECT right(log, 2500) AS tail FROM connector_run WHERE id = $1`, [id]);
    const log = lg.rows[0] ? String((lg.rows[0] as any).tail || "") : null;
    const a = await itemsPool.query(
      `SELECT a.entity, a.entity_key, a.op FROM connector_run r
         JOIN org_content_audit a ON a.actor = 'connector:' || r.system AND a.op IN ('insert','update')
          AND a.entity IN ('source','knowledge') AND a.at >= r.started_at AND a.at <= COALESCE(r.finished_at, now())
        WHERE r.id = $1 ORDER BY a.at DESC LIMIT 60`, [id]);
    const rows = a.rows as Array<{ entity: string; entity_key: string; op: string }>;
    const srcIds = rows.filter((x) => x.entity === "source").map((x) => Number(x.entity_key)).filter(Number.isFinite);
    const knNames = rows.filter((x) => x.entity === "knowledge").map((x) => x.entity_key);
    const seenS = new Map<number, any>(), seenK = new Map<string, any>();
    if (srcIds.length) {
      const p: unknown[] = [srcIds];
      const vis = await sourceVisWhere(viewer, p);
      const s = await itemsPool.query(`SELECT s.id, s.title, s.fields->>'container_name' AS container FROM source s WHERE s.id = ANY($1::int[]) AND ${vis}`, p);
      for (const x of s.rows as any[]) seenS.set(Number(x.id), x);
    }
    if (knNames.length) {
      const p: unknown[] = [knNames];
      const vis = await knowledgeVisWhere(viewer, p);
      const k = await itemsPool.query(`SELECT k.name, k.title FROM knowledge k WHERE k.name = ANY($1::text[]) AND ${vis}`, p);
      for (const x of k.rows as any[]) seenK.set(String(x.name), x);
    }
    const dup = new Set<string>();
    for (const x of rows) {
      const k = x.entity + ":" + x.entity_key;
      if (dup.has(k)) continue;
      dup.add(k);
      if (x.entity === "source") {
        const s = seenS.get(Number(x.entity_key));
        if (s) items.push({ tag: x.op === "insert" ? "new" : "mod", title: String(s.title || "(제목 없음)"), where: s.container ? String(s.container) : null, href: "#/sources/" + s.id });
      } else {
        const kk = seenK.get(x.entity_key);
        if (kk) items.push({ tag: x.op === "insert" ? "new" : "mod", title: String(kk.title || kk.name), where: null, href: "#/knowledge/" + encodeURIComponent(kk.name) });
      }
    }
    return { items, log };
  }
  const t = await itemsPool.query(`SELECT id, requester, requester_session, created_at, started_at, finished_at, left(result->>'summary', 2000) AS summary FROM org_task WHERE id = $1`, [id]);
  const task = t.rows[0] as any;
  if (!task) throw new HttpError(404, "그 실행이 없습니다");
  //  그 배치 AI 의 마지막 말(요약)은 읽은 자료 내용을 담을 수 있다 — 자료 가시성을 우회하지 않도록 관리자·그 레인의 실행 계정에게만.
  const summary = (isAdmin(user) || (viewer && viewer === String(task.requester || ""))) ? (task.summary ? String(task.summary) : null) : null;
  const isCat = CLASSIFY_JOB_RE.test(String(task.requester_session || "").split("#")[0]);
  const p: unknown[] = [id];
  const vis = await knowledgeVisWhere(viewer, p);
  const q = isCat
    ? `SELECT DISTINCT k.name, k.title, false AS is_new, COALESCE(c.name, c.key) AS where_
         FROM org_classifier_seen cs JOIN org_task t ON t.id = cs.task_id
         JOIN knowledge_category kc ON kc.name = cs.knowledge_name AND kc.mapped_by = 'llm'
          AND kc.created_at >= COALESCE(t.started_at, t.created_at) AND kc.created_at <= COALESCE(t.finished_at, now()) + interval '2 minutes'
         JOIN category c ON c.id = kc.category_id
         JOIN knowledge k ON k.name = kc.name
        WHERE cs.task_id = $1 AND ${vis} LIMIT 60`
    : `SELECT DISTINCT k.name, k.title, (k.created_at >= COALESCE(t.started_at, t.created_at)) AS is_new, NULL AS where_
         FROM org_distiller_seen ds JOIN org_task t ON t.id = ds.task_id
         JOIN knowledge_source ks ON ks.source_id = ds.source_id AND ks.relation = 'derived_from'
          AND ks.created_at >= COALESCE(t.started_at, t.created_at) AND ks.created_at <= COALESCE(t.finished_at, now()) + interval '2 minutes'
         JOIN knowledge k ON k.name = ks.name
        WHERE ds.task_id = $1 AND ${vis} LIMIT 60`;
  const r = await itemsPool.query(q, p);
  for (const x of r.rows as any[]) {
    items.push({ tag: x.is_new ? "new" : "mod", title: String(x.title || x.name), where: x.where_ ? String(x.where_) : null, href: "#/knowledge/" + encodeURIComponent(x.name) });
  }
  return { items, summary };
}

type DayKind = { runs: number; failed: number; inserted: number; updated: number; read: number };
type DayRow = { day: string; c: DayKind; d: DayKind };

/**
 * 날짜별 합계 — 7일·30일 그래프와 목록 페이지의 요약줄(#4135 3판). 실행 수천 건을 다 내려보내지 않는다.
 *  수집은 SQL 로 바로 묶는다(실행 수 · 실패 = connector_run, 새로·바뀜 = org_content_audit 중 **그 계열 수집 실행이 돌던 동안**
 *  남은 것만 — 웹훅·백필처럼 실행 없이 들어온 것까지 세면 «실행 0회 · 새 자료 1,844» 처럼 줄과 합계가 어긋난다(매니지드 실측).
 *  같은 계열 두 수집기가 겹쳐 돈 구간도 한 번만 센다). 증류 배치는 하루 수십 건이라 줄 단위(distillRuns)를 받아 JS 에서 묶는다.
 *  날짜 경계는 보는 사람의 시간대(tz) — 자정이 사람마다 다르다.
 */
async function dailyRuns(since: Date, until: Date, tz: string): Promise<{ days: DayRow[]; machines: Array<{ id: string; kind: "c" | "d"; name: string; system: string | null }>; recent: AutoRunRow[] }> {
  const [cr, au, ms, d] = await Promise.all([
    itemsPool.query(
      `SELECT to_char((started_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS day, count(*)::int AS runs,
              count(*) FILTER (WHERE status IN ('error','canceled'))::int AS failed
         FROM connector_run WHERE started_at >= $1 AND started_at < $2 GROUP BY 1`, [since, until, tz]),
    itemsPool.query(
      `SELECT to_char((at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS day, op, count(*)::int AS n
         FROM org_content_audit
        WHERE actor LIKE 'connector:%' AND entity IN ('source','knowledge') AND op IN ('insert','update') AND at >= $1 AND at < $2
          AND EXISTS (SELECT 1 FROM connector_run r
                       WHERE r.system = substr(org_content_audit.actor, 11) AND r.started_at <= org_content_audit.at
                         AND r.started_at > org_content_audit.at - interval '12 hours' AND COALESCE(r.finished_at, now()) >= org_content_audit.at)
        GROUP BY 1, 2`, [since, until, tz]),
    itemsPool.query(
      `SELECT DISTINCT r.collector_id, r.system, c.label, c.key
         FROM connector_run r LEFT JOIN org_collector c ON c.id = r.collector_id
        WHERE r.started_at >= $1 AND r.started_at < $2`, [since, until]),
    distillRuns(since, until),
  ]);
  const zero = (): DayKind => ({ runs: 0, failed: 0, inserted: 0, updated: 0, read: 0 });
  const days = new Map<string, DayRow>();
  const at = (day: string): DayRow => { let r = days.get(day); if (!r) { r = { day, c: zero(), d: zero() }; days.set(day, r); } return r; };
  for (const x of cr.rows as any[]) { const r = at(String(x.day)); r.c.runs += Number(x.runs); r.c.failed += Number(x.failed); }
  for (const x of au.rows as any[]) { const r = at(String(x.day)); if (x.op === "insert") r.c.inserted += Number(x.n); else r.c.updated += Number(x.n); }
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  for (const x of d) {
    const r = at(fmt.format(new Date(x.started_at))).d;
    r.runs++; if (x.status === "error" || x.status === "canceled") r.failed++;
    r.inserted += x.inserted; r.updated += x.updated; r.read += x.read || 0;
  }
  const machines: Array<{ id: string; kind: "c" | "d"; name: string; system: string | null }> = [];
  for (const x of ms.rows as any[]) machines.push({ id: x.collector_id ? String(x.collector_id) : "sys:" + x.system, kind: "c", name: String(x.label || x.key || x.system), system: String(x.system) });
  const seen = new Set<string>();
  for (const x of d) if (!seen.has(x.machine_id)) { seen.add(x.machine_id); machines.push({ id: x.machine_id, kind: "d", name: x.name, system: null }); }
  //  «최근 바뀐 실행» 다섯 — 수집은 창 끝 36시간만 줄 단위로 본다(창 전체를 줄로 받지 않는다).
  const recentSince = new Date(Math.max(since.getTime(), until.getTime() - 36 * 3600_000));
  const rc = await collectorRuns(recentSince, until, 3000);
  const recent = [...rc, ...d].filter(isChanged).sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 5);
  return { days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)), machines: dedupeMachines(machines), recent };
}
const dedupeMachines = <T extends { id: string; kind: string }>(xs: T[]): T[] => { const m = new Map<string, T>(); for (const x of xs) m.set(x.kind + ":" + x.id, x); return [...m.values()]; };

export const autoRunsCapabilities: Capability[] = [
  restWork("org_auto_runs", "자동 실행 기록(수집·증류)",
    "since~until(ISO, 기본 최근 24시간 · 창은 최대 3일 · 최근 31일 안) 의 자동 실행 — 수집기 실행(connector_run)과 증류기·카테고리 붙이기 배치(org_task) 한 줄씩. " +
    "줄마다 inserted(수집: 새로 들어온 자료·지식 / 증류: 새 지식) · updated(수집: 내용이 바뀐 것 / 증류: 고친 지식 · 카테고리 붙인 수) · read(증류가 읽은 수) · duration_sec. " +
    "제목은 org_auto_run_detail, 7일·30일 합계는 org_auto_runs_daily.",
    [{ method: "GET", paths: ["/api/ui/org/auto-runs"], parse: (req) => ({
      since: req.query?.since ? String(req.query.since) : undefined, until: req.query?.until ? String(req.query.until) : undefined,
    }) }],
    async (input: Record<string, unknown>) => {
      const { since, until } = windowOf(input.since, input.until, 3);
      const [c, d] = await Promise.all([collectorRuns(since, until), distillRuns(since, until)]);
      return { since: since.toISOString(), until: until.toISOString(), now: new Date().toISOString(), runs: [...c, ...d].sort((a, b) => b.started_at.localeCompare(a.started_at)) };
    }, {
      since: z.string().optional().describe("이 시각(ISO)부터 — 기본 until 24시간 전"),
      until: z.string().optional().describe("이 시각(ISO)까지(미포함) — 기본 지금. 창은 최대 3일"),
    }, false),
  restWork("org_auto_runs_daily", "자동 실행 날짜별 합계",
    "since~until(ISO, 창 최대 31일) 을 보는 사람의 시간대(tz, IANA 예 Asia/Seoul)로 하루씩 묶은 합계 — 날마다 수집·증류 각각 runs · failed · inserted · updated · read. " +
    "machines(그 창에 돈 수집기·증류기) · recent(최근 바뀐 실행 다섯, org_auto_runs 줄 모양)를 함께 준다.",
    [{ method: "GET", paths: ["/api/ui/org/auto-runs/daily"], parse: (req) => ({
      since: req.query?.since ? String(req.query.since) : undefined, until: req.query?.until ? String(req.query.until) : undefined,
      tz: req.query?.tz ? String(req.query.tz) : undefined,
    }) }],
    async (input: Record<string, unknown>) => {
      const { since, until } = windowOf(input.since, input.until, 31);
      const tz = tzOf(input.tz);
      return { since: since.toISOString(), until: until.toISOString(), now: new Date().toISOString(), tz, ...(await dailyRuns(since, until, tz)) };
    }, {
      since: z.string().optional().describe("이 시각(ISO)부터"),
      until: z.string().optional().describe("이 시각(ISO)까지(미포함) — 기본 지금. 창은 최대 31일"),
      tz: z.string().optional().describe("날짜를 가르는 시간대(IANA, 예 Asia/Seoul) — 기본 UTC"),
    }, false),
  restWork("org_auto_run_detail", "자동 실행 한 건 — 무엇이 바뀌었나",
    "kind=c(수집 실행 id) · kind=d(증류 배치 = 작업 id). 수집은 그 실행이 새로 넣거나 바꾼 자료·지식과 로그 끝부분, 증류는 그 배치가 만들거나 고친 지식(카테고리 붙이기는 붙인 칸)과 " +
    "배치 AI 의 마지막 말(관리자·그 레인의 실행 계정에게만). 보는 사람의 공개범위로 거른다 — 못 보는 것은 목록에 없다.",
    [{ method: "GET", paths: ["/api/ui/org/auto-runs/:kind/:id"], parse: (req) => ({ kind: String(req.params?.kind || ""), id: Number(req.params?.id) }) }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const kind = String(input.kind || "");
      const id = Number(input.id);
      if (kind !== "c" && kind !== "d") throw new HttpError(400, "kind 는 c(수집) 또는 d(증류)");
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "id 는 양의 정수");
      return runDetail(kind, id, user);
    }, {
      kind: z.enum(["c", "d"]).describe("c = 수집 실행(connector_run id) · d = 증류 배치(작업 id)"),
      id: z.number().int().positive().describe("실행 id"),
    }, false),
];
