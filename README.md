# SillyTavern Resource Library

SRL 是一个本地优先的 SillyTavern 资源整理、预览、互传与创作工具。本仓库保留本地与自部署功能，不包含维护者账号系统、账号依赖的资源广场、公告、公共图床、管理后台、反馈服务、官版 APK 更新服务或账号依赖的在线组件分享。Public APK 使用本仓库 GitHub Releases 的独立发行通道；需要云端基础设施的能力仍由部署者自行配置。功能边界与服务配置见 [Public 版本边界与自部署](docs/PUBLIC_RELEASE_DIFFERENCES.md)。

## 隐私与网络说明

首次打开会展示数据与联网说明；之后可在“设置 → 隐私与网络说明”随时查看。APK自动检查更新默认关闭，需单独选择；关闭后保留手动更新。完整数据范围、接收方、关闭方式、请求域名和源码链接见[Public隐私与发布披露](docs/PUBLIC_PRIVACY.md)。发布者须在帖子首楼等醒目位置直接列出实际非白名单域名，并补充实际分发地址及日志情况。

网页加载、静态包下载和网页更新仍会访问分发服务器；接收方可处理IP、请求时间、路径及部分请求头。静态站点模板默认关闭Workers应用日志，不代表既有线上配置已改变，也不等于托管商零记录。自部署启用日志/统计时须告知用途、范围、访问者和实际保存期限，并为可选收集提供拒绝方式。

> [!WARNING]
> **关于本文档**
>
> 本 README 由 AI 辅助整理，并经项目维护者核对。项目持续迭代，文档可能遗漏、表述不准确或未及时反映最新实现。功能行为以当前版本源码和实际运行结果为准；许可证、第三方代码来源及再分发要求以 [LICENSE](LICENSE)、[NOTICE](NOTICE) 和相关上游项目条款为准。这里的安全说明用于解释项目设计和使用注意事项，不构成正式安全审计、法律意见或绝对安全保证。

## 二次修改与衍生版本的数据保护要求

> [!IMPORTANT]
> 本项目的二次修改、衍生开发及再分发版本，必须遵循 **本地优先、用户控制、私有数据不集中托管**。再分发时必须保留并显著展示本说明；不得以更名、免费提供、非商业用途或其他方式规避。

1. **本地优先。** 用户资源及其管理数据应以用户设备上的本地存储为主要数据源。不得把上传至资源库、开启云同步或交出云端访问权限，作为使用本地资源管理功能的前提。
2. **云端由用户自行部署和控制。** 涉及用户私有数据的云端存储、同步、备份、处理或中转，只能使用该用户自行部署并实际控制的 Worker 或后端，以及由该用户自行配置和控制的存储账户。用户须掌握相关账号、凭据及数据的访问、导出和删除权限。
3. **禁止共用数据后端。** 二改者、发行者或运营者不得为不同用户提供统一运营的后端，接收、存储、处理或中转用户私有资源。独立账号、分库、租户隔离或加密均不构成豁免。仅为用户分配账号或专属实例、但管理权限仍由运营者掌握，也不属于用户自行部署和控制。
4. **禁止收集和利用用户资源。** 不得通过自动上传、后台同步、日志、遥测、诊断或其他机制收集用户的角色卡、世界书、聊天记录、图片、附件、创作内容、凭据及相关私有信息；不得将这些数据用于运营者的资源积累、再分发、模型训练或其他用途。
5. **云端功能须由用户主动选择。** 启用前应清楚说明传输的数据范围、用途、目标和保存方式，并允许用户关闭功能、撤销授权及删除云端副本。用户同意使用某项功能，不构成运营者建设共用数据后端的豁免。

**适用范围说明：**“共用后端”指处理用户私有数据的应用服务，不包括单纯分发静态网页、源码、安装包或更新文件的服务；本要求也不禁止不同用户在各自账户下使用同一家云基础设施供应商。

## 主要功能

