# 秦二密码管理

**自动记录网站用户名和密码，同步到你自己的 WebDAV；下次打开网页时自动提示并填写。**

一个不依赖任何第三方服务器的浏览器扩展（Chrome / Edge / Firefox）。扩展的内部标识（包名、存储键、`gecko.id`）仍然是 `pwdmg`，所以改名不影响已经存好的密码库和 WebDAV 配置。密码库就是一个 JSON 文件，存在你自己的 WebDAV 上；可以只用明文（方便查看、备份、迁移），也可以开启**主密码加密**，让落盘和上传的只有 AES-GCM 密文。

```
        登录网站时                                   下次访问时
   ┌──────────────────┐                      ┌──────────────────────┐
   │ 用户名 / 密码输入 │                      │ 密码框右侧出现 🔑 图标 │
   │ 点击“登录”        │                      │ 自动展开匹配的账号列表 │
   └────────┬─────────┘                      └───────────┬──────────┘
            │ 捕获                                        │ 一键填充
            ▼                                             ▼
   ┌──────────────────┐      WebDAV      ┌──────────────────────────┐
   │ 扩展本地缓存      │ ◀── GET / PUT ──▶ │ vault.json（你的服务器）  │
   │ chrome.storage   │   ETag 冲突合并   │ 明文 JSON 或 AES-GCM 密文 │
   └──────────────────┘                   └──────────────────────────┘
```

---

## 功能

- **自动记录**：提交登录表单时捕获用户名 + 密码，写入本地缓存并上传 WebDAV。
- **自动提示**：打开登录页时，在密码框旁显示图标，并自动弹出该站点匹配的账号（可关）。
- **自动填充**：只有 1 个匹配账号且密码框为空时直接填入（可关）；多账号时在面板里点选，也能「填充并提交」。
- **多站点匹配**：按主机名匹配，`login.example.com` 与 `example.com` 视为同一站点。
- **多账号**：同一站点可保存多个账号，按最近使用排序。
- **多设备同步**：以 `updatedAt` 合并、ETag 乐观锁防止互相覆盖；删除用墓碑（tombstone）同步，不会「删了又回来」。
- **配置即用**：填一个 WebDAV 文件地址即可，支持 Basic 认证、Bearer 令牌、自动创建目录。
- **可管理**：工具栏弹窗管理当前站点账号，设置页可搜索、编辑、删除、导入/导出整个密码库。
- **导入浏览器密码**：支持 Chrome / Edge、Firefox、Bitwarden、LastPass 导出的 CSV，导入前显示统计预览，默认只新增、可按需覆盖已有密码。
- **兜底与恢复**：每次覆盖 WebDAV 前都把旧文件在本地留一份快照（最多 5 份，加密库存密文），远端写坏或误导入时可以一键回滚；另有「以本地覆盖远端」用于修复被污染的远端文件，以及导出提醒。
- **主密码加密（可选）**：一个主密码派生 PBKDF2-SHA256 密钥，用 AES-GCM-256 加密整个密码库；本地缓存与 WebDAV 文件都只存密文。主密码不落盘、不上传。
- **密码变化确认**：同一站点同一用户名再次提交了不同的密码时，页面右下角会弹出「保留旧密码 / 更新密码」卡片，确认后才覆盖；注册和改密表单会被识别出来，不会误建条目。待确认的变更存在会话里（30 分钟有效，只存 `storage.session`），所以登录后**页面跳转 / 刷新**了也还能继续确认。

## 安装

先构建（生成 `dist/` 目录）：

```bash
npm run build
```

**Chrome / Edge / 其他 Chromium 内核浏览器**

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择本仓库的 `dist/chrome` 目录
4. 首次安装会自动打开设置页

**Firefox（115+）**

1. 打开 `about:debugging#/runtime/this-firefox`
2. 点「临时载入附加组件」，选择 `dist/firefox/manifest.json`
3. 也可以在 `about:config` 里把 `xpinstall.signatures.required` 设为 `false` 后，用 `dist/pwdmg-firefox.zip` 做本地安装（仅限开发者版本）

> Firefox 的临时加载在重启浏览器后失效，属于正常现象。

## 首次配置

打开扩展设置页（工具栏图标 → 「设置」，或扩展详情页 →「扩展程序选项」），填写 **WebDAV 文件地址**——它指向一个具体文件，不是目录：

