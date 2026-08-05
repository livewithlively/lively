// ═══════════════════════════════════════════════════════════════════════════
// 앱↔CLI 계약 (#1541 T1) — `--json-events` 의 NDJSON 진행 이벤트 + 프롬프트 채널.
//
// **왜 있나**: 데스크톱 앱은 설치·로그인·노드 로직을 재구현하지 않는다(#864 가 만든 '설치 로직 단일화'를
//  깨지 않기 위함). 앱은 `lively` 를 자식 프로세스로 감싸 그 진행을 GUI 로 그린다. 그러려면 CLI 가
//  **기계가 읽을 수 있는** 진행 신호를 내야 하고, 사람 확인이 필요한 자리를 GUI 가 대신 물어볼 수 있어야 한다.
//
// **왜 stdout 인가**: 이 CLI 는 이미 사람용 출력을 전부 stderr 로 보내고 stdout 은 `--json` 기계 판독용으로
//  비워 두는 규약을 지킨다(lively.mjs §1). 그 규약 위에 그대로 얹는다 — 사람용 출력은 **하나도 안 바뀐다**.
//
// **왜 별도 파일인가**: 인코딩·답 파싱·대기 로직은 프로세스를 띄우지 않고 검증할 수 있는 순수/준순수부다.
//  lively.mjs 안에 두면 그 검증이 통째로 e2e 스폰 테스트가 되어 느리고 엣지를 못 덮는다.
//
// ⚠ **비밀은 이벤트에 싣지 않는다.** 토큰 값은 stdout 으로 나가면 앱 로그·크래시 리포트로 샌다.
//  이벤트에 담는 건 '무슨 단계인가'와 '사람이 봐야 할 문구'뿐이다.
// ═══════════════════════════════════════════════════════════════════════════

export const EVENT_V = 1;

/**
 * 이벤트 문구에서 ANSI 색·스타일 시퀀스를 제거한다.
 *
 * GUI 는 색 코드를 렌더할 수 없고, 로그에 남으면 읽기만 나빠진다. **ESC 바이트까지 함께** 지우는 게 요점이다 —
 * `\x1b` 를 빼고 `[0m` 만 지우면 보이지 않는 ESC 가 문구에 남아 앱 쪽 표시가 깨진다(그리고 눈으로는 안 보인다).
 * CSI 계열(`ESC [ … 종결문자`)을 통째로 지운다 — 색(m) 말고도 커서 이동 등이 섞여 들어올 수 있다.
 */
export const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

/**
 * 이벤트 1건 → NDJSON **한 줄**(끝에 개행 1개). 순수 함수.
 *
 * 봉투(v·t·ts)는 payload 가 **덮어쓸 수 없다** — 페이로드가 봉투를 위조하면 앱의 버전 협상·정렬이 무너진다.
 * 직렬화가 실패해도(순환참조 등) **throw 하지 않는다**: 진행 보고가 명령을 죽이면 안 된다. 대신 그 사실을
 * 담은 이벤트를 낸다(조용한 유실보다 낫다 — 앱이 '뭔가 못 실었다'를 알 수 있어야 한다).
 */
export function encodeEvent(t, payload, ts) {
  const env = { v: EVENT_V, t: String(t), ts: Number(ts) };
  try {
    return JSON.stringify({ ...(payload && typeof payload === "object" ? payload : {}), ...env }) + "\n";
  } catch (e) {
    return JSON.stringify({ ...env, t: "notice", level: "warn", message: `이벤트 직렬화 실패(${t}): ${e?.message || e}` }) + "\n";
  }
}

/**
 * stdin 한 줄 → 답 `{id, value}` 또는 `null`(무시). 순수 함수.
 *
 * ⚠ `value` 가 없으면 **null 이다**(빈 답을 '기본값 승인'으로 만들지 않는다). 앱이 실수로 빈 객체를 보내는 것과
 *  사람이 실제로 '아니오'를 고른 것은 완전히 다른 사건이고, 전자를 후자로 오독하면 신원확인이 조용히 통과한다.
 */
