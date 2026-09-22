import { memo } from "react";
import type { WishGradeRow } from "../../../../shared/types";
import { gradeColor } from "../../lib/gradeColor";

/** 横向堆叠条的尺寸常量（像素，SVG viewBox 坐标系）。 */
const BAR_HEIGHT = 10;
const BAR_TOTAL_WIDTH = 100;
/** 段与段之间的视觉缝隙（用 x 偏移实现，不引入 gap 造成的坐标误差）。 */
const SEGMENT_GAP = 0.6;

/**
 * 手绘 SVG 品质占比堆叠条 —— 不依赖任何图表库（P0 零新增依赖）。
 *
 * 输入 {@link WishGradeRow}[]（核心已按 GRADE_ORDER 排序），把每段的 `share`
 * 归一化为宽度，用 `gradeColor` 着色。空数据（总件数为 0）时渲染一条中性灰
 * 底条，避免出现 0 宽度的空白。
 *
 * 该组件为纯展示、无状态，配合 `React.memo` 在 stats 引用稳定时跳过重渲染。
 */
export const WishGradeBar = memo(function WishGradeBar({
  rows,
  title,
}: {
  rows: WishGradeRow[];
  /** 无障碍标题（读屏用）。 */
  title: string;
}) {
  const visible = rows.filter((r) => r.count > 0);
  if (visible.length === 0) {
    return (
      <svg
        viewBox={`0 0 ${BAR_TOTAL_WIDTH} ${BAR_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-2.5 w-full overflow-hidden rounded-sm"
        role="img"
        aria-label={title}
      >
        <rect
          x={0}
          y={0}
          width={BAR_TOTAL_WIDTH}
          height={BAR_HEIGHT}
          rx={1}
          fill="var(--color-muted, #6b7280)"
          opacity={0.25}
        />
      </svg>
    );
  }

  // share 由核心保证 ∈ [0, 1] 且总和为 1（分母为产出物品总数）；此处做一次
  // 防御性归一化，避免持久化数据手工编辑后出现越界宽度。
  const total = visible.reduce((acc, r) => acc + Math.max(0, r.share), 0);
  const denom = total > 0 ? total : 1;
  const gapCount = Math.max(0, visible.length - 1);
  const available = Math.max(0, BAR_TOTAL_WIDTH - gapCount * SEGMENT_GAP);

  let cursor = 0;
  const segments = visible.map((row) => {
    const frac = Math.max(0, row.share) / denom;
    const width = frac * available;
    const x = cursor;
    cursor += width + SEGMENT_GAP;
    return { grade: row.grade, x, width };
  });

  return (
    <svg
      viewBox={`0 0 ${BAR_TOTAL_WIDTH} ${BAR_HEIGHT}`}
      preserveAspectRatio="none"
      className="h-2.5 w-full overflow-hidden rounded-sm"
      role="img"
      aria-label={title}
    >
      {segments
        .filter((s) => s.width > 0)
        .map((s) => (
          <rect
            key={s.grade}
            x={s.x}
            y={0}
            width={s.width}
            height={BAR_HEIGHT}
            fill={gradeColor(s.grade)}
          />
        ))}
    </svg>
  );
});
