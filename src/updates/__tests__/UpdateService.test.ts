jest.mock("vscode", () => ({
  Uri: { file: (filePath: string) => ({ fsPath: filePath }) },
  commands: { executeCommand: jest.fn().mockResolvedValue(undefined) },
}), { virtual: true });

import * as vscode from "vscode";
import { compareVersions, UpdateService } from "../UpdateService";

describe("UpdateService", () => {
  it("compares semantic versions numerically", () => {
    expect(compareVersions("0.1.12", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.9", "0.1.12")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("returns a valid newer VSIX release", async () => {
    const service = new UpdateService({
      currentVersion: "0.1.12",
      requestJson: jest.fn().mockResolvedValue({
        tag_name: "v0.1.13",
        name: "CodeVibe 0.1.13",
        body: "Bug fixes",
        assets: [{
          name: "codevibe-extension-0.1.13.vsix",
          browser_download_url: "https://example.test/codevibe.vsix",
        }],
      }),
    });

    await expect(service.checkForUpdate(true)).resolves.toMatchObject({
      version: "0.1.13",
      body: "Bug fixes",
    });
  });

  it("ignores older releases and releases without VSIX assets", async () => {
    const requestJson = jest.fn()
      .mockResolvedValueOnce({
        tag_name: "v0.1.11",
        assets: [{ name: "notes.txt", browser_download_url: "https://example.test/notes" }],
      })
      .mockResolvedValueOnce({
        tag_name: "v0.1.13",
        assets: [{ name: "notes.txt", browser_download_url: "https://example.test/notes" }],
      });
    const service = new UpdateService({ currentVersion: "0.1.12", requestJson });

    await expect(service.checkForUpdate(true)).resolves.toBeNull();
    await expect(service.checkForUpdate(true)).resolves.toBeNull();
  });

  it("installs a downloaded VSIX through VS Code and cleans it up", async () => {
    const download = jest.fn(async (_url: string, target: string) => {
      const fs = await import("fs/promises");
      await fs.writeFile(target, "vsix");
    });
    const service = new UpdateService({ currentVersion: "0.1.12", download });
    const release = {
      version: "0.1.13",
      tagName: "v0.1.13",
      name: "CodeVibe 0.1.13",
      body: "Fixes",
      vsixUrl: "https://example.test/codevibe.vsix",
    };

    await service.install(release);

    expect(download).toHaveBeenCalled();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.extensions.installExtension",
      expect.objectContaining({ fsPath: expect.stringMatching(/\.vsix$/) }),
    );
  });
});
