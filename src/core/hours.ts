// Front desk hours are 10:00-19:00 IST. Used to tag after-hours calls so the
// dashboard can show how many enquiries the old process would have dropped.
const IST_OFFSET_MIN = 330;

export function isAfterHours(iso: string): boolean {
  const d = new Date(new Date(iso).getTime() + IST_OFFSET_MIN * 60000);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins < 10 * 60 || mins >= 19 * 60;
}
