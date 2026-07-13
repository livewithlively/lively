// per-member 브로커 서버(#746 T4) — unix 도메인 소켓 위 최소 HTTP. 접근통제는 소켓 파일 권한으로:
//  소켓은 브로커 uid 소유 + lively 그룹(0660) → 게이트웨이(lively)만 연결, 멤버 대화 uid(box_<member>)는 접근 불가.
//  → 자격을 쥔 브로커 프로세스를 멤버가 변조/열람 못 함(전용 uid + 소켓 권한 이중).
import http from "node:http";
import { runExec, type ExecRequest, type ExecPolicy, type ExecResult } from "./exec.js";

export interface BrokerConfig extends ExecPolicy { member: string }

// 요청 1건 처리 — op 디스패치. exec/ping 만(MVP). 자격/env 는 응답에 절대 안 실림(runExec 가 보장).
async function handle(body: unknown, cfg: BrokerConfig): Promise<{ status: number; payload: unknown }> {
  const req = (body ?? {}) as Record<string, unknown>;
  if (req.op === "ping") return { status: 200, payload: { ok: true, member: cfg.member } };
  if (req.op === "exec") {
    const res: ExecResult = await runExec(req as unknown as ExecRequest, cfg);
    return { status: 200, payload: res }; // exec 실패(비정상 종료)도 200 + ok:false (전송계층 성공)
  }
  return { status: 400, payload: { ok: false, error: `알 수 없는 op: ${String(req.op)}` } };
}

// 소켓 위 HTTP 서버 생성. 호출자가 listen(socketPath). 본문 상한으로 남용 차단.
export function createBrokerServer(cfg: BrokerConfig, maxBody = 256 * 1024): http.Server {
  return http.createServer((httpReq, httpRes) => {
    if (httpReq.method !== "POST") { httpRes.writeHead(405).end(); return; }
    const chunks: Buffer[] = [];
    let len = 0, aborted = false;
    httpReq.on("data", (c: Buffer) => {
      if (aborted) return;
      len += c.length;
      if (len > maxBody) { aborted = true; httpRes.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "요청 본문 초과" })); httpReq.destroy(); return; }
      chunks.push(c);
    });
    httpReq.on("end", async () => {
      if (aborted) return;
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
      catch { httpRes.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "JSON 파싱 실패" })); return; }
      try {
        const { status, payload } = await handle(body, cfg);
        httpRes.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
      } catch (e) {
        httpRes.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: (e as Error).message }));
      }
    });
    httpReq.on("error", () => { if (!httpRes.headersSent) httpRes.writeHead(400).end(); });
  });
}
