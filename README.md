# 酥鱼的 Feather 软件源

为 [Feather](https://github.com/claration/Feather) 制作的自用 iOS 侧载软件源，结构参考 [laincat/AltStore](https://github.com/laincat/AltStore)。

| 应用 | 上游项目 | 收录范围 |
| --- | --- | --- |
| PiliPlus | [bggRGjQaUbCoE/PiliPlus](https://github.com/bggRGjQaUbCoE/PiliPlus) | 正式 Release 的 iOS IPA |
| Baha Plus | [InternetBugs/Baha-Plus](https://github.com/InternetBugs/Baha-Plus) | 正式 Release 的未签名 iOS IPA |

## 在 Feather 中添加

复制下面的订阅地址，在 Feather 中添加：

```text
https://raw.githubusercontent.com/InternetBugs/feather-repository/main/apps.json
```

在 Feather 的「软件源 / Sources」页面，点击添加按钮，粘贴以上地址并确认。刷新后即可选择应用、下载并使用自己的证书签名安装。界面文字可能因 Feather 版本和语言而异。

`apps.json` 同时提供 Feather 优先使用的 `versions` 列表与旧式 `version`、`downloadURL` 等字段。最近三个正式版本按发布时间从新到旧排列；版本号相同时仍保留不同的构建号，方便在历史版本中选择。

## 首次发布到 GitHub

使用自己的 GitHub 账号建立一个 **公开仓库**，名称为 `feather-repository`，默认分支为 `main`，将当前目录的文件全部推送上去。无需开启 GitHub Pages。

如果仓库还没有 Git 历史，可以在当前目录执行：

```powershell
git init -b main
git add .
git commit -m "feat: 创建 Feather 软件源"
gh repo create InternetBugs/feather-repository --public --source=. --remote=origin --push
```

如果你已经建立了远程仓库，改用已有仓库的地址：

```powershell
git remote add origin https://github.com/InternetBugs/feather-repository.git
git push -u origin main
```

推送完成后，在 GitHub 的 **Actions → 更新 Feather 软件源 → Run workflow** 手动运行一次，确认更新成功，并确认浏览器能打开上面的 JSON 地址。账号、仓库名或分支不同的话，需要同步修改订阅地址、`source.config.json` 的 `website`，以及工作流中的分支设置。

## 自动更新

- 每小时第 17、47 分钟检查上游；GitHub 的定时任务可能延迟，不保证准点。
- 支持 Actions 页面手动运行，以及 `repository_dispatch` 的 `upstream-release` 事件。
- 默认保留各应用最近三个正式版本，跳过草稿、预发布、没有目标 IPA 的 Release。
- IPA 下载链接始终指向原项目的 GitHub Releases。
- 更新失败时保留该应用原有条目，并在运行日志输出警告；首次生成缺少任何应用则整轮失败。
- 提交前运行离线测试并校验源结构，内容不变时不生成空提交。

工作流使用仓库自带的 `GITHUB_TOKEN`。若自动提交提示没有权限，在 **Settings → Actions → General → Workflow permissions** 中检查写入权限和组织策略。启用分支保护后，也需要允许此更新方式，或改为通过 PR 更新。GitHub 对长期没有活动的公开仓库可能停用定时工作流；停用时可以在 Actions 中重新启用。

## 元数据来源

本仓库只获取 GitHub 的 Release JSON 和对应 tag 下的文本源码，生成过程中不下载、解析或执行 IPA。

- 下载链接、文件大小、发布时间和更新说明来自 Release API。
- Bundle ID 和最低 iOS 版本来自对应 tag 的 Xcode 工程配置。
- PiliPlus 的应用版本与构建号来自 IPA **文件名**，例如 `PiliPlus_ios_2.2.0+5598.ipa` 对应 `2.2.0 (5598)`。Release tag `2.2.0.2` 单独记录为 `releaseTag`。
- Baha Plus 的应用版本来自 `v主.次.修订` tag；构建号按上游发版规则 `主 × 1,000,000 + 次 × 1,000 + 修订` 计算。生成时读取该 tag 的版本脚本和构建流程，规则改变便停止更新该条目。
- 如果 GitHub 提供 SHA-256，记录其 `digest`；这不是本仓库下载完整 IPA 后计算的校验结果。
- 图标链接指向相应 tag 下的 iOS AppIcon 资源。

以上信息已按上游公开发布规则对照，但没有读取成品 IPA 的 `Info.plist`，不能视为对安装包内部元数据或真机安装结果的验证。上游改变打包方式时可能需要调整生成器。

## 本地维护

需要 Python 3.11 及以上，仅使用标准库。

```powershell
# 获取 Release，使用已缓存的文本元数据
python tools/build_source.py

# 忽略缓存，重新读取对应 tag 的文本源码；任一上游失败则不写入
python tools/build_source.py --refresh --strict

# 只校验本地 JSON，不联网
python tools/verify_source.py

# 离线回归测试
python -m unittest discover -s tests -v
```

公开 GitHub API 有匿名调用频率限制；如需提高额度，可通过环境变量 `GH_TOKEN` 或 `GITHUB_TOKEN` 提供令牌。生成器只对 `api.github.com` 请求使用该令牌，拒绝携带认证的重定向。

修改源名称、简介、图标或收录数量，编辑 `source.config.json`，然后重新生成。`identifier` 是源的稳定标识，添加到客户端后应保持不变。`versionsToKeep` 支持 1–10；当前内置版本策略为 `pili-asset` 和 `baha-tag`，新增使用其他发布规则的项目需要扩展生成器。

```text
apps.json                         Feather 订阅文件
source.config.json                源信息、应用和版本保留数量
cache/release-metadata.json        绑定 Release 资产身份的文本元数据缓存
tools/build_source.py             生成器
tools/verify_source.py            结构与一致性校验
tests/test_source.py              离线回归测试
.github/workflows/update-source.yml   定时更新与提交
.github/workflows/validate.yml        提交与 PR 校验
```

本仓库的脚本采用 MIT 许可证；收录应用的代码、图标和安装包遵循各自项目的许可。
