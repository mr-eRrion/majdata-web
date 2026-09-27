#!/usr/bin/env python3
"""Build a type-scoped metadata-token map from ilspycmd JSON table dumps."""

import argparse
import json
from pathlib import Path


def read_rows(path: Path) -> list[dict[str, object]]:
	return json.loads(path.read_text(encoding="utf-8"))["rows"]


def main() -> None:
	parser = argparse.ArgumentParser()
	parser.add_argument("--typedef", type=Path, required=True)
	parser.add_argument("--methoddef", type=Path, required=True)
	parser.add_argument("--output", type=Path, required=True)
	parser.add_argument("types", nargs="+")
	args = parser.parse_args()

	type_rows = read_rows(args.typedef)
	method_rows = read_rows(args.methoddef)
	method_by_rid = {int(row["RID"]): row for row in method_rows}
	result = []
	missing = []

	for wanted in args.types:
		for index, type_row in enumerate(type_rows):
			namespace = str(type_row["Namespace"])
			name = str(type_row["Name"])
			full_name = f"{namespace}.{name}" if namespace else name
			if full_name != wanted:
				continue

			start = int(type_row["MethodList"])
			end = int(type_rows[index + 1]["MethodList"]) if index + 1 < len(type_rows) else len(method_rows) + 1
			methods = [method_by_rid[rid] for rid in range(start, end) if rid in method_by_rid]
			result.append(
				{
					"type": full_name,
					"typeToken": type_row["Token"],
					"methods": [
						{"name": method["Name"], "token": method["Token"], "rva": method["RVA"]}
						for method in methods
					],
				}
			)
			break
		else:
			missing.append(wanted)

	if missing:
		parser.error("types not found in metadata: " + ", ".join(missing))

	args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
	main()
