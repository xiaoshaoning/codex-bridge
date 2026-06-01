# Codex CLI on WSL — Installation & Configuration

How to install and configure OpenAI Codex CLI under WSL2, routing through the Codex Bridge running on the Windows host.

## Architecture (WSL2)

```
┌──────────────────── WSL2 ───────────────────┐
│                                               │
│  Codex CLI  ──HTTP──►  Windows Host          │
│  (Linux)               (vSwitch gateway)     │
│                         :8098                 │
│                          │                    │
└──────────────────────────┼────────────────────┘
                           │
               ┌───────────▼──────────────┐
               │   Codex Bridge (8098)    │
               │   Converts Responses API │
               │   ↔ Chat Completions     │
               └───────────┬──────────────┘
                           │
               ┌───────────▼──────────────┐
               │   DeepSeek API           │
               └──────────────────────────┘
```

The bridge runs on **Windows**. Codex CLI runs under **WSL2** (native Linux binary, full sandboxing). They communicate over the Hyper-V virtual switch — not localhost.

## Prerequisites

- WSL2 with a Linux distribution (Ubuntu recommended)
- Node.js 20+ **inside WSL**
- Codex Bridge running on Windows (port 8098)
- DeepSeek API key set on the bridge process

## Step 1 — Install Codex CLI Under WSL

```bash
npm install -g @openai/codex@latest
```

**Important**: Install with WSL's npm, not Windows npm. Windows npm ships only `codex-win32-x64` (Windows native binary), which cannot run under WSL. WSL needs `codex-linux-x64`, installed only by WSL's npm.

## Step 2 — Fix PATH Conflicts

WSL appends the Windows `PATH` by default. If Windows npm installed Codex earlier, `/mnt/c/Users/<user>/AppData/Roaming/npm` appears in WSL's PATH and shadows the WSL installation.

Add this to `~/.bashrc` after the npm-global PATH line:

```bash
export PATH=~/.npm-global/bin:$PATH
# Remove Windows npm path to avoid conflicts with WSL npm packages
export PATH=$(echo "$PATH" | sed 's|:/mnt/c/Users/admin/AppData/Roaming/npm:||g' | sed 's|:/mnt/c/Users/admin/AppData/Roaming/npm$||g')
```

Verify:

```bash
which -a codex
# Must show only: /home/<user>/.npm-global/bin/codex
```

## Step 3 — Understand the Networking

**This is the key WSL-specific issue.** The bridge listens on Windows `localhost:8098`, but WSL has its own separate network namespace. WSL's `localhost` is NOT Windows' `localhost`.

To reach the Windows host from WSL, use the Hyper-V virtual switch gateway:

```bash
ip route show default | awk '{print $3}'
```

**How this works:** WSL2 runs inside a lightweight Hyper-V VM. The virtual switch connects the VM's `eth0` to the Windows host. The VM's default gateway is always the host-side endpoint of that switch — so `ip route show default` prints the Windows host IP regardless of which subnet Hyper-V assigned.

```
$ ip route show default
default via <gateway-ip> dev eth0 proto kernel
      ^        └── column 3: Windows host IP
      └── column 1

$ ip route show default | awk '{print $3}'
<gateway-ip>
```

The output is **machine-specific** — each WSL2 install gets a different subnet. It can also change after a full WSL restart (re-creation of the Hyper-V switch), though it's usually stable across reboots.

Test it with your actual IP:

```bash
curl http://$(ip route show default | awk '{print $3}'):8098/health
```

Put the IP you get into the wrapper below — it replaces the hardcoded value used in other platforms.

## Step 4 — Configure Codex CLI

### Main Config: `~/.codex/config.toml`

```toml
model_provider = "deepseek"
model = "deepseek-v4-pro"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "http://localhost:8098/v1"
requires_openai_auth = false
wire_api = "responses"
supports_websockets = false

[projects."/home/<user>/codes/my-project"]
trust_level = "trusted"
```

The `base_url` value here is a **fallback placeholder** — it will be overridden at runtime by the wrapper below. Codex CLI v0.135.0+ supports `-c key=value` to override any config value on the command line.

| Key | Value | Notes |
|-----|-------|-------|
| `base_url` | `http://localhost:8098/v1` | Placeholder — overridden at runtime by wrapper |
| `wire_api` | `responses` | **Must** be `responses`. `chat_completions` will error |
| `requires_openai_auth` | `false` | Auth is handled server-side by the bridge |
| `supports_websockets` | `false` | Bridge uses SSE streaming |