| 服务 | 地址示例 |
| --- | --- |
| Nextcloud / ownCloud | `https://cloud.example.com/remote.php/dav/files/你的用户名/pwdmg/vault.json` |
| 坚果云 | `https://dav.jianguoyun.com/dav/pwdmg/vault.json` |
| 群晖 Synology（WebDAV Server） | `https://nas.example.com:5006/pwdmg/vault.json` |
| Apache mod_dav / nginx | `https://dav.example.com/pwdmg/vault.json` |
| rclone serve webdav | `http://192.168.1.10:8080/pwdmg/vault.json` |

- **地址可以只填到目录**：以 `/` 结尾（或最后一段没有扩展名）时会自动补成 `…/vault.json`，保存后输入框会显示补全后的完整地址。反过来，地址指向目录时服务器返回的是网页，插件会明确提示而不是丢一个 JSON 解析错误。
- **认证方式**：一般选「用户名 + 密码（Basic）」。Nextcloud / 坚果云请先在账户设置里生成**应用专用密码**，不要填主密码。
- **自动创建目录**：勾选后会用 `MKCOL` 逐级创建缺失目录（`pwdmg/`）。
- 点「**保存并测试连接**」：Chrome 会弹出一次「读取和更改此网站上的数据」的权限请求（只针对你填的那个域名），确认即可。Firefox 在安装时已授予站点权限。

保存后，扩展会立刻拉取远端密码库；如果文件还不存在，会在第一次保存账号时创建。

## 使用

- **记录**：正常登录一次即可。提交后右下角会出现「已记录 example.com · alice」的提示，6 秒内可点「撤销」。
- **提示 / 填充**：
  - 密码框右侧出现 🔑 图标，点开是匹配的账号列表；
  - 页面加载后如果检测到登录框，会自动展开列表；只有 1 个账号时会直接填入；
  - 鼠标点进密码框也会展开列表；
  - 列表每行：点「填充」只填表单，点「↵」填充并提交。
- **手动添加 / 编辑**：点工具栏图标，在弹窗里「＋ 手动添加账号」；已有账号可显示、复制、编辑、删除。
- **立即同步**：弹窗右上角 ⟳，或设置页「立即同步」。扩展也会按设定的间隔（默认 15 分钟）自动同步。

### 主密码加密

设置页「2 · 主密码加密」里可以随时开启 / 关闭：

1. **启用**：输入两次主密码（至少 8 位）。扩展会用新密钥把当前密码库重新加密并上传覆盖远端文件，然后清空明文缓存。
2. **解锁**：每次启动浏览器后密码库都是锁定状态。点工具栏图标或设置页，输入主密码解锁；解锁密钥只放在 `storage.session`，**浏览器一关就失效**。
3. **锁定**：弹窗底部或设置页点「锁定」，立即丢弃会话密钥。锁定时不能填充、不能记录、不会上传。
4. **修改主密码**：用旧主密码解出内容，再用新主密码重新加密整份文件上传（旧文件被覆盖）。
5. **关闭加密**：远端文件会变回明文 JSON（会二次确认，提醒你风险）。

> 主密码只在你脑子里：扩展既不上传也不保存它。**忘记主密码 = 无法解密，数据不可恢复**（除非你手里有导出的明文备份）。

### 从浏览器导入密码

设置页「4 · 同步与数据」→ **导入 JSON / CSV**，支持：

| 来源 | 文件 | 说明 |
| --- | --- | --- |
| Chrome / Edge | `Chrome 密码.csv` | `name,url,username,password,note` |
| Firefox | `logins.csv` | `url,username,password,...` |
| Bitwarden | `bitwarden_export_*.csv` | `folder,favorite,type,name,login_uri,...` |
| LastPass | `lastpass.csv` | `url,username,password,totp,extra,name,grouping,fav` |
| 本扩展 | `pwdmg-vault-*.json` | 明文 JSON 备份 |

导入规则：

- 按**完全相同的主机名 + 用户名**匹配已有记录（`mail.example.com` 与 `example.com` 分开存，不会被合并）
- 同一条记录在文件里出现多次时保留**最后一条**
- `android://` 应用凭据、没有密码、没有可用网址的行会被跳过（结果里会显示跳过了多少）
- 默认**只新增不覆盖**：已存在且密码不同的记录会跳过；勾选「导入时覆盖已有密码」才会替换
- 导入完成后立即同步到 WebDAV；加密库需要先解锁

