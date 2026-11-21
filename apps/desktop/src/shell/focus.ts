/**
 * After an action removes the control that had focus, moves focus to the sidebar heading, or the main area when
 * the sidebar is closed, so keyboard and screen reader users keep their place.
 */
export function restoreFocusIfLost(): void {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const target = document.getElementById('sidebar-title') ?? document.getElementById('workspace-main');
    target?.focus();
  });
}
