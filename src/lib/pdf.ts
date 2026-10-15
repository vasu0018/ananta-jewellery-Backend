import PDFDocument from "pdfkit";
import type { Order, OrderItem, Shipment } from "@prisma/client";
import { getSetting } from "./settings";
import { num } from "./utils";

type Addr = {
  name?: string;
  phone?: string;
  line1?: string;
  line2?: string;
  landmark?: string;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
};

const rupee = (n: number) => `Rs. ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function addrLines(a: Addr) {
  return [
    a.name,
    a.line1,
    a.line2,
    a.landmark ? `Near ${a.landmark}` : undefined,
    [a.city, a.state, a.pincode].filter(Boolean).join(", "),
    a.country,
    a.phone ? `Ph: ${a.phone}` : undefined,
  ].filter(Boolean) as string[];
}

function render(build: (doc: PDFKit.PDFDocument) => void, options: PDFKit.PDFDocumentOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument(options);
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    build(doc);
    doc.end();
  });
}

/** GST tax invoice (CGST+SGST for intra-state, IGST for inter-state). */
export async function invoicePdf(order: Order & { items: OrderItem[] }) {
  const [store, tax] = await Promise.all([getSetting("store"), getSetting("tax")]);
  const ship = order.shippingAddress as Addr;
  const bill = (order.billingAddress as Addr | null) ?? ship;
  const intraState = (ship.state || "").trim().toLowerCase() === store.state.trim().toLowerCase();

  return render(
    (doc) => {
      const L = 40;
      const W = doc.page.width - 80;
      doc.fillColor("#9b5b6b").fontSize(20).font("Helvetica-Bold").text(store.name.toUpperCase(), L, 40, { characterSpacing: 2 });
      doc.fillColor("#444").fontSize(8.5).font("Helvetica");
      doc.text(tax.legalName);
      doc.text(`${store.address}, ${store.city}, ${store.state} - ${store.pincode}`);
      doc.text(`GSTIN: ${tax.gstin}  ·  ${store.email}  ·  ${store.phone}`);

      doc.fillColor("#111").fontSize(14).font("Helvetica-Bold").text("TAX INVOICE", L, 40, { width: W, align: "right" });
      doc.fontSize(8.5).font("Helvetica").fillColor("#444");
      const meta = [
        `Invoice No: ${order.invoiceNumber ?? "—"}`,
        `Invoice Date: ${(order.confirmedAt ?? order.placedAt).toLocaleDateString("en-IN")}`,
        `Order No: ${order.orderNumber}`,
        `Payment: ${order.paymentMethod} (${order.paymentStatus})`,
      ];
      meta.forEach((m, i) => doc.text(m, L, 60 + i * 12, { width: W, align: "right" }));

      let y = 125;
      doc.moveTo(L, y).lineTo(L + W, y).strokeColor("#e8dcd8").stroke();
      y += 10;
      doc.fillColor("#111").font("Helvetica-Bold").fontSize(9).text("Bill To", L, y).text("Ship To", L + W / 2, y);
      doc.font("Helvetica").fontSize(8.5).fillColor("#333");
      addrLines(bill).forEach((line, i) => doc.text(line, L, y + 14 + i * 11, { width: W / 2 - 10 }));
      addrLines(ship).forEach((line, i) => doc.text(line, L + W / 2, y + 14 + i * 11, { width: W / 2 - 10 }));
      y += 14 + Math.max(addrLines(bill).length, addrLines(ship).length) * 11 + 14;

      // Table
      const cols = [
        { t: "#", w: 22 },
        { t: "Item", w: 170 },
        { t: "HSN", w: 40 },
        { t: "Qty", w: 30 },
        { t: "Rate", w: 62 },
        { t: "Taxable", w: 66 },
        { t: "GST", w: 60 },
        { t: "Total", w: W - 450 },
      ];
      doc.rect(L, y, W, 18).fill("#f6efec");
      let x = L + 4;
      doc.fillColor("#111").font("Helvetica-Bold").fontSize(8);
      cols.forEach((c) => {
        doc.text(c.t, x, y + 5, { width: c.w - 6, align: c.t === "Item" ? "left" : "right" });
        x += c.w;
      });
      y += 24;
      doc.font("Helvetica").fontSize(8).fillColor("#222");

      let taxable = 0;
      let gst = 0;
      order.items.forEach((it, idx) => {
        const total = num(it.total);
        const rate = num(it.taxRate);
        const t = num(it.taxAmount) || total - total / (1 + rate / 100);
        taxable += total - t;
        gst += t;
        const name = `${it.name}${it.variantTitle ? ` (${it.variantTitle})` : ""}\nSKU: ${it.sku}`;
        const cells = [
          String(idx + 1),
          name,
          tax.hsnCode,
          String(it.quantity),
          rupee(num(it.unitPrice)),
          rupee(total - t),
          `${rate}%\n${rupee(t)}`,
          rupee(total),
        ];
        x = L + 4;
        cells.forEach((c, i) => {
          doc.text(c, x, y, { width: cols[i].w - 6, align: i === 1 ? "left" : "right" });
          x += cols[i].w;
        });
        y += 28;
        if (y > doc.page.height - 200) {
          doc.addPage();
          y = 50;
        }
      });

      doc.moveTo(L, y).lineTo(L + W, y).strokeColor("#e8dcd8").stroke();
      y += 10;
      const rows: [string, string][] = [
        ["Subtotal", rupee(num(order.subtotal))],
        ...(num(order.discount) ? [[`Discount${order.couponCode ? ` (${order.couponCode})` : ""}`, `- ${rupee(num(order.discount))}`] as [string, string]] : []),
        ...(num(order.loyaltyDiscount) ? [["Loyalty points", `- ${rupee(num(order.loyaltyDiscount))}`] as [string, string]] : []),
        ["Shipping", num(order.shippingFee) ? rupee(num(order.shippingFee)) : "FREE"],
        ...(num(order.codFee) ? [["COD charges", rupee(num(order.codFee))] as [string, string]] : []),
        ...(num(order.giftWrapFee) ? [["Gift wrap", rupee(num(order.giftWrapFee))] as [string, string]] : []),
        ["Taxable value", rupee(taxable)],
        ...(intraState
          ? ([
              ["CGST (incl.)", rupee(gst / 2)],
              ["SGST (incl.)", rupee(gst / 2)],
            ] as [string, string][])
          : ([["IGST (incl.)", rupee(gst)]] as [string, string][])),
      ];
      rows.forEach(([k, v]) => {
        doc.fontSize(8.5).fillColor("#444").text(k, L + W - 260, y, { width: 150, align: "right" });
        doc.fillColor("#111").text(v, L + W - 100, y, { width: 100, align: "right" });
        y += 14;
      });
      doc.rect(L + W - 260, y + 2, 260, 22).fill("#9b5b6b");
      doc.fillColor("#fff").font("Helvetica-Bold").fontSize(10)
        .text("Grand Total", L + W - 250, y + 8, { width: 140 })
        .text(rupee(num(order.total)), L + W - 110, y + 8, { width: 104, align: "right" });

      doc.font("Helvetica").fontSize(7.5).fillColor("#777").text(
        "Prices are inclusive of GST. This is a computer generated invoice and does not require a signature. " +
          "Every piece comes with a certificate of authenticity. For returns & support visit our website.",
        L,
        doc.page.height - 70,
        { width: W, align: "center" },
      );
    },
    { size: "A4", margin: 40 },
  );
}

/** 4x6 inch shipping label. */
export async function shippingLabelPdf(order: Order & { items: OrderItem[] }, shipment: Shipment) {
  const store = await getSetting("store");
  const ship = order.shippingAddress as Addr;
  return render(
    (doc) => {
      const W = 288 - 24;
      doc.lineWidth(1).rect(12, 12, W, 408).stroke();
      doc.font("Helvetica-Bold").fontSize(11).text(shipment.courierName || "Courier", 20, 20);
      doc.fontSize(9).text(order.paymentMethod === "COD" ? `COD  ${rupee(num(order.total))}` : "PREPAID", 20, 20, { width: W - 16, align: "right" });
      doc.moveTo(12, 38).lineTo(12 + W, 38).stroke();
      doc.fontSize(8).font("Helvetica").text("AWB", 20, 46);
      doc.font("Helvetica-Bold").fontSize(22).text(shipment.awb ?? "PENDING", 20, 58, { width: W - 16, align: "center", characterSpacing: 2 });
      doc.moveTo(12, 92).lineTo(12 + W, 92).stroke();
      doc.font("Helvetica-Bold").fontSize(9).text("DELIVER TO", 20, 100);
      doc.font("Helvetica").fontSize(10);
      addrLines(ship).forEach((l, i) => doc.text(l, 20, 114 + i * 13, { width: W - 16 }));
      doc.moveTo(12, 220).lineTo(12 + W, 220).stroke();
      doc.font("Helvetica-Bold").fontSize(9).text("ORDER", 20, 228);
      doc.font("Helvetica").fontSize(8.5)
        .text(`Order: ${order.orderNumber}`, 20, 242)
        .text(`Items: ${order.items.reduce((s, i) => s + i.quantity, 0)}  ·  Weight: ${num(shipment.weight) || 50} g`, 20, 255)
        .text(`Dims: ${num(shipment.length) || 12} x ${num(shipment.width) || 10} x ${num(shipment.height) || 5} cm`, 20, 268);
      doc.moveTo(12, 290).lineTo(12 + W, 290).stroke();
      doc.font("Helvetica-Bold").fontSize(9).text("RETURN ADDRESS", 20, 298);
      doc.font("Helvetica").fontSize(8.5)
        .text(store.name, 20, 312)
        .text(store.address, 20, 324, { width: W - 16 })
        .text(`${store.city}, ${store.state} - ${store.pincode}`, 20, 348)
        .text(`Ph: ${store.phone}`, 20, 360);
      doc.fontSize(7).fillColor("#666").text("Handle with care · Fine jewellery", 20, 398, { width: W - 16, align: "center" });
    },
    { size: [288, 432], margin: 12 },
  );
}
