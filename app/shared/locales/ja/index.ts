// Aggregates every Japanese namespace so callers can `import ja from "./ja"`.
// Each JSON file becomes one i18next namespace keyed by its basename.
import about from "./about.json";
import chests from "./chests.json";
import common from "./common.json";
import dialogs from "./dialogs.json";
import inventory from "./inventory.json";
import live from "./live.json";
import liveMemory from "./liveMemory.json";
import lookup from "./lookup.json";
import loot from "./loot.json";
import market from "./market.json";
import notifications from "./notifications.json";
import pets from "./pets.json";
import settings from "./settings.json";
import tabs from "./tabs.json";
import tray from "./tray.json";
import whatsNew from "./whatsNew.json";

export default {
  about,
  chests,
  common,
  dialogs,
  inventory,
  live,
  liveMemory,
  lookup,
  loot,
  market,
  notifications,
  pets,
  settings,
  tabs,
  tray,
  whatsNew,
};
