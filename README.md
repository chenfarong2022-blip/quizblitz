# QuizBlitz

实时答题竞赛平台 - 老师发题，学生抢答，实时排名。

## 快速部署

### 1. 部署 PartyKit 服务器

```bash
npm install
npm run deploy
```

部署后会得到 WebSocket 服务器地址，例如：
`wss://quizblitz.chenfarong2022-blip.partykit.dev`

### 2. 部署静态页面到 Netlify Drop

1. 打开 https://app.netlify.com/drop
2. 将 `public` 文件夹拖入上传区域
3. 得到访问地址，例如：`https://xxx.netlify.app`

### 3. 配置页面

编辑 `public/index_standalone.html`，将第 28 行的 `PARTYKIT_HOST` 改为你的 PartyKit 服务器地址：

```javascript
const PARTYKIT_HOST = '你的-partykit-地址.partykit.dev';
```

### 4. 访问使用

- 老师访问: `https://xxx.netlify.app` → 选择"我是老师"
- 学生访问: `https://xxx.netlify.app` → 选择"我是学生"输入房间码
- 或让学生扫码加入

## 项目结构

```
quizblitz_cc/
├── party/
│   └── quizblitz.ts      # PartyKit WebSocket 服务器
├── public/
│   └── index_standalone.html  # 前端页面 (老师+学生)
├── package.json
├── partykit.json
└── tsconfig.json
```

## 功能

- ✅ 老师创建房间 (6位房间码)
- ✅ 手动添加题目 / 批量导入 JSON
- ✅ 实时发题 (所有学生同时收到)
- ✅ 抢答计分 (基础分 + 时间奖励)
- ✅ 实时排名
- ✅ 踢人功能
- ✅ 游戏重置
- ✅ 最终前三名展示

## 计分规则

```
得分 = 1000 (答对) + 50 × 剩余秒数
```

例如：还剩 5 秒时答对 → 1250 分

## 批量导入格式

```json
[
  {
    "question": "中国的首都是？",
    "options": ["上海", "北京", "广州", "深圳"],
    "correctAnswer": 1,
    "timeLimit": 15
  },
  {
    "question": "2 + 2 = ?",
    "options": ["3", "4", "5", "6"],
    "correctAnswer": 1,
    "timeLimit": 10
  }
]
```
