# Third-party components

| Component | Version / source | License |
| --- | --- | --- |
| FreeDeepseekAPI | ForgetMeAI, commit `648e708498bfae54cce085015fe5cf6e3e02b414` | MIT, original copyright preserved in LICENSE |
| Node.js Mobile | digidem/nodejs-mobile, release `v24.20.0-0` | Node.js license and bundled dependency notices in `app/src/main/assets/licenses/Nodejs-Mobile.txt` |
| LLVM libc++ runtime | Android NDK r28c; JNI compiled with r27c, `27.2.12479018` | NDK notices in `app/src/main/assets/licenses/Android-NDK-NOTICE.txt` |
| Lucide SVG icons | Pinned commit `2ca268e74888d3506b3319fb8f94aaaaf70ceca9` | ISC + Feather MIT, included in `app/src/main/assets/licenses/Lucide.txt` |
| DeepSeek launcher mark | Lobe Icons; provenance in `third-party/deepseek/provenance.json` | MIT, included in `app/src/main/assets/licenses/Lobe-Icons.txt`; DeepSeek brand mark |

Pinned Android runtime artifact:

`https://github.com/digidem/nodejs-mobile/releases/download/v24.20.0-0/nodejs-mobile-android-24.20.0-0.zip`

SHA256: `f5ffbaf4f2679fa9180b0758c637c2f8fc8828300f95129badf213a028fb37bb`.

The archive SHA256 was verified before extraction. No remote UI fonts, JavaScript CDNs or analytics are included. Original Lucide SVGs are bundled locally, with provenance in `third-party/lucide.json`. The remote DeepSeek login page naturally loads its own assets.

Lucide SVG geometry is used unchanged in the UI. `scripts/import-lucide.py` embeds vendored SVG bytes for offline WebView masks and converts the server geometry into the Android notification vector. The DeepSeek UI mark uses the same Lobe Icons SVG as the launcher; `scripts/import-deepseek-icon.py` imports it in black on a white adaptive launcher background. Both icon licenses are included in the APK.

libc++ is extracted from `https://dl.google.com/android/repository/android-ndk-r28c-windows.zip` with ZIP CRC validation and stripped with NDK llvm-strip. `scripts/fetch-cxx-runtime.py` reproduces extraction with HTTP range reads. A source provenance file is in `third-party/cxx-runtime-provenance.json`.

Cloudflare cloudflared 2026.10.5, official commit 99b2eb2c0152862af2b1abf7c7b4e2170a46b9fe, Apache-2.0. License in app/src/main/assets/licenses/Cloudflared.txt. Android builds add only the network DNS resolver adapter in native/cloudflared/pocket_dns_android.go; TLS verification remains enabled. Provenance and binary hashes: third-party/cloudflared-provenance.json.
