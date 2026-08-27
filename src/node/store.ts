// 분산 노드(#869) — org_node CRUD + 노드 채널 인증.
// 노드 토큰 설계: mintToken(scopes: []) 로 발급한 멤버 귀속 토큰 — 유효 scope 가 공집합이라
//  REST/MCP 어떤 표면에도 안 통한다(최소권한). 노드 채널(/node/ws)만 이 스토어의 authNodeToken 으로
//  org_node.token_hash 직접 매칭 + 토큰 미회수 + 소유 멤버 active 를 모두 요구한다(F7 blast radius).
import crypto from "node:crypto";
import { itemsPool } from "../db/client.js";
import { mintToken, revokeToken } from "../org/store/tokens.js";
import { getMember } from "../org/store/members.js";   // #2165 — 배럴(org/store.js) 대신 좁은 모듈: 배럴을 타면 커넥터·수집기·토큰소스가 통째로 노드 번들에 실린다
import { HttpError } from "../http-error.js";
import type { KeepAwakeStatus } from "./keep-awake.js";
import { LINK_LOG_KEEP } from "../org/schema/node-link-log.js";   // #1849 — 노드당 보관 이벤트 상한(단일 출처)
import { WINDOW_MS, type LinkEvent } from "./sleep-pattern.js";   // #1849 — 진단 창(같은 값으로 읽는다)

const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

export interface OrgNode {
  id: string; name: string; kind: "member" | "worker"; owner_member: string;
  // shared(#1540) = 관리자가 '공유 노드'로 지정했나 = 전체 구성원 개방. 판정은 node-access.ts 단일 술어.
  //  kind 와 직교다 — kind 는 git 자격 정책(resolveRepoInject)·슬롯 용량에만 쓴다.
  token_hash: string | null; enabled: boolean; shared: boolean;
  platform: string | null; agent_ver: string | null; agent_caps: string[] | null; agent_harnesses: string[] | null; host: string | null;
  // #1849 — 노드가 hello 로 보고한 잠자기 억제 상태. NULL = **모름**(구 번들)이지 '안 걸림'이 아니다.
  keep_awake: KeepAwakeStatus | null;
  last_seen: string | null; created_by: string | null; created_at: string; updated_at: string;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
export function normalizeNodeId(raw: string): string {
  const id = (raw || "").toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!ID_RE.test(id)) throw new HttpError(400, "노드 id 형식이 잘못되었습니다(소문자·숫자·하이픈 2~41자)");
  return id;
}

export async function listNodes(): Promise<OrgNode[]> {
  const r = await itemsPool.query(`SELECT * FROM org_node ORDER BY created_at`);
  return r.rows as OrgNode[];
}

export async function getNode(id: string): Promise<OrgNode | undefined> {
  const r = await itemsPool.query(`SELECT * FROM org_node WHERE id=$1`, [id]);
  return r.rows[0] as OrgNode | undefined;
}

