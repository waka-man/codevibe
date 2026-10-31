import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { request } from "https";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface UpdateRelease {
  version: string;
  tagName: string;
  name: string;
  body: string;
  vsixUrl: string;
}

interface GitHubReleaseResponse {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

export interface UpdateServiceOptions {
  repository?: string;
  currentVersion?: string;
  requestJson?: (url: string) => Promise<GitHubReleaseResponse>;
  download?: (url: string, target: string) => Promise<void>;
}

export class UpdateService {
  private readonly repository: string;
  private readonly currentVersion: string;
  private readonly requestJson: (url: string) => Promise<GitHubReleaseResponse>;
  private readonly download: (url: string, target: string) => Promise<void>;
  private checking = false;
  private dismissedVersion: string | undefined;

  constructor(options: UpdateServiceOptions = {}) {
    this.repository = options.repository ?? "waka-man/codevibe";
    this.currentVersion = options.currentVersion ?? "0.0.0";
    this.requestJson = options.requestJson ?? requestJson;
    this.download = options.download ?? downloadFile;
  }

  async checkForUpdate(force = false): Promise<UpdateRelease | null> {
    if (this.checking) {
      return null;
    }
    if (!force && this.dismissedVersion) {
      return null;
    }

    this.checking = true;
    try {
      const response = await this.requestJson(
        `https://api.github.com/repos/${this.repository}/releases/latest`,
      );
      const release = this.parseRelease(response);
      if (!release || compareVersions(release.version, this.currentVersion) <= 0) {
        return null;
      }
      return release;
    } finally {
      this.checking = false;
    }
  }

  /**
   * Fetch the latest published release regardless of version comparison.
   * Used by the integrity check, which must reinstall even when the version
   * number is unchanged (a tampered build keeps the original version).
   */
  async getLatestRelease(): Promise<UpdateRelease | null> {
    if (this.checking) {
      return null;
    }
    this.checking = true;
    try {
      const response = await this.requestJson(
        `https://api.github.com/repos/${this.repository}/releases/latest`,
      );
      return this.parseRelease(response);
    } finally {
      this.checking = false;
    }
  }

  dismiss(version: string): void {
    this.dismissedVersion = version;
  }

  async install(release: UpdateRelease): Promise<void> {
    const target = path.join(
      os.tmpdir(),
      `codevibe-${release.version}-${Date.now()}.vsix`,
    );
    try {
      await this.download(release.vsixUrl, target);
      const stat = await fs.stat(target);
      if (stat.size === 0) {
        throw new Error("Downloaded VSIX is empty");
      }
      await vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        vscode.Uri.file(target),
      );
    } finally {
      await fs.rm(target, { force: true }).catch(() => undefined);
    }
  }

  private parseRelease(response: GitHubReleaseResponse): UpdateRelease | null {
    if (response.draft === true || response.prerelease === true) {
      return null;
    }
    const tagName = typeof response.tag_name === "string" ? response.tag_name : "";
    const version = tagName.replace(/^v/, "");
    const assets = Array.isArray(response.assets) ? response.assets : [];
    const vsix = assets.find(
      (asset): asset is ReleaseAsset =>
        typeof asset === "object" &&
        asset !== null &&
        typeof (asset as ReleaseAsset).name === "string" &&
        (asset as ReleaseAsset).name.toLowerCase().endsWith(".vsix") &&
        typeof (asset as ReleaseAsset).browser_download_url === "string",
    );
    if (!isSemanticVersion(version) || !vsix) {
      return null;
    }
    return {
      version,
      tagName,
      name: typeof response.name === "string" ? response.name : tagName,
      body: typeof response.body === "string" ? response.body : "",
      vsixUrl: vsix.browser_download_url,
    };
  }
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function isSemanticVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}

function requestJson(url: string): Promise<GitHubReleaseResponse> {
  return new Promise((resolve, reject) => {
    const requestHandle = request(
      url,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "CodeVibe-Updater",
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`GitHub returned HTTP ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as GitHubReleaseResponse);
          } catch {
            reject(new Error("GitHub returned invalid release metadata"));
          }
        });
      },
    );
    requestHandle.on("error", reject);
    requestHandle.end();
  });
}

function downloadFile(url: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = require("fs").createWriteStream(target);
    const requestHandle = request(url, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        output.close();
        void downloadFile(response.headers.location, target).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        output.close();
        reject(new Error(`VSIX download returned HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(output);
      output.on("finish", () => output.close(resolve));
    });
    requestHandle.on("error", (error) => {
      output.close();
      reject(error);
    });
    requestHandle.end();
  });
}
