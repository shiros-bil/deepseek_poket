# Установка

## Установка APK на Android

1. Скачайте `DeepSeek-Pocket-1.3.3.apk` из [последнего релиза](https://github.com/shiros-bil/deepseek_poket/releases/latest).
2. Откройте APK на телефоне и разрешите установку из выбранного источника, если Android спросит.
3. Запустите DeepSeek Pocket, добавьте аккаунт DeepSeek и включите API-сервер.
4. Для клиента на этом телефоне используйте `http://127.0.0.1:9655/v1`. Для ПК в той же Wi-Fi сети включите LAN-доступ и используйте `http://IP_ТЕЛЕФОНА:9655/v1`.

Для localhost API-ключ необязателен. Перед доступом из локальной сети или интернета задайте ключ. В Quick Tunnel укажите `stream: false`; для постоянного URL и SSE используйте Named Tunnel.

## Клонирование и сборка на ПК

API-сервер работает на Android, а не на компьютере. На ПК можно собрать приложение или отправлять тестовые запросы на телефон с запущенным приложением.

1. Установите Git, JDK 17, Android Studio, SDK Platform 34 и Build Tools 34.0.0. Для пересборки нативных компонентов установите NDK r27c.
2. В PowerShell выполните:

   ```powershell
   git clone --recurse-submodules https://github.com/shiros-bil/deepseek_poket.git
   cd deepseek_poket
   ./scripts/build.ps1
   python scripts/verify_apk.py
   ```

3. Откройте проект в Android Studio или установите созданный APK на подключённый телефон. Нативные зависимости и подпись описаны в [BUILDING.md](BUILDING.md).
4. Чтобы проверить API с ПК, подключите телефон и компьютер к одной сети, включите LAN-доступ в приложении и отправляйте запросы на `http://IP_ТЕЛЕФОНА:9655/v1`.
