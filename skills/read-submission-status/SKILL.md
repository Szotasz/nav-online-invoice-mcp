---
name: read-submission-status
description: Read whether an invoice data report sent to the NAV was accepted. Use after manage_invoice or manage_annulment returned a transaction ID, when the user asks whether an invoice reached the NAV, or before telling anyone that a submission succeeded.
---

# Was the submission accepted?

Sources, all in the NAV's official repository (nav-gov-hu/Online-Invoice):
- [SPEC] `docs/API docs/hu/Online_Szamla_interfesz specifikacio_HU_v3.0. (2026.02.12).pdf`
- [API] `src/schemas/nav/gov/hu/OSA/invoiceApi.xsd`

## A transaction ID is not an acceptance

`manage_invoice` and `manage_annulment` return a transaction ID as soon as the NAV has taken the request in. The invoice data itself is processed afterwards, asynchronously. The submission is not complete until the client has checked the result and received the receipt for each invoice ([SPEC] 1.1, "A számlaadat-szolgáltatás folyamata").

The client may ask for the status as often as it likes ([SPEC] 1.1). Use `query_transaction_status` with the `transactionId`.

`submit_and_wait` sends like `manage_invoice` (the same confirmation first) and then asks for the status itself, for at most 45 seconds. Its answer follows the same rules: only `DONE` is an acceptance. If it says processing has not finished, continue with `query_transaction_status`; the data has already been sent, so do not send it again.

## The status of each invoice

The answer has one result per invoice. In a batch, match the results to the request by the `index` of each operation ([SPEC] 1.8.8.2, point 2).

The `invoiceStatus` of each invoice ([SPEC] 1.8.8.2, point 3; [API] `InvoiceStatusType`):
- **`RECEIVED`**: taken in. The schema's Hungarian label is "Befogadva", but this is not an acceptance: processing has not started.
- **`PROCESSING`**: processing has started.
- **`SAVED`**: no blocking error so far, and the invoice is saved, but processing has not finished.
- **`DONE`**: processing finished successfully.
- **`ABORTED`**: processing failed.

Only `DONE` counts as a completed report ([SPEC] 1.8.8.2, point 3). Until every invoice is `DONE` or `ABORTED`, keep checking, and do not report success.

## Messages that come with the status

The NAV can attach messages to each invoice ([SPEC] 1.1):
- **`ERROR`**: a blocking error. A technical or serious business error that prevents the report from being accepted.
- **`WARN`**: a warning. It does not block acceptance, but the invoice or the report is, or may be, wrong in content.
- **`INFO`**: information.

Within `DONE`, a report is correct in business terms only if the answer has no `businessValidationMessages` for it ([SPEC] 1.8.8.2, point 3). So `DONE` with a `WARN` is accepted, but tell the user about the warning: the data may need a correction.

Technical validation messages (`technicalValidationMessages`) mean a schema violation or another technical error ([SPEC] 1.8.8.2, point 4).

## What to tell the user

- **`DONE` without messages:** accepted.
- **`DONE` with `WARN`:** accepted, with a warning. Quote the message, and see `choose-correction-path` if the data must be fixed.
- **`ABORTED`:** not accepted ([SPEC] 1.8.8.2, point 3), so there is nothing at the NAV to modify, cancel or annul. Every correction path assumes an accepted report: a technical annulment applies only to a report that reached `DONE` ([SPEC] 2.4.1, point 1), and the specification advises sending a modification only after the original report's `DONE` ([SPEC] 2.5). Read every message of that invoice, not only the first, fix the data, and send the same operation again with `manage_invoice` (for a new invoice, `CREATE`). Do not use `choose-correction-path` for it.
- **Anything else:** not finished yet. Check again later.
