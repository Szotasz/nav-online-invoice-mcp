---
name: choose-correction-path
description: Choose how to correct an invoice already reported to the NAV - a modification (MODIFY), a cancellation (STORNO) or a technical annulment (manage_annulment). Use when an invoice or its data report is wrong, when the user wants to cancel or change an invoice, or before calling manage_annulment.
---

# MODIFY, STORNO or technical annulment

Sources, all in the NAV's official repository (nav-gov-hu/Online-Invoice):
- [SPEC] `docs/API docs/hu/Online_Szamla_interfesz specifikacio_HU_v3.0. (2026.02.12).pdf`
- [API] `src/schemas/nav/gov/hu/OSA/invoiceApi.xsd`
- [ANNUL] `src/schemas/nav/gov/hu/OSA/invoiceAnnulment.xsd`

First decide what is wrong: **the invoice itself**, or **only the data report** about a correct invoice.

## The invoice is wrong: MODIFY or STORNO

A modification or a cancellation of an invoice is a separate document. It is reported with `manage_invoice` ([SPEC] 2.5; [API] `ManageInvoiceOperationType`):
- **`MODIFY`**: a report about a document that modifies the original invoice ([SPEC] 2.5.2).
- **`STORNO`**: a report about the cancellation of the original invoice ([SPEC] 2.5.1).

The rules:
- A modifying document cannot itself be modified. If a modification was wrong, report another modification of the original invoice ([SPEC] 2.5).
- If the original invoice has a report, wait for its `DONE` before sending the modification. Processing is asynchronous, so the order of an invoice and its modification sent together is not guaranteed ([SPEC] 2.5).
- Every modification or cancellation needs these ([SPEC] 2.5.1 and 2.5.2, points 1 to 3 and 6):
  - its own invoice number and issue date;
  - the original invoice's number (`invoiceReference/originalInvoiceNumber`);
  - the `modificationIndex`, which is 1 for the first modification.
- A cancellation of an invoice that was not modified before repeats the original lines with the quantities negated. Its `invoiceSummary` has the amounts with the opposite sign ([SPEC] 2.5.1).
- Cancelling an invoice and issuing a new, correct one makes both documents modifying documents of the original invoice ([SPEC] 2.5).

## Only the data report is wrong: technical annulment

A technical annulment (`manage_annulment`) is for when the invoice describes the transaction correctly, but its data report reached the NAV with wrong data because of a technical error. It is **not** the same as a cancellation (STORNO) ([SPEC] 2.4).

The rules ([SPEC] 2.4.1):
- **Point 1:** it can be applied only to a report that already reached `DONE`, with at most warnings (`WARN`).
- **Point 2:** at most 100 annulments per request. Annulments cannot be mixed with CREATE/MODIFY/STORNO in one request.
- **Point 4:** it is matched by the invoice number, given in `annulmentReference`.
- **Point 5:** annulling an original invoice's report also annuls the reports of all its modifications.
- **Point 6:** annulling a modification's report annuls only that one.
- **Points 8 and 9:** **it needs approval.** After it is processed, a web user approves each technical annulment on the Online Számla interface. The section introduction says this must be a user with the right permission. Until then its `annulmentVerificationStatus` is `VERIFICATION_PENDING` ([SPEC] 1.8.8.2, point 8). After approval, the invoice number can be used again.
- **Point 10:** it is not possible when the report is itself the electronic invoice (`completenessIndicator` = true). The section introduction says the same if such a report is anywhere in the invoice's chain.

What the approval states mean ([SPEC] 1.8.8.2, point 8):
- **`VERIFICATION_DONE`:** approved.
- **`VERIFICATION_REJECTED`:** rejected. Nothing happened; the invoices stay valid.
- **`NOT_VERIFIABLE`:** an index got `ERROR`, so the whole annulment is rejected and must be sent again after the fix.

The annulment code says what was wrong ([ANNUL] `AnnulmentCodeType`):
- `ERRATIC_DATA`: wrong data content;
- `ERRATIC_INVOICE_NUMBER`: wrong invoice number;
- `ERRATIC_INVOICE_ISSUE_DATE`: wrong issue date;
- `ERRATIC_ELECTRONIC_HASH_VALUE`: wrong electronic invoice hash.

## Before sending

Both write tools show the user a summary and wait for a confirmation before anything is sent. The first line of the summary names the NAV environment (see `test-and-production`). Tell the user which path you chose and why, in one sentence, before the confirmation. Then check the result with `query_transaction_status` (see `read-submission-status`).
