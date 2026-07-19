import "@testing-library/jest-dom/vitest";
import { afterEach, expect, beforeAll } from "vitest";
import { cleanup } from "@testing-library/react";
import { toHaveNoViolations } from "jest-axe";
import { initRendererI18n } from "../../src/renderer/i18n";

expect.extend(toHaveNoViolations);

// vitest.dom.config.ts doesn't enable `test.globals`, so @testing-library/react's
// automatic afterEach(cleanup) registration (which checks for a global afterEach)
// never fires — wire it up explicitly instead.
afterEach(cleanup);

// Initialize renderer i18next once before any component test runs so that
// useTranslation() returns English source strings (matching pre-i18n behavior).
beforeAll(async () => {
  await initRendererI18n("en");
});
