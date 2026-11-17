(() => {
  const key = 'lotik.theme';
  const root = document.documentElement;
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  const validTheme = value => value === 'light' || value === 'dark';
  const deviceTheme = () => systemTheme.matches ? 'dark' : 'light';
  let manualTheme;
  try {
    const saved = localStorage.getItem(key);
    if (validTheme(saved)) manualTheme = saved;
  } catch {
    // Storage can be disabled in embedded browsers.
  }
  root.dataset.theme = manualTheme ?? deviceTheme();

  document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('theme-toggle');
    const themeColor = document.querySelector('meta[name="theme-color"]');
    const telegram = document.body.classList.contains('mini') ? window.Telegram?.WebApp : null;
    const miniApp = telegram?.initData ? telegram : null;

    function applyTheme() {
      const telegramTheme = miniApp?.colorScheme;
      const theme = manualTheme ?? (validTheme(telegramTheme) ? telegramTheme : deviceTheme());
      root.dataset.theme = theme;
      button.setAttribute('aria-label', theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему');
      const palette = getComputedStyle(root);
      const background = palette.getPropertyValue('--base').trim();
      const surface = palette.getPropertyValue('--paper').trim();
      themeColor.content = background;
      if (miniApp?.isVersionAtLeast?.('6.1')) miniApp.setBackgroundColor?.(background);
      if (miniApp?.isVersionAtLeast?.('6.9')) miniApp.setHeaderColor?.(background);
      if (miniApp?.isVersionAtLeast?.('7.10')) miniApp.setBottomBarColor?.(surface);
    }

    button.addEventListener('click', () => {
      manualTheme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(key, manualTheme);
      } catch {
        // Keep the selection for this visit if persistence is unavailable.
      }
      applyTheme();
    });
    systemTheme.addEventListener('change', applyTheme);
    miniApp?.onEvent?.('themeChanged', applyTheme);
    applyTheme();
  }, { once: true });
})();
