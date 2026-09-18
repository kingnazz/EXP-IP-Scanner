// Apply the saved theme before first paint so the window never flashes the
// wrong one. "system" is the default and keeps following the operating system.
//
// A separate file rather than an inline script, so the application can run
// under a Content Security Policy that forbids inline code. It is loaded
// synchronously from <head>, which is what makes it run before the first paint.
(function () {
  try {
    var pref = localStorage.getItem("exp-ip-scanner-theme") || "system";
    var dark =
      pref === "dark" ||
      (pref === "system" &&
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", !!dark);
  } catch (e) {
    /* storage unavailable; the app applies the theme when it mounts */
  }
})();
