// ⚠ Lively Enterprise Edition — 이 디렉터리(src/ee)는 상용 라이센스다. src/ee/LICENSE 참조.
//   유효한 구독 없이 프로덕션에서 사용할 수 없다(열람·개발·테스트는 허용).
//
// 감사로그 CSV 내보내기(#1309) — 관리탭 [감사 로그] 3탭(관리 변경·DB 조회·AI 도구 호출)의 "CSV 다운로드".
//
//  ── 왜 capability 가 아니라 별도 라우트인가 ──
//   capability REST 어댑터(web.ts)는 handler 반환값을 res.json() 으로 **한 번에** 내보낸다. 감사로그는 무제한
//   증가하는 로그성 데이터라 전량을 서버 메모리에 올릴 수 없다 — 그래서 이 표면만 스트리밍한다.
//   종전 화면(#1309 이전)은 브라우저가 500행씩 페이지를 돌며 5000행에서 끊었다. 그 상한은 임의의 숫자가 아니라
//   구조의 증상이었다: ① 요청 N/500 번 ② 매 요청마다 집계 6종(summary·byTool·byHarness·byDay·toolOptions)을
//   통째로 재계산 ③ OFFSET 이 깊어질수록 느려짐 ④ CSV 문자열을 탭 메모리에 전량 누적.
//   여기서는 keyset 커서(id DESC)로 한 번의 응답에 흘려보내므로 ①~④ 가 전부 사라지고 상한이 필요없다.
//
//  ── 스냅샷 일관성 ──
//   내보내는 동안에도 새 기록은 계속 INSERT 된다(append-only). 고정하지 않으면 최신순 정렬이 밀려 같은 행이
//   두 파일에 들어가거나 빠진다. 그래서 plan 이 정한 snapshot_id(그 시점의 최대 id) 이하만 내보낸다.
//
//  ⚠ 필터 SQL 은 화면(3탭)이 쓰는 조회 API 와 **같은 의미**여야 한다 — 화면에 보이는 것과 받은 CSV 가 다르면
//   감사 자료로 쓸 수 없다. 원본은 각각:
//     tools → capabilities/tool-usage.ts (tool_usage_stats)
//     org   → org/store.ts listContentAudit (org_audit_list)
//     db    → capabilities/db-audit.ts (db_audit_list)
//   그쪽 필터를 고치면 여기도 같이 고칠 것(각 파일에 상호참조 주석을 달아 뒀다).
import type express from "express";
import { once } from "node:events";
import { sessionOrBearer } from "../../auth/http-auth.js";
import type { BearerVerifier } from "../../auth/bearer.js";
import type { LivelyUser } from "../../context.js";
import { wrap, HttpError } from "../../http/rest-util.js";
import { DANGEROUS_SCOPES } from "../../auth/scopes.js";
import { WINDOWS } from "../../capabilities/tool-usage.js";
import { itemsPool } from "../../db/client.js";
import { ADMIN_AUDIT_ENTITIES } from "../../org/store.js";
import { incognitoFromHeaders } from "../../org/auth/agent-identity.js";
import { orgTimezone } from "../../org/timezone.js"; // 파일명 날짜 라벨을 조직 시간대로 자른다(#1309)

// 한 번에 DB 에서 꺼내는 행 수. 크게 잡을수록 왕복은 줄지만 한 배치가 통째로 메모리에 뜬다 —
//  mcp_call_log.args 는 도구 인자(잘려도 KB 단위)라 2000행이 현실적인 상한선이다.
const BATCH = 2000;
// 한 파일에 담는 최대 행 수 = 파일 분할 단위. Excel 시트 상한이 1,048,576행(헤더 포함)이라 그 아래로 잡는다 —
//  넘겨서 한 파일로 주면 "다 받았는데 열리지 않는다"가 되어 안 준 것과 같다(#1309 "파일 분할해서라도").
export const PART_ROWS = 1_000_000;

const userOf = (req: express.Request): LivelyUser =>
  ((req as unknown as { auth?: { extra?: unknown } }).auth?.extra ?? {}) as unknown as LivelyUser;

