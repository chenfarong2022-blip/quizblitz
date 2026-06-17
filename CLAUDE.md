# QuizBlitz 项目交接文档

> **接手人**: Codex  
> **移交日期**: 2026-06-05  
> **当前版本**: v1.80  
> **最后提交**: `b9bf4bc` - Fix student join stuck: set currentChannelName early to avoid publish race  

---

## 一、项目概述

QuizBlitz 是一个**实时汉语教学答题竞赛平台**。老师创建房间、发题，学生扫码加入、抢答，每道题结束后实时显示排名。最终前三名登上领奖台。

**目标用户**：初级汉语学习者（题干和选项为英文，关键语言点为中文）。

**部署地址**：
- GitHub Pages: `https://chenfarong2022-blip.github.io/quizblitz/`
- Netlify (备用): `https://quizblitz.netlify.app`（通过 `public/index_standalone.html`）

**GitHub 仓库**: `github.com/chenfarong2022-blip/quizblitz`  
**当前分支**: `master`（单分支开发）

---

## 二、技术栈

| 层 | 技术 | 说明 |
|---|------|------|
| **前端** | 纯 HTML/CSS/JS（单文件） | `index.html` 约 3500 行，包含 HTML/CSS/JS 全部代码 |
| **实时通信** | GoEasy (v2.8.0) | 基于 WebSocket 的第三方 Pub/Sub 服务 |
| **WebSocket 备选** | PartyKit | `party/quizblitz.ts`，较少使用 |
| **音效** | Web Audio API | 通过共享 AudioContext 生成合成音效 |
| **部署** | GitHub Pages + Netlify | push 即部署 |
| **CDN 依赖** | GoEasy SDK、QR Server API | 外部加载 |

---

## 三、项目文件结构

```
quizblitz_cc/
├── index.html                    ★ 主文件（全部前端代码，~3500行）
├── public/
│   └── index_standalone.html     Netlify 独立部署版本
├── 课件/                         课件源文件（用于设计题库）
│   ├── lesson12.html
│   ├── lesson13.html
│   └── lesson14.html
├── party/
│   └── quizblitz.ts              PartyKit WebSocket 服务器（备用）
├── partykit.json                 PartyKit 配置
├── package.json                  npm 配置（partykit 依赖）
├── netlify.toml                  Netlify 部署配置
├── *.mp3                         5个音频文件（背景音乐/音效）
├── README.md                     原始 README
└── 各种旧版本备份文件             *.html, *.js 旧版本快照，可忽略
```

---

## 四、核心架构

### 4.1 全局变量（关键）

```javascript
// 角色和房间
let roomCode = '';              // 6位房间码
let myRole = '';                // 'teacher' | 'student'
let isHost = false;             // 是否老师
let myPlayerId = '';            // 当前玩家唯一ID
let gameStatus = 'waiting';     // 'waiting' | 'playing' | 'finished'

// 题目和玩家
let questions = [];             // 当前题目列表
let players = [];               // 所有玩家 [{id, name, avatar, score}]
let currentQuestionIndex = -1;  // 当前题目序号（从0开始）
let myScore = 0;                // 当前玩家总分
let submittedThisQuestion = []; // 已提交本题的玩家ID列表

// 实时通信
let goEasy = null;              // GoEasy 实例
let goEasyChannel = null;       // 当前订阅频道
let goEasyConnected = false;    // 连接状态
let currentChannelName = '';    // 频道名 'quizblitz-{roomCode}'

// GoEasy 配置
const GOEASY_APPKEY = 'BC-51808aead9f94372a17f03fbd36e15e9';
// GoEasy host: 'hangzhou.goeasy.io'

// 连接监控
let lastMessageTime = Date.now();
let heartbeatTimer = null;
let connectionCheckTimer = null;
let _reconnecting = false;      // 重连中标志，防止并发重连
```

### 4.2 事件系统（10种事件类型）

所有事件通过 GoEasy Pub/Sub 频道 `quizblitz-{roomCode}` 广播：

