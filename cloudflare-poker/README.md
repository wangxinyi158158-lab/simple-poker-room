# 好友扑克牌房间（Cloudflare Workers 版）

功能：创建/加入房间，无需注册；房间内至少两人都准备后每人随机发5张牌；所有玩家能看到所有人的手牌；初始积分0；可向其他玩家转让积分且允许负分。

## 部署说明
本项目需使用 Cloudflare Workers Builds / Wrangler 部署，不能只在 Hello World 示例中点击 Deploy。项目根目录包含 `wrangler.jsonc`，其中配置静态资源和 Durable Object 房间服务。

在连接 GitHub 仓库时，Build command 可留空或使用 `npm install`，Deploy command 使用 `npm run deploy`。首次部署若要求启用 Durable Objects migration，配置已写在 wrangler.jsonc 中。

注意：这是无账号的好友小游戏；不要把房间号公开发给陌生人。免费套餐额度和平台界面可能变化。