// 노드 생성 + 전용 토큰 발급(평문 토큰은 이 응답 1회만). 이미 있으면 409 — 토큰 재발급은 rotateNodeToken.
export async function createNode(input: { id: string; name?: string; kind?: string; owner: string; shared?: boolean }, actor?: string): Promise<{ node: OrgNode; token: string }> {
  const id = normalizeNodeId(input.id);
  const kind = input.kind === "worker" ? "worker" : "member";
  if (!(await getMember(input.owner))) throw new HttpError(400, `존재하지 않는 구성원입니다: ${input.owner}`);
  if (await getNode(id)) throw new HttpError(409, `이미 존재하는 노드입니다: ${id}`);
  const { token, tokenHash } = await mintToken(
    { userId: input.owner, memberId: input.owner, scopes: [], label: `node:${id}` },
    actor ?? input.owner, "node-store",
  );
  const r = await itemsPool.query(
    `INSERT INTO org_node(id, name, kind, owner_member, token_hash, created_by, shared)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    // shared 는 **명시할 때만** 켜진다(#1540) — 기본은 등록한 사람 것. 호출부(REST)가 admin 게이트를 건다.
    [id, input.name || id, kind, input.owner, tokenHash, actor ?? null, !!input.shared],
  );
  return { node: r.rows[0] as OrgNode, token };
}

// 토큰 재발급(회전) — 구 토큰 revoke 후 새 토큰으로 교체. 노드 에이전트 재설치/유출 대응.
export async function rotateNodeToken(id: string, actor?: string): Promise<{ node: OrgNode; token: string }> {
  const node = await getNode(id);
  if (!node) throw new HttpError(404, `노드 없음: ${id}`);
  if (node.token_hash) await revokeToken(node.token_hash, actor, "node-store").catch(() => { /* 이미 회수됐어도 계속 */ });
  const { token, tokenHash } = await mintToken(
    { userId: node.owner_member, memberId: node.owner_member, scopes: [], label: `node:${id}` },
    actor ?? node.owner_member, "node-store",
  );
  const r = await itemsPool.query(`UPDATE org_node SET token_hash=$2, updated_at=now() WHERE id=$1 RETURNING *`, [id, tokenHash]);
  return { node: r.rows[0] as OrgNode, token };
}

export async function setNodeEnabled(id: string, enabled: boolean): Promise<void> {
  await itemsPool.query(`UPDATE org_node SET enabled=$2, updated_at=now() WHERE id=$1`, [id, enabled]);
}

// 공유 노드 지정/해제(#1540) — **관리자 전용**(게이트는 호출부 REST). 이 한 컬럼이 '전체 개방'의 유일한 근거다.
//  해제는 즉시 유효하다: 위탁 후보 판정도, 접근 게이트도 매 요청 DB 행을 다시 읽는다(연결 시 스냅샷 캐시를 안 본다).
//  이미 그 노드에서 돌고 있는 남의 위탁 태스크는 죽이지 않는다 — 새 배치만 막는다(진행 중 작업을 정책 변경으로
//  중단시키면 결과를 잃는다). 즉시 끊어야 하면 enabled=false(연결 차단) 또는 태스크 취소를 쓴다.
export async function setNodeShared(id: string, shared: boolean): Promise<void> {
  await itemsPool.query(`UPDATE org_node SET shared=$2, updated_at=now() WHERE id=$1`, [id, shared]);
}

export async function deleteNode(id: string, actor?: string): Promise<{ deleted: boolean }> {
  const node = await getNode(id);
  if (!node) return { deleted: false };
  if (node.token_hash) await revokeToken(node.token_hash, actor, "node-store").catch(() => { /* best-effort */ });
  // 세션 스냅샷 정본(#1834)도 함께 — FK CASCADE 를 안 걸었으므로(org/schema/node-state.ts 주석) 여기서 지운다.
  //  남아도 읽는 쪽 JOIN 이 걸러 보이지는 않지만, 지워진 노드의 세션 목록을 DB 에 남겨 둘 이유가 없다.
  await itemsPool.query(`DELETE FROM org_node_state WHERE node_id=$1`, [id]).catch(() => { /* best-effort */ });
  // 연결 이력(#1849)도 함께 — 같은 이유(FK 를 안 걸었다). 지워진 노드의 이력을 남길 이유가 없다.
  await itemsPool.query(`DELETE FROM org_node_link_log WHERE node_id=$1`, [id]).catch(() => { /* best-effort */ });
  const r = await itemsPool.query(`DELETE FROM org_node WHERE id=$1`, [id]);
  return { deleted: (r.rowCount ?? 0) > 0 };
}

// hello 시 관측 필드 갱신 + 생존 확인 주기 갱신.
export async function touchNode(
  id: string,
  obs?: { platform?: string; agentVer?: string; host?: string; caps?: string[]; harnesses?: string[]; keepAwake?: KeepAwakeStatus },
): Promise<void> {
  // COALESCE — 관측값이 없으면(state push 로 부른 경우) 기존 값을 지우지 않는다.
  //  ⚠ agent_ver 가 라이브에서 **영원히 NULL** 이던 원인이 여기가 아니라 **hello 가 안 보낸 것**이었다(#905 C4).
  //   COALESCE 는 정상이었고, 넘어오는 값이 늘 undefined 였다.
  await itemsPool.query(
    `UPDATE org_node SET last_seen=now(), updated_at=now(),
        platform=COALESCE($2, platform), agent_ver=COALESCE($3, agent_ver), host=COALESCE($4, host),
        agent_caps=COALESCE($5, agent_caps), agent_harnesses=COALESCE($6, agent_harnesses),
        keep_awake=COALESCE($7::jsonb, keep_awake)
      WHERE id=$1`,
    [id, obs?.platform ?? null, obs?.agentVer ?? null, obs?.host ?? null, obs?.caps ?? null, obs?.harnesses ?? null,
      obs?.keepAwake ? JSON.stringify(obs.keepAwake) : null],
  );
}

// 노드 채널 인증 — 평문 토큰으로 org_node 를 특정한다. 어느 하나라도 어긋나면 null(연결 거부):
//  토큰 해시 매칭 · auth_token 미회수 · 노드 enabled · 소유 멤버 active.
export async function authNodeToken(token: string): Promise<OrgNode | null> {
  if (!token || !token.startsWith("lvk_") || !process.env.ITEMS_DATABASE_URL) return null;
  try {
    const r = await itemsPool.query(
      `SELECT n.* FROM org_node n
         JOIN auth_token t ON t.token_hash = n.token_hash
         JOIN org_member m ON m.id = n.owner_member
        WHERE n.token_hash = $1 AND t.revoked_at IS NULL AND n.enabled AND m.state = 'active'`,
      [sha256(token)],
    );
    return (r.rows[0] as OrgNode | undefined) ?? null;
  } catch { return null; } // DB 불가 = fail-closed(연결 거부)
}

// ── 노드 연결 이력(#1849) ───────────────────────────────────────────────────────
// "이 노드가 왜 자꾸 끊기나"는 한 시점의 상태로는 답할 수 없다 — 이력의 모양이 곧 원인이다(sleep-pattern.ts).
//  종전엔 이 정보가 게이트웨이 **로그 파일에만** 있어서, 사람이 ssh 로 grep 해야 보였다.

/** 연결/해제 1건 기록 + 노드당 상한 유지. 실패는 비치명 — 이력 때문에 연결 경로가 죽으면 안 된다. */
export async function appendNodeLinkEvent(nodeId: string, ev: "up" | "down"): Promise<void> {
  await itemsPool.query(`INSERT INTO org_node_link_log(node_id, ev) VALUES($1,$2)`, [nodeId, ev]);
  // 상한 넘은 옛 행 정리 — 삽입할 때마다 그 노드 것만 본다(전역 스캔·별도 크론 불요).
  await itemsPool.query(
    `DELETE FROM org_node_link_log
      WHERE node_id=$1
        AND at < (SELECT at FROM org_node_link_log WHERE node_id=$1 ORDER BY at DESC OFFSET $2 LIMIT 1)`,
    [nodeId, LINK_LOG_KEEP],
  );
}

/**
 * 진단 창(24시간) 안의 이벤트를 **노드별로** 한 번에 읽는다.
 *  ⚠ 노드마다 쿼리하지 않는다 — 목록 API 는 자주 불리고, 노드 수만큼 왕복하면 그게 곧 지연이 된다.
 *   전체라야 노드 수 × LINK_LOG_KEEP 행(현재 규모로 수백 행)이라 한 번에 읽는 편이 싸다.
 */
export async function loadRecentLinkEvents(now: number = Date.now()): Promise<Map<string, LinkEvent[]>> {
  const r = await itemsPool.query(
    `SELECT node_id, ev, at FROM org_node_link_log WHERE at > $1 ORDER BY node_id, at`,
    [new Date(now - WINDOW_MS)],
  );
  const out = new Map<string, LinkEvent[]>();
  for (const row of r.rows as Array<{ node_id: string; ev: "up" | "down"; at: Date }>) {
    const list = out.get(row.node_id) ?? [];
    list.push({ at: new Date(row.at).getTime(), ev: row.ev });
    out.set(row.node_id, list);
  }
  return out;
}
