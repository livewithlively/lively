// 하네스 자산 저장 시점 위험 패턴 검사 — DB 없이 도는 순수 규칙.
//  조직 자산 본문은 구성원 컴퓨터에 파일로 깔리고, 스킬은 그 컴퓨터에서 셸을 돌릴 수 있다. 사후 정적 감사로는
//  이미 배포된 뒤에 안다 → 저장하는 순간에 막는 겹이다. 규칙은 **오탐이 거의 없는 것만** 둔다 — 넓은 규칙은
//  관리자가 매번 risk_ack 로 넘기게 되고, 그러면 우회가 습관이 돼 차단이 무의미해진다.
//  넣지 않은 것: U+200B(zero-width space)는 Slack mrkdwn 볼드 경계용으로 정상 자산에 쓰인다. compose·k8s 표기
//  (`privileged: true`·`cap_add:`)는 CLI 플래그만 본다는 범위 결정으로 뺐다 — 넣으려면 YAML 문맥을 읽어야 한다.
//  부속 파일이 따로 배포되게 되면 파일마다 scanHarnessAssetRisks 를 그대로 재사용한다(필드 이름 자리에 파일 경로).
import { HttpError } from "../http-error.js";

export type HarnessAssetRiskRule =
  | "docker-privileged" | "seccomp-unconfined" | "dangerous-cap-add" | "remote-script-pipe" | "bidi-control";

export interface HarnessAssetRiskFinding {
  rule: HarnessAssetRiskRule;
  field: string;
  /** 1부터. 한 줄짜리 필드(frontmatter JSON 등)도 1. */
  line: number;
  /** 사람이 읽는 한 줄 — 무엇이 왜 위험한가. 원문 조각은 담지 않는다(제어 문자를 메시지·감사로 옮기지 않게). */
  label: string;
}

