#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SDK_ROOT="$PROJECT_ROOT/.tools/dotnet"
CLI_HOME="$PROJECT_ROOT/.tools/dotnet-cli-home"
NUGET_PACKAGES="$PROJECT_ROOT/.tools/nuget"
SDK_VERSION="10.0.401"
WASM_TOOLS_MANIFEST="10.0.112/10.0.100"

cd "$PROJECT_ROOT"

mkdir -p "$PROJECT_ROOT/.tools/dotnet-download" "$SDK_ROOT" "$CLI_HOME" "$NUGET_PACKAGES"
if [[ ! -x "$SDK_ROOT/dotnet" ]]; then
  curl -fsSL https://dot.net/v1/dotnet-install.sh -o "$PROJECT_ROOT/.tools/dotnet-download/dotnet-install.sh"
  bash "$PROJECT_ROOT/.tools/dotnet-download/dotnet-install.sh" \
    --version "$SDK_VERSION" \
    --install-dir "$SDK_ROOT" \
    --no-path
fi

ACTUAL_SDK_VERSION="$(DOTNET_ROOT="$SDK_ROOT" DOTNET_CLI_HOME="$CLI_HOME" \
  DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 "$SDK_ROOT/dotnet" --version)"
if [[ "$ACTUAL_SDK_VERSION" != "$SDK_VERSION" ]]; then
  echo "Expected .NET SDK $SDK_VERSION from global.json; selected $ACTUAL_SDK_VERSION." >&2
  exit 1
fi

DOTNET_ROOT="$SDK_ROOT" \
DOTNET_CLI_HOME="$CLI_HOME" \
NUGET_PACKAGES="$NUGET_PACKAGES" \
DOTNET_CLI_TELEMETRY_OPTOUT=1 \
DOTNET_NOLOGO=1 \
  "$SDK_ROOT/dotnet" workload install wasm-tools --skip-manifest-update

WORKLOADS="$(DOTNET_ROOT="$SDK_ROOT" DOTNET_CLI_HOME="$CLI_HOME" \
  NUGET_PACKAGES="$NUGET_PACKAGES" DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 \
  "$SDK_ROOT/dotnet" workload list)"
printf '%s\n' "$WORKLOADS"
if ! printf '%s\n' "$WORKLOADS" | grep -Eq "^wasm-tools[[:space:]]+${WASM_TOOLS_MANIFEST//./\\.}[[:space:]]+SDK 10\\.0\\.400$"; then
  echo "Expected wasm-tools manifest $WASM_TOOLS_MANIFEST from SDK manifest 10.0.400." >&2
  exit 1
fi

DOTNET_ROOT="$SDK_ROOT" \
DOTNET_CLI_HOME="$CLI_HOME" \
NUGET_PACKAGES="$NUGET_PACKAGES" \
DOTNET_CLI_TELEMETRY_OPTOUT=1 \
DOTNET_NOLOGO=1 \
  "$SDK_ROOT/dotnet" restore "$PROJECT_ROOT/packages/majsimai-browser/host/MajSimaiBrowser.csproj"
