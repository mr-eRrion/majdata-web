#!/usr/bin/env python3
"""Keep one type-qualified method from ilspycmd's assembly IL stream."""

import sys


target = sys.argv[1]
inside_method = False
method_lines = []

for line in sys.stdin:
	if line.lstrip().startswith(".method "):
		inside_method = True
		method_lines = [line]
	elif inside_method:
		method_lines.append(line)

	if inside_method and f"end of method {target}" in line:
		sys.stdout.writelines(method_lines)
		break
	if inside_method and "end of method " in line:
		inside_method = False
		method_lines = []
else:
	print(f"IL method not found: {target}", file=sys.stderr)
	sys.exit(1)
