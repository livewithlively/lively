// antigravity(agy) stream-json → SessionEvent 번역기 (#2439). **순수** — 프로세스·IO 없음.
//
//  ── 근거 (실측, agy 1.1.22 · 2026-08-31) ────────────────────────────────────────
//  ⚠ **앞서 «이 하네스는 stream-json 이 안 된다» 고 적었던 것은 내 실수였다.** `agy` 는 Go 플래그라
//   `--print=<프롬프트>` 형태인데 `--print "<프롬프트>"` 로 불러서, 플래그가 프롬프트로 해석돼
//   모델이 «어떤 도구의 옵션인가요» 라고 되물었다. 하네스 탓이 아니라 호출 형식 탓이었다.
//   교훈: «안 된다» 를 적기 전에 **호출 형식부터 의심한다.**
//
//    agy --print="say OK" --output-format=stream-json
//    ← {"event":"init","conversation_id":…,"init":{"cwd","tools"[57],"permission_mode"}}
//    ← {"event":"step_update","step_update":{step_index,state:"ACTIVE"|"DONE",step_type,text_delta,…}}
//    ← {"event":"step_update","step_update":{…,"duration_seconds","usage":{input_tokens,output_tokens,…}}}
//    ← {"event":"result","result":{status:"SUCCESS","response","num_turns","usage"}}
//
//  ── 이 하네스의 «작업» ──────────────────────────────────────────────────────────
//  agy 에는 claude 의 task 나 codex 의 item 같은 1급 개념이 없고 **step** 이 있다.
//  `step_type` 이 `user_input`·`agent_response`·(툴 실행) 으로 갈리므로, **툴 실행 step 을 작업으로
//  옮긴다.** 다만 이번 실측 표본에 툴 실행이 없어(단순 응답 한 턴) `step_type` 의 실제 값들을 다 보진
//  못했다 — 그래서 아는 둘만 처리하고 나머지는 `raw` 로 관측한다(짐작으로 채우지 않는다).
//
//  ── 승인 ────────────────────────────────────────────────────────────────────────
//  init.tools 에 `ask_permission`·`ask_custom_permission`·`ask_question`·`list_permissions` 가 있다.
//  즉 **승인이 툴 호출로 표현된다** — 벤더가 headless control_request 를 안 주는 것과 별개로,
//  그 툴이 불리는 step 을 잡으면 화면이 카드를 그릴 수 있다. 그 step 의 실제 모양은 미실측이라
//  지금은 raw 로 흘린다(로그인한 세션이 한 번 돌면 형식이 드러난다).
import type { SessionEvent, SessionFacts, TaskInfo, UsageInfo } from "./session-event.js";

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function usageOf(v: unknown): UsageInfo | null {
  const u = rec(v);
  if (!u) return null;
  const out: UsageInfo = { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens) };
  return out.inputTokens === undefined && out.outputTokens === undefined ? null : out;
}

