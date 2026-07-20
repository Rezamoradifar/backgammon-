/** ISO-8601 week utilities. Weeks run Monday 00:00 UTC to the following
 * Monday 00:00 UTC (exclusive), independent of local timezone - used to
 * define the boundaries for the weekly top-wagerer reward job. */

export interface WeekRange {
  weekId: string; // e.g. "2026-W29"
  start: Date;
  end: Date;
}

/** The most recently *completed* full week as of `now` - i.e. last week,
 * not the week still in progress. This is what the weekly job distributes
 * rewards for. */
export function previousCompletedWeek(now: Date): WeekRange {
  const thisWeekStart = mondayStartOfWeek(now);
  const start = new Date(thisWeekStart);
  start.setUTCDate(start.getUTCDate() - 7);
  return weekRangeFromStart(start);
}

function mondayStartOfWeek(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
  const diffToMonday = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d;
}

function weekRangeFromStart(start: Date): WeekRange {
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { weekId: isoWeekId(start), start, end };
}

/** ISO-8601 week number (the Thursday-of-the-week rule), formatted "YYYY-Www". */
function isoWeekId(mondayStart: Date): string {
  // The ISO week's year is whichever year contains that week's Thursday.
  const thursday = new Date(mondayStart);
  thursday.setUTCDate(thursday.getUTCDate() + 3);
  const isoYear = thursday.getUTCFullYear();

  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const jan1Day = jan1.getUTCDay() === 0 ? 7 : jan1.getUTCDay();
  const jan1Monday = new Date(jan1);
  jan1Monday.setUTCDate(jan1.getUTCDate() - (jan1Day - 1));

  const weekNumber = Math.round((mondayStart.getTime() - jan1Monday.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
  return `${isoYear}-W${String(weekNumber).padStart(2, "0")}`;
}
