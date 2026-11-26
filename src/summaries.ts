import { gunzipSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";

// The summaries the user confirms before manage_invoice or manage_annulment sends anything to NAV. Each one is read
// from the XML that would be sent (base64, for manage_invoice optionally gzip). If an operation cannot be read, there
// is no summary, and the tool sends nothing: what the user has not seen is not sent.

/** How many invoice lines are listed one by one; the rest are counted. */
export const MAX_LINES_LISTED = 5;

const PRODUCTION_HOST = "api.onlineszamla.nav.gov.hu";
const TEST_HOST = "api-test.onlineszamla.nav.gov.hu";

export class UnreadableOperation extends Error {
  constructor(public readonly index: number, reason: string) {
    super(`a(z) ${index}. művelet nem olvasható: ${reason}`);
    this.name = "UnreadableOperation";
  }
}

/**
 * The first line of every summary: which NAV the request goes to, read from the base URL it is sent to (NAV_ENV, or
 * NAV_BASE_URL when set). Only the NAV test host is called TESZT; any other host, the production one or a custom
 * address, is called ÉLES, because a custom address may lead to production and a wrong TESZT is the costly mistake.
 */
export function environmentLine(baseUrl: string): string {
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    host = baseUrl;
  }
  if (host === TEST_HOST) return `>>> TESZT NAV <<< (${host}): a NAV tesztkörnyezete.`;
  const custom = host === PRODUCTION_HOST ? "" : ` Egyedi cím, nem a NAV ismert éles vagy teszt címe, ezért élesnek számít.`;
  return `>>> ÉLES NAV <<< (${host}): a beküldés valódi adatszolgáltatás az adóhatóságnak.${custom}`;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false, // keep "000123" and "02" as written
  trimValues: true,
  isArray: (name) => ["batchInvoice", "line"].includes(name),
});

type Node = Record<string, unknown>;

