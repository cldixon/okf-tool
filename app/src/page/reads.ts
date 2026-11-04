import { plural } from "../ui";

/**
 * A page's read history as `GET …/page/{path}` and `POST …/read/{path}` answer it (TEMPRA-220,
 * tempra-dev: v2/read-history): counts and the agent or person split, never who read it.
 */
export interface ReadCounts {
  total: number;
  agents: number;
  people: number;
  mcp: number;
  app: number;
  api: number;
  readers: number;
}

export interface ReadHistory {
  week: ReadCounts;
  month: ReadCounts;
  last: { mcp: string | null; app: string | null; api: string | null };
  last_read: string | null;
}

/**
 * How much the page is read, in people's words for Properties: "14 times this week, 9 by
 * agents", "Not this week, 3 times this month", "Not in the last month".
 */
export function readWords(r: ReadHistory): string {
  const { week, month } = r;
  if (week.total > 0) {
    const by =
      week.agents === 0
        ? ""
        : week.agents === week.total
          ? ", all by agents"
          : `, ${week.agents} by agents`;
    return `${plural(week.total, "time")} this week${by}`;
  }
  if (month.total > 0) return `Not this week, ${plural(month.total, "time")} this month`;
  return "Not in the last month";
}
