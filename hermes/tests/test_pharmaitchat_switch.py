"""Tests for the pharmaitchat-switch Hermes plugin. Stdlib only: no Telegram, no Hermes, no live app."""

import asyncio
import importlib.util
import json
import socketserver
import sys
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

PLUGIN_DIR = Path(__file__).resolve().parent.parent / "plugins" / "pharmaitchat-switch"
TOKEN = "0123456789abcdef0123456789abcdef"


class _LocalHTTPServer(HTTPServer):
    """HTTPServer.server_bind() calls socket.getfqdn(), a reverse-DNS lookup that can stall for tens of
    seconds in a sandboxed environment. The test never needs a real hostname, so skip it."""

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = "127.0.0.1"
        self.server_port = self.server_address[1]


def load_plugin():
    # Loaded as a package, the way Hermes loads it, so the plugin's relative import resolves
    spec = importlib.util.spec_from_file_location(
        "pharmaitchat_switch", PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)])
    module = importlib.util.module_from_spec(spec)
    sys.modules["pharmaitchat_switch"] = module
    spec.loader.exec_module(module)
    return module


plugin = load_plugin()
tap = sys.modules["pharmaitchat_switch.tap"]


class ParseTapTest(unittest.TestCase):
    def test_reads_confirm_and_cancel(self):
        self.assertEqual(tap.parse_tap(f"pls:ok:{TOKEN}"), tap.Tap("confirm", TOKEN))
        self.assertEqual(tap.parse_tap(f"pls:no:{TOKEN}"), tap.Tap("cancel", TOKEN))

    def test_ignores_anything_else(self):
        for data in ["", "ea:once:1", f"pls:maybe:{TOKEN}", "pls:ok:short", f"pls:ok:{TOKEN}x", None]:
            self.assertIsNone(tap.parse_tap(data))


class AllowedTest(unittest.TestCase):
    def test_only_listed_users(self):
        env = {"TELEGRAM_ALLOWED_USERS": " 424242 , 99"}
        self.assertTrue(tap.is_allowed(424242, env))
        self.assertTrue(tap.is_allowed("99", env))
        self.assertFalse(tap.is_allowed(7, env))
        self.assertFalse(tap.is_allowed(None, env))

    def test_nobody_when_the_list_is_empty(self):
        self.assertFalse(tap.is_allowed(424242, {}))


class EnvWithFallbackTest(unittest.TestCase):
    """A token rotation refreshes PHARMAITCHAT_API_TOKEN in ~/.hermes/.env but (until the owner
    retires it) leaves the legacy PHARMALLM_API_TOKEN holding whatever value it last had. This
    plugin must still resolve to the value the app actually enforces (src/config/env-names.ts's
    readEnvWithFallback), never the stale legacy one, when both are present."""

    def test_prefers_the_new_key_when_both_are_present(self):
        env = {"PHARMAITCHAT_API_TOKEN": "new", "PHARMALLM_API_TOKEN": "old"}
        self.assertEqual(tap.env_with_fallback(env, "API_TOKEN"), "new")

    def test_falls_back_to_the_legacy_key_alone(self):
        env = {"PHARMALLM_API_TOKEN": "old"}
        self.assertEqual(tap.env_with_fallback(env, "API_TOKEN"), "old")

    def test_blank_on_both_names_is_absent(self):
        self.assertEqual(tap.env_with_fallback({"PHARMAITCHAT_API_TOKEN": "  ", "PHARMALLM_API_TOKEN": " "}, "API_TOKEN"), "")
        self.assertEqual(tap.env_with_fallback({}, "API_TOKEN"), "")

    def test_trims_a_padded_value(self):
        self.assertEqual(tap.env_with_fallback({"PHARMAITCHAT_API_TOKEN": " padded "}, "API_TOKEN"), "padded")


class OutcomeTest(unittest.TestCase):
    def test_maps_each_app_reply(self):
        confirm, cancel = tap.Tap("confirm", TOKEN), tap.Tap("cancel", TOKEN)
        switching = tap.outcome_for(confirm, tap.AppReply(200, {"status": "switching", "target": "mlx"}))
        self.assertEqual(switching.text, "✅ Switching to mlx — PharmaITChat restarts in a moment")
        self.assertEqual(tap.outcome_for(cancel, tap.AppReply(200, {})).text, "✖ Switch cancelled")
        self.assertEqual(tap.outcome_for(confirm, tap.AppReply(410, {})).text,
                         "⌛ Expired — request the switch again from PharmaITChat")

    def test_keeps_the_buttons_when_the_app_cannot_be_reached(self):
        down = tap.outcome_for(tap.Tap("confirm", TOKEN), tap.AppReply(0, {}, "ConnectionRefusedError"))
        self.assertIsNone(down.text)
        self.assertIn("ConnectionRefusedError", down.toast)
        self.assertIn("401", tap.outcome_for(tap.Tap("confirm", TOKEN), tap.AppReply(401, {})).toast)


