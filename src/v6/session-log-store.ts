// 세션이력 저장 척추(#905 C1 슬라이스 1) — 트랜스크립트 델타를 중앙에 offset-CAS 로 무결하게 append + 회수.
//  설계: [[project-905-design-assetization]] §5. 스키마: v6/schema.ts(session·session_log·session_log_chunk).
//
//  ── 왜 offset-CAS 인가 (설계 §5 ①) ──
//   여러 tailer(재시작·중복 세션)가 같은 (node, session) 로그에 동시에 델타를 밀 수 있다. 상호배제 프리미티브가
//   없으면 tailer 중복(같은 바이트 두 번)·재시작 재push(껐다 켠 tailer 가 처음부터)·순서역전(늦은 델타가 먼저)이
//   전부 로그를 오염시킨다. **락을 새로 들이는 대신** append 를 조건부 UPDATE 로 만든다:
//     UPDATE session_log SET bytes=bytes+len WHERE (node,session)=… AND bytes=$atOffset
//   현재 워터마크와 정확히 이어질 때만(=atOffset==bytes) 1행이 갱신된다. 두 tailer 가 같은 offset 으로 오면
//   먼저 성공한 쪽이 워터마크를 올려 나머지의 WHERE 를 빗나가게 한다 — DB 가 원자적으로 직렬화(락 불요).
//
//  ⚠ **키는 (node_id, session_id) 복합.** 스칼라면 같은 session_id 를 쓰는 두 머신 로그가 한 줄로 병합되고
//   CAS 가 서로를 못 본다(설계 §5 ①). node_id='' = 게이트웨이 로컬(박스).
import { itemsPool } from "../db/client.js";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

// 무손실 압축 저장(#905 C1 슬②) — 청크 data 를 zstd 로 압축해 저장 공간을 줄인다. **무손실**이라 회수 시 원본 그대로
//  복원(resume/webview 충실성 유지) + 워터마크는 항상 원본 길이(raw_len) 기준(원본 바이트 불변식). 순수 함수라 단위검증.
//  · store="raw" 면 압축 안 함. · 작은/비압축성 청크는 압축 안 하고 원본 저장(codec=null). · 압축 예외는 원본 폴백.
const ZSTD_MIN_BYTES = 512;   // 이보다 작으면 압축 이득이 오버헤드보다 작다 → 원본 저장.
export function encodeChunk(raw: Buffer, store: "slim" | "raw" = "slim"): { data: Buffer; codec: string | null } {
  if (store === "raw" || raw.length < ZSTD_MIN_BYTES) return { data: raw, codec: null };
  try { const c = zstdCompressSync(raw); return c.length < raw.length ? { data: c, codec: "zstd" } : { data: raw, codec: null }; }
  catch { return { data: raw, codec: null }; }   // 압축 실패 → 원본 저장(비치명)
}
export function decodeChunk(data: Buffer, codec: string | null): Buffer {
  return codec === "zstd" ? zstdDecompressSync(data) : data;
}

// append 판정(순수) — 현재 워터마크 대비 들어온 [atOffset, atOffset+len) 이 어떤 상태인가. DB 없이 단위검증한다.
//  · append    : 정확히 이어짐(atOffset==current) → 커밋한다.
//  · duplicate : 이미 다 갖고 있음(atOffset+len<=current) → **멱등 성공**(재시작 재push 안전). 새로 안 쓴다.
//  · gap       : 사이가 비었음(atOffset>current) → 거절. 보낸 쪽이 current 부터 다시 보내야 한다.
//  · overlap   : 꼬리가 겹침(atOffset<current<atOffset+len) → 거절. 부분중복이라 그대로 쓰면 오염된다.
export type CasVerdict = "append" | "duplicate" | "gap" | "overlap";
export function casVerdict(current: number, atOffset: number, len: number): CasVerdict {
  if (atOffset === current) return "append";
  if (atOffset > current) return "gap";
  if (atOffset + len <= current) return "duplicate";
  return "overlap";
}