- **资源库管理**：整理角色卡、聊天记录、开场白、用户人设、世界书、主题美化、正则、预设、快速回复、脚本、插件清单、番外、小手机、密钥及其他资源；支持分类、文件夹、标签、收藏、搜索、预览、批量整理、历史版本和回收站。
- **读了么**：按角色整理聊天，支持纯净、精简和完整阅读，竖向滚动与左右翻页、章节跳转、备用回复、收藏、角色专属外观和已保存变量变化回顾。聊天包默认只保存聊天及随附阅读资料，关联已有角色卡前确认；阅读数据可随备份导出和恢复。
- **导入与导出**：导入常见 SillyTavern 资源文件和备份，解析角色卡、世界书、预设等格式；支持链接导入、整库或选定内容的 ZIP 备份与恢复，以及资源包导入导出。
- **酒馆互传**：与 SillyTavern/TavernHelper 相关环境交换受支持的角色卡、世界书和预设。连接方式取决于网页或 Android 版本及使用者部署的桥接服务。
- **云备份**：连接使用者自己的 GitHub 仓库或 WebDAV/Koofr，支持手动、定时备份和恢复。云端目标及访问权限由使用者配置和管理。
- **前端创作工作台**：管理 HTML/CSS/JavaScript 项目，编辑和预览内容，使用模板、检查器、AI 辅助创作和本地组件库；组件支持本地创作、导入与导出。Public 不提供在线发布、分享链接、撤销分享或自部署分享后端。
- **图像与 AI**：使用自行配置的主 API 进行兼容任务和 AI 辅助操作；通过 NovelAI、OpenAI 或兼容服务生成图像；管理本地生图相册，并按需上传至使用者自己的 ImgBed。
- **资源扩展**：管理内置 APP 的多选下载、下载全部、内容更新和卸载；下载与更新分别选择，可从页面或任务中心停止，已完成项保留、未完成项手动重试，支持复用未变化文件、按需补齐内容；第三方 APP/扩展仍通过完整 `.srlapp` 包导入或更新，不使用内置 APP 的增量清单通道。权限受应用内的沙箱和逐项授权机制约束。
- **个性化工具**：自定义外观与 CSS、可视化文件夹、预设缝合、随机抽取、人设管理、角色卡资源装配和 AI 标签等。
- **网页与 Android**：网页支持 PWA 和离线应用壳；Capacitor Android 版提供网页功能及原生文件、备份和系统集成；独立 Kotlin 原生版提供本地资源管理和导入导出。不同版本的功能范围可能不同。

## 数据存储、读取与权限

### 数据存在哪里

- **网页/PWA**：资源正文、原始文件、分类、标签、历史版本、前端工作台项目、组件、相册、扩展数据和应用设置主要保存在浏览器的 IndexedDB；少量界面偏好、草稿恢复数据和兼容配置保存在当前站点的 `localStorage`。PWA 使用 Service Worker/Cache Storage 缓存网页应用壳和已访问的静态资源，以支持离线打开；这不等同于资源库备份。清除浏览器站点数据可能删除本机资料，请定期导出备份。
- **Capacitor Android**：资源库默认使用应用私有原生 SQLite 数据库与文件目录，原有 WebView 数据沿迁移流程接入；界面偏好及部分兼容状态仍使用 WebView 存储。处于旧库兼容或回退状态时按应用提示处理，不能只复制 WebView 数据当作完整迁移。卸载应用或清除应用数据可能删除本机资料。应用关闭了 Android 自动备份；需要迁移时请使用应用内导出或备份功能。
- **独立 Kotlin 原生 Android**：资源索引保存在应用私有 SQLite 数据库，资源包保存在应用私有文件目录。导出的文件写入使用者选择的目录或系统提供的分享/保存位置。
- **保险库**：网页和 Capacitor 资源库可选择开启本地数据加密；使用 PBKDF2 从密码派生密钥，并用 AES-256-GCM 加密资源名称、标签、解析内容、原文件、缩略图和历史快照。密码只用于当前会话，不会保存；忘记密码无法解密。内容指纹仍用于本机去重。此保险库不代表所有应用设置、缓存或外部服务数据都已加密。
- **凭据**：Web 环境将 API Key、Token 等敏感凭据与普通配置分开保存，以不可导出的本机密钥和 AES-GCM 加密后存入当前浏览器 IndexedDB；Android 应用使用 Android Keystore 保护凭据。它们仍受当前设备、浏览器用户配置、恶意软件及同源脚本安全影响，不应把本机凭据存储视为远端备份或绝对安全边界。
- **外部服务**：只有在使用者配置并调用相应功能时，数据才会发送到其选择的 AI/API 服务、GitHub、WebDAV/Koofr、ImgBed、Discord 或自部署 Worker。Discord 消息桥的数据由使用者部署的 Worker/D1 和 Discord 侧处理。具体保存期限和访问者由对应服务及其账户权限决定。

