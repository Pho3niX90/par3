import type { Messages } from "./en";

export const ko: Messages = {
  layout: {
    defaultTitle: "Par3",
    defaultDescription:
      "Parity Labs의 Par3. 계획을 먼저 검토하고, 그다음 코딩 에이전트가 배포하게 하세요.",
    socialImageAlt:
      "Par3: Claude Code, Codex, Cursor, OpenCode, Grok, Antigravity를 지원하는 코딩 에이전트 컨트롤 플레인.",
    homeLabel: "Par3 홈",
    download: "다운로드",
    githubLabel: "GitHub의 Par3",
    language: "언어",
    mitLicensed: "MIT 라이선스",
    basedOn: "T3 Code 기반",
    terms: "이용약관",
    privacy: "개인정보처리방침",
  },
  home: {
    title: "Par3 | 코딩 에이전트를 위한 컨트롤 플레인",
    description:
      "Parity Labs의 Par3. 계획을 먼저 검토하고, 그다음 코딩 에이전트가 배포하게 하세요.",
    heroTitle: ["계획이 먼저.", "그다음에", "에이전트가 배포."],
    heroSub:
      "Par3는 팀을 위해 만든 코딩 에이전트 컨트롤 플레인입니다. Claude Code, Codex, GitHub Copilot, Cursor, OpenCode가 코드를 건드리기 전에 계획을 검토하고 승인하세요. 구독은 쓰던 것 그대로.",
    downloadForMac: "macOS용 다운로드",
    downloadForWindows: "Windows용 다운로드",
    downloadForLinux: "Linux용 다운로드",
    sourceLink: "소스 보기",
    screenshotAlt: "한 스레드에서 Claude, Codex, Muse, Gemini 서브에이전트를 실행하는 Par3",
    plansTitle: "코드보다 계획을 먼저",
    plansBody:
      "Par3에서 플랜 모드는 정식 설정입니다. 에이전트가 무엇을 바꿀지 제안하면, 검토하고 승인한 뒤에야 코드를 작성합니다. 더 큰 변경에는 Spec 모드가 있어, 에이전트가 작성한 요구사항을 사람이 승인해야 구현이 시작됩니다. 무엇을 병합할지는 팀이 정합니다.",
    plansPoints: [
      "모든 계획을 승인, 수정 또는 거절하세요.",
      "지원하는 모든 에이전트에서 동작합니다.",
      "코드는 내 머신에 그대로 남습니다.",
    ],
    harnessTitle: "쓰던 구독 그대로",
    harnessBody:
      "Par3는 토큰을 재판매하지 않습니다. Claude Code, Codex, GitHub Copilot, Cursor, OpenCode, Grok, Antigravity, Pi를 이미 가진 자격 증명으로 연결하세요. 오케스트레이션은 저희가, 요금제는 그대로.",
    googleSignIn: "Google 로그인",
    harnessPoints: [
      "키 재판매 없음. 사용량 제한 없음.",
      "스레드 중간에도 모델 전환.",
      "Copilot은 GitHub Enterprise와도 동작합니다.",
      "ACP Registry의 어떤 에이전트든 추가하세요.",
    ],
    gitVisualLabel:
      "Par3 Git 워크플로 그림: diff를 검토하고, 변경 사항을 커밋 및 푸시하고, 풀 리퀘스트를 엽니다.",
    prReady: "준비됨",
    prCommits: "커밋 3개",
    viewDiff: "diff 보기",
    openPullRequest: "풀 리퀘스트 열기",
    commitPush: "커밋 & 푸시",
    gitTitle: "버튼 하나로 커밋, 푸시, PR까지.",
    gitBody:
      "에이전트 스레드는 각자 자기 브랜치에 작성합니다. 마음에 들면 버튼 하나로 제목, 본문, 변경 로그가 생성된 PR을 엽니다. 이후 검토, 댓글, 병합까지 Par3를 떠나지 않고 처리하세요.",
    gitPoints: [
      "PR 제목과 본문 자동 생성",
      "푸시 전 인라인 diff 리뷰",
      "가이드 리뷰와 GitHub 스택",
      "에이전트가 자기 PR의 체크와 리뷰를 지켜봅니다",
      "GitHub, GitHub Enterprise, GitLab, Bitbucket, Azure DevOps, Forgejo 지원",
      "브랜치 옆에 Jira 이슈 표시",
    ],
    featuresTitle: "자리를 비워도 계속 일하는 에이전트",
    featuresBody:
      "코드가 있는 머신에서 Par3를 실행하고, 어디서든 조종하세요. 에이전트끼리 작업을 넘겨주고, 일정에 맞춰 깨어나고, 팀이 이미 쓰는 도구에 응답합니다.",
    features: [
      {
        name: "어디서든 작업",
        body: "Parity Connect, Tailscale, LAN 또는 SSH로 다른 데스크톱, 브라우저, 휴대폰에서 내 머신에 접속하세요. 포트 포워딩은 필요 없습니다.",
      },
      {
        name: "진짜 모바일 앱",
        body: "iOS와 Android 네이티브 앱에서 스레드를 확인하고, 에이전트에 답하고, 풀 리퀘스트를 리뷰하세요.",
      },
      {
        name: "리드와 사이드킥",
        body: "최첨단 모델과 더 저렴한 모델을 짝지으세요. 리드는 계획하고 검토하며, 사이드킥이 작업을 합니다. Cognition의 Devin Fusion에서 영감을 받았습니다. 스레드는 어떤 제공자에게든 각자의 worktree에서 작업을 넘길 수도 있습니다.",
      },
      {
        name: "일정과 웹훅",
        body: "매일 아침 프롬프트를 실행하거나, GitHub 같은 서비스가 웹훅을 호출할 때 실행하세요. 실행 결과는 검토할 수 있는 스레드로 남습니다.",
      },
      {
        name: "다른 에이전트에서 조종",
        body: "Claude Code, Codex, ChatGPT 등 MCP 클라이언트가 OAuth로 로그인해 스레드를 시작하고, 결과를 읽고, 작업을 관리합니다.",
      },
      {
        name: "한눈에 보이는 접근 권한",
        body: "페어링할 때 기기나 외부 에이전트마다 권한을 정하고, 언제든 접근을 취소하세요.",
      },
    ],
    openEyebrow: "오픈 소스",
    openTitle: "마음에 안 들면 포크하세요.",
    openPoints: [
      { lead: "UI를 바꾸세요.", rest: "모든 화면을 취향대로 꾸밀 수 있습니다." },
      { lead: "에이전트를 추가하세요.", rest: "나만의 도구, 모델, 워크플로를 연결하세요." },
      { lead: "나만의 빌드를 만드세요.", rest: "직접 호스팅하거나 내 이름으로 배포하세요." },
    ],
    forkOnGithub: "GitHub에서 포크",
    browseSource: "소스 보기",
    ctaTitle: "에이전트를 터미널에만 두기엔 아깝습니다.",
    ctaSub:
      "Par3는 무료이고, 오픈 소스이며, 빠릅니다. 설치하고, 이미 결제 중인 에이전트를 연결하고, 배포 전에 모든 계획을 검토하세요.",
    otherPlatforms: "Windows · Linux · 기타",
  },
  download: {
    title: "다운로드 | Par3",
    description: "macOS, Windows, Linux용 Par3를 다운로드하세요.",
    breadcrumb: "다운로드",
    heading: "Par3 다운로드",
    channelLabel: "릴리스 채널",
    stable: "안정판",
    nightly: "Nightly",
    intelNote: "Intel Mac을 쓰시나요? {link}.",
    intelLink: "x64 빌드 다운로드",
    armNote: "ARM을 쓰시나요? arm64 {deb} 또는 {appimage}를 다운로드하세요.",
    terminal: "터미널",
    tryOnce: "설치 없이 한 번 실행해 보려면:",
    allBuilds: "모든 빌드는 {link}에 있습니다",
    releasesPage: "GitHub 릴리스 페이지",
    builtAgo: "{age} 빌드됨",
    releasesFallback: "릴리스",
  },
};
