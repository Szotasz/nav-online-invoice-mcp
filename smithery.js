export default function startCommand(config) {
  const env = {
    NAV_LOGIN: config.NAV_LOGIN,
    NAV_PASSWORD: config.NAV_PASSWORD,
    NAV_TAX_NUMBER: config.NAV_TAX_NUMBER,
    NAV_SIGNATURE_KEY: config.NAV_SIGNATURE_KEY,
    NAV_EXCHANGE_KEY: config.NAV_EXCHANGE_KEY,
    NAV_ENV: config.NAV_ENV || "test",
  };

  if (config.NAV_SOFTWARE_ID) env.NAV_SOFTWARE_ID = config.NAV_SOFTWARE_ID;
  if (config.NAV_SOFTWARE_DEV_NAME) env.NAV_SOFTWARE_DEV_NAME = config.NAV_SOFTWARE_DEV_NAME;
  if (config.NAV_SOFTWARE_DEV_CONTACT) env.NAV_SOFTWARE_DEV_CONTACT = config.NAV_SOFTWARE_DEV_CONTACT;
  if (config.NAV_SOFTWARE_DEV_TAX_NUMBER) env.NAV_SOFTWARE_DEV_TAX_NUMBER = config.NAV_SOFTWARE_DEV_TAX_NUMBER;

  return {
    command: "node",
    args: ["dist/index.js"],
    env,
  };
}
