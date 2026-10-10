import { describe, expect, it } from "vitest";

import { queryTaskEntries, type TaskQueryEntry } from "./task_query";

function entry(
  key: string,
  title: string,
  fields: Partial<TaskQueryEntry<string>> = {},
): TaskQueryEntry<string> {
  return { key, title, context: "", value: key, ...fields };
}

describe("Planner task search and ordering", () => {
  it("matches NFKC-normalized width, decomposed Hangul, case and source context", () => {
    const tasks = [
      entry("match", "ＡＰＩ 리뷰", { context: "Projects/출시.md" }),
      entry("wrong-source", "API 리뷰", { context: "Personal/일상.md" }),
      entry("wrong-title", "서버 정리", { context: "Projects/출시.md" }),
    ];
    const query = `api　${"리뷰".normalize("NFD")}\nPROJECTS`;
    expect(queryTaskEntries(tasks, query, "title", "ko").map((task) => task.key)).toEqual([
      "match",
    ]);
  });

  it("finds Japanese half-width terms in a reminder list and requires every term", () => {
    const tasks = [
      entry("reminder", "メールを確認", { context: "仕事のリスト" }),
      entry("private", "メールを確認", { context: "個人" }),
    ];
    expect(queryTaskEntries(tasks, "ﾒｰﾙ 仕事", "title", "ja").map((task) => task.key)).toEqual([
      "reminder",
    ]);
    expect(queryTaskEntries(tasks, "メール 仕事 未登録", "title", "ja")).toEqual([]);
  });

  it("sorts deadlines first, places missing or invalid dates last and resolves ties by key", () => {
    const tasks = [
      entry("z-undated", "A"),
      entry("z-same", "A", { dueDate: "2026-09-05" }),
      entry("a-same", "Z", { dueDate: "2026-09-05" }),
      entry("first", "First", { dueDate: "2026-09-04" }),
      entry("a-invalid", "Invalid", { dueDate: "2026-02-30" }),
    ];
    expect(queryTaskEntries(tasks, "", "due", "en").map((task) => task.key)).toEqual([
      "first",
      "a-same",
      "z-same",
      "a-invalid",
      "z-undated",
    ]);
  });

  it("sorts scheduled instants across offsets independently from deadlines", () => {
    const tasks = [
      entry("later", "Later", {
        scheduledStart: "2026-09-04T14:00:00+09:00",
        dueDate: "2026-09-01",
      }),
      entry("earlier", "Earlier", {
        scheduledStart: "2026-09-04T04:00:00Z",
        dueDate: "2026-09-10",
      }),
      entry("none", "None"),
    ];
    expect(queryTaskEntries(tasks, "", "scheduled", "en").map((task) => task.key)).toEqual([
      "earlier",
      "later",
      "none",
    ]);
  });

  it("uses locale title ordering with natural numbers and stable equivalent-title ties", () => {
    const tasks = [
      entry("z", "ＡＬＰＨＡ"),
      entry("a", "alpha"),
      entry("ten", "Task 10"),
      entry("two", "Task 2"),
    ];
    expect(queryTaskEntries(tasks, "  \n ", "title", "en").map((task) => task.key)).toEqual([
      "a",
      "z",
      "two",
      "ten",
    ]);
    expect(
      queryTaskEntries([...tasks].reverse(), "", "title", "en").map((task) => task.key),
    ).toEqual(["a", "z", "two", "ten"]);
  });

  it("returns a new ordering while preserving source values and the input array", () => {
    const source = { provider: "apple-reminders", id: "original" };
    const first: TaskQueryEntry<object> = { key: "z", title: "Z", context: "List", value: source };
    const second: TaskQueryEntry<object> = { key: "a", title: "A", context: "List", value: {} };
    const input = Object.freeze([Object.freeze(first), Object.freeze(second)]);
    const result = queryTaskEntries(input, "list", "title", "en");
    expect(result).not.toBe(input);
    expect(result.map((task) => task.key)).toEqual(["a", "z"]);
    expect(input[0]).toBe(first);
    expect(result[1]).toBe(first);
    expect(result[1].value).toBe(source);
  });
});
