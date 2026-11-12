import type { Messages } from "./en";

export const ja: Messages = {
  layout: {
    defaultTitle: "Par3",
    defaultDescription:
      "Parity Labs の Par3。まず計画をレビューし、それからコーディングエージェントに任せましょう。",
    socialImageAlt:
      "Par3：Claude Code、Codex、Cursor、OpenCode、Grok、Antigravity に対応したコーディングエージェントのコントロールプレーン。",
    homeLabel: "Par3 ホーム",
    download: "ダウンロード",
    githubLabel: "GitHub の Par3",
    language: "言語",
    mitLicensed: "MIT ライセンス",
    basedOn: "T3 Code がベース",
    terms: "利用規約",
    privacy: "プライバシー",
  },
  home: {
    title: "Par3 | コーディングエージェントのコントロールプレーン",
    description:
      "Parity Labs の Par3。まず計画をレビューし、それからコーディングエージェントに任せましょう。",
    heroTitle: ["まず計画を。", "それから", "エージェントが出荷する。"],
    heroSub:
      "Par3 はチームのために作られた、コーディングエージェントのコントロールプレーンです。Claude Code、Codex、GitHub Copilot、Cursor、OpenCode がコードに触れる前に、計画をレビューして承認できます。サブスクリプションはお手持ちのものをそのまま使えます。",
    downloadForMac: "macOS 版をダウンロード",
    downloadForWindows: "Windows 版をダウンロード",
    downloadForLinux: "Linux 版をダウンロード",
    sourceLink: "ソースを見る",
    screenshotAlt: "ひとつのスレッドで Claude、Codex、Muse、Gemini のサブエージェントを動かす Par3",
    plansTitle: "コードの前に、計画を見る",
    plansBody:
      "Par3 ではプランモードが正式な設定です。エージェントが変更内容を提案し、あなたがレビューして承認してから、初めてコードを書きます。大きな変更には Spec モードがあり、エージェントが書いた要件を人が承認するまで実装は始まりません。何をマージするかはチームが決めます。",
    plansPoints: [
      "すべての計画を承認・編集・却下できます。",
      "対応するすべてのエージェントで使えます。",
      "コードは自分のマシンに置いたまま。",
    ],
    harnessTitle: "サブスクは持ち込みで",
    harnessBody:
      "Par3 はトークンを転売しません。Claude Code、Codex、GitHub Copilot、Cursor、OpenCode、Grok、Antigravity、Pi を、今お持ちの認証情報でそのまま接続できます。オーケストレーションは私たちが、プランはあなたのままで。",
    googleSignIn: "Google でサインイン",
    harnessPoints: [
      "キーの転売なし。利用枠の制限なし。",
      "スレッドの途中でもモデルを切り替え。",
      "Copilot は GitHub Enterprise にも対応。",
      "ACP Registry から任意のエージェントを追加。",
    ],
    gitVisualLabel:
      "Par3 の Git ワークフローの図：diff をレビューし、変更をコミット＆プッシュして、プルリクエストを作成する。",
    prReady: "準備完了",
    prCommits: "3 コミット",
    viewDiff: "diff を表示",
    openPullRequest: "プルリクエストを作成",
    commitPush: "コミット＆プッシュ",
    gitTitle: "ボタンひとつでコミット、プッシュ、PR 作成。",
    gitBody:
      "エージェントのスレッドはそれぞれ専用のブランチに書き込みます。仕上がったら、ボタンひとつでタイトル・本文・変更履歴付きの PR を作成。レビュー、コメント、マージまで Par3 から離れずに行えます。",
    gitPoints: [
      "PR のタイトルと本文を自動生成",
      "プッシュ前にその場で diff をレビュー",
      "ガイド付きレビューと GitHub スタック",
      "エージェントが自分の PR のチェックとレビューを見守る",
      "GitHub、GitHub Enterprise、GitLab、Bitbucket、Azure DevOps、Forgejo に対応",
      "ブランチの横に Jira の課題を表示",
    ],
    featuresTitle: "席を外しても、エージェントは働き続ける",
    featuresBody:
      "コードのあるマシンで Par3 を動かし、どこからでも操作できます。エージェント同士で作業を引き継ぎ、スケジュールに沿って起動し、チームがすでに使っているツールに応答します。",
    features: [
      {
        name: "どこからでも作業",
        body: "Parity Connect、Tailscale、LAN、SSH を通じて、別のデスクトップ、ブラウザ、スマートフォンから自分のマシンにアクセス。ポート転送は不要です。",
      },
      {
        name: "本物のモバイルアプリ",
        body: "iOS と Android のネイティブアプリで、スレッドを追い、エージェントに返信し、プルリクエストをレビューできます。",
      },
      {
        name: "リードとサイドキック",
        body: "最先端のモデルと安価なモデルを組み合わせ、リードが計画とレビューを、サイドキックが作業を担当します。Cognition の Devin Fusion に着想を得ました。スレッドは任意のプロバイダーに、専用の worktree でタスクを渡すこともできます。",
      },
      {
        name: "スケジュールと Webhook",
        body: "毎朝プロンプトを実行したり、GitHub などのサービスが Webhook を呼んだときに実行したり。各実行はレビューできるスレッドとして残ります。",
      },
      {
        name: "ほかのエージェントから操作",
        body: "Claude Code、Codex、ChatGPT などの MCP クライアントが OAuth でサインインし、スレッドの開始、結果の確認、作業の管理を行えます。",
      },
      {
        name: "見えるアクセス権限",
        body: "ペアリング時にデバイスや外部エージェントごとの権限を選び、いつでもアクセスを取り消せます。",
      },
    ],
    openEyebrow: "オープンソース",
    openTitle: "気に入らなければ、フォークすればいい。",
    openPoints: [
      { lead: "UI を変える。", rest: "あらゆる画面を好みのスタイルに。" },
      { lead: "エージェントを追加する。", rest: "独自のツール、モデル、フローを組み込めます。" },
      {
        lead: "自分のビルドを出す。",
        rest: "セルフホストも、自分のアプリとして配布するのも自由です。",
      },
    ],
    forkOnGithub: "GitHub でフォーク",
    browseSource: "ソースを見る",
    ctaTitle: "あなたのエージェントに、ターミナルだけではもったいない。",
    ctaSub:
      "Par3 は無料、オープンソース、そして高速。インストールして、すでに契約しているエージェントを接続し、出荷前にすべての計画をレビューしましょう。",
    otherPlatforms: "Windows · Linux · その他",
  },
  download: {
    title: "ダウンロード | Par3",
    description: "macOS、Windows、Linux 版の Par3 をダウンロード。",
    breadcrumb: "ダウンロード",
    heading: "Par3 をダウンロード",
    channelLabel: "リリースチャンネル",
    stable: "安定版",
    nightly: "Nightly",
    intelNote: "Intel Mac をお使いですか？　{link}。",
    intelLink: "x64 版をダウンロード",
    armNote: "ARM をお使いですか？　arm64 版の {deb} または {appimage} をダウンロード。",
    terminal: "ターミナル",
    tryOnce: "インストールせずに試すなら：",
    allBuilds: "すべてのビルドは {link} にあります",
    releasesPage: "GitHub のリリースページ",
    builtAgo: "{age}にビルド",
    releasesFallback: "リリース",
  },
};
