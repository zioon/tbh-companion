import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { boxStageListLabel } from "../../../core/lookup/boxDisplay";
import { fmtDropPct } from "../../lib/lookupDisplay";
import { filterAndSortBoxStages, filterFirstDropStages } from "../../lib/boxLootFilters";
import { reportIpcError } from "../../lib/reportError";
import { Card } from "../../design-system/primitives/Card/Card";
import { DataList, DataListRow } from "../../design-system/primitives/DataList/DataList";
import { Input } from "../../design-system/primitives/Input/Input";
import { SectionHeadingRow } from "./itemCardParts";
import { BoxCardDropSummary, BoxCardHeader } from "./BoxCardParts";
import { ItemLink } from "../ItemLink";
import { BoxLoot } from "./BoxLoot";
import type { AppConfig, LookupBoxSources, LookupItem } from "../../../../shared/types";
import type { LookupNavNode } from "../../lib/useLookupNav";

export function BoxDetailCard({
  box,
  boxItemKey,
  onNavigate,
  peekItem,
}: {
  box: LookupBoxSources;
  boxItemKey: number;
  onNavigate: (node: LookupNavNode) => void;
  peekItem: (id: number) => LookupItem | undefined;
}) {
  const { t } = useTranslation("lookup");
  const [farmQuery, setFarmQuery] = useState("");
  const [firstQuery, setFirstQuery] = useState("");
  const [stageMetadata, setStageMetadata] = useState<Record<number, string>>({});

  useEffect(() => {
    if (typeof window.tbh?.getConfig !== "function") return;
    let mounted = true;
    void window.tbh
      .getConfig()
      .then((config: AppConfig) => {
        if (mounted) setStageMetadata(config.stageMetadata ?? {});
      })
      .catch((err: unknown) => reportIpcError(err));
    return () => {
      mounted = false;
    };
  }, []);

  const filteredFarmStages = useMemo(
    () =>
      filterAndSortBoxStages(
        box.stages,
        {
          query: farmQuery,
          sortKey: "spawnPct",
          sortDir: "desc",
        },
        stageMetadata,
      ),
    [box.stages, farmQuery, stageMetadata],
  );

  const filteredFirstStages = useMemo(
    () => filterFirstDropStages(box.firstDropStages, firstQuery, stageMetadata),
    [box.firstDropStages, firstQuery, stageMetadata],
  );

  const showFirstClear = box.firstDropOnly && box.firstDropStages.length > 0;
  const showFarm = !box.firstDropOnly && box.stages.length > 0;
  const showLocationEmpty = !showFirstClear && !showFarm;

  return (
    <Card className="flex flex-col gap-3">
      <BoxCardHeader box={box} boxItemKey={boxItemKey} iconSize="lg" />
      <BoxCardDropSummary box={box} />

      {showFirstClear ? (
        <div className="flex flex-col gap-2">
          <SectionHeadingRow
            label={t("box.firstClearLabel")}
            help={t("box.firstClearHelp")}
            helpLabel={t("box.firstClearHelpLabel")}
          />

          <div className="flex items-center gap-3">
            <Input
              className="min-w-0 flex-1"
              placeholder={t("box.searchStages")}
              value={firstQuery}
              onChange={(e) => setFirstQuery(e.target.value)}
            />
            <span className="shrink-0 whitespace-nowrap text-xs text-muted">
              {t("box.stagesCount", { count: filteredFirstStages.length })}
            </span>
          </div>

          <Card padding="none" className="overflow-hidden">
            <DataList scrollable className="max-h-44">
              {filteredFirstStages.length === 0 ? (
                <DataListRow index={0} className="text-xs text-muted">
                  {t("box.noStagesMatch")}
                </DataListRow>
              ) : (
                filteredFirstStages.map((stage, i) => (
                  <DataListRow key={stage.stageKey} index={i}>
                    <ItemLink
                      node={{ type: "stage", id: stage.stageKey }}
                      name={boxStageListLabel(stage.stageKey, stage.stageName)}
                      onNavigate={onNavigate}
                    />
                  </DataListRow>
                ))
              )}
            </DataList>
          </Card>
        </div>
      ) : null}

      {showFarm ? (
        <div className="flex flex-col gap-2">
          <SectionHeadingRow
            label={t("box.whereLabel")}
            help={t("box.whereHelp")}
            helpLabel={t("box.whereHelpLabel")}
          />

          <div className="flex items-center gap-3">
            <Input
              className="min-w-0 flex-1"
              placeholder={t("box.searchStages")}
              value={farmQuery}
              onChange={(e) => setFarmQuery(e.target.value)}
            />
            <span className="shrink-0 whitespace-nowrap text-xs text-muted">
              {t("box.stagesCount", { count: filteredFarmStages.length })}
            </span>
          </div>

          <Card padding="none" className="overflow-hidden">
            <DataList scrollable className="max-h-44">
              {filteredFarmStages.length === 0 ? (
                <DataListRow index={0} className="text-xs text-muted">
                  {t("box.noStagesMatch")}
                </DataListRow>
              ) : (
                filteredFarmStages.map((stage, i) => (
                  <DataListRow key={stage.stageKey} index={i}>
                    <ItemLink
                      node={{ type: "stage", id: stage.stageKey }}
                      name={boxStageListLabel(stage.stageKey, stage.stageName)}
                      suffix={`· ${fmtDropPct(stage.spawnPct)}%`}
                      onNavigate={onNavigate}
                    />
                  </DataListRow>
                ))
              )}
            </DataList>
          </Card>
        </div>
      ) : null}

      {showLocationEmpty ? <p className="m-0 text-xs text-muted">{t("box.noLocation")}</p> : null}

      {box.drops.length > 0 ? (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          <BoxLoot drops={box.drops} onNavigate={onNavigate} peekItem={peekItem} />
        </div>
      ) : null}
    </Card>
  );
}