| 事件 | 发送方 | 说明 |
|------|--------|------|
| `player-joined` | 学生→所有人 | 学生加入房间。含 `player` 对象和 `isReconnecting` 标记 |
| `game-start` | 老师→所有人 | 游戏开始 |
| `question` | 老师→所有人 | 发送题目（含 questionIndex 和题目数据） |
| `stop-question` | 老师→所有人 | 停止答题（含 correctAnswer） |
| `answer-submitted` | 学生→所有人 | 学生提交答案（含 isCorrect/points/totalScore） |
| `show-ranking` | 老师→所有人 | 显示本题排名 |
| `game-finished` | 老师→所有人 | 游戏结束 |
| `game-reset` | 老师→所有人 | 重置游戏 |
| `sync-state` | 老师→学生 | 重连学生状态同步（含完整游戏状态） |
| `heartbeat` | 学生→所有人 | 心跳包（30s间隔），维持连接活跃 |

### 4.3 发送事件的函数

```javascript
function publishEvent(eventName, data) {
    // 自动包装 { type, ...data, room, timestamp }
    // 通过 goEasy.pubsub.publish() 发送
    // player-joined 事件有5次重试机制
}
```

**⚠️ 重要**: `publishEvent` 依赖 `currentChannelName` 已设置。学生 join 时必须在调用前设置好。

---

## 五、连接监控与重连机制（v1.78-v1.80 新增）

### 5.1 学生端连接监控

```
启动流程:
joinRoom() → currentChannelName设置 → subscribeToRoom() → waitForConnectionAndJoin()
→ goEasyConnected=true 且 currentChannelName已就绪 → publishEvent('player-joined')
→ startConnectionMonitor()
```

```
监控逻辑:
每5秒检查: (当前时间 - lastMessageTime)
  >50秒未收到消息 → 进入重连模式
  _reconnecting=true → scheduleReconnect() → doReconnect()
  成功 → onReconnectSuccess() → 重订阅 + 重发player-joined
  失败 → scheduleReconnect() 指数退避重试（最多10次）
```

### 5.2 教师端状态同步

```
教师收到 player-joined 且 isReconnecting=true 且 gameStatus='playing'
→ 500ms后发送 sync-state 事件
→ 包含: gameStatus, currentQuestionIndex, players[], currentQuestion
```

### 5.3 关键函数

| 函数 | 位置（约） | 说明 |
|------|-----------|------|
| `startConnectionMonitor()` | L1709 | 启动心跳(30s)+断线检测(5s) |
| `stopConnectionMonitor()` | L1740 | 清理所有定时器 |
| `scheduleReconnect()` | L1773 | 指数退避调度重连（2s,4s,8s...） |
| `doReconnect()` | L1793 | 实际执行 GoEasy 重连 |
| `onReconnectSuccess()` | L1828 | 重连成功：清理旧订阅、重新订阅、重发 player-joined |
| `sendStateSync()` | L1858 | 教师发送完整游戏状态给重连学生 |
| `handleGoEasyEvent()` | L1960 | 所有事件处理入口，开头记录 `lastMessageTime` |

### 5.4 UI 指示器

- 右上角固定连接状态点：绿=Connected / 黄闪烁=Reconnecting / 红闪烁=Disconnected
- 长时间断线显示全屏遮罩 "Connection Lost" + 手动重试按钮

---

## 六、题库系统

### 6.1 内置题库（14个，共385题）

题库定义在 `BUILT_IN_BANKS` 对象中（约 L1197-1545），格式：

```javascript
const BUILT_IN_BANKS = {
    "题库名称": [
        {
            question: `题干（英文，必要时中文例句）`,
            options: ["A", "B", "C", "D"],  // 或 ["T", "F"] 判断题
            correctAnswer: 0,               // 0-based 正确答案索引
            timeLimit: 45                   // 秒数
        },
        // ... 更多题
    ],
    // ... 更多题库
};
```

**现有题库清单**：

| # | 题库名 | 题数 | 类型 |
|---|--------|------|------|
| 1 | 词汇练习 (Lessons 4-6) | 20 | 多选+T/F+填空 |
| 2 | 中国基本知识 (Basic China Knowledge) | 20 | 多选+T/F |
| 3 | 第八课口语 (Lesson 8 Speaking) | 18 | 多选 |
| 4 | 第七课口语 (Lesson 7 Speaking) | 20 | 多选 |
| 5 | 听力第七课 (Lesson 7 Listening) | 24 | 多选+T/F |
| 6 | 听力第八课 (Lesson 8 Listening) | 24 | 多选+T/F |
| 7 | 口语第八课 (Lesson 8 Speaking) | 24 | 多选+T/F |
| 8 | 听力第九课 (Lesson 9 Listening) | 32 | 多选+T/F |
| 9 | 听力第十课 (Lesson 10 Listening) | 35 | 多选+T/F |
| 10 | 听力第十一课 (Lesson 11 Listening) | 35 | 多选+T/F |
| 11 | 口语第九课 (Lesson 9 Speaking) | 35 | 多选+T/F |
| 12 | 听力第十二课 | 26 | 16多选+10判断 |
| 13 | 听力第十三课 | 26 | 16多选+10判断 |
| 14 | 听力第十四课 | 26 | 16多选+10判断 |

