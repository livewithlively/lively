// 세션 이름을 **AI 가 짓는다** (#1719 원준 2026-08-20: "질문 내용 보고 세션 이름 생성해서 10자 언더로").
//
// 왜 규칙만으로는 부족한가 — 규칙 이름(session-name.ts)은 첫 지시의 앞 28자다. 사람이 실제로 치는 첫 지시는
//  문장이라 그 28자가 주어와 조사로 채워진다: "한 프로젝트 내에서 +세션을 통해서 새 세션을 여는 과정…" 처럼.
//  목록·탭에서 세션을 구분해 주는 건 그 문장의 **핵심 명사구**("새 세션 컴포저")이고, 그건 잘라내기로는 못 얻는다.
//
// 어떻게 — 이 박스에 이미 깔려 있는 **하네스 CLI 를 한 번**(-p, 한 문장) 부른다.
//  · 서버에 LLM API 키를 두지 않는다 — 조직 금고에 그런 키가 없고(org_credentials 실측 2026-08-20), 키를 새로
//    받아 두면 그때부터 그 키가 이름 짓기의 전제가 된다. 세션을 띄우는 그 CLI 를 그대로 쓰면 자격도 그 멤버 것이다.
//  · 그래서 **실패가 정상 경로에 있다** — CLI 가 없거나 로그인 전이거나 느리면 빈 문자열을 돌려주고, 이름은
//    규칙 이름 그대로 남는다. 이 모듈은 이미 붙어 있는 이름을 **덮어 개선**할 뿐이라 없어도 화면은 성립한다.
//  · 끄기: LIVELY_AI_SESSION_NAME=0 (그 박스는 규칙 이름만 쓴다).
import { spawn } from "node:child_process";
import os from "node:os";

/** 이름 길이 상한 — "10자 언더"(원준). 모델이 넘겨 주면 여기서 자른다(…는 안 붙인다 — 짧은 게 목적이다). */
const MAX = 12;
const TIMEOUT_MS = 40000;

export function aiNamingEnabled(): boolean {
  return process.env.LIVELY_AI_SESSION_NAME !== "0";
}

const PROMPT = (text: string): string =>
  "다음은 사람이 AI 세션에 처음 시킨 말이다. 이 세션의 이름을 지어라.\n" +
  "규칙: 한국어 명사구 한 줄 · 공백 포함 10자 이내 · 조사·서술어·따옴표·마침표 없이 · 설명 말고 이름만 출력.\n\n" +
  "시킨 말: " + String(text || "").replace(/\s+/g, " ").slice(0, 600);

/** CLI 출력에서 이름 한 줄만 건져낸다 — 모델이 앞뒤에 군말을 붙여도 첫 줄의 이름만 남는다. */
export function cleanAiName(out: string): string {
  const first = String(out || "").split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
  // 끝은 **한 번에** 벗긴다 — 따옴표와 마침표가 섞여 있어(`"결제 백오프".`) 순서대로 지우면 하나가 남는다.
  const bare = first.replace(/^[\s"'「『([]+/, "").replace(/[\s"'」』)\].。!?？…]+$/, "").trim();
  if (!bare || bare.length > 40) return "";   // 이름이 아니라 문장을 통째로 뱉었다 — 그러면 규칙 이름이 낫다
  return bare.length > MAX ? bare.slice(0, MAX) : bare;
}

/**
 * 첫 지시 → AI 가 지은 짧은 이름. 못 지으면 "" (호출자는 규칙 이름을 그대로 둔다).
 *  bin — 부를 CLI(기본 claude). configDir — 그 멤버의 CLAUDE_CONFIG_DIR(자격이 거기 있다).
 *  cwd 는 임시 폴더다: 프로젝트 폴더에서 부르면 그 폴더의 CLAUDE.md·훅이 딸려 와 느려지고 이름과 무관한 맥락이 섞인다.
 */
export function aiSessionName(text: string, opts?: { bin?: string; configDir?: string | null }): Promise<string> {
  const bin = opts?.bin || process.env.LIVELY_AI_SESSION_NAME_BIN || "claude";
  const model = process.env.LIVELY_AI_SESSION_NAME_MODEL || "haiku";
  return new Promise<string>((resolve) => {
    let done = false;
    const finish = (v: string): void => { if (!done) { done = true; resolve(v); } };
    try {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (opts?.configDir) env.CLAUDE_CONFIG_DIR = opts.configDir;
      const p = spawn(bin, ["-p", "--model", model, PROMPT(text)], { cwd: os.tmpdir(), env, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      p.stdout.on("data", (c: Buffer) => { out += c.toString("utf8"); if (out.length > 4000) p.kill("SIGKILL"); });
      const t = setTimeout(() => { p.kill("SIGKILL"); finish(""); }, TIMEOUT_MS);
      p.on("error", () => { clearTimeout(t); finish(""); });         // CLI 가 없다 — 규칙 이름으로 산다
      p.on("close", (code) => { clearTimeout(t); finish(code === 0 ? cleanAiName(out) : ""); });
    } catch { finish(""); }
  });
}
