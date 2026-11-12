import type { Messages } from "./en";

export const ptBR: Messages = {
  layout: {
    defaultTitle: "Par3",
    defaultDescription:
      "Par3, da Parity Labs. Revise o plano e depois deixe seus agentes de programação entregarem.",
    socialImageAlt:
      "Par3: o painel de controle para agentes de programação, com Claude Code, Codex, Cursor, OpenCode, Grok e Antigravity.",
    homeLabel: "Página inicial do Par3",
    download: "Baixar",
    githubLabel: "Par3 no GitHub",
    language: "Idioma",
    mitLicensed: "Licença MIT",
    basedOn: "Baseado no T3 Code",
    terms: "Termos",
    privacy: "Privacidade",
  },
  home: {
    title: "Par3 | O painel de controle para agentes de programação",
    description:
      "Par3, da Parity Labs. Revise o plano e depois deixe seus agentes de programação entregarem.",
    heroTitle: ["Primeiro o plano.", "Depois, deixe seus", "agentes entregarem."],
    heroSub:
      "O Par3 é o painel de controle para agentes de programação, feito para equipes. Revise e aprove o plano antes que Claude Code, Codex, GitHub Copilot, Cursor ou OpenCode mexam no seu código. Use suas próprias assinaturas.",
    downloadForMac: "Baixar para macOS",
    downloadForWindows: "Baixar para Windows",
    downloadForLinux: "Baixar para Linux",
    sourceLink: "Ver o código-fonte",
    screenshotAlt: "Par3 executando subagentes do Claude, Codex, Muse e Gemini em uma única thread",
    plansTitle: "Veja o plano antes do código",
    plansBody:
      "O modo plano é uma configuração de primeira classe no Par3. O agente propõe o que vai mudar, você revisa e aprova, e só então ele escreve código. Para mudanças maiores, o modo Spec faz os agentes escreverem requisitos que uma pessoa aprova antes de a implementação começar. Sua equipe decide o que entra.",
    plansPoints: [
      "Aprove, edite ou rejeite cada plano.",
      "Funciona com todos os agentes compatíveis.",
      "Seu código fica nas suas máquinas.",
    ],
    harnessTitle: "Traga sua própria assinatura",
    harnessBody:
      "O Par3 não revende tokens. Conecte Claude Code, Codex, GitHub Copilot, Cursor, OpenCode, Grok, Antigravity ou Pi com as credenciais que você já tem. Nós orquestramos, você mantém seu plano.",
    googleSignIn: "Login com Google",
    harnessPoints: [
      "Sem revenda de chaves. Sem limite de cota.",
      "Troque de modelo no meio da thread.",
      "O Copilot funciona com GitHub Enterprise.",
      "Adicione qualquer agente do ACP Registry.",
    ],
    gitVisualLabel:
      "Ilustração do fluxo de Git no Par3: revisar um diff, fazer commit e push das alterações e abrir um pull request.",
    prReady: "Pronto",
    prCommits: "3 commits",
    viewDiff: "Ver diff",
    openPullRequest: "Abrir pull request",
    commitPush: "Commit e push",
    gitTitle: "Um botão para fazer commit, push e abrir um PR.",
    gitBody:
      "Cada thread de agente escreve no próprio branch. Quando estiver bom, um botão abre o PR com título, descrição e changelog gerados. Depois revise, comente e faça o merge sem sair do Par3.",
    gitPoints: [
      "Títulos e descrições de PR gerados automaticamente",
      "Revisão do diff inline antes do push",
      "Revisões guiadas e stacks do GitHub",
      "Os agentes acompanham checks e revisões dos seus PRs",
      "GitHub, GitHub Enterprise, GitLab, Bitbucket, Azure DevOps e Forgejo",
      "Issues do Jira ao lado do branch",
    ],
    featuresTitle: "Agentes que continuam trabalhando quando você sai",
    featuresBody:
      "Rode o Par3 na máquina onde está o seu código e comande de qualquer lugar. Os agentes passam trabalho uns para os outros, acordam em horários definidos e respondem às ferramentas que sua equipe já usa.",
    features: [
      {
        name: "Trabalhe de qualquer lugar",
        body: "Acesse sua máquina de outro desktop, de um navegador ou do celular via Parity Connect, Tailscale, sua rede local ou SSH. Sem redirecionamento de portas.",
      },
      {
        name: "Um app móvel de verdade",
        body: "Acompanhe threads, responda aos seus agentes e revise pull requests nativamente no iOS e no Android.",
      },
      {
        name: "Um líder e um ajudante",
        body: "Combine um modelo de ponta com um mais barato: o líder planeja e revisa, o ajudante faz o trabalho. Inspirado no Devin Fusion da Cognition. As threads também podem passar tarefas para qualquer provedor, cada uma em sua própria worktree.",
      },
      {
        name: "Agendamentos e webhooks",
        body: "Rode um prompt toda manhã, ou sempre que o GitHub ou outro serviço chamar um webhook. Cada execução vira uma thread que você pode revisar.",
      },
      {
        name: "Controle a partir de outros agentes",
        body: "Claude Code, Codex, ChatGPT e outros clientes MCP entram com OAuth para iniciar threads, ler resultados e gerenciar o trabalho.",
      },
      {
        name: "Acessos à vista",
        body: "Escolha as permissões de cada dispositivo ou agente externo ao pareá-lo, e revogue o acesso quando quiser.",
      },
    ],
    openEyebrow: "Código aberto",
    openTitle: "Se não gostar de algo, faça um fork.",
    openPoints: [
      { lead: "Mude a interface.", rest: "Redesenhe cada tela do seu jeito." },
      { lead: "Adicione um agente.", rest: "Integre suas próprias ferramentas, modelos e fluxos." },
      {
        lead: "Lance sua própria versão.",
        rest: "Hospede por conta própria ou distribua como sua.",
      },
    ],
    forkOnGithub: "Fazer fork no GitHub",
    browseSource: "Ver o código",
    ctaTitle: "Seus agentes merecem mais do que um terminal.",
    ctaSub:
      "O Par3 é gratuito, open source e rápido. Instale, conecte os agentes que você já paga e revise cada plano antes de ir para produção.",
    otherPlatforms: "Windows · Linux · outras",
  },
  download: {
    title: "Baixar | Par3",
    description: "Baixe o Par3 para macOS, Windows ou Linux.",
    breadcrumb: "Baixar",
    heading: "Baixar o Par3",
    channelLabel: "Canal de versões",
    stable: "Estável",
    nightly: "Nightly",
    intelNote: "Tem um Mac com Intel? {link}.",
    intelLink: "Baixe a versão x64",
    armNote: "Usa ARM? Baixe o {deb} ou o {appimage} para arm64.",
    terminal: "Terminal",
    tryOnce: "Ou experimente uma vez sem instalar:",
    allBuilds: "Todas as versões estão na {link}",
    releasesPage: "página de releases do GitHub",
    builtAgo: "Compilado {age}",
    releasesFallback: "Versões",
  },
};