完整备份可包含资源、配置及使用者选择的凭据。选择将凭据加入备份时，ZIP/远端备份中的密钥可能以明文形式保存；任何能读取备份的人都可能使用这些凭据。请只备份到可信位置，并按需轮换已泄露的密钥。

### 可能使用的系统权限

网页通常通过浏览器自身的选择器和安全上下文管理授权；实际提示由浏览器和操作系统决定。Android 项目 Manifest 当前声明的主要权限和入口如下：

| 环境/能力             | 用途与触发方式                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 网页文件选择与导入    | 用户点击导入或恢复后，由浏览器打开文件选择器；只读取用户选中的文件。支持的浏览器中，备份目录需用户选择并授予读写权限。                                                         |
| 网页剪贴板            | 用户点击复制等操作时调用浏览器剪贴板 API；通常需要 HTTPS 等安全上下文，并受浏览器权限策略限制。                                                                                |
| Android 网络访问      | `INTERNET` 用于用户启用的 API、云备份、图床、Discord 和互传请求；独立原生版另声明 `ACCESS_NETWORK_STATE` 读取网络状态。                                                        |
| Android 通知          | Capacitor 版声明 `POST_NOTIFICATIONS`；用户启用原生通知时请求授权，用于长时间备份/任务状态通知。拒绝后相关通知不可用。                                                         |
| Android 前台数据同步  | Capacitor 版声明 `FOREGROUND_SERVICE` 和 `FOREGROUND_SERVICE_DATA_SYNC`，用于用户启动的长时间导入/备份等任务在后台持续运行。                                                   |
| Android 文件导入/导出 | 通过系统文件选择器、SAF、MediaStore、系统分享入口或用户选择的目录访问文件；项目没有声明通用的外部存储读写权限。应用提供的文档入口受 Android 系统 `MANAGE_DOCUMENTS` 权限保护。 |

当前两个 Android Manifest 均未声明通用外部存储读写、摄像头、麦克风或定位权限；源码也未发现相机、麦克风或定位 API 的调用。图片选择使用用户触发的系统选择器；通知和文件/目录访问会受设备版本及用户授权影响。

## 安全提示

- 角色卡、HTML/CSS/JavaScript、扩展包和远程资源可能来自第三方。导入或预览前确认来源；只对可信内容启用 JavaScript 或远程资源。沙箱和内容策略用于缩小权限范围，不会让不可信代码或内容自动变安全；允许远程请求时，相关站点仍可能收到网络请求。
- 外部 APP/扩展只应安装自可信来源，并仔细检查其申请的资源读取、文件等权限。不要把访问令牌写入扩展包、源码、Wrangler 配置或公开仓库。
- AI 提示词、所选图像及发送给供应商的任务内容会离开本机并发送到使用者配置的服务。使用前检查供应商地址、账户、隐私政策和计费规则。
- GitHub、WebDAV/Koofr、ImgBed 和自部署 Worker 由使用者配置。请使用最小必要的 Token/权限；自部署代理中的 CORS 来源限制不是身份认证。
- 完整 ZIP/云备份在选择包含凭据时可能包含明文 API Key、Bot Token 和云备份凭据。不要上传到公开仓库、公开网盘或不可信服务；导出前检查内容选择和目标位置。
- 开启本地保险库后请另行安全保存密码并定期导出备份；忘记密码无法恢复已加密资源。加密保险库不会自动覆盖所有浏览器设置、缓存和第三方服务器数据。

## 兼容关系与第三方代码

SRL 为 SillyTavern 和 TavernHelper 的部分资源格式、脚本及前端内容提供兼容能力。这不表示 SRL 与 SillyTavern、TavernHelper 或其开发者存在隶属、授权、赞助或官方合作关系；兼容范围也不代表对上游全部版本或功能提供保证。

`src/utils/RichContentPreview.ts` 中保留了修改后的 TavernHelper / JS-Slash-Runner 4.8.19 相关代码。来源、修改范围和适用许可见 [NOTICE](NOTICE)；其他第三方依赖和资源的许可应按各自上游声明核对。

## 项目结构