class PostJsonTest(unittest.TestCase):
    """Against a test-owned HTTP server on a free port, never the real app."""

    def setUp(self):
        self.seen = []
        seen = self.seen

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                seen.append((self.path, self.headers["Authorization"], body))
                if body.get("token") == TOKEN:
                    code = 200
                elif body.get("token") == "unauthorized":
                    code = 401
                else:
                    code = 410
                payload = json.dumps({"status": "switching", "target": "mlx"} if code == 200 else {"error": "x"})
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(payload.encode())

            def log_message(self, *args):
                pass

        self.server = _LocalHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.env = {"PHARMALLM_URL": f"http://127.0.0.1:{self.server.server_port}/",
                    "PHARMALLM_API_TOKEN": "api-secret"}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_confirms_with_the_bearer_token(self):
        outcome = tap.resolve(tap.Tap("confirm", TOKEN), self.env)
        self.assertEqual(self.seen, [("/api/stack/confirm", "Bearer api-secret", {"token": TOKEN})])
        self.assertTrue(outcome.text.startswith("✅ Switching to mlx"))

    def test_sends_the_renamed_token_over_a_stale_legacy_one(self):
        # A rotation refreshes PHARMAITCHAT_API_TOKEN but leaves PHARMALLM_API_TOKEN stale
        # (scripts/hermes-setup.sh's fill_env now keeps both fresh, but this must not depend on that).
        env = dict(self.env, **{"PHARMAITCHAT_API_TOKEN": "api-secret", "PHARMALLM_API_TOKEN": "stale"})
        tap.resolve(tap.Tap("confirm", TOKEN), env)
        self.assertEqual(self.seen[-1][1], "Bearer api-secret")

    def test_reads_a_410_as_expired(self):
        outcome = tap.resolve(tap.Tap("cancel", "f" * 32), self.env)
        self.assertEqual(self.seen[0][0], "/api/stack/cancel")
        self.assertTrue(outcome.text.startswith("⌛ Expired"))

    def test_unreachable_app_names_the_error_class_and_never_the_token(self):
        reply = tap.post_json("http://127.0.0.1:9/api/stack/confirm", {"token": TOKEN}, "api-secret", timeout=2)
        self.assertEqual(reply.status, 0)
        self.assertTrue(reply.error)
        self.assertNotIn("api-secret", reply.error)

    def test_a_401_keeps_the_buttons_and_names_the_status(self):
        # Exercises the HTTPError "with err:" branch for a non-410 status.
        outcome = tap.resolve(tap.Tap("confirm", "unauthorized"), self.env)
        self.assertIsNone(outcome.text)
        self.assertIn("401", outcome.toast)

    def test_a_malformed_url_reports_the_error_class_without_raising(self):
        # Request(...) itself raises ValueError here, before urlopen() is even reached.
        reply = tap.post_json("not-a-url", {"token": TOKEN}, "api-secret", timeout=2)
        self.assertEqual(reply.status, 0)
        self.assertTrue(reply.error)

    def test_a_garbage_status_line_reports_the_error_class_without_raising(self):
        # http.client.BadStatusLine is an HTTPException, not an OSError: a distinct catch is needed.
        class GarbageHandler(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.recv(65536)
                self.request.sendall(b"garbage\r\n\r\n")

        server = socketserver.TCPServer(("127.0.0.1", 0), GarbageHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{server.server_address[1]}/api/stack/confirm"
            reply = tap.post_json(url, {"token": TOKEN}, "api-secret", timeout=2)
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(reply.status, 0)
        self.assertTrue(reply.error)

    def test_an_error_body_cut_short_still_returns_the_status(self):
        # err.read() raises IncompleteRead when the connection closes before Content-Length bytes
        # arrive; the sibling except clauses do not cover the HTTPError handler, so it needs its own.
        class TruncatedHandler(socketserver.BaseRequestHandler):
            def handle(self):
                self.request.recv(65536)
                self.request.sendall(b"HTTP/1.1 410 Gone\r\nContent-Type: application/json\r\n"
                                     b"Content-Length: 1000\r\nConnection: close\r\n\r\n{\"error\"")

        server = socketserver.TCPServer(("127.0.0.1", 0), TruncatedHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{server.server_address[1]}/api/stack/confirm"
            reply = tap.post_json(url, {"token": TOKEN}, "api-secret", timeout=2)
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(reply, tap.AppReply(410, {}))


class FakeQuery:
    def __init__(self, data, user_id, answer_error=None):
        self.data = data
        self.from_user = mock.Mock(id=user_id)
        self.answers, self.edits = [], []
        self.answer_error = answer_error  # raised by answer(), e.g. Telegram rejecting a late answer

    async def answer(self, text=None):
        self.answers.append(text)
        if self.answer_error is not None:
            raise self.answer_error

    async def edit_message_text(self, text):
        self.edits.append(text)


class HandleTapTest(unittest.TestCase):
    ENV = {"TELEGRAM_ALLOWED_USERS": "424242", "PHARMALLM_URL": "http://x", "PHARMALLM_API_TOKEN": "t"}

    def run_tap(self, query, outcome=None):
        update = mock.Mock(callback_query=query)
        resolved = mock.Mock(return_value=outcome)
        with mock.patch.dict("os.environ", self.ENV, clear=True), mock.patch.object(plugin, "resolve", resolved):
            asyncio.run(plugin.handle_tap(update, None))
        return resolved

    def test_answers_and_edits_for_an_allowed_user(self):
        query = FakeQuery(f"pls:ok:{TOKEN}", 424242)
        resolved = self.run_tap(query, tap.Outcome("✅ Switching to mlx", "✅ Switching to mlx — restarts"))
        self.assertEqual(resolved.call_args.args[0], tap.Tap("confirm", TOKEN))
        self.assertEqual(query.answers, ["✅ Switching to mlx"])
        self.assertEqual(query.edits, ["✅ Switching to mlx — restarts"])

    def test_refuses_a_stranger_without_calling_the_app(self):
        query = FakeQuery(f"pls:ok:{TOKEN}", 7)
        resolved = self.run_tap(query)
        resolved.assert_not_called()
        self.assertEqual(query.answers, ["Not authorised"])
        self.assertEqual(query.edits, [])

    def test_leaves_the_message_alone_when_the_outcome_keeps_the_buttons(self):
        query = FakeQuery(f"pls:no:{TOKEN}", 424242)
        self.run_tap(query, tap.Outcome("⚠️ Could not reach PharmaITChat (HTTP 500)", None))
        self.assertEqual(query.answers, ["⚠️ Could not reach PharmaITChat (HTTP 500)"])
        self.assertEqual(query.edits, [])

    def test_edits_even_when_telegram_rejects_the_answer(self):
        # A stale/duplicate answer failing must not stop the handler: the app already acted, so the
        # message still has to be edited and no exception may reach the gateway's dispatcher.
        query = FakeQuery(f"pls:ok:{TOKEN}", 424242, answer_error=RuntimeError("Query is too old"))
        self.run_tap(query, tap.Outcome("✅ Switching to mlx", "✅ Switching to mlx — restarts"))
        self.assertEqual(query.answers, ["✅ Switching to mlx"])
        self.assertEqual(query.edits, ["✅ Switching to mlx — restarts"])


class ReadyFileTest(unittest.TestCase):
    def test_writes_pid_and_start_time(self):
        with tempfile.TemporaryDirectory() as home:
            path = plugin.write_ready_file(Path(home), 4242, 777)
            self.assertEqual(json.loads(path.read_text()), {"pid": 4242, "start_time": 777})
            self.assertEqual(path.name, "pharmaitchat-switch.ready.json")
            self.assertEqual([p.name for p in Path(home).iterdir()], ["pharmaitchat-switch.ready.json"])


class FakeHandler:
    def __init__(self, callback, **kwargs):
        self.callback, self.kwargs = callback, kwargs


class FakeApp:
    """Shaped like python-telegram-bot's Application: ``handlers`` maps group -> list, and
    ``add_handler`` appends, which is why a late handler would sit behind Hermes' catch-all."""

    def __init__(self, core=()):
        self.handlers = {0: list(core)} if core else {}

    def add_handler(self, handler, group=0):
        self.handlers.setdefault(group, []).append(handler)


def telegram_fakes():
    telegram_ext = types.ModuleType("telegram.ext")
    telegram_ext.CallbackQueryHandler = FakeHandler
    return {"telegram": types.ModuleType("telegram"), "telegram.ext": telegram_ext}


class FakeAdapter:
    """Stands in for Hermes' Telegram adapter: connects after ``connect_after`` polls (never when None),
    and holds ``rebuilt`` as its app from then on when given, as a transient-init retry would."""

    def __init__(self, app, connect_after=None, rebuilt=None):
        self._app, self.connect_after, self.rebuilt, self.polls = app, connect_after, rebuilt, 0

    @property
    def is_connected(self):
        self.polls += 1
        if self.connect_after is None or self.polls < self.connect_after:
            return False
        if self.rebuilt is not None:
            self._app = self.rebuilt
        return True


class PublishReadyTest(unittest.TestCase):
    def publish(self, adapter, app, home, timeout=1.0):
        return asyncio.run(plugin.publish_ready_when_connected(
            adapter, app, home, 4242, 777, poll=0.01, timeout=timeout))

    def test_writes_the_file_once_connected_with_its_own_app(self):
        app = object()
        adapter = FakeAdapter(app, connect_after=3)
        with tempfile.TemporaryDirectory() as home:
            self.publish(adapter, app, Path(home))
            ready = Path(home) / plugin.READY_FILE_NAME
            self.assertEqual(json.loads(ready.read_text()), {"pid": 4242, "start_time": 777})
        self.assertGreaterEqual(adapter.polls, 3)

    # A transient Telegram error during connect() makes Hermes rebuild its Application and register
    # only its own handlers on it, including a catch-all for every button in group 0. Seen on
    # 2026-09-28 03:11: the UI's stack selector stayed disabled until the gateway was restarted.
    def test_reattaches_to_a_rebuilt_app_ahead_of_hermes_catch_all(self):
        app = object()
        catch_all = object()
        rebuilt = FakeApp(core=[catch_all])
        adapter = FakeAdapter(app, connect_after=2, rebuilt=rebuilt)
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(sys.modules, telegram_fakes()), \
                self.assertLogs(plugin.logger, "WARNING") as logs:
            self.publish(adapter, app, Path(home))
            ready = Path(home) / plugin.READY_FILE_NAME
            self.assertEqual(json.loads(ready.read_text()), {"pid": 4242, "start_time": 777})
        first = rebuilt.handlers[0][0]
        self.assertIs(first.callback, plugin.handle_tap)
        self.assertEqual(first.kwargs, {"pattern": plugin.PATTERN, "block": False})
        self.assertEqual(rebuilt.handlers[0][1:], [catch_all])
        self.assertIn("re-attached", logs.output[0])

    def test_still_writes_nothing_when_reattaching_fails(self):
        app = object()
        adapter = FakeAdapter(app, connect_after=2, rebuilt=object())  # no handlers to attach to
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(sys.modules, telegram_fakes()), \
                self.assertLogs(plugin.logger, "ERROR") as logs:
            self.publish(adapter, app, Path(home))
            self.assertEqual(list(Path(home).iterdir()), [])
        self.assertIn("restart the gateway", logs.output[-1])

    def test_gives_up_without_a_file_when_never_connected(self):
        app = object()
        with tempfile.TemporaryDirectory() as home, self.assertLogs(plugin.logger, "WARNING"):
            self.publish(FakeAdapter(app), app, Path(home), timeout=0.05)
            self.assertEqual(list(Path(home).iterdir()), [])


class WireTest(unittest.TestCase):
    """_wire with fake Telegram/Hermes modules: never the real gateway."""

    def test_removes_a_stale_ready_file_and_registers_a_non_blocking_handler(self):
        app = FakeApp()

        with tempfile.TemporaryDirectory() as home:
            stale = Path(home) / plugin.READY_FILE_NAME
            stale.write_text(json.dumps({"pid": 1, "start_time": 1}))
            gateway_status = types.ModuleType("gateway.status")
            gateway_status.get_process_start_time = lambda pid: 777
            constants = types.ModuleType("hermes_constants")
            # Only the process home is offered: the plugin must not read the per-session override
            constants.get_process_hermes_home = lambda: Path(home)
            fakes = {**telegram_fakes(),
                     "gateway": types.ModuleType("gateway"), "gateway.status": gateway_status,
                     "hermes_constants": constants}

            async def wire_then_look():
                plugin._wire(app, FakeAdapter(app))  # never connects: no file may appear
                await asyncio.sleep(0)
                exists = stale.exists()
                for task in list(plugin._pending):
                    task.cancel()
                return exists

            with mock.patch.dict(sys.modules, fakes):
                self.assertFalse(asyncio.run(wire_then_look()))
        handlers = app.handlers[0]
        self.assertEqual(len(handlers), 1)
        self.assertIs(handlers[0].callback, plugin.handle_tap)
        self.assertEqual(handlers[0].kwargs, {"pattern": plugin.PATTERN, "block": False})


if __name__ == "__main__":
    unittest.main()
