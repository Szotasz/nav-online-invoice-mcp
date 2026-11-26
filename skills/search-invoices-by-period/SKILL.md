---
name: search-invoices-by-period
description: List the invoices issued or received in a period, page by page, and follow an invoice's modification chain. Use when the user asks for the invoices of a month or quarter, for all invoices from or to a partner, or for every modification of one invoice.
---

# Searching invoices for a period

Source: the NAV's official repository (nav-gov-hu/Online-Invoice), [SPEC] `docs/API docs/hu/Online_Szamla_interfesz specifikacio_HU_v3.0. (2026.02.12).pdf`, sections 1.8.6 and 1.8.3.

## The direction

`invoiceDirection` sets which side of the invoice you are on:
- **`OUTBOUND`**: the invoices you issued;
- **`INBOUND`**: the invoices you received.

In `query_invoice_digest`, the partner filters `taxNumber` and `name` look at the other side ([SPEC] 1.8.6.1, point 6):
- with `OUTBOUND`, they search the buyer;
- with `INBOUND`, they search the issuer.

The `name` filter matches the start of a word if it is at least 5 characters long, and is not case sensitive ([SPEC] 1.8.6.1, point 7).

## The period: one of three keys, at most 35 days

`query_invoice_digest` needs exactly one of three main search keys ([SPEC] 1.8.6.1, point 2). In this server's tool:
- **`dateFrom` / `dateTo`:** the issue date of the invoice or modifying document, as calendar days.
- **`insDateTimeFrom` / `insDateTimeTo`:** when the NAV processed it, in UTC.
- **`originalInvoiceNumber`:** the invoice and every document that modifies it.

A date range may span at most 35 days (840 hours); a longer one is refused with an error code ([SPEC] 1.8.6.1, point 3). For a quarter or a year, split the period into windows of 35 days or less, and search each.

When `from` equals `to`, an issue-date search covers that whole day; an `insDate` search covers that exact moment ([SPEC] 1.8.6.1, point 4).

## Pages

- `page` starts at 1. The server decides the page size and the order; the client cannot choose either ([SPEC] 1.8.6.1, point 1).
- The answer gives `availablePage`. Keep asking with a higher `page` until you have them all. A page holds at most 100 items. `availablePage` is 0 when nothing matched ([SPEC] 1.8.6.2, point 1).
- This search lists an invoice that was validly reported more than once, once per report. Tell them apart by `transactionId` ([SPEC] 1.8.6.2, point 2).

The list is a summary. For an invoice's full data, call `query_invoice_data` for it.

## An invoice's modification chain

`query_invoice_chain_digest` lists an original invoice and the documents that modify or cancel it.
- **`invoiceNumber`:** the original invoice's number. It need not exist at the NAV: modifications without an original are listed too, if they refer to that number ([SPEC] 1.8.3.1, point 1).
- **`invoiceDirection` is required.** With `OUTBOUND`, your tax number must be the issuer's on the invoice; with `INBOUND`, the buyer's. An invoice without the buyer's tax number cannot be found from the buyer's side, only from the issuer's ([SPEC] 1.8.3.1, point 2).
- **Pages:** the same as above, at most 100 items each ([SPEC] 1.8.3.2, point 1).
- **`invoiceReferenceData`:** for modifications and cancellations only. From invoice version 2.0 on it carries `modificationIndex`, the order of the modifications ([SPEC] 1.8.3.2, point 4).
