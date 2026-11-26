/** @jsxImportSource react */
// Paseo's board language (client/language.tsx): Korean by default, chosen per device.
import { createContext, useContext, type ReactNode } from "react";
import { z } from "zod";
import { defineSettings } from "../../paseo/plugin-shim";
import type { Translate } from "../../paseo/view-types";
import { useDeviceSetting } from "../device-setting";
import { Button, column, row, space } from "./controls";

export type Language = "ko" | "en";
export const languageSetting = defineSettings({
  id: "board-language", scope: "device", version: 1,
  schema: z.object({ language: z.enum(["ko", "en"]).default("ko") }),
});

const translators: Record<Language, Translate> = {
  ko: (korean) => korean, en: (_, english) => english,
};

function usePreference() {
  const state = useDeviceSetting(languageSetting);
  const language = state.values.language;
  return { state, language, t: translators[language] };
}
const Context = createContext<ReturnType<typeof usePreference> | null>(null);

export function BoardLanguageProvider({ children }: { children: ReactNode }) {
  const preference = usePreference();
  return <Context.Provider value={preference}>{children}</Context.Provider>;
}

export function useBoardLanguage(): { language: Language; t: Translate } {
  const pref = useContext(Context);
  return pref ?? { language: "ko", t: translators.ko };
}

export function BoardLanguageSetting() {
  const pref = useContext(Context);
  if (!pref) return null;
  const { state, t, language } = pref;
  const save = async (value: Language) => {
    if (!state.ready || state.saving || value === language) return;
    await state.save({ language: value });
  };
  return <div style={{ ...column, gap: space[2] }}>
    <span role="heading" aria-level={3} className="section-label">{t("보드 언어", "Board language")}</span>
    <div style={{ ...row, gap: space[1.5] }}>
      {(["ko", "en"] as const).map(id => <Button key={id} label={id === "ko" ? "한국어" : "English"} selected={language === id}
        disabled={!state.ready || state.saving} onPress={() => void save(id)} />)}
    </div>
    {(state.saveFailed || state.loadFailed) && <div style={{ ...column, gap: space[1.5], alignItems: "flex-start" }}>
      <p role="status" className="danger">{t("언어 설정을 확인하고 다시 선택해 주세요.", "Reload the language setting and try again.")}</p>
      <Button label={t("다시 읽기", "Reload setting")} onPress={() => void state.reload()} />
    </div>}
  </div>;
}
