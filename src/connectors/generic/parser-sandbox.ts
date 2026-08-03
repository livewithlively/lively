// 커스텀 파서 격리 실행(#1419 T2) — 관리자가 화면에 쓴 변환 스크립트를 **별도 프로세스**에서 돌린다.
//
//  왜 이게 필요한가: 매핑 표(mapping.ts FieldMap)는 '값 하나를 집는' 것까지만 한다. 실제 사내 API 에는
//   그걸로 안 되는 게 흔하다 — 한 응답 안에 종류가 섞여 있어 갈라야 하거나, 본문이 조각으로 흩어져 있어
//   합쳐야 하거나, 코드값을 사람 말로 바꿔야 한다. 그 탈출구가 파서다.
//
// ════════ 보안 경계 — 무엇을 막고 무엇을 못 막나 (정직하게) ════════
//  실행은 `node --permission` 자식 프로세스다. Node 권한 모델이 **막아 주는 것**:
//    · 파일시스템 읽기·쓰기 전부(--allow-fs-* 를 하나도 주지 않는다)
//    · child_process(다른 프로그램 실행) · worker_threads · 네이티브 애드온 · inspector
//  그리고 우리가 더 얹는 것:
//    · 입력은 stdin JSON, 출력은 stdout JSON — 부모의 객체를 넘기지 않는다(프로토타입 체인 탈출 경로 차단)
//    · 하드 타임아웃(무한루프 차단) · 출력 크기 캡 · 환경변수 미상속(시크릿·토큰이 자식에 안 감)
//
//  ⚠ **막지 못하는 것: 네트워크.** Node 권한 모델에는 네트워크 게이트가 없다(fs·child_process·worker·
//   addon·inspector 만 gate 한다). 즉 파서 스크립트는 마음만 먹으면 받은 데이터를 밖으로 보낼 수 있다.
//   이걸 감수하는 근거: 파서를 쓸 수 있는 사람은 **admin scope 보유자**뿐이고(capabilities restOnly),
//   이 조직은 이미 같은 급의 권한을 여러 곳에 준다 — org_hook(커스텀 훅)은 아예 **구성원 컴퓨터에서**
//   임의 코드를 돌리고, org_tool 은 사내 API 를 호출한다. 파서는 그보다 좁다(격리 프로세스·fs 차단·무환경변수).
//   그래도 '관리자가 쓴 코드가 도는 자리'라는 사실은 화면에 명시해야 한다(UI 경고 문구 — T6).
//
//  ⚠ 두 번째 한계: 권한 모델은 Node 20 에서 `--experimental-permission`, 22+ 에서 `--permission` 이다.
//   플래그가 안 먹는 런타임이면 **파서를 아예 실행하지 않는다**(경계 없이 도는 것보다 기능을 끄는 편이 옳다).
import { spawn } from "node:child_process";
import { logger } from "../../log.js";

/** 파서 1회 실행 한도 — 무한루프·폭주 출력 백스톱. */
const PARSER_TIMEOUT_MS = 10_000;
const PARSER_OUTPUT_CAP = 8 * 1024 * 1024; // 8MB — 한 배치 변환 결과로 충분하고, 메모리 폭주는 막는다

/** 권한 플래그 판정 1회 캐시 — 매 실행마다 node -e 를 띄우지 않게. */
let _permFlag: Promise<string | null> | null = null;

/**
 * 이 런타임이 쓰는 권한 플래그를 고른다. 둘 다 안 되면 null → 파서 실행 거부.
 *  판정은 '플래그를 준 노드가 실제로 뜨는가'로 한다(버전 문자열 추정보다 확실하다).
 */
function permissionFlag(): Promise<string | null> {
  if (_permFlag) return _permFlag;
  _permFlag = (async () => {
    for (const flag of ["--permission", "--experimental-permission"]) {
      const ok = await new Promise<boolean>((resolve) => {
        const c = spawn(process.execPath, [flag, "--no-warnings", "-e", "process.exit(0)"],
          { stdio: "ignore", env: {} });
        c.on("error", () => resolve(false));
        c.on("close", (code) => resolve(code === 0));
      });
      if (ok) return flag;
    }
    return null;
  })();
  return _permFlag;
}

export interface ParserRunResult {
  ok: boolean;
  /** 파서가 돌려준 항목들(항상 배열 — 스칼라/객체 하나를 돌려줘도 감싼다). */
  items: unknown[];
  error?: string;
  /** 파서가 console.log 로 남긴 것 — 화면 '미리보기'에서 디버깅에 쓴다. */
  logs?: string[];
}

