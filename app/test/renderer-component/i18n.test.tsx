import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { useTranslation } from "react-i18next";
import { initRendererI18n, changeRendererLanguage } from "../../src/renderer/i18n";

function Probe() {
  const { t } = useTranslation(["tabs", "common"]);
  return (
    <div>
      <span data-testid="live">{t("tabs:live")}</span>
      <span data-testid="clear">{t("common:clear")}</span>
    </div>
  );
}

describe("renderer i18n", () => {
  beforeEach(async () => {
    await initRendererI18n("en");
  });

  it("renders English translations", () => {
    render(<Probe />);
    expect(screen.getByTestId("live").textContent).toBe("Live");
    expect(screen.getByTestId("clear").textContent).toBe("Clear");
    cleanup();
  });

  it("changeRendererLanguage updates the rendered text (en → zh-CN)", async () => {
    render(<Probe />);
    expect(screen.getByTestId("live").textContent).toBe("Live");
    // zh-CN/tabs.json now contains "实时" for live.
    await changeRendererLanguage("zh-CN");
    // react-i18next triggers a re-render on language change; wait for it
    // to flush before asserting, since the awaited Promise may resolve
    // just before React commits the new state.
    await waitFor(() => {
      expect(screen.getByTestId("live").textContent).toBe("实时");
    });
    expect(screen.getByTestId("clear").textContent).toBe("清除");
    cleanup();
  });
});
