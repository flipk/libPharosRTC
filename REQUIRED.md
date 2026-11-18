# REQUIRED.md - Development & Testing Dependencies Guide

This document details all required software, development libraries, runtime tools, and system utilities needed to develop, build, and test **libPharosRTC** on Linux environments. Specific instructions are provided for both **Fedora 41** and **Ubuntu 22.04 LTS**.

---

## 1. Architecture & Tooling Summary

`libPharosRTC` consists of a TypeScript browser client (with WebWorker support), a Python 3 embedded server backend (`aiortc` + `websockets`), an optional C++17 embedded transport engine (`mbedTLS` 3.x), and an automated network impairment testing suite (`tc netem` + Playwright).

| Subsystem / Layer | Core Tools & Technologies | Key Libraries & Packages |
| --- | --- | --- |
| **Frontend Client** | Node.js (v18+), npm, Vite, Vitest, TypeScript | `vite`, `vitest`, `typescript`, `@playwright/test` |
| **Python Backend** | Python 3.9+, `venv`, `pip` | `aiortc`, `websockets`, `aiohttp`, `cryptography`, `pytest`, `pytest-asyncio` |
| **C++ Core Engine (Optional)** | C++17 Compiler (`g++`/`clang++`), CMake (3.16+), Ninja/Make | `mbedTLS` (3.x), POSIX sockets, `pkg-config` |
| **Network & Impairment** | Linux Kernel (`sch_netem`), `iproute2` (`tc`), NGINX | `iproute-tc` / `iproute2`, `nginx`, `ip netns` |

---

## 2. System Package Installation

### 2.1 Fedora 41

On Fedora 41, install the required development tools, Python headers, Node.js runtime, mbedTLS development headers, and network configuration utilities via `dnf`:

```bash
# Update repository package metadata
sudo dnf check-update

# Install core build toolchain and C++ headers
sudo dnf groupinstall -y "Development Tools" "C Development Tools and Libraries"
sudo dnf install -y gcc-c++ cmake ninja-build make pkgconfig

# Install Python 3 development environment
sudo dnf install -y python3 python3-devel python3-pip python3-virtualenv

# Install Node.js runtime and package manager
sudo dnf install -y nodejs npm

# Install mbedTLS, OpenSSL, and FFI development libraries (for C++ & Python extensions)
sudo dnf install -y mbedtls-devel openssl-devel libffi-devel

# Install network traffic control and Web server packages
sudo dnf install -y iproute-tc iproute nginx git

# Install Playwright browser system dependencies
sudo dnf install -y \
    alsa-lib \
    atk \
    at-spi2-atk \
    cairo \
    cups-libs \
    dbus-libs \
    expat \
    fontconfig \
    freetype \
    gdk-pixbuf2 \
    glib2 \
    gtk3 \
    libX11 \
    libXcomposite \
    libXdamage \
    libXext \
    libXfixes \
    libXrandr \
    libdrm \
    libxcb \
    libxshmfence \
    mesa-libEGL \
    mesa-libGL \
    nspr \
    nss \
    pango
```

---

### 2.2 Ubuntu 22.04 LTS

On Ubuntu 22.04 LTS (Jammy Jellyfish), install equivalent packages using `apt`:

```bash
# Update package indices
sudo apt update

# Install core build toolchain and C++ headers
sudo apt install -y build-essential g++ cmake ninja-build make pkg-config git

# Install Python 3 development environment
sudo apt install -y python3 python3-dev python3-pip python3-venv

# Install Node.js runtime and package manager
sudo apt install -y nodejs npm

# Install mbedTLS, OpenSSL, and FFI development libraries
sudo apt install -y libmbedtls-dev libssl-dev libffi-dev

# Install network traffic control and NGINX
sudo apt install -y iproute2 nginx

# Install Playwright browser system dependencies
sudo apt install -y \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1
```

---

## 3. Node.js & Frontend Environment Setup

The browser client library, priority scheduler, ARQ worker, and E2E test harness require Node.js v18 or newer (v20+ recommended).

### 3.1 Node.js Version Check / NVM Setup

Verify your installed Node.js version:

```bash
node -v
npm -v
```