export function parseAnswer(line) {
  let m;
  try { m = JSON.parse(String(line)); } catch { return null; }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  if (m.t !== "answer") return null;
  if (typeof m.id !== "string" || !m.id) return null;
  if (!("value" in m)) return null;
  return { id: m.id, value: m.value };
}

/** 이벤트 발행기 — `write(line)` 와 시계만 주입받는다(테스트가 프로세스 없이 전량 관측). */
export function createEmitter({ write, now = () => Date.now() } = {}) {
  const emit = (t, payload) => { write(encodeEvent(t, payload, now())); };
  return {
    emit,
    start: (cmd, cli) => emit("start", { cmd, cli }),
    /** status: start|done|fail. i/n 은 진행률(1-based / 총계) — 없으면 생략된다. */
    step: (id, label, status, extra) => emit("step", { id, label, status, ...(extra || {}) }),
    notice: (level, message) => emit("notice", { level, message }),
    result: (data) => emit("result", { data }),
    end: (ok, code) => emit("end", { ok: !!ok, code: Number(code) || 0 }),
  };
}

/**
 * 프롬프트 채널 — `prompt` 이벤트를 내고 stdin 의 답을 기다린다.
 *
 * `onLine(cb)` 로 줄 공급원을, `onEnd(cb)` 로 입력 종료를 주입받는다(테스트가 stdin 없이 구동).
 *
 * ⚠ **EOF 는 기본값 승인이 아니라 실패다**(C4). 답 없이 입력이 닫혔다는 건 앱이 죽었거나 계약을 안 지킨 것이고,
 *  그때 `def` 로 진행하면 "이 계정으로 로그인됩니다" 같은 **신원확인이 사람 없이 통과**한다(#R2-F1 이 막으려던 바로 그것).
 *  fail-closed 가 맞다.
 */
export function createPrompter({ emit, onLine, onEnd }) {
  const waiting = new Map();      // id → resolve/reject
  let ended = false;
  onLine((line) => {
    const a = parseAnswer(line);
    if (!a) return;                                   // 잡음·다른 메시지는 조용히 무시(C2·C3)
    const w = waiting.get(a.id);
    if (!w) return;                                   // 내가 안 기다리는 id — 무시
    waiting.delete(a.id);
    w.resolve(a.value);
  });
  if (typeof onEnd === "function") {
    onEnd(() => {
      ended = true;
      for (const [, w] of waiting) w.reject(new Error("앱과의 연결이 끊겼습니다(답을 받지 못했습니다)."));
      waiting.clear();
    });
  }
  /** kind·payload 로 물어보고 답을 기다린다. id 는 호출자가 준다(짝을 앱이 맞출 수 있게). */
  return {
    ask(id, kind, payload) {
      if (ended) return Promise.reject(new Error("앱과의 연결이 끊겼습니다(답을 받지 못했습니다)."));
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        emit("prompt", { id, kind, ...(payload || {}) });
      });
    },
    /** 답을 기다리지 않는 통지용 프롬프트(예: device-code — 사람은 브라우저에서 승인한다). */
    tell(id, kind, payload) { emit("prompt", { id, kind, ...(payload || {}) }); },
    get pending() { return waiting.size; },
  };
}

/** 스트림 → 줄 단위 공급원. 청크 경계에서 답이 잘리지 않게 버퍼링한다(C6). */
export function lineReader(stream) {
  let buf = "";
  const lineCbs = [], endCbs = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      for (const cb of lineCbs) cb(line);
    }
  });
  stream.on("end", () => { if (buf.trim()) for (const cb of lineCbs) cb(buf); buf = ""; for (const cb of endCbs) cb(); });
  stream.on("error", () => { for (const cb of endCbs) cb(); });
  return { onLine: (cb) => lineCbs.push(cb), onEnd: (cb) => endCbs.push(cb) };
}
