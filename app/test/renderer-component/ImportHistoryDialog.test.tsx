import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AnalyzeMarketVolumeBackupResult } from "../../shared/types";
import { ImportHistoryDialog } from "../../src/renderer/components/market/ImportHistoryDialog";

// 基准摘要：旧备份（缺省币种字段），自动探测出 CNY。
const BASE: AnalyzeMarketVolumeBackupResult = {
  ok: true,
  fileName: "market_volume_history_20260825.json",
  detectedCurrency: "CNY",
  detectedBy: "auto",
  detection: { method: "usdSnapshot", samples: 128, relativeError: 0.01, runnerUp: null },
  baseCurrencyFile: false,
  itemCount: 42,
  priceHashCount: 40,
  pricePointCount: 1234,
  oldestTs: Date.UTC(2026, 7, 1) / 1000,
  newestTs: Date.UTC(2026, 7, 25) / 1000,
};

describe("ImportHistoryDialog", () => {
  it("展示备份摘要与「自动探测」选项，确认时回传 auto", () => {
    const onConfirm = vi.fn();
    render(<ImportHistoryDialog summary={BASE} onConfirm={onConfirm} onCancel={() => {}} />);

    expect(screen.getByText("market_volume_history_20260825.json")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("40 / 1234")).toBeInTheDocument();
    // 文案必须说明是「融合」而非覆盖
    expect(screen.getByText(/merges into your existing history/)).toBeInTheDocument();
    // Select 的测量用隐藏 span 与选中值 span 都含该文案 → 断言存在即可
    expect(screen.getAllByText("Detect automatically (CNY)").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Merge import" }));
    expect(onConfirm).toHaveBeenCalledWith("auto");
  });

  it("未识别出币种时提示需手动选择，且不再声称有探测结果", () => {
    render(
      <ImportHistoryDialog
        summary={{ ...BASE, detectedCurrency: null, detectedBy: null, detection: null }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getAllByText("Detect automatically (not recognised)").length).toBeGreaterThan(0);
    expect(screen.getByText(/could not be detected/)).toBeInTheDocument();
  });

  it("有自动探测结果时给出判定依据（参考源与样本数）", () => {
    render(
      <ImportHistoryDialog
        summary={{
          ...BASE,
          detection: { method: "usdHistory", samples: 77, relativeError: 0.02, runnerUp: null },
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/77 items/)).toBeInTheDocument();
    expect(screen.getByText(/USD price history/)).toBeInTheDocument();
  });

  it("备份已是美元基准时锁定币种并说明无需选择", () => {
    render(
      <ImportHistoryDialog
        summary={{ ...BASE, detectedCurrency: "USD", baseCurrencyFile: true }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/already stored in USD/)).toBeInTheDocument();
    expect(screen.queryByText(/Detect automatically/)).not.toBeInTheDocument();
    expect(screen.getAllByText("USD - US Dollar").length).toBeGreaterThan(0);
  });

  it("「取消」触发 onCancel；busy 时两个按钮都禁用", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <ImportHistoryDialog summary={BASE} onConfirm={() => {}} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(<ImportHistoryDialog summary={BASE} busy onConfirm={() => {}} onCancel={onCancel} />);
    expect(screen.getByRole("button", { name: "Merge import" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});