> 浏览器导出的 CSV 是**明文**，里面有全部密码。导入成功后请立刻删除该文件（也不要放进网盘 / 仓库）。

### 出问题时的自救

WebDAV 上的 `vault.json` 就是全部数据，所以扩展在写入方向上做了几层保护（设置页「5 · 备份与恢复」）：

| 场景 | 现象 | 怎么办 |
| --- | --- | --- |
| 远端文件被改成网页 / 被截断 | 同步报「返回的不是 JSON」，每次同步都失败 | 点「**以本地覆盖远端**」：本地缓存是好的，直接覆盖回去 |
| 远端被别的程序覆盖成旧版本 / 空库 | 账号变少或消失 | 在快照列表里找回覆盖前的那一份，点「恢复」 |
| 误导入、误删除一批账号 | 密码库被改乱 | 找到 `导入前的本地快照` / `删除前的快照` 恢复 |
| 换电脑 / 重装扩展 | 本地缓存没了 | 数据都在 WebDAV 上，重新填地址即可拉回 |

快照规则：

- 每次**成功上传**前，把即将被覆盖的远端内容存进 `storage.local`（`vaultHistory`），最多 5 份、总量上限 4 MB，自动淘汰最旧的
- 加密库的快照就是**密文信封**，不会因为快照多出一份明文；恢复时需要先解锁
- 导入 JSON / CSV、以远端覆盖本地、恢复快照之前，也会先给当前本地密码库留一份
- 恢复快照会**强制覆盖远端**（否则合并逻辑会把刚回滚掉的账号又拉回来），覆盖前的远端同样会留快照，可以反悔
- 快照只在本地，不上传；换设备前想带走就用「导出 JSON」

另外设置页会显示「上次导出时间」，超过 7 天没导出会提醒你再存一份离线备份。

### 健壮性（第二版审计加固）

2026-11 做了一轮整体审计（静态阅读 + 多设备随机同步 + 属性测试 + 模糊测试），以下问题已修复并有回归用例：

| 问题 | 原来会怎样 | 现在 |
| --- | --- | --- |
| 加密参数丢失（清过扩展数据）但远端是明文 | 永久锁定：解锁报「还没启用加密」，关闭加密又要求先解锁，密码库彻底不可用 | 自动降级为明文模式并在设置页提示，可重新设置主密码 |
| 远端被别的设备加密，本地有没上传的条目 | 解锁时本地条目被远端内容覆盖，**静默丢数据** | 解锁时合并本地，两边都保留 |
| 远端 `vault.json` 被删除 | 本地显示「已同步」，远端其实什么都没有 | 下次同步自动补传回去 |
| 两台设备同时点「以本地覆盖远端」 | 报「文件已被其他设备修改」，覆盖失败 | 自动重试（刷新 ETag）直到成功 |
| 修改主密码 | 旧密文快照用新密钥解不开，恢复失败 | 快照跟着换密钥；关闭加密时快照转为明文 |
| 远端文件里 `iterations` 被改成一亿 | 解锁卡几分钟（PBKDF2 是故意慢的） | 超过 2,000,000 直接拒绝 |
| 导入 5000 条 CSV | 逐条规范化，约 22 秒 | 一次规范化 + 索引表，约 0.1 秒 |
| 导入超过 5000 条 | 静默截断，统计对不上 | 明确提示「本次只处理前 5000 条」 |
| 设置页保存设置 | 读-改-写竞争，会丢掉同时写入的字段（如导出时间） | 写入串行化 |
| 同步一直失败 | 每 30 秒重试一次，把服务器打满 | 退避重试：0.5 → 1 → 2 → … 最多 30 分钟，成功后复位 |

### 设置项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| 自动记录 | 开 | 提交登录表单时捕获凭据 |
| 自动提示 | 开 | 打开页面时显示匹配账号、注入密码框图标 |
| 自动展开面板 | 开 | 页面加载后自动弹出账号列表（只在首屏、密码框为空时） |
| 自动填充 | 开 | 只有 1 个匹配账号时直接填入 |
| 密码变化时先确认 | 开 | 关闭后，同站点同用户名的密码变化会直接保存，不再询问 |
| 同步间隔 | 15 分钟 | 定时同步周期（最小 1 分钟） |
| 自动创建目录 | 开 | 用 `MKCOL` 创建缺失目录 |
| 兼容模式（不使用 If-Match） | 关 | 写入不带 `If-Match`：服务器 ETag 不可靠时用（详见「已知限制」）；多设备同时写以最后一次为准 |

