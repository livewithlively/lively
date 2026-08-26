// dev 동기 상태를 **밖에서 보이게** 한다 (#2116).
//
// 왜: `serve-sync.sh` 는 손대면 안 되는 상태를 만나면 조용히 건너뛴다(그게 옳다 — 남의 WIP 를 지우지 않는다).
//  문제는 **그 사실이 로그에만 남는다**는 것이다. 2026-08-26 실측: 하루 세 번, 22분·15분씩 dev 가 옛 화면을
//  서빙하는 동안 아무도 몰랐다. 로그를 열어보기 전엔 알 길이 없었다.
//  훅(serving-clone-guard)이 알려진 두 경로를 막았지만, **새 구멍이 생기면 같은 침묵이 반복된다.**
//  그래서 침묵 자체를 없앤다 — 동기 잡이 자기 상태를 파일에 남기고, `/readyz` 가 그걸 실어 낸다.
//
// 왜 /readyz 인가: 그 라우트 머리말이 이미 못 박고 있다 — *"모니터·알림은 healthz 가 아니라 이걸 봐야 한다"*
//  (2026-07-13 디스크풀 사고). 새 알림 채널을 만들 이유가 없다.
//
// ⚠ **503 으로 만들지 않는다.** 동기가 막힌 것은 '게이트웨이가 못 선다'가 아니라 '내용이 낡았다'이다 —
//  LB 에서 빼면 멀쩡한 서비스를 죽이는 셈이다. 디스크 경고와 같은 등급(degraded, 200)으로 둔다.

/** `serve-sync.sh` 가 남기는 한 줄 상태. 없으면 이 기능이 안 도는 설치다(대다수). */
export interface StageSyncRaw {
  /** 이 상태를 쓴 시각(ISO). 잡이 살아 있다는 증거이기도 하다. */
  at?: unknown;
  state?: unknown;
  /** 건너뛴 이유의 **거친 분류**. 원문 메시지는 안 싣는다 — /readyz 는 미인증이다. */
  code?: unknown;
  /** 연속으로 건너뛰기 시작한 시각(ISO). 없으면 at 을 쓴다(구 판). */
  since?: unknown;
}

export interface StageSyncHealth {
  ok: boolean;
  state: "synced" | "skipped" | "stale";
  /** skipped 일 때의 거친 사유(unpushed·dirty·merging…). synced·stale 이면 null. */
  code: string | null;
  /** 막혀 있은 시간(초). synced 면 0. */
  stuckSec: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const ms = (iso: string): number | null => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/**
 * 파일 내용 → 건강 상태. 파일이 없거나 못 읽으면 **null**(이 설치엔 동기 잡이 없다 — /readyz 에 아예 안 싣는다).
 *
 * @param stuckSec 이만큼 **넘게** 연속으로 건너뛰면 degraded. 경계값은 아직 정상이다.
 * @param staleSec 잡이 이만큼 **넘게** 아무 상태도 안 남기면 잡 자체가 죽은 것으로 본다(launchd 실패·언로드).
 */
export function stageSyncHealth(
  raw: StageSyncRaw | null | undefined,
  nowMs: number,
  stuckSec = 600,
  staleSec = 300,
): StageSyncHealth | null {
  if (!raw || typeof raw !== "object") return null;
  const at = ms(str(raw.at));
  const state = str(raw.state);
  if (at === null || (state !== "synced" && state !== "skipped")) return null;

  const ageSec = Math.round((nowMs - at) / 1000);   // 미래 시각이면 음수 = '아주 신선함' — stale 판정만 하므로 그대로 안전하다
  // 잡이 아무 말도 안 한 지 오래다 — 건너뛴 것보다 나쁘다(건너뛰는 중이면 매 주기 갱신되기 때문이다).
  if (ageSec > staleSec) return { ok: false, state: "stale", code: null, stuckSec: ageSec };
  if (state === "synced") return { ok: true, state: "synced", code: null, stuckSec: 0 };

  const sinceIso = str(raw.since) || str(raw.at);
  const since = ms(sinceIso) ?? at;
  const stuck = Math.max(0, Math.round((nowMs - since) / 1000));
  return { ok: stuck <= stuckSec, state: "skipped", code: str(raw.code) || "unknown", stuckSec: stuck };
}

/**
 * 서빙 클론의 상태 파일을 읽어 판정한다. 파일이 없으면 **null** — serve-sync 를 안 쓰는 설치가 대다수다.
 *  경로는 `LIVELY_STAGE_SYNC_STATUS`, 없으면 `<cwd>/logs/stage-sync.status`(게이트웨이는 서빙 클론에서 뜬다).
 *  ⚠ 읽기 실패는 전부 null 로 삼킨다 — 이 부가 정보 하나 때문에 /readyz 를 실패시키지 않는다.
 */
export async function readStageSync(nowMs = Date.now()): Promise<StageSyncHealth | null> {
  // ⚠ 경로는 **logRoot()** 로 조립한다 — 이 레포는 런타임에서 process.cwd() 를 금지한다(dist/ops/state-dir.test).
  //  serve-sync.sh 도 `<클론>/logs/` 에 쓰므로 같은 자리를 가리킨다(배포가 logs/ 를 따로 소유한다).
  try {
    const [{ logRoot }, fsp, nodePath] = await Promise.all([
      import("./state-dir.js"), import("node:fs/promises"), import("node:path"),
    ]);
    const file = process.env.LIVELY_STAGE_SYNC_STATUS || nodePath.join(logRoot(), "stage-sync.status");
    const raw = JSON.parse(await fsp.readFile(file, "utf8")) as StageSyncRaw;
    return stageSyncHealth(raw, nowMs);
  } catch { return null; }
}
