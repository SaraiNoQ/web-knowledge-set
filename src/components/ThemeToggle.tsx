import { useLayoutEffect, useState } from "react";
import { IconButton } from "./ui/Controls";
import { useToast } from "./ui/Feedback";
import "../theme.css";

export function ThemeToggle() {
  const toast = useToast();
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try { return localStorage.getItem("zhiye.theme") === "dark" ? "dark" : "light"; }
    catch { return "light"; }
  });

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    try { localStorage.setItem("zhiye.theme", next); }
    catch { toast.error("主题已切换，但无法保存偏好；刷新后可能恢复原来的主题。"); }
  };

  return (
    <IconButton label={theme === "light" ? "切换到深色模式" : "切换到浅色模式"} className="theme-toggle" onClick={toggleTheme}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {theme === "light" ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></> : <path d="M20.9 13.1A9 9 0 0 1 10.9 3.1a9 9 0 1 0 10 10Z" />}
      </svg>
    </IconButton>
  );
}
