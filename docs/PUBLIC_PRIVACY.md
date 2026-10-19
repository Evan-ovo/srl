# Public 隐私、联网与发布披露

适用于本仓库网页/PWA及Capacitor Public APK。第三方APP、导入作品和自行修改的部署还应核对其自身说明。

## 源码与版本

- [Public完整源码](https://github.com/jixiangruyi117/SillyTavernResourceLibrary-Public)，网页与APK发行版本见本仓库Releases及对应产品提交。
- 可选服务：[自部署中继源码](https://github.com/jixiangruyi117/SRL-Worker-Public)、[Discord Bridge源码](https://github.com/jixiangruyi117/SRL-Discord-Bridge)。使用者自行部署并控制其账号与数据。
- 源码公开供核查；使用、修改和再分发仍以LICENSE/NOTICE为准，不等于无条件授权。签名密钥、个人凭据和私人部署配置不属于公开源码。

## 本地数据与可选发送

资源正文、原件及多数设置默认在当前设备，不因打开Public而自动上传给作者。项目没有内置访问统计或资源内容遥测上报。

- AI：主动发送的对话、所选资料、提示词、参考图及授权工具结果交给用户选择的API。助手截图每次另行确认；网页代理单独授权，页面文字、控件标签、地址及公开标识可能发给所选AI。拒绝截图或代理、停止任务、移除API配置可阻止后续对应操作；已发送内容不能从本机撤回。
- 备份：按所选范围发送到用户配置的GitHub/WebDAV/Koofr和自部署中继；包含凭据时可能携带可用密钥。可关闭定时备份、停止任务、断开连接或移除配置。远端副本须在目标服务另行删除。
- ImgBed：主动上传时发送所选文件；浏览远端文件发送目录/搜索条件，删除须确认。关闭图床页面或移除连接可停止后续操作，远端文件仍受目标图床管理。
- Discord：启用收件/领取后，经用户的Bridge、Discord及附件CDN处理消息、附件和配对信息；可停止收件并断开连接。
- 远程内容：预览联网素材和脚本默认关闭；第三方APP、外部链接、封面与图标可能引用自己的域名。使用前核对来源与授权，关闭对应预览权限可拒绝预览请求；封面和图标的外链可能在显示时加载，可移除链接或换成本地图片，不加载相应内容可拒绝这些请求。

阅读确认用本机存储及固定版本值的功能性Cookie保存；Cookie会随同站点请求发送，不作为个人跟踪标识。APK自动检查偏好仅留本机，不从通用备份恢复。清理本机数据、远端副本和第三方服务记录是不同操作。

## 更新与基础网络请求

APK自动检查默认关闭。首次说明中可单独勾选，也可在“设置 → 自动检查 APK 更新”更改；开启后在启动、回前台或联网时检查，12小时内最多一次。未确认当前版本说明前不自动检查。关闭会中止正在查询的版本清单并忽略迟到结果；“设置 → 检查 APK 版本更新”仍可手动使用。更新只下载公开版本信息/安装包，不发送资源库正文，下载与安装继续由用户确认，可从任务中心停止下载。

首次说明或“设置 → 隐私与网络说明”提供同一份说明，重看无需倒计时，也不会重新授权。网页首次加载、静态APP包下载和Service Worker更新会访问当前分发站点；APK开关不控制这些网页基础请求，不承诺关闭开关后完全断网。

接收服务器可接触IP、访问时间、请求路径和部分请求头。静态站点模板`wrangler.example.jsonc`默认关闭Workers应用日志，这不会停止托管商为服务、安全、计费处理基础网络信息，也不代表已修改任何现有线上部署。部署者若启用日志/统计，应在自己的发布说明写明字段、用途、访问者和实际保存期限；可选统计应允许拒绝，不承诺零日志。Cloudflare说明：[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)。

## 请求域名与触发条件

以下为本项目固定或常见可选目标，不表示启动时全部访问。社区白名单按发布时规则核对；raw.githubusercontent.com在用户提供的白名单内，其他GitHub域名不因此豁免。

- APK版本检查/下载：`github.com`、`release-assets.githubusercontent.com`、`objects.githubusercontent.com`；仅手动检查或明确开启自动检查后访问。
- GitHub备份、链接导入与助手仓库读取：`api.github.com`、`uploads.github.com`、`raw.githubusercontent.com`、`github.com`及其前述Release下载域名；启用对应操作后访问。
- AI/生图：`api.openai.com`、`api.anthropic.com`、`image.novelai.net`，或使用者实际填写的API域名；主动发送或执行已授权AI任务时访问。
- Koofr：`app.koofr.net`；以及使用者填写的WebDAV/中继域名。APK可原生直连，网页Koofr需要自部署中继。
- Discord：`discord.com`、`cdn.discordapp.com`、`media.discordapp.net`及使用者的Discord Worker域名；配置、收件和下载时访问。
- 网页部署：`dash.cloudflare.com`、`deploy.workers.cloudflare.com`、`github.com`、`discord.com`；用户打开教程链接或授权网页代理时访问。登录网站还可能跳转到用户选择的登录提供方，按实际网站提示授权。
- 图床/远程内容：使用者配置的ImgBed、导入内容/第三方APP/链接实际引用的域名；无法预先固定枚举，不应以“用户配置”掩盖发行者预置的请求。发行者自加的预置目标须具体披露。
- 帮助与效果参考外链（只在点击后由浏览器打开）：`docs.github.com`、`developers.cloudflare.com`、`koofr.eu`、`developer.mozilla.org`、`web.dev`、`webkit.org`、`demos.gsap.com`、`tympanus.net`、`threejs.org`、`motion.dev`、`animejs.com`、`animista.net`。

分发网页/静态APP包的实际站点地址也应在发行帖子明确列出。私人账号地址不硬编码到通用源码；部署者在自己的发布帖填写实际公开分发地址。关闭可选联网功能不等于免除托管站点的基础请求处理。

## 发布帖须保留的信息

在首楼等醒目位置直接列出本次实际非白名单域名及用途，不能只链接本文或只写“可能访问第三方”；同时放源码/发行版本、数据发送范围与拒绝方式。按实际部署核验日志/统计，写明真实情况，不复制未经验证的“无日志”“完全离线”承诺。新版本说明新增实质内容时，更新首次说明版本号使旧用户重新看到。

安全问题优先私信社区管理组，避免在公开频道先公开具体利用方式。本文说明产品行为，不替社区管理组作合规判定。
