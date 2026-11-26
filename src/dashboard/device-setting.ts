// Paseo's defineSettings with scope "device", kept in the plugin's own storage on this machine.
import { useCallback, useEffect, useState } from "react";
import type { z, ZodType } from "zod";
import type { SettingsDefinition } from "../paseo/plugin-shim";

type JsonValue = Parameters<typeof orca.storage.set>[1];

export function deviceSettingKey(id: string) {
  return "device-setting:" + id;
}

export function useDeviceSetting<Schema extends ZodType>(definition: SettingsDefinition<Schema>) {
  type Values = z.output<Schema>;
  const [saved, setSaved] = useState<Values | null>(null);
  const [temporary, setTemporary] = useState<Values | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const fallback = (): Values => definition.schema.parse({}) as Values;

  const reload = useCallback(async () => {
    try {
      const stored = await orca.storage.get(deviceSettingKey(definition.id));
      const parsed = definition.schema.safeParse(stored ?? {});
      setSaved(parsed.success ? parsed.data as Values : fallback());
      setLoadFailed(false);
    } catch {
      setSaved(fallback());
      setLoadFailed(true);
    }
  }, [definition]);
  useEffect(() => { void reload(); }, [reload]);

  // A failed save keeps the new choice on screen and says it was not kept, as Paseo does.
  async function save(next: Values) {
    setTemporary(next);
    setSaving(true);
    setSaveFailed(false);
    try {
      await orca.storage.set(deviceSettingKey(definition.id), next as JsonValue);
      setSaved(next);
      setTemporary(null);
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return { values: temporary ?? saved ?? fallback(), ready: saved !== null, saving, saveFailed, loadFailed, save, reload };
}
