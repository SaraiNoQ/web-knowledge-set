import { useEffect, useMemo, useReducer } from "react";
import { createPluginRegistry } from "./plugin-registry";

export const pluginRegistry = createPluginRegistry({
  get length() { return localStorage.length; }, key: (index) => localStorage.key(index),
  getItem: (key) => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: (key) => localStorage.removeItem(key),
});
export function useExternalPlugins() {
  const [revision, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => pluginRegistry.subscribe(refresh), []);
  return useMemo(() => { try { return { plugins: pluginRegistry.list(), retained: pluginRegistry.retainedData(), error: "" }; } catch (cause) { return { plugins: [], retained: [], error: (cause as Error).message }; } }, [revision]);
}
