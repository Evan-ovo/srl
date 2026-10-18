# Public 版本边界与自部署

Public 以维护者主库作为功能源码上游。除依赖维护者账号或其专属服务的能力外，普通本地功能、网页与 APK 代码应随主库更新。Public 使用独立的本地入口、Worker 设置和 Android 应用身份。

## 不提供的账号与官方托管能力

- 维护者账号登录、账号会话与账号恢复。
- 依赖维护者账号的资源广场、作者管理后台和反馈服务。
- 维护者发布的公告与账号依赖的公共图床；使用者自己的 ImgBed 仍可配置。
- 依赖账号会话和作者托管 API 的在线组件发布、分享链接及撤销分享；本地组件编辑、导入和导出仍可用。
- 维护者预签名 APK、官方 APK 更新提示与安装通道。

不依赖这些账号/官方托管能力的本地及自部署功能属于公共版源码的同步范围。使用者自行提供的 AI/API Key、云盘凭据、ImgBed、Discord 服务和自部署 Worker 不属于维护者账号服务。

内置 APP 管理、安装、内容更新和卸载也属于共享功能，使用部署者自己站点上的静态 APP 包，不需要维护者登录。这与不提供官方 APK 更新通道是两回事。网页和 APP 包通过同一加载门打开当前 UI；同步核验约定见 [Public 同步合同](PUBLIC_SYNC_CONTRACT.md)。

## Worker 地址与服务

- 部署本仓库只提供网页静态资源。设备码中继和 Koofr 代理代码位于独立的 `SRL-Worker-Public` 仓库。
- 使用者 fork 并部署 `SRL-Worker-Public` 后，在网页/PWA 和 Capacitor APK 的“设置 → 中继服务”中的“自部署 Worker”填写 HTTPS 根地址，保存后点“检查连接”；设备码中继需检测通过，酒馆端须填写相同地址。独立 Kotlin APK 在“设置 → SRL Worker 地址”填写。无需在 APK 构建参数中写入中继地址。
- 该中继提供设备码、加密暂存、可选 GitHub 云备份中继和网页 Koofr 代理。Discord Bridge 保持单独的 Worker、地址和凭据设置。
- 未配置中继时，网页 GitHub 备份直连；配置后仅走自己的 Worker，失败不自动回退。网页 Koofr 中继、设备码和加密暂存在配置前不可用；APK 原生云盘直连不依赖此中继。
- APK 的 `SRL_PUBLIC_ORIGIN` / `SRL_PUBLIC_ASSET_ORIGIN` 配置的是网页/静态 APP 包站点，不是本节的独立中继地址。
- 本地开发配置、Cloudflare 账号标识和使用者凭据不得加入公开提交。

## 使用者自行配置的服务

- **Cloudflare**：部署本仓库的静态网页；部署期 Worker 功能另行从 `SRL-Worker-Public` 部署。
- **Koofr 与 WebDAV**：在应用中填写自己的服务地址与凭据；数据保存到使用者选择的云端目标。
- **Discord Bridge**：使用者部署并配置自己的 Discord Worker/Bot。它不使用通用 SRL Worker 地址。
- **ImgBed**：在应用中填写自己的 ImgBed 地址与 Token；需要时可单独部署仓库提供的 ImgBed 跨域代理。
- **AI/API**：使用者自行填写服务地址与 API Key。

## Android 公共版身份

Public 显示名称为 `SRL_Pubilc`，应用 ID 为 `app.srl.publicedition`，并保留独立图标。使用者自行构建和签名 APK，签名密钥、私有部署地址和构建出的 APK 不提交到源码仓库。与其他应用迁移本地数据时，使用项目提供的备份与恢复功能。
