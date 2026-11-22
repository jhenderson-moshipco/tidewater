/** Seconds since `started`, written straight into the element each second so nothing re-renders for it. */
export function Elapsed({ started }: { started: number }) {
  const tick = (element: HTMLSpanElement) => {
    const show = () => {
      element.textContent = `${Math.floor((Date.now() - started) / 1000)} s`;
    };
    show();
    const timer = window.setInterval(show, 1000);
    return () => window.clearInterval(timer);
  };
  return <span ref={tick} aria-hidden="true" style={{ fontVariantNumeric: 'tabular-nums' }} />;
}
