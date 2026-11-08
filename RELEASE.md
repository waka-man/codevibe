# Releases

Newest release first. Each entry becomes the GitHub release when it lands on
`main`. The automation reads the highest `## <x.y.z>` section, bumps
`package.json` to that version, tags `v<x.y.z>`, and publishes the VSIX.

To release a new version:

1. Add a new `## x.y.z` section at the top of this file with what changed.
2. Push to `main`.
3. The automation validates tests, builds the VSIX, tags `v<x.y.z>`,
   and publishes the release with the changelog and integrity hash.

No manual version bump in `package.json`, no manual tags, no manual releases.

---

## 0.1.14

- Fixed git pull falsely flagging pulled code as AI agent mode (#10, #24, #9)
- Fixed activation stability (#14, #26)

## 0.1.13

- Releases automation
