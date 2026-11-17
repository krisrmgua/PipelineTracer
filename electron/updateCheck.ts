/** Polls GitHub tags for a newer published app version. */

export type AppUpdate = {
  version: string;
  url: string;
};

const CHECK_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 12_000;

function parseVersion(raw: string): number[] | null {
  const cleaned = raw.trim().replace(/^v/i, "");
  if (!/^\d+(\.\d+){0,3}$/.test(cleaned)) return null;
  return cleaned.split(".").map((part) => Number(part));
}

/** True when `latest` is a higher semver than `current` (optional leading `v`). */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

export async function fetchLatestVersion(owner: string, repo: string): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/tags?per_page=10`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `${repo}-update-check`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) return null;
    let best: string | null = null;
    for (const entry of data) {
      const name = entry && typeof entry === "object" && "name" in entry ? String((entry as { name: unknown }).name) : "";
      if (!parseVersion(name)) continue;
      const version = name.replace(/^v/i, "");
      if (!best || isNewer(version, best)) best = version;
    }
    return best;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class UpdateChecker {
  private latest: AppUpdate | null = null;
  private timer: NodeJS.Timeout | null = null;
  private dismissed: string | null = null;

  constructor(
    private owner: string,
    private repo: string,
    private currentVersion: () => string,
    private onChange: () => void,
  ) {}

  start(): void {
    void this.check();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.check(), CHECK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): AppUpdate | null {
    return this.latest;
  }

  dismiss(): void {
    if (this.latest) this.dismissed = this.latest.version;
    if (!this.latest) return;
    this.latest = null;
    this.onChange();
  }

  private async check(): Promise<void> {
    const version = await fetchLatestVersion(this.owner, this.repo);
    if (!version) return;
    const current = this.currentVersion();
    if (!isNewer(version, current) || version === this.dismissed) {
      if (this.latest) {
        this.latest = null;
        this.onChange();
      }
      return;
    }
    if (this.latest?.version === version) return;
    this.latest = {
      version,
      url: `https://github.com/${this.owner}/${this.repo}/releases/tag/v${version}`,
    };
    this.onChange();
  }
}
