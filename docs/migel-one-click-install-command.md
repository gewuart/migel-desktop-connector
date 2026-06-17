# Migel 一键安装并配对命令模板

把下面命令复制到电脑终端，即可下载 Migel Desktop Connector、启动连接器并生成 Migel Android 配对二维码：

## macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/gewuart/migel-desktop-connector/main/tools/install-and-pair.sh | bash -s -- https://github.com/gewuart/migel-desktop-connector.git hermes
```

## Windows PowerShell

```powershell
irm https://raw.githubusercontent.com/gewuart/migel-desktop-connector/main/tools/install-and-pair.ps1 | iex; Install-MigelAndPair https://github.com/gewuart/migel-desktop-connector.git hermes
```

如果 App 已经从云端拿到短期桌面 claim，可以把 claim 作为第四个参数追加：

```bash
curl -fsSL https://raw.githubusercontent.com/gewuart/migel-desktop-connector/main/tools/install-and-pair.sh | bash -s -- https://github.com/gewuart/migel-desktop-connector.git hermes '' '<migel_dc_claim>'
```

```powershell
irm https://raw.githubusercontent.com/gewuart/migel-desktop-connector/main/tools/install-and-pair.ps1 | iex; Install-MigelAndPair https://github.com/gewuart/migel-desktop-connector.git hermes '' '<migel_dc_claim>'
```

脚本会自动完成：

1. 下载或更新 Migel 桌面连接器仓库
2. 检查 Node.js 22+、git
3. 安装 tools / gateway / desktop-connector 依赖
4. macOS 安装或重启 Hermes bridge LaunchAgent；Windows 跳过 macOS 服务并直启 connector
5. 安装 Migel pairing skill
6. 启动 desktop connector 并生成二维码

注意：不要把 relay 管理密钥、模型 API key、设备 token 写进命令。命令只应携带短期 claim 或一次性配对码。
