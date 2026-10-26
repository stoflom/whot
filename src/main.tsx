import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { OverlayProvider } from "./overlays";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* #138: every modal (dialog/menu/popover/merge confirm — App-owned
        or owned by a child component) self-registers here while mounted;
        App's keyboard guards derive the Q8 modal-owner rule from the
        single count */}
    <OverlayProvider>
      <App />
    </OverlayProvider>
  </React.StrictMode>
);
