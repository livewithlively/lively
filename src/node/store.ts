// 분산 노드(#869) — org_node CRUD + 노드 채널 인증.
// 노드 토큰 설계: mintToken(scopes: []) 로 발급한 멤버 귀속 토큰 — 유효 scope 가 공집합이라
//  REST/MCP 어떤 표면에도 안 통한다(최소권한). 노드 채널(/node/ws)만 이 스토어의 authNodeToken 으로
//  org_node.token_hash 직접 매칭 + 토큰 미회수 + 소유 멤버 active 를 모두 요구한다(F7 blast radius).
import crypto from "node:crypto";
import { itemsPool, withTx } from "../db/client.js";
import { mintToken, revokeToken } from "../org/store/tokens.js";
import { getMember } from "../org/store/members.js";   // #2165 — 배럴(org/store.js) 대신 좁은 모듈: 배럴을 타면 커넥터·수집기·토큰소스가 통째로 노드 번들에 실린다
import { HttpError } from "../http-error.js";
import type { KeepAwakeStatus } from "./keep-awake.js";
import { LINK_LOG_KEEP } from "../org/schema/node-link-log.js";   // #1849 — 노드당 보관 이벤트 상한(단일 출처)
import { WINDOW_MS, type LinkEvent } from "./sleep-pattern.js";   // #1849 — 진단 창(같은 값으로 읽는다)
import type { NodeAuthDenial, NodeAuthOutcome } from "./auth-denial.js";   // #2161 — 거부 사유(조용한 null 제거)
import { nodeTokenIssuedByRegistration } from "./auth-denial.js";          // #2215 — 노드 토큰 불변식(label·scope)

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
//  ★ 원자적이어야 한다(#2161) — 종전엔 mintToken(커밋) → INSERT org_node 가 **따로 커밋**돼, INSERT 가 실패하면
//   `auth_token` 에 **어디에도 매칭되지 않는 고아 토큰**만 남았다. 그 토큰을 받아 든 노드는 authNodeToken 의
//   조인이 영원히 비어 **502 무한 재시도**를 돈다(실측: 재기동마다 새 토큰이 쌓이고 org_node 는 0건).
//   같은 함정을 #880 device flow 가 먼저 겪고 mintToken 에 client 오버로드를 만들어 뒀다 — 여기서 그걸 쓴다.
export async function createNode(input: { id: string; name?: string; kind?: string; owner: string; shared?: boolean }, actor?: string): Promise<{ node: OrgNode; token: string }> {
  const id = normalizeNodeId(input.id);
  const kind = input.kind === "worker" ? "worker" : "member";
  if (!(await getMember(input.owner))) throw new HttpError(400, `존재하지 않는 구성원입니다: ${input.owner}`);
  if (await getNode(id)) throw new HttpError(409, `이미 존재하는 노드입니다: ${id}`);
  try {
    return await withTx(async (client) => {
      const { token, tokenHash } = await mintToken(
        { userId: input.owner, memberId: input.owner, scopes: [], label: `node:${id}` },
        actor ?? input.owner, "node-store", client,
      );
      const r = await client.query(
        `INSERT INTO org_node(id, name, kind, owner_member, token_hash, created_by, shared)
           VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        // shared 는 **명시할 때만** 켜진다(#1540) — 기본은 등록한 사람 것. 호출부(REST)가 admin 게이트를 건다.
        [id, input.name || id, kind, input.owner, tokenHash, actor ?? null, !!input.shared],
      );
      return { node: r.rows[0] as OrgNode, token };
    });
  } catch (e) {
    // 위 getNode 체크와 INSERT 사이의 경합(같은 노드를 두 번 등록) — PK 위반은 '이미 있다'가 맞는 답이다.
    //  종전엔 이게 500 으로 나가 호출부(CLI)가 rotate 폴백을 못 타고 죽었다.
    if ((e as { code?: string } | null)?.code === "23505") throw new HttpError(409, `이미 존재하는 노드입니다: ${id}`);
    throw e;
  }
}

// 토큰 재발급(회전) — 구 토큰 revoke 후 새 토큰으로 교체. 노드 에이전트 재설치/유출 대응.
//  ★ 여기도 원자적이어야 한다(#2161), 그리고 createNode 보다 위험하다 — 종전 순서는
//   revoke(구 토큰 즉시 무효) → mint → UPDATE 였다. UPDATE 가 실패하면 **구 토큰은 이미 죽었고 새 토큰은
//   org_node 에 안 붙어**, 그 노드는 어느 토큰으로도 못 붙는다(영구 사망). 셋을 한 트랜잭션에 묶어
//   중간 실패 시 구 토큰이 살아 있게 한다 — 회전에 실패하면 **아무 일도 없었던 것**이어야 한다.
export async function rotateNodeToken(id: string, actor?: string): Promise<{ node: OrgNode; token: string }> {
  const node = await getNode(id);
  if (!node) throw new HttpError(404, `노드 없음: ${id}`);
  return withTx(async (client) => {
    const { token, tokenHash } = await mintToken(
      { userId: node.owner_member, memberId: node.owner_member, scopes: [], label: `node:${id}` },
      actor ?? node.owner_member, "node-store", client,
    );
    const r = await client.query(`UPDATE org_node SET token_hash=$2, updated_at=now() WHERE id=$1 RETURNING *`, [id, tokenHash]);
    if (r.rowCount !== 1) throw new HttpError(404, `노드 없음: ${id}`);   // 회전 도중 삭제됐다 — 새 토큰도 롤백된다.
    // 구 토큰 회수는 **교체가 확정된 뒤**(같은 트랜잭션 안에서) — 순서가 뒤집히면 위 사고가 난다.
    if (node.token_hash) await revokeToken(node.token_hash, actor, "node-store", client).catch(() => { /* 이미 회수됐어도 계속 */ });
    return { node: r.rows[0] as OrgNode, token };
  });
}

/**
 * 노드 토큰만 회수한다 — **등록 행(org_node)은 남긴다**(#2215).
 *
 * 로그아웃이 부르는 자리다. 종전엔 `lively logout` 이 `~/.lively/token` 파일 하나만 지워서,
 *  그 PC 의 노드는 **옛 테넌트에 계속 붙어 세션을 서빙했다**(노드 토큰은 로그인 토큰과 별개라 무관하게 유효).
 *  기기 회수·퇴사·워크스페이스 이동에서 그건 그대로 구멍이다.
 *
 * 왜 노드 행을 안 지우나: 그 노드에 묶인 세션 이력·설정(enabled·shared·keep_awake)을 함께 잃지 않기 위해서다.
 *  토큰만 죽으면 그 기계는 즉시 끊기고(다음 인증이 `revoked`), 다시 로그인해 `lively node` 를 돌리면
 *  같은 id 로 회전 등록돼 이력이 이어진다.
 */
export async function revokeNodeToken(id: string, actor?: string): Promise<{ revoked: boolean; node: string }> {
  const node = await getNode(id);
  if (!node) throw new HttpError(404, `노드 없음: ${id}`);
  if (!node.token_hash) return { revoked: false, node: id };
  await revokeToken(node.token_hash, actor, "node-store");
  return { revoked: true, node: id };
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

// 노드 채널 인증 — 평문 토큰으로 org_node 를 특정한다. 어느 하나라도 어긋나면 거부:
//  토큰 해시 매칭 · auth_token 미회수 · 노드 enabled · 소유 멤버 active.
//
// ★ 실패는 **왜 실패했는지까지** 돌려준다(#2161). 종전엔 넷을 전부 `null` 하나로 뭉갰고(사연은 auth-denial.ts),
//  그래서 매니지드에서 노드가 502 를 도는 동안 게이트웨이에 로그 한 줄이 없었다. 판정(여기)과 그 결과를
//  사람에게 전하는 일(호출부의 logger)을 갈라 둔다 — 이 함수는 여전히 순수 판정이다.
export async function authNodeTokenDetailed(token: string): Promise<NodeAuthOutcome<OrgNode>> {
  if (!token || !token.startsWith("lvk_")) return { ok: false, fingerprint: "", reason: "malformed" };
  const hash = sha256(token);
  // 상관추적용 지문 — 평문이 아니라 **해시의 앞부분**이다(해시는 비밀이 아니다: tokens.ts revokeToken 과 같은 관례).
  //  로그끼리, 그리고 DB 의 token_hash 와 맞대 볼 수 있으면 그걸로 충분하다.
  const fingerprint = hash.slice(0, 12);
  if (!process.env.ITEMS_DATABASE_URL) return { ok: false, fingerprint, reason: "no-db" };
  try {
    // 토큰의 label·scopes 를 **함께** 읽어 온다(#2215) — 조인만으로는 "그 자리에 앉은 토큰이 노드 발급물인가"를
    //  묻지 않아서, 로그인 토큰이 org_node.token_hash 에 들어가 있어도 조용히 통과했다(실측: admin 전체 scope).
    //  ⚠ 판정을 SQL 조건으로 내리지 않는다 — 규칙이 여기와 아래 진단 경로 둘로 갈리면 드리프트한다.
    //   규칙은 nodeTokenIssuedByRegistration 한 벌이고, SQL 은 재료만 나른다.
    const r = await itemsPool.query(
      `SELECT n.*, t.label AS tok_label, t.scopes AS tok_scopes FROM org_node n
         JOIN auth_token t ON t.token_hash = n.token_hash
         JOIN org_member m ON m.id = n.owner_member
        WHERE n.token_hash = $1 AND t.revoked_at IS NULL AND n.enabled AND m.state = 'active'`,
      [hash],
    );
    const row = r.rows[0] as (OrgNode & { tok_label: string | null; tok_scopes: unknown }) | undefined;
    if (row) {
      const { tok_label: label, tok_scopes: scopes, ...node } = row;
      if (!nodeTokenIssuedByRegistration({ nodeId: node.id, label, scopes })) {
        return {
          ok: false, fingerprint, reason: "token-not-node-issued",
          node: node.id, label,
          scopes: Array.isArray(scopes) ? scopes.map((s) => String(s)) : [],
        };
      }
      return { ok: true, node: node as OrgNode };
    }
  } catch (e) {
    // DB 불가 = fail-closed(연결 거부)는 종전과 같다. 달라진 것은 **그 사실을 말한다**는 점뿐이다.
    return { ok: false, fingerprint, reason: "db-error", detail: e instanceof Error ? e.message : String(e) };
  }
  // ── 여기부터는 **거부가 확정된 뒤에만** 도는 진단 경로다(성공 핫패스에는 비용이 얹히지 않는다).
  //  거부는 드물어야 하고, 드물지 않다면 그 사실 자체가 우리가 알아야 할 정보다.
  try {
    const d = await itemsPool.query(
      `SELECT t.label, t.member_id, t.revoked_at, t.scopes,
              n.id AS node_id, n.enabled, n.owner_member, m.state AS owner_state
         FROM auth_token t
         LEFT JOIN org_node n ON n.token_hash = t.token_hash
         LEFT JOIN org_member m ON m.id = n.owner_member
        WHERE t.token_hash = $1`,
      [hash],
    );
    const row = d.rows[0] as {
      label: string | null; member_id: string | null; revoked_at: string | null; scopes: unknown;
      node_id: string | null; enabled: boolean | null; owner_member: string | null; owner_state: string | null;
    } | undefined;
    // 이 테넌트에 그 토큰 자체가 없다. 다른 게이트웨이의 토큰을 들고 온 경우가 여기로 온다
    //  (RLS 로 남의 테넌트 토큰이 안 보이는 경우도 같은 칸 — 어느 쪽이든 사람이 할 일은 '재등록'으로 같다).
    if (!row) return { ok: false, fingerprint, reason: "unknown-token" };
    if (row.revoked_at) return { ok: false, fingerprint, reason: "revoked", label: row.label };
    if (!row.node_id) return { ok: false, fingerprint, reason: "not-a-node-token", label: row.label, member: row.member_id };
    if (!row.enabled) return { ok: false, fingerprint, reason: "node-disabled", node: row.node_id };
    if (row.owner_state !== "active") {
      return { ok: false, fingerprint, reason: "owner-inactive", node: row.node_id, owner: row.owner_member ?? "(없음)", state: row.owner_state };
    }
    // 노드·소유자는 멀쩡한데 그 자리의 토큰이 노드 발급물이 아니다(#2215) — 본 쿼리가 빈 이유가 여기다.
    if (!nodeTokenIssuedByRegistration({ nodeId: row.node_id, label: row.label, scopes: row.scopes })) {
      return {
        ok: false, fingerprint, reason: "token-not-node-issued",
        node: row.node_id, label: row.label,
        scopes: Array.isArray(row.scopes) ? row.scopes.map((s) => String(s)) : [],
      };
    }
    // 위를 다 통과했는데 본 쿼리가 비었다 = 그 사이에 바뀌었다(경합). 재연결하면 풀린다.
    return { ok: false, fingerprint, reason: "unknown-token" };
  } catch (e) {
    return { ok: false, fingerprint, reason: "db-error", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** 종전 시그니처(호출부 무회귀) — 사유가 필요하면 authNodeTokenDetailed 를 쓴다. */
export async function authNodeToken(token: string): Promise<OrgNode | null> {
  const r = await authNodeTokenDetailed(token);
  return r.ok ? r.node : null;
}

export type { NodeAuthDenial, NodeAuthOutcome };

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