**如何添加新题库**：
1. 将新课件的 `.html` 文件放入 `课件/` 文件夹
2. 分析课件中的原始句和词汇，提取语言点和语法点
3. 设计 16 道选择题 + 10 道判断题（共 26 题）
4. 在 `BUILT_IN_BANKS` 最后一个题库的 `]` 和 `};` 之间插入新题库
5. 题库命名格式：`"听力第XX课"`
6. 提交前用 `node -e "..."` 检查语法

### 6.2 教师导入题目

教师可通过三种方式添加题目：
1. **手动添加**：逐题输入题目、选项、正确答案、时限
2. **JSON 批量导入**：粘贴 JSON 数组
3. **内置题库导入**：下拉选择，一键导入全部题目

导入格式：
```json
[{
    "question": "题目文本",
    "options": ["A", "B", "C", "D"],
    "correctAnswer": 0,
    "timeLimit": 15
}]
```

---

## 七、页面/UI 结构

### 7.1 页面 ID 清单

```
coverScreen           → 封面页（带动画背景、音乐、v1.80 版本号）
modeSelection         → 模式选择（老师/学生）
teacherJoin           → 教师端主容器（包含以下子页面）
  ├── teacherCreate   → 创建房间（显示房间码、二维码）
  ├── teacherRoomInfo → 房间信息（玩家列表、踢人按钮）
  ├── teacherEditor   → 题目编辑（手动添加/JSON导入/内置题库）
  ├── teacherControl  → 游戏控制（发题、停止、排名、下一题）
  └── teacherRankings → 教师端排名显示
studentMode           → 学生端主容器
  ├── studentJoin     → 加入表单（房间码、昵称、头像）
  └── studentWaiting  → 等待游戏开始
studentQuiz           → 学生答题界面（题目、选项、提交、倒计时、排名）
studentResult         → 学生本题结果
studentRanking        → 学生端排名列表
transitionPage        → 答题结束过渡页（2s）
finalRankingPage      → 最终排名领奖台（2-1-3 经典布局）
  └── podiumContainer → 领奖台容器
miniRankingPopup      → 单题排名弹窗（右上角弹出，8.5s 自动关闭）
miniRankingOverlay    → 排名弹窗半透明背景
teacherQuestionFullscreen → 教师全屏投影模式
connectionStatus      → 连接状态指示器（右上角固定）
connectionLostOverlay → 断线遮罩
```

### 7.2 显示/隐藏工具函数

```javascript
const $ = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');
// .hidden 类 = display: none !important
```

### 7.3 设计风格

采用 **玻璃拟态 (Glassmorphism)**：
- 深色渐变背景 + 浮动模糊彩色光球
- 卡片：`rgba(255,255,255,0.05)` + `backdrop-filter: blur(24px)`
- 按钮：渐变紫 `#6366f1` → `#4f46e5`
- 强调色：柔和紫 `#818cf8` / 柔和粉 `#f472b6` / 柔和金 `#fbbf24`

---

## 八、关键功能实现

### 8.1 领奖台 (Podium)

CSS 类 `.podium-container` 原本是 `display: flex`，会导致冠军横幅和领奖台排成一行而偏右。

**修复方案（v1.76）**：在 JS 中 `container.style.display = 'block'` 覆盖 CSS，内部奖台用内联 `display:flex; justify-content:center`。

### 8.2 分数滚动动画

```javascript
animateScoreRoll(el, endVal, duration, forceStart)
// 使用 easeOut cubic 缓动
// 每跨越50分触发一次 tick 音效（节流80ms）
// 视觉弹跳: CSS 类 score-tick（短暂缩放）
```

### 8.3 道具揭示动画

```
1. 600ms  → 季军 (rank-3) + playBronzeSound()
2. 2600ms → 亚军 (rank-2) + playSilverSound()
3. 5000ms → 冠军 (rank-1) + playGoldSound() + confetti×2
4. 6200ms → 亚/季军分数滚动
5. 8000ms → 冠军分数滚动
```

### 8.4 排名弹窗 FLIP 动画

