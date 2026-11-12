import type { Messages } from "./en";

export const fr: Messages = {
  layout: {
    defaultTitle: "Par3",
    defaultDescription:
      "Par3, par Parity Labs. Validez le plan, puis laissez vos agents de codage livrer.",
    socialImageAlt:
      "Par3 : le poste de pilotage pour agents de codage, avec Claude Code, Codex, Cursor, OpenCode, Grok et Antigravity.",
    homeLabel: "Accueil Par3",
    download: "Télécharger",
    githubLabel: "Par3 sur GitHub",
    language: "Langue",
    mitLicensed: "Licence MIT",
    basedOn: "Basé sur T3 Code",
    terms: "Conditions",
    privacy: "Confidentialité",
  },
  home: {
    title: "Par3 | Le poste de pilotage pour agents de codage",
    description:
      "Par3, par Parity Labs. Validez le plan, puis laissez vos agents de codage livrer.",
    heroTitle: ["D'abord le plan.", "Ensuite, vos agents", "livrent."],
    heroSub:
      "Par3 est le poste de pilotage des agents de codage, conçu pour les équipes. Relisez et approuvez le plan avant que Claude Code, Codex, GitHub Copilot, Cursor ou OpenCode ne touche à votre code. Utilisez vos propres abonnements.",
    downloadForMac: "Télécharger pour macOS",
    downloadForWindows: "Télécharger pour Windows",
    downloadForLinux: "Télécharger pour Linux",
    sourceLink: "Voir le code source",
    screenshotAlt: "Par3 exécutant des sous-agents Claude, Codex, Muse et Gemini dans un même fil",
    plansTitle: "Voyez le plan avant le code",
    plansBody:
      "Le mode plan est un réglage à part entière dans Par3. L'agent propose ce qu'il va modifier, vous le relisez et l'approuvez, et seulement ensuite il écrit du code. Pour les changements plus importants, le mode Spec fait rédiger aux agents des exigences qu'une personne approuve avant toute implémentation. Votre équipe garde la main sur ce qui est intégré.",
    plansPoints: [
      "Approuvez, modifiez ou rejetez chaque plan.",
      "Fonctionne avec tous les agents pris en charge.",
      "Votre code reste sur vos machines.",
    ],
    harnessTitle: "Apportez votre abonnement",
    harnessBody:
      "Par3 ne revend pas de tokens. Branchez Claude Code, Codex, GitHub Copilot, Cursor, OpenCode, Grok, Antigravity ou Pi avec les identifiants que vous avez déjà. Nous les orchestrons, vous gardez votre forfait.",
    googleSignIn: "Connexion Google",
    harnessPoints: [
      "Aucune clé revendue. Aucun quota imposé.",
      "Changez de modèle en cours de fil.",
      "Copilot fonctionne avec GitHub Enterprise.",
      "Ajoutez n'importe quel agent de l'ACP Registry.",
    ],
    gitVisualLabel:
      "Illustration du workflow Git de Par3 : relire un diff, commiter et pousser les changements, puis ouvrir une pull request.",
    prReady: "Prête",
    prCommits: "3 commits",
    viewDiff: "Voir le diff",
    openPullRequest: "Ouvrir la pull request",
    commitPush: "Commit et push",
    gitTitle: "Un bouton pour commiter, pousser et ouvrir une PR.",
    gitBody:
      "Chaque fil d'agent écrit sur sa propre branche. Quand c'est bon, un bouton ouvre la PR avec un titre, une description et un changelog générés. Relisez-la, commentez-la et fusionnez-la ensuite sans quitter Par3.",
    gitPoints: [
      "Titres et descriptions de PR générés automatiquement",
      "Revue du diff intégrée avant de pousser",
      "Revues guidées et stacks GitHub",
      "Les agents suivent les checks et les revues de leurs PR",
      "GitHub, GitHub Enterprise, GitLab, Bitbucket, Azure DevOps et Forgejo",
      "Tickets Jira affichés à côté de la branche",
    ],
    featuresTitle: "Des agents qui continuent quand vous vous absentez",
    featuresBody:
      "Lancez Par3 sur la machine qui contient votre code, puis pilotez-le de n'importe où. Les agents se passent le travail, se réveillent selon un planning et répondent aux outils que votre équipe utilise déjà.",
    features: [
      {
        name: "Travaillez de partout",
        body: "Accédez à votre machine depuis un autre ordinateur, un navigateur ou votre téléphone via Parity Connect, Tailscale, votre réseau local ou SSH. Sans redirection de ports.",
      },
      {
        name: "Une vraie app mobile",
        body: "Suivez les fils, répondez à vos agents et relisez les pull requests en natif sur iOS et Android.",
      },
      {
        name: "Un chef et un acolyte",
        body: "Associez un modèle de pointe à un modèle moins cher : le chef planifie et relit, l'acolyte fait le travail. Inspiré de Devin Fusion de Cognition. Les fils peuvent aussi confier des tâches à n'importe quel fournisseur, dans leur propre worktree.",
      },
      {
        name: "Plannings et webhooks",
        body: "Lancez un prompt chaque matin, ou dès que GitHub ou un autre service appelle un webhook. Chaque exécution arrive dans un fil que vous pouvez relire.",
      },
      {
        name: "Pilotez-le depuis d'autres agents",
        body: "Claude Code, Codex, ChatGPT et d'autres clients MCP se connectent via OAuth pour lancer des fils, lire les résultats et gérer le travail.",
      },
      {
        name: "Des accès visibles",
        body: "Choisissez les permissions de chaque appareil ou agent externe lors de l'appairage, et révoquez son accès à tout moment.",
      },
    ],
    openEyebrow: "Open source",
    openTitle: "Si quelque chose ne vous plaît pas, forkez-le.",
    openPoints: [
      { lead: "Changez l'interface.", rest: "Personnalisez chaque écran à votre goût." },
      { lead: "Ajoutez un agent.", rest: "Branchez vos propres outils, modèles et workflows." },
      {
        lead: "Publiez votre propre version.",
        rest: "Hébergez-le vous-même ou distribuez-le sous votre nom.",
      },
    ],
    forkOnGithub: "Forker sur GitHub",
    browseSource: "Parcourir le code",
    ctaTitle: "Vos agents méritent mieux qu'un terminal.",
    ctaSub:
      "Par3 est gratuit, open source et rapide. Installez-le, branchez les agents que vous payez déjà et relisez chaque plan avant sa livraison.",
    otherPlatforms: "Windows · Linux · autres",
  },
  download: {
    title: "Télécharger | Par3",
    description: "Téléchargez Par3 pour macOS, Windows ou Linux.",
    breadcrumb: "Télécharger",
    heading: "Télécharger Par3",
    channelLabel: "Canal de publication",
    stable: "Stable",
    nightly: "Nightly",
    intelNote: "Sur un Mac Intel ? {link}.",
    intelLink: "Téléchargez la version x64",
    armNote: "Sur ARM ? Téléchargez le {deb} ou l'{appimage} arm64.",
    terminal: "Terminal",
    tryOnce: "Ou essayez-le sans rien installer :",
    allBuilds: "Toutes les versions sont sur la {link}",
    releasesPage: "page des releases GitHub",
    builtAgo: "Compilé {age}",
    releasesFallback: "Versions",
  },
};