/** stream-json 한 줄 → 세션 이벤트. 대화 본문(text_delta)은 ChatLine 축이라 null. */
export function antigravityEvent(line: unknown): SessionEvent | null {
  const o = rec(line);
  if (!o) return null;
  const event = String(o.event ?? "");

  //  ── init — 이 세션이 무엇을 할 수 있나 ──
  if (event === "init") {
    const i = rec(o.init) ?? {};
    const facts: SessionFacts = { permissionMode: str(i.permission_mode) };
    //  ⚠ agy 의 tools 는 **57개**다(브라우저 조작 포함). 그대로 화면에 쏟으면 사람이 못 읽는다 —
    //   목록은 나르되 화면이 접어서 보여준다(여기서 자르면 «몇 개인지» 를 잃는다).
    if (Array.isArray(i.tools)) facts.skills = i.tools.map(String);
    return { t: "facts", facts };
  }

  //  ── step_update — 턴의 진행. 사용량이 실려 오면 그것만 올린다. ──
  if (event === "step_update") {
    const s = rec(o.step_update) ?? {};
    const u = usageOf(s.usage);
    if (u) return { t: "usage", usage: u };
    //  대화 본문(text_delta)은 ChatLine 축 — 여기서 다루지 않는다.
    const stepType = str(s.step_type);
    if (stepType === "user_input" || stepType === "agent_response") return null;

    //  ── 도구 실행 = 우리 어휘의 «작업» (실측 2026-09-01, agy 1.1.22) ──────────────
    //   {"event":"step_update","step_update":{step_index:2,state:"ACTIVE"|"DONE",step_type:"tool",
    //     tool_name:"run_command",tool_info:{name,parameters:{CommandLine:"echo …"},output:"…"}}}
    //   ⚠ id 는 **step_index** 다(툴 자체 id 가 없다). 한 대화 안에서 단조 증가하므로 짝이 맞는다 —
    //    그런데 대화가 바뀌면 0부터 다시 시작하므로 대화 id 를 앞에 붙인다(다른 턴의 행과 안 섞이게).
    //   ⚠ state 는 ACTIVE/DONE **둘뿐**이다 — 실패를 따로 안 준다. 그러니 실패를 지어내지 않는다.
    if (stepType === "tool") {
      const info = rec(s.tool_info) ?? {};
      const params = rec(info.parameters) ?? {};
      const idx = num(s.step_index);
      if (idx === undefined) return { t: "raw", source: "antigravity", payload: o };
      const id = `${str(s.conversation_id) ?? "c"}#${idx}`;
      const toolName = str(s.tool_name) ?? str(info.name) ?? "도구";
      //  제목은 «무엇을 하는가» 다 — 명령이면 명령줄, 아니면 도구 이름(사람이 읽고 판단할 수 있는 것).
      const cmd = str(params.CommandLine) ?? str(params.command) ?? str(params.TargetFile) ?? str(params.Query);
      const title = cmd ? (cmd.length > 120 ? cmd.slice(0, 117) + "…" : cmd) : toolName;
      const done = String(s.state ?? "").toUpperCase() === "DONE";
      //  ★3 — 하네스 낱말(run_command)이 아니라 **우리 낱말**로 종류를 정한다.
      const kind: TaskInfo["kind"] = /command|terminal|bash/i.test(toolName) ? "shell"
        : /subagent|agent/i.test(toolName) ? "agent" : "other";
      if (!done) return { t: "task.started", task: { id, kind, title, status: "running", startedAt: Date.now() } };
      const secs = num(s.duration_seconds);
      return { t: "task.updated", id, patch: {
        status: "completed", title, endedAt: Date.now(),
        ...(secs !== undefined ? { startedAt: Date.now() - Math.round(secs * 1000) } : {}),
        ...(str(info.output) ? { summary: String(info.output).slice(0, 300) } : {}),
      } };
    }

    //  ★ 그 밖의 step_type 은 **미실측**이다. 짐작해 작업으로 만들지 않고 관측한다.
    return { t: "raw", source: "antigravity", payload: o };
  }

  //  ── result — 턴 마감. 사용량이 여기 다시 온다. ──
  if (event === "result") {
    const r = rec(o.result) ?? {};
    const u = usageOf(r.usage);
    return u ? { t: "usage", usage: u } : null;
  }

  return event ? { t: "raw", source: "antigravity", payload: o } : null;
}

/**
 * `/help` 결과 → 슬래시 명령 목록 (#2439, 실측 2026-09-01).
 *
 *  ── 왜 이 길인가 ───────────────────────────────────────────────────────────────
 *  antigravity 의 `init` 은 cwd·tools·permission_mode 만 준다 — **명령 목록이 없다.**
 *  그런데 `--disable-slash-commands` 플래그가 있다는 건 print 모드에서 슬래시가 **동작한다**는 뜻이고,
 *  실제로 `agy --print=/help` 가 목록을 돌려준다(모델 호출 없이 즉답):
 *      "/agents\tList available custom agents\n/model\tSet a model\n…"
 *  그래서 한 번 물어 화면에 준다 — 자동완성의 재료다.
 *
 *  ⚠ 형식이 바뀌면 **빈 배열**을 준다(있는 척하지 않는다). 그러면 화면은 목록 없이 그대로 산다.
 */
export function antigravityCommandsFromHelp(text: string): Array<{ name: string; description?: string }> {
  const out: Array<{ name: string; description?: string }> = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("/")) continue;
    //  `\t` 로 갈린다. 이름에 괄호 별칭이 붙기도 한다: "/config (settings)".
    const [head, ...rest] = line.split("\t");
    const name = head.trim().replace(/^\//, "").split(/\s+/)[0];
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(name)) continue;
    const desc = rest.join(" ").trim();
    out.push({ name, description: desc || undefined });
  }
  return out;
}