单题排名弹窗使用 FLIP (First-Last-Invert-Play) 技术：
- 显示初始排名（旧分数）
- 4秒内所有分数同时滚动到新分数
- 每 ~220ms 根据最新排序用 `getBoundingClientRect` 做位置动画交换

---

## 九、音效系统

### 9.1 共享 AudioContext（v1.79 优化）

```javascript
var sharedAudioCtx = null;
function getAudioCtx() {
    if (!sharedAudioCtx) {
        sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (sharedAudioCtx.state === 'suspended') {
        sharedAudioCtx.resume();
    }
    return sharedAudioCtx;
}
```

**⚠️ 所有音效函数必须使用 `getAudioCtx()` 而不是 `new AudioContext()`**，否则多次调用会创建大量 AudioContext 导致音效卡顿。

### 9.2 音效函数

| 函数 | 波形 | 频率 | 时长 | 用途 |
|------|------|------|------|------|
| `playTickSound()` | Square | 1200Hz | 0.05s | 倒计时/分数滚动 tick |
| `playBeepSound()` | Sine | 880Hz | 0.15s | 学生提交通知老师 |
| `playJoinSound()` | Sine×2 | 660→880Hz | 0.35s | 新学生加入 |
| `playBronzeSound()` | Triangle | 440→660Hz | 0.4s | 季军揭示 |
| `playSilverSound()` | Sine×2 | 660,880Hz | 0.5s | 亚军揭示 |
| `playGoldSound()` | Sine×4 | C5-E5-G5-C6 | 1.1s | 冠军揭示 |

### 9.3 Tick 音效节流

分数滚动时的 tick 音效有 80ms 最小间隔限制，通过 `window._lastTickTime` 跟踪。

---

## 十、音乐系统

### 10.1 HTML Audio 元素

| ID | 源文件 | 回环 | 用途 |
|----|--------|------|------|
| `bgMusic` | 封面页Kalimba Loop.mp3 | ✅ | 封面背景音乐 |
| `gameMusic` | quiz.mp3 | ✅ | 答题背景音乐 |
| `victorySound` | Glockenspiel Victory.mp3 | ❌ | 答对音效 |
| `finalMusic` | End Glitter Wins!.mp3 | ✅ | 最终领奖台音乐 |

音频文件托管在: `https://raw.githubusercontent.com/chenfarong2022-blip/quizblitz/master/`

### 10.2 音乐播放辅助函数

```javascript
playMusicSafely(audioId, restart)
// 处理浏览器自动播放策略限制
// 失败时将元素标记 needsRetry
// tryResumePendingAudio() 在用户首次交互时重试
```

---

## 十一、计分规则

```
得分 = 1000 (答对基础分) + 50 × 剩余秒数

例：还剩5秒 → 1000 + 50×5 = 1250 分
答错 → 0 分
```

---

## 十二、常见问题与坑

### 12.1 学生扫码进不去（已修复 v1.80）

**根因**: `joinRoom()` 中 `waitForConnectionAndJoin` 和 `subscribeToRoom` 并行轮询。前者只检查 `goEasyConnected`，不检查 `currentChannelName`。如果前者先等到连接，但 `doSubscribe` 还没运行（此时 `currentChannelName` 仍为空），`publishEvent('player-joined')` 静默失败。

**修复**: `currentChannelName` 在 `joinRoom()` 入口处就设置（不再依赖 `doSubscribe`），`waitForConnectionAndJoin` 增加了 `currentChannelName` 检查。

### 12.2 重连竞态条件（已修复 v1.79）

**根因**: 旧版 `attemptReconnect()` 可能被断线检测器每隔5秒并发调用，且内部递归自调用，导致多个重连同时进行，互相覆盖。

**修复**: 引入 `_reconnecting` 标志位，分离 `scheduleReconnect()`（延时调度）和 `doReconnect()`（实际执行），杜绝并发重连。

### 12.3 分数滚动音效卡顿（已修复 v1.79）

**根因**: `playTickSound()` 每次创建新 AudioContext。多个分数同时滚动时大量 AudioContext 堆积。

**修复**: 所有音效函数共享一个 `sharedAudioCtx`，tick 音效节流 80ms。

### 12.4 领奖台偏右（已修复 v1.76）

**根因**: `.podium-container` CSS `display: flex`（row默认方向），导致冠军横幅和内层 podium-container 作为两个 flex 子元素左右排列。