## 数据格式

### 加密后（v2 信封）

开启主密码加密后，远端文件和本地缓存都只有密文，结构如下（共 2 空格缩进，可读但不可解）：

```json
{
  "format": "pwdmg-vault",
  "version": 2,
  "encrypted": true,
  "kdf": {
    "name": "PBKDF2",
    "hash": "SHA-256",
    "iterations": 310000,
    "salt": "base64(16 字节随机盐)"
  },
  "cipher": { "name": "AES-GCM", "iv": "base64(12 字节随机 IV)", "tagLength": 128 },
  "data": "base64(密文 + 认证标签)",
  "updatedAt": "2025-01-02T03:04:05.000Z"
}
```

- 密钥 = `PBKDF2-HMAC-SHA256(主密码, salt, iterations)`，长度 256 位；主密码本身不写入文件。
- 每次保存都会换一个新的 IV；解密时会校验 GCM 认证标签，密码错误或文件被改动都会直接失败，不会得到乱码内容。
- `iterations` 随文件保存，以后调高迭代次数不会让旧文件解不开。
- **判断加密与否**：远端是 `format: "pwdmg-vault"` 的信封就一定是加密库；是下面的 `version: 1` 明文就是明文库。新设备第一次连接时会先探测远端，避免把明文覆盖到加密文件上。

### 未加密（v1 明文）

密码库是一份自解释的明文 JSON，可以直接备份、手工修改（改完记得在设置页「以远端覆盖本地」）：

```json
{
  "version": 1,
  "updatedAt": "2025-01-02T03:04:05.000Z",
  "entries": [
    {
      "id": "0f2c1c1e-7f6d-4a1f-9d0e-1a2b3c4d5e6f",
      "host": "example.com",
      "origin": "https://example.com",
      "url": "https://example.com/login",
      "username": "alice",
      "password": "s3cret!",
      "title": "example.com",
      "notes": "",
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-01-02T03:04:05.000Z",
      "useCount": 3,
      "lastUsedAt": "2025-01-02T03:00:00.000Z"
    }
  ],
  "tombstones": {
    "已删除条目的 id": "2025-01-02T03:04:05.000Z"
  }
}
```

- `entries[].host` 决定匹配范围（支持子域双向匹配）。
- `tombstones` 记录删除时间，保证多设备之间「删除」也能同步；超过 180 天自动清理。
- 合并规则：同一条目取 `updatedAt` 较新者；删除时间晚于条目更新时间时条目被删除。

## 安全说明（请务必阅读）

- **加密是可选的，默认关闭**。不开加密时，密码库是明文 JSON：任何能访问该文件的人都能看到全部密码，本地缓存（`chrome.storage.local`）也是明文。这种情况请务必：
  - 使用 **HTTPS** 的 WebDAV；
  - 使用**应用专用密码 / 访问令牌**，不要用主账号密码；
  - 把文件放在私有目录，不要公开分享；
  - 不要把 WebDAV 密码写在公共设备的浏览器里。
- **开启主密码加密后**：远端文件与本地缓存都只有 AES-GCM 密文；密钥由主密码经 PBKDF2-SHA256（默认 310000 次迭代）派生，只在内存和 `storage.session` 里存在。**「导出」得到的仍是明文 JSON**（否则没法用来恢复），导出时会提醒你这一点，请妥善保管该文件。
- **忘记主密码没有后门**：没有找回、没有提示，只能丢掉这份密码库（或从你之前导出的明文备份恢复）。
- 加密只保护「文件内容」。同步时仍然需要 WebDAV 的账号密码 / 令牌，它们照旧保存在扩展设置里；能完全控制你浏览器配置文件的人仍然可以读走它们。
- 在一个设备上改了主密码，其他设备下次同步会要求用**新主密码**解锁；旧主密码会报「主密码不正确，或文件已损坏」。
- 关闭加密是**破坏性**操作：文件会以明文覆盖上传，旧密文不再保留。
- 扩展不会把密码发往任何第三方服务器，**唯一的外部请求就是你自己配置的 WebDAV 地址**。
- 捕获逻辑的防护：注册 / 修改密码表单（多个密码框或 `autocomplete="new-password"`）不会被记录或填充；刚由扩展填充的凭据再次提交不会重复记录；凭据的站点以**浏览器提供的发送方地址**为准，页面无法伪造。
- 站点权限：Chrome 版只在你保存 WebDAV 地址时申请**那一个域名**的访问权限；内容脚本需要读取页面上的登录表单，因此在 `http/https` 页面上运行。