If the distribution package is outdated, install or update Node.js using [nvm](https://github.com/nvm-sh/nvm):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
```

### 3.2 Installing Node Dependencies

From the root of the repository, initialize and install all JavaScript/TypeScript dependencies:

```bash
npm install
```

### 3.3 Playwright Installation

Playwright is used for full end-to-end testing of `RTCDataChannel` datagrams under network impairment. Install Playwright browser binaries:

```bash
npx playwright install chromium firefox
```

If system libraries are missing for Playwright headful/headless browsers, execute:

```bash
npx playwright install-deps
```

---

## 4. Python Backend Environment Setup

The embedded server uses Python 3 with `aiortc` for WebRTC/SCTP, `websockets` or `aiohttp` for SDP signaling, and `cryptography` for P-256 ECDSA persistent identity management.

### 4.1 Creating a Virtual Environment

It is recommended to use a Python virtual environment to isolate library dependencies:

```bash
# Create virtual environment in repo root
python3 -m venv venv

# Activate the virtual environment
source venv/bin/activate

# Upgrade base tooling
pip install --upgrade pip setuptools wheel
```

### 4.2 Installing Python Packages

Install required runtime and testing packages inside the active virtual environment:

```bash
pip install \
    aiortc \
    aiohttp \
    websockets \
    cryptography \
    pytest \
    pytest-asyncio
```

### 4.3 Python Package Breakdown

| Package | Purpose |
| --- | --- |
| `aiortc` | Provides asyncio-based WebRTC, ICE-Lite, DTLS 1.2, and SCTP DataChannel support. |
| `websockets` / `aiohttp` | Runs the signaling server (`/ws/webrtc`) behind NGINX. |
| `cryptography` | Generates and loads persistent P-256 ECDSA certificates for WebRTC DTLS fingerprints. |
| `pytest` | Runs unit tests for `frame_codec`, `priority_scheduler`, and `arq_engine`. |
| `pytest-asyncio` | Enables asynchronous unit test execution for Python `asyncio` tasks. |

---

## 5. Network Impairment & Testing Environment Setup (`tc netem`)

Linux `tc` (Traffic Control) with `netem` (Network Emulation) is required to simulate high Bit Error Rate (BER), jitter, packet loss, and blackout events during E2E testing.

### 5.1 Kernel Module Verification

Ensure the `sch_netem` kernel module is loaded:

```bash
sudo modprobe sch_netem
```

To verify:

```bash
lsmod | grep netem
```

### 5.2 Isolated Network Namespaces (Recommended for Local Dev)

To test network impairment without disrupting your local machine's network interface (e.g., WiFi/Ethernet), set up a virtual network pair (`veth`) inside a dedicated network namespace:

```bash
# Create network namespace 'pharos_ns'
sudo ip netns add pharos_ns

# Create veth pair connecting host to namespace
sudo ip link add veth-host type veth peer name veth-ns

# Move veth-ns into namespace
sudo ip link set veth-ns netns pharos_ns

# Assign IP addresses
sudo ip addr add 192.168.100.1/24 dev veth-host
sudo ip link set veth-host up

sudo ip netns exec pharos_ns ip addr add 192.168.100.2/24 dev veth-ns
sudo ip netns exec pharos_ns ip link set veth-ns up
sudo ip netns exec pharos_ns ip link set lo up
```

### 5.3 Impairment Presets Quick Reference

Once the namespace or link is configured, test scripts can apply impairments using `tc`:

* **Terrestrial High-BER Profile (12% loss, 15ms RTT):**
  ```bash
  sudo ip netns exec pharos_ns tc qdisc add dev veth-ns root netem delay 15ms 3ms loss 12%
  ```

* **Starlink Rain-Fade Profile (3% loss, 45ms jittered RTT):**
  ```bash
  sudo ip netns exec pharos_ns tc qdisc change dev veth-ns root netem delay 45ms 20ms distribution normal loss 3%
  ```

* **Reset Network Rules:**
  ```bash
  sudo ip netns exec pharos_ns tc qdisc del dev veth-ns root
  ```

---

## 6. Optional C++ Build Environment (Option B / Bare-Metal Shim)

If building or testing the standalone C++17 embedded transport engine (`libresilient_link.so`), `mbedTLS` 3.x is required.

### 6.1 Compiler & Library Verification

Verify C++17 support and `mbedTLS` header accessibility:

```bash
g++ --version
pkg-config --modversion mbedtls
```

### 6.2 CMake Build Commands

```bash
# From repository root
mkdir -p build && cd build

# Configure C++ release build using Ninja
cmake -G Ninja -DCMAKE_BUILD_TYPE=Release ..

# Build C++ targets
ninja
```

---

## 7. Installation Verification Checklist

Run the following commands to confirm that all development and testing prerequisites are properly installed and ready:

```bash
# 1. Check Node.js and TypeScript environment
node -v
npm test -- --version  # Vitest check

# 2. Check Python environment (with venv activated)
python3 --version
pytest --version
python3 -c "import aiortc; import cryptography; import websockets; print('Python WebRTC environment ready')"

# 3. Check Network Impairment Tooling
tc -V
sudo modprobe sch_netem && echo "netem module available"

# 4. Check C++ Compiler (if building Option B C++ engine)
g++ -std=c++17 -v
```
