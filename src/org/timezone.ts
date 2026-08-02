// 조직 시간대(#778) — 게이트웨이의 모든 '벽시계' 의미론(스케줄러 cron · 일자 집계 · 세션 pane TZ)의 단일 출처.
//
//  왜 머신(OS) 시간대가 아니라 조직 설정인가:
//   - 게이트웨이는 **비-root 서비스 유저**로 돌고 root 는 잠긴 sudoers 화이트리스트(고정 스크립트 2개)뿐이다.
//     `timedatectl set-timezone` 을 웹에서 하려면 그 root 표면을 넓혀야 하는데, 시간대 하나 때문에 할 일이 아니다.
//   - 박스(고객 EC2 등)의 OS 전역 시간대는 **우리 소유가 아니다** — 거기 다른 프로세스·로그·모니터링이 UTC 를 전제할 수 있다.
//   - 리눅스 서버 기본 TZ 는 대개 UTC 라, 그대로 두면 '매일 09:00' cron 이 **18:00 KST 에 돈다**(#778 의 진짜 버그).
//  → 시간대를 제품 설정으로 올려 게이트웨이 안에서 결정론적으로 만든다. OS 는 건드리지 않는다.
import { itemsPool } from "../db/client.js";

export const DEFAULT_TZ = "Asia/Seoul";

// IANA 존 검증 — Intl 이 모르는 존이면 RangeError. 이 값은 SQL `AT TIME ZONE $n` 과 tmux `-e TZ=` 로 흘러가므로
//  (둘 다 파라미터/argv = 인젝션 표면 없음) 형식 가드가 아니라 **의미 가드**로서 저장 전에 한 번 친다.
export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; }
  catch { return false; }
}

// 캐시 — cron 틱(30s)·세션 생성마다 DB 를 때리지 않게. 쓰기(updateOrgProfile)가 즉시 무효화하고 TTL 은 백스톱.
let cached: { tz: string; at: number } | null = null;
const TTL_MS = 60_000;

// 유효 시간대. 미설정(NULL)·미지의 존·DB 미연결 → DEFAULT_TZ (기본값의 단일 출처는 DB DEFAULT 가 아니라 여기).
export async function orgTimezone(): Promise<string> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.tz;
  let tz = DEFAULT_TZ;
  try {
    const r = await itemsPool.query(`SELECT timezone FROM org_profile WHERE id=1`);
    const v = (r.rows[0] as { timezone?: string | null } | undefined)?.timezone;
    if (v && isValidTimezone(v)) tz = v;
  } catch { /* 테이블 부재(부팅 초기)·DB 미연결 → 기본값. 시간대 때문에 세션·틱을 죽이지 않는다. */ }
  cached = { tz, at: Date.now() };
  return tz;
}

export function invalidateOrgTimezone(): void { cached = null; }
