// 서술 재작성 배치의 LLM 파일 교환 — 배치가 `claude -p` 를 직접 띄울 수 없는 자리(헤드리스 세션 안의 Bash 는
//  인증이 없어 중첩 `claude -p` 가 실패한다)에서, 요청을 파일로 내놓고 바깥 세션이 답을 파일로 돌려주게 한다.
//  답하는 쪽 절차는 style-rewrite-llm-dir-answerer.md 에 있다 — 디렉터리 구조를 바꾸면 그 문서도 같이 고쳐야 한다.
//
//  <dir>/pending/<id>.json   배치가 쓴 요청 {id, model, purpose, prompt} (tmp 에 쓰고 rename)
//  <dir>/claimed/<id>.json   답하는 쪽이 집어 간 요청(pending 에서 rename — 두 번 집지 않게)
//  <dir>/done/<id>.txt       답(LLM 출력 그대로) · <dir>/done/<id>.error = 답하는 쪽이 알린 실패 — 배치가 읽고 지운다
//  <dir>/batch.pid           배치 pid · <dir>/finished = 배치가 끝났다(답하는 쪽 루프 종료 신호)
//  요청·답에는 지식 문서 전문이 담긴다 — 디렉터리는 0700, 배치가 쓰는 파일은 0600 으로 두고 읽은 답은 남기지 않는다.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, rmSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";

export const LLM_DIR_POLL_MS = 1000;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** 요청 id — 파일명으로 안전해야 하고, 이어 하기로 같은 문서를 다시 돌려도 이전 실행의 늦은 답을 집지 않도록 실행 id 를 앞에 둔다. */
export function llmRequestId(runId, docName, seq, purpose) {
  const h = createHash("sha256").update(String(docName)).digest("hex").slice(0, 12);
  return `${runId}-${h}-${String(seq).padStart(3, "0")}-${String(purpose).replace(/[^a-z0-9_]/gi, "")}`;
}

export function initLlmDir(dir) {
  // mkdir 의 mode 는 새로 만들 때만 먹는다 — 앞 실행이나 사람이 느슨하게 만들어 둔 디렉터리도 chmod 로 조인다.
  for (const d of [dir, ...["pending", "claimed", "done"].map((x) => join(dir, x))]) {
    mkdirSync(d, { recursive: true, mode: DIR_MODE });
    chmodSync(d, DIR_MODE);
  }
  // 앞 실행이 남긴 종료 표시를 지우지 않으면 답하는 쪽이 시작하자마자 끝난 줄 안다.
  rmSync(join(dir, "finished"), { force: true });
  writeFileSync(join(dir, "batch.pid"), `${process.pid}\n`, { mode: FILE_MODE });
}

export function markLlmDirFinished(dir) {
  try { writeFileSync(join(dir, "finished"), `${new Date().toISOString()}\n`, { mode: FILE_MODE }); } catch { /* 종료 경로에서 죽지 않는다 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 요청 하나를 내놓고 답을 기다린다. 실패는 스폰 모드와 같은 오류 문구(llm_timeout · llm_exit …)로 던져
 *  배치의 재시도 판정(retryableLlm)과 연속 실패 중단이 그대로 먹게 한다.
 */
export async function llmDirExchange({ dir, id, model, purpose, prompt, timeoutMs, pollMs = LLM_DIR_POLL_MS }) {
  const pending = join(dir, "pending", `${id}.json`);
  const claimed = join(dir, "claimed", `${id}.json`);
  const doneTxt = join(dir, "done", `${id}.txt`);
  const doneErr = join(dir, "done", `${id}.error`);
  const tmp = join(dir, "pending", `.${id}.json.tmp`);
  writeFileSync(tmp, JSON.stringify({ id, model, purpose, prompt }), { mode: FILE_MODE });
  renameSync(tmp, pending);
  const cleanup = () => { rmSync(pending, { force: true }); rmSync(claimed, { force: true }); };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // 읽은 답은 바로 지운다 — 문서 전문(재작성본)이 교환 디렉터리에 쌓이지 않게.
    if (existsSync(doneTxt)) { const out = readFileSync(doneTxt, "utf8"); rmSync(doneTxt, { force: true }); cleanup(); return out; }
    if (existsSync(doneErr)) {
      const msg = readFileSync(doneErr, "utf8").trim().slice(0, 300);
      rmSync(doneErr, { force: true });
      cleanup();
      throw new Error(`llm_exit dir: ${msg}`);
    }
    if (Date.now() >= deadline) { cleanup(); throw new Error("llm_timeout"); }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}
