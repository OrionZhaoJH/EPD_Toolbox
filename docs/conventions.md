# 交互与通信约定（备忘录）

> 改页面、加命令、换设备前先过一遍这份清单。每一条都来自实际踩过的坑，
> 新增模块时按同样口径执行，不要各自发明。

## 1. 命令互斥：发出命令后禁用所有命令交互控件

**规则**：任意一条命令发出后，页面上所有命令交互空间（按钮、下拉、颜色块、参数输入）
立即禁用；只有命令**完成 / 超时 / 出错**，或连接断开后才恢复。

**为什么**：

- 固件同一时刻只接受一条命令：`EPD_TaskSubmit()` / `FlashTaskSubmitErase()` 忙时返回 `-1`，
  并发下发会被直接丢弃；
- 前端的 `sendAndWait()` 是按 `CMD` 匹配响应的，两条命令重叠会串包，
  出现「刷纯色收到擦除的完成帧」这种假成功。

**实现方式**（`assets/js/ble-console.js`）：

```js
const usable = !!client.connected && !locked;   // 连接 && 未锁定
function applyCommandEnabled() { /* 所有命令控件统一在这里开关 */ }
function setCommandLock(v) { locked = v; applyCommandEnabled(); }

busy = true; setCommandLock(true);
try { await client.xxx(); } catch (e) { ... } finally { busy = false; setCommandLock(false); }
```

**新增命令卡片时必须做**：

1. 把新增的按钮/下拉/输入加进 `applyCommandEnabled()` 的统一开关列表；
2. handler 套用上面的骨架：`busy` 守卫 → `setCommandLock(true)` → `try/catch/finally` →
   `finally` 里 `setCommandLock(false)`，**超时和异常路径也要解禁**；
3. 不要只靠 `log('上一条命令还在执行')` 这种提示——按钮还能点，就还是会误操作。

**边界**：连接 / 断开按钮不属于命令卡片，执行期间保持可用，作为卡死时的逃生通道；
断开时 `locked` 会被清掉，重连后不会一直锁着。

## 2. 长命令用「空闲超时 + 心跳保活」，不要用固定总超时

- E6 整屏刷新实测十几秒到几十秒，固定 15 s 总超时会误判失败；
- 固件在刷屏期间持续重复回 `RESPONSE_CODE_DOING`（`55 AA 00 08 10 01 00 0D`）当心跳；
- 所以 `sendAndWait()` 每收到一帧同 `CMD` 的响应就重置计时器：
  刷纯色 / 刷图 20 s、擦除 60 s 收不到任何帧才失败；
- 心跳帧不逐条写日志（几十上百条会把日志冲掉），只在第一次心跳补一条说明；
  界面用 `onHeartbeat(cmd, count)` 刷进度。

**以后加长耗时命令**：先问设备有没有心跳；没有心跳的，给足固定空闲上限并写清在提示里。

## 3. 送图（`0x30`）必须「先擦后写、逐片等 DONE」

协议见固件仓库 `BLE_Protocol.md`，实现见 `ble.js` 的 `writeImage()`：

- **先擦同槽**：发 `0x20` 擦除目标 `image_id`，等 `0x02` 成功才允许送图；
  擦除失败/超时直接中止，不要「擦除没回就继续写」。
- **分片固定 233 字节**：帧长 244（`55 AA 00 F4 30 [id] [offH offM offL] [payload] 00 0D`），
  offset 大端、从 0 每片 +233；最后一片 payload 147 字节、帧长 158。172800 字节 → 742 片。
- **每片等 DONE 再发下一片**：这是天然流控，连发会撞上固件忙状态被 `BUSY` 丢弃。
- **单片失败要重发**：GATT 偶发错误（典型「GATT operation already in progress」）、
  该片超时、设备回 `BUSY` 都属于可重试；每片最多 3 次（`attempts`，退避 40/80 ms），
  重试要记一条日志并在进度上标出来。协议错误（`无效数据` / `无效主命令`）不重试，
  重发也不会变好。