## 已知限制

- **多步登录**（先输入用户名、下一步才出现密码框）：如果该站点只有 1 个已保存账号，扩展会自动沿用它的用户名更新密码；如果该站点有多个账号，可能记录成空用户名，可在弹窗里手动补全。
- **验证码 / 二次验证 / 短信登录**不受影响，但需要你手动点「填充」。
- 极少数站点用 Web Components 的**封闭 Shadow DOM** 渲染登录框，扩展无法访问。
- 部分站点把密码框做成 `type="text"` + `-webkit-text-security` 掩码，1.5.2 起可以识别；但用**自绘 canvas** 当输入框的站点（极少数）仍然无法填充。
- 登录表单在**跨域 iframe** 里时，内容脚本会在该 iframe 中独立工作（图标/面板出现在 iframe 内部），弹窗的「填充」会先尝试顶层框架再尝试所有框架。
- WebDAV 服务端需要支持 `GET`、`PUT`，建议支持 `MKCOL`（自动建目录）。只读共享或需要交互式网页登录（非 Basic/Bearer）的服务不可用。
- 同一站点、同名用户名的多条记录会被视为同一条（后写的密码生效）。
- **使用次数 / 最近使用时间只记在本机**：它们不参与同步，否则每填一次密码都要改一次远端文件。换设备后「最常用」的排序会重新开始。
- **条件写入（`If-Match`）**：上传时会带上远端文件的 ETag，避免覆盖别的设备刚写的内容。如果服务器**不返回 `ETag`**，或者 `ETag` 每次请求都变，两台设备恰好同时上传时会退化为「后写的赢」；下一次同步会通过合并把丢失的条目补回来，但那一刻的密码可能不是最新的。
- **弱校验符（`W/"…"`）**：按 RFC 允许的形式发强校验符（去掉 `W/` 前缀），大多数服务器接受；个别服务器的 `If-Match` 实现有问题，连续 412 时扩展会**自动降级**：本次同步改为不带 `If-Match` 上传，把「兼容模式」记为已开启，并在弹窗/设置页提示「已自动切换为兼容模式：不再发送 If-Match」。也可以在第 4 节手动勾选同一个开关随时关掉。
- 远端文件的 `iterations` 有上限（2,000,000），超过会被判为「文件可能已被篡改」，避免一个被改过的文件让解锁卡上几分钟。
- 主密码丢失无法恢复；扩展不会保存任何主密码提示（仅显示迭代次数等公开参数）。
- 待确认的密码变更只保留**最近一条**（同一时间只提示一个站点的变化），30 分钟后失效，浏览器重启或锁定即清空。
- 解锁状态按浏览器会话保存：重启浏览器、或关闭并重新打开扩展的 service worker 后仍保持（`storage.session`），但**浏览器重启即失效**，需要重新解锁。

## 常见问题

**测试连接提示「网络请求失败」**
检查：地址是否以 `http(s)://` 开头且指向文件；证书是否有效；Chrome 是否授予了该域名的访问权限（设置页重新点一次「保存并测试连接」会再次申请）。

**提示「认证失败（401）」**
多半是用了主密码。Nextcloud / 坚果云需要在账户安全设置里创建**应用专用密码**；有些服务需要用户名带域名（如 `user@example.com`）。

**提示「这个地址返回的是网页，不是密码库文件」**
说明 `GET` 拿到的是 HTML（目录列表页 / 登录页 / 反向代理页面），不是 JSON。逐个排查：
1. 地址要精确到文件，例如 `https://dav.example.com/pwdmg/vault.json`；只填到目录时插件会自动补 `vault.json`，但路径本身必须对。
2. DAV 路径：Nextcloud 用 `/remote.php/dav/files/<用户名>/…`，坚果云用 `/dav/…`，群晖用 WebDAV Server 的 **5005/5006** 端口（不是 DSM 的 5000/5001）。
3. 认证没通过时有些服务会重定向到登录页（200/302），此时请改用应用专用密码。
4. 用终端确认一次：`curl -i -u '用户名:应用密码' '地址'`——期望 `404`（文件还不存在，正常）或 `207`；`200` + `text/html` 就是地址指向了网页。

