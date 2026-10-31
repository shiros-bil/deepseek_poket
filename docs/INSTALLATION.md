# Installation

## Install the release APK on Android

1. Download `DeepSeek-Pocket-1.3.3.apk` from the [latest release](https://github.com/shiros-bil/deepseek_poket/releases/latest).
2. Open the APK on the phone and approve installation from the selected source if Android asks.
3. Open DeepSeek Pocket, add a DeepSeek account, and start the API server.
4. Use `http://127.0.0.1:9655/v1` for a client on the phone. For a PC on the same Wi-Fi, enable LAN access and use `http://PHONE_IP:9655/v1`.

The API key is optional on localhost. Set one before enabling LAN or public access. Quick Tunnels need `stream: false`; use a Named Tunnel when a stable URL and SSE are required.

## Clone and build on a PC

The API server runs on Android, not on the PC. The PC can build the app or send test API requests to a phone running the app.

1. Install Git, JDK 17, Android Studio, SDK Platform 34, and Build Tools 34.0.0. Install NDK r27c if native components need rebuilding.
2. In PowerShell:

   ```powershell
   git clone --recurse-submodules https://github.com/shiros-bil/deepseek_poket.git
   cd deepseek_poket
   ./scripts/build.ps1
   python scripts/verify_apk.py
   ```

3. Open the project in Android Studio or install the generated APK on a connected phone. See [BUILDING.md](BUILDING.md) for native dependencies and signing details.
4. To test from the PC, keep the PC and phone on the same network, enable LAN access in the app, and send requests to `http://PHONE_IP:9655/v1`.
