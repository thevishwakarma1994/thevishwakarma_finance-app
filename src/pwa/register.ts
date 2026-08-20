/**
 * Installed PWAs keep a Workbox precache of index.html + hashed JS.
 * After a deploy, a controlling worker can keep serving that old shell
 * until the next real document load. Register immediately, re-check on
 * focus, and reload once when the new worker claims the page.
 */
export function registerProductionServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;

  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  void navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((registration) => {
    const check = () => {
      void registration.update();
    };
    check();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") check();
    });
  });
}