**提示「文件已被其他设备修改」**
扩展会自动重新读取、合并后重试，一般无需干预。若反复失败，检查是否有其他程序在写同一个文件。

**提示「服务器拒绝了条件写入（HTTP 412）」**
这不是网络问题：远端文件的 ETag 与扩展手上的不一致，或者服务器对 `If-Match` 的处理不合规范（常见于部分 NAS、Apache mod_dav 配置、经过反向代理 / CDN 的 DAV）。
1. 先点一次「立即同步」——扩展会自动重新读取远端、合并后再重试，若第二次成功就不会降级。
2. 仍然 412 时，扩展会自动切换成兼容模式（不再发送 `If-Match`）并给出提示；也可以在设置页第 4 节手动勾选「兼容模式：不使用 If-Match」。
3. 兼容模式下多台设备同时写入时以最后一次为准（下一次同步仍会通过合并把条目补齐），代价是那一刻可能短暂丢失刚写入的一条。

**改完远端 JSON 没生效**
点击设置页的「以远端覆盖本地」，或等待下一次定时同步。

**提示「主密码不正确，或文件已损坏」**
输入的主密码不对（也可能是另一台设备改过主密码）。确认大小写、输入法、是否多复制了空格。若确实全部忘记，只能删除/替换远端文件重新开始。

**每次重启浏览器都要解锁？**
是的，这是设计如此：解锁密钥只存在 `storage.session`。想少输几次可以靠浏览器密码管理器记住主密码框（风险自负）。

**保存了密码却没提示更新**
检查设置页「密码变化时先确认」是否开着：开着时需要在页面右下角卡片点「更新密码」；关着则提交即覆盖。如果那条记录不是同一用户名，会被当成新账号处理。

**同步了但站点上不提示**
确认登录页真的有一个可见的密码输入框；某些站点需要先把页面切到「账号登录」标签。也可以点一下密码框触发面板。

**点了「填充」，密码框却消失了 / 没填进去**
这类站点把登录框做成了**弹层**（arena.ai、Notion、各类后台都是），而且会在 `document` 上监听 `pointerdown` / `click`，判断点在弹层外面就把弹层关掉。扩展的图标和面板挂在 `<html>` 下，过去的版本会被页面当成「点外面」：弹层先关、密码框先没，填充就落空了。
1.5.2 起：扩展在 `window` 捕获阶段（早于页面的监听器）拦下落在自己 UI 上的点击，页面收不到这次事件，弹层不会关；动作也改到**按下瞬间**执行，并在写完后核对值与重试最多 10 拍，页面当场重建登录框也能填上。
仍然填不进去时按顺序排查：
1. 确认用的是 1.5.2 或更新版本（设置页顶部显示版本号）。
2. 点一下密码框**先让面板出现**，再点面板里的「填充」/「↵」，不要用浏览器密码管理器补全。
3. 如果站点把登录框渲染在**封闭 Shadow DOM**或**跨域 iframe 的 cross-origin 隔离环境**里，扩展无法访问（见「已知限制」）。跨域 iframe 里扩展在该 iframe 内独立工作，图标会出现在 iframe 内部。
4. 页面在填充后立刻跳转 / 重渲染属于站点自身行为；「填充并提交」失败时改用「填充」，确认值写进去后手动点登录。

**面板 / 图标看起来没有样式（裸文字、位置乱）**
站点 CSP 很严格时会拦掉内容脚本插入的 `<style>`。1.5.2 起优先用 `adoptedStyleSheets` 注入，仍然被拦时退回关键行内样式，不会再出现完全没样式的面板。

## 开发

```bash
npm run check        # 语法 + JSON 校验
npm test             # 单元 / 集成 / DOM 测试
npm run build        # 生成 dist/chrome、dist/firefox 及 zip
npm run verify       # 上面三步一起跑
npm run release      # 校验 + 测试 + 打包 + 校验和（见「打包与发布」）
npm run version:check# 只检查三处版本号是否一致
npm run icons        # 重新生成 icons/*.png
```

