# 酥鱼的 Feather 软件源

为 [Feather](https://github.com/claration/Feather) 制作的公开 iOS 侧载软件源。Cloudflare Worker 在用户刷新订阅时读取上游 Release，生成 AltStore 格式的 JSON；IPA 始终从原项目 GitHub Releases 直接下载。

| 应用 | 白名单仓库 | 收录范围 |
| --- | --- | --- |
| PiliPlus | `bggRGjQaUbCoE/PiliPlus` | 正式 Release 的 iOS IPA |
| Baha Plus | `InternetBugs/Baha-Plus` | 正式 Release 的未签名 iOS IPA |

没有 Cron Trigger、后台定时任务或定期更新源文件的 GitHub Actions。仓库保留的 Actions 仅在提交和 PR 时进行校验，不调用上游 API，也不部署 Worker。

## 在 Feather 中添加

公开订阅地址：

```text
https://feather-source.internetbugs.workers.dev/apps.json
```

在 Feather 的「软件源 / Sources」中添加该地址即可。订阅面向所有人开放，无需密钥、登录或自定义请求头，也没有客户端 IP 白名单。白名单只限制 Worker 可查询的上游软件仓库。

Worker 提供最近三个正式版本、更新说明和大小；同时保留 Feather 使用的 `versions` 和旧式 `version`、`downloadURL` 等字段。下载地址绑定具体版本，避免显示的版本和实际安装包不一致。

原地址 `https://raw.githubusercontent.com/InternetBugs/feather-repository/main/apps.json` 仍是仓库中的静态快照，不会随上游自动更新。迁移后需要在 Feather 中改用 Worker 订阅地址；GitHub Raw 无法通过修改 JSON 实现 HTTP 重定向。

## 白名单与用量保护

- **仓库白名单**：`src/feed.ts` 中固定两项 `ALLOWED_REPOS`，配置中的仓库也必须通过校验。HTTP 请求不能选择仓库或上游 URL。
- **路径白名单**：GitHub API 只读取这两个仓库的 Release 列表和固定的 Xcode 工程、版本脚本、发版工作流。拒绝异常 tag、路径穿越和上游重定向。
- **下载白名单**：核验 IPA 地址的 HTTPS 协议、精确域名、仓库、tag 和文件名，拒绝账号信息、端口、查询参数以及外部下载域名。Worker 不转发、不下载 IPA。
- **公开固定入口**：唯一业务入口为 `/apps.json`，所有人均可订阅。请求不能增加应用，也不能指定任意仓库、分支、上游 URL 或强制刷新。
- **请求限制**：只接受 GET / HEAD，拒绝查询参数和其他路由。按 Cloudflare 提供的 `CF-Connecting-IP` 对每个客户端限流，每个地区约 30 次/分钟，超出返回 429；忽略 `X-Forwarded-For`。该边缘限流是近似值，不充当全球 GitHub 配额，也不用于限制允许访问的 IP。
- **全球缓存与并发合并**：所有地区通过同一个固定源标识访问 Durable Object；成功结果保存 3 分钟，边缘缓存最多 30 秒且不超过刷新期限。请求不能创建额外对象或绕过缓存。
- **全球上游预算**：Durable Object 在每次 GitHub 请求前持久化计数。匿名访问过去一小时最多 40 次，配置 `GITHUB_TOKEN` 后最多 300 次；单次刷新最多 24 次请求。共享托管出口仍可能受 GitHub 其他流量影响，因此也处理上游 403 / 429。
- **故障回退**：刷新前先持久化至少 5 分钟的失败冷却期，再请求上游；成功后改为 3 分钟。上游限流时延长等待，最多保留 24 小时内的最后成功订阅。超过期限或首次生成失败返回 503 和 `Retry-After`，不返回缺少应用的订阅。
- **资源与日志**：上游请求有超时、响应体大小和文本文件大小限制。成功响应使用 `public, max-age=0, must-revalidate`，客户端每次刷新均检查服务端缓存；错误响应不缓存。关闭自动请求调用日志，代码只记录固定错误分类，不输出凭据或上游响应。

成功刷新后的共享缓存有效期为 3 分钟，到期后的下一次访问才查询上游。更新速度还受到 GitHub 限流、全局上游预算和故障冷却的影响，并非每次请求都直连 GitHub。

## 部署到 Cloudflare

需要 Node.js 22 及以上，以及已启用 Workers 的 Cloudflare 账户。使用 SQLite Durable Object，不需要手工创建 KV、数据库或外部服务。

```powershell
npm ci

# 生成官方类型、检查代码并运行不联网的运行时测试
npm run types
npm run check

# 首次使用时登录自己的 Cloudflare 账户
npx wrangler login

# 部署公开订阅源，无需配置订阅密钥
npm run deploy
```

自建部署时，使用 Wrangler 输出的实际域名并在后面添加 `/apps.json`。

可选 GitHub 令牌通过 Wrangler 的交互输入设置：

```powershell
npx wrangler secret put GITHUB_TOKEN
```

只需要公开仓库的读取能力，不需要写入权限。不要在 `wrangler.jsonc`、命令行参数或 Git 中填写令牌。设置令牌不会扩大仓库白名单。

修改应用配置后执行 `npm run types`、`npm run check`，再重新部署。更改应用时还需要同步调整代码中的仓库和路径白名单；仅修改请求参数或远程 JSON 不能增加上游。

## 本地开发与验证

```powershell
npm run types
npm run dev

# 类型检查、Worker 运行时测试，以及发布包预检查
npm run check
npm run deploy:check
```

本地请求使用 `http://localhost:8787/apps.json`。测试使用公开入口和模拟 GitHub 响应运行，不消耗 GitHub API 配额、不上传密钥、不访问真实 IPA。

现有 Python 工具保留为手动生成静态快照的辅助工具，需要 Python 3.11 及以上；Worker 不依赖它们运行：

```powershell
python tools/build_source.py --refresh --strict
python tools/verify_source.py
python -m unittest discover -s tests -v
```

## 元数据来源

- 版本记录的下载地址、大小、发布时间、更新说明和可用 SHA-256 来自 GitHub Release API。
- Bundle ID 和最低 iOS 版本来自相应 tag 的 Xcode 工程。
- PiliPlus 的应用版本、构建号来自 IPA 文件名；Release tag 另外记录。
- Baha Plus 的版本来自 `v主.次.修订` tag；核对该 tag 下的构建脚本和参数后，按 `主 × 1,000,000 + 次 × 1,000 + 修订` 计算构建号。规则改变时保留最后成功订阅并停止刷新。
- 图标来自相应 tag 的 AppIcon，安装包不经过 Worker。

这些信息没有通过读取成品 IPA 的 `Info.plist` 验证，真机安装结果仍需实际检查。

```text
src/index.ts                   公开入口、限流、边缘缓存、Durable Object
src/feed.ts                    GitHub 白名单客户端与订阅生成
wrangler.jsonc                 Worker、绑定、迁移和限流
source.config.json             源信息、应用元信息和版本保留数量
tests/worker.test.ts            Worker 运行时、安全与并发测试
apps.json                      手动维护的静态订阅快照
tools/build_source.py           Python 静态快照生成器
tools/verify_source.py          静态订阅校验
.github/workflows/validate.yml  提交与 PR 的离线校验
```

本仓库代码采用 MIT 许可证；收录应用的代码、图标和安装包遵循各自项目许可。
