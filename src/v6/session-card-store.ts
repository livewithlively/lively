// v6/session-card-store.ts — 세션 요약 카드를 만들어 두는 곳(#4530 검색 품질 «뜻으로 찾기», 원준 2026-10-05).
//
//  카드 = 세션마다 «무엇이었나» 를 모은 글(v6/session-card.ts). 대화 색인(session_msg)이 나아간 세션을 골라 카드를 다시 만들고,
//   글이 바뀌었으면 벡터를 비워 임베딩 대기(embedding_vector IS NULL)로 돌린다 — 채우는 것은 임베딩 백필(runAutoBackfillSweep)이다.
//  ⚠ 카드는 대화의 사본이다 — 지우기를 따라가야 한다. 완전 삭제(purgeSessionLog)·보존 정리(reap)가 함께 지운다(session-log-store).
//  ⚠ 카드 글은 화면으로 나가지 않는다(검색은 «어느 세션이 비슷한가» 만 돌려준다). 볼 수 있는가는 검색 쪽이 따로 잰다.
import { itemsPool } from "../db/client.js";
import { buildSessionCard, CARD_VER, type CardMsg } from "./session-card.js";
import { SESSION_CARD_TARGET, markEmbeddingPending, runAutoBackfillSweep } from "./embedding-backfill.js";
import { sessionNameFromPrompt } from "../terminal/session-name.js";
import { currentTenant } from "../org/tenant-context.js";

/** 한 번의 정비가 만드는 카드 수 · 쓰는 시간의 상한. */
export const CARD_SWEEP_MAX = 30;
export const CARD_SWEEP_MS = 6_000;
/** 돌고 있는 세션의 카드는 이 간격보다 자주 다시 만들지 않는다 — 말 한 마디마다 임베딩을 다시 하지 않게. */
export const CARD_REBUILD_MIN_MS = 10 * 60_000;
/** 카드에 읽어 들이는 사람 말의 상한(앞에서 · 뒤에서 각각) · 고친 파일 수 · 말 하나에서 읽는 글자. */
const CARD_SAID_HEAD = 400;
const CARD_SAID_TAIL = 400;
const CARD_FILES_MAX = 400;
const CARD_ROW_CHARS = 900;

/** 카드 한 줄의 열쇠 — 임베딩 백필이 쓰는 한 칸짜리 키. */
export const cardId = (nodeId: string, sessionId: string): string => nodeId + "|" + sessionId;

/**
 * 한 세션의 카드를 (다시) 만든다. built = 글이 바뀌어 임베딩 대기로 돌렸다 · same = 글이 그대로다 · empty = 사람이 한 말이 없다
 *  (빈 카드로 적어 둔다 — 정비가 같은 세션을 되풀이해 집지 않게) · gone = 세션이나 색인이 없다.
 */