export interface AppendResult {
  ok: boolean;          // true = 이 델타의 바이트가 (지금 커밋됐든 이미 있든) 로그에 온전히 반영돼 있다.
  verdict: CasVerdict;
  bytes: number;        // 이 (node,session) 로그의 현재 총 바이트 = 다음에 보내야 할 offset(보낸 쪽 워터마크 정정용).
}

// 로그 소유자(첫 append 한 멤버) 조회 — 없으면 null(아직 아무도 안 씀). 엔드포인트가 owner-gate 에 쓴다.
export async function sessionOwner(nodeId: string, sessionId: string): Promise<string | null> {
  const r = await itemsPool.query(`SELECT owner FROM session WHERE node_id=$1 AND session_id=$2`, [nodeId, sessionId]);
  return (r.rows[0]?.owner as string | null) ?? null;
}

// 부모 세션 id — 서브에이전트면 부모(주) 세션 id, 최상위면 null(#905 C1 슬⑥). 렌더 시 sidechain 포함 여부 판정에 쓴다.
export async function sessionParent(nodeId: string, sessionId: string): Promise<string | null> {
  const r = await itemsPool.query(`SELECT parent_session_id FROM session WHERE node_id=$1 AND session_id=$2`, [nodeId, sessionId]);
  return (r.rows[0]?.parent_session_id as string | null) ?? null;
}

// 제목 유도(#905 C1 슬⑤b) — 트랜스크립트 JSONL 에서 **첫 사람 발화**를 뽑아 세션 제목으로(uuid 대신 읽을 수 있게).
//  주입/툴결과/메타 라인은 건너뛴다. 첫 append(offset 0)에서만 계산해 COALESCE 로 굳힌다(한 번 정해지면 불변).
const TITLE_INJECTED = /^\s*(<command-name|<local-command-|<command-message|<command-args|<bash-|<task-notification|<system-reminder|\[Request interrupted|Caveat:|This session is being continued)/;
export function firstUserPromptTitle(jsonl: string): string | null {
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let o: { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.type !== "user" || o.isMeta || o.isSidechain) continue;
    const c = o.message && o.message.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) text = c.filter((x): x is { type: string; text?: string } => !!x && (x as { type?: string }).type === "text").map((x) => x.text || "").join(" ");
    text = (text || "").replace(/\s+/g, " ").trim();
    if (!text || TITLE_INJECTED.test(text)) continue;
    return text.length > 120 ? text.slice(0, 120) + "…" : text;
  }
  return null;
}

