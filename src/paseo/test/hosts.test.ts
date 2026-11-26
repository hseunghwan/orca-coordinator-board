import { expect, test } from "vitest";
import { boardHosts, hiddenAfter, hostVisibility, type BoardHost } from "../shared/hosts";

const current = { id: "srv_lab_a", label: "Lab" };
const host = (serverId: string, label: string, status: BoardHost["status"] = "online"): BoardHost => ({ serverId, label, status });

test("기존 앱 등록 호스트와 연결 상태를 표시하고 현재 보드가 빠진 경우에만 미확인으로 보완한다", () => {
  const offline = host("srv_other", "Laptop", "offline");
  const entries = [host(current.id, current.label), offline];
  expect(boardHosts(current, entries)).toEqual(entries);
  expect(boardHosts(current, [offline])).toEqual([offline, host(current.id, current.label, "unknown")]);
  expect(boardHosts(current, [...entries, ...entries])).toEqual(entries);
});

test("동일한 이름과 같은 ID 접미사가 있어도 모든 호스트를 구별한다", () => {
  const ids = ["srv_alpha_1234567", "srv_beta_1234567", "srv_independent"];
  const rows = boardHosts({ id: ids[0], label: "Mac" }, ids.map(id => host(id, "Mac")));
  expect(new Set(rows.map(h => h.label)).size).toBe(3);
  expect(rows.map(h => h.serverId)).toEqual(ids);
  expect(rows.every(h => h.label.startsWith("Mac · "))).toBe(true);
});

test("호스트별 표시 설정은 기본 포함이며 제외한 ID만 저장하고 다시 나타난 호스트는 그 설정을 따른다", () => {
  const initial = hostVisibility.schema.parse({});
  expect(initial.hidden).toEqual([]);
  const hidden = hiddenAfter(initial.hidden, current.id, false);
  expect(hiddenAfter(hidden, current.id, false)).toEqual([current.id]);
  expect(hiddenAfter(hidden, "new", false)).toEqual([current.id, "new"]);
  expect(hiddenAfter(hidden, current.id, true)).toEqual([]);
  expect(initial.hidden).toEqual([]);
});