// ── 쿼리 파라미터 정규화 ──
function qs(v: unknown, max = 200): string {
  if (typeof v !== "string") return "";
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `인자 형식이 잘못되었습니다 — ${max}자를 초과합니다`);
  return t;
}
function qiso(v: unknown): string | null {
  const t = qs(v, 40);
  if (!t) return null;
  if (Number.isNaN(Date.parse(t))) throw new HttpError(400, "기간 형식이 잘못되었습니다 — ISO8601 이어야 합니다");
  return t;
}
function qbool(v: unknown): boolean {
  return v === "1" || v === "true";
}
function qbig(v: unknown): string | null {
  const t = qs(v, 32);
  if (!t) return null;
  if (!/^\d{1,19}$/.test(t)) throw new HttpError(400, "snapshot_id 형식이 잘못되었습니다");
  return t;
}
function qpart(v: unknown): number {
  const t = qs(v, 8);
  if (!t) return 1;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 1 || Math.floor(n) !== n) throw new HttpError(400, "part 형식이 잘못되었습니다 — 1 이상 정수");
  return n;
}

// ── kind 별 내보내기 정의 ──
export interface ExportSpec {
  idCol: string;      // keyset 커서 컬럼(BIGSERIAL PK). 조인이 있으면 별칭 포함.
  from: string;       // FROM 절(조인 포함)
  where: string;      // WHERE 절($1..$n) — 화면 조회 API 와 동치
  params: unknown[];
  select: string;     // SELECT 목록. 별칭 순서 = CSV 컬럼 순서
  columns: string[];  // CSV 헤더(= 행 객체 키)
  baseName: string;   // 파일명 앞부분
}

// 기간 라벨 — 파일명에 무엇을 뽑았는지 남긴다(2026-06-01_2026-06-30 · 7d · all).
//  ⚠ **조직 시간대로 자른다.** 화면은 "7월 30일 하루"를 그 지역의 자정~자정으로 보내므로(KST 면 UTC 7/29 15:00),
//   ISO 문자열을 그냥 앞 10자로 자르면 파일 이름이 `2026-07-29_2026-07-30` 이 되어 **고른 날짜와 하루 어긋난다**.
//   파일만 보고 무슨 기간인지 알아야 하는 게 이 라벨의 존재 이유라, 어긋나면 없느니만 못하다.
//  sv-SE 로케일은 YYYY-MM-DD 를 준다(Intl 표준 트릭 — 별도 포맷터 불필요).
function periodLabel(window: string, since: string | null, until: string | null, tz: string): string {
  const d = (s: string): string => {
    try { return new Date(s).toLocaleDateString("sv-SE", { timeZone: tz }); }
    catch { return s.slice(0, 10); } // 알 수 없는 시간대 — 라벨 때문에 내보내기가 실패하면 안 된다
  };
  if (since || until) return `${since ? d(since) : "처음"}_${until ? d(until) : "지금"}`.replace(/[^\w.-]/g, "");
  return window || "all";
}

