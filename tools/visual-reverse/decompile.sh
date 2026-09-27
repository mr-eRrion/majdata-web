#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOOL_VERSION=11.1.0.9782
GROUP=r1
EXPLICIT_TYPES=0
EXPLICIT_MEMBERS=0
EXPLICIT_IL_MEMBERS=0
TYPES=()
MEMBERS=()
IL_MEMBERS=()

usage() {
	cat <<'EOF'
Usage: tools/visual-reverse/decompile.sh [--group NAME] [--type FULL.NAME ...] [--member TOKEN ...] [--il-member TYPE::METHOD ...]

With no --type arguments, group r1 selects the initial SkinManager/Hold/Touch set.
Use --type to decompile any other type into .tools/visual-reverse/NAME/raw.
Use --member with a metadata token to save a single member's C# body.
Use --il-member for a single, unambiguous type-qualified IL method; only that method's IL is saved.
EOF
}

while (($#)); do
	case "$1" in
		--group)
			(($# >= 2)) || { usage >&2; exit 2; }
			GROUP="$2"
			shift 2
			;;
		--type)
			(($# >= 2)) || { usage >&2; exit 2; }
			EXPLICIT_TYPES=1
			TYPES+=("$2")
			shift 2
			;;
		--member)
			(($# >= 2)) || { usage >&2; exit 2; }
			EXPLICIT_MEMBERS=1
			MEMBERS+=("$2")
			shift 2
			;;
		--il-member)
			(($# >= 2)) || { usage >&2; exit 2; }
			EXPLICIT_IL_MEMBERS=1
			IL_MEMBERS+=("$2")
			shift 2
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			printf 'Unknown option: %s\n' "$1" >&2
			usage >&2
			exit 2
			;;
	esac
done

[[ "$GROUP" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
	printf 'Invalid group name: %s\n' "$GROUP" >&2
	exit 2
}

if ((EXPLICIT_TYPES == 0)); then
	case "$GROUP" in
		r1)
			TYPES=(
				Gameplay.Manager.SkinManager
				Gameplay.Data.SkinData
				Gameplay.Manager.NoteInstanceManager
				Gameplay.Mono.NoteMono
				Gameplay.Mono.TapMono
				Gameplay.Mono.HoldMono
				Gameplay.Mono.TouchMono
				Gameplay.Mono.TouchHoldMono
				Gameplay.Control.HoldControl
				Gameplay.Control.NoteControl
				'Gameplay.Control.NoteControl`2'
				Gameplay.Control.TapControl
				Gameplay.Control.TouchControl
				Gameplay.Control.TouchHoldControl
				Global.Chart.TouchData
				Global.Chart.TouchHoldData
				Global.Utils.Functions
				EditorScene.FileManager
			)
			;;
		*)
			printf 'Group %s has no default type list; provide one or more --type arguments.\n' "$GROUP" >&2
			usage >&2
			exit 2
			;;
	esac
fi

if ((EXPLICIT_MEMBERS == 0)) && [[ "$GROUP" == r1 ]]; then
	MEMBERS=(
		0x060002FD 0x060002FE 0x060002FF 0x06000300 0x06000302 0x06000303
		0x06000295 0x06000273 0x0600029D 0x0600029E 0x0600029F 0x0600029A
		0x0600031B 0x0600031C 0x06000348 0x0600034F 0x06000368
		0x06000320 0x06000324 0x06000328 0x06000342 0x06000199
	)
fi

if ((EXPLICIT_IL_MEMBERS == 0)) && [[ "$GROUP" == r1 ]]; then
	IL_MEMBERS=(TouchMono::SetAlpha)
fi

DOTNET="$ROOT/.tools/dotnet/dotnet"
TOOL_DIR="$ROOT/.tools/visual-reverse/bin"
ILSPY="$TOOL_DIR/ilspycmd"
ASSEMBLY="$ROOT/Visual Maimai/Visual Maimai_Data/Managed/Assembly-CSharp.dll"

[[ -f "$ASSEMBLY" ]] || { printf 'Assembly not found: %s\n' "$ASSEMBLY" >&2; exit 1; }
[[ -x "$DOTNET" ]] || { printf 'Expected local .NET SDK at %s\n' "$DOTNET" >&2; exit 1; }

mkdir -p "$TOOL_DIR"
if [[ ! -x "$ILSPY" ]]; then
	mkdir -p "$ROOT/.tools/dotnet-cli-home" "$ROOT/.tools/nuget"
	DOTNET_CLI_HOME="$ROOT/.tools/dotnet-cli-home" \
	NUGET_PACKAGES="$ROOT/.tools/nuget" \
	"$DOTNET" tool install --tool-path "$TOOL_DIR" ilspycmd --version "$TOOL_VERSION"
fi

export DOTNET_ROOT="$ROOT/.tools/dotnet"
VERSION_OUTPUT="$("$ILSPY" --version 2>&1 | sed -n '1p')"
[[ "$VERSION_OUTPUT" == "ilspycmd: $TOOL_VERSION" ]] || {
	printf 'Expected ilspycmd %s, got: %s\n' "$TOOL_VERSION" "$VERSION_OUTPUT" >&2
	exit 1
}

OUT="$ROOT/.tools/visual-reverse/$GROUP/raw"
mkdir -p "$OUT"

{
	printf 'ilspycmd=%s\n' "$VERSION_OUTPUT"
	printf 'decompiler=%s\n' "$TOOL_VERSION"
	printf '.NET SDK=%s\n' "$("$DOTNET" --version)"
	printf 'assembly=%s\n' "${ASSEMBLY#"$ROOT"/}"
	printf 'assembly_sha256=%s\n' "$(shasum -a 256 "$ASSEMBLY" | awk '{print $1}')"
	printf 'group=%s\n' "$GROUP"
	for type in "${TYPES[@]}"; do printf 'type=%s\n' "$type"; done
	if ((${#MEMBERS[@]})); then
		for member in "${MEMBERS[@]}"; do printf 'member=%s\n' "$member"; done
	fi
	if ((${#IL_MEMBERS[@]})); then
		for member in "${IL_MEMBERS[@]}"; do printf 'il_member=%s\n' "$member"; done
	fi
} > "$ROOT/.tools/visual-reverse/$GROUP/provenance.txt"

"$ILSPY" --disable-updatecheck --dump-table TypeDef --json "$ASSEMBLY" > "$OUT/metadata-typedef.json"
"$ILSPY" --disable-updatecheck --dump-table MethodDef --json "$ASSEMBLY" > "$OUT/metadata-methoddef.json"

for type in "${TYPES[@]}"; do
	slug="$(printf '%s' "$type" | tr '.+' '__' | tr -c 'A-Za-z0-9_-' '_')"
	"$ILSPY" --disable-updatecheck -t "$type" "$ASSEMBLY" > "$OUT/$slug.cs"
done

if ((${#MEMBERS[@]})); then
	for member in "${MEMBERS[@]}"; do
		slug="$(printf '%s' "$member" | tr -c 'A-Za-z0-9_-' '_')"
		"$ILSPY" --disable-updatecheck --member "$member" "$ASSEMBLY" > "$OUT/member-$slug.cs"
	done
fi

if ((${#IL_MEMBERS[@]})); then
	for member in "${IL_MEMBERS[@]}"; do
		slug="$(printf '%s' "$member" | tr -c 'A-Za-z0-9_-' '_')"
		"$ILSPY" --disable-updatecheck --ilcode "$ASSEMBLY" | \
			python3 "$ROOT/tools/visual-reverse/extract-il-member.py" "$member" > "$OUT/il-member-$slug.il"
	done
fi

python3 "$ROOT/tools/visual-reverse/build-method-map.py" \
	--typedef "$OUT/metadata-typedef.json" \
	--methoddef "$OUT/metadata-methoddef.json" \
	--output "$OUT/type-method-map.json" \
	"${TYPES[@]}"

printf 'Wrote %d decompiled types to %s\n' "${#TYPES[@]}" "$OUT"
