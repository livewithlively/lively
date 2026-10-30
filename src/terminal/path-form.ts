// 경로 이름 꼴(#4847) — 파일 시스템이 담을 수 없는 이름을 **공개범위 판정보다 먼저** 거른다. 순수(파일 시스템 · DB 무접근).
//
// 왜 판정 앞인가: 이름 꼴은 볼 수 있는지와 상관없이 같은 답이어야 한다. 판정 뒤의 링크 해소(path-jail)는 판정을 지난 자리에서만
//  돌므로 이 검사를 거기 맡기지 않는다. 여기서 거르는 것은 «이 파일 시스템에 그런 이름은 있을 수 없다» 와 «웹에서 다루지 않는 글자»
//  뿐이다 — 볼 수 있는 자리의 실제 상태(파일 아래 경로 · 링크)에서 오는 실패는 판정 뒤의 몫이다(terminal-files resolveBrowse).
//
// 거르는 것:
//  · 제어 문자(U+0000~U+001F · U+007F) — NUL 은 어떤 파일 시스템에도 없는 이름이고(노드 fs · 자식 프로세스 인자가 거부한다),
//    나머지는 주소(files/address parseAddress)가 받지 않는 글자라 홈 탐색기도 같게 받지 않는다 — 웹은 그런 이름을 만들거나 열지 않는다.
//    단 이미 있는 이름을 지우거나 이름을 바꿀 때는 NUL 만 거른다(셸이 만든 이름을 웹에서 치우거나 고칠 수 있게 — opts.existing).
//  · 한 이름(`/` 사이 한 칸)이 상한을 넘음 · 경로 전체가 상한을 넘음 — 상한은 이 서버가 파일 작업을 하는 파일 시스템의 것이다:
//      리눅스(ext4 · JuiceFS — 매니지드 · CI): 한 이름 255바이트(UTF-8) · 경로 전체 4095바이트(PATH_MAX 4096 은 끝 NUL 포함)
//      맥(APFS — 셀프호스트):                 한 이름 255 UTF-16 단위(실측 — 한글 255자는 되고 이모지 128개는 안 된다) · 경로 전체 1023바이트
//    역슬래시는 리눅스 · 맥에서 이름 안의 글자라 이름의 길이는 `/` 사이로 잰다.
//  경로 전체 길이는 받은 그대로 잰다 — 해소하며 접두가 길어지는 몫(맥 `/tmp` → `/private/tmp`)은 판정 뒤 해소가 «있을 수 없는 이름» 으로
//   돌려주고, 부르는 쪽이 그것을 없는 자리와 같은 답으로 다룬다(path-jail probeSaysAbsent).

export interface PathFormLimits {
  /** 한 이름의 상한 */
  nameMax: number;
  /** 한 이름을 재는 단위 — 리눅스는 바이트, 맥(APFS)은 UTF-16 단위 */
  nameUnit: "utf8" | "utf16";
  /** 경로 전체(절대경로)의 바이트 상한 */
  pathMax: number;
}

/** 이 서버의 파일 시스템 상한. 맥만 다르다 — 그 밖(리눅스 등)은 리눅스 상한. */
export function pathFormLimits(platform: NodeJS.Platform = process.platform): PathFormLimits {
  return platform === "darwin"
    ? { nameMax: 255, nameUnit: "utf16", pathMax: 1023 }
    : { nameMax: 255, nameUnit: "utf8", pathMax: 4095 };
}

export type PathFormProblem = "control" | "name" | "path";

// eslint-disable-next-line no-control-regex -- 제어 문자를 **거르려고** 쓴다
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * 이 경로의 이름 꼴이 틀렸나 — 틀렸으면 까닭, 아니면 null.
 *  rel = 자리 기준 상대경로(`/` 구분, 글자로 접은 뒤) · abs = 실제로 여는 절대경로.
 *  existing — 이미 있는 이름을 지우거나 이름을 바꾸는 자리(셸이 만든 `Icon\r` 같은 이름을 웹에서 치울 수 있게): 제어 문자 가운데
 *   NUL 만 거른다(어떤 파일 시스템에도 없는 이름이다). 길이 상한은 그대로다.
 */
export function pathFormProblem(rel: string, abs: string, limits: PathFormLimits = pathFormLimits(), opts: { existing?: boolean } = {}): PathFormProblem | null {
  if (opts.existing ? rel.includes("\u0000") : CONTROL_RE.test(rel)) return "control";
  for (const name of rel.split("/")) {
    const n = limits.nameUnit === "utf8" ? Buffer.byteLength(name, "utf8") : name.length;
    if (n > limits.nameMax) return "name";
  }
  if (Buffer.byteLength(abs, "utf8") > limits.pathMax) return "path";
  return null;
}

/** 이름 하나(새 이름)의 꼴 — 경로 구분자 판정은 부르는 쪽이 이미 했다는 전제다. */
export function nameFormProblem(name: string, limits: PathFormLimits = pathFormLimits()): PathFormProblem | null {
  return pathFormProblem(name, "", limits);
}

/** 사람(과 AI)에게 보일 문장 — 까닭과 상한만 말한다(요청한 경로를 되풀이하지 않는다). */
export function pathFormMessage(problem: PathFormProblem, limits: PathFormLimits = pathFormLimits()): string {
  if (problem === "control") return "이름에 쓸 수 없는 글자(제어 문자)가 들어 있습니다";
  if (problem === "name") {
    return limits.nameUnit === "utf8"
      ? `이름이 너무 깁니다 — 한 이름은 ${limits.nameMax}바이트까지입니다(한글은 한 글자에 3바이트)`
      : `이름이 너무 깁니다 — 한 이름은 ${limits.nameMax}자까지입니다`;
  }
  return `경로가 너무 깁니다 — 경로 전체는 ${limits.pathMax}바이트까지입니다`;
}

/** 응답 몸의 code — 화면이 까닭을 문구가 아니라 이 값으로 가른다. */
export const PATH_FORM_CODE = "path_name_invalid";
