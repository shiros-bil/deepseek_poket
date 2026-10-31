# Android installation

1. Download `DeepSeek-Pocket-1.3.3.apk` from the [latest release](https://github.com/shiros-bil/deepsee_poket/releases/latest).
2. Open the APK on the Android phone and approve installation from the selected source if Android asks.
3. Open DeepSeek Pocket, add a DeepSeek account, then start the API in Overview.
4. Connect an app on the phone to `http://127.0.0.1:9655/v1`.

The app does not require an API key by default. Set one in Settings before enabling LAN or public access. Cloudflare Quick Tunnels require `stream: false`; select a Named Tunnel when a stable host and SSE are required.
