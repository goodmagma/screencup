/**
 * UI translations. The language is resolved by the backend (`get_language` in
 * src-tauri/src/i18n.rs) from the settings, or from the system locale when set to
 * automatic, and loaded once per window before the first render (see main.tsx).
 *
 * `{name}` placeholders are filled from the `params` of `t`.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { it, type Key } from "./locales/it";
import { en } from "./locales/en";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { de } from "./locales/de";
import { pt } from "./locales/pt";

export type { Key };

/** Mirrors `Lang` in src-tauri/src/i18n.rs. */
export type Lang = "it" | "en" | "es" | "fr" | "de" | "pt";

const DICTIONARIES: Record<Lang, Record<Key, string>> = { it, en, es, fr, de, pt };
let current: Lang = "en";

/** The language this window renders in. */
export const language = () => current;

/** Loads the resolved language; call before the first render. */
export async function initI18n(): Promise<void> {
  try {
    current = await invoke<Lang>("get_language");
  } catch {
    current = "en";
  }
  document.documentElement.lang = current;
}

/**
 * Reloads the window when a settings change switches the language, so every text is
 * rendered again in the new one.
 */
export function reloadOnLanguageChange(): void {
  listen("settings-changed", async () => {
    const lang = await invoke<Lang>("get_language").catch(() => current);
    if (lang !== current) window.location.reload();
  });
}

export function t(key: Key, params?: Record<string, string | number>): string {
  const text = DICTIONARIES[current][key] ?? it[key];
  return params ? text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m)) : text;
}
