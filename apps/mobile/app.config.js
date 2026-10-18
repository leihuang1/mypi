const fs = require("node:fs");
const path = require("node:path");

module.exports = ({ config }) => {
  const projectId = process.env.MYPI_EAS_PROJECT_ID || config.extra?.eas?.projectId;
  const googleServicesFile = process.env.MYPI_GOOGLE_SERVICES_FILE || "./google-services.json";
  return {
    ...config,
    extra: { ...config.extra, ...(projectId ? { eas: { ...config.extra?.eas, projectId } } : {}) },
    android: {
      ...config.android,
      ...(fs.existsSync(path.resolve(__dirname, googleServicesFile)) ? { googleServicesFile } : {}),
    },
  };
};