export async function buildCardFor(nodeId: string, sessionId: string): Promise<"built" | "same" | "empty" | "gone"> {
  const meta = (await itemsPool.query(
    `SELECT s.title, c.indexed_to,
            (SELECT st.label FROM org_session_state st
              WHERE st.claude_session_id = s.session_id AND st.owner = s.owner
                AND st.label_source IN ('human','agent') AND st.label IS NOT NULL AND btrim(st.label) <> '' LIMIT 1) AS label,
            (SELECT p.name FROM session_project sp JOIN project p ON p.id = sp.project_id
              WHERE sp.session_id = s.session_id ORDER BY sp.valid_from DESC LIMIT 1) AS project,
            (SELECT k.card FROM session_card k WHERE k.node_id = s.node_id AND k.session_id = s.session_id) AS old_card
       FROM session s
       JOIN session_msg_cursor c ON c.node_id = s.node_id AND c.session_id = s.session_id
      WHERE s.node_id = $1 AND s.session_id = $2`, [nodeId, sessionId])).rows[0] as
    { title: string | null; indexed_to: string | number; label: string | null; project: string | null; old_card: string | null } | undefined;
  if (!meta) return "gone";
  //  사람 말은 **앞에서도 뒤에서도** 읽는다 — 카드는 «앞 절반 + 뒤 절반» 을 남기는데, 앞에서만 읽으면 긴 세션의 최근 말이 영영
  //   못 들어온다(세션이 자라도 카드가 굳는다). 고친 파일은 따로 읽는다 — 파일을 수백 번 고친 세션에서 사람 말의 자리를 먹지 않게(격리 리뷰).
  const said = await itemsPool.query(
    `SELECT role, body FROM (
       (SELECT 'user' AS role, left(body, ${CARD_ROW_CHARS}) AS body, at_offset, idx FROM session_msg
         WHERE node_id = $1 AND session_id = $2 AND role = 'user' ORDER BY at_offset, idx LIMIT ${CARD_SAID_HEAD})
       UNION
       (SELECT 'user' AS role, left(body, ${CARD_ROW_CHARS}) AS body, at_offset, idx FROM session_msg
         WHERE node_id = $1 AND session_id = $2 AND role = 'user' ORDER BY at_offset DESC, idx DESC LIMIT ${CARD_SAID_TAIL})
     ) u ORDER BY at_offset, idx`, [nodeId, sessionId]);
  const edited = await itemsPool.query(
    `SELECT body FROM (
       SELECT left(body, ${CARD_ROW_CHARS}) AS body, min(at_offset) AS first_at FROM session_msg
        WHERE node_id = $1 AND session_id = $2 AND role = 'edit' GROUP BY 1
     ) e ORDER BY first_at LIMIT ${CARD_FILES_MAX}`, [nodeId, sessionId]);
  const last = (await itemsPool.query(
    `SELECT left(body, ${CARD_ROW_CHARS}) AS body FROM session_msg
      WHERE node_id = $1 AND session_id = $2 AND role = 'assistant'
      ORDER BY at_offset DESC, idx DESC LIMIT 1`, [nodeId, sessionId])).rows[0] as { body: string } | undefined;
  const msgs: CardMsg[] = [
    ...said.rows.map((r): CardMsg => ({ role: "user", text: String(r.body ?? "") })),
    ...edited.rows.map((r): CardMsg => ({ role: "edit", text: String(r.body ?? "") })),
  ];
  const card = buildSessionCard({
    name: (meta.label && meta.label.trim()) || sessionNameFromPrompt(String(meta.title ?? "")) || null,
    project: meta.project, msgs, lastAnswer: last?.body ?? null,
  });
  const id = cardId(nodeId, sessionId);
  await itemsPool.query(
    `INSERT INTO session_card(node_id, session_id, card_id, card, src_bytes, ver)
     VALUES($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, node_id, session_id) DO UPDATE
       SET card = EXCLUDED.card, src_bytes = EXCLUDED.src_bytes, ver = EXCLUDED.ver, updated_at = now()`,
    [nodeId, sessionId, id, card, Number(meta.indexed_to) || 0, CARD_VER]);
  if (!card) return "empty";
  if (meta.old_card === card) return "same";
  //  글이 바뀌었다 — 옛 벡터는 옛 글의 것이다. 비워서 임베딩 대기로 돌린다(채우기는 정비가 끝난 뒤 한 번에 깨운다).
  await markEmbeddingPending(SESSION_CARD_TARGET, id, false);
  return "built";
}

const sweeping = new Set<string>();
/**
 * 카드가 없거나 묵은 세션을 최근 것부터 골라 만든다. 서브에이전트·작업 상자 세션은 검색에 안 나오므로 만들지 않는다(대화 색인과 같은 조건).
 *  묵었다 = 판이 다르다 · 또는 대화 색인이 카드를 만든 때보다 나아갔고 마지막으로 만든 지 CARD_REBUILD_MIN_MS 가 지났다.
 *  같은 워크스페이스의 정비가 겹치면 뒤 판은 그냥 돌아간다.
 */
export async function sweepSessionCards(opts: { max?: number; maxMs?: number } = {}): Promise<{ seen: number; built: number }> {
  const key = currentTenant()?.id ?? "-";
  if (sweeping.has(key)) return { seen: 0, built: 0 };
  sweeping.add(key);
  const deadline = Date.now() + (opts.maxMs ?? CARD_SWEEP_MS);
  let seen = 0, built = 0;
  try {
    const r = await itemsPool.query(
      `SELECT c.node_id, c.session_id
         FROM session_msg_cursor c
         JOIN session s ON s.node_id = c.node_id AND s.session_id = c.session_id
         LEFT JOIN session_card k ON k.node_id = c.node_id AND k.session_id = c.session_id
        WHERE c.indexed_to > 0
          AND s.parent_session_id IS NULL AND s.run_kind IS DISTINCT FROM 'task'
          AND (k.session_id IS NULL OR k.ver IS DISTINCT FROM $1
               OR (c.indexed_to > k.src_bytes AND k.updated_at < now() - ($2 || ' milliseconds')::interval))
        ORDER BY c.updated_at DESC
        LIMIT $3`, [CARD_VER, String(CARD_REBUILD_MIN_MS), Math.max(1, opts.max ?? CARD_SWEEP_MAX)]);
    for (const row of r.rows as Array<{ node_id: string; session_id: string }>) {
      if (Date.now() >= deadline) break;
      seen++;
      try { if ((await buildCardFor(String(row.node_id ?? ""), String(row.session_id))) === "built") built++; }
      catch (e) { console.warn(`[session-card] ${row.session_id} 카드 만들기 실패(비치명 — 다음 판이 다시 집는다):`, (e as Error)?.message ?? e); }
    }
  } finally {
    sweeping.delete(key);
  }
  //  새 글이 생겼으면 임베딩 채우기를 깨운다(기다리지 않는다 — 꺼져 있으면 그 함수가 곧바로 돌아간다).
  if (built) void runAutoBackfillSweep().catch(() => { /* 다음 주기가 채운다 */ });
  return { seen, built };
}