**修复**: JS 中 `container.style.display = 'block'` 覆盖 CSS，内部用内联 `display:flex; justify-content:center` 居中。

### 12.5 排名弹窗闪烁（已修复 v1.72）

**根因**: FLIP 动画在 DOM 重排时重新触发 CSS 动画 `slideInRankings`。

**修复**: FLIP 阶段暂停 CSS 动画。

---

## 十三、开发工作流

### 13.1 日常开发

```bash
# 所有修改都在 index.html 中
# 修改后用 node 语法检查：
node -e "
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const scripts = html.match(/<script[\s\S]*?>([\s\S]*?)<\/script>/g);
scripts.forEach((s, i) => {
  const code = s.replace(/<script[^>]*>/, '').replace('<\/script>', '');
  try { new Function(code); } catch(e) { console.log('Block', i, e.message); }
});
console.log('Done');
"

# 提交和推送
git add index.html
git commit -m "描述改动; vX.XX"
git push origin master
```

### 13.2 版本号规范

- 版本号在封面页底部 `<p>vX.XX</p>` 
- **每次重要改动都要更新版本号**
- 格式：`vX.XX`（如 v1.80）

### 13.3 添加新课库的步骤

1. 将课件 HTML 放入 `课件/` 文件夹
2. 用 `grep -oP 'original-text">[^<]+' 课件/lessonXX.html` 提取原句
3. 从原句中识别关键词汇和语法点
4. 设计 16 道选择题（10 词汇 + 6 语法）+ 10 道判断题
5. 题干和选项用英文描述，中文仅出现在例句中
6. 判断题考点不能与选择题重复
7. 判断题不能太简单（测试近义词辨析、语法细节、常见偏误）
8. 在 `BUILT_IN_BANKS` 对象末尾插入新题库
9. `node -e` 语法检查后提交

### 13.4 版本号更新记录

| 版本 | 主要改动 |
|------|----------|
| v1.80 | 修复学生扫码进不去（currentChannelName 提前设置） |
| v1.79 | 重写连接监控（修复重连竞态）+ 共享 AudioContext + tick 节流 |
| v1.78 | 添加连接监控、心跳、自动重连、状态同步 |
| v1.77 | 添加 听力第十二/十三/十四课 题库（各26题） |
| v1.76 | 修复领奖台偏右（flex block 覆盖） |
| v1.75 | 修复领奖台闪现 + 居中 |
| v1.74 | 道具一个一个揭示 + 金银铜音效 |
| v1.73 | 简化领奖台为传统 2-1-3 布局 |

---

## 十四、外部依赖与服务

### 14.1 GoEasy

- **AppKey**: `BC-51808aead9f94372a17f03fbd36e15e9`
- **Host**: `hangzhou.goeasy.io`
- **SDK**: `https://cdn.goeasy.io/goeasy-2.8.0.min.js`
- **计费模式**: 按连接数和消息量
- **备用方案**: PartyKit (`party/quizblitz.ts`)

### 14.2 QR Code 生成

```javascript
`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`
```

### 14.3 GitHub Pages 部署

- 仓库: `chenfarong2022-blip/quizblitz`
- 分支: `master`
- 设置: Settings → Pages → Source: Deploy from a branch → master → / (root)
- 自动部署: push 后约 1-2 分钟生效

### 14.4 Netlify（备用）

- 配置文件: `netlify.toml`
- 发布目录: `public/`
- 入口: `index_standalone.html`

---

## 十五、Git 操作注意事项

- **远程 URL 含 token**：`https://ghp_...@github.com/...`，不要泄露
- **单分支 master**：所有改动直接推 master，无 PR 流程
- **网络问题**：GitHub 在中国大陆可能不稳定，push 失败时重试
- **Co-authored-by**: 提交信息末尾有 `Co-Authored-By: Claude <noreply@anthropic.com>`

---

## 十六、待办/未来改进

- [ ] 断线恢复后学生可能丢失已提交的答案
- [ ] 音箱音效在移动端表现不佳
- [ ] 题库可以拆分为独立 JSON 文件而非全部嵌入 index.html
- [ ] 教师端可以增加题目预览功能
- [ ] 学生端可以增加聊天/表情反馈
- [ ] 可以考虑用 PartyKit 替代 GoEasy 以降低费用

---

## 十七、紧急联系

如有问题可联系原开发者 **陈法榕**（浙江大学）。

---

**文档版本**: 1.0  
**生成时间**: 2026-06-05  
**生成工具**: Claude Code
