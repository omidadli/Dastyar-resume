/**
 * Excel export of a report page.
 *
 * `xlsx` is a big dependency, so it is loaded only when the button is pressed.
 * A sheet with no rows throws inside the library, so empty sheets are skipped
 * instead of producing a broken file.
 */
export async function exportSheets(fileName: string, sheets: { name: string; rows: Record<string, string | number | null>[] }[]) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  let added = 0;
  for (const sheet of sheets) {
    if (!sheet.rows.length) continue;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet.rows), sheet.name.slice(0, 31));
    added++;
  }
  if (!added) throw new Error('empty');
  wb.Workbook = { ...(wb.Workbook || {}), Views: [{ RTL: true }] };
  XLSX.writeFile(wb, fileName);
}
