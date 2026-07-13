// 게이트웨이-측 브로커 클라이언트(#746 T4) — 멤버 브로커의 unix 소켓으로 요청 포워딩. 게이트웨이 라우팅이 사용.
//  소켓 접근은 파일 권한(lively 그룹)으로 제한됨 — 게이트웨이(lively)만 연결 가능.
import http from "node:http";

export interface BrokerResponse { ok: boolean; stdout?: string; stderr?: string; code?: number | null; error?: string; [k: string]: unknown }

export function brokerCall(socketPath: string, req: unknown, timeoutMs = 65000): Promise<BrokerResponse> {
  return new Promise<BrokerResponse>((resolve, reject) => {
    const body = JSON.stringify(req ?? {});
    const r = http.request(
      { socketPath, path: "/", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
          catch { reject(new Error("broker 응답 파싱 실패")); }
        });
      },
    );
    r.on("error", (e) => reject(new Error(`broker 연결 실패: ${e.message}`)));
    r.on("timeout", () => r.destroy(new Error("broker 요청 타임아웃")));
    r.write(body);
    r.end();
  });
}
