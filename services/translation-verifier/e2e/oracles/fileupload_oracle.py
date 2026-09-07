"""Host-only oracle. Never include this file in the agent's snapshot."""

import json
import sys
from importlib import import_module
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1]) / "src"))
MultipartStream = import_module("commons_fileupload.core").MultipartStream

for case_id, body, discard in [
    ("empty", b"", False),
    ("text", b"hello", False),
    ("binary", bytes([0, 10, 13, 127, 128, 255]), False),
    ("large", b"a" * 8193, False),
    ("discard", bytes([0, 10, 13, 127, 128, 255]), True),
]:
    wire = b"--b\r\nX: y\r\n\r\n" + body + b"\r\n--b--\r\n"
    stream = MultipartStream(BytesIO(wire), b"b")
    if not stream.skip_preamble():
        raise AssertionError("Missing first part")
    stream.read_headers()
    output = BytesIO()
    count = stream.read_body_data(None if discard else output)
    bytes_match = output.getvalue() == (b"" if discard else body)
    final_boundary = not stream.read_boundary()
    print(
        json.dumps(
            {
                "id": case_id,
                "count": count,
                "expectedCount": len(body),
                "bytesMatch": bytes_match,
                "finalBoundary": final_boundary,
                "outputClosed": output.closed,
                "passed": count == len(body)
                and bytes_match
                and final_boundary
                and not output.closed,
            }
        )
    )