// 델타 append — offset-CAS. 성공/멱등이면 ok=true, gap/overlap 이면 ok=false(+정정용 현재 bytes).
export async function appendSessionLog(input: {
  nodeId: string; sessionId: string; atOffset: number; data: Buffer; harness?: string | null; owner?: string | null; store?: "slim" | "raw"; parentSessionId?: string | null;
}): Promise<AppendResult> {
  const { nodeId, sessionId, atOffset, data } = input;
  const len = data.length;
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    // 불멸 세션 레코드 보장(있으면 last_seen 만 갱신). owner 는 **최초 1회만** 굳는다(COALESCE — 첫 append 한
    //  멤버가 소유자로 고정, 이후 append 가 못 덮는다). 프라이버시 게이트라 라우트의 owner-검사와 함께 이중방어.
    //  제목은 첫 append(offset 0)의 첫 사람 발화에서 유도해 COALESCE 로 굳힌다(uuid 대신 읽을 수 있는 제목, 한 번만).
    const titleCand = atOffset === 0 && len > 0 ? firstUserPromptTitle(data.toString("utf8")) : null;
    await client.query(
      `INSERT INTO session(node_id, session_id, harness, owner, title, parent_session_id) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, node_id, session_id) DO UPDATE SET last_seen=now(),
         harness=COALESCE(session.harness, EXCLUDED.harness),
         owner=COALESCE(session.owner, EXCLUDED.owner),
         title=COALESCE(session.title, EXCLUDED.title),
         parent_session_id=COALESCE(session.parent_session_id, EXCLUDED.parent_session_id)`,
      [nodeId, sessionId, input.harness ?? null, input.owner ?? null, titleCand, input.parentSessionId ?? null]);
    await client.query(
      `INSERT INTO session_log(node_id, session_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [nodeId, sessionId]);

    if (len === 0) {
      // 빈 델타 — 워터마크만 조회해 돌려준다(하트비트/오프셋 확인용). 아무것도 안 쓴다.
      const r = await client.query(`SELECT bytes FROM session_log WHERE node_id=$1 AND session_id=$2`, [nodeId, sessionId]);
      await client.query("COMMIT");
      const cur = Number(r.rows[0]?.bytes ?? 0);
      return { ok: atOffset <= cur, verdict: casVerdict(cur, atOffset, 0), bytes: cur };
    }

    // 🔑 offset-CAS — 정확히 이어질 때만 1행 갱신(원자적 직렬화, 락 불요).
    const upd = await client.query(
      `UPDATE session_log SET bytes = bytes + $3, updated_at = now()
        WHERE node_id=$1 AND session_id=$2 AND bytes = $4
        RETURNING bytes`,
      [nodeId, sessionId, len, atOffset]);

    if (upd.rowCount === 1) {
      // 무손실 압축 저장(#905 C1 슬②) — 저장은 압축본, 오프셋 회계는 원본(raw_len=len). CAS 는 원본 len 으로 이미 처리됨.
      const enc = encodeChunk(data, input.store ?? "slim");
      await client.query(
        `INSERT INTO session_log_chunk(node_id, session_id, at_offset, data, raw_len, codec) VALUES($1,$2,$3,$4,$5,$6)`,
        [nodeId, sessionId, atOffset, enc.data, len, enc.codec]);
      await client.query("COMMIT");
      return { ok: true, verdict: "append", bytes: Number(upd.rows[0].bytes) };
    }

    // CAS 빗나감 — 현재 워터마크로 사유 분류. duplicate 는 멱등 성공(재시작 재push 안전).
    const r = await client.query(`SELECT bytes FROM session_log WHERE node_id=$1 AND session_id=$2`, [nodeId, sessionId]);
    await client.query("COMMIT");
    const cur = Number(r.rows[0]?.bytes ?? 0);
    const verdict = casVerdict(cur, atOffset, len);
    return { ok: verdict === "duplicate", verdict, bytes: cur };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => { /* noop */ });
    throw e;
  } finally {
    client.release();
  }
}

// 재연결 오프셋 고지(설계 §5 ⑤) — 보낸 쪽이 "어디부터 보내야 하나"를 묻는다. 없으면 0.
export async function sessionLogWatermark(nodeId: string, sessionId: string): Promise<number> {
  const r = await itemsPool.query(`SELECT bytes FROM session_log WHERE node_id=$1 AND session_id=$2`, [nodeId, sessionId]);
  return Number(r.rows[0]?.bytes ?? 0);
}

// 회수(웹뷰·resume 슬라이스에서 사용) — from 바이트부터 이어붙여 반환. 청크가 at_offset 순서라 그대로 concat.
//  from 이 청크 경계 중간이면 그 청크의 해당 지점부터 자른다(경계 무관 요청 허용).
export async function readSessionLog(nodeId: string, sessionId: string, from = 0): Promise<{ from: number; bytes: number; data: Buffer }> {
  const total = await sessionLogWatermark(nodeId, sessionId);
  const start = Math.max(0, Math.min(from, total));
  // 오프셋 회계는 **원본 길이**(raw_len) 기준 — 압축본 octet_length 가 아니라. 구청크(raw_len NULL)는 원본=octet_length(data).
  const r = await itemsPool.query(
    `SELECT at_offset, data, codec, COALESCE(raw_len, octet_length(data)) AS raw_len FROM session_log_chunk
      WHERE node_id=$1 AND session_id=$2 AND at_offset + COALESCE(raw_len, octet_length(data)) > $3
      ORDER BY at_offset`,
    [nodeId, sessionId, start]);
  const parts: Buffer[] = [];
  for (const row of r.rows) {
    const chunkAt = Number(row.at_offset);
    const buf: Buffer = decodeChunk(row.data as Buffer, (row.codec as string | null) ?? null);   // 압축본이면 원본 복원
    const skip = start > chunkAt ? start - chunkAt : 0;   // 시작이 이 청크 중간이면 원본 기준 앞부분 잘라낸다
    parts.push(skip > 0 ? buf.subarray(skip) : buf);
  }
  return { from: start, bytes: total, data: Buffer.concat(parts) };
}

// 내 세션 목록(#905 C1 슬⑤b 웹뷰) — 소유자=요청자인 세션을 **모든 노드에서**(환경 무관 "내 세션들").
//  회수 표면의 목록면: 어느 환경에서 만들었든 내 세션을 한 곳에서 본다. reap 된 세션도 남(bytes=0, session 불멸).
export interface SessionListRow {
  node_id: string; session_id: string; harness: string | null; title: string | null;
  owner: string | null; owner_name: string | null; first_seen: string; last_seen: string; bytes: number;
  project_id?: number | null; project_name?: string | null;   // 최근 바인딩 프로젝트(내 세션 목록에서만 채움, #905 C1)
}
const SESSION_LIST_COLS = `s.node_id, s.session_id, s.harness, s.title, s.owner, m.display_name AS owner_name,
  s.first_seen, s.last_seen, COALESCE(l.bytes, 0)::bigint AS bytes`;
const mapSessionRow = (x: Record<string, unknown>): SessionListRow => ({
  node_id: x.node_id as string, session_id: x.session_id as string, harness: (x.harness as string) ?? null,
  title: (x.title as string) ?? null, owner: (x.owner as string) ?? null, owner_name: (x.owner_name as string) ?? null,
  first_seen: x.first_seen as string, last_seen: x.last_seen as string, bytes: Number(x.bytes),
  project_id: x.project_id != null ? Number(x.project_id) : null, project_name: (x.project_name as string) ?? null,
});

// 내 세션 목록(웹뷰) — 소유자=요청자. 제목·소유자표시명·생성·마지막활동·크기 포함.
export async function listSessionsForOwner(owner: string, limit = 200): Promise<SessionListRow[]> {
  if (!owner) return [];
  const r = await itemsPool.query(
    `SELECT ${SESSION_LIST_COLS}, proj.project_id, proj.project_name
       FROM session s
       JOIN session_log l ON l.node_id = s.node_id AND l.session_id = s.session_id
       LEFT JOIN org_member m ON m.id = s.owner
       LEFT JOIN LATERAL (
         SELECT sp.project_id, p.name AS project_name
           FROM session_project sp JOIN project p ON p.id = sp.project_id
          WHERE sp.session_id = s.session_id ORDER BY sp.valid_from DESC LIMIT 1
       ) proj ON true
      WHERE s.owner = $1 AND l.bytes > 0 AND s.parent_session_id IS NULL
      ORDER BY s.last_seen DESC
      LIMIT $2`,
    [owner, Math.min(Math.max(Number(limit) || 200, 1), 500)]);
  return r.rows.map(mapSessionRow);
}

// 프로젝트 세션 목록(#905 C1 슬⑤b) — 이 프로젝트에 **한 번이라도** 바인딩된 세션(시간구간 전체). 프로젝트 상세 탭용.
//  인가는 라우트에서(프로젝트 멤버). (node,session) 중복 제거 후 마지막활동 순.
export async function listSessionsForProject(projectId: number, limit = 200): Promise<SessionListRow[]> {
  if (!projectId) return [];
  const r = await itemsPool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (s.node_id, s.session_id) ${SESSION_LIST_COLS}
         FROM session s
         JOIN session_project sp ON sp.session_id = s.session_id AND sp.project_id = $1
         JOIN session_log l ON l.node_id = s.node_id AND l.session_id = s.session_id
         LEFT JOIN org_member m ON m.id = s.owner
        WHERE l.bytes > 0 AND s.parent_session_id IS NULL
        ORDER BY s.node_id, s.session_id
     ) t ORDER BY t.last_seen DESC LIMIT $2`,
    [projectId, Math.min(Math.max(Number(limit) || 200, 1), 500)]);
  return r.rows.map(mapSessionRow);
}

