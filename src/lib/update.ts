import { APP_VERSION } from "../version";

export const LATEST_RELEASE_API =
  "https://api.github.com/repos/kingnazz/EXP-IP-Scanner/releases/latest";

export interface LatestRelease {
  version: string;
  url: string;
}

export interface UpdateCheckResult {
  available: boolean;
  version?: string;
  installable?: boolean;
  releaseUrl?: string;
}

/** Parse the simple stable semver we publish: v1.2.3 or 1.2.3. */
export function parseStableVersion(value: string): [number, number, number] | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewerVersion(latest: string, current = APP_VERSION): boolean {
  const a = parseStableVersion(latest);
  const b = parseStableVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
}

/**
 * Ask GitHub which stable release is current.
 *
 * This is intentionally separate from Tauri's signed updater manifest. The
 * GitHub release is the source of truth for "is a newer version available?",
 * while the updater manifest only answers "can this build install it in-place?"
 */
export async function fetchLatestRelease(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<LatestRelease> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(LATEST_RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GitHub returned HTTP ${response.status}`);
    }

    const data: unknown = await response.json();
    if (!data || typeof data !== "object") {
      throw new Error("GitHub returned an invalid release response");
    }

    const release = data as {
      tag_name?: unknown;
      html_url?: unknown;
      draft?: unknown;
      prerelease?: unknown;
    };

    if (release.draft === true || release.prerelease === true) {
      throw new Error("GitHub did not return a stable release");
    }
    if (typeof release.tag_name !== "string" || !parseStableVersion(release.tag_name)) {
      throw new Error("GitHub returned a release with an invalid version");
    }
    if (
      typeof release.html_url !== "string" ||
      !release.html_url.startsWith("https://github.com/kingnazz/EXP-IP-Scanner/releases/")
    ) {
      throw new Error("GitHub returned a release with an invalid URL");
    }

    return {
      version: release.tag_name.replace(/^v/, ""),
      url: release.html_url,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("GitHub did not answer before the update check timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
