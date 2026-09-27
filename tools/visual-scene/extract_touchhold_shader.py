#!/usr/bin/env python3
"""Extract the fixed build's SprFill DXBC programs, excluding parameter blobs."""
from pathlib import Path
import hashlib
import json
import struct

import UnityPy
from UnityPy.helpers import CompressionHelper
from UnityPy.streams import EndianBinaryReader
from UnityPy.export.ShaderConverter import ShaderSubProgram

source = Path('Visual Maimai/Visual Maimai_Data/sharedassets0.assets')
env = UnityPy.load(str(source))
obj = next(o for o in env.objects if o.type.name == 'Shader' and o.path_id == 215)
shader = obj.read()
parsed = obj.read_typetree()['m_ParsedForm']
assert parsed['m_Name'] == 'Custom/SprFill'
assert list(shader.platforms) == [4]  # This build contains D3D11 only.
output = Path('.tools/visual-reverse/touchhold-shader')
output.mkdir(parents=True, exist_ok=True)
(output / 'parsed.json').write_text(json.dumps(parsed, indent=2))

blob = CompressionHelper.decompress_lz4(
    bytes(shader.compressedBlob)[shader.offsets[0][0]:][:shader.compressedLengths[0][0]],
    shader.decompressedLengths[0][0],
)
programs = []
shader_pass = parsed['m_SubShaders'][0]['m_Passes'][0]
for stage in ['progVertex', 'progFragment']:
    variants = [v for group in shader_pass[stage]['m_PlayerSubPrograms'] for v in group]
    for variant in variants:
        index = variant['m_BlobIndex']
        # Unity >=2019.3 uses 12-byte table entries; 0/9 are parameter blobs.
        offset = struct.unpack_from('<I', blob, 4 + index * 12)[0]
        reader = EndianBinaryReader(blob, endian='<')
        reader.Position = offset
        program = ShaderSubProgram(reader)
        keywords = [parsed['m_KeywordNames'][i] for i in variant['m_KeywordIndices']]
        assert set(program.m_Keywords) == set(keywords), (program.m_Keywords, keywords)
        code = bytes(program.m_ProgramCode)
        start = code.index(b'DXBC')
        size = struct.unpack_from('<I', code, start + 24)[0]
        raw = code[start:start + size]
        assert len(raw) == size
        name = f'{index}-{stage}.dxbc'
        (output / name).write_bytes(raw)
        programs.append(dict(file=name, keywords=keywords, bytes=size,
                             sha256=hashlib.sha256(raw).hexdigest()))
record = dict(source=str(source), objectId=215,
              objectSha256=hashlib.sha256(obj.get_raw_data()).hexdigest(), programs=programs)
(output / 'programs.json').write_text(json.dumps(record, indent=2))
print(f'Extracted {len(programs)} mapped programs to {output}')
