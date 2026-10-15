import type { Response } from "express";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

export type Column<T> = { key: string; label: string; value?: (row: T) => unknown; width?: number };

function cell<T>(row: T, col: Column<T>) {
  const v = col.value ? col.value(row) : (row as Record<string, unknown>)[col.key];
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.join("; ");
  return v;
}

function csvEscape(v: unknown) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(rows: T[], columns: Column<T>[]) {
  const head = columns.map((c) => csvEscape(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => csvEscape(cell(r, c))).join(","));
  return [head, ...body].join("\r\n");
}

/** RFC-4180 CSV parser (quoted fields, escaped quotes, CRLF). Returns objects keyed by header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (!nonEmpty.length) return [];
  const headers = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => (obj[h] = (r[idx] ?? "").trim()));
    return obj;
  });
}

export async function toXlsx<T>(rows: T[], columns: Column<T>[], sheetName = "Report") {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ananta Jewellery";
  const ws = wb.addWorksheet(sheetName.slice(0, 31));
  ws.columns = columns.map((c) => ({ header: c.label, key: c.key, width: c.width ?? 18 }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    const obj: Record<string, unknown> = {};
    for (const c of columns) obj[c.key] = cell(r, c);
    ws.addRow(obj);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toPdfTable<T>(title: string, rows: T[], columns: Column<T>[]): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 32 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(16).text(title, { continued: false });
    doc.fontSize(9).fillColor("#666").text(`Generated ${new Date().toLocaleString("en-IN")}`);
    doc.moveDown(0.8).fillColor("#000");

    const usable = doc.page.width - 64;
    const colW = usable / columns.length;
    const drawHeader = () => {
      const y = doc.y;
      doc.rect(32, y - 2, usable, 16).fill("#f3f0ee").fillColor("#000");
      columns.forEach((c, i) => doc.fontSize(8).font("Helvetica-Bold").text(c.label, 34 + i * colW, y, { width: colW - 4, ellipsis: true }));
      doc.font("Helvetica").moveDown(0.6);
    };
    drawHeader();
    for (const r of rows) {
      if (doc.y > doc.page.height - 48) {
        doc.addPage();
        drawHeader();
      }
      const y = doc.y;
      columns.forEach((c, i) =>
        doc.fontSize(8).text(String(cell(r, c)), 34 + i * colW, y, { width: colW - 4, ellipsis: true, lineBreak: false }),
      );
      doc.moveDown(0.7);
    }
    doc.end();
  });
}

/** Send rows as csv | xlsx | pdf | json depending on ?format. */
export async function sendExport<T>(
  res: Response,
  format: string | undefined,
  name: string,
  rows: T[],
  columns: Column<T>[],
) {
  const stamp = new Date().toISOString().slice(0, 10);
  const file = `${name}-${stamp}`;
  switch (format) {
    case "csv":
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${file}.csv"`);
      res.send("\uFEFF" + toCsv(rows, columns));
      return true;
    case "xlsx":
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${file}.xlsx"`);
      res.send(await toXlsx(rows, columns, name));
      return true;
    case "pdf":
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${file}.pdf"`);
      res.send(await toPdfTable(name.replace(/-/g, " ").toUpperCase(), rows, columns));
      return true;
    default:
      return false;
  }
}
