import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock electron 的 app.getLocale()，因为 i18n 模块依赖它
vi.mock("electron", () => ({
  app: { getLocale: () => "en-US" },
}));

// Mock node:child_process 的 execSync，让 readGameLanguage 不真的 spawn reg.exe。
// 默认模拟 "游戏未安装"（reg query 抛错）行为；测试用 _setRegOutput 覆盖。
let mockRegOutput: (() => Buffer) | (() => never) = () => {
  throw new Error("reg query failed (mock: game not installed)");
};
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockRegOutput(...(args as [])),
}));

// 动态 import 让 mock 生效
const { initMainI18n, t, changeLanguage, _resetGameLanguageCacheForTests } =
  await import("../../src/main/i18n");

/** 测试 helper：模拟 reg query 返回某个 idx 值。 */
function setRegIdx(idx: number): void {
  mockRegOutput = () =>
    Buffer.from(
      `\r\nHKEY_CURRENT_USER\\Software\\TesseractStudio\\TaskBarHero\r\n    tbh_lang_idx_h1851722218    REG_DWORD    0x${idx.toString(16)}\r\n`,
      "utf-8",
    );
}

function clearRegIdx(): void {
  mockRegOutput = () => {
    throw new Error("reg query failed (mock: game not installed)");
  };
}

describe("main i18n", () => {
  beforeEach(() => {
    _resetGameLanguageCacheForTests();
  });

  afterEach(() => {
    // 切回 en + 清空 mock 以隔离测试
    changeLanguage("en");
    clearRegIdx();
    _resetGameLanguageCacheForTests();
  });

  it("initMainI18n with en resolves t()", () => {
    initMainI18n({ language: "en" });
    expect(t("tabs:live")).toBe("Live");
    expect(t("tray:show")).toBe("Show");
  });

  it("initMainI18n with auto follows system locale", () => {
    initMainI18n({ language: "auto" }); // systemLocale = en-US → en
    expect(t("tabs:live")).toBe("Live");
  });

  it("changeLanguage updates t() output (en → zh-CN)", () => {
    initMainI18n({ language: "en" });
    expect(t("tabs:live")).toBe("Live");
    changeLanguage("zh-CN");
    // zh-CN/tabs.json now contains "实时" for live
    expect(t("tabs:live")).toBe("实时");
    expect(t("tray:show")).toBe("显示");
  });

  it("changeLanguage falls back to en for missing zh-CN keys", () => {
    initMainI18n({ language: "en" });
    changeLanguage("zh-CN");
    // For a key that exists in neither zh-CN nor en, i18next returns the
    // key without the namespace prefix.
    expect(t("tabs:nonexistentKey")).toBe("nonexistentKey");
  });

  it("interpolation works in main process with zh-CN", () => {
    initMainI18n({ language: "zh-CN" });
    expect(t("notifications:updateAvailableBody", { version: "1.2.3" })).toBe(
      "TBH 助手 v1.2.3 已发布，前往“关于”页面下载。",
    );
  });

  describe("game language sync", () => {
    it("initMainI18n with game follows registry (zh-Hans → zh-CN)", () => {
      setRegIdx(9); // 9 = zh-Hans
      initMainI18n({ language: "game" });
      expect(t("tabs:live")).toBe("实时");
      expect(t("tray:show")).toBe("显示");
    });

    it("initMainI18n with game follows registry (ja-JP → ja)", () => {
      setRegIdx(11); // 11 = ja-JP
      initMainI18n({ language: "game" });
      expect(t("tabs:live")).toBe("ライブ");
    });

    it("initMainI18n with game follows registry (ko-KR → ko)", () => {
      setRegIdx(12); // 12 = ko-KR
      initMainI18n({ language: "game" });
      expect(t("tabs:live")).toBe("라이브");
    });

    it("initMainI18n with game follows registry (en-US → en)", () => {
      setRegIdx(0); // 0 = en-US
      initMainI18n({ language: "game" });
      expect(t("tabs:live")).toBe("Live");
    });

    it("initMainI18n with game falls back to en for unsupported game language", () => {
      // 1 = de-DE (German) — not in APP_LANGUAGES, falls back to "en".
      setRegIdx(1);
      initMainI18n({ language: "game" });
      expect(t("tabs:live")).toBe("Live");
    });

    it("initMainI18n with game falls back to system locale when registry missing", () => {
      // Game not installed / registry missing — readGameLanguage returns null,
      // resolveLanguage("game", systemLocale, null) falls back to system locale.
      clearRegIdx();
      initMainI18n({ language: "game" }); // systemLocale = en-US → en
      expect(t("tabs:live")).toBe("Live");
    });

    it("changeLanguage(game) re-reads registry", () => {
      initMainI18n({ language: "en" });
      expect(t("tabs:live")).toBe("Live");
      setRegIdx(9); // 9 = zh-Hans
      changeLanguage("game");
      expect(t("tabs:live")).toBe("实时");
    });
  });

  it("t() returns key before init (startup fallback)", async () => {
    // 隔离此测试：reset modules 后重新 import，得到未初始化的实例。
    vi.resetModules();
    vi.doMock("electron", () => ({ app: { getLocale: () => "en-US" } }));
    const fresh = await import("../../src/main/i18n");
    expect(fresh.t("tabs:live")).toBe("tabs:live");
    // 还原 mock 让后续测试可用
    vi.doUnmock("electron");
    vi.resetModules();
    await import("../../src/main/i18n");
  });
});
