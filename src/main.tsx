import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initI18n, reloadOnLanguageChange } from "./i18n";
import "./styles.css";

initI18n().then(() => {
  reloadOnLanguageChange();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
