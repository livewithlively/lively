import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pg from "pg";
import { getPool } from "../db/pool.js";
import { getMysqlPool, execReadQueryMysql, type MysqlPoolLike } from "../db/mysql-engine.js";
import { listTableNames, listColumnsMeta } from "../db/catalog.js";
import { assertSafeSelect, isSystemDeniedTable, type SafeSelectOpts } from "../db/firewall.js";
import { auditQuery } from "../db/audit.js";
import { AuditWriteError, collectSubjectKeys, persistAccessBestEffort, persistAccessOrThrow } from "../db/access-log.js";
import { getSourceConfig, listSourceConfigs, resolveSourceName, refreshSources } from "../db/sources.js";
import { refreshPolicy, getSourcePolicy, resolveMaskedAttrs, getMaskStyleMap, getSubjectColSet, resolveSubjectAttrs, resolveUnmaskKeys, peekMaskedSrcKeyToCol } from "../db/policy.js";
import { planMaskTargets, applyRowMasking, type FieldMeta, type MaskStyle } from "../db/mask.js";
import { resolveUser, requireDbSource, canAccessDbSource, hasAnyDbAccess } from "../context.js";

// pg 결과 필드 출처 메타(oid:attnum) — execReadQuery 반환 전용. 게이트2 진입 시 엔진 중립 srcKey 로 변환된다(#715).
export interface PgFieldMeta {
  name: string;
  tableID: number;
  columnID: number;
}

export interface DbQueryResult {
  columns: string[];
  rows: unknown[];
  rowCount: number;
  truncated: boolean;
  fields: PgFieldMeta[]; // 마스킹(게이트2)용 출처 메타(name/tableID/columnID) — 응답엔 미노출
}

// 읽기 전용 트랜잭션 한 사이클: BEGIN READ ONLY → statement_timeout → (소스가 RLS 면) set_config 주입
//  → 사용자 SELECT → ROLLBACK. pg.PoolClient.query 만 의존하므로 목 클라이언트로 호출 순서·바인딩을
//  단위테스트할 수 있다(src/tools/db.test.ts).
export async function execReadQuery(
  client: Pick<pg.PoolClient, "query">,
  cfg: { rls: string | null; timeoutMs: number; maxRows: number },
  userId: string,
  sql: string,
): Promise<DbQueryResult> {
  await client.query("BEGIN READ ONLY");
  await client.query(`SET LOCAL statement_timeout = ${cfg.timeoutMs}`);
  if (cfg.rls) {
    await client.query("SELECT set_config($1, $2, true)", [cfg.rls, userId]);
  }
  const result = await client.query({ text: sql, rowMode: "array" });
  const allRows = result.rows;
  const rows = allRows.slice(0, cfg.maxRows);
  const truncated = allRows.length > cfg.maxRows;
  await client.query("ROLLBACK"); // 읽기 전용 → 항상 롤백
  return {
    columns: result.fields.map((f) => f.name),
    rows,
    rowCount: rows.length,
    truncated,
    fields: result.fields.map((f) => ({ name: f.name, tableID: f.tableID, columnID: f.columnID })),
  };
}

// db 직접등록 툴(capability 레지스트리 밖) — 웹 도구 토글 후보·http_proxy 섀도잉 차단에 쓰인다.
// registerDbTools 본문의 server.registerTool 이름·title 과 동기 유지.
export const DB_TOOLS = [
  { name: "db_sources", title: "DB 소스 목록",
    description: "이 게이트웨이에 등록된 읽기 데이터소스 목록. db_query/db_schema 의 source 인자에 쓸 이름을 확인한다(접속 URL·자격증명 비노출). admin 은 내장 'self' 소스(게이트웨이 자기 items DB — 지식·프로젝트·도메인맵)가 항상 보인다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "db_schema", title: "DB 스키마 조회",
    description: "테이블/컬럼 메타데이터를 반환한다. table 을 주면 그 컬럼만, 없으면 테이블 목록. source 로 데이터소스를 고른다.",
    inputSchema: { type: "object", properties: { table: { type: "string" }, source: { type: "string" } } } },
  { name: "db_query", title: "읽기 전용 SQL 실행",
    description: "단일 SELECT 문만 실행한다. 결과는 사용자 권한(RLS)에 따라 자동 필터된다. 쓰기/DDL 불가, 행수·실행시간 제한. admin 은 내장 'self' 소스로 이 게이트웨이 자기 콘텐츠(지식·프로젝트·태스크·카테고리·도메인맵)를 별도 등록 없이 SQL 조회 가능(콘텐츠 테이블만 — 시크릿·PII 차단).",
    inputSchema: { type: "object", required: ["sql"], properties: { sql: { type: "string", description: "실행할 단일 SELECT 문" }, source: { type: "string", description: "데이터소스 이름(db_sources 로 확인)" } } } },
] as const;

