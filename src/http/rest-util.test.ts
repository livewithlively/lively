// wrap 의 오류 매핑 — 공유 저장소 연결 끊김(ENOTCONN)을 사람 말로 (#2548).
//
// 실측(2026-09-02, 매니지드): 호스트 JuiceFS 재마운트 뒤 테넌트 판 컨테이너의 /work/shared 가 «Transport endpoint is
//  not connected». 세션 복원의 mkdir 이 그 메시지로 실패했는데 wrap 이 500 «internal_error» 로 뭉개, 사용자도 운영자도
//  원인을 몰랐다. #813 의 디스크 부족 매핑과 같은 자리·같은 규율 — 원인이 명확한 오류는 그대로 말하고 무엇을 할지 알려 준다.
//
// 사양·엣지: E1 메시지에 «Transport endpoint is not connected» → 503 + «공유 저장소» 문구 / E2 errno ENOTCONN → 503
//           / E3 무관한 오류 → 종전 500 internal_error / E4 HttpError 는 그대로(매핑이 가로채지 않는다)
import test from "node:test";
import assert from "node:assert/strict";
import { wrap, HttpError } from "./rest-util.js";

function fake(): { req: any; res: any; out: { status: number; body: any } } {
  const out = { status: 0, body: null as any };
  const res = {
    headersSent: false,
    status(c: number) { out.status = c; return this; },
    json(b: unknown) { out.body = b; return this; },
  };
  return { req: { path: "/api/ui/terminal/sessions/x/restore" }, res, out };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test("E1 «Transport endpoint is not connected» → 503 + 공유 저장소 문구", async () => {
  const { req, res, out } = fake();
  wrap(async () => { throw new Error("mkdir: cannot create directory '/work/shared': Transport endpoint is not connected"); })(req, res, () => {});
  await tick();
  assert.equal(out.status, 503, "🔴 ENOTCONN 이 500 internal_error 로 뭉개진다 — 사용자가 원인을 알 길이 없다");
  assert.match(String(out.body?.error), /공유 저장소/);
});

test("E2 errno ENOTCONN → 503", async () => {
  const { req, res, out } = fake();
  const e = Object.assign(new Error("connect failed"), { code: "ENOTCONN" });
  wrap(async () => { throw e; })(req, res, () => {});
  await tick();
  assert.equal(out.status, 503);
});

test("E3 무관한 오류는 종전대로 500 internal_error", async () => {
  const { req, res, out } = fake();
  wrap(async () => { throw new Error("boom"); })(req, res, () => {});
  await tick();
  assert.equal(out.status, 500);
  assert.equal(out.body?.error, "internal_error");
});

test("E4 HttpError 는 매핑이 가로채지 않는다", async () => {
  const { req, res, out } = fake();
  wrap(async () => { throw new HttpError(404, "세션 없음"); })(req, res, () => {});
  await tick();
  assert.equal(out.status, 404);
  assert.equal(out.body?.error, "세션 없음");
});
