// 세션 휴지통 라우트(#1851) — POST /api/ui/terminal/session-trash {op, ids}
//
//  흐름(원준 2026-08-23): 도는 세션 → ×(지난 세션으로, DELETE ?reclaim=1) → 지난 세션에서 휴지통 → **휴지통 안에서만**
//  완전 삭제(종전 '완전 삭제' ×)·비우기. 종전엔 지난 세션 행의 × 가 곧바로 desired-state 를 지웠다(되돌릴 수 없고, 중앙 기록
//  행이 '기록'으로 다시 떠올랐다). 이 라우트가 그 한 단계를 둘로 가른다.
//   · trash   — 휴지통으로. 도는 세션은 거부(먼저 ×로 멈춰야 한다 — 휴지통은 '지난 세션'의 다음 단계다).
//               #3870 — body.stop_live === true 면 멈추고 넣는다(사이드바 휴지통 단추가 사람에게 묻고 나서 켠다).
//   · untrash — 되돌리기(지난 세션으로 복귀).
//   · purge   — 완전 삭제: desired-state 행을 지우고(되살리기 불가) 휴지통 표식을 purged 로(목록에서 영영 빠진다).
//   · empty   — 휴지통 비우기 = 휴지통의 내 세션 전부 purge.
//  owner 게이트 — 자기 세션만(desired-state 의 owner, 중앙 기록의 owner). 남의 것이 섞여 오면 그 id 만 건너뛰고 skipped 로 알린다.
//  한 세션의 두 이름(박스 id·대화 uuid)을 **함께** 표식한다 — 프론트가 넘긴 ids 에 더해 desired-state 의 claude_session_id 도 덧붙인다.
import type express from "express";
import type { LivelyUser } from "../context.js";
import { wrap, HttpError } from "../http/rest-util.js";
import { listTrashedIds } from "./session-trash.js";
import { applySessionTrashOp, type TrashOp } from "./session-trash-ops.js";   // 핵심은 ops 모듈 — 프로젝트 휴지통(capabilities)과 공유

const userOf = (req: express.Request): LivelyUser => (req.auth?.extra ?? {}) as unknown as LivelyUser;
const idOf = (u: LivelyUser): string => u.userId || u.email || "";
const OPS = new Set(["trash", "untrash", "purge", "empty"]);

export function registerSessionTrashRoutes(app: express.Express, auth: express.RequestHandler): void {
  app.post("/api/ui/terminal/session-trash", auth, wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const u = userOf(req);
    const me = idOf(u);
    if (!me) throw new HttpError(403, "사용자 신원이 없습니다");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const op = String(b.op ?? "").trim();
    if (!OPS.has(op)) throw new HttpError(400, "op 는 trash|untrash|purge|empty");
    let ids = Array.isArray(b.ids) ? (b.ids as unknown[]).map((x) => String(x ?? "").trim()).filter(Boolean) : [];
    if (op === "empty") ids = await listTrashedIds(me);
    else if (!ids.length) throw new HttpError(400, "ids 가 필요합니다");
    if (ids.length > 500) throw new HttpError(400, "한 번에 500개까지");
    //  #3870(원준 2026-10-05 «잘못 생성한 세션을 … 완료를 거치지 않고 삭제를 할 수가 없잖아») — stop_live 면 도는 세션을 **멈추고** 넣는다.
    //   프로젝트를 통째로 버릴 때 이미 쓰는 길(applySessionTrashOp stopLive)을 세션 하나에도 연다. 안 주면 종전대로 거부한다 —
    //   화면이 «하던 작업이 멈춘다» 를 사람에게 묻고 나서만 켜는 값이다. trash 에만 뜻이 있다(완전 삭제는 원래 멈추고 지운다).
    //   mustStop — 못 멈추면(그 세션이 도는 컴퓨터가 꺼져 있다) 넣지 않고 이유를 돌려준다(session-trash-ops liveTrashRefusal).
    const stopLive = op === "trash" && b.stop_live === true;
    const { done, skipped } = await applySessionTrashOp(u, me, op as TrashOp, ids, stopLive ? { stopLive: true, mustStop: true } : {});
    res.json({ ok: true, op, done, skipped });
  }));
}
