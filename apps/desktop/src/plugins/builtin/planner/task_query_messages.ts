export const taskQueryMessages = {
  taskSearch: ["할 일 검색", "Search tasks", "タスクを検索"],
  clearTaskSearch: ["검색 지우기", "Clear search", "検索をクリア"],
  sortTasks: ["할 일 정렬", "Sort tasks", "タスクの並べ替え"],
  sortDue: ["마감일순", "Due date", "期限順"],
  sortScheduled: ["배정 시간순", "Scheduled time", "予定時刻順"],
  sortTitle: ["이름순", "Title", "名前順"],
  noTaskMatches: [
    "검색에 맞는 할 일이 없어요.",
    "No matching tasks.",
    "一致するタスクはありません。",
  ],
} as const satisfies Record<string, readonly [string, string, string]>;
