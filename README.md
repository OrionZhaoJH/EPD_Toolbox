# EPD Toolbox

面向 **E6 六色电子纸**（黑 / 白 / 黄 / 红 / 蓝 / 绿）的静态网页上位机：图片抖动量化、4bpp 面板数据打包导出、Web Bluetooth 设备控制。

纯静态站点，无后端、无构建步骤，推送到 `main` 自动部署到 GitHub Pages。

## 功能

| 页面 | 说明 |
| --- | --- |
| `index.html` | 工具箱首页：工具入口、像素编码与 BLE 帧格式速查 |
| `e6-image.html` | 图像输入 → 抖动量化 → 预览 → 导出 / 设备控制 |

已实现：

- 12 种抖动算法（Floyd-Steinberg、Atkinson、Jarvis、Stucki、Burkes、Sierra、Sierra Lite、Ordered 2/4/8、阈值、随机）
- 亮度 / 对比度 / 抖动强度 / 蛇形扫描参数
- 尺寸适配：等比留白、等比裁剪、拉伸；分辨率可自定义（默认 480×720）
- 实时 6 色预览（适应 / 1× / 2× / 4× 缩放）与颜色占比统计
- 导出 `.bin`、C 数组 `.h`、复制全部 hex
- BLE：读 IC 版本、刷纯色、擦除图片槽，命令帧 `55 AA … 0D` 实时收发日志
- 连接状态三态显示（未连接 / 连接中… / 已连接），滚动后顶栏常驻状态徽章
- 移动端适配：单列布局、表单项独占一行、顶栏按钮收成图标、表格横向滚动

## 目录结构

```
EPD_Toolbox/
├── index.html                     # 首页（工具入口 + 格式速查）
├── e6-image.html                  # E6 图像转换 / 设备控制页
├── assets/
│   ├── css/app.css                # 设计系统（跟随系统暗色）
│   └── js/
│       ├── e6-codec.js            # 调色板 / 抖动 / 4bpp 打包（纯函数）
│       ├── ble.js                 # Web Bluetooth 封装 + 命令帧
│       └── e6-page.js             # 页面交互
├── tests/codec.test.mjs           # 编解码自测（node 直接跑）
└── .github/workflows/deploy-pages.yml
```

## 数据格式

E6 面板像素为 **4 bit/像素**，两个像素拼一个字节：

- 颜色编号：黑 `0`、白 `1`、黄 `2`、红 `3`、蓝 `5`、绿 `6`（`4`、`7` 保留）
- 字节排布：`byte = (像素(x, 2y) << 4) | 像素(x, 2y+1)`，即**高半字节是上面那个像素**
- 扫描方向：**列优先**，外层 `x = 0 → w-1`
- 一帧字节数：`w × ceil(h / 2)`，480×720 即 **172800** 字节

自测覆盖了位序、列优先、六色编号与整帧往返：

```bash
node tests/codec.test.mjs
```

## BLE 协议

服务 `FFE0`，下行命令 `FFE3`（写），上行响应 `FFE4`（notify）。

```
55 AA LEN_H LEN_L CMD DATA... CRC 0x0D
LEN = 整帧长度 = DATA 长度 + 7（固件校验 LEN 与实际长度一致）
CRC 固件暂不校验，填 0x00
```

| CMD | 含义 | 示例 |
| --- | --- | --- |
| `0x00` | 读 IC 版本 | `55 AA 00 08 00 00 00 0D` |
| `0x10` | 刷纯色（data=颜色编号） | `55 AA 00 08 10 01 00 0D`（刷白） |
| `0x20` | 擦除图片槽（data=槽号 0~10） | `55 AA 00 08 20 01 00 0D` |

响应码：`0x00` 成功、`0x01` 已受理、`0x02` 完成、`0x03` 忙，`0xE0` 起为错误码。

> 图像数据上传需要固件补一条写 Flash 的命令（当前固件只有 `0x00 / 0x10 / 0x20`），
> 因此页面上的「上传图像」按钮暂时禁用；请先导出 `.bin`。

## 本地预览

Web Bluetooth 要求安全上下文（`https://` 或 `localhost`），直接双击 `file://` 打开时只有图像处理可用。推荐起一个本地静态服务：

```bash
python -m http.server 8080
# 浏览器打开 http://localhost:8080/
```

图像处理全程在浏览器内完成，图片不会上传。

## 部署到 GitHub Pages

1. 仓库 **Settings → Pages → Source** 选择 **GitHub Actions**
2. 推送到 `main`（或 `master`）后 `.github/workflows/deploy-pages.yml` 自动部署
3. 站点地址：`https://<用户名>.github.io/<仓库名>/`

也可以在 **Actions** 页面手动 `Run workflow`。`index.html` 里的 GitHub 仓库链接是占位地址，记得替换。

## 提交规范

每次改动单独提交，提交信息写清「改了什么、为什么」：

```
<type>(<scope>): <中文摘要>

- 具体改动点
- 影响范围
```

`type` 取 `feat` / `fix` / `docs` / `style` / `refactor` / `test` / `ci` / `chore`。