const PRIVILEGED = /(?<![\w-])--privileged(?![\w-])/;
const SECCOMP_UNCONFINED = /seccomp\s*[=:]\s*unconfined/i;
const DANGEROUS_CAP_ADD = /(?<![\w-])--cap-add(?:\s*=\s*|\s+)(?:CAP_)?(?:SYS_ADMIN|SYS_PTRACE|ALL)(?![\w])/i;
// curl·wget 이 든 파이프 칸 바로 다음 칸이 셸로 시작한다. 사이에 다른 칸이 끼면(`| jq | sh`) 잡지 않는다.
//  `sh\b` 라 `| shasum` 은 안 걸린다. 한 정규식(`curl[^|]*\|\s*sh`)으로 쓰면 curl 시작점마다 줄 끝까지 훑어
//  2차 시간이 된다(본문 상한 262144자 한 줄에 수 초 동기 정지) — 그래서 `|` 로 칸을 나눠 칸마다 한 번씩 본다.
const FETCHER = /\b(?:curl|wget)\b/;
const SHELL_HEAD = /^\s*(?:sudo\s+(?:-\S+\s+)*)?(?:ba|z|da|k)?sh\b/;
const SHELL_PROCESS_SUBST = /\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b/;
const SHELL_C_SUBST = /\b(?:ba|z)?sh\s+-c\s+["']?\$\(\s*(?:curl|wget)\b/;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/;

const LABELS: Record<HarnessAssetRiskRule, string> = {
  "docker-privileged": "컨테이너 --privileged(호스트 장치·권한 전부를 넘긴다)",
  "seccomp-unconfined": "seccomp 해제(unconfined — 시스템 호출 제한을 끈다)",
  "dangerous-cap-add": "위험 capability 추가(SYS_ADMIN·SYS_PTRACE·ALL — 컨테이너 밖으로 나갈 수 있다)",
  "remote-script-pipe": "내려받은 스크립트를 셸에 바로 넣는다(curl·wget → sh·bash — 받은 내용을 검토 없이 실행)",
  "bidi-control": "양방향 제어 문자(화면에 보이는 순서와 실제 순서가 달라진다)",
};

// Markdown 표 행(`| a | b |`)은 칸 구분자가 `|` 라 «curl 칸 | sh 칸» 이 파이프처럼 읽힌다. 표 행에서는
//  인라인 코드(`…`) 안만 명령으로 보고, 그 안의 `\|`(표 안 파이프 이스케이프)를 파이프로 되돌린다.
function commandTextsOfLine(line: string, table: boolean): string[] {
  if (!table) return [line];
  const t = line.trim();
  const spans: string[] = [];
  for (const m of t.matchAll(/`([^`]+)`/g)) spans.push(m[1].replace(/\\\|/g, "|"));
  return spans;
}

function pipesFetchIntoShell(cmd: string): boolean {
  const cells = cmd.split("|");
  for (let i = 0; i + 1 < cells.length; i++) if (FETCHER.test(cells[i]) && SHELL_HEAD.test(cells[i + 1])) return true;
  return false;
}

function isRemoteScriptPipe(line: string, table: boolean): boolean {
  return commandTextsOfLine(line, table).some((s) => pipesFetchIntoShell(s) || SHELL_PROCESS_SUBST.test(s) || SHELL_C_SUBST.test(s));
}

// 설치 안내는 `curl … \` + 다음 줄 `| bash`, 또는 `curl … |` + 다음 줄 `sh` 로 흔히 줄을 나눈다. 파이프 규칙만
//  이어진 줄을 한 명령으로 합쳐 보고 위치는 첫 줄로 낸다. 표 행은 양쪽 경계다 — 앞 줄이 `\`(Markdown 하드 줄바꿈)로
//  끝나도 표 행을 빨아들이지 않고, 표 행 끝의 `|` 로 다음 줄을 잇지도 않는다(칸 구분자가 파이프로 읽히지 않게).
const isTableRow = (line: string): boolean => { const t = line.trim(); return t.length > 1 && t.startsWith("|") && t.endsWith("|"); };

// 표 행 여부는 물리 줄에서 정해 넘긴다 — 이어 붙인 텍스트가 우연히 `|…|` 꼴이 돼도 표로 다시 판정하지 않게.
function joinedCommandLines(lines: string[]): Array<{ text: string; line: number; table: boolean }> {
  const out: Array<{ text: string; line: number; table: boolean }> = [];
  let buf = "", start = 0, joining = false;
  const flush = () => { if (joining) out.push({ text: buf, line: start, table: false }); buf = ""; joining = false; };
  lines.forEach((raw, i) => {
    if (isTableRow(raw)) { flush(); out.push({ text: raw, line: i + 1, table: true }); return; }
    if (!joining) { start = i + 1; joining = true; }
    const t = raw.trimEnd();
    const backslash = t.endsWith("\\");
    buf += (buf ? " " : "") + (backslash ? t.slice(0, -1) : t);
    if (!(backslash || t.endsWith("|"))) flush();
  });
  flush();
  return out;
}

function rulesOfLine(line: string): HarnessAssetRiskRule[] {
  const hits: HarnessAssetRiskRule[] = [];
  if (PRIVILEGED.test(line)) hits.push("docker-privileged");
  if (SECCOMP_UNCONFINED.test(line)) hits.push("seccomp-unconfined");
  if (DANGEROUS_CAP_ADD.test(line)) hits.push("dangerous-cap-add");
  if (BIDI.test(line)) hits.push("bidi-control");
  return hits;
}

/** 필드마다 줄 단위로 검사한다. text 가 undefined 인 필드(부분수정에서 안 보낸 칸)는 건너뛴다. */
export function scanHarnessAssetRisks(fields: ReadonlyArray<{ field: string; text: string | undefined }>): HarnessAssetRiskFinding[] {
  const out: HarnessAssetRiskFinding[] = [];
  for (const { field, text } of fields) {
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const rule of rulesOfLine(line)) out.push({ rule, field, line: i + 1, label: LABELS[rule] });
    });
    for (const j of joinedCommandLines(lines)) {
      if (isRemoteScriptPipe(j.text, j.table)) out.push({ rule: "remote-script-pipe", field, line: j.line, label: LABELS["remote-script-pipe"] });
    }
  }
  return out;
}

export const RISK_ACK_MAX = 500;

/** risk_ack 입력 검증 — 미전송·빈 문자열 = 없음. 사유 없는 우회를 막으려고 공백만인 값도 없음으로 본다. */
export function parseRiskAck(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HttpError(400, "risk_ack 는 문자열(이 패턴이 문제없는 이유)이어야 합니다");
  const s = v.trim();
  if (!s) return undefined;
  if (s.length > RISK_ACK_MAX) throw new HttpError(400, `risk_ack 는 ${RISK_ACK_MAX}자 이하로 적어 주세요`);
  return s;
}

export type HarnessAssetRiskDecision =
  | { action: "save"; findings: HarnessAssetRiskFinding[]; acked: boolean }
  | { action: "block"; findings: HarnessAssetRiskFinding[]; message: string };

const MESSAGE_LIST_MAX = 10;

/**
 * enforce = 조직이 차단을 켰나. 꺼져 있으면 찾은 것을 경고로만 돌려준다(켜기 전에 오탐을 볼 수 있게).
 * 켜져 있으면 risk_ack 가 있어야 저장한다 — acked:true 는 호출자가 감사에 남겨야 한다는 뜻이다.
 */
export function decideHarnessAssetRisk(input: {
  enforce: boolean; findings: HarnessAssetRiskFinding[]; riskAck: string | undefined;
}): HarnessAssetRiskDecision {
  const { enforce, findings, riskAck } = input;
  if (findings.length === 0) return { action: "save", findings, acked: false };
  if (!enforce) return { action: "save", findings, acked: false };
  if (riskAck) return { action: "save", findings, acked: true };
  const shown = findings.slice(0, MESSAGE_LIST_MAX).map((f) => ` · ${f.field} ${f.line}행: ${f.label}`);
  const more = findings.length > MESSAGE_LIST_MAX ? [` · 외 ${findings.length - MESSAGE_LIST_MAX}건`] : [];
  const message = [
    "저장하지 않았습니다 — 구성원 컴퓨터에서 실행될 수 있는 위험 패턴이 있습니다.",
    ...shown, ...more,
    "해당 줄을 고치거나 빼고 다시 저장하세요. 「이 옵션을 쓰지 마라」 같은 경고 문장 안에서 이름만 언급한 경우라면, " +
      "risk_ack 에 문제없는 이유를 적어 다시 저장하면 저장되고 그 사유가 감사 기록에 남습니다.",
  ].join("\n");
  return { action: "block", findings, message };
}
