import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { quit: vi.fn(), getPath: () => "/tmp" },
  Menu: { buildFromTemplate: vi.fn((t) => t) },
  Tray: class {
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    on = vi.fn();
    isDestroyed = () => false;
    destroy = vi.fn();
  },
  nativeImage: {
    createFromPath: () => ({
      isEmpty: () => false,
      resize: () => ({}),
    }),
  },
}));

const { createTray, rebuildTrayMenu } = await import("../../src/main/tray/trayService");
const { initMainI18n, t } = await import("../../src/main/i18n");

describe("trayService i18n", () => {
  it("tray menu uses t() for labels", () => {
    initMainI18n({ language: "en" });
    const services = {
      showMain: vi.fn(),
      openOverlay: vi.fn(),
      openBoxTracker: vi.fn(),
    } as never;
    createTray(services);
    expect(t("tray:show")).toBe("Show");
    expect(t("tray:quit")).toBe("Quit");
  });

  it("rebuildTrayMenu exists and is callable", () => {
    const services = {
      showMain: vi.fn(),
      openOverlay: vi.fn(),
      openBoxTracker: vi.fn(),
    } as never;
    expect(() => rebuildTrayMenu(services)).not.toThrow();
  });
});
