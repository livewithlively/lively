// 세션의 대화 파일을 **찾는 한 자리** — 라우트(chat-routes)와 감시자(transcript-watch)가 같은 답을 쓴다 (#3699).
//
//  ── 왜 뽑았나 ────────────────────────────────────────────────────────────────────
//  «이 세션의 대화 파일이 어디 있나» 는 조각 여섯의 합이다: 매핑된 대화 id · 하네스 · 실행 폴더 ·
//   소유자 osUser(로컬 fs 냐 멤버 중계냐) · 훅이 보고한 경로 · 규약 폴백. 종전엔 그 여섯이
//   `chat-routes` 의 transcript 핸들러 **안에만** 있었다. #3699 가 같은 파일을 지켜보는 **두 번째
//   호출자**(감시자)를 들이면서, 그 계산이 두 벌이 되면 «화면이 읽는 파일» 과 «감시자가 지켜보는 파일»
//   이 조용히 갈린다 — 그러면 알림은 오는데 화면은 안 자라거나(다른 파일), 알림이 영영 안 온다.
//   조용히 갈리는 종류의 결함이라 신고도 안 된다(sse-frames.ts 를 떼어낸 것과 같은 결).
//
//  ── 경계 ─────────────────────────────────────────────────────────────────────────
//  여기는 **계산만** 한다. 실패의 뜻을 HTTP 상태·문장으로 옮기는 것은 라우트의 몫이고(사람에게 말하는
//   자리는 하나여야 한다), 감시자는 같은 실패를 «아직 아니다» 로 읽고 조용히 다시 시도한다.
import { sessionDir } from "./terminal-sessions.js";
import { getOpt } from "./tmux-exec.js";
import { resolveSessionDir } from "../sessions/session-desired.js";
import { getSessionState } from "../sessions/session-state.js";
import { sessionOsUser } from "./profiles.js";
import { harnessIo, type HarnessSessionAdapter } from "./harness-io/adapter.js";
import { locateTranscript, type Located } from "./harness-io/locate.js";
import { transcriptFsFor, type TranscriptFs } from "./harness-io/transcript-fs.js";

/**
 * 이 세션의 하네스 — desired-state 미러(있으면) → 라이브 tmux 옵션(`@box_harness`) 폴백.
 *  둘 다 없으면 `''`(모름) — **claude 로 추측하지 않는다**(못 읽는 하네스로 다룬다).
 */
export async function harnessOf(id: string, stHarness: string | null | undefined): Promise<string> {
  if (stHarness) return stHarness;
  return (await getOpt(id, "@box_harness").catch(() => "")) || "";
}

/**
 * 읽을 수 있다고 판정된 어댑터 — `parse` 가 **있다는 사실이 타입에 남는다**.
 *  종전엔 라우트 안에서 `if (!io.parse) throw` 로 좁혀졌는데, 판정을 여기로 옮기면서 그 좁힘까지 같이
 *  옮기지 않으면 호출부가 다시 `!` 로 우겨야 한다 — 그러면 «못 읽는 하네스» 판정이 두 벌이 된다.
 */
export type ReadableAdapter = HarnessSessionAdapter & { parse: NonNullable<HarnessSessionAdapter["parse"]> };

export interface TranscriptTargetOk {
  ok: true;
  /** 실제로 읽을 대화 id(요청한 uuid 또는 매핑된 것). */
  uuid: string;
  /** 이 세션에 **지금 매핑된** 대화 id — 훅이 보고한 경로를 믿어도 되는지 가르는 값. */
  mapped: string;
  io: ReadableAdapter;
  cwd: string;
  tfs: TranscriptFs;
  found: Located;
}
/**
 * 못 찾은 이유 — 셋을 가르는 까닭은 **부르는 쪽이 다르게 다뤄야 하기 때문**이다:
 *  `no-uuid`·`not-found` 는 «아직»(첫 대화가 오가면 생긴다) 이고, `unreadable` 은 «영영»(이 하네스는 못 읽는다) 이다.
 *  감시자는 앞의 둘엔 다시 걸고 뒤엔 포기한다 — 안 가르면 못 읽는 하네스 세션에 영원히 재시도가 돈다.
 */
export type TranscriptTargetFail =
  | { ok: false; why: "no-uuid" }
  | { ok: false; why: "unreadable"; label: string }
  | { ok: false; why: "not-found" };
export type TranscriptTarget = TranscriptTargetOk | TranscriptTargetFail;

/**
 * 이 박스 세션의 대화 파일을 찾는다.
 *
 * @param wantUuid 이 박스의 **다른 대화 파일**(맥락 압축 전 파일). 비우면 지금 매핑된 대화.
 *
 *  ⚠ 훅이 보고한 경로(`transcript_path`)는 **지금 매핑된 대화**의 것이다 — 다른 uuid 를 찾을 땐
 *   규약으로만 뒤진다(그 경로를 주면 엉뚱한 현재 파일을 읽는다).
 */
export async function resolveTranscript(id: string, wantUuid = ""): Promise<TranscriptTarget> {
  const st = await getSessionState(id);
  const mapped = st?.claude_session_id || "";
  const uuid = wantUuid || mapped;
  //  매핑이 없으면 여기서 끝이다 — cwd 규약 폴더를 훑어 최신 파일을 집지 않는다(#1719 회귀, 3b36df18 되돌림).
  //  대화 파일엔 어느 박스의 것인지가 안 적혀 있고 폴더는 cwd 로만 갈려, mtime 최신은 '내 대화'가 아니라
  //  '지금 제일 시끄러운 세션'이다. 박스↔대화 결합을 아는 곳은 세션 **안에서** 도는 훅뿐이다.
  if (!uuid) return { ok: false, why: "no-uuid" };
  const harness = await harnessOf(id, st?.harness);
  const io = harnessIo(harness);
  if (!io || !io.parse) return { ok: false, why: "unreadable", label: io?.label || harness || "이 하네스" };
  const readable = io as ReadableAdapter;
  // 실행 폴더 — desired-state 미러가 있으면 그것, 없으면 tmux 옵션(라이브).
  const cwd = st?.dir || await resolveSessionDir(id, () => sessionDir(id)).catch(() => "");
  // 파일 접근 파사드 — 소유자 osUser(격리·중계 판정은 sessionOsUser 가) → 로컬 fs 또는 멤버 실행환경 중계.
  const tfs = transcriptFsFor(await sessionOsUser(id).catch(() => null));
  const found = await locateTranscript(
    readable,
    { cwd, convId: uuid, owner: st?.owner || "", reportedPath: uuid === mapped ? st?.transcript_path : null },
    tfs.stat,
  );
  if (!found) return { ok: false, why: "not-found" };
  return { ok: true, uuid, mapped, io: readable, cwd, tfs, found };
}
