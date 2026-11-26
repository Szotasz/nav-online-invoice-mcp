---
name: test-and-production
description: Tell the NAV test environment from production, and know which one this server sends to. Use before any manage_invoice or manage_annulment call, when the user asks whether something goes to the real NAV, or when setting up NAV_ENV and the credentials.
---

# Test or production NAV

Sources:
- [SPEC] the NAV's official repository (nav-gov-hu/Online-Invoice), `docs/API docs/hu/Online_Szamla_interfesz specifikacio_HU_v3.0. (2026.02.12).pdf`;
- this server's own code: `src/config.ts` and `src/summaries.ts`.

## Two separate systems

The NAV runs a user test environment and a production environment, each with its own web interface and its own API address ([SPEC] chapter 6, sections 6.1 and 6.2):
- **test:** the API host is `api-test.onlineszamla.nav.gov.hu`, the web interface is `onlineszamla-test.nav.gov.hu`;
- **production:** the API host is `api.onlineszamla.nav.gov.hu`, the web interface is `onlineszamla.nav.gov.hu`.

They do not share anything. A registration in the test environment does not replace one in production, and technical users and keys created in the test environment cannot be used in production ([SPEC] "Adózókra vonatkozó használati követelmények", the closing paragraph).

So a working test setup says nothing about production. Each needs:
- its own registration;
- its own technical user;
- its own signature key and exchange key ([SPEC] same section, points 1 to 3).

## Which one this server uses

- **`NAV_ENV=test`** sends to the test environment. **Any other value, or no `NAV_ENV` at all, sends to production** (`src/config.ts`). Production is the default.
- **`NAV_BASE_URL`**, when set, overrides both.

## Check before sending

Every summary that `manage_invoice` or `manage_annulment` shows before sending starts with the environment, in capitals (`src/summaries.ts`):
- **`>>> ÉLES NAV <<<`**: production;
- **`>>> TESZT NAV <<<`**: the test environment.

Only the NAV test host is called TESZT. A custom `NAV_BASE_URL` is called ÉLES, because it may lead to production.

Read that first line to the user before they confirm. If the client cannot ask for the confirmation itself, the tool returns the summary and a `confirmation_id` instead: show that summary to the user word for word, and send the `confirmation_id` only after their explicit yes. If they meant to test and it says ÉLES, stop: nothing has been sent yet. Fix `NAV_ENV`, and restart the server.
