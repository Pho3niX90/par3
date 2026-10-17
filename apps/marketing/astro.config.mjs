import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://par3.paritylabs.co.za",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
  // Par3 uses Parity Labs' own policies; the old page paths keep working.
  redirects: {
    "/legal": "https://paritylabs.co.za/terms",
    "/privacy-policy": "https://paritylabs.co.za/privacy",
    "/terms-of-service": "https://paritylabs.co.za/terms",
    "/security-policy": "https://github.com/Pho3niX90/t3code/security",
    "/app": "https://app.paritylabs.co.za",
  },
});