```text
src/
├─ components/    Vue 页面与界面组件
├─ composables/   页面状态和交互逻辑
├─ core/          应用启动、容器与平台能力
├─ database/      IndexedDB 数据库及迁移
├─ parser/        SillyTavern 与资源格式解析
├─ services/      资源、备份、AI、图床等业务服务
├─ storage/       本地数据与文件存储适配器
├─ sync/          同步相关逻辑
├─ styles/        页面样式
├─ templates/     创作工作台模板
├─ types/         TypeScript 类型定义
├─ utils/         格式转换、安全和辅助函数
└─ workers/       浏览器 Web Worker
android/
├─ app/           Capacitor Android 应用与原生插件
└─ nativeapp/     独立 Kotlin 原生 Android 应用
cloudflare/       Cloudflare Worker 模板（包括可选 ImgBed 代理）
workers/          独立服务；Discord 消息桥及其 D1 迁移
scripts/          构建、资源校验和审计脚本
public/           网页静态资源
docs/             当前公开版功能边界说明
```

修改功能时可从对应目录的页面、composable 和 service 开始追踪；`.test.ts` 等测试通常与业务代码相邻。`dist/` 是构建生成目录，不是源码编辑位置。

内置前端模板中的 `YOUR-IMGBED-DOMAIN` 是示例图片地址占位符，不是可用的公共图床。使用模板时请通过图片素材替换为自己的图片或已配置的图床链接。

## 本机运行

推荐 Node.js 24 和项目锁定的 pnpm 11.5.0。若使用 Node.js 22，至少为 22.13.0；早期 22.x 不满足当前 Vite/jsdom 的依赖要求。先运行 `node --version`、`pnpm --version` 核对；本轮本机验证使用 Node.js 24.15.0。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

构建网页：

```bash
pnpm build
```

在局域网设备上临时访问开发服务器：

```bash
pnpm dev:lan
```

该命令会监听所有网络接口，只在可信的局域网临时使用；不应将开发服务器暴露到公共网络。

本地预览生产构建：

```bash
pnpm preview
```

提交代码前可运行完整检查：

```bash
pnpm check
```

`pnpm check` 检查格式、lint、测试和生产构建。公开更新还必须单独执行增量隐私检查：

```bash
pnpm secret:scan --base <上次已审计的完整提交SHA>
```

它检查基线之后的每个新提交、暂存区、未暂存改动和新增文件，并核对新提交的 GitHub noreply 邮箱。可用 `--private-values-file <仓库外JSON文件>` 加入自己的私人邮箱、域名及地址字符串列表；不要提交此文件。输出的 `addressReview`、`binaryReview` 是人工复核清单，自动检查通过不代表这些项目已经通过隐私审核。`pnpm secret:scan` 的全树模式与 `secret:scan:history` 只用于明确授权的首次审计，不属于日常重复门禁。CI 使用本次推送/PR 的基线；它不替代推送前的审计。

维护共享功能时与主项目同步，但保留 Public 的品牌、独立应用 ID、无登录入口和自部署配置。发行者应保存上次已审计 SHA、独立签名和部署配置；自部署凭据、私人地址与安装包不得加入源码仓库。

## 部署到 Cloudflare Workers

本仓库部署的 Worker 用于托管 SRL 网页静态资源。设备码中继、加密暂存、可选 GitHub 备份中继和网页 Koofr WebDAV 代理来自独立的 `SRL-Worker-Public`，需要这些能力时另行 fork 并部署。网页/PWA 和 Capacitor APK 在“设置 → 中继服务”中的“自部署 Worker”填写其 HTTPS 根地址，保存后点“检查连接”；设备码须检测通过，酒馆端须填写相同地址。独立 Kotlin APK 在“设置 → SRL Worker 地址”填写。Discord Bridge 使用自己的独立 Worker 配置。

网页未配置 Worker 时，GitHub 备份直连 GitHub；配置后只使用自己的 Worker，失败不自动切回直连或官方服务。网页 Koofr 中继、设备码和加密暂存在未配置时不可用；APK 原生云盘直连不依赖该中继。网页站点地址、独立中继地址和可选 Discord/ImgBed 地址分别配置，不能相互替代。

1. Fork 或下载本仓库，在本地安装依赖并构建：

   ```bash
   pnpm install --frozen-lockfile
   pnpm build
   ```

2. 使用项目已锁定的 Wrangler 并登录自己的 Cloudflare 账号：

   ```bash
   pnpm exec wrangler login
   ```

3. 将根目录 `wrangler.example.jsonc` 复制为 `wrangler.jsonc`。按需修改 Worker 名称；模板使用 `workers.dev`，不绑定自定义域名。多账号环境先核对登录身份，并在本次进程的 `CLOUDFLARE_ACCOUNT_ID` 中显式选择目标账号，避免发到另一套服务。真实账号与配置不提交源码。
4. 部署：

   ```bash
   pnpm exec wrangler deploy --config wrangler.jsonc
   ```

