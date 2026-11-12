import type { Messages } from "./en";

export const de: Messages = {
  layout: {
    defaultTitle: "Par3",
    defaultDescription:
      "Par3 von Parity Labs. Prüfe den Plan, dann lass deine Coding-Agents liefern.",
    socialImageAlt:
      "Par3: die Steuerzentrale für Coding-Agents, mit Claude Code, Codex, Cursor, OpenCode, Grok und Antigravity.",
    homeLabel: "Startseite von Par3",
    download: "Download",
    githubLabel: "Par3 auf GitHub",
    language: "Sprache",
    mitLicensed: "MIT-lizenziert",
    basedOn: "Basiert auf T3 Code",
    terms: "Nutzungsbedingungen",
    privacy: "Datenschutz",
  },
  home: {
    title: "Par3 | Die Steuerzentrale für Coding-Agents",
    description: "Par3 von Parity Labs. Prüfe den Plan, dann lass deine Coding-Agents liefern.",
    heroTitle: ["Erst der Plan.", "Dann lass deine", "Agents liefern."],
    heroSub:
      "Par3 ist die Steuerzentrale für Coding-Agents, gebaut für Teams. Prüfe und genehmige den Plan, bevor Claude Code, Codex, GitHub Copilot, Cursor oder OpenCode deinen Code anfasst. Nutze deine eigenen Abos.",
    downloadForMac: "Für macOS herunterladen",
    downloadForWindows: "Für Windows herunterladen",
    downloadForLinux: "Für Linux herunterladen",
    sourceLink: "Quellcode ansehen",
    screenshotAlt: "Par3 führt Claude-, Codex-, Muse- und Gemini-Subagents in einem Thread aus",
    plansTitle: "Erst den Plan sehen, dann den Code",
    plansBody:
      "Der Planmodus ist in Par3 eine vollwertige Einstellung. Der Agent schlägt vor, was er ändern will, du prüfst und genehmigst es, und erst dann schreibt er Code. Bei größeren Änderungen lässt der Spec-Modus die Agents Anforderungen schreiben, die ein Mensch genehmigt, bevor die Umsetzung beginnt. Dein Team entscheidet, was gemergt wird.",
    plansPoints: [
      "Jeden Plan genehmigen, bearbeiten oder ablehnen.",
      "Funktioniert mit jedem unterstützten Agent.",
      "Dein Code bleibt auf deinen Rechnern.",
    ],
    harnessTitle: "Bring dein eigenes Abo mit",
    harnessBody:
      "Par3 verkauft keine Tokens weiter. Binde Claude Code, Codex, GitHub Copilot, Cursor, OpenCode, Grok, Antigravity oder Pi mit deinen vorhandenen Zugangsdaten ein. Wir orchestrieren, du behältst deinen Tarif.",
    googleSignIn: "Google-Anmeldung",
    harnessPoints: [
      "Keine weiterverkauften Keys. Keine Kontingentgrenzen.",
      "Modell mitten im Thread wechseln.",
      "Copilot funktioniert mit GitHub Enterprise.",
      "Jeden Agent aus der ACP Registry hinzufügen.",
    ],
    gitVisualLabel:
      "Illustration des Git-Workflows in Par3: Diff prüfen, Änderungen committen und pushen und einen Pull Request öffnen.",
    prReady: "Bereit",
    prCommits: "3 Commits",
    viewDiff: "Diff ansehen",
    openPullRequest: "Pull Request öffnen",
    commitPush: "Commit & Push",
    gitTitle: "Ein Klick für Commit, Push und PR.",
    gitBody:
      "Jeder Agent-Thread schreibt in seinen eigenen Branch. Wenn alles passt, öffnet ein Klick den PR mit generiertem Titel, Beschreibung und Changelog. Danach prüfst, kommentierst und mergst du ihn, ohne Par3 zu verlassen.",
    gitPoints: [
      "Automatisch generierte PR-Titel und -Beschreibungen",
      "Diff-Review direkt vor dem Push",
      "Geführte Reviews und GitHub-Stacks",
      "Agents behalten Checks und Reviews ihrer PRs im Blick",
      "GitHub, GitHub Enterprise, GitLab, Bitbucket, Azure DevOps und Forgejo",
      "Jira-Issues direkt neben dem Branch",
    ],
    featuresTitle: "Agents, die weiterarbeiten, wenn du weg bist",
    featuresBody:
      "Lass Par3 auf dem Rechner mit deinem Code laufen und steuere es von überall. Agents übergeben sich gegenseitig Arbeit, starten nach Zeitplan und reagieren auf die Tools, die dein Team schon nutzt.",
    features: [
      {
        name: "Arbeite von überall",
        body: "Erreiche deinen Rechner von einem anderen Desktop, im Browser oder vom Handy über Parity Connect, Tailscale, dein LAN oder SSH. Ohne Portweiterleitung.",
      },
      {
        name: "Eine echte mobile App",
        body: "Verfolge Threads, antworte deinen Agents und prüfe Pull Requests nativ auf iOS und Android.",
      },
      {
        name: "Ein Lead und ein Sidekick",
        body: "Kombiniere ein Spitzenmodell mit einem günstigeren: Der Lead plant und prüft, der Sidekick erledigt die Arbeit. Inspiriert von Devin Fusion von Cognition. Threads können Aufgaben auch an jeden Anbieter in einem eigenen Worktree übergeben.",
      },
      {
        name: "Zeitpläne und Webhooks",
        body: "Starte jeden Morgen einen Prompt, oder immer dann, wenn GitHub oder ein anderer Dienst einen Webhook aufruft. Jeder Lauf landet in einem Thread, den du prüfen kannst.",
      },
      {
        name: "Steuerung durch andere Agents",
        body: "Claude Code, Codex, ChatGPT und andere MCP-Clients melden sich per OAuth an, um Threads zu starten, Ergebnisse zu lesen und Arbeit zu verwalten.",
      },
      {
        name: "Zugriffe, die du siehst",
        body: "Lege beim Koppeln fest, welche Berechtigungen jedes Gerät oder jeder externe Agent erhält, und entziehe den Zugriff jederzeit.",
      },
    ],
    openEyebrow: "Open Source",
    openTitle: "Wenn dir etwas nicht gefällt, forke es.",
    openPoints: [
      { lead: "Ändere die UI.", rest: "Gestalte jede Oberfläche nach deinem Geschmack." },
      { lead: "Füge einen Agenten hinzu.", rest: "Binde eigene Tools, Modelle und Abläufe ein." },
      {
        lead: "Veröffentliche deinen eigenen Build.",
        rest: "Hoste ihn selbst oder vertreibe ihn als deinen eigenen.",
      },
    ],
    forkOnGithub: "Auf GitHub forken",
    browseSource: "Quellcode ansehen",
    ctaTitle: "Deine Agents verdienen Besseres als ein Terminal.",
    ctaSub:
      "Par3 ist kostenlos, Open Source und schnell. Installiere es, binde die Agents ein, für die du schon zahlst, und prüfe jeden Plan, bevor er live geht.",
    otherPlatforms: "Windows · Linux · andere",
  },
  download: {
    title: "Download | Par3",
    description: "Lade Par3 für macOS, Windows oder Linux herunter.",
    breadcrumb: "Download",
    heading: "Par3 herunterladen",
    channelLabel: "Release-Kanal",
    stable: "Stable",
    nightly: "Nightly",
    intelNote: "Mac mit Intel-Chip? {link}.",
    intelLink: "Lade den x64-Build herunter",
    armNote: "Auf ARM? Lade das {deb} oder {appimage} für arm64 herunter.",
    terminal: "Terminal",
    tryOnce: "Oder einmal ohne Installation ausprobieren:",
    allBuilds: "Alle Builds findest du auf der {link}",
    releasesPage: "GitHub-Releases-Seite",
    builtAgo: "Erstellt {age}",
    releasesFallback: "Releases",
  },
};
