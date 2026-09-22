/* EXP IP Scanner website behaviour — v3 cache key.
 *
 * No dependencies, no tracking, no build step. Two jobs: the screenshot
 * switcher, and filling the download cards from the latest GitHub release.
 *
 * Everything degrades. The page is fully readable and every download link
 * works before this file runs and if it never runs at all, because the markup
 * already points at the releases page. The GitHub request never blocks
 * rendering: it is fired after the page is interactive and only replaces text
 * once it answers.
 *
 * The asset-matching rules are adapted from ArcScan's, which were strict for a
 * reason worth repeating: the consequence of a loose match is somebody
 * clicking "Download installer" and getting a portable ZIP -- something that
 * looks like a working download right up until it does not work.
 */
(function () {
  "use strict";

  var REPO = "nazar-exp/EXP-IP-Scanner";
  var RELEASES = "https://github.com/" + REPO + "/releases";
  var SCREENSHOT_VERSION = "1.2.1";

  // ----------------------------------------------------- screenshot switcher

  var tabs = Array.prototype.slice.call(document.querySelectorAll(".shot-tab"));
  var shotImage = document.getElementById("shot-image");
  var shotCaption = document.getElementById("shot-caption");

  if (tabs.length && shotImage && shotCaption) {
    var select = function (tab) {
      tabs.forEach(function (other) {
        other.setAttribute("aria-selected", other === tab ? "true" : "false");
        other.tabIndex = other === tab ? 0 : -1;
      });
      shotImage.src =
        "assets/shots/" + tab.getAttribute("data-shot") + ".webp?v=" + encodeURIComponent(SCREENSHOT_VERSION);
      shotImage.alt = tab.getAttribute("data-caption");
      shotCaption.textContent = tab.getAttribute("data-caption");
    };

    tabs.forEach(function (tab, index) {
      tab.tabIndex = tab.getAttribute("aria-selected") === "true" ? 0 : -1;
      tab.addEventListener("click", function () {
        select(tab);
      });
      // Arrow keys move between tabs, which is what the tablist role promises.
      tab.addEventListener("keydown", function (event) {
        var next = null;
        if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
        else if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
        else if (event.key === "Home") next = tabs[0];
        else if (event.key === "End") next = tabs[tabs.length - 1];
        if (next) {
          event.preventDefault();
          select(next);
          next.focus();
        }
      });
    });
  }

  // ------------------------------------------------------------- downloads

  /**
   * What each card's download must be named, and what it must not be.
   *
   * Each rule states both, because a suffix test alone would let an installer
   * satisfy the portable card on a release that happens to name them
   * similarly. The release tag's version is supplied as well, so a stale asset
   * left attached to a release cannot satisfy a current card.
   */
  var ASSET_RULES = {
    portable: {
      must: [/^EXP-IP-Scanner_[\d.]+_windows-x64-portable\.zip$/i],
      mustNot: [/arm64|aarch64/i, /setup/i],
    },
    installer: {
      must: [/^EXP-IP-Scanner_[\d.]+_x64-setup\.exe$/i],
      mustNot: [/arm64|aarch64/i, /portable/i],
    },
  };

  /**
   * Names that must never be offered as a download, whatever else matches.
   *
   * The updater manifest and its signatures are machinery for the in-app
   * updater. A GitHub source archive is not a build at all.
   */
  var NEVER = [/\.sig$/i, /^latest\.json$/i, /\.nsis\.zip$/i, /^(source|Source)[-_ ]?code/i];

  function pickAsset(assets, rule, expectedVersion) {
    if (!rule || !/^\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?$/i.test(expectedVersion || "")) {
      return null;
    }
    var prefix = ("EXP-IP-Scanner_" + expectedVersion + "_").toLowerCase();
    var matches = [];
    for (var i = 0; i < assets.length; i++) {
      var name = assets[i].name || "";
      if (name.toLowerCase().indexOf(prefix) !== 0) continue;

      var forbidden = false;
      for (var n = 0; n < NEVER.length; n++) {
        if (NEVER[n].test(name)) forbidden = true;
      }
      if (forbidden) continue;

      var ok = rule.must.length > 0;
      for (var m = 0; m < rule.must.length; m++) {
        if (!rule.must[m].test(name)) ok = false;
      }
      for (var x = 0; x < rule.mustNot.length; x++) {
        if (rule.mustNot[x].test(name)) ok = false;
      }
      if (ok) matches.push(assets[i]);
    }
    // GitHub prevents duplicate names, but two differently named assets could
    // still satisfy one rule. Refuse ambiguity rather than let the result
    // depend on the order the API happened to return them in.
    return matches.length === 1 ? matches[0] : null;
  }

  // Exposed for the site verification suite, which runs these rules against a
  // fixture of every asset a release publishes. Reading them from here means
  // the tests check the rules the page actually uses.
  window.__expAssetRules = { rules: ASSET_RULES, never: NEVER, pick: pickAsset };

  function formatSize(bytes) {
    var mb = bytes / (1024 * 1024);
    return mb >= 1 ? mb.toFixed(1) + " MB" : Math.round(bytes / 1024) + " KB";
  }

  function setField(card, field, apply) {
    var el = card.querySelector('[data-field="' + field + '"]');
    if (el) apply(el);
  }

  var cards = {};
  Array.prototype.forEach.call(document.querySelectorAll(".dl"), function (card) {
    cards[card.getAttribute("data-kind")] = card;
  });

  var status = document.getElementById("download-status");
  var heroDownload = document.getElementById("hero-download");
  var versionFallback = document.getElementById("version-fallback");
  var releaseMeta = document.getElementById("release-meta");

  if (!Object.keys(cards).length) return;

  // A short timeout, because a slow or blocked API must not leave the page
  // looking like it is still loading. The markup's fallbacks already work.
  var controller = typeof AbortController === "function" ? new AbortController() : null;
  var timer = setTimeout(function () {
    if (controller) controller.abort();
  }, 6000);

  fetch("https://api.github.com/repos/" + REPO + "/releases/latest", {
    headers: { Accept: "application/vnd.github+json" },
    signal: controller ? controller.signal : undefined,
  })
    .then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    })
    .then(function (release) {
      clearTimeout(timer);
      var assets = release.assets || [];
      var version = (release.tag_name || "").replace(/^v/, "");

      if (version && versionFallback) versionFallback.textContent = "v" + version;
      if (releaseMeta && release.published_at) {
        releaseMeta.textContent =
          " · released " + new Date(release.published_at).toLocaleDateString();
      }

      Object.keys(cards).forEach(function (kind) {
        var card = cards[kind];
        var asset = pickAsset(assets, ASSET_RULES[kind], version);

        if (version) setField(card, "version", function (el) { el.textContent = version; });
        if (release.html_url) {
          setField(card, "notes", function (el) { el.href = release.html_url; });
        }
        if (asset) {
          setField(card, "link", function (el) { el.href = asset.browser_download_url; });
          if (typeof asset.size === "number") {
            setField(card, "size", function (el) { el.textContent = formatSize(asset.size); });
          }
          if (kind === "portable" && heroDownload) {
            heroDownload.href = asset.browser_download_url;
          }
        } else {
          // No matching asset in this release: leave the button pointing at
          // the release page rather than at a link that would 404.
          setField(card, "size", function (el) { el.textContent = "see the release page"; });
        }
      });

      if (status) {
        status.textContent =
          "Links and sizes are from release " +
          (release.tag_name || "latest") +
          " on GitHub, where every asset also carries a SHA-256 digest.";
      }
    })
    .catch(function () {
      clearTimeout(timer);
      // Rate limited, offline, or blocked. Every button already points at the
      // releases page, so the only thing to change is the explanation.
      if (status) {
        status.innerHTML =
          'Release details could not be loaded from GitHub just now. Every button above opens the <a href="' +
          RELEASES +
          '">releases page</a>, where the current downloads are listed.';
      }
    });
})();