### Shell Wrapper: `~/.bashrc`

The gateway IP is machine-specific and not universal. Instead of hardcoding it, add a shell function that resolves it dynamically on every invocation:

```bash
# WSL-aware codex wrapper — auto-resolves Windows host IP
codex() {
  local host_ip
  host_ip=$(ip route show default 2>/dev/null | awk '{print $3}')
  if [ -z "$host_ip" ]; then
    echo "codex: could not resolve Windows host IP" >&2
    return 1
  fi
  command codex -c "model_providers.deepseek.base_url=http://${host_ip}:8098/v1" "$@"
}
```

This makes `codex` automatically use the correct Windows host IP for every invocation, on every machine, after every reboot.

### Profile Configs: `~/.codex/pro.config.toml` and `~/.codex/fast.config.toml`

Codex v0.135.0+ requires profiles in **separate files** (not inline in `config.toml`).

**`~/.codex/pro.config.toml`** (heavy work):

```toml
model = "deepseek-v4-pro"
```

**`~/.codex/fast.config.toml`** (quick tasks):

```toml
model = "deepseek-v4-flash"
```

Usage:

```bash
codex exec -p pro "implement a pipelined CPU in Verilog"
codex exec -p fast "fix the syntax error on line 42"
```

## Step 5 — Start the Bridge

On **Windows** (not WSL), in PowerShell:

```powershell
cd D:\codes\codex-bridge
$env:DEEPSEEK_API_KEY = "sk-your-key-here"
npm start
```

The bridge must be running before any Codex command.

## Step 6 — Verify

```bash
cd /home/<user>/codes/<trusted-project>
codex exec "say hello"
```

The startup banner must show:

```
model: deepseek-v4-pro
provider: deepseek
```

A successful run returns output (not `tokens used: 0`). Check the bridge console to confirm requests are being forwarded to DeepSeek.

## About the Base URL

### Is the gateway IP universal?

**No.** The gateway IP is assigned by WSL's virtual switch and varies per machine. It can also change after a Hyper-V switch recreation (e.g., `wsl --shutdown` followed by restart).

### How to get the correct IP

```bash
ip route show default | awk '{print $3}'
```

### Why the wrapper approach

Hardcoding the IP in `config.toml` works until the IP changes. The shell function wrapper auto-resolves it on every call — no manual updates needed, and the same setup works across different machines.

### Alternative: hardcoded IP (simpler, fragile)

If you prefer a static config with no wrapper, run the command above once, put the result in `config.toml` as `base_url`, and update it manually if it ever changes:

```toml
base_url = "http://<your-gateway-ip>:8098/v1"
```

## WSL-Specific Troubleshooting

### "stream disconnected before completion: error sending request"

- Cause: Bridge is unreachable from WSL.
- Check: `curl http://$(ip route show default | awk '{print $3}'):8098/health`
- If that fails: is the bridge running on Windows? Did the gateway IP change?
- If the wrapper isn't set up yet: run `ip route show default | awk '{print $3}'` and verify it matches the `base_url` in config.toml.

### "Error loading config.toml: unknown variant `chat_completions`"

- Cause: `wire_api` is set to `chat_completions`.
- Fix: Set `wire_api = "responses"`.

### "profile `fast` cannot be used while config.toml contains legacy profile config"

- Cause: Profiles defined inline in `config.toml` (v0.134.0 compatible style).
- Fix: Move `[profiles.*]` tables to separate `~/.codex/<name>.config.toml` files, then remove them from the main config.

### "Missing optional dependency @openai/codex-linux-x64"

- Cause: The Windows npm Codex installation is being invoked.
- Fix: Apply the PATH fix from Step 2, then run `source ~/.bashrc` and `which codex`. It must point to `~/.npm-global/bin/codex`.

### "Codex could not find bubblewrap on PATH"

- Warning only. Codex uses a bundled fallback. To silence it: `sudo apt install bubblewrap`.

## Comparison: Native vs WSL + Bridge

| | Native (Codex → OpenAI) | WSL + Bridge (Codex → DeepSeek) |
|---|---|---|
| Model | OpenAI models | DeepSeek v4 |
| API key location | Codex CLI | Bridge (server-side only) |
| Network | Direct internet | WSL → vSwitch → Bridge → DeepSeek |
| Sandbox | Native Linux | Native Linux (WSL2 kernel) |
| Base URL | Static (api.openai.com) | Dynamic (vSwitch gateway IP) |
| Setup complexity | `npm install -g` | PATH fix, IP resolution, bridge on Windows |
