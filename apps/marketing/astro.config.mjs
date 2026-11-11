import { defineConfig } from "astro/config";

import { LOCALES } from "./src/i18n/locales.ts";

// Astro loads env with an empty prefix, and under `vp run` Vite+'s loadEnv then reports every
// variable to the task cache. Any env difference (TERM, VP_RAW_SUBCOMMAND, an agent's session
// vars) would rerun `astro check`. Without the runner client, loadEnv reads process.env directly;
// file tracking does not use this client.
delete process.env.VP_RUN_NODE_CLIENT_PATH;

// Astro reads this when it records an event, after the config loads, so no CLI telemetry is sent.
process.env.ASTRO_TELEMETRY_DISABLED = "1";

export default defineConfig({
  site: "https://t3.codes",
  // Vercel 308s `/path/` to `/path` (see vercel.ts), so every internal link and canonical uses one form.
  trailingSlash: "never",
  // English stays unprefixed at `/`; see src/i18n/locales.ts for each locale's URL segment.
  i18n: {
    defaultLocale: "en",
    locales: LOCALES.map(({ code, path }) =>
      !path || path === code ? code : { path, codes: [code] },
    ),
    routing: { prefixDefaultLocale: false },
  },
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