- **写请求要带响应**：244 字节的包用 Write Request（`writeValueWithResponse`），
  需要 ATT MTU ≥ 247；Web Bluetooth 没有主动请求 MTU 的接口，只能依赖系统自动协商，
  写入报长度错误时要明确提示 MTU 不足。
- **742 片不逐条写日志**：`client.silentCmd` 让该 cmd 的收发静默，进度交给进度条；
  否则日志被冲掉、页面也会卡。
- 送图期间同样 `setCommandLock(true)`，并提供「中止」（`shouldStop` 每片检查一次）。
- 送完图默认接着发 `0x11` 把这一槽刷到屏上（送图卡片「送完自动刷图」复选框，可关掉）；
  只写 flash 不会显示，槽里没数据时 `0x11` 只会刷出空白。

## 4. 刷图（`0x11`）的完成通知 CMD 是 `0x10`（固件约定）

固件 `peripheralEPDTaskCB()`（`E6_P370_CH592F/App/peripheral.c`）推送刷屏进度 / 完成通知时，
把帧里的 CMD **写死为 `CHAR3_CMD_10_UPDATE_COLOR`**，刷纯色和刷图共用同一条 8 字节通知：

```
55 AA 00 08 10 [01 心跳 | 02 完成 | FF 失败] 00 0D
```

所以等 `0x11` 的应答时**必须把 `CMD=0x10` 的帧一起算**，否则永远等不到 `0x02`：

- `ble.js` 的 `sendFrameAndWait()` 支持 `opts.acceptCmds`（额外接受的 CMD 列表），
  匹配判定为 `const accept = [cmd].concat((opts && opts.acceptCmds) || []);`；
- `updateImage(imageId, opts)` 固定带 `acceptCmds: [CMD.UPDATE_COLOR]`，外层还包了
  `withRetry()`（`0x11` 收到 `0x03` 表示任务队列满，可重试）；
- 别把这套抄给 `0x20` / `0x30`：`peripheralFlashTaskCB()` 的通知 CMD 是按操作区分的
  （擦除回 `0x20`、写片回 `0x30`），乱加接受项反而会串包；
- `acceptCmds` 只加同名通知，不要写成「接受所有 CMD」；顺带用测试把
  「无关 CMD 的完成帧不能误判成功」钉住（`tests/ble.test.mjs` 第 16 组）。

## 5. 帧解析不要假定 PAYLOAD 首字节是响应码

- `0x10` / `0x11` / `0x20` / `0x30` 的 PAYLOAD 首字节是响应码（`0x00` 成功 / `0x01` 受理·心跳 / `0x02` 完成 / `0x03` 忙 / `0xE0+` 错误）；
- `0x00` 读版本的应答**没有响应码**：`55 AA 00 0A 00 10 84 02 00 0D` 里 `10 84 02` 就是版本号，
  曾经按「首字节=响应码」解析，报出过「未知响应 0x10」；
- `parseStream()` 只负责切帧，语义交给各命令自己处理：读版本单走 `readRevision()`。

## 6. 状态显示

- 徽章只显示三态短文案：未连接 / 连接中… / 已连接，设备名单独放在右侧，不重复；
- 滚动后顶栏出现同一状态的徽章（`#bleStatusTop`），回到顶部自动隐藏；
- 命令卡片各自带一个小状态徽章：未执行 / 执行中（带耗时、心跳数）/ 成功 / 失败。

## 7. 移动端

- ≤640px：单列布局、表单项独占一行、输入框字号 ≥16px（防 iOS 聚焦放大）、
  顶栏按钮收成图标（`.btn-label` 隐藏）、表格包 `.table-wrap` 横向滚动。

## 8. 提交前自检

```bash
node --check assets/js/*.js
node tests/codec.test.mjs
node tests/ble.test.mjs
```

- 新增控件要挂进 `el` 映射，页面 id 与 JS 引用必须一一对应；
- HTML 标签配平、CSS 花括号配平；
- 提交信息写清「改了什么、为什么」，一个逻辑一处提交。
