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
import { itemsPool } from "../items/store.js";

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

// 델타 append — offset-CAS. 성공/멱등이면 ok=true, gap/overlap 이면 ok=false(+정정용 현재 bytes).
export async function appendSessionLog(input: {
  nodeId: string; sessionId: string; atOffset: number; data: Buffer; harness?: string | null; owner?: string | null;
}): Promise<AppendResult> {
  const { nodeId, sessionId, atOffset, data } = input;
  const len = data.length;
  const client = await itemsPool.connect();
  try {
    await client.query("BEGIN");
    // 불멸 세션 레코드 보장(있으면 last_seen 만 갱신). owner 는 **최초 1회만** 굳는다(COALESCE — 첫 append 한
    //  멤버가 소유자로 고정, 이후 append 가 못 덮는다). 프라이버시 게이트라 라우트의 owner-검사와 함께 이중방어.
    await client.query(
      `INSERT INTO session(node_id, session_id, harness, owner) VALUES($1,$2,$3,$4)
       ON CONFLICT (node_id, session_id) DO UPDATE SET last_seen=now(),
         harness=COALESCE(session.harness, EXCLUDED.harness),
         owner=COALESCE(session.owner, EXCLUDED.owner)`,
      [nodeId, sessionId, input.harness ?? null, input.owner ?? null]);
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
      await client.query(
        `INSERT INTO session_log_chunk(node_id, session_id, at_offset, data) VALUES($1,$2,$3,$4)`,
        [nodeId, sessionId, atOffset, data]);
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
  const r = await itemsPool.query(
    `SELECT at_offset, data FROM session_log_chunk
      WHERE node_id=$1 AND session_id=$2 AND at_offset + octet_length(data) > $3
      ORDER BY at_offset`,
    [nodeId, sessionId, start]);
  const parts: Buffer[] = [];
  for (const row of r.rows) {
    const chunkAt = Number(row.at_offset);
    const buf: Buffer = row.data;
    const skip = start > chunkAt ? start - chunkAt : 0;   // 시작이 이 청크 중간이면 앞부분 잘라낸다
    parts.push(skip > 0 ? buf.subarray(skip) : buf);
  }
  return { from: start, bytes: total, data: Buffer.concat(parts) };
}

// 내 세션 목록(#905 C1 슬⑤b 웹뷰) — 소유자=요청자인 세션을 **모든 노드에서**(환경 무관 "내 세션들").
//  회수 표면의 목록면: 어느 환경에서 만들었든 내 세션을 한 곳에서 본다. reap 된 세션도 남(bytes=0, session 불멸).
export interface SessionListRow { node_id: string; session_id: string; harness: string | null; bytes: number; last_seen: string; }
export async function listSessionsForOwner(owner: string, limit = 200): Promise<SessionListRow[]> {
  if (!owner) return [];
  const r = await itemsPool.query(
    `SELECT s.node_id, s.session_id, s.harness, COALESCE(l.bytes, 0)::bigint AS bytes, s.last_seen
       FROM session s LEFT JOIN session_log l ON l.node_id = s.node_id AND l.session_id = s.session_id
      WHERE s.owner = $1
      ORDER BY s.last_seen DESC
      LIMIT $2`,
    [owner, Math.min(Math.max(Number(limit) || 200, 1), 500)]);
  return r.rows.map((x) => ({
    node_id: x.node_id, session_id: x.session_id, harness: x.harness,
    bytes: Number(x.bytes), last_seen: x.last_seen,
  }));
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
