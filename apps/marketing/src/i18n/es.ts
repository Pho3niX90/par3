import type { Messages } from "./en";

export const es: Messages = {
  layout: {
    defaultTitle: "Par3",
    defaultDescription:
      "Par3, de Parity Labs. Revisa el plan y luego deja que tus agentes de programación lo entreguen.",
    socialImageAlt:
      "Par3: el panel de control para agentes de programación, con Claude Code, Codex, Cursor, OpenCode, Grok y Antigravity.",
    homeLabel: "Inicio de Par3",
    download: "Descargar",
    githubLabel: "Par3 en GitHub",
    language: "Idioma",
    mitLicensed: "Licencia MIT",
    basedOn: "Basado en T3 Code",
    terms: "Términos",
    privacy: "Privacidad",
  },
  home: {
    title: "Par3 | El panel de control para agentes de programación",
    description:
      "Par3, de Parity Labs. Revisa el plan y luego deja que tus agentes de programación lo entreguen.",
    heroTitle: ["Primero el plan.", "Después, que tus", "agentes entreguen."],
    heroSub:
      "Par3 es el panel de control para agentes de programación, pensado para equipos. Revisa y aprueba el plan antes de que Claude Code, Codex, GitHub Copilot, Cursor u OpenCode toquen tu código. Usa tus propias suscripciones.",
    downloadForMac: "Descargar para macOS",
    downloadForWindows: "Descargar para Windows",
    downloadForLinux: "Descargar para Linux",
    sourceLink: "Ver el código fuente",
    screenshotAlt: "Par3 ejecutando subagentes de Claude, Codex, Muse y Gemini en un mismo hilo",
    plansTitle: "Mira el plan antes que el código",
    plansBody:
      "El modo plan es un ajuste de primera clase en Par3. El agente propone lo que va a cambiar, tú lo revisas y lo apruebas, y solo entonces escribe código. Para cambios más grandes, el modo Spec hace que los agentes redacten requisitos que una persona aprueba antes de empezar la implementación. Tu equipo decide qué se integra.",
    plansPoints: [
      "Aprueba, edita o rechaza cada plan.",
      "Funciona con todos los agentes compatibles.",
      "Tu código se queda en tus máquinas.",
    ],
    harnessTitle: "Trae tu propia suscripción",
    harnessBody:
      "Par3 no revende tokens. Conecta Claude Code, Codex, GitHub Copilot, Cursor, OpenCode, Grok, Antigravity o Pi con las credenciales que ya tienes. Nosotros los orquestamos, tú conservas tu plan.",
    googleSignIn: "Inicio de sesión con Google",
    harnessPoints: [
      "Sin reventa de claves. Sin límites de cuota.",
      "Cambia de modelo a mitad del hilo.",
      "Copilot funciona con GitHub Enterprise.",
      "Añade cualquier agente del ACP Registry.",
    ],
    gitVisualLabel:
      "Ilustración del flujo de Git en Par3: revisar un diff, hacer commit y push de los cambios y abrir un pull request.",
    prReady: "Listo",
    prCommits: "3 commits",
    viewDiff: "Ver diff",
    openPullRequest: "Abrir pull request",
    commitPush: "Commit y push",
    gitTitle: "Un botón para hacer commit, push y abrir un PR.",
    gitBody:
      "Cada hilo de agente escribe en su propia rama. Cuando está bien, un botón abre el PR con título, descripción y changelog generados. Después revísalo, coméntalo y fusiónalo sin salir de Par3.",
    gitPoints: [
      "Títulos y descripciones de PR generados automáticamente",
      "Revisa el diff en la app antes de hacer push",
      "Revisiones guiadas y stacks de GitHub",
      "Los agentes vigilan los checks y revisiones de sus PRs",
      "GitHub, GitHub Enterprise, GitLab, Bitbucket, Azure DevOps y Forgejo",
      "Incidencias de Jira junto a la rama",
    ],
    featuresTitle: "Agentes que siguen trabajando cuando te vas",
    featuresBody:
      "Ejecuta Par3 en la máquina donde está tu código y dirígelo desde cualquier lugar. Los agentes se pasan trabajo entre sí, se activan según un horario y responden a las herramientas que tu equipo ya usa.",
    features: [
      {
        name: "Trabaja desde cualquier lugar",
        body: "Accede a tu máquina desde otro escritorio, un navegador o tu teléfono mediante Parity Connect, Tailscale, tu red local o SSH. Sin redirección de puertos.",
      },
      {
        name: "Una app móvil de verdad",
        body: "Sigue hilos, responde a tus agentes y revisa pull requests de forma nativa en iOS y Android.",
      },
      {
        name: "Un líder y un ayudante",
        body: "Combina un modelo de vanguardia con uno más barato: el líder planifica y revisa, el ayudante hace el trabajo. Inspirado en Devin Fusion de Cognition. Los hilos también pueden delegar tareas a cualquier proveedor en su propio worktree.",
      },
      {
        name: "Horarios y webhooks",
        body: "Ejecuta un prompt cada mañana, o cuando GitHub u otro servicio llame a un webhook. Cada ejecución queda en un hilo que puedes revisar.",
      },
      {
        name: "Contrólalo desde otros agentes",
        body: "Claude Code, Codex, ChatGPT y otros clientes MCP inician sesión con OAuth para crear hilos, leer resultados y gestionar el trabajo.",
      },
      {
        name: "Accesos a la vista",
        body: "Elige los permisos que recibe cada dispositivo o agente externo al emparejarlo, y revoca su acceso cuando quieras.",
      },
    ],
    openEyebrow: "Código abierto",
    openTitle: "Si algo no te gusta, haz un fork.",
    openPoints: [
      { lead: "Cambia la interfaz.", rest: "Rediseña cada pantalla a tu gusto." },
      { lead: "Añade un agente.", rest: "Integra tus propias herramientas, modelos y flujos." },
      { lead: "Publica tu propia versión.", rest: "Alójala tú mismo o distribúyela como tuya." },
    ],
    forkOnGithub: "Hacer fork en GitHub",
    browseSource: "Ver el código",
    ctaTitle: "Tus agentes merecen algo mejor que una terminal.",
    ctaSub:
      "Par3 es gratuito, de código abierto y rápido. Instálalo, conecta los agentes que ya pagas y revisa cada plan antes de que se publique.",
    otherPlatforms: "Windows · Linux · otras",
  },
  download: {
    title: "Descargar | Par3",
    description: "Descarga Par3 para macOS, Windows o Linux.",
    breadcrumb: "Descargar",
    heading: "Descargar Par3",
    channelLabel: "Canal de versiones",
    stable: "Estable",
    nightly: "Nightly",
    intelNote: "¿Tienes un Mac con Intel? {link}.",
    intelLink: "Descarga la versión x64",
    armNote: "¿Usas ARM? Descarga el {deb} o el {appimage} para arm64.",
    terminal: "Terminal",
    tryOnce: "O pruébalo sin instalar nada:",
    allBuilds: "Todas las compilaciones están en la {link}",
    releasesPage: "página de versiones de GitHub",
    builtAgo: "Compilada {age}",
    releasesFallback: "Versiones",
  },
};