// 쿼리스트링 → 내보내기 정의. req 가 아니라 query 객체를 받는다 — HTTP 없이 단위검증하기 위해서다
//  (필터 SQL 의 $n 번호와 params 개수가 어긋나면 런타임에야 터지는데, 그건 감사 자료를 뽑는 순간이다).
export function buildSpec(q: Record<string, unknown>, tz = "UTC"): ExportSpec {
  const kind = qs(q.kind, 16) || "tools";
  const since = qiso(q.since);
  const until = qiso(q.until);

  if (kind === "tools") {
    // 원본: capabilities/tool-usage.ts — 절대 기간(since/until)이 오면 상대 window 는 무시(거기와 같은 규칙).
    const w = qs(q.window, 8) || "7d";
    const window = Object.prototype.hasOwnProperty.call(WINDOWS, w) ? w : "7d";
    const interval = (since || until) ? null : WINDOWS[window];
    return {
      idCol: "id",
      from: "mcp_call_log",
      where: `WHERE ($1::text IS NULL OR called_at >= now() - $1::interval)
                AND ($2 = '' OR harness = $2)
                AND ($3::bool IS NOT TRUE OR NOT ok)
                AND ($4::timestamptz IS NULL OR called_at >= $4)
                AND ($5::timestamptz IS NULL OR called_at <= $5)
                AND ($6 = '' OR tool = $6)`,
      params: [interval, qs(q.harness), qbool(q.errors), since, until, qs(q.tool)],
      select: "called_at, tool, harness, actor, ok, duration_ms, error, args",
      columns: ["called_at", "tool", "harness", "actor", "ok", "duration_ms", "error", "args"],
      baseName: `mcp-calls-${periodLabel(window, since, until, tz)}${qbool(q.errors) ? "-errors" : ""}`,
    };
  }

  if (kind === "org") {
    // 원본: org/store.ts listContentAudit. scope='all' 이면 지식·프로젝트까지 전부, 그 외엔 민감 관리 엔티티만.
    const entity = qs(q.entity);
    const scope = qs(q.scope, 8);
    const entities = entity ? [entity] : (scope === "all" ? null : [...ADMIN_AUDIT_ENTITIES]);
    return {
      idCol: "a.id",
      from: "org_content_audit a LEFT JOIN org_member m ON m.id = a.actor",
      where: `WHERE ($1::text[] IS NULL OR a.entity = ANY($1))
                AND ($2::text IS NULL OR a.entity_key = $2)
                AND ($3::text IS NULL OR a.actor = $3)
                AND ($4::text IS NULL OR a.actor_kind = $4)
                AND ($5::text IS NULL OR a.channel = $5)
                AND ($6::text IS NULL OR a.op = $6)
                AND ($7::timestamptz IS NULL OR a.at >= $7::timestamptz)
                AND ($8::timestamptz IS NULL OR a.at <= $8::timestamptz)`,
      params: [
        entities, qs(q.entity_key) || null, qs(q.actor) || null,
        qs(q.actor_kind) || null, qs(q.channel) || null, qs(q.op) || null,
        since, until,
      ],
      select: `a.at, a.entity, a.entity_key, a.op, a.actor, m.display_name AS actor_display,
               a.actor_kind, a.channel, a.source, a.req_ip, a.before, a.after`,
      columns: ["at", "entity", "entity_key", "op", "actor", "actor_display", "actor_kind", "channel", "source", "req_ip", "before", "after"],
      baseName: `admin-changes-${periodLabel("all", since, until, tz)}`,
    };
  }

  if (kind === "db") {
    // 원본: capabilities/db-audit.ts. `tables ? $3` 는 JSONB 포함 연산자 — node-postgres 는 $n 만 치환하므로 그대로 간다.
    const op = qs(q.op, 16);
    if (op && op !== "query" && op !== "schema") throw new HttpError(400, "op 은 query|schema 만 허용됩니다");
    return {
      idCol: "id",
      from: "db_access_log",
      where: `WHERE ($1 = '' OR user_id = $1)
                AND ($2 = '' OR source = $2)
                AND ($3 = '' OR tables ? $3)
                AND ($4 = '' OR op = $4)
                AND (NOT $5::bool OR ok = false)
                AND ($6::timestamptz IS NULL OR at >= $6)
                AND ($7::timestamptz IS NULL OR at <= $7)`,
      params: [qs(q.user), qs(q.source), qs(q.table).toLowerCase(), op, qbool(q.errors), since, until],
      select: `at, user_id, harness, op, source, tables, masked_columns, unmasked_columns,
               subject_keys, row_count, duration_ms, ok, error, sql`,
      columns: ["at", "user_id", "harness", "op", "source", "tables", "masked_columns", "unmasked_columns", "subject_keys", "row_count", "duration_ms", "ok", "error", "sql"],
      baseName: `db-access-${periodLabel("all", since, until, tz)}`,
    };
  }

  throw new HttpError(400, "kind 형식이 잘못되었습니다 — tools|org|db 중 하나여야 합니다");
}

