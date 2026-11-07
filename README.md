# 方舟桌宠公共框架

由角色包驱动的 Electron 桌面伴侣框架，提供 standard、standard-music、growth、ai 四套外壳。本仓库提供公共源码和原创几何示例“小圆”。现有角色安装包位于独立的 fangzhou-desktop-pets 下载仓库。

## 运行原创示例

安装 Node.js 22 或 24 LTS 与 npm，在仓库根目录执行：

```sh
npm install
npm test
npm run prepare:example
npm start -- standard
```

真实 Electron 启动检查可在本机桌面会话运行：`npx electron scripts/smoke-electron.cjs standard`，最后参数也可替换为其他三套外壳。测试使用临时用户数据目录。

其他外壳分别使用 `npm start -- standard-music`、`npm start -- growth`、`npm start -- ai`。示例图片由代码生成，不需要下载角色素材。两张 PNG 用于验证待机与打招呼动作，示例本身没有逐帧动画；接入自己的动画文件后可使用同一动作接口。

AI 功能默认不携带密钥，在应用设置中自行配置服务。模拟测试不会调用付费服务。系统安全存储不可用时不应保存密钥。不要把本机应用数据、聊天记录或密钥上传到仓库。

## 构建

```sh
npm run build -- standard
npm run build -- standard-music
npm run build -- growth
npm run build -- ai
```

构建默认针对运行命令的系统：macOS 生成 DMG，Windows 生成安装程序。输出位于 dist/。建议分别在 macOS 和 Windows 构建与测试，首次构建需要下载 Electron 及构建工具。示例采用构建器默认应用图标；实际产品请配置自己的授权图标。示例包未配置开发者签名或公证。

## 结构与角色接入

- app/：基础互动、动作管理、桌宠窗口。
- variants/standard-music/app/：音乐播放器状态与歌词扩展。
- variants/growth/app/：积分、成长、本地存档与备份。
- variants/ai/app/：AI 对话、设置、安全存储与请求管理。
- scripts/prepare-example.cjs：原创示例生成、四套外壳准备和构建配置。
- .stage/：生成的独立应用，不纳入 Git。

角色数据由 character.json、actions.json、图片和可选 persona.json 组成。prepare-example.cjs 展示完整最小配置；可以替换为自己的授权内容。每套示例使用不同应用标识和名称，以隔离设置。图片目录沿用 assets/gifs 名称，但支持浏览器可解码的 PNG/GIF。

## 验证与平台限制

npm test 包含四套示例准备检查、全屏守护、窗口几何恢复、拖动以及 AI 后端模拟回归。模拟网络与窗口测试不等同于原生系统实测。Windows 全屏、DPI、音乐读取和 macOS 权限、睡眠恢复均需实机验收；音乐功能取决于播放器版本和本机权限。

当前公开候选仅包含桌面框架。Android 现有工程与角色资源、产品配置关联，尚未提取并验证可独立构建的公共示例，因此本次不纳入。

## 许可

本仓库自有框架代码、示例生成器和生成的原创几何图像采用 MIT，允许修改和商用，须保留版权及许可声明。第三方组件沿用各自原许可证，见 THIRD_PARTY_NOTICES.md。此许可不授予任何游戏角色、商标、角色素材、人设或第三方服务的权利。

当前 Electron 版本延续现有框架基线。发布下游产品前应评估依赖更新并完成相应平台测试。
