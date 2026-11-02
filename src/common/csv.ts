export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stops text running as an Excel formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvText = (rows: (string | number | null)[][]) =>
  '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
