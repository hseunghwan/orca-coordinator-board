// Every visible string is written in both languages, as t(korean, english).
export type T = (ko: string, en: string) => string

export function translator(locale: string): T {
  return /^ko(?:-|$)/i.test(locale) ? (ko) => ko : (_ko, en) => en
}
