export type TaskSort = "due" | "scheduled" | "title";

export interface TaskQueryEntry<T> {
  value: T;
  key: string;
  title: string;
  context: string;
  dueDate?: string;
  scheduledStart?: string;
}

function normalized(value: string, locale: string) {
  return value.normalize("NFKC").toLocaleLowerCase(locale);
}

function dateOrder(value: string | undefined): number {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return Infinity;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return Infinity;
  if (value.length === 10 && new Date(time).toISOString().slice(0, 10) !== value) return Infinity;
  return time;
}

/** Search titles and source context together, keeping each task's source value intact. */
export function queryTaskEntries<T>(
  entries: readonly TaskQueryEntry<T>[],
  query: string,
  sort: TaskSort,
  locale: string,
): TaskQueryEntry<T>[] {
  const terms = normalized(query, locale).trim().split(/\s+/).filter(Boolean);
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  const matches = entries.filter((entry) => {
    if (!terms.length) return true;
    const haystack = normalized(`${entry.title}\n${entry.context}`, locale);
    return terms.every((term) => haystack.includes(term));
  });
  return matches.sort((a, b) => {
    let order: number;
    if (sort === "title") {
      order = collator.compare(a.title.normalize("NFKC"), b.title.normalize("NFKC"));
    } else {
      const first = dateOrder(sort === "due" ? a.dueDate : a.scheduledStart);
      const second = dateOrder(sort === "due" ? b.dueDate : b.scheduledStart);
      order = first === second ? 0 : first < second ? -1 : 1;
    }
    return order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
}
