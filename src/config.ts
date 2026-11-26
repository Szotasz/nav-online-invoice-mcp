import type { NavConfig } from "./types.js";

// The NAV connection settings, in one place for both entry points. A value in `config` (the Smithery config) wins,
// then the environment; the CLI passes no config, so it reads the environment only.
export function getConfig(config?: Partial<Record<string, string>>): NavConfig {
  const get = (key: string): string | undefined =>
    config?.[key] || process.env[key];

  const required = (key: string): string => {
    const val = get(key);
    if (!val) throw new Error(`Missing required config: ${key}`);
    return val;
  };

  const env = get("NAV_ENV");
  const isTest = env === "test";
  const baseUrl = isTest
    ? "https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3"
    : "https://api.onlineszamla.nav.gov.hu/invoiceService/v3";

  return {
    login: required("NAV_LOGIN"),
    password: required("NAV_PASSWORD"),
    taxNumber: required("NAV_TAX_NUMBER"),
    signatureKey: required("NAV_SIGNATURE_KEY"),
    exchangeKey: required("NAV_EXCHANGE_KEY"),
    baseUrl: get("NAV_BASE_URL") || baseUrl,
    softwareId: get("NAV_SOFTWARE_ID") || "NAVONLINEINVMCP-01",
    softwareName: get("NAV_SOFTWARE_NAME") || "nav-online-invoice-mcp",
    softwareVersion: get("NAV_SOFTWARE_VERSION") || "2.0.0",
    softwareDevName: get("NAV_SOFTWARE_DEV_NAME") || "MCP Developer",
    softwareDevContact: get("NAV_SOFTWARE_DEV_CONTACT") || "dev@example.com",
    softwareDevCountryCode: get("NAV_SOFTWARE_DEV_COUNTRY") || "HU",
    softwareDevTaxNumber: get("NAV_SOFTWARE_DEV_TAX_NUMBER") || get("NAV_TAX_NUMBER") || "00000000",
  };
}
