// 실패한 수집 실행의 사정 — 로그 끝에서 사람이 읽을 한 줄(#4135).
//
//  종전(auto-runs.ts lastLine)은 로그 마지막 줄을 그대로 돌려줬다. 수집 워커의 마지막 줄은 대개 구조화 로그(JSON)라
//   화면에 `{"level":50,"time":…,"err":"Figma 토큰이 없습니다 — …"}` 가 통째로 나왔다. 그 줄에서 사정(err · 없으면 msg)만 꺼낸다.
//  수집기 목록의 last_run 과 자동 실행 기록이 같은 함수를 쓴다 — 같은 실패가 두 화면에서 다른 말로 나오지 않게.
export const REASON_MAX = 300;

export function failReason(logTail: string | null | undefined): string | null {
  const lines = String(logTail ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : "";
  if (!last) return null;
  let text = last;
  if (last.startsWith("{")) {
    try {
      const j = JSON.parse(last) as Record<string, unknown>;
      const err = j.err;
      const fromErr = typeof err === "string" ? err
        : err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string" ? String((err as { message: string }).message)
        : "";
      const picked = (fromErr || (typeof j.msg === "string" ? j.msg : "")).trim();
      if (picked) text = picked;
    } catch { /* 잘린 줄 — 있는 그대로 */ }
  }
  return text.slice(0, REASON_MAX);
}
