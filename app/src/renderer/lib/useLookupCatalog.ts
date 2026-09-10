import type { LookupItem } from "../../../shared/types";
import { useTbhContext } from "../context/tbhContext";

/**
 * 共享的图鉴目录（名称已本地化）。
 *
 * 由 TbhProvider 在应用启动时预取一次并按语言切换重新拉取，所有标签页
 * 消费同一份数据。返回 null 表示目录尚未就绪（启动预取进行中）——消费方
 * 应渲染骨架占位而不是灰点/无颜色占位，避免目录到达后出现明显的第二次
 * 更新。
 */
export function useLookupCatalog(): LookupItem[] | null {
  return useTbhContext().lookupCatalog;
}
