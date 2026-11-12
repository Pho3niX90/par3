import type { Messages } from "./en";

export const zh: Messages = {
  layout: {
    defaultTitle: "Par3",
    defaultDescription: "Par3，由 Parity Labs 打造。先审查计划，再让编程智能体交付。",
    socialImageAlt:
      "Par3：面向编程智能体的控制中心，支持 Claude Code、Codex、Cursor、OpenCode、Grok 和 Antigravity。",
    homeLabel: "Par3 首页",
    download: "下载",
    githubLabel: "GitHub 上的 Par3",
    language: "语言",
    mitLicensed: "MIT 许可",
    basedOn: "基于 T3 Code",
    terms: "条款",
    privacy: "隐私",
  },
  home: {
    title: "Par3 | 面向编程智能体的控制中心",
    description: "Par3，由 Parity Labs 打造。先审查计划，再让编程智能体交付。",
    heroTitle: ["先定计划，", "再让你的", "智能体交付。"],
    heroSub:
      "Par3 是为团队打造的编程智能体控制中心。在 Claude Code、Codex、GitHub Copilot、Cursor 或 OpenCode 动你的代码之前，先审查并批准计划。使用你自己的订阅。",
    downloadForMac: "下载 macOS 版",
    downloadForWindows: "下载 Windows 版",
    downloadForLinux: "下载 Linux 版",
    sourceLink: "查看源码",
    screenshotAlt: "Par3 在同一个线程中运行 Claude、Codex、Muse 和 Gemini 子智能体",
    plansTitle: "先看计划，再看代码",
    plansBody:
      "计划模式是 Par3 的一等设置。智能体先提出要改什么，你审查并批准后，它才开始写代码。对于更大的改动，Spec 模式让智能体先写需求，由人批准后才开始实现。合入什么，由你的团队决定。",
    plansPoints: [
      "批准、编辑或拒绝每一份计划。",
      "适用于所有支持的智能体。",
      "你的代码留在你自己的机器上。",
    ],
    harnessTitle: "自带订阅",
    harnessBody:
      "Par3 不转售 token。用你已有的凭据接入 Claude Code、Codex、GitHub Copilot、Cursor、OpenCode、Grok、Antigravity 或 Pi。我们负责编排，你保留自己的套餐。",
    googleSignIn: "Google 登录",
    harnessPoints: [
      "不转售密钥，不设额度上限。",
      "线程进行中也能切换模型。",
      "Copilot 支持 GitHub Enterprise。",
      "可从 ACP Registry 添加任意智能体。",
    ],
    gitVisualLabel: "Par3 Git 工作流示意图：审查 diff、提交并推送更改，然后创建拉取请求。",
    prReady: "就绪",
    prCommits: "3 个提交",
    viewDiff: "查看 diff",
    openPullRequest: "创建 PR",
    commitPush: "提交并推送",
    gitTitle: "一键提交、推送并创建 PR。",
    gitBody:
      "每个智能体线程都写入自己的分支。满意之后，一键创建 PR，自动生成标题、描述和变更日志。然后在 Par3 内完成审查、评论和合并。",
    gitPoints: [
      "自动生成 PR 标题和描述",
      "推送前就地审查 diff",
      "引导式审查与 GitHub stack",
      "智能体会跟进自己 PR 的检查和审查",
      "支持 GitHub、GitHub Enterprise、GitLab、Bitbucket、Azure DevOps 和 Forgejo",
      "在分支旁显示 Jira 问题",
    ],
    featuresTitle: "你离开时，智能体照样工作",
    featuresBody:
      "在存放代码的机器上运行 Par3，然后随时随地操控它。智能体之间互相交接工作，按计划自动启动，并响应团队已在使用的工具。",
    features: [
      {
        name: "随处工作",
        body: "通过 Parity Connect、Tailscale、局域网或 SSH，从另一台电脑、浏览器或手机访问你的机器。无需端口转发。",
      },
      {
        name: "真正的移动应用",
        body: "在 iOS 和 Android 上原生查看线程、回复智能体并审查拉取请求。",
      },
      {
        name: "主力与助手",
        body: "把前沿模型和更便宜的模型搭配使用：主力负责规划和审查，助手负责干活。灵感来自 Cognition 的 Devin Fusion。线程也可以把任务交给任意提供方，在各自的 worktree 中完成。",
      },
      {
        name: "定时任务与 webhook",
        body: "每天早上运行一个提示词，或在 GitHub 等服务调用 webhook 时运行。每次运行都会生成一个可供审查的线程。",
      },
      {
        name: "由其他智能体驱动",
        body: "Claude Code、Codex、ChatGPT 和其他 MCP 客户端通过 OAuth 登录，即可创建线程、读取结果并管理工作。",
      },
      {
        name: "权限一目了然",
        body: "配对时为每台设备或外部智能体选择权限，并可随时撤销其访问。",
      },
    ],
    openEyebrow: "开源",
    openTitle: "哪里不喜欢，就 fork 它。",
    openPoints: [
      { lead: "改 UI。", rest: "按你的喜好重新设计每个界面。" },
      { lead: "加智能体。", rest: "接入你自己的工具、模型和工作流。" },
      { lead: "发布你自己的版本。", rest: "自行托管，或以你自己的名义分发。" },
    ],
    forkOnGithub: "在 GitHub 上 fork",
    browseSource: "浏览源码",
    ctaTitle: "终端配不上你的智能体。",
    ctaSub: "Par3 免费、开源、快速。安装它，接入你已经付费的智能体，并在每份计划交付前进行审查。",
    otherPlatforms: "Windows · Linux · 其他",
  },
  download: {
    title: "下载 | Par3",
    description: "下载 macOS、Windows 或 Linux 版 Par3。",
    breadcrumb: "下载",
    heading: "下载 Par3",
    channelLabel: "发布通道",
    stable: "稳定版",
    nightly: "Nightly 版",
    intelNote: "使用 Intel 芯片的 Mac？{link}。",
    intelLink: "下载 x64 版本",
    armNote: "ARM 架构？下载 arm64 版 {deb} 或 {appimage}。",
    terminal: "终端",
    tryOnce: "或者无需安装，直接试用一次：",
    allBuilds: "所有版本都在 {link}上",
    releasesPage: "GitHub 发布页面",
    builtAgo: "{age}构建",
    releasesFallback: "发布页面",
  },
};
