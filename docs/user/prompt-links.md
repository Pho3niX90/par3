# Prompt links

A prompt link opens Par3 with a prefilled draft—useful for sharing prompts or adding one-click fixes in pull request comments.

Links **never** auto-send or change your permission mode, branch, or worktree. They only open a draft for you to review and send.

## Create a link

- **From the composer**: Open the command palette and choose **Copy prompt link** (or **Copy prompt link with repo and model** on GitHub projects).
- **From a sent message**: Click **Copy prompt link**.
- **By hand** (URL-encode the prompt, e.g. with `encodeURIComponent`):

```text
https://app.paritylabs.co.za/new?prompt=Rate%20my%20swearing
https://app.paritylabs.co.za/new?prompt=Fix%20the%20build&repo=owner/name&provider=codex&model=gpt-5.5
https://app.paritylabs.co.za/new?pr=owner/name/123&prompt=Fix%20the%20failing%20check
```

| Parameter  | Description                                                       |
| ---------- | ----------------------------------------------------------------- |
| `prompt`   | Draft text (up to 8,000 characters). Required unless `pr` is set. |
| `repo`     | GitHub repository (`owner/name` or URL).                          |
| `provider` | Provider ID (e.g. `codex`, `claude`).                             |
| `model`    | Model ID or name for that provider.                               |
| `pr`       | GitHub pull request (`owner/name/123` or URL).                    |

## How links open

Opening a link on `app.paritylabs.co.za` asks whether to use the desktop/mobile app, the current browser, or the download page (**Remember my choice** skips this next time).

- **No `repo`**: Opens a no-project draft on your last-used machine.
- **`repo`**: Opens in your most recent project for that repo (or offers **Clone** / **Use without project**).
- **`provider` / `model`**: Applied if configured; otherwise falls back to your default with a notice.
- **`pr`**: Opens the thread linked to that PR, or prepares a new worktree draft on the PR branch after you confirm checkout.
- **Thread prompt link** (`https://app.paritylabs.co.za/<environment>/<thread>?prompt=…`): Prefills that thread's composer (asks before overwriting an existing draft).

Par3 strips invisible characters (such as zero-width and hidden tag characters) and warns you if a prompt contained them.

## GitHub Copilot app links

On Windows and macOS, the desktop app also opens GitHub's **Open in GitHub Copilot app** links, as long as the GitHub Copilot app is not installed to handle them. An issue opens a draft that asks the agent to work on it, in that repository. A pull request opens like a `pr` link. A Copilot session link uses its `repo`, `pr` and `prompt`, and ignores its mode and branch.

## Share a thread

**Copy thread** copies a link (`https://app.paritylabs.co.za/threads/<environment>/<thread>`) that opens in Par3 on desktop, web, or mobile and pastes into any composer as a thread chip. Only someone connected to the machine running that thread can view it.
