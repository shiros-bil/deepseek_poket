# DeepSeek Pocket

[Русская версия](README.ru.md) · [Latest APK release](https://github.com/shiros-bil/deepseek_poket/releases/latest)

DeepSeek Pocket turns an Android phone into a small, OpenAI-compatible API endpoint backed by the DeepSeek web app. It is an independent, experimental adapter and a practical example for testing AI client requests routed through a phone. It is not an official DeepSeek API or service. Upstream behavior, account access, rate limits, and compatibility can change without notice.

## What it does

- Runs the API server on Android 8+ in a foreground service.
- Exposes `deepseek-v4.1-flash` and `deepseek-v4.1-flash-thinking` with web search enabled.
- Provides OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages compatible endpoints.
- Supports streaming, tools, and images where the upstream web app and client allow them.
- Lets clients on the same phone, local network, or an optional Cloudflare Tunnel send test requests to the phone.

## Download and install on Android

Download `DeepSeek-Pocket-1.3.3.apk` from the [latest release](https://github.com/shiros-bil/deepseek_poket/releases/latest), open it on the phone, and approve installation from that source if Android asks. Start the app, add a DeepSeek account, then start the API server.

For a client running on the same phone, use:

```text
http://127.0.0.1:9655/v1
```

For a client on a PC on the same Wi-Fi, enable LAN access in the app and use the phone's local IP address, for example `http://192.168.1.25:9655/v1`. The exact address depends on your network. Set an API key in the app before exposing the endpoint to a network. A Cloudflare Tunnel can provide HTTPS access from outside the local network.

## Test the endpoints

List models:

```bash
curl http://127.0.0.1:9655/v1/models
```

Send a chat completion from the phone (replace the model if needed):

```bash
curl http://127.0.0.1:9655/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

When an API key is configured, include `-H 'Authorization: Bearer YOUR_API_KEY'`. For the Anthropic-compatible endpoint use `POST /v1/messages`; for OpenAI Responses use `POST /v1/responses`. Other useful routes are `GET /health`, `GET /readyz`, `GET /v1/model-capabilities`, and `GET /v1/sessions`.

## Use the project on a PC

The API server itself runs on Android; cloning this repository does not turn a PC into a DeepSeek server. A PC is used to inspect or build the Android app, or to send test requests to the server running on a phone.

1. Install Git, JDK 17, Android Studio, and Android SDK Platform 34 / Build Tools 34.0.0. Install NDK r27c if rebuilding native components.
2. In PowerShell, clone the project and its upstream API submodule:

   ```powershell
   git clone --recurse-submodules https://github.com/shiros-bil/deepseek_poket.git
   cd deepseek_poket
   ```

3. Open the folder in Android Studio and allow Gradle sync, or build from PowerShell:

   ```powershell
   ./scripts/build.ps1
   python scripts/verify_apk.py
   ```

4. Install the generated APK on a connected Android phone, or download the release APK directly. See [build instructions](docs/BUILDING.md) for native libraries, signing, and a fresh checkout.
5. To send requests from the PC to the phone, connect both devices to the same network, enable LAN access on the phone, and point your client to `http://PHONE_IP:9655/v1`.

## API compatibility and limits

The app adapts requests to the DeepSeek web client; it does not provide the official DeepSeek API. Models, account availability, response behavior, and limits are controlled by the upstream service. `temperature`, `max_tokens`, `max_completion_tokens`, and `max_output_tokens` are passed as high-priority behavioral instructions. They are hints: the web client does not expose decoder temperature, and exact token limits cannot be enforced.

Requests should include the current conversation's message history when the client expects continuity. A request containing only one message cannot identify which earlier chat it belongs to. See [chat settings](README.ru.md#настройки-чата) or the app settings for history replay. A known content-filter placeholder may trigger one retry; recovery is not guaranteed.

## Network access

Enable **Settings → Public API** to start a Cloudflare Tunnel.

- A Quick Tunnel requires no Cloudflare account, but its address changes on restart and it does not support SSE. Use `stream: false` with it.
- A Named Tunnel uses your Cloudflare token and hostname and supports a stable address and SSE.
- Restrict browser origins where appropriate and set an API key before exposing the endpoint. Anyone who can reach an unprotected public URL may send requests through your account.

See [Cloudflare Quick Tunnel limitations](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## Documentation

- [Build from source](docs/BUILDING.md)
- [Install the APK](docs/INSTALLATION.md)
- [Russian README](README.ru.md)
- [Changelog](CHANGELOG.md)
- [Third-party notices](THIRD-PARTY.md)

## License

The Android adaptation is MIT licensed. See [`LICENSE`](LICENSE) and the third-party notices for component-specific terms.
