// Source strings. Every other locale must provide the same shape (see `Messages`).
// `{name}` placeholders are filled at render time and must survive translation.
export const en = {
  layout: {
    defaultTitle: "Par3",
    defaultDescription: "Par3 by Parity Labs. Review the plan, then let your coding agents ship.",
    socialImageAlt:
      "Par3: the control plane for coding agents, with Claude Code, Codex, Cursor, OpenCode, Grok and Antigravity.",
    homeLabel: "Par3 home",
    download: "Download",
    githubLabel: "Par3 on GitHub",
    language: "Language",
    mitLicensed: "MIT licensed",
    basedOn: "Based on T3 Code",
    terms: "Terms",
    privacy: "Privacy",
  },
  home: {
    title: "Par3 | The control plane for coding agents",
    description: "Par3 by Parity Labs. Review the plan, then let your coding agents ship.",
    heroTitle: ["Plan first.", "Then let your", "agents ship."],
    heroSub:
      "Par3 is the control plane for coding agents, built for teams. Review and approve the plan before Claude Code, Codex, GitHub Copilot, Cursor or OpenCode touches your code. Bring your own subscriptions.",
    downloadForMac: "Download for macOS",
    downloadForWindows: "Download for Windows",
    downloadForLinux: "Download for Linux",
    sourceLink: "View the source",
    screenshotAlt: "Par3 running Claude, Codex, Muse, and Gemini subagents in one thread",
    plansTitle: "See the plan before the code",
    plansBody:
      "Plan mode is a first-class setting in Par3. The agent proposes what it will change, you review and approve it, and only then does it write code. For bigger changes, Spec mode has agents write requirements that a person approves before any implementation starts. Your team stays in charge of what lands.",
    plansPoints: [
      "Approve, edit or reject every plan.",
      "Works with every supported agent.",
      "Your code stays on your machines.",
    ],
    harnessTitle: "Bring your own sub",
    harnessBody:
      "Par3 doesn't resell tokens. Plug in Claude Code, Codex, GitHub Copilot, Cursor, OpenCode, Grok, Antigravity or Pi with the credentials you already have. We orchestrate them, you keep your plan.",
    googleSignIn: "Google sign-in",
    harnessPoints: [
      "No keys resold. No quota caps.",
      "Switch models mid-thread.",
      "Copilot works with GitHub Enterprise.",
      "Add any agent from the ACP Registry.",
    ],
    gitVisualLabel:
      "Illustration of the Par3 Git workflow: review a diff, commit and push changes, and open a pull request.",
    prReady: "Ready",
    prCommits: "3 commits",
    viewDiff: "View diff",
    openPullRequest: "Open pull request",
    commitPush: "Commit & push",
    gitTitle: "One button to commit, push, and make a PR.",
    gitBody:
      "Every agent thread writes to its own branch. When it's good, one button opens the PR with a generated title, body and changelog. Then review, comment and merge it without leaving Par3.",
    gitPoints: [
      "Auto-generated PR titles & bodies",
      "Inline diff review before you push",
      "Guided reviews and GitHub stacks",
      "Agents watch their PRs for checks and reviews",
      "GitHub, GitHub Enterprise, GitLab, Bitbucket, Azure DevOps and Forgejo",
      "Jira issues shown next to the branch",
    ],
    featuresTitle: "Agents that keep working when you step away",
    featuresBody:
      "Run Par3 on the machine with your code, then steer it from anywhere. Agents hand work to each other, wake up on a schedule, and answer to the tools your team already uses.",
    features: [
      {
        name: "Work from anywhere",
        body: "Reach your machine from another desktop, a browser or your phone over Parity Connect, Tailscale, your LAN or SSH. No port forwarding.",
      },
      {
        name: "A real mobile app",
        body: "Follow threads, reply to your agents and review pull requests natively on iOS and Android.",
      },
      {
        name: "A lead and a sidekick",
        body: "Pair a frontier model with a cheaper one: the lead plans and reviews, the sidekick does the work. Inspired by Cognition's Devin Fusion. Threads can also hand tasks to any provider in their own worktree.",
      },
      {
        name: "Schedules and webhooks",
        body: "Run a prompt every morning, or whenever GitHub or another service calls a webhook. Each run lands in a thread you can review.",
      },
      {
        name: "Drive it from other agents",
        body: "Claude Code, Codex, ChatGPT and other MCP clients sign in with OAuth to start threads, read results and manage work.",
      },
      {
        name: "Access you can see",
        body: "Choose the permissions each device or outside agent gets when you pair it, and revoke its access at any time.",
      },
    ],
    openEyebrow: "Open source",
    openTitle: "If you don't like something, fork it.",
    openPoints: [
      { lead: "Change the UI.", rest: "Restyle every surface to match your taste." },
      { lead: "Add an agent.", rest: "Wire in your own tools, models, and flows." },
      { lead: "Ship your own build.", rest: "Self-host it or distribute it as your own." },
    ],
    forkOnGithub: "Fork on GitHub",
    browseSource: "Browse source",
    ctaTitle: "Your agents deserve better than a terminal.",
    ctaSub:
      "Par3 is free, open source and fast. Install it, plug in the agents you already pay for, and review every plan before it ships.",
    otherPlatforms: "Windows · Linux · other",
  },
  download: {
    title: "Download | Par3",
    description: "Download Par3 for macOS, Windows, or Linux.",
    breadcrumb: "Download",
    heading: "Download Par3",
    channelLabel: "Release channel",
    stable: "Stable",
    nightly: "Nightly",
    intelNote: "On an Intel Mac? {link}.",
    intelLink: "Download the x64 build",
    armNote: "On ARM? Download the arm64 {deb} or {appimage}.",
    terminal: "Terminal",
    tryOnce: "Or try it once without installing:",
    allBuilds: "All builds are on the {link}",
    releasesPage: "GitHub releases page",
    builtAgo: "Built {age}",
    releasesFallback: "Releases",
  },
};

type Widen<T> = T extends string
  ? string
  : T extends ReadonlyArray<infer Item>
    ? ReadonlyArray<Widen<Item>>
    : { readonly [Key in keyof T]: Widen<T[Key]> };

export type Messages = Widen<typeof en>;
