# NAV Online Számla MCP Szerver

MCP (Model Context Protocol) szerver a magyar NAV Online Számla API v3.0-hoz.

Ez a szerver lehetővé teszi, hogy AI asszisztensek (pl. Claude) lekérdezzék és kezeljék a számlákat a NAV Online Számla rendszeren keresztül.

## Funkciók

### Lekérdező eszközök (csak olvasás)
- **query_taxpayer** - Adózói adatok lekérdezése adószám alapján
- **query_invoice_data** - Számla részletes adatainak lekérdezése számlaszám alapján
- **query_invoice_digest** - Számlák keresése szűrőkkel (dátum, partner, kategória stb.)
- **query_invoice_check** - Számla létezésének ellenőrzése a rendszerben
- **query_invoice_chain_digest** - Számla módosítási láncának megtekintése
- **query_transaction_status** - Beküldött számlák feldolgozási állapotának ellenőrzése
- **query_transaction_list** - Tranzakciók listázása dátumtartomány alapján

### Írási eszközök
- **manage_invoice** - Számlák beküldése (CREATE, MODIFY, STORNO)
- **manage_annulment** - Számlák technikai érvénytelenítése

## Előfeltételek

NAV Online Számla technikai felhasználó szükséges. Regisztráció:
- **Teszt**: https://onlineszamla-test.nav.gov.hu/
- **Éles**: https://onlineszamla.nav.gov.hu/

## Telepítés

### 1. Telepítés

```bash
npm install
npm run build
```

### 2. Konfigurálás

Másold az `.env.example` fájlt `.env` néven és töltsd ki az adataidat:

```bash
cp .env.example .env
```

Szükséges környezeti változók:
| Változó | Leírás |
|---|---|
| `NAV_LOGIN` | Technikai felhasználó login |
| `NAV_PASSWORD` | Technikai felhasználó jelszó |
| `NAV_TAX_NUMBER` | 8 jegyű adószám |
| `NAV_SIGNATURE_KEY` | Aláíró kulcs a NAV-tól |
| `NAV_EXCHANGE_KEY` | Cserekulcs a NAV-tól |
| `NAV_ENV` | `test` vagy `production` |

### 3. Hozzáadás a Claude Code-hoz

Add hozzá a `~/.claude/settings.json` fájlhoz:

```json
{
  "mcpServers": {
    "nav-online-invoice": {
      "command": "node",
      "args": ["/elérési/út/nav-online-invoice-mcp/dist/index.js"],
      "env": {
        "NAV_LOGIN": "felhasználónév",
        "NAV_PASSWORD": "jelszó",
        "NAV_TAX_NUMBER": "12345678",
        "NAV_SIGNATURE_KEY": "aláíró_kulcs",
        "NAV_EXCHANGE_KEY": "cserekulcs",
        "NAV_ENV": "test"
      }
    }
  }
}
```

## Használati példák

Konfigurálás után a következőket kérdezheted Claude-tól:

- "Keress rá erre az adószámra: 12345678"
- "Listázd ki a kiállított számlákat 2024 januárból"
- "Kérd le az INV-001 számla részleteit"
- "Mi a feldolgozási állapota ennek a tranzakciónak: TX123"

## API referencia

Ez a szerver a [NAV Online Invoice API v3.0](https://github.com/nav-gov-hu/Online-Invoice) implementációja.

### Hitelesítés

Minden kérés automatikusan aláírásra kerül SHA-512 (jelszó) és SHA3-512 (kérés aláírás) használatával. A token csere az írási műveleteknél automatikusan történik.

### Környezetek

| Környezet | API URL |
|---|---|
| Teszt | `https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3` |
| Éles | `https://api.onlineszamla.nav.gov.hu/invoiceService/v3` |

---

# NAV Online Invoice MCP Server (English)

MCP (Model Context Protocol) server for the Hungarian NAV Online Invoice (Online Számla) API v3.0.

This server allows AI assistants like Claude to query and manage invoices through the NAV Online Invoice system.

## Features

### Query Tools (read-only)
- **query_taxpayer** - Look up taxpayer information by tax number
- **query_invoice_data** - Get full invoice details by invoice number
- **query_invoice_digest** - Search invoices with filters (date, partner, category, etc.)
- **query_invoice_check** - Check if an invoice exists in the system
- **query_invoice_chain_digest** - View modification chain of an invoice
- **query_transaction_status** - Check processing status of submitted invoices
- **query_transaction_list** - List transactions within a date range

### Write Tools
- **manage_invoice** - Submit invoices (CREATE, MODIFY, STORNO)
- **manage_annulment** - Technical annulment of invoices

## Prerequisites

You need a NAV Online Invoice technical user. Register at:
- **Test**: https://onlineszamla-test.nav.gov.hu/
- **Production**: https://onlineszamla.nav.gov.hu/

## Setup

### 1. Install

```bash
npm install
npm run build
```

### 2. Configure

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required environment variables:
| Variable | Description |
|---|---|
| `NAV_LOGIN` | Technical user login |
| `NAV_PASSWORD` | Technical user password |
| `NAV_TAX_NUMBER` | 8-digit taxpayer number |
| `NAV_SIGNATURE_KEY` | Signature key from NAV |
| `NAV_EXCHANGE_KEY` | Exchange key from NAV |
| `NAV_ENV` | `test` or `production` |

### 3. Add to Claude Code

Add to your `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "nav-online-invoice": {
      "command": "node",
      "args": ["/path/to/nav-online-invoice-mcp/dist/index.js"],
      "env": {
        "NAV_LOGIN": "your_login",
        "NAV_PASSWORD": "your_password",
        "NAV_TAX_NUMBER": "12345678",
        "NAV_SIGNATURE_KEY": "your_signature_key",
        "NAV_EXCHANGE_KEY": "your_exchange_key",
        "NAV_ENV": "test"
      }
    }
  }
}
```

## Usage Examples

Once configured, you can ask Claude:

- "Look up this tax number: 12345678"
- "List invoices issued in January 2024"
- "Get the details of invoice INV-001"
- "What is the processing status of transaction TX123"

## API Reference

This server implements the [NAV Online Invoice API v3.0](https://github.com/nav-gov-hu/Online-Invoice).

### Authentication

All requests are automatically signed using SHA-512 (password) and SHA3-512 (request signature). Token exchange for write operations is handled automatically.

### Environments

| Environment | API URL |
|---|---|
| Test | `https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3` |
| Production | `https://api.onlineszamla.nav.gov.hu/invoiceService/v3` |

## License

MIT