// ── CSV 직렬화 ──
// 수식 인젝션 방어(OWASP CSV Injection) — 감사로그 셀에는 사람·에이전트가 넣은 문자열이 그대로 들어간다
//  (도구 인자·실행 SQL·에러 메시지). Excel/Sheets 는 = + - @ 나 탭/CR 로 시작하는 셀을 **수식으로 실행**하므로
//  앞에 작은따옴표를 덧대 텍스트로 고정한다. 숫자·불리언은 값이 손상되면 안 되므로 제외한다(음수 -3 → '-3 방지).
const CSV_RISKY = /^[=+\-@\t\r]/;
export function csvCell(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  let s: string;
  if (v === null || v === undefined) s = "";
  else if (v instanceof Date) s = v.toISOString();
  else if (typeof v === "object") { try { s = JSON.stringify(v); } catch { s = String(v); } }
  else s = String(v);
  if (s === "") return s;
  if (CSV_RISKY.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function csvLine(row: Record<string, unknown>, columns: string[]): string {
  const out: string[] = [];
  for (const c of columns) out.push(csvCell(row[c]));
  return out.join(",") + "\r\n";
}

// 총 행수·스냅샷·분할 계획. 화면이 이걸 먼저 받아 "몇 개 파일을 받게 되는지" 알고 순차 다운로드한다.
export function planParts(total: number): number {
  return total === 0 ? 0 : Math.ceil(total / PART_ROWS);
}

export function registerAuditExportRoutes(app: express.Express, verifier: BearerVerifier): void {
  const authResolve = sessionOrBearer(verifier);

  // admin 게이트 — 세 원본 capability 가 모두 scope=admin(전 구성원의 행위·인자가 나간다).
  //  정적 토큰 차단은 web.ts 의 capability 어댑터와 같은 규칙(DANGEROUS_SCOPES)을 그대로 적용해 파리티를 맞춘다.
  const requireAdmin: express.RequestHandler = (req, res, next) => {
    const user = userOf(req);
    if (!user || !user.userId) { res.status(401).json({ error: "unauthenticated" }); return; }
    if (!(Array.isArray(user.scopes) && user.scopes.includes("admin"))) {
      res.status(403).json({ error: "forbidden: 'admin' 권한이 필요합니다" }); return;
    }
    if (DANGEROUS_SCOPES.has("admin") && user.tokenSource === "static") { // admin 은 위험 scope — 규칙의 출처를 코드로 남긴다
      res.status(403).json({ error: "정적 토큰으로는 관리/런타임 변경이 불가합니다 — 접속 해제할 수 있는 발급 토큰(lvk_)을 사용하세요" }); return;
    }
    if (incognitoFromHeaders(req.headers)) {
      res.status(403).json({ error: "인코그니토 세션 — 라이블리 접근이 비활성화되어 있습니다(#1007). 이 세션의 LIVELY_MODE(=incognito)를 해제하고 다시 시도하세요." }); return;
    }
    next();
  };
  const mw: express.RequestHandler[] = [authResolve, requireAdmin];

  // ── 계획: 이 필터로 몇 행이 나오고 몇 개 파일로 나뉘는지 + 스냅샷 기준점 ──
  app.get("/api/ui/audit-export/plan", ...mw, wrap(async (req, res) => {
    const spec = buildSpec((req.query ?? {}) as Record<string, unknown>, await orgTimezone());
    const r = await itemsPool.query(
      `SELECT count(*)::int8 AS total, max(${spec.idCol})::int8 AS max_id FROM ${spec.from} ${spec.where}`,
      spec.params,
    );
    const total = Number(r.rows[0]?.total ?? 0);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      total,
      snapshot_id: r.rows[0]?.max_id != null ? String(r.rows[0].max_id) : null,
      part_rows: PART_ROWS,
      parts: planParts(total),
      columns: spec.columns,
      filename: spec.baseName + ".csv",
    });
  }));

  // ── 본체: CSV 스트리밍(행수 상한 없음) ──
  app.get("/api/ui/audit-export.csv", ...mw, wrap(async (req, res) => {
    const spec = buildSpec((req.query ?? {}) as Record<string, unknown>, await orgTimezone());
    const part = qpart(req.query?.part);
    let snapshot = qbig(req.query?.snapshot_id);
    // 화면은 plan 에서 받은 snapshot_id 를 실어 보낸다. 직접 URL 로 부른 경우(운영자 curl)엔 지금 시점으로 고정.
    if (snapshot === null) {
      const m = await itemsPool.query(`SELECT max(${spec.idCol})::int8 AS id FROM ${spec.from} ${spec.where}`, spec.params);
      snapshot = m.rows[0]?.id != null ? String(m.rows[0].id) : "0";
    }

    const n = spec.params.length;
    const pCur = `$${n + 1}`, pLim = `$${n + 2}`;
    const pageSql = `SELECT ${spec.select}, ${spec.idCol} AS __cursor_id
                       FROM ${spec.from} ${spec.where}
                        AND ${spec.idCol} < ${pCur}::bigint
                      ORDER BY ${spec.idCol} DESC
                      LIMIT ${pLim}`;

    // 분할 시작점 — part 2 부터는 앞 part 가 이미 가져간 행을 건너뛴다. OFFSET 은 여기 한 번만 쓰고
    //  이후는 keyset 이라, 깊은 OFFSET 의 비용을 파일당 1회로 묶는다(매 배치마다 무는 것과 다르다).
    //  커서는 exclusive upper bound 라 시작값은 snapshot+1(= snapshot 포함).
    let cursor = (BigInt(snapshot) + 1n).toString();
    if (part > 1) {
      const skip = (part - 1) * PART_ROWS;
      const s = await itemsPool.query(
        `SELECT ${spec.idCol} AS id FROM ${spec.from} ${spec.where}
           AND ${spec.idCol} <= $${n + 1}::bigint
         ORDER BY ${spec.idCol} DESC OFFSET $${n + 2} LIMIT 1`,
        [...spec.params, snapshot, skip],
      );
      if (!s.rows.length) { // 범위를 넘는 part — 헤더만 있는 빈 파일(오류 아님: 경계에서 행이 줄어들 수 있다)
        sendCsvHeaders(res, spec, part);
        res.end("﻿" + spec.columns.join(",") + "\r\n");
        return;
      }
      cursor = (BigInt(String(s.rows[0].id)) + 1n).toString();
    }

    sendCsvHeaders(res, spec, part);
    // BOM — Excel 이 UTF-8 을 한글로 읽게 하는 관용(없으면 한글이 깨진다).
    if (!res.write("﻿" + spec.columns.join(",") + "\r\n")) await once(res, "drain");

    let emitted = 0;
    for (;;) {
      if (res.destroyed || res.writableEnded) return; // 브라우저가 취소함 — 더 긁지 않는다
      const room = PART_ROWS - emitted;
      if (room <= 0) break;
      const r = await itemsPool.query(pageSql, [...spec.params, cursor, Math.min(BATCH, room)]);
      const rows = r.rows as Array<Record<string, unknown>>;
      if (!rows.length) break;
      let buf = "";
      for (const row of rows) buf += csvLine(row, spec.columns);
      // 백프레셔 — 소켓이 못 따라가면 기다린다. 이걸 빼면 느린 연결에서 응답 전체가 서버 메모리에 쌓인다.
      if (!res.write(buf)) await once(res, "drain");
      emitted += rows.length;
      cursor = String(rows[rows.length - 1].__cursor_id);
      if (rows.length < Math.min(BATCH, room)) break;
    }
    res.end();
  }));
}

// 파일명은 ASCII 로만 — RFC 6266 확장(filename*)까지 갈 이유가 없다(baseName 은 영문·숫자·날짜).
function sendCsvHeaders(res: express.Response, spec: ExportSpec, part: number): void {
  const name = `${spec.baseName}${part > 1 ? `-part${part}` : ""}.csv`.replace(/[^\w.-]/g, "_");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}
