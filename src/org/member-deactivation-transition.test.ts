// 멤버 비활성 전이 판정(#1780 v2 §7-1, 사양 H5) — 순수. active 에서 벗어나는 전이만 회수를 촉발한다.
import { strict as assert } from "node:assert";
import { isMemberDeactivation } from "./store/members.js";

assert.equal(isMemberDeactivation("active", "inactive"), true, "active→inactive 는 전이");
assert.equal(isMemberDeactivation("active", null), true, "active→삭제 는 전이");
assert.equal(isMemberDeactivation("active", "active"), false, "active 재저장은 전이 아님");
assert.equal(isMemberDeactivation("inactive", "inactive"), false, "inactive 재저장은 전이 아님(이미 거둠)");
assert.equal(isMemberDeactivation("inactive", null), false, "inactive→삭제 는 전이 아님(이미 거둠)");
assert.equal(isMemberDeactivation("inactive", "active"), false, "재활성화는 회수가 아니다(grant 는 부활하지 않는다 — 재동의)");
assert.equal(isMemberDeactivation(undefined, "inactive"), false, "신규 생성이 inactive 여도 거둘 것이 없다");
console.log("member-deactivation-transition.test: ok");
