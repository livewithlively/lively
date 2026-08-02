// #592 지식 댓글 데이터 접근 — task-detail-store 의 postComment/getTaskFeed/toggleCommentReaction 동형 이식.
//  차이 두 가지: ① 귀속 키가 task_id(INT)가 아니라 knowledge.name(TEXT), ② 시스템 이벤트(org_content_audit diff)
//  병합 없음 — 지식 문서 하단 댓글 섹션은 **댓글+이모지 반응만**(태스크 피드와 달리 편집 이력은 감사 탭 몫).
//  reply_to = 1단계 스레드(부모가 이 지식의 최상위 댓글일 때만 인정 — 과허용·중첩 평탄화, task_comment 와 동일 가드).
//  사람 식별자(author/member)=org_member.id 문자열(FK 없음 — 미러/외부 신원 허용, 태스크 댓글 관례).
import { itemsPool } from "../db/client.js";
import { q, one } from "../db/client.js";
import { type WriteCtx } from "./content-audit.js";

export interface KnowledgeCommentReaction { emoji: string; count: number; mine: boolean }
export interface KnowledgeFeedItem {
  kind: "comment"; id: number; ts: string; actor: string | null; reply_to: number | null;
  display_name: string | null; body: string; reactions: KnowledgeCommentReaction[];
}

// 댓글 작성 — 작성 후 갱신된 피드 반환(모달/섹션이 통째로 다시 그린다, postComment 동형).
export async function postKnowledgeComment(name: string, text: string, ctx?: WriteCtx, parentId?: number | null): Promise<KnowledgeFeedItem[]> {
  const body = text.trim();
  if (!body) throw new Error("댓글 내용이 비어 있습니다");
  // FK(knowledge.name)가 존재를 강제하지만, 위반 전에 클린 404('없음')로 끊는다.
  const exists = await one(itemsPool, `SELECT 1 AS x FROM knowledge WHERE name=$1`, [name]);
  if (!exists) throw new Error(`지식 '${name}' 없음`);
  // reply_to = 부모 댓글 id(1단계 스레드). null=최상위. 부모가 이 지식의 최상위 댓글일 때만 인정(과허용·중첩 평탄화).
  let parent: number | null = null;
  if (parentId) {
    const ok = await one(itemsPool, `SELECT 1 AS x FROM knowledge_comment WHERE id=$1 AND name=$2 AND reply_to IS NULL`, [parentId, name]);
    if (ok) parent = parentId;
  }
  await itemsPool.query(
    `INSERT INTO knowledge_comment(name, author, body, reply_to, created_at) VALUES($1, $2, $3, $4, now())`,
    [name, ctx?.actor ?? null, body, parent]);
  return getKnowledgeCommentFeed(name, ctx?.actor ?? null);
}

// 피드 = 댓글(knowledge_comment)만 시간순. display_name 은 org_member LEFT JOIN(외부 신원은 NULL → 프론트가 id 표기).
//  반응은 emoji별 count + 내(viewer) 반응 여부(mine) 집계 — getTaskFeed 의 댓글 부분과 동일 shape(kind:'comment').
export async function getKnowledgeCommentFeed(name: string, viewer?: string | null): Promise<KnowledgeFeedItem[]> {
  const comments = await q(itemsPool,
    `SELECT c.id, c.body, c.created_at, c.author AS actor, c.reply_to, m.display_name
     FROM knowledge_comment c LEFT JOIN org_member m ON m.id = c.author
     WHERE c.name=$1 ORDER BY c.created_at`, [name]);
  const cids = comments.map((c) => c.id);
  const reactRows = cids.length
    ? await q(itemsPool,
        `SELECT comment_id, emoji, COUNT(*)::int AS count, BOOL_OR(member = $2) AS mine
         FROM knowledge_comment_reaction WHERE comment_id = ANY($1)
         GROUP BY comment_id, emoji ORDER BY comment_id, MIN(created_at)`, [cids, viewer ?? ""])
    : [];
  const reactByComment = new Map<number, KnowledgeCommentReaction[]>();
  for (const r of reactRows) {
    const arr = reactByComment.get(r.comment_id) || [];
    arr.push({ emoji: r.emoji, count: r.count, mine: r.mine });
    reactByComment.set(r.comment_id, arr);
  }
  const feed: KnowledgeFeedItem[] = comments.map((c) => ({
    kind: "comment", id: c.id, ts: c.created_at, actor: c.actor, reply_to: c.reply_to ?? null,
    display_name: c.display_name, body: c.body, reactions: reactByComment.get(c.id) || [],
  }));
  return feed.slice(-300);
}

// 이 댓글이 달린 지식의 소환키(#1291) — 댓글 id 로만 들어오는 표면(반응 토글 등)이 **문서** 공개범위를
//  판정하려면 먼저 귀속 문서를 알아야 한다. 없는 댓글이면 undefined(호출부가 판정을 건너뛴다).
export async function knowledgeNameOfComment(commentId: number): Promise<string | undefined> {
  const rows = await q(itemsPool, `SELECT name FROM knowledge_comment WHERE id=$1`, [commentId]);
  return rows.length ? String(rows[0].name) : undefined;
}

// 댓글 반응 토글 — (comment_id, emoji, member) 있으면 제거, 없으면 추가. 갱신된 emoji별 집계 반환(toggleCommentReaction 동형).
export async function toggleKnowledgeCommentReaction(commentId: number, emoji: string, member: string): Promise<KnowledgeCommentReaction[]> {
  const e = String(emoji).slice(0, 16);
  const ex = await one(itemsPool, `SELECT 1 AS x FROM knowledge_comment_reaction WHERE comment_id=$1 AND emoji=$2 AND member=$3`, [commentId, e, member]);
  if (ex) await itemsPool.query(`DELETE FROM knowledge_comment_reaction WHERE comment_id=$1 AND emoji=$2 AND member=$3`, [commentId, e, member]);
  else await itemsPool.query(`INSERT INTO knowledge_comment_reaction(comment_id, emoji, member) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [commentId, e, member]);
  return q(itemsPool,
    `SELECT emoji, COUNT(*)::int AS count, BOOL_OR(member=$2) AS mine FROM knowledge_comment_reaction
     WHERE comment_id=$1 GROUP BY emoji ORDER BY MIN(created_at)`, [commentId, member]);
}
