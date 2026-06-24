# Discord 測試入口設定

Discord 入口使用 HTTP Interactions，適合部署在 Vercel；不需要常駐 Gateway WebSocket。

## 1. 建立 Discord App

1. 前往 Discord Developer Portal，建立一個 Application，例如 `Brain Router`。
2. 在 **General Information** 複製：
   - Application ID
   - Public Key
3. 在 **Bot** 頁面取得 Bot Token。Token 只用來註冊 slash commands，不要提交到 Git。
4. 在 **Installation** 開啟 Guild Install，加入 `applications.commands` 與 `bot` scopes；Bot permission 先給 `Send Messages` 即可。

## 2. 設定 Vercel 環境變數

在 `brain-router-0623` 專案加入：

```text
DISCORD_APPLICATION_ID=<Application ID>
DISCORD_PUBLIC_KEY=<Public Key>
```

變更後重新部署。

## 3. 設定 Interaction Endpoint

回到 Discord Developer Portal 的 **General Information**，填入：

```text
https://brain-router-0623.vercel.app/api/discord/interactions
```

Discord 會送出已簽章的 PING；Vercel 環境變數正確時會驗證成功。

## 4. 註冊測試指令

先在 Discord 開啟 Developer Mode，複製測試 Server 的 ID。於本機暫時設定：

```text
DISCORD_APPLICATION_ID=<Application ID>
DISCORD_BOT_TOKEN=<Bot Token>
DISCORD_GUILD_ID=<測試 Server ID>
```

再執行：

```bash
npm run discord:register
```

有 `DISCORD_GUILD_ID` 時會註冊成測試 Server 指令，通常很快出現。確認穩定後，可移除該變數再執行一次，改註冊為全域指令。

## 5. 安裝與測試

把 App 安裝進測試 Server，接著測試：

```text
/eric message:你好，介紹一下你自己
/ryan message:評估我們是否該把 Discord 當主要入口
/queenie message:幫我看這個品牌語氣
/brain message:請找適合的 AI 同事一起評估新產品方向
```

Eric 使用 Magnific 時：

```text
/eric message:magnific 生成一隻穿黑西裝的柴犬，在台北夜市吃雞排，電影感攝影
```

第一次會收到 Magnific OAuth 連線網址。連接完成後，再送一次相同指令即可。

## 架構說明

- Discord 會在 3 秒內收到 deferred acknowledgment，避免顯示指令失敗。
- 真正的 Agent 工作在回應後執行，完成後更新原訊息；長回覆會自動分段。
- Discord 與 Slack 共用 Agent profiles、知識庫與模型設定，但以 `source=discord` 分開保存對話。
- 目前使用單一 Brain Router Discord App；Agent 人格與記憶仍各自獨立。若實測後希望每個 Agent 顯示成不同 Bot 身分，再拆成三個 Discord Applications。
