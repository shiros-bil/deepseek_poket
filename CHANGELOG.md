# Changelog

## 1.3.3

- Added high-priority prompt guidance from `temperature`, `max_tokens`, `max_completion_tokens`, and `max_output_tokens` request fields.
- Kept these settings when rebuilding a request after detecting a known content-filter placeholder.
- Disabled automatic continuation when an output token budget is requested.
- Clarified that generation settings are prompt guidance rather than decoder controls.

## 1.3.2

- Detect known DeepSeek content-filter signals and exact placeholder text.
- Retry once in a fresh chat with the request's supplied conversation and captured partial answer when available.
- Buffer streaming output until the final response is checked.

## 1.3.1

- Added explicit boundaries for system, user, and assistant messages.
- Removed the local HTTP body-size and prompt-length limits.