部署配置与命令可参考 [Cloudflare Workers 静态资源文档](https://developers.cloudflare.com/workers/static-assets/) 和 [Wrangler 配置文档](https://developers.cloudflare.com/workers/wrangler/configuration/)。

### 使用 Cloudflare Workers Builds 从 GitHub 部署

也可以将 fork 后的仓库连接到 Cloudflare，由 `main` 分支的提交自动构建和部署。创建 Worker 时按下表填写：

| Cloudflare 项目字段            | 填写内容                                                                    |
| ------------------------------ | --------------------------------------------------------------------------- |
| Repository                     | 你 fork 的 `SillyTavernResourceLibrary-Public`                              |
| Production branch              | `main`                                                                      |
| Project name                   | `srl-resource-library`                                                      |
| Build command                  | `pnpm run build`                                                            |
| Deploy command                 | `pnpm exec wrangler deploy --config wrangler.example.jsonc`                 |
| Preview command                | 保留默认 `npx wrangler preview`；首次部署建议关闭 **Enable Preview builds** |
| Protect with Cloudflare Access | 关闭                                                                        |
| Advanced settings              | 设置构建环境变量 `NODE_VERSION=24`，使用与本机验证相同的 Node.js 主版本     |

`Project name` 必须与 `wrangler.example.jsonc` 中的 Worker 名称 `srl-resource-library` 一致。部署命令显式使用仓库内的通用配置模板；不要改成默认的 `npx wrangler deploy`，也不要把个人的 `wrangler.jsonc`、账号信息或凭据提交到 fork。首次部署时，Cloudflare 会引导授权 GitHub 仓库和 Cloudflare 账号；部署完成后，在 Worker 的 Overview 页面查看站点地址。若之后要启用 Preview builds，Preview command 也要指定模板：`pnpm exec wrangler preview --config wrangler.example.jsonc`。

保存命令返回的 HTTPS 站点来源，验证首页、`/api/version`、`/manifest.webmanifest` 和图标。设备码中继与 Koofr 代理不由该静态站点 Worker 提供。独立 Worker 部署说明见 [SRL-Worker-Public](https://github.com/jixiangruyi117/SRL-Worker-Public)。

也可把 `dist/` 部署为 Cloudflare Pages 静态站点，构建命令为 `pnpm build`、输出目录为 `dist`，并设置 `NODE_VERSION=24`。静态站点同样可以连接另行部署的中继；Pages 本身不提供本仓库 Worker 的 `/api/version` 等接口，网页更新主要依赖 Service Worker。Pages Git 构建说明见 [Cloudflare Pages 文档](https://developers.cloudflare.com/pages/configuration/build-configuration/)。

### ImgBed 跨域中转（可选）

只有你的 ImgBed 不接受 SRL 来源的跨域请求时才需要部署。模板固定转发到你配置的 ImgBed HTTPS 地址，只开放上传、读取图片和删除图片路径，不接受任意目标 URL。上传和删除仍需由 ImgBed 凭据授权。

1. 进入 `cloudflare/imgbed-proxy/`，复制 `wrangler.example.jsonc` 为 `wrangler.jsonc`。
2. 将 `IMGBED_ORIGIN` 改为自己的 ImgBed HTTPS 根地址；将 `ALLOWED_ORIGINS` 改为自己 SRL 部署的完整 Origin。此设置只控制浏览器 CORS，不是身份认证。
3. 回到仓库根目录，使用项目已锁定的 Wrangler 部署，避免依赖全局安装：

   ```bash
   pnpm exec wrangler deploy --config cloudflare/imgbed-proxy/wrangler.jsonc
   ```

4. 在 SRL 的前端工作台或生图相册中连接自己的 ImgBed。填写 Worker 地址和 ImgBed 自己签发的 Token；不要把 Token 写入 Worker 源码或配置。模板将单次上传限制为 10 MiB。

### Discord 社区消息桥（可选）

社区消息导入使用独立的用户自建 Worker 和 D1 数据库，只处理 Discord 消息捕获与一次性导入凭据，不连接 SRL 账号系统，也不使用作者的 Discord 社区 ID。SRL 内置的 Discord 设置向导也提供手动部署步骤。

1. 进入 `workers/discord-source-bridge/`，安装依赖并登录自己的 Cloudflare 账号：

   ```bash
   npm ci
   npx wrangler login
   ```

   复制 `wrangler.example.jsonc` 为本地 `wrangler.jsonc`。本地配置会被 Git 忽略；请勿提交其中的 D1 `database_id`。

2. 创建自己的 D1 数据库：

   ```bash
   npx wrangler d1 create srl-discord-source-handoff
   ```

   把命令返回的 `database_id` 填入 `wrangler.jsonc` 中 `d1_databases` 的 `database_id` 字段。建议保留示例数据库名称；若改名，须同步修改创建命令、配置中的 `database_name` 以及该子目录 `package.json` 的 `db:migrate` 脚本，`DB` 绑定名保持不变。

3. 将 Discord Developer Portal 中自己的 Application ID、Public Key 和 Bot Token 分别保存为 Worker Secret：

   ```bash
   npx wrangler secret put DISCORD_APPLICATION_ID
   npx wrangler secret put DISCORD_PUBLIC_KEY
   npx wrangler secret put DISCORD_BOT_TOKEN
   ```

   无需设置 `SRL_WEB_URL`。Android / iOS 网页或 PWA 用户在 Worker 的 `/open/:token` 页面复制临时链接，再回到当前 SRL 网页 / PWA 粘贴领取，避免把内容保存到另一个浏览器存储空间。大 handoff 会拆分成多条临时 D1 记录，不设单条 handoff 大小上限；Cloudflare 账号和数据库总配额仍适用。Bridge 还会提取 Discord `.txt` 附件中的文字（每条消息最多 2 个文件、每个最多 1 MB、单次最多 2 MB）；其他附件仍按链接保存。不要把 Bot Token 写入配置文件或源码。

4. 部署并应用数据库迁移：

   ```bash
   npm run deploy
   ```

5. 在 Discord Developer Portal 将 Interactions Endpoint URL 设为 `https://你的-worker.workers.dev/interactions`，然后按 SRL 内置向导完成命令注册，并把 Worker 根地址填入 Discord 社区设置。

`npm run deploy` 会先将 `migrations/` 中尚未应用的 SQL 迁移到远程 D1，再部署 Worker。[Cloudflare D1 Wrangler 命令](https://developers.cloudflare.com/d1/wrangler-commands/)与 [D1 迁移说明](https://developers.cloudflare.com/d1/reference/migrations/)可查看官方文档。

## Android 源码构建

需要 Android Studio、Android SDK（包含 Android 36 平台和 Build Tools）、JDK 21，以及前述 Node.js/pnpm 环境。当前默认应用名为 `SRL_Pubilc`，应用 ID 为 `app.srl.publicedition`，与官版独立，可同时安装。两个版本的本地资料相互隔离，可通过备份迁移。

### 打包网页功能的离线 APK（推荐）

先确定托管网页与 APP 静态包的站点地址；它与应用设置中填写的独立中继地址不同。以下 PowerShell 示例中的地址和路径均替换为自己的配置，不写入源码：

```powershell
pnpm install --frozen-lockfile
$env:JAVA_HOME = 'X:\Android\jbr'
$env:ANDROID_HOME = 'X:\Android\Sdk'
$env:GRADLE_USER_HOME = Join-Path $env:USERPROFILE '.gradle'
$env:SRL_PUBLIC_ORIGIN = 'https://你的-worker.workers.dev'
$env:SRL_PUBLIC_ASSET_ORIGIN = 'https://你的-worker.workers.dev'
```

`SRL_PUBLIC_ORIGIN` 只设置 APK 本地 WebView 的来源，首页仍来自 APK 内置文件，不是在线网页套壳。`SRL_PUBLIC_ASSET_ORIGIN` 单独设置缺少内置副本时下载 `.srlapp` 的 HTTPS 来源。首次发行后必须保持应用 ID、本地 WebView 来源和签名不变，以保证覆盖升级继续读取原数据库；升级时可以更新功能包下载来源。两项都不配置时使用本机 `localhost`，仅能保证核心本地资源库，缺少内置副本的可选功能包无法下载。不要使用 `CAPACITOR_SERVER_URL` / Remote 模式制作离线发行包。

在 Android Studio 打开 `android/` 后可以自行构建签名；也可首次在仓库外生成专用密钥（不要与其他发行版本共用）：

```powershell
& "$env:JAVA_HOME\bin\keytool.exe" -genkeypair -keystore 'X:\private\public-release.jks' -alias release -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=SRL Public'
```

安全保存该密钥、别名和密码。每次 Release 构建只在当前进程加载自己的签名材料：

```powershell
$env:SRL_ANDROID_RELEASE_STORE_FILE = 'X:\private\public-release.jks'
$env:SRL_ANDROID_RELEASE_KEY_ALIAS = 'release'
$secret = Read-Host '签名库密码' -AsSecureString
$env:SRL_ANDROID_RELEASE_STORE_PASSWORD = [Net.NetworkCredential]::new('', $secret).Password
$env:SRL_ANDROID_RELEASE_KEY_PASSWORD = $env:SRL_ANDROID_RELEASE_STORE_PASSWORD
pnpm android:apk -Mode Packaged -Variant Release
```

如果 key 密码不同，单独输入 `SRL_ANDROID_RELEASE_KEY_PASSWORD`。产物为 `android/app/build/outputs/apk/release/app-release.apk`；构建脚本执行签名验证。在工作目录 `android/` 运行 `./gradlew :app:lintRelease`（Windows PowerShell 使用 `.\gradlew.bat :app:lintRelease`），并用 SDK 的 `apksigner verify --verbose --print-certs` 核对后续版本证书与首次发行一致。APK 包名/图标、首次断网打开和已安装功能的离线访问需要安装验证。

APK 构建脚本已生成网页并同步到 Android。签名包完成后，再按上文的 `pnpm exec wrangler deploy --config wrangler.jsonc` 部署此时的 `dist/`，并回读当前 buildId 的 catalog 与每个 `.srlapp` 大小、SHA-256。不要在两者之间重新运行 `pnpm build` 或 `pnpm android:sync`，否则功能包哈希可能变化，线上清单与 APK 对应的构建不一致。

关闭构建终端或移除这四个签名环境变量。`.jks`、密码、Wrangler 本地配置与私人部署地址不加入公开源码。手工构建可自行分发；需要应用内检查更新时，使用下面的 GitHub Releases 流程，始终使用相同的 Public 签名和应用 ID。

### 统一 Public APK 与网页发布（一次性配置）

发行仓库由 `public-release.config.json` 声明，默认是本仓库。Actions 的 **Public release** 在 `main` 产品代码变化后构建签名 APK，并一次发布 `SRL_Pubilc.apk`、`public-web.zip` 与 `public-release.json`。APK 内置网页和 CF 部署使用同一网页候选，内置 APP 文件哈希保持一致；第三方 APP 仍每次更新完整 `.srlapp` 包。发布先上传草稿全部资产，全部成功才公开，重跑已发布候选不会覆盖字节。

1. 在发行仓库 **Settings → Secrets and variables → Actions** 添加 Secrets：
   - `PUBLIC_ANDROID_KEYSTORE_BASE64`：现有 Public 签名文件的 Base64。
   - `PUBLIC_ANDROID_STORE_PASSWORD`、`PUBLIC_ANDROID_KEY_ALIAS`、`PUBLIC_ANDROID_KEY_PASSWORD`：同一密钥的密码和别名。
   - `PUBLIC_WEB_ORIGIN`：首次 Public 发行确定的本地 WebView 来源，后续保持不变。
   - `PUBLIC_ASSET_ORIGIN`：托管网页及 APP 包的公开 HTTPS 站点来源。
2. 同页 Variables 添加 `PUBLIC_ANDROID_CERT_SHA256`（原 Public 发行证书 SHA-256，64 位十六进制，无冒号）及 `PUBLIC_APK_RELEASE_ENABLED=true`。先完成所有配置再开启；Fork 默认不会发行 APK，也不会获得上游 Secrets。已有安装必须沿用原 Public 密钥，不能拿官版密钥或临时 Debug 密钥替代。
3. 在 **Actions → Public release → Run workflow** 触发首次发行；之后推送产品更新自动发行。Android versionCode 由完整 Git 历史的提交数生成独立递增号；保留 `main` 历史并快进更新，不重建或压缩已发行历史。
4. 小号 CF 已连接的 GitHub Fork 保持原 Worker 与账号，只修改 **Settings → Builds → Build configuration**：Build command 为 `pnpm public:web-build`；Deploy command 为 `pnpm exec wrangler deploy --config wrangler.example.jsonc`；构建环境 `NODE_VERSION=24`。Repository 处显示实际的 `owner/repo`，CF 登录邮箱不是仓库名。不需要另建账号或 Worker，也不需要给 CF 签名密钥或 GitHub Token。
5. 首次 Release 成功后，在该 Fork 点击 **Sync fork → Update branch**，CF 自动取得该产品提交对应的 Release 网页包并部署；核对部署成功与 `/api/version`。以后按“上游推送并发行成功 → 同步 Fork → CF 自动部署”更新即可。

CF 默认从本仓库下载对应 `public-<产品提交 SHA>` 的候选，文档单独更新复用前一个产品候选。构建会补全浅克隆的提交历史，避免仅更新文档时误找不存在的产品发行。Release 尚在构建时最多等待 15 分钟，再给网页包下载 5 分钟；失败会中止此次构建，保留线上旧部署，不改为其他版本。应等上游 Actions 成功后再同步 Fork；若已提前同步导致超时，在 CF 重试同一构建即可。此模式要求 Fork 保留上游产品提交身份；有自己的产品改动时，选择自己发行（设置 CF `SRL_RELEASE_REPOSITORY=自己的owner/repo`，启用自己的发行配置）或使用上面的 `pnpm build` 源码自部署流程。

`PUBLIC_*_ORIGIN` 虽通过 Secrets 注入，但站点来源会编进公开 APK，**并非秘密地址**。只能配置同意公开用于 Public 发行的站点，不能借 Secrets 把私人基础设施地址放进公开附件。密钥与密码不会编进 APK。此发行通道不提供账号、反馈或公共图床服务，也不会替用户配置其云盘、API 或独立中继。

首次需从本仓库 Releases 手动安装支持 GitHub 更新的新 Public APK。之后读取 GitHub Releases 的静态 `public-release.json` 检查版本，不调用 GitHub REST API，也不需要用户 Token；多人共用出口 IP 不再消耗每小时 60 次的匿名 API 额度。在“设置 → 检查 APK 版本更新”检查，或在首次说明/设置中单独开启自动检查后由启动/回前台/联网检查（默认关闭，12 小时限频；未确认新版说明前不自动请求）；可选择更新、稍后提醒或忽略；这些选项控制提示，关闭自动请求请使用“自动检查 APK 更新”开关，手动检查保留。下载会检查仓库、大小、SHA-256、包名、较高版本号和签名，最后仍需 Android 系统确认安装，不能静默安装；任务中心可停止下载。网页更新继续沿 Service Worker，不能替代 APK 原生代码升级。静态清单会随每次成功发行自动生成；APK 下载固定到清单对应的产品提交，更新检查和安装期间发布新版也不会混用文件。没有 GitHub Release 时提示渠道尚未发布；GitHub/CDN 的网络限制仍可能影响访问，失败后由用户手动重试，不自动循环请求。旧版使用 API 的 APK 需先从 Releases 手动覆盖安装一次本修复版，网页更新不会替换 APK 内的检查代码。

### 独立 Kotlin 原生版

原生 Android 酒馆互传功能连接独立部署的 SRL Worker。在 APK 的“设置 → SRL Worker 地址”中填写 HTTPS 根地址：

不需要设备码中继时可留空；保存的地址只存放在该设备本机设置中，不写入构建参数。

该模块与上面的 Capacitor 版使用相同 Public 应用 ID，属于替代安装，数据格式与能力范围不同；不要把它当作网页功能完整的 APK。

## 离线使用边界

- Public 不调用官方登录/会话服务，进入本地库不需要先登录。
- 网页/PWA 首次访问需要联网；页面提示“资源库已可离线使用”后可断网重新打开。首次未缓存的网站无法凭空离线加载。清理站点数据可能同时删除缓存和本地库。
- Packaged APK 的核心入口已随包携带，首次启动也不需要在线登录；可选 APP 需先从自己的站点安装，之后使用已保存的本地文件。
- AI 请求、云备份、Discord、图床、互传及远程图片等网络功能仍需联网。本地保险库若启用，离线时仍需自己的解锁密码；它与官方账号登录无关。

## 许可

Copyright (C) 2026 jixiangruyi117。

本项目按 Aladdin Free Public License Version 9（AFPL v9）授权。**AFPL v9 不是 OSI 定义的开源许可证**，并对分发和商业销售等行为设有限制。使用、修改或再分发前，请完整阅读 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)，并遵守适用条款；不要仅凭“源码可见”推断可以不受限制地商业使用或再分发。
