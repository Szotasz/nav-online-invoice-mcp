# NAV Online Számla MCP Szerver

MCP (Model Context Protocol) szerver a magyar NAV Online Számla API v3.0-hoz.

Ez a szerver lehetővé teszi, hogy AI asszisztensek (pl. Claude) lekérdezzék és kezeljék a számlákat a NAV Online Számla rendszeren keresztül.

## Távoli használat (connectors.hu)

Ha nem szeretnéd helyben telepíteni, a [connectors.hu](https://connectors.hu) egységes hozzáférési pontot ad a NAV Online Számlához (és további magyar üzleti API-khoz). A connectors.hu kezeli a hitelesítést, és a `nav_*` namespacelt tool-okat hozzáférhetővé teszi az AI ügynököd számára (Claude Code, Claude Desktop, stb.).

**[Csatlakozás a connectors.hu-n](https://connectors.hu)**

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
- **submit_and_wait** - Beküldés, mint a manage_invoice (ugyanazzal a megerősítéssel), majd legfeljebb 45 másodperc várakozás a NAV számlánkénti feldolgozási eredményére. Ha addig nem végez, a tranzakció-azonosítót adja vissza: a státusz a query_transaction_status-szal kérdezhető tovább. A várakozás leállítása a már elküldött adatot nem vonja vissza.
- **manage_annulment** - Számlák technikai érvénytelenítése

### Megerősítés beküldés előtt

A három írási eszköz semmit nem küld a NAV-nak, amíg a felhasználó jóvá nem hagyja:

- Az összefoglaló **első sora a környezet**: `>>> ÉLES NAV <<<` vagy `>>> TESZT NAV <<<`. Ha a `NAV_ENV` nincs megadva, a szerver az éles NAV-ot hívja, és az összefoglaló is ÉLES-t mond. Egyedi `NAV_BASE_URL` esetén is ÉLES-t mond, mert nem tudhatja, hová vezet a cím.
- A `manage_invoice` összefoglalója a beküldendő XML-ből készül, műveletenként: a művelet, a számlaszám, a kelt, az eladó és a vevő adószáma és neve, a nettó, az áfa és a bruttó végösszeg a pénznemmel, MODIFY/STORNO-nál az eredeti számla, és az első öt tétel (a többi darabszámként).
- A `manage_annulment` összefoglalója a számlaszámot, az érvénytelenítés kódját és okát mutatja. Kimondja azt is, hogy a technikai érvénytelenítést a NAV feldolgozása után az Online Számla webes felületén még jóvá kell hagyni (a NAV interfész-specifikációja szerint).
- Ha az XML nem olvasható, nincs összefoglaló, és az eszköz nem küld semmit.
- Megerősítést kérni tudó kliensnél (MCP elicitation) a szerver közvetlenül a felhasználót kérdezi. Csak a bepipált jóváhagyás küld; az elutasítás, a megszakítás, a hiba és az időtúllépés nem.
- Más kliensnél az első hívás csak az összefoglalót és egy `confirmation_id`-t adja vissza. Ugyanazokkal a paraméterekkel és ezzel az azonosítóval hívva megy el a beküldés. Az azonosító egyszer használható, ezekhez a paraméterekhez kötött, és 5 percig érvényes.
- **A valódi kapu a megerősítés-kérés (elicitation).** A tartalék úton a második hívást a modell az összefoglaló megmutatása nélkül is megteheti: az eszköz szövege ezt tiltja, de kikényszeríteni nem tudja.
- Az XML mezőértékeiben a vezérlő- és formázó karakterek (pl. sortörés) szóközzé válnak, így egy érték nem írhat új sort az összefoglalóba. Karakterhivatkozást (`&#...`) tartalmazó értéket a szerver nem küld el, mert a NAV mást olvasna ki belőle, mint amit az összefoglaló mutat.
- Ami nem ment el, arra a válasz kimondja: `nothing sent`.

### Skillek

A szerver az eszközök mellé öt NAV-útmutatót is ad MCP skillként (skills-kiterjesztés, SDK v2.4+), így a skilleket támogató kliens akkor tölti be a szabályokat, amikor szükség van rájuk. Minden állításuk a NAV hivatalos dokumentációjából (nav-gov-hu/Online-Invoice) jön, fejezet- és pontszintű forrással:

- `read-submission-status`: a beküldés státuszának olvasása (csak a `DONE` számít teljesítettnek; `WARN` mellett befogadva, `ERROR` mellett nem).
- `choose-correction-path`: MODIFY, STORNO vagy technikai érvénytelenítés, és hogy az utóbbit a webes felületen jóvá kell hagyni.
- `look-up-taxpayer`: adózó-lekérdezés a 8 jegyű törzsszámmal, és mit ad vissza a válasz.
- `test-and-production`: a teszt és az éles környezet, a `NAV_ENV` (nélküle éles), és az összefoglaló első sora.
- `search-invoices-by-period`: keresés egy időszakra (irány, legfeljebb 35 napos tartomány, lapozás) és a módosítási lánc.

A skilleket még nem támogató kliensnek minden útmutató `skill-<név>` nevű promptként is elérhető. Az útmutatók a `skills/` mappában vannak.

## Előfeltételek

NAV Online Számla technikai felhasználó szükséges. Regisztráció:
- **Teszt**: https://onlineszamla-test.nav.gov.hu/
- **Éles**: https://onlineszamla.nav.gov.hu/

Helyi futtatáshoz Node.js 20 vagy újabb kell (az MCP SDK v2 igénye).

## Helyi telepítés

Ha inkább lokálisan szeretnéd futtatni a szervert:

### 1. Telepítés

```bash
git clone https://github.com/Szotasz/nav-online-invoice-mcp.git
cd nav-online-invoice-mcp
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
      "args": ["/elérési/út/nav-online-invoice-mcp/dist/cli.js"],
      "env": {
        "NAV_LOGIN": "felhasználónév",
        "NAV_PASSWORD": "jelszó",
        "NAV_TAX_NUMBER": "12345678",
        "NAV_SIGNATURE_KEY": "aláíró_kulcs",
        "NAV_EXCHANGE_KEY": "cserekulcs",
        "NAV_ENV": "production"
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

## Támogatás

Ha hasznosnak találod ezt a projektet, támogathatod a fejlesztést:

[![Támogass a Donably-n](https://img.shields.io/badge/T%C3%A1mogat%C3%A1s-Donably-18b8c4)](https://www.donably.com/ai-a-mindennapokban-szabolccsal)

---

# NAV Online Invoice MCP Server (English)

MCP (Model Context Protocol) server for the Hungarian NAV Online Invoice (Online Számla) API v3.0.

This server allows AI assistants like Claude to query and manage invoices through the NAV Online Invoice system.

## Remote Usage (connectors.hu)

If you don't want to install locally, [connectors.hu](https://connectors.hu) provides a unified access point to NAV Online Számla (and other Hungarian business APIs). connectors.hu handles authentication and exposes `nav_*` namespaced tools to your AI agent (Claude Code, Claude Desktop, etc.).

**[Connect via connectors.hu](https://connectors.hu)**

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
- **submit_and_wait** - Submit like manage_invoice (with the same confirmation), then wait up to 45 seconds for NAV's processing result per invoice. If NAV has not finished by then, it returns the transaction ID: continue with query_transaction_status. Stopping the wait does not recall data already sent.
- **manage_annulment** - Technical annulment of invoices

### Confirmation before anything is sent

The three write tools send nothing to NAV until the user approves it:

- The **first line of the summary is the environment**: `>>> ÉLES NAV <<<` (production) or `>>> TESZT NAV <<<` (test). Without `NAV_ENV` the server calls production NAV, and the summary says ÉLES. With a custom `NAV_BASE_URL` it says ÉLES too, as it cannot know where that address leads.
- The `manage_invoice` summary is read from the XML to be sent, per operation: the operation, the invoice number, the issue date, the supplier's and the customer's tax number and name, the net, VAT and gross totals with the currency, the original invoice for MODIFY/STORNO, and the first five lines (the rest counted).
- The `manage_annulment` summary shows the invoice number, the annulment code and the reason. It also says that a technical annulment still has to be approved on the Online Számla web interface after NAV has processed it (per the NAV interface specification).
- If the XML cannot be read, there is no summary, and the tool sends nothing.
- With a client that supports confirmation requests (MCP elicitation), the server asks the user directly. Only an approval with the box checked sends; a decline, a cancel, an error or a timeout does not.
- With other clients the first call returns only the summary and a `confirmation_id`. A second call with the same arguments plus that id sends it. The id is single-use, bound to these arguments, and valid for 5 minutes.
- **The real gate is the confirmation request (elicitation).** On the fallback path the model can make the second call without showing the summary: the tool text forbids it, but cannot enforce it.
- In the XML field values, control and format characters (a newline, for example) become spaces, so a value cannot write a new line into the summary. A value with a character reference (`&#...`) is not sent, because NAV would read another value from it than the summary shows.
- Every answer that did not send says so: `nothing sent`.

### Skills

The server ships five NAV guides with the tools, as MCP skills (the skills extension, SDK v2.4+), so a client that supports skills can load the rules when they are needed. Every statement in them comes from the NAV's official documentation (nav-gov-hu/Online-Invoice), with the section and point as the source:

- `read-submission-status`: reading a submission's status (only `DONE` counts as completed; accepted with `WARN`, not with `ERROR`).
- `choose-correction-path`: MODIFY, STORNO or technical annulment, and that the latter needs approval on the web interface.
- `look-up-taxpayer`: a taxpayer lookup with the 8-digit taxpayer ID, and what the answer holds.
- `test-and-production`: the test and the production environment, `NAV_ENV` (production without it), and the summary's first line.
- `search-invoices-by-period`: a search for a period (direction, at most 35 days per range, pages) and the modification chain.

For clients that do not support skills yet, each guide is also a prompt named `skill-<name>`. The guides are in `skills/`.

## Prerequisites

You need a NAV Online Invoice technical user. Register at:
- **Test**: https://onlineszamla-test.nav.gov.hu/
- **Production**: https://onlineszamla.nav.gov.hu/

Running it locally needs Node.js 20 or later (required by the MCP SDK v2).

## Local Installation

If you prefer to run the server locally:

### 1. Install

```bash
git clone https://github.com/Szotasz/nav-online-invoice-mcp.git
cd nav-online-invoice-mcp
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
      "args": ["/path/to/nav-online-invoice-mcp/dist/cli.js"],
      "env": {
        "NAV_LOGIN": "your_login",
        "NAV_PASSWORD": "your_password",
        "NAV_TAX_NUMBER": "12345678",
        "NAV_SIGNATURE_KEY": "your_signature_key",
        "NAV_EXCHANGE_KEY": "your_exchange_key",
        "NAV_ENV": "production"
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

## Support

If you find this project useful, you can support the development:

[![Support on Donably](https://img.shields.io/badge/Support-Donably-18b8c4)](https://www.donably.com/ai-a-mindennapokban-szabolccsal)

## License

MIT
