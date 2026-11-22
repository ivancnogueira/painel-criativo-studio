const THEME_STORAGE_KEY = "criativo_painel_theme";
const THEME_META_COLOR = {
  dark: "#0b0c0f",
  light: "#f4f6fa",
};

let isTransitioning = false;

export function getTheme() {
  const current = document.documentElement.dataset.theme;
  if (current === "light" || current === "dark") return current;
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "dark";
  } catch {
    return "dark";
  }
}

function updateToggleButtons(theme) {
  const nextLabel = theme === "dark" ? "Ativar modo claro" : "Ativar modo escuro";
  document.querySelectorAll(".theme-toggle-btn").forEach((btn) => {
    btn.setAttribute("aria-label", nextLabel);
    btn.setAttribute("title", nextLabel);
    btn.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
  });
}

export function setTheme(nextTheme) {
  const theme = nextTheme === "light" ? "light" : "dark";
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.remove("dark", "light");
  root.classList.add(theme);

  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* armazenamento indisponível */
  }

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_META_COLOR[theme]);

  updateToggleButtons(theme);
  return theme;
}

export function initTheme() {
  return setTheme(getTheme());
}

export async function toggleThemeAnimated(triggerEl = null, options = { duration: 400 }) {
  if (isTransitioning) return getTheme();
  const nextTheme = getTheme() === "dark" ? "light" : "dark";
  const duration = Number(options?.duration) || 400;

  const reduceMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (typeof document.startViewTransition !== "function" || reduceMotion) {
    return setTheme(nextTheme);
  }

  isTransitioning = true;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let cx = vw / 2;
  let cy = vh / 2;

  if (triggerEl && typeof triggerEl.getBoundingClientRect === "function") {
    const rect = triggerEl.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      cx = rect.left + rect.width / 2;
      cy = rect.top + rect.height / 2;
    }
  }

  const maxRadius = Math.hypot(Math.max(cx, vw - cx), Math.max(cy, vh - cy));
  const clipFrom = `circle(0px at ${cx}px ${cy}px)`;
  const clipTo = `circle(${maxRadius}px at ${cx}px ${cy}px)`;
  const root = document.documentElement;

  root.dataset.themeVt = "active";
  root.style.setProperty("--theme-vt-duration", `${duration}ms`);
  root.style.setProperty("--theme-vt-clip-from", clipFrom);

  try {
    const transition = document.startViewTransition(() => {
      setTheme(nextTheme);
    });
    await transition.ready;
    root.animate(
      { clipPath: [clipFrom, clipTo] },
      {
        duration,
        easing: "ease-in-out",
        fill: "forwards",
        pseudoElement: "::view-transition-new(root)",
      },
    );
    await transition.finished;
  } catch {
    setTheme(nextTheme);
  } finally {
    delete root.dataset.themeVt;
    root.style.removeProperty("--theme-vt-duration");
    root.style.removeProperty("--theme-vt-clip-from");
    isTransitioning = false;
  }
  return nextTheme;
}
