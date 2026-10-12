# Public 同步核验约定

Public 的共享功能来自主库已提交快照。同步范围由维护者指定为本地主线或远端主线，不纳入未提交文件或未经授权的开发分支。主库的私有提交 SHA 只记录在主库既有工作记录中；Public 记录对应版本与自身审计基线。

代码使用 `SRL-PUBLIC-SYNC` 标记：`MAIN-ONLY` 排除账号及官方托管服务，`REPLACE` 保留两端同 ID 的必要替代实现，`WORKER-URL` 保留用户配置的服务地址，`PUBLIC-ONLY` 标注 Public 独有适配。标记范围须按真实依赖核查，不能仅因名称包含 `OfficialApp` 或“助手”而排除共享功能。

APP 管理、安装、更新、卸载、内容修订号和加载门使用当前站点的静态包，不依赖维护者登录，属于共享功能。主库旧标记中误归为 `MAIN-ONLY` 的这些片段，Public 显式保留为 `PUBLIC-ONLY`；账号服务、资源广场、反馈、官方共享托管与官方 APK 更新通道继续排除。APP 更新与官方 APK 更新是不同能力。

同步后应覆盖所有共享源码、样式、读了么 HTML/脚本、运行时、APP 打包配置和相关测试。逐项核查保留替换区内的上游变化；特别是 Worker 地址适配不能保留整段旧业务实现。复核主库中尚未完整标记的账号绑定、广场 ID 等代码，避免残留导入和入口。

Public 不提供官版内置的公共中继，也不设默认中继地址。`RelayWorkerSettingsService` 统一管理用户自部署 Worker 的目标、检查结果与活动操作；通过既有 `PublicWorkerSettingsService` 地址存储保持设置兼容。用户未填写自部署地址时，Koofr 中转、设备码和加密暂存均不可用；设备码仍要求检查通过。Discord Bridge 继续使用独立设置。

所有内置 APP 均通过 `FeatureAppLoaders` → `OfficialAppGate` → `OfficialAppRuntime` 加载，网页与包内 UI 入口由 `OfficialAppPackages` 维护。`FeatureAppLoaders.test.ts` 检查全部 APP 使用同一加载链，并核查前端了么、缝了么和助手的实际打包入口。同步后运行相关回归、类型检查、构建与包完整性检查；真机和线上验收单独记录。

品牌、图标、应用 ID、签名与部署地址保持 Public 身份。公开前按 README 执行增量隐私和提交邮箱检查；同步本身不推送、部署或构建 APK。
