import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClassifyPromptDialog } from "../../src/renderer/components/loot/ClassifyPromptDialog";

describe("ClassifyPromptDialog", () => {
  it("renders three category buttons when open", () => {
    render(
      <ClassifyPromptDialog
        open
        itemCount={3}
        onClose={() => {}}
        onResolve={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /common/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /stage boss/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /act boss/i })).toBeInTheDocument();
  });

  it("calls onResolve with 'common' when Common clicked", () => {
    const onResolve = vi.fn();
    render(
      <ClassifyPromptDialog
        open
        itemCount={2}
        onClose={() => {}}
        onResolve={onResolve}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /common/i }));
    expect(onResolve).toHaveBeenCalledWith("common");
  });

  it("calls onResolve with 'rare' when Stage boss clicked", () => {
    const onResolve = vi.fn();
    render(
      <ClassifyPromptDialog
        open
        itemCount={2}
        onClose={() => {}}
        onResolve={onResolve}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /stage boss/i }));
    expect(onResolve).toHaveBeenCalledWith("rare");
  });

  it("calls onResolve with 'act' when Act boss clicked", () => {
    const onResolve = vi.fn();
    render(
      <ClassifyPromptDialog
        open
        itemCount={2}
        onClose={() => {}}
        onResolve={onResolve}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /act boss/i }));
    expect(onResolve).toHaveBeenCalledWith("act");
  });

  it("calls onClose when Cancel clicked", () => {
    const onClose = vi.fn();
    render(
      <ClassifyPromptDialog
        open
        itemCount={1}
        onClose={onClose}
        onResolve={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("displays item count", () => {
    render(
      <ClassifyPromptDialog
        open
        itemCount={5}
        onClose={() => {}}
        onResolve={() => {}}
      />,
    );
    expect(screen.getByText(/5 items/i)).toBeInTheDocument();
  });
});
