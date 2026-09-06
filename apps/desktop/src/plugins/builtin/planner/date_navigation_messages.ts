export const dateNavigationMessages = {
  dateJump: ["날짜로 이동", "Go to a date", "日付に移動"],
  previousMonth: ["이전 달", "Previous month", "前の月"],
  nextMonth: ["다음 달", "Next month", "次の月"],
  dateInput: ["날짜 직접 입력", "Enter a date", "日付を入力"],
  goToDate: ["이동", "Go", "移動"],
  invalidDate: [
    "올바른 날짜를 입력해주세요.",
    "Enter a valid date.",
    "有効な日付を入力してください。",
  ],
} as const satisfies Record<string, readonly [string, string, string]>;