// 서브에이전트 목록(#905 C1 슬⑥) — 이 (부모)세션이 스폰한 서브에이전트 세션들. 대화록 아래 트리로 보여준다.
//  최상위 목록엔 안 나오고(부모의 parent_session_id IS NULL) 여기서만. 내용 있는(bytes>0) 것만, 시간순(오래된→최신).
export async function listSubagentsForSession(nodeId: string, parentSessionId: string, limit = 200): Promise<SessionListRow[]> {
  if (!parentSessionId) return [];
  const r = await itemsPool.query(
    `SELECT ${SESSION_LIST_COLS}
       FROM session s
       JOIN session_log l ON l.node_id = s.node_id AND l.session_id = s.session_id
       LEFT JOIN org_member m ON m.id = s.owner
      WHERE s.node_id = $1 AND s.parent_session_id = $2 AND l.bytes > 0
      ORDER BY s.first_seen ASC
      LIMIT $3`,
    [nodeId, parentSessionId, Math.min(Math.max(Number(limit) || 200, 1), 500)]);
  return r.rows.map(mapSessionRow);
}

// 기존 세션 제목 백필(#905 C1 슬⑤b) — title 컬럼 도입 전 캡처/백필된 세션은 title=null(목록에 uuid 로 보임).
//  제목은 append 시점에만 유도되므로, 이미 들어온 로그엔 소급이 필요하다. 첫 청크(at_offset=0)에서 제목을 뽑아 채운다.
//  멱등: title IS NULL 인 것만 손댄다(다 채우면 no-op). 첫 청크에 사람 발화 없으면 그대로 null(다음에 재시도).
export async function backfillSessionTitles(limit = 500): Promise<number> {
  const rows = await itemsPool.query(
    `SELECT s.node_id, s.session_id, c.data
       FROM session s
       JOIN session_log_chunk c ON c.node_id = s.node_id AND c.session_id = s.session_id AND c.at_offset = 0
      WHERE s.title IS NULL
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 500, 1), 5000)]);
  let n = 0;
  for (const r of rows.rows) {
    const title = firstUserPromptTitle((r.data as Buffer).toString("utf8"));
    if (!title) continue;
    await itemsPool.query(
      `UPDATE session SET title = $3 WHERE node_id = $1 AND session_id = $2 AND title IS NULL`,
      [r.node_id, r.session_id, title]);
    n++;
  }
  return n;
}

// 보존 reap(설계 §5 ③) — retentionDays 지나도록 **손대지 않은**(updated_at 기준) 로그를 통째로 지운다.
//  · **세션 단위**로 지운다(청크만 부분삭제 금지 — offset 연속성이 깨져 회수가 구멍남). updated_at 은 마지막 append.
//  · retentionDays<=0 → 무제한(아무것도 안 지움). session 레코드는 **불멸**(로그·청크만 삭제, '있었다'는 남는다).
//  · 단일 문장(modifying CTE)이라 원자적 — 지운 세션의 청크만 정확히 함께 삭제(활성 세션의 옛 청크는 안 건드림).
export async function reapSessionLogs(retentionDays: number): Promise<{ logs: number; chunks: number }> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return { logs: 0, chunks: 0 };
  const r = await itemsPool.query(
    `WITH reaped AS (
       DELETE FROM session_log WHERE updated_at < now() - ($1 * interval '1 day')
       RETURNING node_id, session_id
     ), delchunks AS (
       DELETE FROM session_log_chunk c USING reaped r
        WHERE c.node_id = r.node_id AND c.session_id = r.session_id
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM reaped)::int AS logs, (SELECT count(*) FROM delchunks)::int AS chunks`,
    [retentionDays]);
  return { logs: Number(r.rows[0]?.logs ?? 0), chunks: Number(r.rows[0]?.chunks ?? 0) };
}
