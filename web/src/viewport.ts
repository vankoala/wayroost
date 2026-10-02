// Size the app to the *visible* viewport so the composer stays above the
// on-screen keyboard on iOS (Android handles this via interactive-widget).

export function trackVisualViewport(): void {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!vv) return;
  let frame = 0;
  const sync = () => {
    frame = 0;
    root.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
    root.style.setProperty('--app-top', `${Math.round(vv.offsetTop)}px`);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(sync);
  };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  sync();
}
