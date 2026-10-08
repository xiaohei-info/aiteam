import json
import logging
from pathlib import Path

from shared.log_files import PrivateRotatingHandler, install_file_handler
from shared.observability import JsonLogFormatter


def test_json_logs_omit_exception_values_and_arguments():
    try:
        raise ValueError("password=sentinel chat body sentinel")
    except ValueError:
        import sys
        record = logging.LogRecord("service", logging.ERROR, __file__, 10, "failed %s", ("sentinel",), sys.exc_info())
    data = json.loads(JsonLogFormatter().format(record))
    assert data["error_type"] == "ValueError"
    assert data["frames"]
    assert "sentinel" not in json.dumps(data)
    assert data["event"] == "application.event"


def test_private_rotation_and_reconfiguration(tmp_path):
    formatter = JsonLogFormatter()
    install_file_handler(str(tmp_path), formatter)
    root = logging.getLogger()
    try:
        install_file_handler(str(tmp_path), formatter)
        handlers = [h for h in root.handlers if isinstance(h, PrivateRotatingHandler)]
        assert len(handlers) == 1
        handler = handlers[0]
        handler.maxBytes = 600
        for _ in range(20):
            handler.emit(logging.LogRecord("test", logging.WARNING, __file__, 1, "test.completed", (), None))
        files = list(tmp_path.glob(Path(handler.baseFilename).name + "*"))
        assert len(files) <= 4
        for path in files:
            assert path.stat().st_mode & 0o777 == 0o600
            for line in path.read_text().splitlines():
                assert json.loads(line)["event"] == "test.completed"
    finally:
        install_file_handler(None, formatter)


def test_handler_errors_never_print_raw_records(capsys, tmp_path):
    handler = PrivateRotatingHandler(tmp_path / "test.jsonl", maxBytes=100, backupCount=1)
    handler.stream.close()
    record = logging.LogRecord("test", logging.ERROR, __file__, 1, "password sentinel", (), None)
    handler.emit(record)
    assert handler.dropped_records == 1
    assert "sentinel" not in capsys.readouterr().err
    handler.close()
