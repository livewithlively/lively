// 분산 노드(#869) — org_node CRUD + 노드 채널 인증.
// 노드 토큰 설계: mintToken(scopes: []) 로 발급한 멤버 귀속 토큰 — 유효 scope 가 공집합이라
//  REST/MCP 어떤 표면에도 안 통한다(최소권한). 노드 채널(/node/ws)만 이 스토어의 authNodeToken 으로
//  org_node.token_hash 직접 매칭 + 토큰 미회수 + 소유 멤버 active 를 모두 요구한다(F7 blast radius).
import crypto from "node:crypto";
import { itemsPool } from "../db/client.js";
import { mintToken, revokeToken, getMember } from "../org/store.js";
import { HttpError } from "../http-error.js";

const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

export interface OrgNode {
  id: string; name: string; kind: "member" | "worker"; owner_member: string;
  token_hash: string | null; enabled: boolean;
  platform: string | null; agent_ver: string | null; agent_caps: string[] | null; host: string | null;
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
export async function createNode(input: { id: string; name?: string; kind?: string; owner: string }, actor?: string): Promise<{ node: OrgNode; token: string }> {
  const id = normalizeNodeId(input.id);
  const kind = input.kind === "worker" ? "worker" : "member";
  if (!(await getMember(input.owner))) throw new HttpError(400, `존재하지 않는 구성원입니다: ${input.owner}`);
  if (await getNode(id)) throw new HttpError(409, `이미 존재하는 노드입니다: ${id}`);
  const { token, tokenHash } = await mintToken(
    { userId: input.owner, memberId: input.owner, scopes: [], label: `node:${id}` },
    actor ?? input.owner, "node-store",
  );
  const r = await itemsPool.query(
    `INSERT INTO org_node(id, name, kind, owner_member, token_hash, created_by)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id, input.name || id, kind, input.owner, tokenHash, actor ?? null],
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

export async function deleteNode(id: string, actor?: string): Promise<{ deleted: boolean }> {
  const node = await getNode(id);
  if (!node) return { deleted: false };
  if (node.token_hash) await revokeToken(node.token_hash, actor, "node-store").catch(() => { /* best-effort */ });
  const r = await itemsPool.query(`DELETE FROM org_node WHERE id=$1`, [id]);
  return { deleted: (r.rowCount ?? 0) > 0 };
}

// hello 시 관측 필드 갱신 + 생존 확인 주기 갱신.
export async function touchNode(
  id: string,
  obs?: { platform?: string; agentVer?: string; host?: string; caps?: string[] },
): Promise<void> {
  // COALESCE — 관측값이 없으면(state push 로 부른 경우) 기존 값을 지우지 않는다.
  //  ⚠ agent_ver 가 라이브에서 **영원히 NULL** 이던 원인이 여기가 아니라 **hello 가 안 보낸 것**이었다(#905 C4).
  //   COALESCE 는 정상이었고, 넘어오는 값이 늘 undefined 였다.
  await itemsPool.query(
    `UPDATE org_node SET last_seen=now(), updated_at=now(),
        platform=COALESCE($2, platform), agent_ver=COALESCE($3, agent_ver), host=COALESCE($4, host),
        agent_caps=COALESCE($5, agent_caps)
      WHERE id=$1`,
    [id, obs?.platform ?? null, obs?.agentVer ?? null, obs?.host ?? null, obs?.caps ?? null],
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
