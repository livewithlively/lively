// self 소스 열람 가드(#1291) — db_query/db_schema 진입 직후의 방어선 0-b. R24 가 만든 실행 파이프라인
//  (db/query-exec.ts)에서 **self 특화**라는 이유로 여기로 내려왔다(#1313 R48). query-exec 는 이 함수를
//  재수출만 하므로 소비자(tools/db.ts)의 import 는 그대로다.
//  ⚠ 이 파일은 db/self/ 계약에 따라 v6(visibility)를 알아도 된다 — 자세한 이유는 ./index.ts 헤더.
import { itemsPool } from "../client.js";
import { SELF_SOURCE } from "./self-source.js";
import { selfRlsReady } from "./self-rls.js";
import { activeBreakGlass } from "../../v6/visibility.js";

// #1291 — 내장 self 소스는 콘텐츠 테이블(project·knowledge·activity…)을 SQL 로 직접 읽는 창이다.
//  여기가 열려 있으면 `SELECT * FROM project` 한 줄로 다른 표면의 공개범위가 전부 무의미해진다.
//  ⚠ v2: admin 도 우회하지 않으므로 **admin 이라는 이유로 열어 주지 않는다.** 그렇다고 아무도 안 잠근 조직에서까지
//   조회를 뺏으면 "잠그기 전까지 달라지는 것 없음"이라는 전제가 깨진다(고객사 A 실측 61/66명이 db 스코프 보유).
//   그래서 **잠긴 맥락이 하나라도 생기는 순간부터** 콘텐츠 테이블을 닫고, 긴급 열람 중에만 다시 연다.
//   (행 단위로 걸러 주려면 비특권 롤 + RLS 가 필요하다 — 접속 롤이 소유자/슈퍼유저라 정책만으론 안 걸린다. 후속.)
let lockedAt = 0, lockedAny = false;
async function anyLockedContext(): Promise<boolean> {
  const now = Date.now();
  if (now - lockedAt < 30_000) return lockedAny;
  try {
    const r = await itemsPool.query(
      `SELECT 1 WHERE EXISTS(SELECT 1 FROM project_list WHERE visibility='members')
                 OR EXISTS(SELECT 1 FROM project_folder WHERE visibility='members')
                 OR EXISTS(SELECT 1 FROM knowledge WHERE visibility='members') LIMIT 1`);
    lockedAny = (r.rowCount ?? 0) > 0; lockedAt = now;
  } catch { lockedAny = true; }   // 판정 불가면 닫는 쪽
  return lockedAny;
}

export async function requireSelfSourceAllowed(
  user: { scopes: string[]; userId?: string }, source: string,
): Promise<void> {
  if (source !== SELF_SOURCE) return;
  // #1291 v3 — 행 단위 필터(RLS)가 준비됐으면 **전면 차단을 하지 않는다.** 잠긴 행만 빠지고 나머지는 그대로
  //  조회된다. v2 의 전면 차단은 "리스트 하나 잠갔더니 조직 전체가 SQL 조회를 잃는" 상태를 만들었다(고객사 A 실측).
  //  RLS 준비에 실패한 배포에서만 아래 v2 동작으로 폴백한다.
  if (selfRlsReady()) return;
  if (!(await anyLockedContext())) return;          // 아무도 안 잠갔으면 종전 그대로
  const me = user.userId || "";
  if (me) {
    const bg = await activeBreakGlass(me);
    if (bg.some((b) => !b.kind)) return;            // 전체 스코프 긴급 열람 중이면 연다
  }
  throw new Error(
    "self 소스는 지금 조회할 수 없습니다 — 이 조직에는 공개범위가 지정된 맥락이 있어, SQL 직접 조회로 그 범위를 "
    + "우회하지 않도록 제한됩니다. 관리자에게 공개범위 조정을 요청하거나, 긴급 열람(vis_break_glass_start · Enterprise)을 사유와 함께 여세요. "
    + "다른 등록 소스는 종전대로 조회 가능합니다.");
}