- 测试默认零依赖；安装 `jsdom`（`npm install`）后会额外运行内容脚本与页面测试：

```bash
npm install        # 只装 jsdom（devDependency）
npm test
```

### 目录结构

```
CHANGELOG.md             版本与变更记录
manifests/               两种浏览器的 manifest（构建时复制为 manifest.json）
  manifest.chrome.json   MV3 + service worker + optional_host_permissions
  manifest.firefox.json  MV3 + background.scripts + host_permissions
src/
  background.js          同步引擎、凭据记录、消息路由、徽标
  shared/
    api.js               chrome.* / browser.* 兼容层
    util.js              主机名匹配、时间格式化等
    vault.js             密码库模型：upsert / merge / 墓碑 / 查找
    crypto.js            主密码派生、AES-GCM 加解密、信封序列化
    csv.js               密码 CSV 解析（Chrome / Edge / Firefox / Bitwarden / LastPass）
    webdav.js            极简 WebDAV 客户端（GET/PUT/MKCOL/PROPFIND + ETag）
    store.js             设置与本地缓存读写
  content/
    content.js           登录框识别、提示面板、填充、提交捕获
  popup/                 工具栏弹窗（当前站点账号管理）
  options/               设置页（连接、行为、同步、密码库）
icons/                   16/32/48/128 图标
.github/
  workflows/release.yml  tag 触发：校验版本 → 测试 → 打包 → GitHub Release
scripts/
  build.mjs              组装 dist 并打包 zip
  release.mjs            改版本号 → 校验 → 测试 → 打包 → 提交 / 打 tag
  check-version.mjs      校验 package.json 与两个 manifest 的版本号
  check.mjs              静态检查
  make-icons.mjs         零依赖生成 PNG 图标
  lib/zip.mjs            零依赖 ZIP 写入（deflate / store，可复现）
  lib/version.mjs        版本号读写与校验
test/
  util.test.js           工具函数
  vault.test.js          密码库模型（合并、墓碑、去重）
  webdav.test.js         针对本地内存 WebDAV 服务的协议测试
  crypto.test.js         信封格式、加解密、错误主密码
  csv.test.js            CSV 解析、表头别名、去重与跳过规则
  import.test.js         CSV 批量导入 + 待确认密码变更的端到端
  background.test.js     端到端：记录 → 上传 → 拉取 → 删除 → 冲突
  encryption.test.js     加密生命周期：启用 / 解锁 / 锁定 / 改主密码 / 关闭
  content.test.js        内容脚本（jsdom）
  pages.test.js          弹窗 / 设置页（jsdom）
  build.test.js          zip 打包正确性与版本号一致性
  helpers/               测试用的 WebDAV 服务器与扩展 API 模拟器
```

### 技术要点

- **Manifest V3**：Chrome 用 service worker + `importScripts`；Manifest 里为 Firefox 列出 `background.scripts`，同一份 `background.js` 两种环境都能跑。
- **消息协议**：`content:getState` / `credential:capture` / `credential:used` / `vault:*` / `settings:changed`，全部经过 `shared/api.js` 的 `sendMessage` 封装。
- **导入**：`shared/csv.js` 只做纯解析（RFC 4180、表头别名、按主机+用户名去重），`vault:importEntries` 负责合并策略（精确匹配主机、默认不覆盖、跳过 `android://`）。
- **待确认变更**：`credential:capture` 检测到密码变化时把新密码存进 `storage.session` 的 `pendingChange`；页面加载时内容脚本用 `credential:pending` 取回并重新弹卡片，确认 / 拒绝走 `credential:resolvePending`。
- **地址归一化 / 网页识别**：`shared/webdav.js` 的 `normalizeUrl()` 在客户端构造时统一处理地址（补 `vault.json`、去 hash），`read()` 检测到 HTML 响应会抛 `code:'html'`，因此「测试连接」也不会再误报成功。
- **并发安全**：所有同步串行执行；本地改动带自增 `rev`，上传期间若又发生增删，不使用旧快照覆盖本地，而是合并后追加一次同步（有回归测试覆盖）。
- **加密**：`shared/crypto.js` 只做纯函数（派生 / 加解密 / 信封），`background.js` 负责模式判定：远端信封强制加密；明文文件在 `settings.encryptVault` 或本地缓存已加密时保持加密；`encryptionDisabled` 标志防止「刚关闭加密又被远端密文拉回」。
- **解锁会话**：密钥存 `storage.session` 的 `vaultKey`，MV3 worker 被回收后仍可复用；`vault:lock` 直接删除。
- **UI 隔离**：内容脚本的面板/图标/提示都放在 Shadow DOM 中，避免与站点样式冲突；支持跟随滚动与深色模式。

