# Building from source

## Requirements

- JDK 17
- Android SDK Platform 34 and Build Tools 34.0.0
- Gradle 8.7 (the wrapper is included)
- Android NDK r27c
- Go 1.27.3 for rebuilding cloudflared
- Windows PowerShell (the helper scripts target Windows)

## Android native libraries

Git intentionally excludes `app/src/main/jniLibs`, which contains compiled libraries. The release includes Node.js Mobile 24.20.0 and cloudflared 2026.10.5 for all three Android ABIs. Rebuild the native dependencies before assembling a fresh checkout.

1. Download the Node.js Mobile `v24.20.0-0` Android archive from the link and verify the SHA256 in `scripts/build.ps1`.
2. Prepare the matching NDK r28c libc++ runtime using `scripts/fetch-cxx-runtime.py`.
3. Run `scripts/build.ps1 -RebuildNative -NdkPath <path> -CxxRuntimePath <path>`.
4. Clone Cloudflare's `cloudflared` tag `2026.10.5` into `.tools/cloudflared-src`.
5. Run `scripts/build-cloudflared.ps1 -GoPath <go.exe> -NdkPath <ndk>`.
6. Run `scripts/build.ps1` to build and sign the APK. Preserve your own signing key for updates.
7. Run `python scripts/verify_apk.py` to check native libraries and packaging.

The Android DNS adapter source and Cloudflared binary provenance are in `native/cloudflared` and `third-party/cloudflared-provenance.json`.

## Upstream source

The original API is a Git submodule. Clone with `git clone --recurse-submodules`, or initialize it after cloning with `git submodule update --init --recursive`.

## Signing

The signing key is local, ignored by Git, and must not be shared. A newly generated key cannot update an APK signed with another key. For a public build, configure your own signing key and distribute the matching certificate safely.