const node = (v: unknown): Node | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Node) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined);
const path = (v: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((cur, k) => node(cur)?.[k], v);

/** Base64 (and gzip, when compressed) to the parsed document; throws when it is not base64 or not XML. */
function decode(index: number, b64: string, compressed: boolean): Node {
  const clean = b64.replace(/\s+/g, "");
  if (clean === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) throw new UnreadableOperation(index, "nem base64");
  let bytes = Buffer.from(clean, "base64");
  if (compressed) {
    try {
      bytes = gunzipSync(bytes);
    } catch {
      throw new UnreadableOperation(index, "a tömörítés (gzip) nem bontható ki");
    }
  }
  let doc: unknown;
  try {
    doc = parser.parse(bytes.toString("utf8"), true);
  } catch (err) {
    throw new UnreadableOperation(index, `nem érvényes XML (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
  }
  const d = node(doc);
  if (!d) throw new UnreadableOperation(index, "nem XML");
  return d;
}

function taxNumber(t: unknown): string | undefined {
  const id = str(path(t, "taxpayerId"));
  if (!id) return undefined;
  return [id, str(path(t, "vatCode")), str(path(t, "countyCode"))].filter(Boolean).join("-");
}

function customerLine(info: unknown): string {
  const status = str(path(info, "customerVatStatus"));
  const id =
    taxNumber(path(info, "customerVatData", "customerTaxNumber")) ??
    str(path(info, "customerVatData", "communityVatNumber")) ??
    str(path(info, "customerVatData", "thirdStateTaxId"));
  const name = str(path(info, "customerName"));
  if (!id && !name) return status === "PRIVATE_PERSON" ? "magánszemély (név és adószám nélkül)" : "nincs megadva";
  return [id ?? "adószám nélkül", name ?? "név nélkül"].join(" ");
}

function lineText(line: unknown): string {
  const desc = str(path(line, "lineDescription")) ?? "leírás nélkül";
  const qty = str(path(line, "quantity"));
  const unit = str(path(line, "unitOfMeasureOwn")) ?? str(path(line, "unitOfMeasure"));
  const net = str(path(line, "lineAmountsNormal", "lineNetAmountData", "lineNetAmount"));
  const gross =
    str(path(line, "lineAmountsNormal", "lineGrossAmountData", "lineGrossAmountNormal")) ??
    str(path(line, "lineAmountsSimplified", "lineGrossAmountSimplified"));
  const amount = [net && `nettó ${net}`, gross && `bruttó ${gross}`].filter(Boolean).join(", ");
  return [desc, qty && `${qty}${unit ? ` ${unit}` : ""}`, amount].filter(Boolean).join(": ");
}

/** One invoice (or one invoice of a batch) as summary lines. */
function invoiceLines(index: number, invoice: unknown, operation: string): string[] {
  const head = path(invoice, "invoiceHead");
  const supplierTax = taxNumber(path(head, "supplierInfo", "supplierTaxNumber"));
  const supplierName = str(path(head, "supplierInfo", "supplierName"));
  if (!supplierTax || !supplierName) throw new UnreadableOperation(index, "hiányzik az eladó adószáma vagy neve");
  const currency = str(path(head, "invoiceDetail", "currencyCode"));
  const summary = path(invoice, "invoiceSummary");
  const gross = str(path(summary, "summaryGrossData", "invoiceGrossAmount"));
  if (!currency || !gross) throw new UnreadableOperation(index, "hiányzik a pénznem vagy a bruttó végösszeg");
  const net = str(path(summary, "summaryNormal", "invoiceNetAmount"));
  const vat = str(path(summary, "summaryNormal", "invoiceVatAmount"));
  const totals = net && vat
    ? `Nettó ${net} ${currency}, áfa ${vat} ${currency}, bruttó ${gross} ${currency}`
    : `Bruttó ${gross} ${currency} (egyszerűsített számla: nettó és áfa külön nincs)`;

  const out = [`   Eladó: ${supplierTax} ${supplierName}`, `   Vevő: ${customerLine(path(head, "customerInfo"))}`, `   ${totals}`];
  const ref = path(invoice, "invoiceReference");
  if (operation !== "CREATE" || ref) {
    const original = str(path(ref, "originalInvoiceNumber"));
    const modIndex = str(path(ref, "modificationIndex"));
    out.push(`   Eredeti számla: ${original ?? "NINCS MEGADVA"}${modIndex ? ` (módosítás sorszáma: ${modIndex})` : ""}`);
  }
  const lines = (path(invoice, "invoiceLines", "line") as unknown[] | undefined) ?? [];
  out.push(`   Tételek: ${lines.length}`);
  lines.slice(0, MAX_LINES_LISTED).forEach((l, i) => out.push(`     ${str(path(l, "lineNumber")) ?? i + 1}. ${lineText(l)}`));
  if (lines.length > MAX_LINES_LISTED) out.push(`     és még ${lines.length - MAX_LINES_LISTED} tétel`);
  return out;
}

export interface InvoiceOperation {
  index: number;
  operation: string;
  invoiceData: string;
}

/** The manage_invoice summary, one block per operation. Throws UnreadableOperation for the first unreadable one. */
export function summarizeInvoiceOperations(baseUrl: string, operations: InvoiceOperation[], compressed: boolean): string {
  const out = [environmentLine(baseUrl), "", `Számla-adatszolgáltatás a NAV-nak (manage_invoice), ${operations.length} művelet:`];
  for (const op of operations) {
    const data = node(decode(op.index, op.invoiceData, compressed).InvoiceData);
    if (!data) throw new UnreadableOperation(op.index, "nem InvoiceData dokumentum");
    const number = str(data.invoiceNumber);
    const issued = str(data.invoiceIssueDate);
    if (!number || !issued) throw new UnreadableOperation(op.index, "hiányzik a számlaszám vagy a kelt");
    out.push("", `#${op.index} ${op.operation}: számlaszám ${number}, kelt ${issued}`);
    const main = path(data, "invoiceMain");
    const single = path(main, "invoice");
    const batch = (path(main, "batchInvoice") as unknown[] | undefined) ?? [];
    if (single) {
      out.push(...invoiceLines(op.index, single, op.operation));
    } else if (batch.length) {
      out.push(`   Kötegelt módosító okirat, ${batch.length} számlára:`);
      for (const b of batch) {
        out.push(`  [köteg ${str(path(b, "batchIndex")) ?? "?"}]`, ...invoiceLines(op.index, path(b, "invoice"), op.operation));
      }
    } else {
      throw new UnreadableOperation(op.index, "nincs benne számla (invoiceMain)");
    }
  }
  return out.join("\n");
}

// The annulment codes, as the NAV schema (invoiceAnnulment.xsd) describes them.
const ANNULMENT_CODES: Record<string, string> = {
  ERRATIC_DATA: "hibás adattartalom",
  ERRATIC_INVOICE_NUMBER: "hibás számlaszám",
  ERRATIC_INVOICE_ISSUE_DATE: "hibás kiállítási dátum",
  ERRATIC_ELECTRONIC_HASH_VALUE: "hibás elektronikus számla hash érték",
};

export interface AnnulmentOperation {
  index: number;
  annulmentData: string;
}

/**
 * The manage_annulment summary. The closing note is from the NAV interface specification (Online Számla interfész
 * specifikáció v3.0, the technical annulment section, point 8): every technical annulment needs a web user's approval
 * after it is processed; until then its status is VERIFICATION_PENDING.
 */
export function summarizeAnnulmentOperations(baseUrl: string, operations: AnnulmentOperation[]): string {
  const out = [environmentLine(baseUrl), "", `Technikai érvénytelenítés a NAV-nál (manage_annulment), ${operations.length} művelet:`];
  for (const op of operations) {
    const a = node(decode(op.index, op.annulmentData, false).InvoiceAnnulment);
    if (!a) throw new UnreadableOperation(op.index, "nem InvoiceAnnulment dokumentum");
    const ref = str(a.annulmentReference);
    const code = str(a.annulmentCode);
    if (!ref || !code) throw new UnreadableOperation(op.index, "hiányzik a számlaszám vagy az érvénytelenítés kódja");
    const meaning = ANNULMENT_CODES[code];
    out.push(
      "",
      `#${op.index} számlaszám ${ref}`,
      `   Kód: ${code}${meaning ? ` (${meaning})` : " (a NAV sémájában nem szereplő kód)"}`,
      `   Ok: ${str(a.annulmentReason) ?? "nincs megadva"}`,
    );
  }
  out.push(
    "",
    "A technikai érvénytelenítés a beküldéssel még nem él: a NAV feldolgozása után az Online Számla webes felületén " +
      "jóvá kell hagyni (addig a státusza VERIFICATION_PENDING). Elutasítás esetén a számlák érvényesek maradnak.",
  );
  return out.join("\n");
}