// harness: 이 요청의 접속 신원(buildServer 가 전달) — db 접근 감사(P5, #746)의 harness 귀속에 쓴다.
export function registerDbTools(server: McpServer, harness?: string | null): void {
  // 등록된 읽기 데이터소스 디스커버리 — 자유 SQL 전에 여기서 소스 이름을 확인한다(접속 URL·자격증명 미노출).
  server.registerTool(
    "db_sources",
    {
      title: "DB 소스 목록",
      description:
        "이 게이트웨이에 등록된 읽기 데이터소스 목록. db_query/db_schema 의 source 인자에 쓸 이름을 여기서 확인한다. 접속 URL·자격증명은 노출하지 않는다. allowed=현재 토큰으로 접근 가능 여부, rls=행수준 격리 적용 여부, origin=env(운영자 직접)|db(웹 관리)|builtin(내장 self — admin 전용, 게이트웨이 자기 items DB: 지식·프로젝트·도메인맵). 등록 소스가 없는 고객 박스에서도 admin 은 self 로 자기 콘텐츠를 조회할 수 있다.",
      inputSchema: {},
    },
    async (_args, extra) => {
      const user = resolveUser(extra);
      if (!hasAnyDbAccess(user)) {
        throw new Error(`Forbidden: user '${user.userId}' lacks any 'db' scope`);
      }
      await refreshSources(); // env∪DB 병합 스냅샷 최신화(웹에서 추가한 소스 즉시 반영)
      const sources = listSourceConfigs().map((s) => ({
        name: s.name,
        driver: s.driver,
        authMode: s.authMode,
        origin: s.origin,
        rls: s.rls !== null, // GUC 이름 자체는 비노출 — 행수준 격리 적용 여부만
        maxRows: s.maxRows,
        timeoutMs: s.timeoutMs,
        allowed: canAccessDbSource(user, s.name),
      }));
      return { content: [{ type: "text", text: JSON.stringify({ sources }, null, 2) }] };
    },
  );

  // 안전한 메타데이터 조회 (RLS 무관). 여기부터 시작하는 걸 권장.
  server.registerTool(
    "db_schema",
    {
      title: "DB 스키마 조회",
      description:
        "테이블/컬럼 메타데이터를 반환합니다. table 을 주면 그 컬럼만, 없으면 테이블 목록. source 로 데이터소스를 고른다(미지정 시 기본 소스 — 다중 등록 시 명시 필요, db_sources 참조).",
      inputSchema: { table: z.string().optional(), source: z.string().optional() },
    },
    async ({ table, source }, extra) => {
      const user = resolveUser(extra);
      await refreshSources();
      await refreshPolicy();
      // P5(#746) — 스키마 접근도 성공·차단·실패 전건 감사에 남긴다(메타데이터라 best-effort — 기록 실패가 조회를 막진 않음).
      //  차단 프로빙(deny/시스템 테이블 이름 더듬기)이 기록에서 빠지면 안 되므로 권한·정책 체크도 try 안에서 진행(리뷰 blocking①).
      let src = String(source ?? "").trim() || "(미지정)";
      const schemaAudit = (ok: boolean, tables: string[], error?: string): void =>
        persistAccessBestEffort({
          userId: user.userId, tokenHashPrefix: user.tokenHashPrefix ?? null, harness: harness ?? null,
          op: "schema", source: src, sql: null, tables, maskedColumns: [], rowCount: 0, durationMs: 0,
          ok, error: error ?? null, subjectKeys: null,
        });
      try {
        src = resolveSourceName(source);
        requireDbSource(user, src);
        const policy = getSourcePolicy(src); // 테이블 정책 오버레이(라이브 스키마 위)
        // P4(#746) — masked 표시도 요청자 언마스크를 반영(권한자에겐 db_query 가 raw 를 주므로 masked 로 오도하지 않게).
        const unmask = await resolveUnmaskKeys(user.userId, src);
        const masks = getMaskStyleMap(src, unmask.keys);
        // 카탈로그 조회는 엔진 공통 모듈(db/catalog.ts) — pg='public' / mysql=소스 스키마(DATABASE()) (#715).
        if (table) {
          const tl = table.toLowerCase();
          if (isSystemDeniedTable(tl)) throw new Error(`Blocked table: ${tl} — 게이트웨이 내부 테이블은 조회할 수 없습니다(시스템 차단)`);
          const mode = policy.tableMode.get(tl) ?? policy.tableDefault;
          if (mode === "deny") throw new Error(`Blocked table: ${tl} — 이 소스에서 조회가 허용되지 않은 테이블입니다(웹 관리)`);
          const cols = await listColumnsMeta(src, table);
          const rows = cols.map((r) => {
            const style = masks.get(`${tl}.${r.column_name.toLowerCase()}`);
            return style ? { ...r, masked: style } : r; // 마스킹 컬럼 표시(에이전트가 파생/필터 회피하도록)
          });
          schemaAudit(true, [tl]);
          return { content: [{ type: "text", text: JSON.stringify({ source: src, table, rows }, null, 2) }] };
        }
        // effective-allow 테이블만 노출(시스템 내부 테이블 제외) — allow-list(table_default='deny') 모드면 허용된 것만 보인다.
        const names = await listTableNames(src);
        const rows = names
          .filter((n) => {
            const tn = n.toLowerCase();
            if (isSystemDeniedTable(tn)) return false;
            return (policy.tableMode.get(tn) ?? policy.tableDefault) === "allow";
          })
          .map((n) => ({ table_name: n }));
        schemaAudit(true, []);
        return { content: [{ type: "text", text: JSON.stringify({ source: src, rows }, null, 2) }] };
      } catch (e) {
        schemaAudit(false, table ? [String(table).toLowerCase()] : [], (e as Error).message);
        throw e;
      }
    },
  );

  // 자유 SQL — 여러 겹의 가드 위에서만 동작한다.
  server.registerTool(
    "db_query",
    {
      title: "읽기 전용 SQL 실행",
      description:
        "단일 SELECT 문만 실행합니다. 결과는 사용자 권한(RLS)에 따라 자동 필터됩니다. 쓰기/DDL 불가, 결과 행수·실행시간 제한이 적용됩니다. source 로 데이터소스를 고른다(미지정 시 기본 소스 — 다중 등록 시 명시 필요, db_sources 참조). admin 은 내장 'self' 소스로 이 게이트웨이 자기 콘텐츠(지식·프로젝트·태스크·카테고리·도메인맵)를 별도 등록 없이 SQL 조회할 수 있습니다(콘텐츠 테이블만 — 시크릿·개인정보 차단). 예: db_query({source:'self', sql:'select count(*) from knowledge'}).",
      inputSchema: {
        sql: z.string().describe("실행할 단일 SELECT 문"),
        source: z.string().optional().describe("데이터소스 이름(db_sources 로 확인)"),
      },
    },
    async ({ sql, source }, extra) => {
      const user = resolveUser(extra);
      await refreshSources();
      await refreshPolicy();
      const src = resolveSourceName(source);
      requireDbSource(user, src); // 방어선 0: 소스별 권한
      const cfg = getSourceConfig(src);
      if (!cfg) throw new Error(`db source '${src}' 설정을 찾을 수 없습니다`); // 리프레시-삭제 경합 방어
      // P4(#746) — raw-PII 언마스크: 요청 멤버의 유효 grant 를 해소해 마스킹 대상에서 per-user 차감.
      //  Gate1(파생차단)·Gate2(값마스킹)·fail-closed 카운트가 요청자 기준으로 자연 정합(권한자는 그 컬럼 raw 조회).
      const unmask = await resolveUnmaskKeys(user.userId, src);
      const policy = getSourcePolicy(src, unmask.keys);
      const gateOpts: SafeSelectOpts | undefined =
        cfg.driver === "mysql" ? { dialect: "mysql", schema: cfg.database } : undefined;

      // P5(#746) — 게이트1 차단·실행 실패·성공 전부 db_access_log 에 남도록 게이트1부터 try 안에서 진행한다.
      const started = Date.now();
      const auditBase = {
        userId: user.userId, tokenHashPrefix: user.tokenHashPrefix ?? null, harness: harness ?? null,
        op: "query" as const, source: src, sql,
      };
      let planTables: string[] = [];
      let maskedColNames: string[] = [];
      let unmaskedColNames: string[] = [];
      let unmaskedGrantIds: string[] = [];
      try {
        // 방어선 1·2 + 게이트1(테이블 allow/deny · 마스킹-파생 차단) — mysql 은 dialect+크로스-스키마 거부(#715).
        const plan = assertSafeSelect(sql, policy, gateOpts);
        planTables = plan.tables ?? [];

        // ── 엔진별 실행 → 엔진 중립 형태(rows + fields.srcKey)로 정규화 ──
        interface NormResult { columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean; fields: FieldMeta[] }
        let out: NormResult;
        let attrStyles: Map<string, MaskStyle> | null = null;
        if (cfg.driver === "mysql") {
          // mysql(#715): 출처가 결과 필드(orgTable/orgName)에 직접 실려 온다 — 정책 키(table.col)와 같은 도메인.
          const pool = (await getMysqlPool(src)) as unknown as MysqlPoolLike;
          out = await execReadQueryMysql(pool, { timeoutMs: cfg.timeoutMs, maxRows: cfg.maxRows, database: cfg.database }, sql);
          if (policy.hasMasks || unmask.keys.size > 0) attrStyles = getMaskStyleMap(src, unmask.keys);
        } else {
          const pool = await getPool(src);
          const client = await pool.connect();
          let r: DbQueryResult;
          try {
            r = await execReadQuery(client, cfg, user.userId, sql);
          } catch (e) {
            await client.query("ROLLBACK").catch(() => { /* 이미 실패 — 정리 시도만 */ });
            throw e;
          } finally {
            client.release();
          }
          out = {
            ...r,
            rows: r.rows as unknown[][],
            fields: r.fields.map((f) => ({ name: f.name, srcKey: f.tableID && f.columnID ? `${f.tableID}:${f.columnID}` : null })),
          };
          // 게이트2(pg) — (table,col) 정책을 소스 카탈로그의 (oid,attnum)=srcKey 로 해석.
          if (policy.hasMasks || unmask.keys.size > 0) attrStyles = await resolveMaskedAttrs(src, pool, unmask.keys);
        }

        let masked = 0;
        if (attrStyles) {
          // 게이트2 — DB 가 알려주는 출처(srcKey)로 마스킹 대상 식별해 게이트웨이에서 값 마스킹(고객 DB 무수정).
          const targets = planMaskTargets(out.fields, attrStyles);
          // fail-closed — 게이트1 기대 마스킹 출력에 미달(뷰/무출처 등)하면 유출 대신 거부.
          if (targets.length < plan.minMaskedOutputs || (plan.hasTopStarOverMaskedTable && targets.length === 0)) {
            throw new Error("마스킹 검증 실패 — 개인정보 컬럼의 출처를 확인할 수 없어 쿼리를 거부합니다(컬럼을 명시하거나 관리자에게 문의)");
          }
          if (targets.length > 0) out = { ...out, rows: applyRowMasking(out.rows, targets) };
          masked = targets.length;
          maskedColNames = targets.map((t) => out.fields[t.index]?.name ?? `#${t.index}`);
        }

        // P4 — 이 쿼리 출력에 '실제로 반환된' 언마스크 컬럼만 감사에 기록(테이블 멤버십이 아니라 out.fields 기준 — 과다기록 방지).
        //  mysql: srcKey 자체가 `table.col` / pg: 캐시된 srcKeyToCol(oid:attnum→table.col)로 되돌린다. grant_ids 는 그 컬럼을 연 grant 만.
        if (unmask.keys.size > 0) {
          const s2c = cfg.driver === "mysql" ? null : peekMaskedSrcKeyToCol(src);
          const outCols = new Set<string>();
          for (const f of out.fields) {
            if (!f.srcKey) continue;
            const col = cfg.driver === "mysql" ? f.srcKey : s2c?.get(f.srcKey);
            if (col && unmask.keys.has(col)) outCols.add(col);
          }
          unmaskedColNames = [...outCols];
          const gidSet = new Set<string>();
          for (const col of outCols) for (const gid of (unmask.grantsByKey.get(col) ?? [])) gidSet.add(gid);
          unmaskedGrantIds = [...gidSet];
        }

        // P5 — 조회 대상 식별자(subject) 수집: 지정 컬럼(org_db_subject_key)의 반환값만 상한부.
        //  mysql=srcKey(table.col) 직접 매칭 / pg=카탈로그 해석(oid:attnum→table.col). 마스킹 적용 후 값 기준(fail-safe).
        let subjectKeys: ReturnType<typeof collectSubjectKeys> = null;
        const subjSet = getSubjectColSet(src);
        if (subjSet.size > 0) {
          if (cfg.driver === "mysql") {
            subjectKeys = collectSubjectKeys(out.fields, out.rows, (k) => (subjSet.has(k) ? k : null));
          } else {
            const attrs = await resolveSubjectAttrs(src, await getPool(src));
            subjectKeys = collectSubjectKeys(out.fields, out.rows, (k) => attrs.get(k) ?? null);
          }
        }

        // P5 — 감사 우선(fail-closed): 기록이 성공해야 결과를 반환한다(실패 시 AuditWriteError → 아래 catch).
        await persistAccessOrThrow({
          ...auditBase, tables: planTables, maskedColumns: maskedColNames,
          unmaskedColumns: unmaskedColNames, grantIds: unmaskedGrantIds.length > 0 ? unmaskedGrantIds : null,
          rowCount: out.rowCount, durationMs: Date.now() - started, ok: true, subjectKeys,
        });
        auditQuery({ userId: user.userId, source: src, sql, rowCount: out.rowCount, ms: Date.now() - started, ok: true, masked });
        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              { source: src, columns: out.columns, rows: out.rows, rowCount: out.rowCount, truncated: out.truncated, ...(masked ? { masked } : {}) },
              null, 2),
          }],
        };
      } catch (e) {
        auditQuery({
          userId: user.userId,
          source: src,
          sql,
          rowCount: 0,
          ms: Date.now() - started,
          ok: false,
          error: (e as Error).message,
        });
        // P5 — 차단(게이트1)·실행 실패도 감사에 남긴다(best-effort). 감사 실패로 인한 거부(AuditWriteError)는 재시도 무의미.
        if (!(e instanceof AuditWriteError)) {
          // 게이트1 차단 시 plan 이 없으므로, firewall 이 에러에 실어준 참조 테이블로 감사 행을 채운다.
          const errTables = (e as { tables?: string[] }).tables;
          if (planTables.length === 0 && Array.isArray(errTables)) planTables = errTables;
          persistAccessBestEffort({
            ...auditBase, tables: planTables, maskedColumns: maskedColNames,
            rowCount: 0, durationMs: Date.now() - started, ok: false, error: (e as Error).message, subjectKeys: null,
          });
        }
        throw e;
      }
    },
  );
}