## 打包与发布

### 只打包（本地用）

```bash
npm run build          # 等价于 node scripts/build.mjs
```

产物在 `dist/`：

| 文件 | 用途 |
| --- | --- |
| `dist/chrome/` | Chrome / Edge：「加载已解压的扩展程序」直接选这个目录 |
| `dist/firefox/` | Firefox：`about:debugging` 临时载入 `dist/firefox/manifest.json` |
| `dist/pwdmg-chrome.zip` | 提交 Chrome Web Store / 分发给别人 |
| `dist/pwdmg-firefox.zip` | 提交 Firefox AMO / 分发给别人 |

zip 由 `scripts/lib/zip.mjs` 自己写（**不依赖系统的 `zip` 命令**，Windows 也能跑），同样的输入产出同样的字节，方便核对两次构建是不是只改了想改的东西。

> 产物刻意**不是 `.crx`**：CRX 必须签名，商店上架收的就是 zip（签名由商店自己做，用户下载的 `.crx` 也是商店签的）；自签名 CRX 如今只能靠企业策略安装，普通用户拖拽会被拦；Firefox 则完全不支持 CRX（用 AMO 签名后的 XPI）。所以分发用 zip，本地调试用目录。

### 一条命令走完整流程

```bash
npm run release                            # 用当前版本号：校验 + 测试 + 打包 + 生成校验和
npm run release -- 1.2.0                   # 改版本号（package.json + 两个 manifest）后再打包
npm run release -- --bump patch            # 按语义化版本递增（patch / minor / major）
npm run release -- 1.2.0 --tag             # 再提交并打 git tag v1.2.0
npm run release -- 1.2.0 --tag --skip-test # 跳过测试（不推荐）
npm run release -- --pack-only             # 只打包，不改版本、不碰 git（CI 用）
npm run version:check                      # 只检查三处版本号是否一致
```

版本历史见 [`CHANGELOG.md`](CHANGELOG.md)。

`npm run release` 会依次：写版本号（`package.json`、`package-lock.json`、两个 manifest）→ `scripts/check.mjs` 静态检查 → `npm test` → 构建两个 zip → 生成 `dist/SHA256SUMS.txt` →（加 `--tag` 时）提交 `chore(release): vX.Y.Z` 并打附注 tag。

脚本不会自己 `push`，最后一步命令会打印出来：

```bash
git push origin HEAD --follow-tags
```

### GitHub Actions 自动发版

`.github/workflows/release.yml` 在**推送 `v*` tag**（或手动 `workflow_dispatch`）时运行：

1. `npm ci` 安装依赖（`package-lock.json` 已入库）
2. `node scripts/check-version.mjs "$GITHUB_REF_NAME"` —— tag 与 `package.json`、两个 manifest 必须完全一致，否则直接失败，防止发出错误版本号的包
3. `node scripts/release.mjs --pack-only` —— 静态检查 + 全部测试 + 打包 + 校验和
4. 上传 `pwdmg-chrome.zip`、`pwdmg-firefox.zip`、`SHA256SUMS.txt` 作为构建产物（保留 30 天）
5. tag 触发时创建 GitHub Release 并附上三个文件，Release 说明里带安装步骤

所以日常发版就两步：

```bash
npm run release -- 1.2.0 --tag
git push origin HEAD --follow-tags
```

### 上架商店

- **Chrome Web Store**：后台「上传新版本」选 `dist/pwdmg-chrome.zip`，首次上架需要一个 128×128 图标（仓库里已有）和隐私说明（扩展只访问你配置的 WebDAV 域名 + 页面登录表单，不收集数据）。
- **Firefox AMO**：上传 `dist/pwdmg-firefox.zip`。manifest 里已带 `browser_specific_settings.gecko.id`（`pwdmg@limkco.dev`），MV3 需要 Firefox 115+；AMO 会自动签名，签名后的包才能永久安装。
- 本地开发和测试**不需要**签名：Chrome 走开发者模式，Firefox 走 `about:debugging` 临时载入。

## 许可

MIT
