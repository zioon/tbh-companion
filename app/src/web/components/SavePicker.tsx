// Web shell: save-file input affordances.
//
// `SavePicker` is the large dashed drop zone on the Home page (drag-and-drop +
// click to choose). `ChooseSaveButton` is the compact "choose another file"
// control used by Inventory and the loaded-state summary. Both funnel into
// `loadWebSaveFile`, which decrypts locally and never uploads.

import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuUpload } from "react-icons/lu";
import { Button } from "../../renderer/design-system/primitives/Button/Button";
import { cn } from "../../renderer/lib/cn";
import { loadWebSaveFile } from "../webTbhApi";
import { useWebRuntime } from "../lib/useWebRuntime";

const ACCEPT = ".es3,.json,application/octet-stream";

/** Literal file name shared by every locale's `home.dropTitle`. */
const SAVE_FILE_NAME = "SaveFile_Live.es3";

/**
 * Dashed drag-and-drop / click target that loads a `.es3` save locally.
 *
 * The `border-dashed` class is part of the shell's contract: the end-to-end
 * smoke (`scripts/smoke-app/smoke-web.cjs`) finds this element by that class to
 * feed it a real save. Do not remove it.
 */
export function SavePicker({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation("web");
  const runtime = useWebRuntime();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const onFiles = useCallback((files: FileList | null) => {
    const file = files?.[0];
    if (file) void loadWebSaveFile(file);
  }, []);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        onFiles(e.dataTransfer.files);
      }}
      className={cn(
        "flex flex-col items-center justify-center gap-3.5 rounded-2xl border border-dashed px-6 py-9 text-center transition-colors",
        dragging ? "border-accent bg-accent/10" : "border-accent/30 bg-accent/[0.04]",
        compact && "px-5 py-5",
      )}
    >
      <LuUpload aria-hidden className="size-[26px] text-accent" strokeWidth={1.8} />
      <p className="m-0 text-[15.5px] font-semibold text-fg">
        <DropTitle text={runtime.loading ? t("home.dropReading") : t("home.dropTitle")} />
      </p>
      {!compact && (
        <p className="m-0 max-w-[620px] text-xs leading-relaxed text-muted">
          {t("home.dropPrivacy")}
        </p>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          onFiles(e.target.files);
          // Reset so picking the same file again re-triggers change.
          e.target.value = "";
        }}
      />
      <Button
        variant="primary"
        onClick={() => inputRef.current?.click()}
        disabled={runtime.loading}
      >
        {t("home.choose")}
      </Button>
    </div>
  );
}

/**
 * The drop title with its embedded file name set in mono/accent.
 *
 * Every locale's `home.dropTitle` embeds the literal `SaveFile_Live.es3`, so
 * splitting on it is locale-safe; when a translation happens to omit the name
 * we fall back to plain text rather than rendering a half-empty string.
 */
function DropTitle({ text }: { text: string }) {
  const [before, after] = text.split(SAVE_FILE_NAME);
  if (after === undefined) return <>{text}</>;
  return (
    <>
      {before}
      <span className="font-mono text-accent">{SAVE_FILE_NAME}</span>
      {after}
    </>
  );
}

/** Compact button that opens the file picker (no drop zone). */
export function ChooseSaveButton({
  label,
  variant = "ghost",
  size,
  className,
}: {
  label?: string;
  variant?: "primary" | "ghost";
  size?: "sm";
  className?: string;
}) {
  const { t } = useTranslation("web");
  const runtime = useWebRuntime();
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void loadWebSaveFile(file);
          e.target.value = "";
        }}
      />
      <Button
        variant={variant}
        size={size}
        className={className}
        disabled={runtime.loading}
        onClick={() => inputRef.current?.click()}
      >
        {label ?? t("loadAnother")}
      </Button>
    </>
  );
}
