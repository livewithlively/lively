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
import { itemsPool, withTx } from "../db/client.js";
import { sessionNameFromPrompt } from "../terminal/session-name.js";
import { SINGLE_TENANT_ID } from "../db/tenant-column.js";   // #1875 — 세션 목록 워크스페이스 필터의 primary 귀속값
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

// 이 기록을 남긴 하네스(캡처 훅이 보고, #1746) — 읽을 때 어느 어댑터 파서로 공통 ChatLine 을 만들지 정한다. 미보고(구 행)면 null.
export async function sessionHarness(nodeId: string, sessionId: string): Promise<string | null> {
  const r = await itemsPool.query(`SELECT harness FROM session WHERE node_id=$1 AND session_id=$2`, [nodeId, sessionId]);
  return (r.rows[0]?.harness as string | null) ?? null;
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
/** 트랜스크립트 줄에서 읽어 낼 수 있는 '마지막 활동 시각'. 못 읽으면 null → 호출부가 now() 로 폴백한다.
 *
 *  왜 있나 (#2050): `session.last_seen` 은 종전에 **미러가 받은 시각**(`now()`)이었다. 목록이
 *   `ORDER BY last_seen DESC` 라, 몇 달 전 대화가 훅을 통해 **처음** 올라오는 순간 맨 위에 새것처럼 섰다.
 *   그게 세션 창이 저절로 남의 세션으로 넘어가던 사고의 방아쇠였다(화면 폴백이 '맨 위'를 골랐다).
 *
 *  ⚠ **미래는 믿지 않는다.** 보고하는 기계의 시계가 앞서 있으면 그 세션이 목록 맨 위에 영구히 박힌다.
 *   통상 시계 오차(SKEW)는 그대로 두고 그 밖은 null 로 떨어뜨린다 — 틀린 미래보다 '모르겠다'가 낫다.
 *  ⚠ **과거는 그대로 쓴다.** 오래된 대화를 제자리에 세우는 것이 이 함수의 목적이다.
 */
const ACTIVITY_SKEW_MS = 5 * 60_000;   // 통상 시계 오차 — 경계 포함(정확히 5분은 허용)
const ACTIVITY_TAIL_LINES = 400;       // 꼬리만 훑는다(큰 델타를 전수 파싱하지 않게)
export function lastActivityAt(jsonl: string, nowMs: number = Date.now()): Date | null {
  if (!jsonl) return null;
  const lines = jsonl.split("\n");
  const stop = Math.max(0, lines.length - ACTIVITY_TAIL_LINES);
  for (let i = lines.length - 1; i >= stop; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let o: { timestamp?: unknown };
    try { o = JSON.parse(line); } catch { continue; }
    const ts = o && typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (!Number.isFinite(ts)) continue;
    if (ts > nowMs + ACTIVITY_SKEW_MS) return null;   // 시계가 앞선 보고 — 지어내지 않고 폴백에 맡긴다
    return new Date(ts);
  }
  return null;
}

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
    const text = len > 0 ? data.toString("utf8") : "";
    const titleCand = atOffset === 0 && len > 0 ? firstUserPromptTitle(text) : null;
    // 이 델타가 말하는 마지막 활동 시각(#2050) — 못 읽으면 null 이고 SQL 이 now() 로 받는다.
    const activityAt = len > 0 ? lastActivityAt(text) : null;
    await client.query(
      `INSERT INTO session(node_id, session_id, harness, owner, title, parent_session_id, first_seen, last_seen)
       VALUES($1,$2,$3,$4,$5,$6, COALESCE($7::timestamptz, now()), COALESCE($7::timestamptz, now()))
       ON CONFLICT (tenant_id, node_id, session_id) DO UPDATE SET
         -- 대화가 **마지막으로 움직인** 시각. 못 읽으면 종전대로 수신 시각(now()).
         --  GREATEST: 같은 델타가 재전송돼도(멱등) 값이 과거로 되돌지 않는다.
         last_seen=GREATEST(session.last_seen, COALESCE($7::timestamptz, now())),
         harness=COALESCE(session.harness, EXCLUDED.harness),
         owner=COALESCE(session.owner, EXCLUDED.owner),
         title=COALESCE(session.title, EXCLUDED.title),
         parent_session_id=COALESCE(session.parent_session_id, EXCLUDED.parent_session_id)`,
      [nodeId, sessionId, input.harness ?? null, input.owner ?? null, titleCand, input.parentSessionId ?? null,
       activityAt ? activityAt.toISOString() : null]);
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
//  to(선택, #1719) — [from, to) 창만. 긴 기록(수십 MB)을 화면이 꼬리부터 창으로 읽을 때 쓴다. 없으면 종전대로 끝까지.
export async function readSessionLog(nodeId: string, sessionId: string, from = 0, to?: number): Promise<{ from: number; bytes: number; data: Buffer }> {
  const total = await sessionLogWatermark(nodeId, sessionId);
  const start = Math.max(0, Math.min(from, total));
  const end = to !== undefined && Number.isFinite(to) ? Math.max(start, Math.min(to, total)) : total;
  // 오프셋 회계는 **원본 길이**(raw_len) 기준 — 압축본 octet_length 가 아니라. 구청크(raw_len NULL)는 원본=octet_length(data).
  const r = await itemsPool.query(
    `SELECT at_offset, data, codec, COALESCE(raw_len, octet_length(data)) AS raw_len FROM session_log_chunk
      WHERE node_id=$1 AND session_id=$2 AND at_offset + COALESCE(raw_len, octet_length(data)) > $3 AND at_offset < $4
      ORDER BY at_offset`,
    [nodeId, sessionId, start, end]);
  const parts: Buffer[] = [];
  for (const row of r.rows) {
    const chunkAt = Number(row.at_offset);
    let buf: Buffer = decodeChunk(row.data as Buffer, (row.codec as string | null) ?? null);   // 압축본이면 원본 복원
    if (chunkAt + buf.length > end) buf = buf.subarray(0, end - chunkAt);   // 끝이 이 청크 중간이면 뒷부분 잘라낸다
    const skip = start > chunkAt ? start - chunkAt : 0;   // 시작이 이 청크 중간이면 원본 기준 앞부분 잘라낸다
    parts.push(skip > 0 ? buf.subarray(skip) : buf);
  }
  return { from: start, bytes: total, data: Buffer.concat(parts) };
}

// 내 세션 목록(#905 C1 슬⑤b 웹뷰) — 소유자=요청자인 세션을 **모든 노드에서**(환경 무관 "내 세션들").
//  회수 표면의 목록면: 어느 환경에서 만들었든 내 세션을 한 곳에서 본다. reap 된 세션도 남(bytes=0, session 불멸).
export interface SessionListRow {
  node_id: string; session_id: string; harness: string | null; title: string | null;
  //  ★ title 과 name 은 다르다(#2234). title 은 **대화 제목**(첫 사람 발화 120자, firstUserPromptTitle) —
  //   이력 화면에서 "그 대화가 무엇이었나"를 읽으라고 길게 남긴 값이다. name 은 **목록에 걸 이름**으로,
  //   세션 이름을 짓는 그 규칙(terminal/session-name.ts)을 통과시킨 값이다. 둘을 한 값으로 쓰면
  //   목록이 첫 지시 원문을 이름 자리에 건다 — 실측 2026-08-27(jang): 좌측 사이드바에
  //   「업데이트 준비가 완료되었습니다. 새 버전 0.1.358 다시 시작하여 반영하기 이거 사이드바 아래에서 …」(121자).
  name: string | null;
  owner: string | null; owner_name: string | null; first_seen: string; last_seen: string; bytes: number;
  project_id?: number | null; project_name?: string | null;   // 최근 바인딩 프로젝트(내 세션 목록에서만 채움, #905 C1)
}
const SESSION_LIST_COLS = `s.node_id, s.session_id, s.harness, s.title, s.owner, m.display_name AS owner_name,
  s.first_seen, s.last_seen, COALESCE(l.bytes, 0)::bigint AS bytes`;
const mapSessionRow = (x: Record<string, unknown>): SessionListRow => ({
  node_id: x.node_id as string, session_id: x.session_id as string, harness: (x.harness as string) ?? null,
  title: (x.title as string) ?? null,
  //  이름은 **짓는 규칙 한 곳**을 그대로 탄다 — 살아 있는 박스가 자동 이름을 받는 그 규칙이다(#1808 · #2116).
  //   그래야 박스가 죽어 기록만 남아도 같은 세션이 같은 이름으로 서 있다(종전엔 죽는 순간 121자로 늘어났다).
  name: sessionNameFromPrompt(String(x.title ?? "")) || null,
  owner: (x.owner as string) ?? null, owner_name: (x.owner_name as string) ?? null,
  first_seen: x.first_seen as string, last_seen: x.last_seen as string, bytes: Number(x.bytes),
  project_id: x.project_id != null ? Number(x.project_id) : null, project_name: (x.project_name as string) ?? null,
});

// 내 세션 목록(웹뷰) — 소유자=요청자. 제목·소유자표시명·생성·마지막활동·크기 포함.
/** 이 목록의 상한(#2022 후속) — 종전 500 은 **말없이** 잘렸다. 실측 2026-08-26: 200행이 한 사람의
 *  7.7일치밖에 못 덮어(하루 ~26세션) 그보다 오래된 지난 세션이 트리에서 통째로 사라졌다. 상한을 올리되
 *  **잘렸다는 사실을 호출자에게 알린다**(listSessionsForOwnerPage) — 조용한 절단이 이 버그의 정체였다. */
export const SESSION_LIST_MAX = 2000;

/** 요청한 깊이를 상한 안으로 — **한 곳에서만** 정한다(종전엔 스토어 쿼리와 라우트가 각자 200/500 을 들고 있었다). */
export const clampSessionListLimit = (v: unknown): number => Math.min(Math.max(Number(v) || 200, 1), SESSION_LIST_MAX);

/** 목록 + **잘렸는지**. 화면이 '이게 전부'라고 오해하지 않게 truncated 를 함께 준다. */
export async function listSessionsForOwnerPage(owner: string, limit = 200, workspaceId?: string | null): Promise<{ rows: SessionListRow[]; truncated: boolean }> {
  const want = clampSessionListLimit(limit);
  const rows = await listSessionsForOwner(owner, want, workspaceId);
  //  요청한 만큼 꽉 찼다 = 그 뒤가 더 있을 수 있다. '정확히 want 개'인 경우도 truncated 로 본다(보수적 — 없다고 단정하지 않는다).
  return { rows, truncated: rows.length >= want };
}

/**
 * 내 세션 목록. `workspaceId` 를 주면 **그 워크스페이스에 속한 세션만**(#1875 격리): gw_session_map 부재/보관됨 =
 *  primary(SINGLE_TENANT_ID). 안 주면 종전대로 owner 전체(내부 소비자·대시보드 등 — 워크스페이스 관심 없는 경로).
 *  ⚠ 필터를 SQL 에 두는 이유: LIMIT 뒤에 JS 로 거르면 want 를 채우고도 잘려 나가 truncated 판정이 거짓이 된다.
 *  owner(org_member)는 워크스페이스를 넘나드는 전역 신원이라(IDENTITY_GLOBAL_TABLES) owner 만으로는 개인
 *  워크스페이스에 박스 전체 세션 제목이 샌다 — 실측(#1875, 2026-08-27 장원준 신고: 개인 ws 사이드바에 팀 세션 제목).
 */
export async function listSessionsForOwner(owner: string, limit = 200, workspaceId?: string | null): Promise<SessionListRow[]> {
  if (!owner) return [];
  const params: unknown[] = [owner, clampSessionListLimit(limit)];
  let wsClause = "";
  if (workspaceId) {
    params.push(workspaceId, SINGLE_TENANT_ID);   // $3 = 현재 워크스페이스, $4 = primary(맵 부재 시 귀속)
    wsClause = `AND COALESCE(
        (SELECT m.workspace_id::text FROM gw_session_map m
           JOIN gw_workspace w ON w.id = m.workspace_id AND w.state = 'active'
          WHERE m.session_id = s.session_id),
        $4) = $3`;
  }
  const r = await itemsPool.query(
    `SELECT ${SESSION_LIST_COLS}, proj.project_id, proj.project_name
       FROM session s
       JOIN session_log l ON l.node_id = s.node_id AND l.session_id = s.session_id
       LEFT JOIN org_member m ON m.id = s.owner
       LEFT JOIN LATERAL (
         -- 마지막 구간이 해제(project_id NULL)면 프로젝트 없음으로 본다(#1867) — 마지막 non-null 을 현재로 연장하지 않는다.
         SELECT p.id AS project_id, p.name AS project_name
           FROM (SELECT sp.project_id FROM session_project sp
                  WHERE sp.session_id = s.session_id ORDER BY sp.valid_from DESC LIMIT 1) last
           JOIN project p ON p.id = last.project_id
       ) proj ON true
      WHERE s.owner = $1 AND l.bytes > 0 AND s.parent_session_id IS NULL ${wsClause}
      ORDER BY s.last_seen DESC
      LIMIT $2`,
    params);
  return r.rows.map(mapSessionRow);
}

// 프로젝트 세션 목록(#905 C1 슬⑤b) — 이 프로젝트에 **한 번이라도** 바인딩된 세션(시간구간 전체). 프로젝트 상세 탭용.
//  인가는 라우트에서(프로젝트 멤버). (node,session) 중복 제거 후 마지막활동 순.
/**
 * 이 프로젝트에 바인딩된 중앙 기록 세션 — **내가 볼 수 있는 것만**(#1876 S2).
 *
 * ⚠ 종전엔 «프로젝트 멤버면 그 프로젝트의 세션 기록 목록 전부» 였다. 라우트 게이트(isProjectMember)를
 *  통과한 사람에게 남의 세션 제목·시각이 통째로 나갔다 — 세션이 프라이빗이면 그 **존재와 제목**도
 *  프라이빗이어야 한다(D1). 그래서 술어를 목록·입장과 같은 축(소유자 + 명시 초대)으로 좁힌다.
 *
 * 초대는 박스 세션 축(`org_session_state.invites`)에 있고 이 표의 키는 대화 uuid 라, `org_session_conv`
 *  로 잇는다(양쪽 키 모두 대조 — 노드 세션·구 경로는 대화 uuid 가 곧 박스 id 인 경우가 있다).
 */
export async function listSessionsForProject(projectId: number, viewer: string, limit = 200): Promise<SessionListRow[]> {
  if (!projectId || !viewer) return [];
  const r = await itemsPool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (s.node_id, s.session_id) ${SESSION_LIST_COLS}
         FROM session s
         JOIN session_project sp ON sp.session_id = s.session_id AND sp.project_id = $1
         JOIN session_log l ON l.node_id = s.node_id AND l.session_id = s.session_id
         LEFT JOIN org_member m ON m.id = s.owner
        WHERE l.bytes > 0 AND s.parent_session_id IS NULL
          AND (s.owner = $3 OR EXISTS(
                SELECT 1 FROM org_session_state st
                 WHERE (st.id = s.session_id
                        OR st.id IN (SELECT box_id FROM org_session_conv WHERE conv_uuid = s.session_id))
                   AND st.invites @> to_jsonb(ARRAY[$3::text])))
        ORDER BY s.node_id, s.session_id
     ) t ORDER BY t.last_seen DESC LIMIT $2`,
    [projectId, Math.min(Math.max(Number(limit) || 200, 1), 500), viewer]);
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

// 개인 세션 기록 **완전 삭제**(#1850) — 소유자가 자기 세션 대화 전문을 중앙에서 남김없이 지운다.
//  ⚠ 보존 reap(위)과 목적이 다르다. reap 은 로그·청크만 지우고 `session` 레지스트리를 **불멸**로 남긴다
//   (그 세션이 '있었다'는 증언). 여기선 그 증언까지 지운다 — 근거 둘:
//    ① `session.title` 은 **첫 사람 발화에서 유도**한 값이다(firstUserPromptTitle). 개인정보를 지우겠다는
//       사람에게 "내용은 지웠지만 당신이 처음 뭐라고 말했는지는 목록에 남아 있다"는 삭제가 아니다.
//    ② 목록에 행이 남으면 사람은 안 지워졌다고 읽는다. '지웠다'가 화면에서 참이 되어야 한다(#1582 규약).
//  · 서브에이전트(parent_session_id=이 세션)의 대화록도 함께 지운다 — 같은 대화의 다른 절반이고,
//    부모만 지우면 그 내용이 고아로 남아 조회 표면에서 계속 읽힌다.
//  · session_project(프로젝트 귀속)도 함께 — 세션 행이 사라지면 남을 근거가 없다.
//  · **단일 트랜잭션** — 부분 삭제(내용은 지워졌는데 목록엔 남는 등)를 만들지 않는다. 실패하면 전부 롤백되고
//    호출자는 '안 지워졌다'를 사실대로 말할 수 있다.
export async function purgeSessionLog(nodeId: string, sessionId: string, purgedBy = ""): Promise<{ sessions: number; chunks: number; bytes: number; subagents: number }> {
  return withTx(async (client) => {
    // 지울 세션 = 이 세션 + 그 서브에이전트들(같은 노드). 한 번에 잡아 두고 그 목록으로만 지운다 —
    //  삭제 도중 새 서브에이전트가 끼어들어도 이 트랜잭션의 대상은 고정이다(재실행하면 그건 다음에 지워진다).
    const subs = await client.query(
      `SELECT session_id FROM session WHERE node_id=$1 AND parent_session_id=$2`, [nodeId, sessionId]);
    const ids = [sessionId, ...subs.rows.map((r) => String(r.session_id))];
    // 지운 양(사람에게 "얼마가 사라졌다"를 사실대로 말하기 위해) — 삭제 전에 잰다.
    const sz = await client.query(
      `SELECT COALESCE(SUM(bytes), 0)::bigint AS bytes FROM session_log WHERE node_id=$1 AND session_id = ANY($2)`,
      [nodeId, ids]);
    const chunks = await client.query(
      `DELETE FROM session_log_chunk WHERE node_id=$1 AND session_id = ANY($2)`, [nodeId, ids]);
    await client.query(`DELETE FROM session_log WHERE node_id=$1 AND session_id = ANY($2)`, [nodeId, ids]);
    const sessions = await client.query(`DELETE FROM session WHERE node_id=$1 AND session_id = ANY($2)`, [nodeId, ids]);
    // session_project 는 (node 축이 없는) session_id 키다 — 같은 id 가 두 노드에 있으면 남은 쪽의 귀속까지
    //  지워질 수 있어, **다른 노드에 같은 session_id 가 남아 있지 않을 때만** 지운다.
    await client.query(
      `DELETE FROM session_project sp
        WHERE sp.session_id = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM session s WHERE s.session_id = sp.session_id)`, [ids]);
    // #2233 — 대화 사슬(어느 박스가 이 대화를 돌렸나)도 함께 지운다. 남겨 두면 완전 삭제한 대화가 다른 세션
    //  화면의 사슬에 이름으로 남는다(내용은 이미 없지만, '있었다'는 사실 자체가 지우기로 한 것이다).
    await client.query(`DELETE FROM org_session_conv WHERE conv_uuid = ANY($1)`, [ids]);
    // 묘비 — 이 좌표는 다시 받지 않는다. 없으면 워터마크가 0으로 돌아간 자리에 캡처 훅이 전문을 다시 올려
    //  지운 것이 부활한다(세션이 아직 살아 있을 때 특히). 서브에이전트 좌표도 각각 세운다(각자 append 대상이다).
    for (const id of ids) {
      // ⚠ ON CONFLICT 에 **제약 컬럼을 적지 않는다**. 이 배포의 PK 는 스키마 정의 그대로가 아니다 —
      //  멀티테넌시가 켜진 배포에선 부팅 마이그레이션(db/tenant-column.ts)이 모든 표에 tenant_id 를 붙이고
      //  PK 를 (tenant_id, …) 로 재작성한다. 컬럼을 적으면 그 배포에서 "매칭되는 제약이 없다"로 터지고
      //  (실측: 이 자리에서 500), 반대로 tenant_id 를 적으면 테넌시가 꺼진 배포에서 터진다.
      //  묘비는 **있기만 하면 되는** 표라 DO NOTHING 이면 충분하다 — 첫 삭제 시각을 덮을 이유도 없다.
      await client.query(
        `INSERT INTO session_purged(node_id, session_id, purged_by) VALUES($1,$2,$3)
           ON CONFLICT DO NOTHING`,
        [nodeId, id, purgedBy || null]);
    }
    return {
      sessions: sessions.rowCount ?? 0,
      chunks: chunks.rowCount ?? 0,
      bytes: Number(sz.rows[0]?.bytes ?? 0),
      subagents: subs.rows.length,
    };
  });
}

// 이 좌표가 완전 삭제된 적 있나(#1850) — append·watermark 게이트가 재수집을 거부하는 근거.
//  ⚠ 조회는 (node, session) 정확일치. 묘비는 되살리지 않는다(복원 경로 없음 — 그게 '완전 삭제'의 뜻이다).
export async function isSessionPurged(nodeId: string, sessionId: string): Promise<boolean> {
  const r = await itemsPool.query(
    `SELECT 1 FROM session_purged WHERE node_id=$1 AND session_id=$2`, [nodeId, sessionId]);
  return r.rows.length > 0;
}
