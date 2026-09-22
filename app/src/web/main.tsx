// Web build entry point.
//
// Order matters: the web `window.tbh` shim must be installed *before* the
// renderer imports anything that reads it at module scope, and the in-memory
// bundled-data source must exist before `TbhProvider` mounts (it triggers
// `loadLocaleCatalog` on first render).

import React from "react";
import ReactDOM from "react-dom/client";
import { installWebTbhApi } from "./webTbhApi";
import { installWebDataSource } from "./dataSource";
import { WebRoot } from "./WebApp";
import "../renderer/styles.css";

installWebDataSource();
installWebTbhApi();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WebRoot />
  </React.StrictMode>,
);
