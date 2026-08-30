// 메일 채널(라벨) 선택 — #2416. 엣지 표 행마다 한 검사.
//  사양: ① 사람이 만든 라벨 우선(여럿이면 이름 오름차순 첫 번째) ② 없으면 기본 분류 탭의 한국어 이름
//       ③ 둘 다 없으면 빈 문자열(지어내지 않는다).
import test from "node:test";
import assert from "node:assert/strict";
import { pickMailLabel, toRawItem } from "./gmail.js";

const names = new Map<string, string>([
  ["Label_1", "고객사/두루물류"],
  ["Label_2", "정산"],
  ["Label_9", "   "],           // 공백뿐 — 이름 없는 것과 같다
]);

test("① 사람이 만든 라벨이 있으면 그 이름", () => {
  assert.equal(pickMailLabel(["INBOX", "Label_2"], names), "정산");
});

test("② 사람 라벨이 여럿이면 이름 오름차순 첫 번째(순서가 흔들리지 않는다)", () => {
  const a = pickMailLabel(["Label_2", "Label_1"], names);
  const b = pickMailLabel(["Label_1", "Label_2"], names);
  assert.equal(a, b);
  assert.equal(a, "고객사/두루물류");
});

test("③ 시스템 라벨뿐이면 채널 없음", () => {
  assert.equal(pickMailLabel(["INBOX", "UNREAD", "IMPORTANT"], names), "");
});

test("④ 사람 라벨이 없고 분류 탭이 있으면 그 한국어 이름", () => {
  assert.equal(pickMailLabel(["INBOX", "CATEGORY_PROMOTIONS"], names), "프로모션");
});

test("⑤ 사람 라벨이 분류 탭보다 우선한다", () => {
  assert.equal(pickMailLabel(["CATEGORY_PROMOTIONS", "Label_2"], names), "정산");
});

test("⑥ labelIds 가 없으면 채널 없음", () => {
  assert.equal(pickMailLabel(undefined, names), "");
  assert.equal(pickMailLabel([], names), "");
});

test("⑦ 라벨 맵에 이름이 없으면(조회 실패 등) 지어내지 않는다", () => {
  assert.equal(pickMailLabel(["Label_777"], names), "");
  assert.equal(pickMailLabel(["Label_777"], new Map()), "");
});

test("⑧ 이름이 공백뿐인 라벨은 없는 것으로 본다", () => {
  assert.equal(pickMailLabel(["Label_9"], names), "");
  assert.equal(pickMailLabel(["Label_9", "Label_2"], names), "정산");
});

// ── 배선 단언 — 고른 채널이 실제로 RawItem 에 실리는가(관측 장치가 죽어 있지 않은지) ──
const msg = { id: "m1", threadId: "m1", internalDate: "1756500000000", labelIds: ["INBOX", "Label_2"], payload: { headers: [{ name: "Subject", value: "정산 안내" }] } };

test("⑨ container 를 주면 RawItem.container_name 으로 실린다", () => {
  const it = toRawItem(msg as never, { instance: "default", container: pickMailLabel(msg.labelIds, names) });
  assert.equal(it.container_name, "정산");
});

test("⑩ 채널이 없으면 container_name 을 아예 넣지 않는다(빈 문자열로 넣지 않는다)", () => {
  const it = toRawItem(msg as never, { instance: "default", container: "" });
  assert.equal(it.container_name, undefined);
  const it2 = toRawItem(msg as never, { instance: "default" });
  assert.equal(it2.container_name, undefined);
});

test("⑪ 앞뒤 공백은 다듬어 싣는다", () => {
  const it = toRawItem(msg as never, { instance: "default", container: "  정산  " });
  assert.equal(it.container_name, "정산");
});
