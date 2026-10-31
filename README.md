# DeepSeek Pocket

[Русская версия](README.ru.md) · [Latest release](https://github.com/shiros-bil/deepsee_poket/releases/latest)

DeepSeek Pocket runs an OpenAI-compatible API server on an Android phone. It supports Android 8 and newer, and includes ARM64, ARMv7, and x86_64 builds.

## Download

Install the APK from the [latest GitHub Release](https://github.com/shiros-bil/deepsee_poket/releases/latest). The app can update an earlier version without removing its accounts or preferences.

## Quick start

1. Install the APK and add a DeepSeek account in **Accounts**.
2. Start the API server in **Overview**.
3. Use `http://127.0.0.1:9655/v1` as the API base URL on the phone.
4. The API key is optional by default. Set a key in **Settings** when you expose the API to a network.

The API offers `deepseek-v4.1-flash` and `deepseek-v4.1-flash-thinking`. Web search is enabled for both. It supports OpenAI Chat Completions, Anthropic Messages, and Responses formats, including tools, images, and streaming.

## Public access

Enable **Settings → Public API** to start a Cloudflare Tunnel with the server. The HTTPS address appears in Overview.

- **Quick Tunnel** needs no Cloudflare account, but its address changes when restarted. Quick Tunnels do not support SSE; set `stream: false` in the client.
- **Named Tunnel** uses your Cloudflare token and hostname. It supports a stable hostname and SSE.
- Browser origins can be unrestricted or limited to an allowlist. An API key is recommended when the address is public.

See [Cloudflare Quick Tunnel limitations](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## Chat settings

Settings can be saved only while the server is stopped. If you leave Settings with unsaved changes, the app offers to apply or discard them.

The optional history settings replay the conversation sent by the API client. Clients should send the current conversation's messages to preserve context. A request with only one message cannot tell the server whether it belongs to a previous chat, so it gets a separate context.

The API also accepts `temperature`, `max_tokens`, `max_completion_tokens`, and `max_output_tokens`. The app adds these values to a high-priority prompt block. They are behavioral hints: DeepSeek Web does not expose decoder temperature controls, and token limits cannot be enforced exactly.

When DeepSeek returns a known content-filter placeholder, the API can retry once in a fresh chat with the request's supplied conversation and any captured partial answer. Streaming text is buffered until the final response state is checked. Recovery is not guaranteed.

## Build from source

Requirements: Java 17, Android SDK Platform 34, Android Build Tools 34.0.0, Gradle 8.7, and Android NDK r27c. Native Node.js Mobile and cloudflared libraries are excluded from Git; follow the build instructions in [`docs/BUILDING.md`](docs/BUILDING.md).

```powershell
./scripts/build.ps1
python scripts/verify_apk.py
```

The original API is included as the `upstream` Git submodule. Third-party notices and licenses are in [`THIRD-PARTY.md`](THIRD-PARTY.md) and the app assets.

## Project documents

- [Russian README](README.ru.md)
- [Build instructions](docs/BUILDING.md)
- [Installation guide](docs/INSTALLATION.md)
- [Release notes](CHANGELOG.md)

## License

The Android adaptation is MIT licensed. See [`LICENSE`](LICENSE) and the third-party notices for component-specific terms.