/**
 * 커스텀 파서 실행 — `parse(input)` 를 정의한 스크립트에 입력을 먹이고 항목 배열을 받는다.
 *
 *  스크립트가 보는 것: 전역 `input`(부모가 준 JSON). 돌려주는 법: `parse` 함수를 정의하거나,
 *   마지막 식으로 값을 남긴다. 둘 다 지원해 '한 줄짜리 변환'도 되게 한다.
 *  스크립트가 못 보는 것: require·import·process.env·파일·자식 프로세스(권한 모델 + 미주입).
 */
export async function runCustomParser(script: string, input: unknown): Promise<ParserRunResult> {
  const flag = await permissionFlag();
  if (!flag) {
    // 경계를 세울 수 없으면 실행하지 않는다 — '그냥 돌리기'는 선택지가 아니다.
    return { ok: false, items: [], error: "이 런타임에서 파서 격리(--permission)를 쓸 수 없어 실행을 거부했습니다. Node 20+ 가 필요합니다." };
  }

  // 러너 — 자식 프로세스가 실행할 껍데기. 스크립트를 함수 본문으로 감싸 전역 오염을 줄이고,
  //  결과를 한 줄 JSON 으로 stdout 에 뱉는다(부모는 그 한 줄만 신뢰한다).
  const runner = `
    let __chunks = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { __chunks += d; });
    process.stdin.on("end", () => {
      const __logs = [];
      const __origLog = console.log;
      console.log = (...a) => { if (__logs.length < 200) __logs.push(a.map(String).join(" ")); };
      try {
        const { script, input } = JSON.parse(__chunks);
        const fn = new Function("input", "console", script + "\\n;return (typeof parse === 'function') ? parse(input) : (typeof __result !== 'undefined' ? __result : undefined);");
        let out = fn(input, { log: console.log, warn: console.log, error: console.log });
        if (out === undefined || out === null) out = [];
        if (!Array.isArray(out)) out = [out];
        __origLog(JSON.stringify({ ok: true, items: out, logs: __logs }));
      } catch (e) {
        __origLog(JSON.stringify({ ok: false, items: [], error: String((e && e.message) || e), logs: __logs }));
      }
    });
  `;

  return await new Promise<ParserRunResult>((resolve) => {
    const child = spawn(process.execPath, [flag, "--no-warnings", "-e", runner], {
      stdio: ["pipe", "pipe", "pipe"],
      // 환경변수 미상속 — 자식이 토큰·DB URL 을 볼 수 없다(파서에 필요하지도 않다).
      env: {},
    });
    let out = "", err = "", capped = false;
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* 이미 종료 */ }
      resolve({ ok: false, items: [], error: `파서가 ${PARSER_TIMEOUT_MS / 1000}초 안에 끝나지 않아 중단했습니다(무한 루프 확인).` });
    }, PARSER_TIMEOUT_MS);

    child.stdout.on("data", (d: Buffer) => {
      if (out.length > PARSER_OUTPUT_CAP) { capped = true; try { child.kill("SIGKILL"); } catch { /* */ } return; }
      out += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => { if (err.length < 8192) err += d.toString("utf8"); });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, items: [], error: `파서 프로세스를 띄우지 못했습니다: ${e.message}` });
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (capped) { resolve({ ok: false, items: [], error: "파서 출력이 상한(8MB)을 넘어 중단했습니다." }); return; }
      const line = out.trim().split("\n").filter(Boolean).pop() ?? "";
      if (!line) {
        resolve({ ok: false, items: [], error: `파서가 결과를 돌려주지 않았습니다${err ? ` — ${err.trim().slice(0, 500)}` : ""}` });
        return;
      }
      try {
        const parsed = JSON.parse(line) as ParserRunResult;
        resolve({ ok: Boolean(parsed.ok), items: Array.isArray(parsed.items) ? parsed.items : [], error: parsed.error, logs: parsed.logs });
      } catch {
        logger.warn({ tail: line.slice(0, 200) }, "커스텀 파서 출력 파싱 실패");
        resolve({ ok: false, items: [], error: "파서 출력을 읽을 수 없습니다(JSON 이 아님)." });
      }
    });

    child.stdin.end(JSON.stringify({ script, input }));
  });
}
