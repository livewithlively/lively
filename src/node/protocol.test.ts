// 노드 프로토콜(#869) 단위 테스트 — 채널 프레임 인코딩/디코딩 왕복 + 제어 파싱 + 가시성 판정.
import { strict as assert } from "node:assert";
import { encodeChanFrame, decodeChanFrame, parseMsg, nodeSessionVisible, FRAME_PTY } from "./protocol.js";

// 프레임 왕복 — 멀티바이트(UTF-8 쪼개짐 경계 포함)도 바이트 그대로 보존돼야 한다(무디코드 릴레이 불변식).
{
  const payload = Buffer.concat([Buffer.from("한글𝔘"), Buffer.from([0x00, 0xff, 0x1b]), Buffer.from("e")]);
  const f = decodeChanFrame(encodeChanFrame(7, payload));
  assert.ok(f);
  assert.equal(f.kind, FRAME_PTY);
  assert.equal(f.chan, 7);
  assert.ok(f.payload.equals(payload));
}
// 채널 id 32비트 경계.
{
  const f = decodeChanFrame(encodeChanFrame(0xfffffffe, Buffer.from("x")));
  assert.ok(f && f.chan === 0xfffffffe);
}
// 짧은 프레임 = null(크래시 금지).
assert.equal(decodeChanFrame(Buffer.from([1, 0])), null);

// 제어 파싱 — t 없는/깨진 JSON 은 null.
assert.deepEqual(parseMsg('{"t":"res","id":1,"ok":true}'), { t: "res", id: 1, ok: true });
assert.equal(parseMsg("{"), null);
assert.equal(parseMsg('{"id":1}'), null);

// 가시성 — 소유자·초대만(개인 세션 규칙). 프로젝트 전체공개 규칙은 노드 세션에 미적용(D2).
assert.equal(nodeSessionVisible({ owner: "yoon", invites: [] }, "yoon"), true);
assert.equal(nodeSessionVisible({ owner: "yoon", invites: ["jang"] }, "jang"), true);
assert.equal(nodeSessionVisible({ owner: "yoon", invites: [] }, "jang"), false);

console.log("node/protocol.test OK");
