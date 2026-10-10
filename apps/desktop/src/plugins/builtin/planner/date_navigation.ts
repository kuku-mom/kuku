import { addDays, dateFromKey, weekDays } from "./dates";

export function validNavigationDate(day: string): boolean {
  return !day.startsWith("0000-") && Number.isFinite(dateFromKey(day).getTime());
}

export function navigationMonth(day: string): string {
  return validNavigationDate(day) ? `${day.slice(0, 7)}-01` : "";
}

/** Move by civil months and clamp the day, so January 31 reaches February's last day. */
export function moveNavigationMonth(day: string, months: number): string {
  if (!validNavigationDate(day) || !Number.isInteger(months)) return "";
  const date = new Date(`${day}T12:00:00Z`);
  const wantedDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9999)
    return "";
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  next.setUTCDate(0);
  date.setUTCDate(Math.min(wantedDay, next.getUTCDate()));
  const result = date.toISOString().slice(0, 10);
  return validNavigationDate(result) ? result : "";
}

/** Always six Monday-first rows, preventing popup height jumps between months. */
export function navigationMonthDays(day: string): string[][] {
  const month = navigationMonth(day);
  if (!month) return [];
  const first = weekDays(month)[0];
  return Array.from({ length: 6 }, (_, row) =>
    Array.from({ length: 7 }, (_, column) => {
      const candidate = addDays(first, row * 7 + column);
      return validNavigationDate(candidate) ? candidate : "";
    }),
  );
}

export function moveNavigationFocus(day: string, key: string, shift = false): string | undefined {
  if (!validNavigationDate(day)) return undefined;
  switch (key) {
    case "ArrowLeft":
      return addDays(day, -1);
    case "ArrowRight":
      return addDays(day, 1);
    case "ArrowUp":
      return addDays(day, -7);
    case "ArrowDown":
      return addDays(day, 7);
    case "Home":
      return weekDays(day)[0];
    case "End":
      return weekDays(day)[6];
    case "PageUp":
      return moveNavigationMonth(day, shift ? -12 : -1) || undefined;
    case "PageDown":
      return moveNavigationMonth(day, shift ? 12 : 1) || undefined;
  }
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function placeDateNavigator(pane: Rect, trigger: Rect, height: number) {
  const paddingX = Math.min(10, Math.max(0, pane.right - pane.left) / 2);
  const paddingY = Math.min(10, Math.max(0, pane.bottom - pane.top) / 2);
  const left = pane.left + paddingX;
  const right = Math.max(left, pane.right - paddingX);
  const top = pane.top + paddingY;
  const bottom = Math.max(top, pane.bottom - paddingY);
  const width = Math.min(300, right - left);
  const naturalHeight = Math.max(0, height);
  const below = Math.max(0, bottom - trigger.bottom - 7);
  const above = Math.max(0, trigger.top - top - 7);
  const useBelow = below >= naturalHeight || (above < naturalHeight && below >= above);
  const maxHeight = Math.min(naturalHeight, useBelow ? below : above, bottom - top);
  const desiredTop = useBelow ? trigger.bottom + 7 : trigger.top - 7 - maxHeight;
  return {
    left: Math.max(left, Math.min(trigger.left, right - width)),
    top: Math.max(top, Math.min(desiredTop, bottom - maxHeight)),
    width,
    maxHeight,
  };
}
