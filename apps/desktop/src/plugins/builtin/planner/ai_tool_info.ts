import { currentLocale } from "~/i18n";

type ToolInfo = { label: string; activeLabel: string; description: string };
const messages = {
  ko: {
    tasks_search: ["할 일 검색", "할 일 찾는 중", "노트와 미리 알림의 할 일을 검색하고 정렬해요."],
    task_read: ["할 일 조회", "할 일 확인 중", "할 일의 최신 내용과 배정 시간을 확인해요."],
    task_create: [
      "할 일 추가",
      "할 일 추가 중",
      "Kuku Inbox 또는 선택한 미리 알림 목록에 저장해요.",
    ],
    task_update: ["할 일 수정", "할 일 수정 중", "원본 할 일의 제목·마감일·계획일을 수정해요."],
    task_complete: [
      "할 일 완료 상태 변경",
      "완료 상태 저장 중",
      "원본에 완료 상태를 저장하고 시간 블록은 유지해요.",
    ],
    task_schedule: [
      "작업 시간 배정",
      "작업 시간 저장 중",
      "작업 시간을 배정하거나 기존 블록을 이동해요.",
    ],
    task_unassign: [
      "작업 시간 해제",
      "시간 배정 해제 중",
      "연결된 시간 블록을 제거하고 할 일은 유지해요.",
    ],
    task_delete: [
      "할 일 삭제",
      "할 일 삭제 중",
      "선택한 할 일을 삭제하고 지정한 대로 블록을 처리해요.",
    ],
    calendars_list: [
      "연결 캘린더 조회",
      "캘린더 확인 중",
      "연결 상태와 조회·저장 가능한 캘린더를 확인해요.",
    ],
    events_list: [
      "기간별 일정 조회",
      "일정 불러오는 중",
      "선택한 기간의 일정을 최신 상태로 불러와요.",
    ],
    event_read: ["일정 조회", "일정 확인 중", "원본에서 일정의 최신 내용과 버전을 확인해요."],
    event_create: ["일정 만들기", "일정 저장 중", "선택한 캘린더에 새 일정을 저장해요."],
    event_update: ["일정 수정", "일정 수정 중", "원본 일정의 제목·시간·장소·설명을 수정해요."],
    event_delete: ["일정 삭제", "일정 삭제 중", "선택한 일정을 삭제해요. 연결된 할 일은 유지해요."],
    availability: [
      "빈 시간·겹침 확인",
      "빈 시간 찾는 중",
      "최신 일정과 작업 블록을 기준으로 빈 시간과 겹침을 확인해요.",
    ],
    open_source: ["원본 열기", "원본 여는 중", "선택한 할 일의 원본 노트나 외부 항목을 열어요."],
    link_note: [
      "일정에 노트 연결",
      "노트 연결 중",
      "외부 일정·미리 알림에 기존 노트나 새 노트를 연결해요.",
    ],
  },
  en: {
    tasks_search: [
      "Search tasks",
      "Searching tasks",
      "Search and sort tasks from notes and reminders.",
    ],
    task_read: ["Read task", "Reading task", "Read the latest task and scheduled time."],
    task_create: [
      "Create task",
      "Creating task",
      "Save a task to Kuku Inbox or a selected reminder list.",
    ],
    task_update: [
      "Update task",
      "Updating task",
      "Update the source task's title, due date or planned date.",
    ],
    task_complete: [
      "Set task completion",
      "Saving completion",
      "Save completion to the source and keep its time block.",
    ],
    task_schedule: [
      "Schedule task",
      "Scheduling task",
      "Assign work time or move the existing block.",
    ],
    task_unassign: [
      "Unassign task time",
      "Removing time block",
      "Remove the linked time block and keep the task.",
    ],
    task_delete: [
      "Delete task",
      "Deleting task",
      "Delete the selected task with the requested block treatment.",
    ],
    calendars_list: [
      "List calendars",
      "Reading calendars",
      "Check connections and calendars available to read or write.",
    ],
    events_list: ["List events", "Loading events", "Fetch the latest events for a selected range."],
    event_read: [
      "Read event",
      "Reading event",
      "Read the latest event and version from its source.",
    ],
    event_create: ["Create event", "Saving event", "Save a new event to the selected calendar."],
    event_update: [
      "Update event",
      "Updating event",
      "Update the source event's title, time, location or description.",
    ],
    event_delete: [
      "Delete event",
      "Deleting event",
      "Delete the selected event while keeping its linked task.",
    ],
    availability: [
      "Check availability",
      "Finding free time",
      "Find free time and overlaps using current events and work blocks.",
    ],
    open_source: ["Open source", "Opening source", "Open the task's source note or external item."],
    link_note: [
      "Link note",
      "Linking note",
      "Link an existing or new note to an external event or reminder.",
    ],
  },
  ja: {
    tasks_search: [
      "タスクを検索",
      "タスクを検索中",
      "ノートとリマインダーのタスクを検索・並べ替えます。",
    ],
    task_read: ["タスクを確認", "タスクを確認中", "タスクの最新内容と予定時間を確認します。"],
    task_create: [
      "タスクを追加",
      "タスクを追加中",
      "Kuku Inboxまたは選択したリマインダーリストに保存します。",
    ],
    task_update: [
      "タスクを編集",
      "タスクを編集中",
      "元のタスクのタイトル・期限・計画日を変更します。",
    ],
    task_complete: [
      "完了状態を変更",
      "完了状態を保存中",
      "元のタスクに完了状態を保存し、時間ブロックは残します。",
    ],
    task_schedule: [
      "作業時間を割り当て",
      "作業時間を保存中",
      "作業時間を割り当てるか、既存のブロックを移動します。",
    ],
    task_unassign: [
      "時間の割り当てを解除",
      "時間ブロックを削除中",
      "連携する時間ブロックを削除し、タスクは残します。",
    ],
    task_delete: [
      "タスクを削除",
      "タスクを削除中",
      "選択したタスクを削除し、指定どおりにブロックを処理します。",
    ],
    calendars_list: [
      "カレンダーを確認",
      "カレンダーを確認中",
      "接続状況と読み書き可能なカレンダーを確認します。",
    ],
    events_list: [
      "期間内の予定を確認",
      "予定を読み込み中",
      "選択した期間の最新の予定を取得します。",
    ],
    event_read: ["予定を確認", "予定を確認中", "元の予定の最新内容とバージョンを確認します。"],
    event_create: ["予定を作成", "予定を保存中", "選択したカレンダーに新しい予定を保存します。"],
    event_update: [
      "予定を編集",
      "予定を編集中",
      "元の予定のタイトル・時間・場所・説明を変更します。",
    ],
    event_delete: [
      "予定を削除",
      "予定を削除中",
      "選択した予定を削除し、連携するタスクは残します。",
    ],
    availability: [
      "空き時間・重複を確認",
      "空き時間を検索中",
      "最新の予定と作業ブロックから空き時間と重複を確認します。",
    ],
    open_source: [
      "元の項目を開く",
      "元の項目を開いています",
      "タスクの元のノートまたは外部項目を開きます。",
    ],
    link_note: [
      "ノートを連携",
      "ノートを連携中",
      "外部の予定・リマインダーに既存または新規ノートを連携します。",
    ],
  },
} as const;

/** Kept independent of tool handlers so chat labels don't activate Planner. */
export function plannerToolInfo(identity: string): ToolInfo | undefined {
  const kind = identity.startsWith("planner.")
    ? identity.slice(8)
    : identity.startsWith("planner_")
      ? identity.slice(8)
      : "";
  if (!Object.hasOwn(messages.en, kind)) return undefined;
  const [label, activeLabel, description] =
    messages[currentLocale()][kind as keyof typeof messages.en];
  return { label, activeLabel, description };
}
