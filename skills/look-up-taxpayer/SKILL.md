---
name: look-up-taxpayer
description: Look up a Hungarian taxpayer at the NAV by tax number and read the answer correctly. Use when the user gives a Hungarian tax number, before putting a buyer's tax number on an invoice, or when asked whether a tax number is valid.
---

# Looking up a taxpayer

Source: the NAV's official repository (nav-gov-hu/Online-Invoice), [SPEC] `docs/API docs/hu/Online_Szamla_interfesz specifikacio_HU_v3.0. (2026.02.12).pdf`, sections 1.8.9.1 and 1.8.9.2.

## The request: the first 8 digits

`query_taxpayer` takes the **first 8 digits** of a Hungarian tax number, the taxpayer ID (pattern: exactly 8 digits) ([SPEC] 1.8.9.1).
- A full Hungarian tax number has three parts: the 8-digit `taxpayerId`, the 1-digit `vatCode` and the 2-digit `countyCode` ([SPEC] 1.8.9.2, the patterns of `taxNumberDetail`). Send only the first part.
- Only Hungarian tax numbers can be checked ([SPEC] 1.8.9.1, point 1). An EU VAT number or a foreign tax ID cannot be looked up here.
- Never guess or complete missing digits. If the user gave fewer than 8 digits, ask for the full number.

## The answer

Per [SPEC] 1.8.9.2:
- **Point 1:** `taxpayerValidity` is `true` if the tax number exists, and `false` if it is not valid or does not exist.
- **Point 2:** `taxpayerData` is returned only if the tax number exists. The taxpayer's full name is always known.
- **Point 6:** `taxNumberDetail` holds the taxpayer's **full** tax number, in the format the invoice data schema uses: `taxpayerId`, `vatCode` and `countyCode`.
- **Point 7:** the addresses are a list, as one taxpayer can have several. `HQ` is the registered office, `SITE` a site, `BRANCH` a branch.
- **Point 8:** `incorporation` is the economic type: `ORGANIZATION` (a company), `SELF_EMPLOYED` (a sole trader) or `TAXABLE_PERSON` (a private person with a tax number).
- **Point 3:** `vatGroupMembership` is the taxpayer's VAT group, if they belong to one.
- **Point 5:** `infoDate` is when the taxpayer's data last changed.

## Using it on an invoice

- Take the full tax number from `taxNumberDetail`. Do not use the 8 digits you sent as if they were the full tax number.
- Take the name and the address from the answer rather than from memory. Ask which address applies if there are several.
- If `taxpayerValidity` is `false`, tell the user before anything is invoiced: the number is not valid or does not exist at the NAV.
